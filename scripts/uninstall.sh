#!/usr/bin/env bash
# Removes the service. Keeps ~/.hearth (your sessions) unless --purge is given.
set -eu
if [ "$(uname -s)" = Darwin ]; then
  P="$HOME/Library/LaunchAgents/io.github.hearth.plist"
  launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || true; rm -f "$P"
else
  systemctl --user disable --now hearth.service 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/hearth.service"
fi
rm -rf "$HOME/.hearth/app"
[ "${1:-}" = "--purge" ] && rm -rf "$HOME/.hearth"
echo "Hearth removed."
