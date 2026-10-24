import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "./acp.js";

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
  /** Extra settings used only when a particular install of the agent is the one found (see AgentProfile). */
  profiles?: AgentProfile[];
}

/**
 * Launch settings for one particular install of an agent, e.g. a Goose set up to use a local model. It applies only
 * when the agent's binary that was found (after following symlinks) is `bin`, its `envFile` gives at least one
 * setting, and (with `healthUrl`) that URL answers right now. Otherwise the agent starts with its own config as usual.
 * Paths may start with "~/" (the home folder).
 */
export interface AgentProfile {
  /** A short label, shown by `hearth probe` and in the agent list. */
  name: string;
  bin: string;
  /** A file of `KEY: value` (YAML) or `KEY=value` lines: its top-level UPPER_CASE keys become environment variables. */
  envFile?: string;
  /** Only these keys from `envFile` (default: all of its UPPER_CASE keys). */
  keys?: string[];
  /** Checked just before each launch (any 2xx within HEALTH_TIMEOUT_MS). `${NAME}` is filled in from the settings. */
  healthUrl?: string;
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
  // Goose (`goose acp`). Also found where fm-serve-goose puts it (Goose on Apple's on-device model through `fm serve`
  // and a local tool-call proxy); for that install, its settings come from the repo's config.example.yaml, and only
  // while the proxy answers (no proxy, e.g. before macOS 27: Goose uses its own config).
  { id: "goose", name: "Goose", detect: ["goose", "~/Developer/fm-serve-goose/bin/goose"], command: "goose", args: ["acp"],
    profiles: [{ name: "fm serve", bin: "~/Developer/fm-serve-goose/bin/goose", envFile: "~/Developer/fm-serve-goose/config.example.yaml",
      keys: ["GOOSE_PROVIDER", "GOOSE_MODEL", "OPENAI_HOST", "OPENAI_BASE_PATH", "GOOSE_CONTEXT_LIMIT", "GOOSE_AUTO_COMPACT_THRESHOLD"],
      healthUrl: "${OPENAI_HOST}/v1/models" }] },
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
  const extra = process.platform === "win32"
    ? [join(process.env.APPDATA || join(h, "AppData", "Roaming"), "npm"), join(h, ".local", "bin"), join(h, ".bun", "bin"), join(h, ".cargo", "bin")]
    : [join(h, ".local/bin"), join(h, ".grok/bin"), join(h, ".npm-global/bin"), join(h, ".bun/bin"),
      join(h, ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = (process.env.PATH ?? "").split(delimiter).concat(extra);
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

/** "~/x" → the home folder's x (other paths unchanged). */
export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")) ? join(home, p.slice(2)) : p;
}

export function which(bin: string, path = searchPath()): string | null {
  bin = expandHome(bin);
  if (bin.includes("/") || (process.platform === "win32" && bin.includes("\\"))) return existsSync(bin) ? bin : null;
  // Windows: also try PATHEXT (npm installs agents as .cmd shims)
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) { const p = join(dir, bin + e); if (existsSync(p)) return p; }
  }
  return null;
}
/** spawn options that make npm-style .cmd shims start on Windows (a no-op elsewhere). */
export const winShell = (): { shell?: boolean } => (process.platform === "win32" ? { shell: true } : {});

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
  /** The AgentProfile that matches the install found (it is used at launch only if its healthUrl answers then). */
  profile?: string;
  deep?: { ok: boolean; error?: string; loadSession?: boolean; authMethods?: string[]; agentName?: string; profile?: string; note?: string };
}

/** The first detect binary found (PATH, the usual install folders, or a "~/"/absolute path). */
export function findAgent(a: AgentDef): string | undefined {
  return a.detect.map((b) => which(b)).find(Boolean) ?? undefined;
}

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** Read `KEY: value` / `KEY=value` lines (top level, UPPER_CASE keys only; quotes and trailing " # comments" removed). */
export function readEnvFile(file: string, keys?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string; try { text = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.*)$/.exec(line);
    if (!m || (keys && !keys.includes(m[1]))) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, "").trim();
    if (v !== "" && !/^[[{|>]/.test(v)) out[m[1]] = v;
  }
  return out;
}

/** The profile matching this install (bin and envFile), with its settings; reachability isn't checked here. */
export function matchProfile(a: AgentDef, found: string | undefined, home = homedir()): { profile: AgentProfile; env: Record<string, string> } | null {
  const f = found && real(found);
  if (!f) return null;
  for (const p of a.profiles ?? []) {
    if (real(expandHome(p.bin, home)) !== f) continue;
    const env = p.envFile ? readEnvFile(expandHome(p.envFile, home), p.keys) : {};
    if (Object.keys(env).length) return { profile: p, env };
  }
  return null;
}

export const HEALTH_TIMEOUT_MS = 1500;
async function answers(url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }); await r.body?.cancel(); return r.ok; } catch { return false; }
}

export interface Launch { command: string; args: string[]; env: Record<string, string>; profile?: string; note?: string }

/**
 * How to start the agent right now: its command (the binary that was found, when the command itself isn't on the
 * PATH), its args and env, plus a matching profile's settings when that install is the one found and its health URL
 * answers. Hearth's own env (`a.env`, e.g. from agents.json) still wins over a profile's.
 */
export async function resolveLaunch(a: AgentDef, home = homedir()): Promise<Launch> {
  const onPath = which(a.command);
  const found = a.profiles?.length || !onPath ? findAgent(a) : undefined;
  // The command isn't on the PATH but the same program was found elsewhere (e.g. "~/…/bin/goose"): start that one.
  const same = (p: string) => basename(p).replace(/\.(exe|cmd)$/i, "") === basename(expandHome(a.command));
  const command = !onPath && found && same(found) ? found : a.command;
  const base: Launch = { command, args: a.args, env: { ...a.env } };
  const m = matchProfile(a, found, home);
  if (!m) return base;
  const url = m.profile.healthUrl?.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => (m.env[k] ?? process.env[k] ?? "").replace(/\/+$/, ""));
  if (url && !(await answers(url))) return { ...base, note: `${m.profile.name}: ${url} didn't answer, so ${a.name} uses its own config` };
  return { command: same(found!) ? found! : command, args: a.args, env: { ...m.env, ...a.env }, profile: m.profile.name };
}

/** Cheap probe: is a detect binary on the PATH (or at one of its paths)? */
export function probe(agents: AgentDef[]): ProbeResult[] {
  return agents.map((a) => {
    const found = findAgent(a);
    const profile = matchProfile(a, found)?.profile.name;
    return { id: a.id, name: a.name, installed: !!found, path: found, status: a.status ?? "listed", ...(profile ? { profile } : {}) };
  });
}

/** Deep probe: start the agent and run `initialize`, then kill it. */
export async function deepProbe(a: AgentDef, timeoutMs = 20000): Promise<ProbeResult["deep"]> {
  const l = await resolveLaunch(a);
  // Its own process group, so the kill below also stops anything it started (an npx or shell wrapper's child).
  const child = spawn(l.command, l.args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...process.env, PATH: searchPath(), ...l.env }, ...winShell() });
  let err = "";
  child.stderr!.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const conn = acp.probeClient(stream);
    const res = await Promise.race([
      conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      new Promise<never>((_, rej) => {
        setTimeout(() => { const last = err.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300); rej(new Error(last ? `timeout; its last output: ${last}` : "timeout (no output)")); }, timeoutMs).unref?.();
        child.on("error", rej);
      }),
    ]);
    return { ok: true, loadSession: !!res.agentCapabilities?.loadSession, authMethods: (res.authMethods ?? []).map((m) => m.id), agentName: res.agentInfo?.name, profile: l.profile, note: l.note };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), profile: l.profile, note: l.note };
  } finally {
    if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } else child.kill("SIGKILL");
  }
}

export function osUser(): string {
  try { return execFileSync("id", ["-un"]).toString().trim(); } catch { return process.env.USER ?? "user"; }
}
