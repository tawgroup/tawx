// OpenCode Go client — OpenAI-compatible /chat/completions (with optional streaming).
import { BASE_URL, API_KEY, MAX_TOKENS, REQUEST_TIMEOUT_MS } from "./config.mjs";

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

function isFatal(status, type, msg) {
  return (
    status === 401 ||
    status === 403 ||
    /CreditsError|ModelError|Insufficient|unauthor|invalid api key/i.test(`${type} ${msg}`)
  );
}

// Parse a streaming SSE response, emitting content deltas via onToken.
async function parseStream(res, onToken, bump) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = [];
  let finish_reason, usage = {}, cost;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bump();
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      if (j.cost != null) cost = j.cost;
      const ch = (j.choices || [])[0];
      if (!ch) continue;
      if (ch.finish_reason) finish_reason = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) { content += d.content; onToken(d.content); }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: "", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const message = { role: "assistant", content };
  const calls = toolCalls
    .filter(Boolean)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
    }));
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason, usage, cost };
}

/**
 * Call the model once. If onToken is given (and TAW_NO_STREAM is unset), streams the reply.
 * @returns {Promise<{message: object, finish_reason: string, usage: object}>}
 */
export async function chat({ messages, tools, model, maxTokens = MAX_TOKENS, signal, onToken }) {
  const stream = typeof onToken === "function" && !process.env.TAW_NO_STREAM;
  const body = { model, messages, max_tokens: maxTokens };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  let lastErr;
  let emitted = false;
  const tokenOnce = (t) => { emitted = true; onToken(t); };

  for (let attempt = 0; attempt < 6; attempt++) {
    // hard timeout, reset on each received chunk so long but live streams don't trip it
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    };

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let j; try { j = JSON.parse(text); } catch { /* not json */ }
        const err = (j && (j.error || j)) || {};
        const type = err.type || `HTTP ${res.status}`;
        const msg = err.message || text.slice(0, 300);
        if (isFatal(res.status, type, msg)) throw new Error(`${type}: ${msg}`);
        lastErr = new Error(`${type}: ${msg}`);
        await SLEEP(800 * (attempt + 1));
        continue;
      }

      if (stream) {
        return await parseStream(res, tokenOnce, bump);
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        lastErr = new Error(`Bad response (${res.status}): ${text.slice(0, 300)}`);
        await SLEEP(500 * (attempt + 1));
        continue;
      }
      if (json.type === "error" || json.error) {
        const err = json.error || json;
        const type = err.type || "Error";
        const msg = err.message || JSON.stringify(err);
        if (isFatal(res.status, type, msg)) throw new Error(`${type}: ${msg}`);
        lastErr = new Error(`${type}: ${msg}`);
        await SLEEP(800 * (attempt + 1));
        continue;
      }
      const choice = (json.choices || [])[0] || {};
      const message = choice.message || {};
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: "function",
          function: { name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" },
        }));
      }
      return { message, finish_reason: choice.finish_reason, usage: json.usage || {}, cost: json.cost };
    } catch (e) {
      if (signal?.aborted) throw e;
      // if we already streamed tokens to the user, don't retry (would duplicate output)
      if (emitted) throw e;
      lastErr = new Error(`request error/timeout: ${e.message}`);
      await SLEEP(500 * (attempt + 1));
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new Error("request failed");
}
