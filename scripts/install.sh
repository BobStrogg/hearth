#!/usr/bin/env bash
# Hearth installer: macOS (LaunchAgent) or Linux (systemd --user). No sudo.
#   curl -fsSL <url>/install.sh | bash
# Optional environment (written to ~/.hearth/env on first install only):
#   HEARTH_SOURCE            npm spec to install (default: github:BobStrogg/hearth)
#   HEARTH_PUBLIC_ORIGIN     e.g. https://agents.example.com (added to allowed origins)
#   HEARTH_IDENTITY          single: | header:<name> | cloudflare   (default single:)
#   HEARTH_CF_TEAM_DOMAIN    https://<team>.cloudflareaccess.com    (identity=cloudflare)
#   HEARTH_CF_AUD            Access application AUD tag             (identity=cloudflare)
#   HEARTH_PASSWORD          off | os | scrypt:...                  (default: os on macOS, off elsewhere)
#   HEARTH_PORT              default 7682
set -euo pipefail
SRC="${HEARTH_SOURCE:-github:BobStrogg/hearth}"
DIR="$HOME/.hearth"; APP="$DIR/app"; PORT="${HEARTH_PORT:-7682}"
OS="$(uname -s)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

need_node() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! need_node; then
  if [ "$OS" = Darwin ] && command -v brew >/dev/null; then echo "Installing Node via Homebrew..."; brew install node
  else echo "Hearth needs Node.js 20 or newer. Install it, then re-run." >&2; exit 1; fi
fi
NODE="$(command -v node)"

mkdir -p "$DIR" && chmod 700 "$DIR"
echo "Installing $SRC ..."
npm install -g --prefix "$APP" "$SRC" >/dev/null
BIN="$APP/lib/node_modules/hearth-acp/dist/main.js"
[ -f "$BIN" ] || { echo "install failed: $BIN missing" >&2; exit 1; }

if [ ! -f "$DIR/env" ]; then
  DEF_PW=off; [ "$OS" = Darwin ] && DEF_PW=os
  ORIGINS="http://127.0.0.1:$PORT,http://localhost:$PORT"
  [ -n "${HEARTH_PUBLIC_ORIGIN:-}" ] && ORIGINS="$HEARTH_PUBLIC_ORIGIN,$ORIGINS"
  umask 077
  cat > "$DIR/env" <<ENV
HEARTH_PORT=$PORT
HEARTH_ALLOWED_ORIGINS=$ORIGINS
HEARTH_IDENTITY=${HEARTH_IDENTITY:-single:}
HEARTH_CF_TEAM_DOMAIN=${HEARTH_CF_TEAM_DOMAIN:-}
HEARTH_CF_AUD=${HEARTH_CF_AUD:-}
HEARTH_PASSWORD=${HEARTH_PASSWORD:-$DEF_PW}
HEARTH_ROOTS=$HOME
ENV
  echo "Wrote $DIR/env"
fi

cat > "$DIR/run.sh" <<RUN
#!/bin/bash
set -a; . "$DIR/env"; set +a
export PATH="\$HOME/.local/bin:\$HOME/.grok/bin:\$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec "$NODE" "$BIN" serve
RUN
chmod 700 "$DIR/run.sh"

if [ "$OS" = Darwin ]; then
  P="$HOME/Library/LaunchAgents/io.github.hearth.plist"; mkdir -p "$(dirname "$P")"
  cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.github.hearth</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/run.sh</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/hearth.log</string><key>StandardErrorPath</key><string>$DIR/hearth.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
elif ! command -v systemctl >/dev/null; then
  echo "No systemd found. Start Hearth with your own service manager: /bin/bash $DIR/run.sh" >&2; exit 0
else
  U="$HOME/.config/systemd/user/hearth.service"; mkdir -p "$(dirname "$U")"
  cat > "$U" <<UNIT
[Unit]
Description=Hearth ACP agent daemon
[Service]
ExecStart=/bin/bash $DIR/run.sh
Restart=always
[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now hearth.service
  echo "Tip: 'loginctl enable-linger $USER' keeps Hearth running when you're logged out."
fi

for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "Agents found:"; ( set -a; . "$DIR/env"; set +a; "$NODE" "$BIN" probe | grep '✓' ) || true
    echo "Hearth OK on http://127.0.0.1:$PORT"; exit 0
  fi
  sleep 0.5
done
echo "Hearth did not start; see $DIR/hearth.log" >&2; exit 1
