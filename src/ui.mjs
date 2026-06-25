// ANSI helpers for the TUI — zero deps.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const tc = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  // ---- semantic roles (truecolor; degrade to plain when NO_COLOR) ----
  accent: tc(167, 139, 250),  // lavender — brand, prompt, active
  brand: tc(180, 160, 255),
  soft: tc(125, 211, 252),    // soft cyan — assistant accents
  amber: tc(245, 176, 84),    // warning/attention — YOLO
  ok: tc(110, 215, 160),      // success/user
  text: tc(228, 230, 240),    // near-white primary
  muted: tc(132, 134, 158),   // secondary
  faint: tc(92, 94, 116),     // tertiary / separators
};

// Visible length of a string, ignoring ANSI escape sequences.
export const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;

// pi dark-theme background tones (from pi's dark.json): card = tool/output panels,
// info = system notices, bar = the status footer band.
export const BG = { card: [30, 30, 36], info: [60, 55, 40], bar: [36, 36, 48] };

// Fill a line's background to `cols` visible columns — the pi "card/panel" look.
// Inner fg colors reset with 39m (not 0m) so the background persists; we close 49m.
export function bgLine(content, cols, rgb = BG.card) {
  const pad = Math.max(0, cols - visLen(content));
  if (!useColor) return content + " ".repeat(pad);
  const [r, g, b] = rgb;
  return `\x1b[48;2;${r};${g};${b}m` + content + " ".repeat(pad) + "\x1b[49m";
}

// Lay out a left and right segment on one line padded to `cols` wide.
function justify(left, right, cols) {
  const gap = Math.max(1, cols - visLen(left) - visLen(right));
  return left + " ".repeat(gap) + right;
}

// Compact two-line header + a thin subtle rule.
export function banner({ version = "", cwd = "", session = "", cols = 80 } = {}) {
  const w = Math.min(cols || 80, 120);
  const logo = "  " + c.bold(c.brand("◢◣ tawx")) + (version ? "  " + c.faint("v" + version) : "");
  const right = (cwd ? c.muted(cwd) : "") + (session ? c.faint(`  ·  ${session}`) : "");
  const rule = "  " + c.faint("─".repeat(Math.max(0, w - 4)));
  // pi-style one-line shortcut hint under the rule.
  const hint = "  " + c.faint("/ commands") + c.faint(" · ") + c.faint("↑↓ recall")
    + c.faint(" · ") + c.faint("ctrl-c interrupt") + c.faint(" · ") + c.faint("ctrl-c again to exit");
  return "\n" + justify(logo, right + "  ", w) + "\n" + rule + "\n" + hint + "\n";
}

// ---- Markdown → ANSI (zero-dep), styled after pi's renderer: headings by level,
// blockquotes, horizontal rules, ordered/unordered lists, code fences, inline
// code/bold/italic/strikethrough/links. Stays line-based so it streams.
function renderInline(s) {
  s = s.replace(/`([^`]+)`/g, (_, t) => c.cyan(t));
  s = s.replace(/~~([^~]+)~~/g, (_, t) => c.dim(c.gray(t)));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, a, t) => a + c.italic(t));
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, (_, a, t) => a + c.italic(t));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => c.underline(c.blue(t)) + c.dim(` (${u})`));
  return s;
}

const hrWidth = () => Math.min((process.stdout.columns || 80) - 4, 56);

// A stateful per-line renderer (carries fenced-code-block state across lines).
// Returns a function(line) -> rendered string, or null for lines to drop (fence markers).
function lineRenderer() {
  let inFence = false;
  return (line) => {
    // Fenced code: keep a subtle gutter (pi indents + dims the block body).
    if (/^\s*```/.test(line)) { inFence = !inFence; return null; }
    if (inFence) return c.faint("│ ") + c.cyan(line);

    // Horizontal rule: --- / *** / ___ alone on a line → a thin faint divider.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return c.faint("─".repeat(hrWidth()));

    // Headings by level: H1 underlined+bold, H2 bold, H3+ keep a dim "#" prefix.
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length, txt = renderInline(h[2]);
      if (lvl === 1) return c.bold(c.underline(c.brand(txt)));
      if (lvl === 2) return c.bold(c.brand(txt));
      return c.faint("#".repeat(lvl) + " ") + c.bold(c.soft(txt));
    }

    // Blockquote: pi-style "│ " border in a muted tone.
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) return c.faint("│ ") + c.muted(renderInline(q[1]));

    // Ordered list: keep the number, tint the marker.
    const ol = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
    if (ol) return ol[1] + c.soft(ol[2] + ol[3]) + " " + renderInline(ol[4]);

    // Unordered list: -, *, + → a tinted bullet (indentation preserved for nesting).
    line = line.replace(/^(\s*)[-*+]\s+/, (_, sp) => sp + c.yellow("• "));
    return renderInline(line);
  };
}

export function renderMarkdown(text) {
  const render = lineRenderer();
  const out = [];
  for (const line of String(text).split("\n")) {
    const r = render(line);
    if (r !== null) out.push(r);
  }
  return out.join("\n");
}

// Streaming Markdown: push() text chunks; complete lines are rendered + written immediately,
// the partial last line is held until the next newline or end().
export function createMdStream(write) {
  const render = lineRenderer();
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const r = render(line);
        if (r !== null) write(r + "\n");
      }
    },
    end() {
      if (buf.length) {
        const r = render(buf);
        if (r !== null) write(r + "\n");
      }
      buf = "";
    },
  };
}

// ---- One-line, verb-led tool summaries (flux-inspired) ---------------------
// Each finished tool call collapses to a single readable line instead of dumping
// the raw result. Only genuinely useful output (bash, diff) gets a short dimmed
// body underneath. Keeps the transcript scannable: verb · target · detail.
export const TOOL_VERB = {
  read_file: "read", list_dir: "list", glob: "find", grep: "grep", diff: "diff",
  web_fetch: "fetch", write_file: "write", edit_file: "edit", multi_edit: "edit",
  replace_lines: "edit", apply_patch: "patch", undo_last_change: "undo", bash: "bash",
};
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit", "replace_lines", "apply_patch", "undo_last_change",
]);
const firstLine = (s) => String(s).split("\n")[0];
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

// The "what was touched" portion — prefer the call preview (path/pattern/command),
// stripping any trailing "(123 bytes)" / "(3 edits)" annotation it carries.
function toolTarget(name, result, preview) {
  if (name === "apply_patch") return (String(result).match(/patch to (.+?) \(undo/) || [])[1] || "";
  if (name === "undo_last_change") return "";
  return String(preview || "").replace(/\s*\(\d[^)]*\)\s*$/, "").trim();
}

// The trailing "· detail" — a count/size parsed back out of the tool's result string.
function toolDetail(name, result) {
  const r = String(result); let m;
  switch (name) {
    case "read_file":
      if ((m = r.match(/…\[showing lines (\d+)-(\d+) of (\d+)\]/))) return `lines ${m[1]}-${m[2]} of ${m[3]}`;
      { const n = r ? r.split("\n").length : 0; return `${n} line${n === 1 ? "" : "s"}`; }
    case "list_dir": {
      if (r === "(empty)") return "empty";
      const items = r.split("\n"), dirs = items.filter((x) => x.endsWith("/")).length;
      return `${items.length} item${items.length === 1 ? "" : "s"}` + (dirs ? `, ${dirs} dir${dirs === 1 ? "" : "s"}` : "");
    }
    case "glob":
      if ((m = r.match(/\((\d+) files?\)\s*$/))) return `${m[1]} file${m[1] === "1" ? "" : "s"}`;
      return /^\(no files match/.test(r) ? "no matches" : "";
    case "grep": {
      if (/^\(no matches\)/.test(r.trim())) return "no matches";
      const hits = r.split("\n").filter((l) => /:\d+:/.test(l));
      const files = new Set(hits.map((l) => l.split(":")[0]));
      return hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"}` + (files.size > 1 ? ` · ${files.size} files` : "") : "";
    }
    case "write_file": return (m = r.match(/\((\d+) bytes/)) ? `${m[1]} bytes` : "";
    case "edit_file": return (m = r.match(/\((\d+) places?/)) ? `${m[1]} place${m[1] === "1" ? "" : "s"}` : "1 place";
    case "multi_edit": return (m = r.match(/applied (\d+) edits?/)) ? `${m[1]} edits` : "";
    case "apply_patch": return ""; // files shown as the target
    case "undo_last_change": return (m = r.match(/reverted (\d+)/)) ? `${m[1]} file${m[1] === "1" ? "" : "s"}` : "";
    case "web_fetch": return (m = r.match(/\[(\d{3})/)) ? m[1] : "";
    default: return "";
  }
}

// Render a completed tool call as printable lines (already colored, no PANEL pad).
// Returns ["▏ verb target · detail", ...optional dimmed body].
export function renderToolResult(name, result, preview, cols = 80) {
  const r = String(result);
  const w = Math.max(30, Math.min((cols || 80) - 4, 100));
  const verb = TOOL_VERB[name] || name;
  const tgt = toolTarget(name, r, preview);

  // Errors / interrupts: a single red line carrying the reason.
  if (/^ERROR/.test(r.trim()) || r.trim() === "(interrupted by user)") {
    const msg = clip(firstLine(r).replace(/^ERROR:?\s*/, "") || "failed", w - 18);
    return ["  " + c.red("▏ ") + c.red(verb) + (tgt ? " " + c.muted(clip(tgt, 44)) : "") + c.faint(" · ") + c.red(msg)];
  }

  const kind = WRITE_TOOLS.has(name) ? "write" : name === "bash" ? "run" : "read";
  const tint = kind === "write" ? c.ok : kind === "run" ? c.accent : c.soft;

  // detail: bash colors the exit code; everything else is a faint count/size.
  let detailNode = "";
  if (name === "bash") {
    const code = (r.match(/^\(exit (\d+)\)/) || [])[1];
    detailNode = c.faint(" · ") + (code === "0" ? c.ok("exit 0") : c.amber("exit " + (code ?? "?")));
  } else {
    const d = toolDetail(name, r);
    if (d) detailNode = c.faint(" · " + d);
  }

  const head = "  " + tint("▏ ") + tint(verb)
    + (tgt ? " " + c.text(clip(tgt, w - 22)) : "") + detailNode;

  const body = [];
  if (name === "bash") {
    const lines = r.replace(/^\(exit \d+\)\n?/, "").split("\n");
    if (lines.length === 1 && lines[0] === "(no output)") { /* nothing to show */ }
    else {
      for (const l of lines.slice(0, 12)) body.push("    " + c.faint(clip(l, w - 4)));
      if (lines.length > 12) body.push("    " + c.faint(`… +${lines.length - 12} lines`));
    }
  } else if (name === "diff") {
    for (const l of r.split("\n").slice(0, 18)) {
      const t = clip(l, w - 4);
      body.push("    " + (t[0] === "+" ? c.green(t) : t[0] === "-" ? c.red(t) : c.faint(t)));
    }
    const extra = r.split("\n").length - 18;
    if (extra > 0) body.push("    " + c.faint(`… +${extra} lines`));
  }
  return [head, ...body];
}

// a tiny spinner that runs while an async fn is pending
export async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) return fn();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write("\r" + c.magenta(frames[i++ % frames.length]) + " " + c.dim(label) + "  ");
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    process.stdout.write("\r\x1b[2K"); // clear line
  }
}
