import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createRequire } from "node:module";
const HEARTH_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
import { type AgentDef, searchPath } from "./agents.js";
import type { SessionMeta, Store, TranscriptEntry } from "./store.js";
import { absorb, applyUpdate, MODE_ID, MODEL_ID, normalize, setLocal, valid, type RawSettings, type UiOption } from "./settings.js";

export type LiveEvent =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "state"; state: SessionMeta["state"]; title: string }
  | { type: "permission"; id: string; params: acp.RequestPermissionRequest }
  | { type: "permission_resolved"; id: string; optionId?: string }
  | { type: "prompt_done"; stopReason: string }
  | { type: "error"; message: string }
  | { type: "settings"; options: UiOption[] };

interface Pending { params: acp.RequestPermissionRequest; resolve: (r: acp.RequestPermissionResponse) => void }
export interface Term { buf: Buffer; truncated: boolean; exit?: { exitCode: number | null; signal: string | null }; done: Promise<void>; text(): string; kill(): void }

/** The user's login shell (launchd gives daemons a minimal environment). */
export function userShell(): string {
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
      proc = shell ? spawn(userShell(), ["-lc", line], { cwd, env: fullEnv, stdio: ["ignore", "pipe", "pipe"], detached: true })
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

/** True if `p` (resolved) is inside `root`. Follows symlinks for existing paths. */
export function within(root: string, p: string): boolean {
  const real = (x: string) => { try { return realpathSync(x); } catch { return resolve(x); } };
  const r = real(root);
  let target = resolve(p);
  try { target = realpathSync(target); } catch { try { target = resolve(realpathSync(dirname(target)), target.split("/").pop()!); } catch { /* new path */ } }
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

  constructor(public meta: SessionMeta, private agent: AgentDef, private store: Store) {}

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
  ensureRunning(): Promise<void> {
    if (this.alive && this.conn && this.meta.agentSessionId) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start() {
    const child = spawn(this.agent.command, this.agent.args, {
      cwd: this.meta.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { ...process.env, PATH: searchPath(), ...this.agent.env },
    });
    this.child = child;
    let tail = "";
    child.stderr!.on("data", (d: Buffer) => { this.stderrLog(d); tail = (tail + d.toString()).slice(-2000); });
    const exited = new Promise<never>((_, rej) => {
      child.once("error", (e) => rej(e));
      child.once("exit", (code, sig) => rej(new Error(`agent exited (${code ?? sig})`)));
    });
    exited.catch(() => {});
    child.once("exit", (code, signal) => {
      this.log("sys", { event: "agent_exit", code, signal, stderrTail: tail.split("\n").slice(-8).join("\n") || undefined });
      for (const [id, p] of this.pending) { p.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "permission_resolved", id }); }
      this.pending.clear();
      for (const t of this.terms.values()) t.kill();
      this.terms.clear();
      this.child = undefined; this.conn = undefined; this.prompting = false;
      if (this.meta.state !== "exited") this.setState("stopped");
    });

    const raw = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const self = this;
    const readable = raw.readable.pipeThrough(new TransformStream({
      transform(msg, ctl) {
        // Track settings from the raw message: the SDK's parsed notification can drop unrecognised option shapes.
        const mm = msg as { method?: string; params?: { update?: Record<string, unknown> } };
        if (mm.method === "session/update" && mm.params?.update) { const next = applyUpdate(self.meta.settings ?? {}, mm.params.update); if (next) self.updateSettings(next); }
        if (!(self.loading && (msg as { method?: string }).method === "session/update")) self.log("in", msg); ctl.enqueue(msg); },
    }));
    const w = raw.writable.getWriter();
    const writable = new WritableStream({ async write(msg) { self.log("out", msg); await w.write(msg); }, close: () => w.close() });
    this.conn = new acp.ClientSideConnection(() => this.clientHandler(), { readable, writable } as acp.Stream);

    const init = await Promise.race([this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "hearth", version: HEARTH_VERSION },
    }), exited]);
    this.caps = init;
    const prior = this.meta.agentSessionId;
    const caps = init.agentCapabilities ?? {};
    const canResume = !!caps.sessionCapabilities?.resume;
    const seeding = this.meta.seeded === false; // imported: replay the agent's history into our transcript once
    let done = false;
    if (prior && caps.loadSession) {
      this.loading = !seeding;
      try {
        if (seeding) this.log("sys", { event: "import_replay_start", agentSessionId: prior });
        const lr = await Promise.race([this.conn.loadSession({ sessionId: prior, cwd: this.meta.cwd, mcpServers: [] }), exited]);
        this.updateSettings(absorb(this.meta.settings ?? {}, lr as never));
        this.log("sys", { event: seeding ? "session_imported" : "session_loaded", agentSessionId: prior, via: "load" });
        done = true;
      } catch (e) {
        this.log("sys", { event: "session_load_failed", error: String((e as Error)?.message ?? e) });
      } finally { this.loading = false; }
    }
    if (!done && prior && canResume) {
      try {
        const rr = await Promise.race([this.conn.resumeSession({ sessionId: prior, cwd: this.meta.cwd, mcpServers: [] }), exited]);
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
      await this.newAgentSession(exited);
    }
    if (seeding) { this.meta.seeded = true; if (this.meta.importedFrom) this.meta.importedFrom.via = this.meta.agentSessionId === prior ? (caps.loadSession ? "load" : "resume") : "pending"; this.store.save(this.meta); }
    this.setState("idle");
    if (this.newlyCreated) { this.newlyCreated = false; await this.applyPrefs(); }
  }

  private async newAgentSession(exited: Promise<never>) {
    const r = await Promise.race([this.conn!.newSession({ cwd: this.meta.cwd, mcpServers: [] }), exited]);
    this.meta.agentSessionId = r.sessionId;
    this.updateSettings(absorb({}, r as never));
    this.newlyCreated = true;
  }
  private newlyCreated = false;

  async prompt(content: acp.ContentBlock[]) {
    await this.ensureRunning();
    if (this.prompting) throw new Error("agent is busy; cancel first");
    this.prompting = true; this.setState("running");
    try {
      const r = await this.conn!.prompt({ sessionId: this.meta.agentSessionId!, prompt: content });
      if (this.meta.title === "New session") {
        const t = content.find((c) => c.type === "text") as { text?: string } | undefined;
        if (t?.text) { this.meta.title = t.text.slice(0, 60); }
      }
      return r;
    } finally { this.prompting = false; if (this.alive) this.setState("idle"); }
  }

  async cancel() {
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
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-c.pid!, sig); } catch { c.kill(sig); } };
    kill("SIGTERM");
    await new Promise<void>((res) => { const t = setTimeout(() => { kill("SIGKILL"); res(); }, 5000); c.once("exit", () => { clearTimeout(t); res(); }); });
  }

  /** Daemon shutdown: stop the agent but keep the session resumable. */
  async shutdown() {
    const c = this.child; if (!c) return;
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
