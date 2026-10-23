import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Agents Hearth started that may still be running. Each agent runs in its own process group (spawned detached, and
 * the macOS LaunchAgent abandons process groups), so if Hearth itself dies without its SIGTERM cleanup (SIGKILL, a
 * crash, a power cut of the service) its agents are left behind and can keep holding the agent's own session locks.
 * Hearth records each agent's group here while it runs and, at startup, stops groups an earlier Hearth left behind.
 */
export interface AgentPid { pid: number; command: string; started: string }

export class AgentPids {
  private list: AgentPid[] = [];
  constructor(readonly file: string) { this.list = this.read(); }
  private read(): AgentPid[] {
    try { const j = JSON.parse(readFileSync(this.file, "utf8")); return Array.isArray(j) ? j.filter((x) => Number.isInteger(x?.pid) && x.pid > 1 && typeof x.command === "string") : []; } catch { return []; }
  }
  private save() {
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(this.list), { mode: 0o600 }); renameSync(tmp, this.file); } catch { /* best effort */ }
  }
  add(pid: number | undefined, command: string) {
    if (!pid || process.platform === "win32") return;
    this.list = this.list.filter((x) => x.pid !== pid).concat({ pid, command, started: new Date().toISOString() }); this.save();
  }
  remove(pid: number | undefined) {
    if (!pid) return;
    const n = this.list.length; this.list = this.list.filter((x) => x.pid !== pid); if (this.list.length !== n) this.save();
  }
  get entries(): readonly AgentPid[] { return this.list; }

  /**
   * Stop agent process groups left by an earlier Hearth: only a group whose leader is still alive, still leads its
   * own group, and still runs the recorded command (so a reused pid is never touched). SIGTERM, then SIGKILL after
   * `graceMs`. Returns the pids it stopped.
   */
  async reap(graceMs = 3000, ps: (pid: number) => { pgid: number; command: string } | null = psInfo): Promise<number[]> {
    const stale = this.list; this.list = []; this.save();
    if (process.platform === "win32") return [];
    const hit: number[] = [];
    for (const x of stale) {
      const p = ps(x.pid);
      if (!p || p.pgid !== x.pid || !p.command.includes(basename(x.command))) continue;
      try { process.kill(-x.pid, "SIGTERM"); hit.push(x.pid); } catch { /* gone */ }
    }
    if (!hit.length) return hit;
    for (const end = Date.now() + graceMs; Date.now() < end && hit.some(alive);) await new Promise((r) => setTimeout(r, 100));
    for (const pid of hit) if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    return hit;
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** The process group and command line of `pid`, or null if it isn't running. */
export function psInfo(pid: number): { pgid: number; command: string } | null {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const m = /^(\d+)\s+(.*)$/s.exec(out); return m ? { pgid: Number(m[1]), command: m[2] } : null;
  } catch { return null; }
}
