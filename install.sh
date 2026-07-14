#!/usr/bin/env bash
# tawx installer. One-liner:
#   curl -fsSL https://raw.githubusercontent.com/tawgroup/tawx/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/tawgroup/tawx.git"
DIR="${TAWX_HOME:-$HOME/.tawx/app}"
LEGACY_DIR="$HOME/.tawx-harness"   # where releases before 0.19 installed

echo "▟▙ tawx installer"

# 1. Node check (>= 20)
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node >= 20 first (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node >= 20 required (found $(node -v))." >&2
  exit 1
fi

# 2. Clone or update. Pre-0.19 installs live in ~/.tawx-harness — move them over
# rather than cloning a second copy that the old one keeps shadowing on PATH.
if [ ! -d "$DIR/.git" ] && [ -d "$LEGACY_DIR/.git" ]; then
  echo "→ Moving $LEGACY_DIR → $DIR"
  mkdir -p "$(dirname "$DIR")"
  mv "$LEGACY_DIR" "$DIR"
  git -C "$DIR" remote set-url origin "$REPO"   # repo was renamed: tawx-harness → tawx
fi

if [ -d "$DIR/.git" ]; then
  echo "→ Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "→ Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

# 3. Make the `tawx` command available
chmod +x "$DIR/bin/taw.mjs"
echo "→ Installing the 'tawx' and 'tx' commands"
if ( cd "$DIR" && npm install -g . >/dev/null 2>&1 ); then
  echo "  installed globally via npm"
else
  # npm global prefix is often root-owned on Linux — fall back to a user-local symlink (no sudo).
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
  ln -sf "$DIR/bin/taw.mjs" "$BIN/tawx"
  ln -sf "$DIR/bin/taw.mjs" "$BIN/tx"
  echo "  npm -g not permitted → linked $BIN/tawx and $BIN/tx"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        [ -e "$rc" ] || continue
        grep -q 'tawx PATH' "$rc" 2>/dev/null || \
          printf '\n# tawx PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      done
      echo "  → added ~/.local/bin to PATH. Open a NEW terminal, or run:"
      echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
fi

# 4. Config dir — must match TAWX_DIR in src/config.mjs (~/.tawx), which is where
# auth.json and sessions live. Model + provider are stored per-provider in auth.json
# (set via `tawx login` / `/model` in the TUI), so we DON'T pin a model in .env —
# a hard-coded TAWX_MODEL would override the saved choice and break other providers.
mkdir -p "$HOME/.tawx" && chmod 700 "$HOME/.tawx"

echo ""
echo "✓ Done. Try:  tawx --help    (or just: tawx / tx)"
echo "  Get a key: https://opencode.ai → workspace → API Keys"
