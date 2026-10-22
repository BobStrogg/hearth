#!/usr/bin/env bash
# Hearth one-liner installer. Installs Node if needed (Homebrew on macOS, apt/dnf/pacman on Linux when available),
# then installs the npm package and registers a background service.
#
#   curl -fsSL https://raw.githubusercontent.com/BobStrogg/hearth/main/scripts/install.sh | bash
#
# Optional environment (also accepted by `hearth service install` afterwards):
#   HEARTH_SOURCE            npm spec (default: hearth-acp@latest; use a local .tgz or github:BobStrogg/hearth)
#   HEARTH_PUBLIC_ORIGIN     e.g. https://agents.example.com
#   HEARTH_IDENTITY          single: | header:<name> | cloudflare
#   HEARTH_CF_TEAM_DOMAIN    https://<team>.cloudflareaccess.com
#   HEARTH_CF_AUD            Access application AUD
#   HEARTH_PASSWORD          off | os | scrypt:...
#   HEARTH_PORT              default 7682
#   HEARTH_AUTO_UPDATE       on | off (default off)
set -euo pipefail
SRC="${HEARTH_SOURCE:-hearth-acp@latest}"
DIR="${HEARTH_HOME:-$HOME/.hearth}"; APP="$DIR/app"
OS="$(uname -s)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

need_node() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! need_node; then
  if [ "$OS" = Darwin ] && command -v brew >/dev/null; then echo "Installing Node via Homebrew…"; brew install node
  elif command -v apt-get >/dev/null 2>&1; then echo "Installing Node via apt…"; sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm
  elif command -v dnf >/dev/null 2>&1; then echo "Installing Node via dnf…"; sudo dnf install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then echo "Installing Node via pacman…"; sudo pacman -S --noconfirm nodejs npm
  else echo "Hearth needs Node.js 22+ (22.23.4, 24.22.1, 26.12.1 or newer). Install it (https://nodejs.org), then re-run." >&2; exit 1; fi
  need_node || { echo "Node.js 22+ still missing after install (your package manager may ship an older one: see https://nodejs.org)." >&2; exit 1; }
fi
# Patched releases per line (October 2026 Node.js security release). Older ones still work, but update soon.
node -e 'const f={22:"22.23.4",24:"24.22.1",26:"26.12.1"},v=process.versions.node,m=+v.split(".")[0],p=s=>s.split(".").map(Number);
  const lt=(a,b)=>{a=p(a);b=p(b);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]<b[i];return false};
  const w=f[m]?(lt(v,f[m])&&"has known security vulnerabilities; update to "+f[m]+" or newer"):(m<26&&"is a line that no longer gets security fixes; use 22, 24 or 26");
  if(w)console.error("WARNING: Node.js "+v+" "+w+".")' || true

mkdir -p "$DIR" && chmod 700 "$DIR"
echo "Installing $SRC …"
npm install -g --prefix "$APP" --no-audit --no-fund "$SRC"
BIN="$APP/bin/hearth"
[ -x "$BIN" ] || BIN="$APP/lib/node_modules/hearth-acp/dist/main.js"
[ -f "$BIN" ] || { echo "install failed: hearth binary missing under $APP" >&2; exit 1; }

# Prefer the shims npm wrote; fall back to node + main.js.
if [ -x "$APP/bin/hearth" ]; then HEARTH="$APP/bin/hearth"
else HEARTH="$(command -v node) $BIN"; fi
export PATH="$APP/bin:$PATH"

# Pass any HEARTH_* already in the environment through to `service install` (first-run defaults).
# shellcheck disable=SC2086
$HEARTH service install ${HEARTH_SYSTEM:+--system}
echo
$HEARTH doctor --offline || true
echo
echo "Done. Open http://127.0.0.1:${HEARTH_PORT:-7682}"
echo "Behind Cloudflare Access? See docs/cloudflare.md"
