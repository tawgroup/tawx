// taw-harness config — resolves API key, base URL, model from env/.env/CLI.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- minimal .env loader (zero-dep) ----
function loadDotenv(dir) {
  const p = path.join(dir, ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(process.cwd());
loadDotenv(path.join(os.homedir(), ".taw"));

// ---- OpenCode Go endpoint (verified: bills the $10 Go subscription, cost=0) ----
export const BASE_URL =
  process.env.TAW_BASE_URL || "https://opencode.ai/zen/go/v1";

export const API_KEY =
  process.env.OPENCODE_API_KEY || process.env.TAW_API_KEY || "";

// Models included in the OpenCode Go subscription (verified via /zen/go/v1/models).
export const GO_MODELS = [
  "glm-5.1", "glm-5",
  "deepseek-v4-pro", "deepseek-v4-flash",
  "qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus",
  "kimi-k2.6", "kimi-k2.5",
  "minimax-m2.7", "minimax-m2.5",
  "mimo-v2.5-pro", "mimo-v2.5",
];

// glm-5: ĐÁNG TIN cho vòng lặp agent (multi-turn tool ổn định).
// kimi-k2.5 nhanh + non-reasoning NHƯNG hỏng multi-turn ("Provider returned error" sau
// vài tool-result) → chỉ hợp gen 1-phát (TAW_MODEL=kimi-k2.5 + max-steps 1-2), KHÔNG nên làm default.
export const DEFAULT_MODEL = process.env.TAW_MODEL || "glm-5";

export const MAX_STEPS = Number(process.env.TAW_MAX_STEPS || 40);
export const MAX_TOKENS = Number(process.env.TAW_MAX_TOKENS || 8192);
// hard timeout per model request — cheap Go models can stall on big generations
export const REQUEST_TIMEOUT_MS = Number(process.env.TAW_REQUEST_TIMEOUT || 180000);
// cap of bytes returned to the model from a single tool result
export const TOOL_OUTPUT_CAP = Number(process.env.TAW_TOOL_CAP || 30000);

export function assertKey() {
  if (!API_KEY) {
    throw new Error(
      "Chưa có API key. Set OPENCODE_API_KEY (key gói OpenCode Go) trong env hoặc .env.\n" +
        "Lấy key tại: https://opencode.ai → workspace → API Keys",
    );
  }
}
