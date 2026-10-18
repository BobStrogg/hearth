import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AgentDef {
  id: string;
  name: string;
  /** Binaries whose presence means the agent is installed. Any match counts. */
  detect: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** "tested" = exercised by the Hearth maintainers; "listed" = from public docs only. */
  status?: "tested" | "listed";
}

/** Pinned adapter versions (bump deliberately). */
export const CLAUDE_ACP = "@agentclientprotocol/claude-agent-acp@0.93.0";
export const CODEX_ACP = "@agentclientprotocol/codex-acp";

/** Known ACP agents. Launch commands follow each vendor's docs and the acpx registry. */
export const BUILTIN_AGENTS: AgentDef[] = [
  { id: "claude", name: "Claude Code", detect: ["claude"], command: "npx", args: ["-y", CLAUDE_ACP], status: "tested" },
  { id: "grok", name: "Grok Build", detect: ["grok"], command: "grok", args: ["agent", "stdio"], status: "tested" },
  { id: "codex", name: "Codex", detect: ["codex"], command: "npx", args: ["-y", CODEX_ACP] },
  { id: "gemini", name: "Gemini CLI", detect: ["gemini"], command: "gemini", args: ["--acp"] },
  { id: "cursor", name: "Cursor", detect: ["cursor-agent"], command: "cursor-agent", args: ["acp"] },
  { id: "devin", name: "Devin", detect: ["devin"], command: "devin", args: ["acp"] },
  { id: "copilot", name: "GitHub Copilot", detect: ["copilot"], command: "copilot", args: ["--acp", "--stdio"] },
  { id: "opencode", name: "OpenCode", detect: ["opencode"], command: "opencode", args: ["acp"] },
  { id: "qwen", name: "Qwen Code", detect: ["qwen"], command: "qwen", args: ["--acp"] },
  { id: "kimi", name: "Kimi CLI", detect: ["kimi"], command: "kimi", args: ["acp"] },
  { id: "goose", name: "Goose", detect: ["goose"], command: "goose", args: ["acp"] },
  { id: "junie", name: "Junie", detect: ["junie"], command: "junie", args: ["--acp=true"] },
  { id: "kiro", name: "Kiro CLI", detect: ["kiro-cli-chat"], command: "kiro-cli-chat", args: ["acp"] },
  { id: "droid", name: "Factory Droid", detect: ["droid"], command: "droid", args: ["exec", "--output-format", "acp"] },
  { id: "qoder", name: "Qoder CLI", detect: ["qodercli"], command: "qodercli", args: ["--acp"] },
  { id: "pi", name: "Pi", detect: ["pi"], command: "npx", args: ["-y", "pi-acp"] },
  { id: "openclaw", name: "OpenClaw", detect: ["openclaw"], command: "openclaw", args: ["acp"] },
  { id: "kilocode", name: "Kilo Code", detect: ["kilocode"], command: "npx", args: ["-y", "@kilocode/cli", "acp"] },
  { id: "fast-agent", name: "fast-agent", detect: ["fast-agent"], command: "uvx", args: ["fast-agent-mcp", "acp"] },
];

export function searchPath(): string {
  const h = homedir();
  const extra = [join(h, ".local/bin"), join(h, ".grok/bin"), join(h, ".npm-global/bin"), join(h, ".bun/bin"),
    join(h, ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = (process.env.PATH ?? "").split(delimiter).concat(extra);
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

export function which(bin: string, path = searchPath()): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of path.split(delimiter)) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadAgents(file?: string): AgentDef[] {
  const list = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]));
  if (file && existsSync(file)) {
    const extra = JSON.parse(readFileSync(file, "utf8")) as AgentDef[];
    for (const a of extra) list.set(a.id, { ...list.get(a.id), ...a } as AgentDef);
  }
  return [...list.values()];
}

export interface ProbeResult {
  id: string; name: string; installed: boolean; path?: string; status?: string;
  deep?: { ok: boolean; error?: string; loadSession?: boolean; authMethods?: string[]; agentName?: string };
}

/** Cheap probe: is a detect binary on the PATH? */
export function probe(agents: AgentDef[]): ProbeResult[] {
  return agents.map((a) => {
    const found = a.detect.map((b) => which(b)).find(Boolean) ?? undefined;
    return { id: a.id, name: a.name, installed: !!found, path: found, status: a.status ?? "listed" };
  });
}

/** Deep probe: start the agent and run `initialize`, then kill it. */
export async function deepProbe(a: AgentDef, timeoutMs = 20000): Promise<ProbeResult["deep"]> {
  const child = spawn(a.command, a.args, { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PATH: searchPath(), ...a.env } });
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const conn = new acp.ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {} }), stream);
    const res = await Promise.race([
      conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      new Promise<never>((_, rej) => { setTimeout(() => rej(new Error("timeout")), timeoutMs); child.on("error", rej); }),
    ]);
    return { ok: true, loadSession: !!res.agentCapabilities?.loadSession, authMethods: (res.authMethods ?? []).map((m) => m.id), agentName: res.agentInfo?.name };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  } finally {
    child.kill("SIGKILL");
  }
}

export function osUser(): string {
  try { return execFileSync("id", ["-un"]).toString().trim(); } catch { return process.env.USER ?? "user"; }
}
