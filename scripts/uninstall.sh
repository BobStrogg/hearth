#!/usr/bin/env bash
# Stop the Hearth service. Pass --purge to also delete ~/.hearth (and the XDG/AppData data and config dirs).
set -euo pipefail
DIR="${HEARTH_HOME:-$HOME/.hearth}"; APP="$DIR/app"
export PATH="$APP/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v hearth >/dev/null 2>&1; then hearth service uninstall 2>/dev/null || true
elif [ -f "$APP/lib/node_modules/hearth-acp/dist/main.js" ]; then
  node "$APP/lib/node_modules/hearth-acp/dist/main.js" service uninstall 2>/dev/null || true
else
  # Pre-0.4 fallback: remove the old LaunchAgent / systemd unit by hand.
  case "$(uname -s)" in
    Darwin) P="$HOME/Library/LaunchAgents/io.github.hearth.plist"; launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || true; rm -f "$P" ;;
    Linux) systemctl --user disable --now hearth.service 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/hearth.service" ;;
  esac
fi
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DIR" "${XDG_DATA_HOME:-$HOME/.local/share}/hearth" "${XDG_CONFIG_HOME:-$HOME/.config}/hearth"
  [ "$(uname -s)" = Darwin ] || true
  echo "Removed config and sessions."
else
  echo "Service removed. Config and sessions were kept (pass --purge to delete them)."
fi
