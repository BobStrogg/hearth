import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { loadAgents, probe, which } from "./agents.js";
import { installInfo } from "./install-info.js";
import { nodeFloorCheck } from "./node-floor.js";
import { dataDir, envFilePath, parseEnv } from "./platform.js";
import { configFromEnv } from "./server.js";
import { serviceManager } from "./service.js";
import { cmpVer, latestRelease, plan } from "./update.js";
import { VERSION } from "./version.js";
import { Voice } from "./voice.js";

type Level = "ok" | "warn" | "fail" | "info";
export interface Check { level: Level; title: string; fix?: string }

const portFree = (port: number, host: string) => new Promise<boolean>((res) => {
  const s = createServer(); s.once("error", () => res(false)); s.listen(port, host, () => s.close(() => res(true)));
});

/** Diagnose the install, config, agents, service and (optionally, with network) updates and Cloudflare Access. */
export async function doctor(opts: { online?: boolean } = {}): Promise<Check[]> {
  const out: Check[] = []; const add = (level: Level, title: string, fix?: string) => out.push({ level, title, fix });
  const nf = nodeFloorCheck();
  add(nf.level, `Node.js ${process.versions.node}${nf.level === "ok" ? "" : nf.level === "fail" ? " (unsupported)" : " (needs a security update)"}`, nf.message && `${nf.message} Get it from https://nodejs.org or \`brew upgrade node\`.`);
  const info = installInfo();
  add("info", `Hearth ${VERSION} (${info.method}${info.prefix ? ` in ${info.prefix}` : info.exe ? `: ${info.exe}` : ""}) on ${process.platform}-${process.arch}`);

  const envFile = envFilePath(); const dir = dataDir();
  if (!existsSync(envFile)) add("warn", `No config file at ${envFile} (defaults are used)`, "Run `hearth service install` to create it, or create it by hand (see README).");
  else {
    const mode = statSync(envFile).mode & 0o777;
    add(process.platform !== "win32" && mode & 0o077 ? "warn" : "ok", `Config ${envFile}`, process.platform !== "win32" && mode & 0o077 ? `chmod 600 ${envFile}` : undefined);
    const keys = Object.keys(parseEnv(readFileSync(envFile, "utf8")));
    const unknown = keys.filter((k) => !k.startsWith("HEARTH_")); if (unknown.length) add("warn", `Unrecognised keys in config: ${unknown.join(", ")}`);
  }
  let cfg; try { cfg = configFromEnv(); } catch (e) { add("fail", `Config error: ${(e as Error).message}`); return out; }
  add("ok", `Data in ${dir}`);
  if (existsSync(dir) && process.platform !== "win32" && statSync(dir).mode & 0o077) add("warn", `${dir} is readable by other users`, `chmod 700 ${dir}`);

  // identity / password
  const id = cfg.identity;
  if (id === "cloudflare") {
    if (!cfg.cfTeamDomain || !cfg.cfAud) add("fail", "identity=cloudflare but HEARTH_CF_TEAM_DOMAIN / HEARTH_CF_AUD are missing", "Set both in the config (see docs/cloudflare.md).");
    else {
      add("ok", `Cloudflare Access identity (${cfg.cfTeamDomain})`);
      if (!cfg.allowedOrigins.some((o) => o.startsWith("https://"))) add("warn", "No https:// origin in HEARTH_ALLOWED_ORIGINS", "Add your public hostname, e.g. HEARTH_ALLOWED_ORIGINS=https://agents.example.com,http://127.0.0.1:7682");
      if (opts.online) {
        try { const r = await fetch(new URL("/cdn-cgi/access/certs", cfg.cfTeamDomain), { signal: AbortSignal.timeout(8000) }); add(r.ok ? "ok" : "fail", `Access signing keys ${r.ok ? "reachable" : `HTTP ${r.status}`}`, r.ok ? undefined : "Check HEARTH_CF_TEAM_DOMAIN (https://<team>.cloudflareaccess.com)."); }
        catch (e) { add("warn", `Couldn't reach ${cfg.cfTeamDomain}: ${(e as Error).message}`); }
      }
    }
  } else if (id.startsWith("header:")) add("warn", `identity=${id}: any local process can set that header`, "Prefer `cloudflare` identity on shared machines.");
  else add("ok", `identity=${id} (single user${id.length > 7 ? ` ${id.slice(7)}` : ""})`);
  const aliases = Object.keys(cfg.userAliases ?? {}).length;
  if (aliases) add("ok", `User aliases: ${aliases} identit${aliases === 1 ? "y maps" : "ies map"} to a canonical user`);
  const pw = cfg.password.split(":")[0];
  if (pw === "os") {
    if (process.platform === "darwin") add(existsSync("/usr/bin/dscl") ? "ok" : "fail", "Password unlock: macOS account password (dscl)");
    else if (process.platform === "linux") add(which("pamtester") || process.env.HEARTH_PAMTESTER ? "ok" : "fail", "Password unlock: OS account password (pamtester)", which("pamtester") ? undefined : "Install pamtester (e.g. `sudo apt install pamtester`), or use HEARTH_PASSWORD=scrypt:… from `hearth hash-password`.");
    else add("fail", "HEARTH_PASSWORD=os isn't supported on this OS", "Use `hearth hash-password <pw>` and HEARTH_PASSWORD=scrypt:…");
  } else if (pw === "off") add(id === "cloudflare" ? "warn" : "info", "No password unlock (HEARTH_PASSWORD=off)", id === "cloudflare" ? "Consider HEARTH_PASSWORD=os for a second factor tied to this machine." : undefined);
  else add("ok", "Password unlock: scrypt hash");
  for (const r of cfg.roots) if (!existsSync(r)) add("fail", `Root folder missing: ${r}`, "Fix HEARTH_ROOTS.");

  // agents
  const found = probe(loadAgents(cfg.agentsFile)).filter((p) => p.installed);
  add(found.length ? "ok" : "warn", found.length ? `Agents: ${found.map((p) => p.name).join(", ")}` : "No ACP agents found on PATH",
    found.length ? undefined : "Install one (for example Claude Code, Grok Build, Codex, Gemini CLI) and sign in to it once in a terminal.");

  // port + service
  let listening = false;
  try { const r = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { listening = true; const j = await r.json() as { version?: string }; add(j.version === VERSION ? "ok" : "warn", `Hearth is answering on http://127.0.0.1:${cfg.port} (version ${j.version ?? "?"})`, j.version !== VERSION ? "A different version is running: `hearth service restart`." : undefined); } } catch { /* not running */ }
  if (!listening) {
    const free = await portFree(cfg.port, "127.0.0.1");
    add(free ? "warn" : "fail", free ? `Nothing is listening on port ${cfg.port}` : `Port ${cfg.port} is used by something that isn't Hearth`, free ? "Start it: `hearth service start` (or `hearth` in a terminal)." : "Pick another HEARTH_PORT or stop the other program.");
  }
  const svc = serviceManager();
  if (!svc) add("warn", "No supported service manager found", process.platform === "linux" ? "systemd --user isn't available here: run `hearth` under your own supervisor, or `sudo hearth service install --system`." : "Run `hearth` in a terminal or under your own supervisor.");
  else {
    const st = svc.status();
    if (!st.installed) add("warn", `Not installed as a ${st.manager} service`, "`hearth service install` starts it at login and restarts it if it stops.");
    else add(st.running ? "ok" : "fail", `${st.manager} service ${st.running ? `running${st.pid ? ` (pid ${st.pid})` : ""}` : "installed but not running"}`, st.running ? st.detail : "`hearth service start`, then `hearth service logs`.");
    if (st.detail) add("warn", st.detail);
    // macOS: through the stable launcher, folder permissions survive Node.js and Hearth updates (see launcher.ts).
    if (process.platform === "darwin" && st.installed && st.file && /LaunchAgents/.test(st.file)) {
      let pl = ""; try { pl = readFileSync(st.file, "utf8"); } catch { /* unreadable */ }
      if (/hearth-launch<\/string>/.test(pl)) add("ok", "Runs through hearth-launch: macOS folder permissions last across Node.js and Hearth updates");
      else add("warn", "Runs Hearth directly: macOS may ask for folder permission (Documents, Desktop…) again after each Node.js or Hearth update, and agents wait until someone clicks Allow", "`hearth service install` (needs the Xcode Command Line Tools: `xcode-select --install`)");
    }
  }

  // voice (optional)
  if (cfg.voice) {
    const vc = new Voice(cfg.dataDir).caps();
    add("info", `Voice on this computer: speech to text ${vc.stt.available ? `ready (whisper.cpp, ${vc.stt.model})` : "not set up"}; text to speech ${vc.tts.engine ?? "none"}`,
      vc.stt.available ? undefined : "Optional, for the mic button in browsers without built-in speech recognition (e.g. the Tesla browser) or to keep dictation private: `hearth voice install`.");
  } else add("info", "Voice on this computer: off (HEARTH_VOICE=off)");

  // updates
  const auto = (process.env.HEARTH_AUTO_UPDATE ?? "off").toLowerCase();
  add("info", `Auto-update: ${auto === "on" ? "on (daily check; restarts when idle)" : "off"} · update method: ${plan(info).how}`);
  if (opts.online) {
    try { const rel = await latestRelease(8000); const n = cmpVer(rel.version, VERSION) > 0; add(n ? "warn" : "ok", n ? `Update available: ${rel.version}` : `Up to date (latest release ${rel.tag})`, n ? (plan(info).canApply ? "`hearth update`" : plan(info).how) : undefined); }
    catch (e) { add("info", `Couldn't check for updates: ${(e as Error).message}`); }
  }
  return out;
}

export function printChecks(cs: Check[]) {
  const icon = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  for (const c of cs) { console.log(`${icon[c.level]} ${c.title}`); if (c.fix) console.log(`    → ${c.fix}`); }
  const f = cs.filter((c) => c.level === "fail").length, w = cs.filter((c) => c.level === "warn").length;
  console.log(f ? `\n${f} problem(s), ${w} warning(s).` : w ? `\nNo problems, ${w} warning(s).` : "\nAll good.");
  return f;
}
