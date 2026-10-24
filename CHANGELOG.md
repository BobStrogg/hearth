# Changelog

## 0.7.0
- Goose's providers are agents of their own in the picker. Hearth asks Goose (its ACP extension,
  `_goose/unstable/providers/list`) which providers are set up and lists each as "Goose · <provider>", e.g.
  "Goose · Cloudflare Workers AI": a custom provider you defined (`~/.config/goose/custom_providers/*.json`) unless its
  key is missing, or another provider once its key is set. Each starts `goose acp` with `GOOSE_PROVIDER` and that
  provider's default model; pick another of its models with the session's Model pill (Goose's own ACP option, remembered
  per entry). If Goose's config pins one context limit (fm-serve-goose sets 4096 for the on-device model), another
  provider gets the smallest limit its own models advertise instead. Hearth never reads or stores a key: Goose only
  says whether it is set, and never runs a provider's `auth` command (a custom provider that gets its key from one, such
  as the home setup's Cloudflare provider, is listed like one with no key field). A custom provider on this computer (a
  loopback `base_url`, e.g. one for fm serve's proxy) is listed only while its `/models` answers. An older Goose without
  these methods just shows as "Goose".
- Goose is also found where [fm-serve-goose](https://github.com/BobStrogg/fm-serve-goose) installs it
  (`~/Developer/fm-serve-goose/bin/goose`), as well as on the PATH, `~/.local/bin` and Homebrew. That install adds
  "Goose · on-Mac (fm serve)" (Apple's on-device model, macOS 27) while its local proxy answers, started with the repo's
  settings from its `config.example.yaml`; if the proxy has stopped by the time you start one, the session says so
  instead of quietly using another model. When Goose has its own custom provider for the same local server, that one
  is listed instead.
- Plain "Goose" (its own config) stays, but is left out of the new-session picker when one of the entries above is what
  it would start anyway. Entries that aren't ready right now are left out too; their existing sessions keep working
  (saved in `agent-variants.json`, provider and model names only). `hearth probe` lists them under the agent.
- Agents can now have `profiles` (in `src/agents.ts` or `agents.json`): settings for one particular install, read from
  a file, each its own picker entry while a health URL answers. `detect` and `bin` paths may start with `~/`.
- Voice: a recording a little over the size limit (up to 4x) is read and dropped before the 413, so the browser gets
  the "recording too large" message instead of a dropped connection (seen as "fetch failed" on macOS).

## 0.6.0
- Voice, all opt-in and per device. A mic button by the message box dictates into it: the browser's own speech
  recognition streams words into the box as you speak, and nothing is sent until you tap Send (or turn on "Send when I
  stop talking"). A speaker pill by the composer reads each finished reply aloud with the browser's best voice
  (on-device Premium/Enhanced voices first); code blocks, diffs, tool calls, links and markdown are left out ("code
  omitted"). Each reply has its own speaker button. Hands-free (off by default) listens again after a reply is read.
  Speaking stops when you tap the mic, Send or Stop.
- Where the browser has no working speech recognition or voices (the Tesla browser, Firefox, Chromium builds without
  Google's service), or by choice for privacy, this computer does it: the browser records 16 kHz WAV and Hearth runs
  whisper.cpp (`whisper-cli`), and replies are read with macOS `say` (AAC) or piper / espeak-ng on Linux. Set it up from
  Voice settings (⋯ in a session) or `hearth voice install` (Homebrew `whisper-cpp` plus a 60 MB SHA-256-checked
  English model). New `GET /api/voice`, `POST /api/voice/transcribe|speak|install` behind the usual auth and CSRF
  checks, with size, length and time limits; temp files are deleted after each job. `HEARTH_VOICE=off` turns the
  computer side off. `hearth doctor` reports it.

## 0.5.13
- Released instead of 0.5.12 (the v0.5.12 tag has no release: the macOS Intel release build's tests timed out). Same
  changes as 0.5.12 and 0.5.11 below. Test-only fix: the start-up timeout tests give the mock agent 4 s instead of 1 s,
  so a slow CI runner's normal start isn't taken for a hang. CI now also tests on macOS Intel.

## 0.5.12 (not released)
- Not released (see 0.5.13). Same changes as
  0.5.11 below, plus: an agent is never started after its session was stopped while the folder check ran (when Hearth
  shut down at that moment, the agent could outlive it). CI now also tests on linux-arm64.

## 0.5.11 (not released)
- macOS folder permissions (Documents, Desktop, Downloads…) no longer reset with every Node.js or Hearth update. macOS
  gives them to the program launchd starts, identified by its path and signature, and Homebrew's node and the hearth
  binary change both on every update; until someone clicked Allow on the Mac's screen, agents started in such a folder
  just waited. `hearth service install` now builds a tiny launcher once (`~/.hearth/bin/hearth-launch`, needs the
  Xcode Command Line Tools) that starts Hearth and stays its parent, and never rebuilds it unless its source changes.
  Allow it once (or give it Full Disk Access) and that lasts. `hearth doctor` says whether the service uses it.
  `HEARTH_NO_LAUNCHER=1` runs Hearth directly as before.
- Before starting an agent, Hearth checks that the session folder opens (5 s limit, off the main thread). A folder
  macOS holds behind a privacy prompt used to make the agent hang silently until the 120 s start-up limit. Now the note
  says so within seconds, names the program to allow (the launcher, or node), and starts no agent. A check stuck behind
  the prompt is shared, not repeated, and clears by itself once someone clicks Allow.
- Right after starting (for example after an update), Hearth opens the folders of up to 5 recent sessions, so a macOS
  prompt appears then rather than on the next send.
- `/healthz` reports `permission: { needed, folders, since, launcher }` (folder names only, no paths) when a session
  folder or a Files request is stuck or denied, so a dashboard can show "needs permission".

## 0.5.10
- An agent that starts but never answers (it waits on a sign-in, an update, a macOS permission or keychain prompt, or
  the network): the "Couldn't start the agent" note now shows what that process printed while Hearth waited, or says it
  printed nothing (with its pid and start time). It never shows an earlier run's output, and Hearth's own clean-up kill
  no longer adds a separate "Agent stopped (signal SIGTERM)" card.
- Agent cards show when they happened, in your local time, and UTC timestamps in the agent's output are shown in local
  time too.
- `agent-stderr.log` marks the start of each run (`--- hearth X: started devin (pid N) at <local time> ---`) and moves a
  full log to `agent-stderr.log.1`. Before, a log that reached 2 MB stopped growing, so it kept showing an old run.
- Agents an earlier Hearth left running (Hearth was killed before it could stop them) are stopped when Hearth starts.
  Only a recorded group leader that still runs the recorded command is stopped. The agent probe also stops the probed
  agent's whole process group and reports its last output on a timeout.
- Internal: moved to the ACP TypeScript SDK 2.x (`@agentclientprotocol/sdk` ^2.0.1). SDK 2 removed the connection classes
  Hearth used; `src/acp.ts` now wraps the SDK's client app API, and Hearth imports the SDK's `/unstable` entrypoint so
  it keeps the same ACP v1 features as before (session/list, session/resume, config options). No behaviour change.
- CI/release actions and dev dependencies updated (Dependabot).

## 0.5.9
- When the agent exits by itself (while starting, while answering, or right after it was spawned), the chat shows one
  card with how it exited (exit code or signal, and when) and its last 20 lines of stderr, kept in the transcript so it
  survives a reload. Repeats of the same failure update that card (×N) instead of stacking "Agent stopped" lines.
- Errors that used to say only "ACP connection closed" now say "agent exited (code): <its last stderr line>".
- After 3 immediate failures in a row Hearth stops restarting the agent by itself: queued prompts pause with the reason
  (Resume tries again), and the card says why. A send still tries, and the first prompt the agent answers resets it.
- A message that couldn't be delivered because the agent couldn't start is put back in the composer.
- Start failures that aren't an exit (a timeout, a missing command, an error answer) are kept in the transcript too.

## 0.5.8
- Security: the single-file binaries attached to each release embed the Node.js that builds them, and 0.5.2 to 0.5.7
  were built on Node.js 22.23.2/22.23.3, before the October 2026 Node.js security release (CVE-2026-111497 Brotli decoder
  RCE and others). 0.5.8's binaries embed Node.js 22.23.4. If you use a downloaded binary, update it. The npm package
  runs on your own Node.js, so update that instead (see below).
- Node.js 22 or newer is required (`engines`, the installer). Node.js 20 is end of life and gets no security fixes.
- `hearth doctor` and `hearth serve` (at startup, in the log) warn when Node.js is older than the patched releases
  22.23.4, 24.22.1 or 26.12.1, or is a line that no longer gets fixes.
- Release pipeline hardening: Node.js pinned to the patched release and the build refuses to run below it; every
  GitHub Action pinned to a full commit SHA; read-only token by default, with `id-token: write` (npm trusted
  publishing) only on the npm job and `contents: write` only on the release job; npm pinned to 11.x instead of
  `latest`; Dependabot for Actions and npm.
- The GitHub release is created as a draft with every file (binaries, npm tarball, SHA256SUMS) attached and checked, and
  only then published, so it works with GitHub immutable releases (files can't change after publishing). The npm
  tarball and the release's tarball are the same file, so the checksums match.
- `HEARTH_UPDATES_URL` (`hearth service install --updates-url https://…`): for installs whose updates are managed
  elsewhere (a fleet dashboard, MDM). Hearth then never checks GitHub or updates itself (`HEARTH_AUTO_UPDATE` is
  ignored, `POST /api/update` is refused) and the version bar links there instead of offering *Update now*. The page's
  "update available" check is now at most 10 minutes old (was an hour).
- Version history note: there is no 0.5.3 release. Its tag was pushed but the release run failed and nothing was
  published; 0.5.4 replaced it. The tag is left in place (tags aren't rewritten).

## 0.5.7
- Sending into a stopped session never looks ignored. While the agent is respawned and its session reloaded (which can
  take a while with a long conversation), the chat shows "Starting the agent…" and the status reads "starting", on every
  device viewing it, including ones that open it meanwhile.
- Agent start-up has deadlines: each step (initialize, session/load or resume, session/new) gets 120 s. A session/load
  that hangs falls back to a fresh agent session (the earlier history stays on screen) so the message still goes; any
  other start failure shows "couldn't start the agent: …" in the chat and leaves no half-started agent behind, so the
  next send starts cleanly.
- A send while the page isn't connected (Hearth restarting after an update, a network drop) used to do nothing. Now it
  says it's reconnecting, keeps the message and sends it once the connection is back.

## 0.5.6
- Prompt queue: queued prompts no longer get stuck after the agent was stopped or sat idle. The queue now drains whenever
  the agent is free: after any turn ends (a Stop or cancel ends only that prompt; the queue carries on), after the agent
  restarts or a device reconnects, when Hearth starts (sessions with a leftover `queue.json` are picked up without anyone
  opening them, even if they were paused), and on a periodic idle check (`HEARTH_QUEUE_CHECK_MS`, default 15 s). A failed
  prompt pauses the queue and it retries by itself after 15 s, 1 min and 5 min (respawning the agent), then waits for
  Resume. One prompt at a time, in order, never sent twice.
- Queue UI: icons are inline SVG (move handle, send now, a trash can for delete) instead of emoji/symbol glyphs, which the
  Tesla browser's limited fonts drew wrongly. The same goes for the header (back, menu, keyboard mode, −/+), the Files and
  notification buttons, the file browser, tool-call and plan status marks and the settings button.
- Queue UI: no pencil button. Tap or click a queued prompt's text to edit it in place: Enter or leaving the field saves,
  Esc (or the × next to it) cancels. The text is a focusable button for keyboard users (Enter, Space or F2 edits).
- Queue UI: drag a prompt's handle to reorder it, with pointer events (mouse, touch, the Tesla touchscreen); the list
  doesn't scroll under your finger and the new order is saved on the server. Arrow keys (and Home/End) on the focused
  handle move it too. The ↑/↓ buttons are gone.
- The queue list keeps its nodes when an update changes nothing visible, so a tap in progress isn't lost.

## 0.5.5
- Keyboard mode: a viewport resize only jumps to the latest message if you were already following the end (reading older
  history stays put), and only when the size actually changed. Found by the macOS CI history-paging test on 0.5.4.

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
