// Context compaction (pi-style): when the conversation approaches the model's
// context window, summarize the older prefix and keep the recent tail verbatim.
// Trigger: used > contextWindow - reserve. Keep: the last ~keepTokens of messages.
import { chat } from "./provider.mjs";
import { contextWindowFor, COMPACT_RESERVE, COMPACT_KEEP_TOKENS, COMPACT_ENABLED } from "./config.mjs";

const IMAGE_CHARS = 4800; // rough per-image cost (pi uses the same figure)

// Estimate tokens for one message (~4 chars/token; conservative).
export function estimateMsgTokens(m) {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const p of m.content) chars += p.type === "image" ? IMAGE_CHARS : (p.text?.length || 0);
  }
  if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  return Math.ceil(chars / 4);
}

// Estimate tokens for the whole message array.
export function estimateTokens(messages) {
  let n = 0;
  for (const m of messages) n += estimateMsgTokens(m);
  return n;
}

function renderForSummary(m) {
  if (m.role === "assistant" && m.tool_calls)
    return `ASSISTANT called: ${m.tool_calls.map((c) => `${c.function?.name}(${c.function?.arguments || ""})`).join("; ")}` + (m.content ? `\n${m.content}` : "");
  if (m.role === "tool") return `TOOL RESULT: ${String(m.content).slice(0, 2000)}`;
  const text = typeof m.content === "string" ? m.content : "(non-text content)";
  return `${m.role.toUpperCase()}: ${text}`;
}

const SUMMARY_SYSTEM =
  "You are a context summarization assistant. Read an AI coding agent's working log and produce a structured checkpoint another LLM will use to continue. Do NOT continue the work or answer questions in it — output ONLY the summary.";

const SUMMARY_FORMAT = `Summarize the work log below into this EXACT format:

## Goal
[What the user is trying to accomplish.]

## Constraints & Preferences
- [constraints/preferences, or "(none)"]

## Progress
### Done
- [completed changes]
### In Progress
- [current work]
### Blocked
- [blockers, if any]

## Key Decisions
- **[decision]**: [why]

## Next Steps
1. [ordered next actions]

## Critical Context
- [data/paths/values needed to continue, or "(none)"]

Keep it concise. Preserve EXACT file paths, function names, line numbers, and error messages.`;

// Returns true if it compacted. Mutates `messages` in place.
export async function maybeCompact(messages, { model, signal, onEvent = () => {}, keepTokens = COMPACT_KEEP_TOKENS } = {}) {
  if (!COMPACT_ENABLED) return false;
  const used = estimateTokens(messages);
  const trigger = contextWindowFor(model) - COMPACT_RESERVE;
  if (used <= trigger) return false;
  if (messages.length < 6) return false; // too short to bother

  // Walk backwards from the newest, accumulating tokens, until we've kept ~keepTokens.
  // `cut` = index of the first KEPT message (everything before it gets summarized).
  let acc = 0, cut = 1;
  for (let i = messages.length - 1; i >= 1; i--) {
    acc += estimateMsgTokens(messages[i]);
    if (acc >= keepTokens) { cut = i; break; }
  }
  // Never start the kept tail on an orphan tool result (its tool_call would be in
  // the summarized prefix). Move the cut forward past any leading tool messages.
  while (cut < messages.length && messages[cut].role === "tool") cut++;

  const head = messages[0]; // system prompt
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);
  if (middle.length < 2) return false; // nothing meaningful to compress

  const transcript = middle.map(renderForSummary).join("\n\n").slice(0, 60000);

  onEvent({ type: "compact_start", before: used });
  let summary;
  try {
    const r = await chat({
      model,
      signal,
      maxTokens: 2000,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: `${SUMMARY_FORMAT}\n\n--- WORK LOG ---\n${transcript}` },
      ],
    });
    summary = r.message?.content?.trim();
  } catch (e) {
    onEvent({ type: "compact_error", error: e.message });
    return false;
  }
  if (!summary) return false;

  messages.splice(0, messages.length,
    head,
    { role: "user", content: `[Earlier conversation compacted to save context]\n\n${summary}` },
    ...tail,
  );
  onEvent({ type: "compact_done", after: estimateTokens(messages) });
  return true;
}
