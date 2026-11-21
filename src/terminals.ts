import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { searchPath } from "./agents.js";
import { type PtyHelper } from "./pty.js";
import { userShell } from "./session.js";

/**
 * Terminals that live on this computer, not in the browser tab: each one is a login shell on a pseudo-terminal
 * (see pty.ts) owned by the Hearth daemon. Closing the page, losing the network or switching devices only detaches
 * a viewer; the shell and whatever runs in it keep going, and reattaching replays the recent output. A terminal ends
 * when its shell exits, when someone closes it (hang up, then SIGKILL anything left after a grace period), when it
 * sits unused for the idle limit, or when Hearth itself stops or restarts.
 */

export type TermState = "running" | "exited";
export interface TermInfo {
  id: string; title: string; cwd: string; command: string;
  createdAt: string; lastActivity: string; state: TermState;
  exitCode: number | null; signal: string | null; exitedAt: string | null;
  cols: number; rows: number; viewers: number;
  /** What is in the foreground right now (e.g. "devin", "vim"), when known; null when it's just the shell. */
  running?: string | null;
}
/** A viewer: a WebSocket in production, anything with send() in tests. Text frames are JSON events, binary frames are output. */
export interface TermClient { send(data: string | Buffer): void }

export class TermError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

export interface TerminalsOptions {
  helper: () => PtyHelper;
  /** Running terminals per owner (HEARTH_TERMINALS_MAX, default 10). */
  max?: number;
  /** A running terminal nobody is viewing and nothing has used for this long is closed. 0 = never (default 3 days). */
  idleMs?: number;
  /** How long an ended terminal stays in the list so its last output can be read (default 1 hour). */
  keepExitedMs?: number;
  /** Output kept for replay on reattach, per terminal (default 512 KB). */
  scrollbackBytes?: number;
  /** Time between hang-up and SIGKILL when closing (default 3 s). */
  graceMs?: number;
  /** Program run in each terminal; default the user's login shell with -l. */
  shell?: () => { command: string; args: string[] };
  sweepMs?: number;
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 15: "SIGTERM" };
const iso = (t: number) => new Date(t).toISOString();

export class Term {
  readonly id = randomBytes(8).toString("hex");
  title: string; readonly cwd: string; readonly command: string;
  readonly createdAt = Date.now(); lastActivity = Date.now();
  state: TermState = "running"; exitCode: number | null = null; signal: string | null = null; exitedAt: number | null = null;
  cols: number; rows: number; pid = 0; running: string | null = null;
  private chunks: Buffer[] = []; private bytes = 0; private trimmed = false;
  private clients = new Set<TermClient>();
  private proc: ChildProcess; private killTimer?: NodeJS.Timeout;
  readonly done: Promise<void>; private finish!: () => void;
  private ctlBuf = "";

  constructor(readonly owner: string, helper: string, o: { cwd: string; title: string; cols: number; rows: number; command: string; args: string[]; env: NodeJS.ProcessEnv; scrollbackBytes: number; graceMs: number; onExit: (t: Term) => void }) {
    this.title = o.title; this.cwd = o.cwd; this.cols = o.cols; this.rows = o.rows; this.command = [o.command, ...o.args].join(" ");
    this.scrollbackBytes = o.scrollbackBytes; this.graceMs = o.graceMs;
    this.done = new Promise((r) => { this.finish = r; });
    const env = { ...o.env, HEARTH_TERMINAL: this.id };
    this.proc = spawn(helper, [String(o.cols), String(o.rows), o.cwd, o.command, ...o.args], { stdio: ["pipe", "pipe", "ignore", "pipe"], env });
    this.proc.stdout!.on("data", (b: Buffer) => this.output(b));
    this.proc.stdin!.on("error", () => {});
    const ctl = this.proc.stdio[3] as import("node:net").Socket;
    ctl.on("error", () => {});
    ctl.on("data", (b: Buffer) => {
      this.ctlBuf += b.toString("latin1");
      let i;
      while ((i = this.ctlBuf.indexOf("\n")) >= 0) {
        const line = this.ctlBuf.slice(0, i); this.ctlBuf = this.ctlBuf.slice(i + 1);
        const [k, a, b2] = line.split(" ");
        if (k === "P") this.pid = Number(a) || 0;
        else if (k === "E") { const code = Number(a), sig = Number(b2); this.exitCode = code >= 0 ? code : null; this.signal = sig > 0 ? SIGNALS[sig] ?? `signal ${sig}` : null; }
        else if (k === "F") this.output(Buffer.from(`\r\nhearth: ${line.slice(2)}\r\n`));
      }
    });
    this.proc.on("error", (e) => { this.output(Buffer.from(`\r\nhearth: can't start the terminal: ${e.message}\r\n`)); });
    this.proc.on("close", (code, sig) => {
      clearTimeout(this.killTimer);
      if (this.exitCode === null && this.signal === null) { if (sig) this.signal = sig; else if (code !== 0) this.exitCode = code; }
      this.state = "exited"; this.exitedAt = Date.now(); this.running = null;
      this.broadcast(JSON.stringify({ type: "exit", terminal: this.info() }));
      o.onExit(this); this.finish();
    });
  }
  private readonly scrollbackBytes: number; private readonly graceMs: number;

  info(): TermInfo {
    return { id: this.id, title: this.title, cwd: this.cwd, command: this.command, createdAt: iso(this.createdAt), lastActivity: iso(this.lastActivity),
      state: this.state, exitCode: this.exitCode, signal: this.signal, exitedAt: this.exitedAt ? iso(this.exitedAt) : null,
      cols: this.cols, rows: this.rows, viewers: this.clients.size, running: this.running };
  }
  get viewers() { return this.clients.size; }

  private output(b: Buffer) {
    this.lastActivity = Date.now();
    this.chunks.push(b); this.bytes += b.length;
    while (this.bytes > this.scrollbackBytes && this.chunks.length > 1) { this.bytes -= this.chunks.shift()!.length; this.trimmed = true; }
    if (this.bytes > this.scrollbackBytes) { // one huge chunk: keep its tail
      const c = this.chunks[0]; this.chunks[0] = c.subarray(c.length - this.scrollbackBytes); this.bytes = this.chunks[0].length; this.trimmed = true;
    }
    for (const c of this.clients) { try { c.send(b); } catch { /* the socket's own close handler detaches it */ } }
  }
  /** The recent output, starting at a line boundary once older output has been dropped (so replay doesn't start mid-sequence). */
  scrollback(): Buffer {
    let b = Buffer.concat(this.chunks);
    if (this.trimmed) { const nl = b.indexOf(10); if (nl >= 0 && nl < b.length - 1) b = b.subarray(nl + 1); }
    return b;
  }
  /** Plain text of the last `maxChars` of output: escape sequences removed, carriage-return overwrites applied per line. */
  text(maxChars = 4000): string {
    const raw = this.scrollback().toString("utf8")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (titles, links)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
      .replace(/\x1b[@-Z\\-_()#%*+][0-9A-Za-z]?/g, "") // other ESC sequences
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const lines = raw.split("\n").map((l) => { const parts = l.split("\r").filter((p, i, a) => p !== "" || i === a.length - 1); return parts.length ? parts.reduce((acc, p) => p + acc.slice(p.length)) : ""; });
    const s = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    return s.length > maxChars ? s.slice(s.length - maxChars) : s;
  }

  /** Start sending this client the terminal: a hello event, the scrollback as one binary frame, then live output. Returns detach. */
  attach(c: TermClient): () => void {
    c.send(JSON.stringify({ type: "hello", terminal: { ...this.info(), viewers: this.clients.size + 1 } }));
    const sb = this.scrollback(); if (sb.length) c.send(sb);
    if (this.state === "exited") { c.send(JSON.stringify({ type: "exit", terminal: this.info() })); return () => {}; }
    this.clients.add(c);
    return () => { this.clients.delete(c); };
  }
  broadcast(msg: string) { for (const c of this.clients) { try { c.send(msg); } catch { /* detached on close */ } } }

  input(data: string | Buffer) {
    if (this.state !== "running" || !data.length) return;
    this.lastActivity = Date.now();
    this.proc.stdin!.write(data);
  }
  resize(cols: number, rows: number) {
    if (this.state !== "running" || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 999 || rows > 999) return;
    this.cols = cols; this.rows = rows;
    (this.proc.stdio[3] as import("node:net").Socket).write(`R ${cols} ${rows}\n`);
  }
  /**
   * Close: hang up like closing a terminal window (the shell and the foreground job get SIGHUP); the helper SIGKILLs
   * anything still in the terminal's session after the grace period. Resolves when all of it has ended.
   */
  close(): Promise<void> {
    if (!this.killTimer && this.state === "running") {
      try { (this.proc.stdio[3] as import("node:net").Socket).write(`H ${this.graceMs}\n`); } catch { /* gone */ }
      this.killTimer = setTimeout(() => this.forceKill(), this.graceMs + 3000); // the helper itself is stuck
      this.killTimer.unref();
    }
    return this.done;
  }
  /** Last resort when the helper doesn't finish: SIGKILL the shell's process group and the helper. */
  forceKill() {
    if (this.state !== "running") return;
    if (this.pid > 0) { try { process.kill(-this.pid, "SIGKILL"); } catch { /* group gone */ } }
    try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
  }
}

export class Terminals {
  private terms = new Map<string, Term>();
  private helperState?: PtyHelper;
  private sweepTimer?: NodeJS.Timeout;
  private fgAt = 0; private fgRun?: Promise<void>;
  readonly max: number; readonly idleMs: number; readonly keepExitedMs: number;
  constructor(private o: TerminalsOptions) {
    this.max = o.max ?? 10; this.idleMs = o.idleMs ?? 3 * 86400_000; this.keepExitedMs = o.keepExitedMs ?? 3600_000;
    this.sweepTimer = setInterval(() => this.sweep(), o.sweepMs ?? 60_000); this.sweepTimer.unref();
  }
  /** Builds the pty helper on first use (cached), so a page load never waits on a compiler. */
  helper(): PtyHelper { return this.helperState?.path ? this.helperState : (this.helperState = this.o.helper()); }
  status(): { available: true } | { available: false; note: string } {
    const h = this.helper(); return h.path === null ? { available: false, note: h.note } : { available: true };
  }

  list(owner: string): TermInfo[] {
    return [...this.terms.values()].filter((t) => t.owner === owner).sort((a, b) => b.createdAt - a.createdAt).map((t) => t.info());
  }
  /** list() with what each running terminal has in the foreground (one `ps`, at most every 2 s). */
  async listDetailed(owner: string): Promise<TermInfo[]> { await this.refreshForeground(); return this.list(owner); }
  get(owner: string, id: unknown): Term | undefined {
    const t = typeof id === "string" ? this.terms.get(id) : undefined;
    return t && t.owner === owner ? t : undefined;
  }
  need(owner: string, id: unknown): Term { const t = this.get(owner, id); if (!t) throw new TermError("No such terminal.", 404); return t; }

  create(owner: string, o: { cwd: string; title?: string; cols?: number; rows?: number }): Term {
    const h = this.helper();
    if (h.path === null) throw new TermError(`Terminals aren't available: ${h.note}.`, 503);
    if (!statSync(o.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new TermError("That folder doesn't exist.");
    const running = [...this.terms.values()].filter((t) => t.owner === owner && t.state === "running").length;
    if (running >= this.max) throw new TermError(`${running} terminals are already open (the limit is ${this.max}). Close one first.`, 409);
    const sh = this.o.shell?.() ?? { command: userShell(), args: ["-l"] };
    const env: NodeJS.ProcessEnv = {};
    // Hearth's own settings (the MCP token, the password hash…) stay out of the shell's environment.
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HEARTH_")) env[k] = v;
    Object.assign(env, { PATH: searchPath(), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "en_US.UTF-8" });
    const n = [...this.terms.values()].filter((t) => t.owner === owner).length + 1;
    const clamp = (v: unknown, d: number) => { const x = Math.floor(Number(v)); return x >= 2 && x <= 999 ? x : d; };
    const t = new Term(owner, h.path, { cwd: o.cwd, title: (o.title ?? "").trim().slice(0, 120) || `Terminal ${n}`, cols: clamp(o.cols, 80), rows: clamp(o.rows, 24),
      command: sh.command, args: sh.args, env, scrollbackBytes: this.o.scrollbackBytes ?? 512 * 1024, graceMs: this.o.graceMs ?? 3000, onExit: () => this.trimExited(owner) });
    this.terms.set(t.id, t);
    return t;
  }
  rename(owner: string, id: unknown, title: unknown): TermInfo {
    const t = this.need(owner, id); const s = typeof title === "string" ? title.trim().slice(0, 120) : "";
    if (!s) throw new TermError("title is required.");
    t.title = s; t.broadcast(JSON.stringify({ type: "info", terminal: t.info() }));
    return t.info();
  }
  /** Close a running terminal (waits for it to end, SIGKILL after the grace period). With remove, or if it had already ended, it leaves the list too. */
  async close(owner: string, id: unknown, o: { remove?: boolean } = {}): Promise<TermInfo> {
    const t = this.need(owner, id);
    const wasExited = t.state === "exited";
    await t.close();
    if (o.remove || wasExited) this.terms.delete(t.id);
    return t.info();
  }
  /** Ended terminals beyond the newest 10 per owner leave the list. */
  private trimExited(owner: string) {
    const ended = [...this.terms.values()].filter((t) => t.owner === owner && t.state === "exited").sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0));
    for (const t of ended.slice(10)) this.terms.delete(t.id);
  }
  sweep(now = Date.now()) {
    for (const t of [...this.terms.values()]) {
      if (t.state === "exited" && now - (t.exitedAt ?? now) > this.keepExitedMs) this.terms.delete(t.id);
      else if (t.state === "running" && this.idleMs > 0 && t.viewers === 0 && now - t.lastActivity > this.idleMs) {
        t.close().then(() => this.terms.delete(t.id)).catch(() => {});
      }
    }
  }
  private refreshForeground(): Promise<void> {
    const live = [...this.terms.values()].filter((t) => t.state === "running" && t.pid > 0);
    if (!live.length || process.platform === "win32") return Promise.resolve();
    if (Date.now() - this.fgAt < 2000) return this.fgRun ?? Promise.resolve();
    this.fgAt = Date.now();
    return this.fgRun = new Promise<void>((res) => {
      execFile("ps", ["-A", "-o", "pid=,pgid=,tpgid=,comm="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (!err) {
          const rows = String(out).split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4)
            .map(([pid, pgid, tpgid, ...comm]) => ({ pid: +pid, pgid: +pgid, tpgid: +tpgid, comm: comm.join(" ") }));
          for (const t of live) {
            const shell = rows.find((r) => r.pid === t.pid);
            const fg = shell && shell.tpgid > 0 && shell.tpgid !== shell.pgid ? rows.find((r) => r.pid === shell.tpgid) ?? rows.find((r) => r.pgid === shell.tpgid) : undefined;
            t.running = fg ? fg.comm.split("/").pop()!.replace(/^-/, "") : null;
          }
        }
        res();
      });
    });
  }
  async shutdown() {
    clearInterval(this.sweepTimer);
    await Promise.all([...this.terms.values()].map((t) => t.close().catch(() => {})));
    this.terms.clear();
  }
}
