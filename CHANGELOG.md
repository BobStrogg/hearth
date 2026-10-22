# Changelog

## 0.5.4
- Same as 0.5.3, which was tagged but never published (a timing-sensitive browser test failed on one CI runner; the test now
  waits for the history replay more tolerantly and reports what the page showed if it fails).

## 0.5.3 (not published)
- Keyboard mode: Hearth now follows the visual viewport, so on-screen keyboards that resize it (iOS, Android) keep the
  composer visible. For browsers that draw a keyboard over the page without saying so (for example the Tesla browser), the
  ⌨︎ button in the header (touch screens only) squeezes the whole app into the top part of the screen. The composer stays
  pinned at the bottom of that area, and the conversation, the queue and the latest message stay above the keyboard. −/+ set
  the size (30-80 % of the screen, default 52 %, remembered per device). In the Tesla browser it turns on by itself while
  any text field has focus (composer, queue edits, file browser, settings) and off when it loses focus, debounced so moving
  between fields doesn't flap. Sheets, the queue list and images size to the squeezed area.

## 0.5.2
- Files: the file browser no longer freezes Hearth. Listing, opening, uploading and new-folder calls were synchronous,
  so a folder macOS protects (Desktop, Documents, Downloads, cloud or network folders) could block the whole server
  (every page, sessions and health checks) while macOS waited for someone to answer a privacy prompt on the Mac's
  screen, often after Node was upgraded, since macOS ties those permissions to the exact binary. All file-browser calls are now
  asynchronous with a deadline (`HEARTH_FILES_TIMEOUT_MS`, default 15 s). A call past it answers 504 with what to do
  (click Allow on the Mac, or give node Full Disk Access). While 3 calls are still stuck, new file requests are refused
  at once, so the rest of Hearth keeps working. Entries are stat'ed a few at a time.
- The libuv thread pool defaults to 16 threads (`UV_THREADPOOL_SIZE`, if not already set).
- Files view shows "Loading…" while a folder opens, and a link back to the top of Files after an error.

## 0.5.1
- Files: downloads that failed with "Site wasn't available" behind a proxy/tunnel now work or say why. The file is
  opened and its first block read before any header is sent, so a file that's listed but can't be read (macOS privacy
  controls, an iCloud placeholder, another user's file) gets a real error with a plain reason instead of a dropped
  connection (which Cloudflare Tunnel reports to the browser as a 502). macOS `EPERM` explains how to grant access.
- Files: clicking a file checks it first (`/api/files/download?check=1`) and shows any problem in the list, then
  hands the download to the browser as before (streamed to disk).
- Files: downloads support `Range`/`If-Range` (206, 416), `ETag`, `Last-Modified` and `HEAD`, so the browser's Resume
  continues an interrupted download. `filename*` is fully RFC 5987-encoded. Read errors are logged.

## 0.5.0
- Notifications: each device can opt in (🔔 on the session list) to Web Push notifications when an agent finishes a
  turn (with the end of its reply; errors and unusual stop reasons say so) or is waiting for approval. Nothing is sent
  for a session you're looking at, for your own Stop, or while the queue moves straight on to the next prompt. VAPID +
  aes128gcm implemented with node:crypto (no new dependencies); keys in `vapid.json`, subscriptions per user; gone
  subscriptions (404/410) are dropped. Choose per device: finished, approval, or both; "Send a test". iPhone/iPad need
  Hearth added to the Home Screen. New `web/sw.js` (notifications only, no caching). `HEARTH_PUSH=off` disables it.
- Files: 📁 Files lists, downloads (streamed, always as attachments) and uploads files (8 MB chunks, resumable, explicit
  overwrite) and creates folders, confined to `HEARTH_FILES_ROOT` (default: home). `..`, absolute paths and symlinks
  leaving the root are refused; such links are hidden from listings. `HEARTH_FILES=off` disables it.
- `/api/me` reports whether files and notifications are available.

## 0.4.4
- Prompt queue: sending while the agent is busy queues the prompt (the send button reads "Queue") instead of failing
  with "agent is busy". The queue is per session, kept on the machine in `sessions/<id>/queue.json` (written only when
  it changes; removed when empty), capped at 10 prompts, and synced live to every open client.
- A turn that ends normally runs the next queued prompt (FIFO, one at a time). An error, a Stop, or any other stop
  reason (e.g. `max_tokens`, `refusal`) pauses the queue with the reason shown and a Resume button. A queue left over
  from a Hearth restart also waits for Resume. Sending while paused and idle runs that prompt directly.
- Queued prompts can be edited (text; attached images and other blocks are kept), moved (↑/↓, or drag on desktop),
  deleted, or sent now (cancels the current turn, then runs that prompt and resumes the queue).
- Session list entries include a `queued` count for live sessions. Auto-update also waits while a turn is starting.

## 0.4.3
- `HEARTH_USER_ALIASES` (`alias=canonical` pairs; `hearth service install --user-aliases …`): one person signing in
  through several Access login methods (email PIN, GitHub, Google) keeps one set of sessions. Applied before the
  allow-list and the per-user data dir; `hearth doctor` reports the alias count.

## 0.4.2
- Same changes as 0.4.1 (which has no published release: its build hit a flaky streaming-timing test on a slow
  macOS Intel runner). The test now judges the spread across all streamed chunks instead of a single gap.

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
