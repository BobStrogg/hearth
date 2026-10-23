import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AgentDef, searchPath, winShell } from "./agents.js";
import type { SessionMeta, Store, TranscriptEntry } from "./store.js";
import { absorb, applyUpdate, MODE_ID, MODEL_ID, normalize, setLocal, valid, type RawSettings, type UiOption } from "./settings.js";
import { VERSION } from "./version.js";
import { PromptQueue, QueueError, type QueueView } from "./queue.js";

export type LiveEvent =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "state"; state: SessionMeta["state"]; title: string }
  | { type: "permission"; id: string; params: acp.RequestPermissionRequest }
  | { type: "permission_resolved"; id: string; optionId?: string }
  | { type: "prompt_done"; stopReason: string }
  | { type: "error"; message: string }
  | { type: "agent_starting" }
  | { type: "agent_ready" }
  | { type: "settings"; options: UiOption[] }
  | ({ type: "queue" } & QueueView);

class StartTimeout extends Error {}
/** The last meaningful line an agent wrote to stderr (what to show in a one-line error). */
const lastLine = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";
interface Pending { params: acp.RequestPermissionRequest; resolve: (r: acp.RequestPermissionResponse) => void }
export interface Term { buf: Buffer; truncated: boolean; exit?: { exitCode: number | null; signal: string | null }; done: Promise<void>; text(): string; kill(): void }

/** The user's login shell (launchd gives daemons a minimal environment). */
export function userShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  const sh = process.env.SHELL;
  if (sh && existsSync(sh)) return sh;
  return process.platform === "darwin" ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}
const shq = (a: string) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;

/**
 * Run an ACP terminal command. Agents differ: some send {command:"git", args:["status"]}, others send a whole
 * shell line as `command` with no args ("ls -la | head"). With no args we run it through the user's shell;
 * with args we exec directly and fall back to the shell if the binary can't be found on PATH.
 */
export function startTerminal(command: string, args: string[], cwd: string, env: Record<string, string>, limit: number, onError: (e: string) => void): Term {
  const fullEnv = { ...process.env, PATH: searchPath(), TERM: "dumb", NO_COLOR: "1", ...env };
  const viaShell = !args.length;
  const line = viaShell ? command : [command, ...args].map(shq).join(" ");
  let proc: ChildProcess;
  const t: Term = {
    buf: Buffer.alloc(0), truncated: false, done: Promise.resolve(),
    text() { let s = t.buf.toString("utf8"); if (t.truncated) s = s.replace(/^\uFFFD+/, ""); return s; },
    kill() { if (proc?.pid && t.exit === undefined) { try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } } },
  };
  const add = (b: Buffer) => { t.buf = Buffer.concat([t.buf, b]); if (t.buf.length > limit) { t.buf = t.buf.subarray(t.buf.length - limit); t.truncated = true; } };
  t.done = new Promise((res) => {
    const run = (shell: boolean) => {
      proc = shell ? spawn(userShell(), process.platform === "win32" ? ["/d", "/s", "/c", line] : ["-lc", line], { cwd, env: fullEnv, stdio: ["ignore", "pipe", "pipe"], detached: true })
        : spawn(command, args, { cwd, env: fullEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
      proc.stdout!.on("data", add); proc.stderr!.on("data", add);
      let failed = false;
      proc.on("error", (e: NodeJS.ErrnoException) => {
        failed = true;
        if (!shell && e.code === "ENOENT") return run(true);
        onError(String(e.message)); add(Buffer.from(`${e.message}\n`)); t.exit = { exitCode: 127, signal: null }; res();
      });
      proc.on("close", (code, signal) => { if (failed) return; t.exit = { exitCode: code, signal: signal ?? null }; res(); });
    };
    run(viaShell);
  });
  return t;
}

/** True if `p` (resolved) is inside `root`. Follows symlinks; for not-yet-created paths, realpaths the longest existing prefix (so /var vs /private/var on macOS still works). */
export function within(root: string, p: string): boolean {
  const realPrefix = (x: string): string => {
    let cur = resolve(x), rest: string[] = [];
    for (;;) {
      try { return rest.length ? join(realpathSync(cur), ...rest) : realpathSync(cur); }
      catch { const next = dirname(cur); if (next === cur) return join(cur, ...rest); rest.unshift(basename(cur)); cur = next; }
    }
  };
  const r = realPrefix(root);
  const target = realPrefix(p);
  const rel = relative(r, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class LiveSession {
  child?: ChildProcess;
  conn?: acp.ClientSideConnection;
  caps?: acp.InitializeResponse;
  pending = new Map<string, Pending>();
  listeners = new Set<(e: LiveEvent) => void>();
  terms = new Map<string, Term>();
  private permSeq = 0;
  private termSeq = 0;
  private loading = false;
  private starting?: Promise<void>;
  prompting = false;

  /** Prompts sent while a turn is running; see submit(). */
  readonly queue: PromptQueue;
  /** True from the moment a turn is requested until it has finished (covers agent start-up, unlike `prompting`). */
  turnActive = false;
  private userCancelled = false;
  private sendNowPending = false;

  constructor(public meta: SessionMeta, private agent: AgentDef, private store: Store) {
    let file = "";
    try { file = join(store.dir(meta.owner, meta.id), "queue.json"); } catch { /* bad id: never persisted */ }
    this.queue = new PromptQueue(file, (v) => this.emit({ type: "queue", ...v }));
  }

  /**
   * A prompt from the user: runs now if the agent is free, otherwise joins the queue (FIFO). Whenever the agent is
   * idle (a turn ended for any reason, including Stop; the agent restarted; Hearth started; the periodic check) the
   * next queued prompt runs by itself. After an error the queue pauses and retries by itself with backoff.
   */
  submit(content: acp.ContentBlock[]): { queued: boolean } {
    if (!Array.isArray(content) || !content.length) throw new QueueError("empty prompt");
    if (this.turnActive) { this.queue.add(content); return { queued: true }; }
    void this.runTurn(content);
    return { queued: false };
  }
  /** Resume a paused queue (or start a waiting one): runs the next prompt if the agent is free. */
  resumeQueue() { this.retries = 0; this.retryAt = 0; this.quickFails = 0; this.queue.setPaused(false); this.kick(); }

  /** An exit within this long of the agent being spawned (or while it starts or answers) counts as an immediate failure. */
  static QUICK_EXIT_MS = 20_000;
  /** After this many immediate failures in a row Hearth stops restarting the agent by itself (sends still try). */
  static MAX_QUICK_FAILS = 3;
  /** Immediate failures in a row (reset when a prompt completes, or on Resume). */
  quickFails = 0;
  get crashLooping() { return this.quickFails >= LiveSession.MAX_QUICK_FAILS; }
  private phase: "starting" | "prompt" | "idle" = "idle";
  private lastFailLine = "";
  private lastExit?: { child: ChildProcess; code: number | null; signal: string | null; line: string };
  /**
   * "ACP connection closed" says nothing: when a request fails because the agent died, wait a moment for its exit
   * and report that instead (exit code or signal and its last stderr line).
   */
  private async explain(e: unknown, child: ChildProcess | undefined): Promise<never> {
    if (child && /connection closed|stream closed|EPIPE|ECONNRESET/i.test(String((e as Error)?.message ?? e))) {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((r) => { const t = setTimeout(r, 1500); child.once("exit", () => { clearTimeout(t); setImmediate(r); }); });
      const x = this.lastExit;
      if (x && x.child === child) throw new Error(`agent exited (${x.code ?? x.signal})${x.line ? `: ${x.line}` : ""}`);
    }
    throw e;
  }
  private intendedKills = new WeakSet<ChildProcess>();

  /** Delays before a queue paused by a failed prompt tries again by itself (then it waits for Resume). */
  static RETRY_MS = [15_000, 60_000, 300_000];
  private retries = 0; private retryAt = 0;
  /**
   * Drain the queue if the agent is free: called after every turn, by the periodic idle check, on Hearth startup and
   * after an agent restart. Runs at most one prompt at a time, in order; the agent is respawned by prompt() if it
   * exited. A queue paused by a failure resumes by itself once its retry time has come.
   */
  kick(): boolean {
    if (!this.queue.items.length || this.turnActive || this.prompting || this.meta.state === "exited") return false;
    if (this.crashLooping) return false; // it keeps dying right after it starts: don't respawn it by itself
    if (this.queue.paused) { if (!this.retryAt || Date.now() < this.retryAt) return false; this.retryAt = 0; this.queue.setPaused(false); }
    this.next(); return true;
  }
  /** Run this queued prompt now: it moves to the front, and the current turn (if any) is cancelled first. */
  async sendNow(id: string) {
    const i = this.queue.items.findIndex((x) => x.id === id);
    if (i < 0) throw new QueueError("that queued prompt is gone");
    this.queue.move(id, 0);
    if (!this.turnActive) { this.queue.setPaused(false); this.next(); return; }
    this.sendNowPending = true;
    await this.cancel(true);
  }
  private next() {
    if (!this.queue.items.length) return;
    this.turnActive = true; // before the queue update goes out, so no client sees "idle with a queue"
    void this.runTurn(this.queue.shift()!.content as acp.ContentBlock[]);
  }
  private async runTurn(content: acp.ContentBlock[]) {
    this.turnActive = true; this.userCancelled = false;
    let stop: string | undefined, err: string | undefined;
    try { stop = (await this.prompt(content)).stopReason; this.emit({ type: "prompt_done", stopReason: stop }); }
    catch (e) { err = String((e as Error)?.message ?? e); this.emit({ type: "error", message: err }); }
    finally { this.turnActive = false; }
    const sendNow = this.sendNowPending; this.sendNowPending = false;
    if (!err) { this.retries = 0; this.retryAt = 0; }
    if (!this.queue.items.length || this.meta.state === "exited") return;
    if (sendNow) { this.queue.setPaused(false); return this.next(); }
    if (err && this.crashLooping) {
      this.retryAt = 0;
      return this.queue.setPaused(true, `the agent keeps exiting right after it starts (${this.quickFails} times in a row), so Hearth stopped restarting it by itself${this.lastFailLine ? `: ${this.lastFailLine}` : ""}. Fix it on the computer, then press Resume`);
    }
    if (err) {
      // A failure (agent crashed, couldn't start, …) pauses the queue; it tries again by itself a few times, respawning the agent.
      const d = LiveSession.RETRY_MS[this.retries++];
      this.retryAt = d === undefined ? 0 : Date.now() + d;
      const when = d === undefined ? "press Resume to try again" : `trying again in ${d < 60_000 ? `${Math.round(d / 1000)} s` : `${Math.round(d / 60_000)} min`}`;
      return this.queue.setPaused(true, `the last prompt failed (${when}): ${err.slice(0, 200)}`);
    }
    // A Stop, a cancel or another stop reason (max_tokens, refusal, …) ends that prompt only: the queue carries on.
    this.kick();
  }

  emit(e: LiveEvent) { for (const l of this.listeners) { try { l(e); } catch { /* ignore */ } } }

  private saveTimer?: NodeJS.Timeout;
  log(dir: TranscriptEntry["dir"], msg: unknown) {
    const entry = this.store.append(this.meta, dir, msg);
    this.meta.lastActivity = entry.ts;
    // Forward immediately; persist meta lazily so token-by-token streaming isn't slowed by a rename per chunk.
    this.emit({ type: "entry", entry });
    this.saveTimer ??= setTimeout(() => { this.saveTimer = undefined; try { this.store.save(this.meta); } catch { /* session purged */ } }, 500);
  }

  /** Agent stderr goes to sessions/<id>/agent-stderr.log (capped) so failures are diagnosable. */
  private stderrLog(chunk: Buffer | string) {
    try {
      const p = join(this.store.dir(this.meta.owner, this.meta.id), "agent-stderr.log");
      if (existsSync(p) && statSync(p).size > 2_000_000) return;
      appendFileSync(p, chunk, { mode: 0o600 });
    } catch { /* ignore */ }
  }

  get options(): UiOption[] { return normalize(this.meta.settings ?? {}); }
  updateSettings(next: RawSettings) {
    this.meta.settings = next;
    try { this.store.save(this.meta); } catch { /* purged */ }
    this.emit({ type: "settings", options: this.options });
  }

  /** Change one setting via the right ACP call; remembers it as this user's default for the agent. */
  async setOption(id: string, value: unknown, remember = true) {
    await this.ensureRunning();
    const opt = this.options.find((o) => o.id === id);
    if (!opt) throw new Error(`unknown setting ${id}`);
    if (!valid(opt, value)) throw new Error(`invalid value for ${opt.name}`);
    const sessionId = this.meta.agentSessionId!;
    if (opt.via === "mode") { await this.conn!.setSessionMode({ sessionId, modeId: String(value) }); this.updateSettings(setLocal(this.meta.settings ?? {}, opt, value)); }
    else if (opt.via === "model") { await this.conn!.request("session/set_model", { sessionId, modelId: String(value) }); this.updateSettings(setLocal(this.meta.settings ?? {}, opt, value)); }
    else {
      const req = typeof value === "boolean" ? { sessionId, configId: id, type: "boolean" as const, value } : { sessionId, configId: id, value };
      const r = await this.conn!.setSessionConfigOption(req as acp.SetSessionConfigOptionRequest);
      this.updateSettings(Array.isArray(r?.configOptions) ? absorb(this.meta.settings ?? {}, r as never) : setLocal(this.meta.settings ?? {}, opt, value));
    }
    if (remember) { try { this.store.setPref(this.meta.owner, this.meta.agentId, prefKey(opt), value); } catch { /* ignore */ } }
  }

  /** New sessions: apply the user's remembered choices that the agent still offers. Failures are logged, not fatal. */
  private async applyPrefs() {
    const prefs = this.store.getPrefs(this.meta.owner)[this.meta.agentId] ?? {};
    // model first: other options (e.g. reasoning effort) can depend on it
    const order = (o: UiOption) => (o.category === "model" ? 0 : o.category === "mode" ? 1 : 2);
    for (const opt of [...this.options].sort((a, b) => order(a) - order(b))) {
      const want = prefs[prefKey(opt)];
      const cur = this.options.find((o) => o.id === opt.id);
      if (want === undefined || !cur || cur.value === want || !valid(cur, want)) continue;
      try { await this.setOption(cur.id, want, false); }
      catch (e) { this.log("sys", { event: "setting_default_failed", option: opt.name, error: String((e as Error)?.message ?? e) }); }
    }
  }

  setState(state: SessionMeta["state"]) {
    this.meta.state = state; clearTimeout(this.saveTimer); this.saveTimer = undefined; this.store.save(this.meta);
    this.emit({ type: "state", state, title: this.meta.title });
  }

  get alive() { return !!this.child && this.child.exitCode === null && !this.child.killed; }

  /** Spawn the agent (if needed), initialize, and create or load the ACP session. */
  /** How long the agent gets to answer each start-up step (initialize, session/load or resume, session/new). */
  static START_TIMEOUT_MS = 120_000;
  /** True while the agent is being spawned and its session loaded (clients show "Starting the agent…"). */
  get isStarting() { return !!this.starting; }
  ensureRunning(): Promise<void> {
    if (this.alive && this.conn && this.meta.agentSessionId) return Promise.resolve();
    if (!this.starting) this.emit({ type: "agent_starting" });
    this.starting ??= this.start().catch(async (e) => {
      // A start that failed or timed out must not leave a half-started agent behind: the next send starts afresh.
      const c = this.child;
      if (c && c.exitCode === null) { this.recycling = true; try { await this.killChild(c); } catch { /* gone */ } finally { this.recycling = false; } }
      this.child = undefined; this.conn = undefined;
      if (this.meta.state !== "exited") this.setState("stopped");
      const why = String((e as Error)?.message ?? e);
      // An exit is already in the transcript (with its output); anything else (a timeout, a missing command, an
      // error answer such as "not logged in") is kept there too, so it is still visible after a reload.
      if (!/^agent exited/.test(why)) {
        this.quickFails++;
        this.lastFailLine = why.slice(0, 300);
        this.log("sys", { event: "agent_start_failed", error: why.slice(0, 2000), fails: this.quickFails, gaveUp: this.crashLooping || undefined });
      }
      throw new Error(`couldn't start the agent: ${why}`);
    }).then(() => {
      this.emit({ type: "agent_ready" });
      // The agent (re)started: a queue paused by a failure tries again now, and a waiting queue drains.
      if (this.retryAt) this.retryAt = 1;
      setImmediate(() => this.kick());
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(skipLoad = false): Promise<void> {
    const child = spawn(this.agent.command, this.agent.args, {
      cwd: this.meta.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { ...process.env, PATH: searchPath(), ...this.agent.env }, ...winShell(),
    });
    this.child = child;
    const spawnedAt = Date.now(); this.phase = "starting";
    let tail = "";
    child.stderr!.on("data", (d: Buffer) => { this.stderrLog(d); tail = (tail + d.toString()).slice(-2000); });
    const exited = new Promise<never>((_, rej) => {
      child.once("error", (e) => rej(e));
      child.once("exit", (code, sig) => { const last = lastLine(tail); rej(new Error(`agent exited (${code ?? sig})${last ? `: ${last}` : ""}`)); });
    });
    exited.catch(() => {});
    const step = <T,>(p: Promise<T>, what: string): Promise<T> => {
      let t: NodeJS.Timeout | undefined;
      const ms = LiveSession.START_TIMEOUT_MS;
      const late = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new StartTimeout(`the agent didn't answer ${what} within ${Math.round(ms / 1000)} s`)), ms); t.unref?.(); });
      return Promise.race([p, exited, late]).catch((e) => this.explain(e, child)).finally(() => clearTimeout(t));
    };
    child.once("exit", (code, signal) => {
      // Was this a failure (it died by itself while starting, answering, or right after it was spawned)?
      const intended = this.intendedKills.has(child) || this.recycling || this.meta.state === "exited";
      const phase = this.phase;
      const quick = !intended && (phase !== "idle" || Date.now() - spawnedAt < LiveSession.QUICK_EXIT_MS);
      this.lastExit = { child, code, signal, line: lastLine(tail) };
      if (quick) { this.quickFails++; this.lastFailLine = lastLine(tail) || `exit ${code ?? signal}`; }
      if (this.child === child) this.phase = "idle";
      const stderrTail = tail.replace(/\s+$/, "").split("\n").slice(-20).join("\n") || undefined;
      this.log("sys", { event: "agent_exit", code, signal, stderrTail, phase, intended: intended || undefined,
        fails: quick ? this.quickFails : undefined, gaveUp: quick && this.crashLooping ? true : undefined });
      for (const [id, p] of this.pending) { p.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "permission_resolved", id }); }
      this.pending.clear();
      for (const t of this.terms.values()) t.kill();
      this.terms.clear();
      this.child = undefined; this.conn = undefined; this.prompting = false;
      if (this.meta.state !== "exited" && !this.recycling) this.setState("stopped");
    });

    const raw = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const self = this;
    const readable = raw.readable.pipeThrough(new TransformStream({
      transform(msg, ctl) {
        // Track settings from the raw message: the SDK's parsed notification can drop unrecognised option shapes.
        const mm = msg as { method?: string; params?: { update?: Record<string, unknown> } };
        if (mm.method === "session/update" && mm.params?.update) { const next = applyUpdate(self.meta.settings ?? {}, mm.params.update); if (next) self.updateSettings(next); }
        if (!(mm.method === "session/update" && (self.loading || (self.dropIdleReplay && !self.prompting && REPLAY_KINDS.has(String(mm.params?.update?.sessionUpdate)))))) self.log("in", msg);
        ctl.enqueue(msg); },
    }));
    const w = raw.writable.getWriter();
    const writable = new WritableStream({ async write(msg) { self.log("out", msg); await w.write(msg); }, close: () => w.close() });
    this.conn = new acp.ClientSideConnection(() => this.clientHandler(), { readable, writable } as acp.Stream);

    const init = await step(this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "hearth", version: VERSION },
    }), "initialize");
    this.caps = init;
    const prior = this.meta.agentSessionId;
    const caps = init.agentCapabilities ?? {};
    const canResume = !!caps.sessionCapabilities?.resume;
    const seeding = this.meta.seeded === false; // imported: replay the agent's history into our transcript once
    let done = false;
    if (prior && caps.loadSession && !skipLoad) {
      this.loading = !seeding;
      try {
        if (seeding) this.log("sys", { event: "import_replay_start", agentSessionId: prior });
        const lr = await step(this.conn.loadSession({ sessionId: prior, cwd: this.meta.cwd, mcpServers: [] }), "session/load");
        this.updateSettings(absorb(this.meta.settings ?? {}, lr as never));
        this.log("sys", { event: seeding ? "session_imported" : "session_loaded", agentSessionId: prior, via: "load" });
        // Some agents keep replaying history after answering session/load; it's already in our transcript.
        if (!seeding) this.dropIdleReplay = true;
        done = true;
      } catch (e) {
        this.log("sys", { event: "session_load_failed", error: String((e as Error)?.message ?? e) });
        if (e instanceof StartTimeout) {
          // A load that hangs leaves the agent wedged: start a fresh process that doesn't try to load.
          this.loading = false; this.recycling = true;
          try { await this.killChild(child); } finally { this.recycling = false; }
          return this.start(true);
        }
      } finally { this.loading = false; }
      if (!done && canResume) {
        // Some agents (seen with Devin) attach the session even when session/load fails, so a resume on the same
        // process subscribes it twice and every update arrives 2-3x. Resume on a fresh process instead.
        this.recycling = true;
        try { await this.killChild(child); } finally { this.recycling = false; }
        return this.start(true);
      }
    }
    if (!done && prior && canResume) {
      try {
        const rr = await step(this.conn.resumeSession({ sessionId: prior, cwd: this.meta.cwd, mcpServers: [] }), "session/resume");
        this.updateSettings(absorb(this.meta.settings ?? {}, rr as never));
        this.log("sys", { event: seeding ? "session_imported" : "session_resumed", agentSessionId: prior, via: "resume",
          note: seeding ? "agent resumed the session but doesn't replay history over ACP; earlier messages aren't shown" : undefined });
        done = true;
      } catch (e) {
        this.log("sys", { event: "session_resume_failed", error: String((e as Error)?.message ?? e) });
      }
    }
    if (!done) {
      if (seeding) throw new Error("this agent couldn't load or resume that session");
      if (prior) this.log("sys", { event: "context_reset", reason: "agent could not load or resume the session; earlier history is display-only" });
      await this.newAgentSession(step);
    }
    if (seeding) { this.meta.seeded = true; if (this.meta.importedFrom) this.meta.importedFrom.via = this.meta.agentSessionId === prior ? (caps.loadSession ? "load" : "resume") : "pending"; this.store.save(this.meta); }
    this.phase = "idle";
    this.setState("idle");
    if (this.newlyCreated) { this.newlyCreated = false; await this.applyPrefs(); }
  }

  private recycling = false;
  private dropIdleReplay = false;
  private async killChild(c: ChildProcess) {
    if (c.exitCode !== null) return;
    this.intendedKills.add(c);
    const gone = new Promise<void>((res) => c.once("exit", () => res()));
    try { process.kill(-c.pid!, "SIGTERM"); } catch { c.kill("SIGTERM"); }
    const t = setTimeout(() => { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } }, 3000);
    await gone; clearTimeout(t);
  }

  private async newAgentSession(step: <T>(p: Promise<T>, what: string) => Promise<T>) {
    const r = await step(this.conn!.newSession({ cwd: this.meta.cwd, mcpServers: [] }), "session/new");
    this.meta.agentSessionId = r.sessionId;
    this.updateSettings(absorb({}, r as never));
    this.newlyCreated = true;
  }
  private newlyCreated = false;

  async prompt(content: acp.ContentBlock[]) {
    await this.ensureRunning();
    if (this.prompting) throw new Error("agent is busy; cancel first");
    this.prompting = true; this.dropIdleReplay = false; this.phase = "prompt"; this.setState("running");
    try {
      const child = this.child;
      const r = await this.conn!.prompt({ sessionId: this.meta.agentSessionId!, prompt: content }).catch((e) => this.explain(e, child));
      this.quickFails = 0; // it answered: not crash-looping
      if (this.meta.title === "New session") {
        const t = content.find((c) => c.type === "text") as { text?: string } | undefined;
        if (t?.text) { this.meta.title = t.text.slice(0, 60); }
      }
      return r;
    } finally { this.prompting = false; if (this.phase === "prompt") this.phase = "idle"; if (this.alive) this.setState("idle"); }
  }

  async cancel(internal = false) {
    if (!internal && this.turnActive) this.userCancelled = true;
    if (this.conn && this.meta.agentSessionId) await this.conn.cancel({ sessionId: this.meta.agentSessionId });
    for (const [id, p] of this.pending) { p.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "permission_resolved", id }); }
    this.pending.clear();
  }

  answerPermission(id: string, optionId: string | null) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    this.log("sys", { event: "permission_answer", toolCallId: p.params.toolCall?.toolCallId, optionId });
    this.emit({ type: "permission_resolved", id, optionId: optionId ?? undefined });
    return true;
  }

  async terminate() {
    this.setState("exited");
    try { await this.cancel(); } catch { /* ignore */ }
    const c = this.child;
    if (!c) return;
    this.intendedKills.add(c);
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-c.pid!, sig); } catch { c.kill(sig); } };
    kill("SIGTERM");
    await new Promise<void>((res) => { const t = setTimeout(() => { kill("SIGKILL"); res(); }, 5000); c.once("exit", () => { clearTimeout(t); res(); }); });
  }

  /** Daemon shutdown: stop the agent but keep the session resumable. */
  async shutdown() {
    const c = this.child; if (!c) return;
    this.intendedKills.add(c);
    try { process.kill(-c.pid!, "SIGTERM"); } catch { c.kill("SIGTERM"); }
    await new Promise<void>((res) => { const t = setTimeout(() => { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } res(); }, 3000); c.once("exit", () => { clearTimeout(t); res(); }); });
  }

  private checkPath(p: string) {
    if (!isAbsolute(p) || !within(this.meta.cwd, p)) throw acp.RequestError.invalidParams({ path: p }, "path outside the session folder");
  }

  private clientHandler(): acp.Client {
    return {
      requestPermission: (params) => new Promise((resolveP) => {
        const id = `p${++this.permSeq}`;
        this.pending.set(id, { params, resolve: resolveP });
        this.emit({ type: "permission", id, params });
      }),
      sessionUpdate: async () => { /* logged, broadcast and settings-tracked by the stream tap */ },
      readTextFile: async ({ path, line, limit }) => {
        this.checkPath(path);
        let text = await readFile(path, "utf8");
        if (line || limit) { const ls = text.split("\n"); const s = Math.max(0, (line ?? 1) - 1); text = ls.slice(s, limit ? s + limit : undefined).join("\n"); }
        return { content: text };
      },
      writeTextFile: async ({ path, content }) => {
        this.checkPath(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        return {};
      },
      createTerminal: async ({ command, args, env, cwd, outputByteLimit }) => {
        // ACP requires an absolute cwd; be lenient and resolve relative ones against the session folder.
        const wd = cwd ? resolve(this.meta.cwd, cwd) : this.meta.cwd;
        if (!within(this.meta.cwd, wd)) throw acp.RequestError.invalidParams({ cwd: wd }, "cwd outside the session folder");
        const terminalId = `t${++this.termSeq}`;
        const t = startTerminal(command, args ?? [], wd, Object.fromEntries((env ?? []).map((e) => [e.name, e.value])), outputByteLimit ?? 1_000_000,
          (err) => this.log("sys", { event: "terminal_error", terminalId, command, args, cwd: wd, error: err }));
        this.terms.set(terminalId, t);
        return { terminalId };
      },
      terminalOutput: async ({ terminalId }) => {
        const t = this.term(terminalId);
        return { output: t.text(), truncated: t.truncated, exitStatus: t.exit ?? null };
      },
      waitForTerminalExit: async ({ terminalId }) => { const t = this.term(terminalId); await t.done; return { exitCode: t.exit!.exitCode, signal: t.exit!.signal }; },
      killTerminal: async ({ terminalId }) => { this.term(terminalId).kill(); return {}; },
      releaseTerminal: async ({ terminalId }) => { const t = this.terms.get(terminalId); t?.kill(); this.terms.delete(terminalId); return {}; },
    };
  }

  private term(id: string) { const t = this.terms.get(id); if (!t) throw acp.RequestError.invalidParams({ terminalId: id }, "unknown terminal"); return t; }
}

const prefKey = (o: UiOption) => (o.via === "config" ? (o.category === "model" || o.category === "mode" ? `@${o.category}` : o.id) : o.id === MODE_ID ? "@mode" : o.id === MODEL_ID ? "@model" : o.id);
const REPLAY_KINDS = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
