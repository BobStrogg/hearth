import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AgentDef, searchPath } from "./agents.js";
import type { SessionMeta, Store, TranscriptEntry } from "./store.js";

export type LiveEvent =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "state"; state: SessionMeta["state"]; title: string }
  | { type: "permission"; id: string; params: acp.RequestPermissionRequest }
  | { type: "permission_resolved"; id: string; optionId?: string }
  | { type: "prompt_done"; stopReason: string }
  | { type: "error"; message: string };

interface Pending { params: acp.RequestPermissionRequest; resolve: (r: acp.RequestPermissionResponse) => void }
interface Term { proc: ChildProcess; out: string; limit: number; truncated: boolean; exit?: { exitCode: number | null; signal: string | null }; done: Promise<void> }

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

  log(dir: TranscriptEntry["dir"], msg: unknown) {
    const entry = this.store.append(this.meta, dir, msg);
    this.meta.lastActivity = entry.ts;
    this.store.save(this.meta);
    this.emit({ type: "entry", entry });
  }

  setState(state: SessionMeta["state"]) {
    this.meta.state = state; this.store.save(this.meta);
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
    child.stderr!.on("data", () => { /* agent logs; not part of transcript */ });
    const exited = new Promise<never>((_, rej) => {
      child.once("error", (e) => rej(e));
      child.once("exit", (code, sig) => rej(new Error(`agent exited (${code ?? sig})`)));
    });
    exited.catch(() => {});
    child.once("exit", (code, signal) => {
      this.log("sys", { event: "agent_exit", code, signal });
      for (const [id, p] of this.pending) { p.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "permission_resolved", id }); }
      this.pending.clear();
      for (const t of this.terms.values()) t.proc.kill("SIGKILL");
      this.terms.clear();
      this.child = undefined; this.conn = undefined; this.prompting = false;
      if (this.meta.state !== "exited") this.setState("stopped");
    });

    const raw = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const self = this;
    const readable = raw.readable.pipeThrough(new TransformStream({
      transform(msg, ctl) { if (!(self.loading && (msg as { method?: string }).method === "session/update")) self.log("in", msg); ctl.enqueue(msg); },
    }));
    const w = raw.writable.getWriter();
    const writable = new WritableStream({ async write(msg) { self.log("out", msg); await w.write(msg); }, close: () => w.close() });
    this.conn = new acp.ClientSideConnection(() => this.clientHandler(), { readable, writable } as acp.Stream);

    const init = await Promise.race([this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "hearth", version: "0.1.0" },
    }), exited]);
    this.caps = init;
    const prior = this.meta.agentSessionId;
    if (prior && init.agentCapabilities?.loadSession) {
      this.loading = true;
      try {
        await Promise.race([this.conn.loadSession({ sessionId: prior, cwd: this.meta.cwd, mcpServers: [] }), exited]);
        this.log("sys", { event: "session_loaded", agentSessionId: prior });
      } catch (e) {
        this.log("sys", { event: "session_load_failed", error: String(e) });
        await this.newAgentSession(exited);
      } finally { this.loading = false; }
    } else {
      if (prior) this.log("sys", { event: "context_reset", reason: "agent does not support session/load; earlier history is display-only" });
      await this.newAgentSession(exited);
    }
    this.setState("idle");
  }

  private async newAgentSession(exited: Promise<never>) {
    const r = await Promise.race([this.conn!.newSession({ cwd: this.meta.cwd, mcpServers: [] }), exited]);
    this.meta.agentSessionId = r.sessionId; this.store.save(this.meta);
  }

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
      sessionUpdate: async () => { /* already logged & broadcast by the stream tap */ },
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
        const wd = cwd ?? this.meta.cwd;
        if (!within(this.meta.cwd, wd)) throw acp.RequestError.invalidParams({ cwd: wd }, "cwd outside the session folder");
        const proc = spawn(command, args ?? [], { cwd: wd, env: { ...process.env, PATH: searchPath(), ...Object.fromEntries((env ?? []).map((e) => [e.name, e.value])) }, stdio: ["ignore", "pipe", "pipe"] });
        const t: Term = { proc, out: "", limit: outputByteLimit ?? 1_000_000, truncated: false, done: Promise.resolve() };
        const add = (b: Buffer) => { t.out += b.toString(); if (Buffer.byteLength(t.out) > t.limit) { t.out = t.out.slice(-t.limit); t.truncated = true; } };
        proc.stdout!.on("data", add); proc.stderr!.on("data", add);
        t.done = new Promise((res) => { proc.on("close", (code, signal) => { t.exit = { exitCode: code, signal }; res(); }); proc.on("error", (e) => { add(Buffer.from(String(e))); t.exit = { exitCode: 127, signal: null }; res(); }); });
        const terminalId = `t${++this.termSeq}`;
        this.terms.set(terminalId, t);
        return { terminalId };
      },
      terminalOutput: async ({ terminalId }) => {
        const t = this.term(terminalId);
        return { output: t.out, truncated: t.truncated, exitStatus: t.exit ?? null };
      },
      waitForTerminalExit: async ({ terminalId }) => { const t = this.term(terminalId); await t.done; return t.exit!; },
      killTerminal: async ({ terminalId }) => { this.term(terminalId).proc.kill("SIGKILL"); return {}; },
      releaseTerminal: async ({ terminalId }) => { const t = this.terms.get(terminalId); t?.proc.kill("SIGKILL"); this.terms.delete(terminalId); return {}; },
    };
  }

  private term(id: string) { const t = this.terms.get(id); if (!t) throw acp.RequestError.invalidParams({ terminalId: id }, "unknown terminal"); return t; }
}
