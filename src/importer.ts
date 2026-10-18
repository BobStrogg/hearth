import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AgentDef, searchPath } from "./agents.js";

export interface ExternalSession { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }
export interface ExternalList {
  agentId: string;
  /** "acp" = session/list; "files" = read-only fallback from the agent's local store; "none" = unsupported */
  source: "acp" | "files" | "none";
  canLoad: boolean; canResume: boolean;
  sessions: ExternalSession[];
  error?: string;
}

/** Start the agent briefly, ask for its sessions over ACP (session/list), fall back to its local files. */
export async function listExternal(a: AgentDef, opts: { cwd?: string; max?: number; timeoutMs?: number } = {}): Promise<ExternalList> {
  const max = opts.max ?? 200;
  const child = spawn(a.command, a.args, { cwd: opts.cwd ?? homedir(), stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PATH: searchPath(), ...a.env } });
  const out: ExternalList = { agentId: a.id, source: "none", canLoad: false, canResume: false, sessions: [] };
  try {
    const conn = new acp.ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {} }),
      acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    const fail = new Promise<never>((_, rej) => { setTimeout(() => rej(new Error("timeout")), opts.timeoutMs ?? 30000).unref(); child.once("error", rej); child.once("exit", () => rej(new Error("agent exited"))); });
    fail.catch(() => {});
    const init = await Promise.race([conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }), fail]);
    const caps = init.agentCapabilities ?? {};
    out.canLoad = !!caps.loadSession; out.canResume = !!caps.sessionCapabilities?.resume;
    if (caps.sessionCapabilities?.list) {
      try {
        let cursor: string | null | undefined;
        do {
          const r = await Promise.race([conn.listSessions({ cwd: opts.cwd ?? null, cursor: cursor ?? null }), fail]);
          out.sessions.push(...r.sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })));
          cursor = r.nextCursor;
        } while (cursor && out.sessions.length < max);
        out.source = "acp";
      } catch (e) { out.error = String((e as Error)?.message ?? e); }
    }
  } catch (e) { out.error = String((e as Error)?.message ?? e); }
  finally { child.kill("SIGKILL"); }
  if (out.source !== "acp") {
    const files = fileFallback(a.id);
    if (files) { out.sessions = files; out.source = "files"; }
  }
  out.sessions.sort((x, y) => String(y.updatedAt ?? "").localeCompare(String(x.updatedAt ?? "")));
  if (opts.cwd) out.sessions = out.sessions.filter((s) => s.cwd === opts.cwd || s.cwd.startsWith(opts.cwd + "/"));
  out.sessions = out.sessions.slice(0, max);
  return out;
}

/** Read-only fallback: list sessions from known on-disk stores (titles/cwd only, never written). */
export function fileFallback(agentId: string, home = homedir()): ExternalSession[] | null {
  const walk = (d: string, depth: number, acc: string[]) => {
    if (depth < 0 || !existsSync(d)) return acc;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth - 1, acc); else if (e.name.endsWith(".jsonl")) acc.push(p);
    }
    return acc;
  };
  const firstLines = (f: string, n = 60) => readFileSync(f, "utf8").split("\n", n).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? "").join(" ") : "";
  if (agentId === "claude") {
    const files = walk(join(home, ".claude", "projects"), 1, []);
    if (!files.length) return null;
    return files.slice(-500).map((f) => {
      const lines = firstLines(f);
      const cwd = lines.find((l) => l.cwd)?.cwd ?? "";
      const user = lines.find((l) => l.type === "user" && l.message);
      return { sessionId: f.split("/").pop()!.replace(/\.jsonl$/, ""), cwd, title: textOf(user?.message?.content).slice(0, 80) || null, updatedAt: statSync(f).mtime.toISOString() };
    });
  }
  if (agentId === "codex") {
    const files = walk(join(home, ".codex", "sessions"), 4, []);
    if (!files.length) return null;
    return files.slice(-500).map((f) => {
      const lines = firstLines(f);
      const meta = lines.find((l) => l.type === "session_meta")?.payload ?? {};
      const user = lines.find((l) => l.type === "response_item" && l.payload?.role === "user" && !/^<(environment_context|user_instructions)/.test(textOf(l.payload?.content)));
      return { sessionId: meta.id ?? f.split("/").pop()!.replace(/\.jsonl$/, ""), cwd: meta.cwd ?? "", title: textOf(user?.payload?.content).slice(0, 80) || null, updatedAt: statSync(f).mtime.toISOString() };
    });
  }
  return null;
}
