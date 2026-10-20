# Changelog

## 0.4.1
- Fix: the model/mode pills and settings sheet stayed empty for real agents. Config options are keyed by `id` in the
  ACP spec (Claude Code, Grok Build and Devin all send `id`); Hearth only read a non-standard `configId`, dropped every
  option, and then also skipped the legacy `modes`/`models` because `configOptions` was present. Both keys are now
  accepted, and options saved by earlier versions show up again without restarting the agent.
- Legacy `modes` / unstable `models` now fill in a category (mode or model) that the agent's config options don't
  cover, so an agent that advertises its model as a config option but its mode only as `modes` gets both pills.
  Config options that yield nothing usable fall back to the legacy shapes.
- Select values wrapped as `{ value }` are accepted; selects without any choices are skipped.
- Tests: the mock agent sends spec-shaped options and can also send `configId`, split (mode via `modes`), late
  (`config_option_update` after `session/new`) and wrapped shapes; unit tests use trimmed real Claude Code payloads.

## 0.4.0
- Cross-platform packaging. `hearth service install|uninstall|start|stop|restart|status|logs` behind a common
  ServiceManager: LaunchAgent (or `--system` LaunchDaemon) on macOS, systemd `--user` (or `--system`) on Linux, Task
  Scheduler on Windows (experimental). Migrates the old `run.sh` LaunchAgent in place.
- `hearth doctor` checks Node, agents, port, config, the service, Cloudflare Access and updates.
- `hearth update` (and optional `HEARTH_AUTO_UPDATE=on`) pulls a verified GitHub Release, restarts the service and rolls
  back if `/healthz` fails. The web UI shows the version and an "Update now" button.
- Config and data use XDG on Linux and `%APPDATA%` on Windows; an existing `~/.hearth` is kept. `hearth --version`.
- npm package `hearth-acp`, one-liner installer, Homebrew tap (`BobStrogg/homebrew-hearth`), single-file binaries
  (Node SEA) attached to GitHub Releases with `SHA256SUMS`. CI on macOS + Linux (+ Windows best-effort); gitleaks on
  every push/PR.
- Windows: path-safe `which` (PATHEXT), `shell: true` for agent spawn, `cmd.exe` for shell terminals.

## 0.3.3
- Inline images. ACP `image` blocks (base64 `data` or `uri`), `resource_link` and embedded `resource` blocks with an
  `image/*` type, images inside tool results (including MCP-style `rawOutput.content`), and markdown images
  (`![alt](url)`, plus links that point at image files) are shown inline, sized to the message, lazy-loaded.
  Tap/click opens a full-size overlay (tap or Esc to close); Open/Save stays available.
- PNG, JPEG, GIF, WebP and AVIF; SVG only ever through `<img>` (never inline markup).
- Local files (`file://`, absolute or session-relative paths) are served by `GET /api/sessions/:id/file`: same auth as
  the API, image extensions only, inside the session folder only (symlinks resolved), magic bytes checked, 30 MB cap,
  sandboxed CSP.
- Scroll position stays put when images load late (including in lazily loaded history); base64 isn't dumped into tool
  cards.

## 0.3.2
- Lazy history: sessions open on the last turns and page older ones in as you scroll up, keeping your place.

## 0.3.1
- Fix duplicated/interleaved streaming text (one WebSocket per chat; Devin import double-subscribe).

## 0.3.0
- Agent settings: model/mode pills and a settings sheet for everything else the agent advertises.
