// The agent loop: model <-> tools until the task is done.
import { chat } from "./provider.mjs";
import { TOOLS, toolSchemas } from "./tools.mjs";
import { systemPrompt } from "./prompt.mjs";
import { maybeCompact } from "./compact.mjs";
import { DEFAULT_MODEL, MAX_STEPS } from "./config.mjs";

function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return null;
  }
}

/**
 * Create a stateful agent session (keeps conversation across turns).
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.model
 * @param {(ev:object)=>void} opts.onEvent
 * @param {(tool:object,args:object)=>Promise<boolean>} opts.approve  // return true to run
 */
export function createAgent(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let model = opts.model || DEFAULT_MODEL;
  const onEvent = opts.onEvent || (() => {});
  const approve = opts.approve || (async () => true);
  const maxSteps = opts.maxSteps || MAX_STEPS;
  const stream = opts.stream || false;

  const registry = { ...TOOLS };
  const tools = toolSchemas();
  const ctx = { cwd, onEvent };

  const messages = [
    { role: "system", content: systemPrompt({ cwd, model }) },
  ];

  // After an interrupt, the log can end on an assistant tool_calls message whose tool
  // results never got pushed. Most providers reject that. Synthesize the missing results
  // so the next turn starts from a coherent state.
  function reconcileToolCalls() {
    let ai = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].tool_calls?.length) { ai = i; break; }
      if (messages[i].role === "user") break;
    }
    if (ai === -1) return;
    const answered = new Set(
      messages.slice(ai + 1).filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );
    for (const call of messages[ai].tool_calls) {
      if (!answered.has(call.id))
        messages.push({ role: "tool", tool_call_id: call.id, content: "(interrupted by user)" });
    }
  }

  async function send(userText, { signal } = {}) {
    reconcileToolCalls();
    messages.push({ role: "user", content: userText });

    for (let step = 0; step < maxSteps; step++) {
      // Compact older turns if the conversation has grown too large for the context window.
      await maybeCompact(messages, { model, signal, onEvent });
      onEvent({ type: "thinking", model });
      const { message, finish_reason, usage, cost } = await chat({
        messages,
        tools,
        model,
        cwd,
        signal,
        onToken: stream ? (t) => onEvent({ type: "assistant_delta", text: t }) : undefined,
      });

      const calls = message.tool_calls || [];
      // record assistant turn (content may be empty when only tool_calls)
      messages.push({
        role: "assistant",
        content: message.content || "",
        ...(calls.length ? { tool_calls: calls } : {}),
      });

      if (message.content) onEvent({ type: "assistant", text: message.content });
      onEvent({ type: "usage", usage, cost });

      if (!calls.length) {
        onEvent({ type: "done" });
        return message.content || "";
      }

      // Phase 1 — validate + approve SEQUENTIALLY (approval is an interactive
      // prompt; can't run several at once). Build a plan of what to execute.
      const plan = [];
      for (const call of calls) {
        const name = call.function?.name;
        const tool = registry[name];
        const args = safeParse(call.function?.arguments);
        if (!tool || args === null) {
          plan.push({ call, content: !tool ? `ERROR: no such tool "${name}"` : "ERROR: arguments are not valid JSON" });
          continue;
        }
        onEvent({ type: "tool_call", name, preview: tool.preview ? tool.preview(args) : "" });
        if (tool.needsApproval) {
          const ok = await approve(name, args, tool.preview ? tool.preview(args) : "");
          if (!ok) {
            onEvent({ type: "tool_denied", name });
            plan.push({ call, content: "The user DENIED running this tool. Try another approach or ask." });
            continue;
          }
        }
        plan.push({ call, name, tool, args, run: true });
      }

      // Phase 2 — run the approved tools IN PARALLEL (like pi). Independent
      // reads/greps no longer wait on each other.
      await Promise.all(
        plan.filter((p) => p.run).map(async (p) => {
          try {
            p.result = await p.tool.run(p.args, ctx);
          } catch (e) {
            p.result = `ERROR running tool: ${e.message}`;
          }
        }),
      );

      // Phase 3 — emit results + push tool messages IN ORDER (tool_call_id must
      // line up with the assistant's call order regardless of finish order).
      for (const p of plan) {
        if (p.run) {
          onEvent({ type: "tool_result", name: p.name, result: p.result });
          messages.push({ role: "tool", tool_call_id: p.call.id, content: String(p.result) });
        } else {
          messages.push({ role: "tool", tool_call_id: p.call.id, content: p.content });
        }
      }
    }
    onEvent({ type: "max_steps" });
    return "(reached step limit)";
  }

  return {
    send,
    get model() {
      return model;
    },
    setModel(m) {
      model = m;
      // Keep the system prompt's stated model name in sync, otherwise the agent
      // keeps introducing itself as the old model after a /model switch.
      messages[0] = { role: "system", content: systemPrompt({ cwd, model }) };
    },
    reset() {
      messages.length = 1; // keep system
    },
    messages,
  };
}
