import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Hearth keeps its data (sessions, logs) and its config file.
 * - HEARTH_HOME (or HEARTH_DATA_DIR) wins.
 * - An existing ~/.hearth is kept (older installs) on every OS.
 * - macOS: ~/.hearth. Linux: $XDG_DATA_HOME/hearth (data) and $XDG_CONFIG_HOME/hearth/env (config).
 *   Windows: %APPDATA%\hearth.
 */
export function dataDir(env = process.env, platform = process.platform, home = homedir()): string {
  if (env.HEARTH_DATA_DIR) return env.HEARTH_DATA_DIR;
  if (env.HEARTH_HOME) return env.HEARTH_HOME;
  const legacy = join(home, ".hearth");
  if (existsSync(legacy)) return legacy;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "hearth");
  if (platform === "darwin") return legacy;
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "hearth");
}

export function envFilePath(env = process.env, platform = process.platform, home = homedir()): string {
  if (env.HEARTH_ENV_FILE) return env.HEARTH_ENV_FILE;
  const d = dataDir(env, platform, home);
  if (platform === "linux" && !env.HEARTH_HOME && !env.HEARTH_DATA_DIR && d !== join(home, ".hearth"))
    return join(env.XDG_CONFIG_HOME || join(home, ".config"), "hearth", "env");
  return join(d, "env");
}

/** Parse a KEY=VALUE file (the same format a POSIX shell can `set -a; .` it). Comments and blank lines ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Load the env file into process.env (values already set in the environment win). Returns the file used, if any. */
export function loadEnvFile(env = process.env): string | null {
  const f = envFilePath(env);
  if (!existsSync(f)) return null;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(f, "utf8")))) if (env[k] === undefined) env[k] = v;
  return f;
}

export interface ConfigInput { port?: string; publicOrigin?: string; identity?: string; cfTeamDomain?: string; cfAud?: string; password?: string; roots?: string; autoUpdate?: string }

/** Create the env file with defaults (if missing), then apply any explicitly given values. Mode 600. */
export function writeEnvFile(file: string, given: ConfigInput, defaults: ConfigInput = {}, platform = process.platform, home = homedir()): { created: boolean; changed: string[] } {
  const exists = existsSync(file);
  const cur = exists ? parseEnv(readFileSync(file, "utf8")) : {};
  const changed: string[] = [];
  const set = (k: string, v: string | undefined) => { if (v !== undefined && cur[k] !== v) { cur[k] = v; changed.push(k); } };
  const pick = (k: keyof ConfigInput) => given[k] ?? (exists ? undefined : defaults[k]);
  if (!exists) {
    const port = given.port ?? defaults.port ?? "7682";
    cur.HEARTH_PORT = port;
    cur.HEARTH_ALLOWED_ORIGINS = [given.publicOrigin ?? defaults.publicOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter(Boolean).join(",");
    cur.HEARTH_IDENTITY = pick("identity") ?? "single:";
    cur.HEARTH_CF_TEAM_DOMAIN = pick("cfTeamDomain") ?? "";
    cur.HEARTH_CF_AUD = pick("cfAud") ?? "";
    cur.HEARTH_PASSWORD = pick("password") ?? (platform === "darwin" ? "os" : "off");
    cur.HEARTH_ROOTS = pick("roots") ?? home;
    cur.HEARTH_AUTO_UPDATE = pick("autoUpdate") ?? "off";
  } else {
    set("HEARTH_PORT", given.port);
    if (given.publicOrigin) {
      const o = (cur.HEARTH_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!o.includes(given.publicOrigin)) set("HEARTH_ALLOWED_ORIGINS", [given.publicOrigin, ...o].join(","));
    }
    set("HEARTH_IDENTITY", given.identity); set("HEARTH_CF_TEAM_DOMAIN", given.cfTeamDomain); set("HEARTH_CF_AUD", given.cfAud);
    set("HEARTH_PASSWORD", given.password); set("HEARTH_ROOTS", given.roots); set("HEARTH_AUTO_UPDATE", given.autoUpdate);
  }
  if (exists && !changed.length) return { created: false, changed };
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const body = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(file + ".tmp", body, { mode: 0o600 }); renameSync(file + ".tmp", file);
  return { created: !exists, changed };
}

export const isWin = process.platform === "win32";
