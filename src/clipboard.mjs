// Read an image from the system clipboard and save it to a temp file.
// Zero-dep: macOS uses the built-in `osascript`; Linux uses wl-paste/xclip if present.
// Returns the written file path, or null if the clipboard has no image / unsupported OS.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const has = (cmd) => spawnSync("command", ["-v", cmd], { shell: true }).status === 0;

// macOS: AppleScript can pull the clipboard as PNG (« class PNGf ») and write it out.
function saveMac(file) {
  const script = `
try
  set png to (the clipboard as «class PNGf»)
on error
  return "NOIMAGE"
end try
set f to (open for access (POSIX file ${JSON.stringify(file)}) with write permission)
set eof f to 0
write png to f
close access f
return "OK"`;
  const res = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 5000 });
  return (res.stdout || "").trim() === "OK";
}

// Linux: wl-paste (Wayland) or xclip (X11), trying common image mime types.
function saveLinux(file) {
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    let buf = null;
    if (has("wl-paste")) {
      const r = spawnSync("wl-paste", ["--type", mime, "--no-newline"], { maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0 && r.stdout?.length) buf = r.stdout;
    }
    if (!buf && has("xclip")) {
      const r = spawnSync("xclip", ["-selection", "clipboard", "-t", mime, "-o"], { maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0 && r.stdout?.length) buf = r.stdout;
    }
    if (buf?.length) { fs.writeFileSync(file, buf); return true; }
  }
  return false;
}

export function saveClipboardImage() {
  const file = path.join(os.tmpdir(), `tawx-clip-${Date.now()}.png`);
  let ok = false;
  try {
    if (process.platform === "darwin") ok = saveMac(file);
    else if (process.platform === "linux") ok = saveLinux(file);
  } catch { ok = false; }
  if (ok && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return null;
}
