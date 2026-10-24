// Picker entries derived from one agent: its ready profiles (e.g. Goose on the Mac's own model through fm serve) and
// the backends the agent itself reports as set up (Goose's providers, over its ACP extension). Each becomes its own
// agent in the picker ("Goose · Cloudflare Workers AI") that starts the same program with that backend's settings;
// choosing a model within a backend stays the agent's own ACP Model option. No secrets are read: Goose only says
// whether a provider's key is set.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "./acp.js";
import { answers, type AgentDef, findAgent, healthUrlFor, localUrl, matchProfile, profileProblem, resolveLaunch, searchPath, winShell } from "./agents.js";

/** A picker id segment: lower case letters, digits, "_" and "-" (Hearth's agent ids are [a-z0-9_.-]). */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";

/** The picker entry for one of the agent's profiles (settings read and checked at each launch, see resolveLaunch). */
export function profileEntry(a: AgentDef, name: string): AgentDef {
  return { id: `${a.id}.${slug(name)}`, name: `${a.name} · ${name}`, detect: a.detect, command: a.command, args: a.args,
    ...(a.env ? { env: a.env } : {}), ...(a.status ? { status: a.status } : {}), profiles: a.profiles, parent: a.id, profile: name };
}

/** A backend Goose reports as set up: its provider id and label, the model to start with, a context limit if known. */
export interface Backend { id: string; name: string; model: string; contextLimit?: number }
/** The only settings a backend entry carries (never a key: Goose reads those itself). */
export const BACKEND_KEYS = ["GOOSE_PROVIDER", "GOOSE_MODEL", "GOOSE_CONTEXT_LIMIT"] as const;

export function backendEntry(a: AgentDef, b: Pick<Backend, "id" | "name">, env: Record<string, string>): AgentDef {
  const own = Object.fromEntries(Object.entries(env).filter(([k]) => (BACKEND_KEYS as readonly string[]).includes(k)));
  return { id: `${a.id}.${slug(b.id)}`, name: `${a.name} · ${b.name}`, detect: a.detect, command: a.command, args: a.args,
    env: { ...a.env, ...own }, ...(a.status ? { status: a.status } : {}), parent: a.id, variant: b.name };
}

/** Goose's provider inventory entry (`_goose/unstable/providers/list`), the fields Hearth uses. */
export interface GooseProvider {
  providerId: string; providerName?: string; providerType?: string; defaultModel?: string;
  acp?: boolean; visibleInSetup?: boolean; deprecated?: boolean;
  configKeys?: { name: string; secret?: boolean; primary?: boolean }[];
  models?: { id: string; contextLimit?: number | null }[];
}

/**
 * Which of Goose's providers count as set up. Goose's own `configured` flag is true for nearly every provider (local
 * ones need nothing), so: a custom provider (one the user defined, e.g. in ~/.config/goose/custom_providers) unless its
 * key is missing, and any other provider only once its key is set. Never: deprecated or hidden providers, ACP-backed
 * ones (Hearth runs those agents directly), or ones with no model to start with.
 */
export async function setUp(entries: GooseProvider[], keySet: (providerId: string, key: string) => Promise<boolean>): Promise<Backend[]> {
  const out: Backend[] = [];
  for (const e of entries) {
    if (!e?.providerId || e.deprecated || e.acp || e.visibleInSetup === false) continue;
    const model = e.defaultModel || e.models?.[0]?.id;
    if (!model) continue;
    const key = e.configKeys?.find((k) => k.primary && k.secret);
    const ok = e.providerType === "Custom" ? !key || await keySet(e.providerId, key.name) : !!key && await keySet(e.providerId, key.name);
    if (!ok) continue;
    const limits = (e.models ?? []).map((m) => m.contextLimit).filter((n): n is number => typeof n === "number" && n > 0);
    out.push({ id: e.providerId, name: e.providerName || e.providerId, model, ...(limits.length ? { contextLimit: Math.min(...limits) } : {}) });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Start Goose briefly and ask it (ACP extension methods) which providers are set up, plus the values of some
 * non-secret config keys. null when it can't say (not installed, an older Goose without these methods, a timeout).
 */
export async function askGoose(a: AgentDef, configKeys: string[], timeoutMs = 10000): Promise<{ backends: Backend[]; config: Record<string, string> } | null> {
  const l = await resolveLaunch({ ...a, profile: undefined, variant: undefined });
  const child = spawn(l.command, l.args, { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", env: { ...process.env, PATH: searchPath(), ...l.env }, ...winShell() });
  try {
    const conn = acp.probeClient(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    const fail = new Promise<never>((_, rej) => { setTimeout(() => rej(new Error("timeout")), timeoutMs).unref(); child.once("error", rej); child.once("exit", () => rej(new Error("agent exited"))); });
    fail.catch(() => {});
    const call = <T>(method: string, params: unknown) => Promise.race([conn.request<T>(method, params), fail]);
    await Promise.race([conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }), fail]);
    const list = await call<{ entries?: GooseProvider[] }>("_goose/unstable/providers/list", { providerIds: [] });
    const config: Record<string, string> = {};
    for (const key of configKeys) {
      try {
        const r = await call<{ value?: unknown }>("_goose/unstable/config/read", { key });
        if (r?.value !== null && r?.value !== undefined && typeof r.value !== "object") config[key] = String(r.value);
      } catch { /* not set */ }
    }
    // Only "is it set": Goose masks secret values, and Hearth never keeps or shows them anyway.
    const keySet = async (providerId: string, key: string) => {
      try { const r = await call<{ fields?: { key: string; isSet?: boolean }[] }>("_goose/unstable/providers/config/read", { providerId }); return !!r?.fields?.find((f) => f.key === key)?.isSet; }
      catch { return false; }
    };
    return { backends: await setUp(Array.isArray(list?.entries) ? list.entries : [], keySet), config };
  } catch { return null; }
  finally {
    if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } else child.kill("SIGKILL");
  }
}

/**
 * Where a custom Goose provider points (its `base_url`), read from Goose's custom_providers folder (only that field;
 * an `auth` command is never run or read by Hearth). undefined when its file isn't found there.
 */
export function customBaseUrl(id: string, home = homedir()): string | undefined {
  const dirs = [...new Set([process.env.XDG_CONFIG_HOME, join(home, ".config")].filter(Boolean).map((d) => join(d!, "goose", "custom_providers")))];
  for (const d of dirs) {
    let files: string[]; try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try { const j = JSON.parse(readFileSync(join(d, f), "utf8")); if (j?.name === id && typeof j.base_url === "string") return j.base_url; } catch { /* not ours */ }
    }
  }
  return undefined;
}
/** An OpenAI-style base URL's model list ("http://127.0.0.1:1977/v1" → ".../v1/models"). */
export const modelsUrl = (base: string) => base.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/models";
const origin = (u: string | undefined) => { try { return u ? new URL(u).origin : undefined; } catch { return undefined; } };

export interface Variants {
  /** Ready derived entries, profiles first. */
  entries: AgentDef[];
  /** One of them is what the plain agent would start (its default provider / settings): the plain entry can be hidden. */
  coversDefault: boolean;
  at: number;
}

/** The agent's derived picker entries right now (profiles whose health URL answers; set-up providers). */
export async function discoverVariants(a: AgentDef, opts: { home?: string; ask?: typeof askGoose } = {}): Promise<Variants> {
  const home = opts.home ?? homedir(), ask = opts.ask ?? askGoose;
  const found = findAgent(a);
  if (!found) return { entries: [], coversDefault: false, at: Date.now() };
  const profs: { def: AgentDef; env: Record<string, string> }[] = [];
  for (const p of a.profiles ?? []) {
    const m = matchProfile(a, found, home, p.name);
    if (!m || await profileProblem(p, { ...m.env, ...a.env })) continue;
    profs.push({ def: profileEntry(a, p.name), env: { ...m.env, ...a.env } });
  }
  let backends: Backend[] = [], config: Record<string, string> = {};
  if (a.discover === "goose-providers") {
    const keys = new Set<string>(["GOOSE_PROVIDER", "GOOSE_CONTEXT_LIMIT", ...profs.flatMap((x) => Object.keys(x.env))]);
    const r = await ask(a, [...keys]).catch(() => null);
    if (r) ({ backends, config } = r);
  }
  // A custom provider on this machine (e.g. Goose's own definition of the fm serve proxy) is listed only while it
  // answers; a profile for the same local server gives way to it (one entry, Goose's own).
  const local = new Set<string>();
  const ready: Backend[] = [];
  for (const b of backends) {
    const base = customBaseUrl(b.id, home);
    if (base && localUrl(base)) { local.add(origin(base)!); if (!(await answers(modelsUrl(base)))) continue; }
    ready.push(b);
  }
  backends = ready;
  for (let i = profs.length - 1; i >= 0; i--) {
    const p = a.profiles?.find((x) => x.name === profs[i].def.profile);
    if (p && local.has(origin(healthUrlFor(p, profs[i].env)) ?? "")) profs.splice(i, 1);
  }
  const dflt = a.env?.GOOSE_PROVIDER ?? config.GOOSE_PROVIDER;
  const entries = profs.map((x) => x.def);
  const ids = new Set(entries.map((e) => e.id));
  for (const b of backends) {
    const env: Record<string, string> = { GOOSE_PROVIDER: b.id, GOOSE_MODEL: b.model };
    // Goose's config can pin one context limit for every provider (fm-serve-goose sets 4096 for the on-device model):
    // another provider would inherit it, so it gets the smallest limit its own models advertise instead.
    if (config.GOOSE_CONTEXT_LIMIT && b.id !== dflt && b.contextLimit) env.GOOSE_CONTEXT_LIMIT = String(b.contextLimit);
    const e = backendEntry(a, b, env);
    if (!ids.has(e.id)) { ids.add(e.id); entries.push(e); }
  }
  const coversDefault = !!dflt && (backends.some((b) => b.id === dflt) || profs.some((x) => Object.entries(x.env).every(([k, v]) => config[k] === v)));
  return { entries, coversDefault, at: Date.now() };
}

/** What is saved about a derived entry (so its sessions still start after a restart): no secrets, see BACKEND_KEYS. */
export interface SavedVariant { id: string; parent: string; name: string; profile?: string; variant?: string; env?: Record<string, string> }
export function saveVariant(e: AgentDef): SavedVariant {
  return e.profile !== undefined ? { id: e.id, parent: e.parent!, name: e.name, profile: e.profile }
    : { id: e.id, parent: e.parent!, name: e.name, variant: e.variant, env: Object.fromEntries(Object.entries(e.env ?? {}).filter(([k]) => (BACKEND_KEYS as readonly string[]).includes(k))) };
}
export function restoreVariant(parent: AgentDef, s: SavedVariant): AgentDef | null {
  if (!s || typeof s.id !== "string" || s.parent !== parent.id || !/^[a-z0-9_.-]+$/.test(s.id)) return null;
  const e = typeof s.profile === "string" ? profileEntry(parent, s.profile)
    : s.env?.GOOSE_PROVIDER ? backendEntry(parent, { id: s.env.GOOSE_PROVIDER, name: String(s.variant ?? s.env.GOOSE_PROVIDER) }, s.env) : null;
  return e && e.id === s.id ? e : null;
}
