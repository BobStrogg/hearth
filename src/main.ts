#!/usr/bin/env node
import "./threadpool.js";
import { hashPassword } from "./auth.js";
import { deepProbe, loadAgents, probe } from "./agents.js";
import { doctor, printChecks } from "./doctor.js";
import { dataDir, envFilePath, loadEnvFile, writeEnvFile, type ConfigInput } from "./platform.js";
import { configFromEnv, Hearth } from "./server.js";
import { serviceManager, tail } from "./service.js";
import { update } from "./update.js";
import { VERSION } from "./version.js";
import { nodeFloorCheck } from "./node-floor.js";
import { describe as describeVoice, Voice } from "./voice.js";

const USAGE = `hearth ${VERSION}: web UI for ACP coding agents

  hearth                         run the server (same as \`hearth serve\`)
  hearth service install [opts]  run Hearth in the background, at login (launchd / systemd --user / Task Scheduler)
        --system                 system-wide (LaunchDaemon / system unit; needs sudo), runs as you at boot
        --port N  --public-origin https://host  --identity single:|header:<h>|cloudflare
        --cf-team-domain https://<team>.cloudflareaccess.com  --cf-aud <aud>  --password off|os|scrypt:…
        --roots dir1,dir2  --auto-update on|off  --user-aliases a@x=b@y,…  --updates-url https://…   (written to the config file)
  hearth service uninstall|start|stop|restart|status|logs
  hearth doctor [--offline]      check the install, config, agents, port and service
  hearth update [--check] [--force]   update from GitHub Releases, restart the service, roll back if unhealthy
  hearth voice [status|install]  private speech to text on this computer (whisper.cpp + a 60 MB model) for the mic button
  hearth probe [--deep]          list the ACP agents found on this machine
  hearth hash-password <pw>      make a HEARTH_PASSWORD=scrypt:… value
  hearth --version

Config: ${envFilePath()}   Data: ${dataDir()}`;

function flags(argv: string[]) {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) o[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith("--")) o[k] = argv[++i]; else o[k] = true;
  }
  return o;
}
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : argv.includes("--version") || argv.includes("-v") ? "version" : argv.includes("--help") || argv.includes("-h") ? "help" : "serve";
  if (process.env.HEARTH_NO_ENV_FILE !== "1") loadEnvFile();
  const f = flags(argv.slice(1));

  if (cmd === "version") return console.log(VERSION);
  if (cmd === "help") return console.log(USAGE);
  if (cmd === "hash-password") {
    const pw = argv[1]; if (!pw) { console.error("usage: hearth hash-password <password>"); process.exit(2); }
    return console.log(hashPassword(pw));
  }
  if (cmd === "probe") {
    const cfg = configFromEnv(); const agents = loadAgents(cfg.agentsFile);
    for (const p of probe(agents)) {
      let extra = "";
      if (p.installed && argv.includes("--deep")) extra = JSON.stringify(await deepProbe(agents.find((a) => a.id === p.id)!));
      console.log(`${p.installed ? "✓" : " "} ${p.id.padEnd(11)} ${p.name.padEnd(16)} ${p.path ?? ""} ${extra}`);
    }
    return;
  }
  if (cmd === "voice") {
    const v = new Voice(dataDir()); const sub = argv[1] ?? "status";
    if (sub === "install") {
      try { await v.runInstall((m) => console.log(m)); } catch (e) { console.error(`Couldn't set up speech to text: ${(e as Error).message}`); process.exitCode = 1; }
    } else if (sub !== "status") { console.error("usage: hearth voice [status|install]"); process.exit(2); }
    for (const l of describeVoice(v)) console.log(l);
    return;
  }
  if (cmd === "doctor") { const fails = printChecks(await doctor({ online: !f.offline })); process.exitCode = fails ? 1 : 0; return; }
  if (cmd === "update") {
    const r = await update({ check: !!f.check, force: !!f.force });
    console.log(r.message); if (r.rolledBack) process.exitCode = 1; return;
  }
  if (cmd === "service") {
    const sub = argv[1] ?? "status";
    const svc = serviceManager(sub === "install" ? !!f.system : undefined);
    if (!svc) { console.error(process.platform === "linux" ? "systemd --user isn't available here. Use `sudo hearth service install --system`, or run `hearth` under your own supervisor (see README)." : "No supported service manager on this OS. Run `hearth` directly."); process.exit(1); }
    if (sub === "install") {
      const given: ConfigInput = { port: str(f.port), publicOrigin: str(f["public-origin"]), identity: str(f.identity), cfTeamDomain: str(f["cf-team-domain"]), cfAud: str(f["cf-aud"]),
        password: str(f.password), roots: str(f.roots), autoUpdate: str(f["auto-update"]), userAliases: str(f["user-aliases"]), updatesUrl: str(f["updates-url"]) };
      const e = process.env; // first-time defaults may also come from the environment (used by the install script)
      const defaults: ConfigInput = { port: e.HEARTH_PORT, publicOrigin: e.HEARTH_PUBLIC_ORIGIN, identity: e.HEARTH_IDENTITY, cfTeamDomain: e.HEARTH_CF_TEAM_DOMAIN, cfAud: e.HEARTH_CF_AUD, password: e.HEARTH_PASSWORD, roots: e.HEARTH_ROOTS, autoUpdate: e.HEARTH_AUTO_UPDATE, userAliases: e.HEARTH_USER_ALIASES, updatesUrl: e.HEARTH_UPDATES_URL };
      const file = envFilePath(); const w = writeEnvFile(file, given, defaults);
      console.log(w.created ? `Wrote ${file}` : w.changed.length ? `Updated ${w.changed.join(", ")} in ${file}` : `Using ${file}`);
      for (const n of svc.install({ system: !!f.system })) console.log(n);
      const port = Number(given.port ?? process.env.HEARTH_PORT ?? 7682);
      for (let i = 0; i < 40; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { console.log(`Hearth ${((await r.json()) as { version: string }).version} is running on http://127.0.0.1:${port}`); return; } } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.error(`Hearth didn't answer on port ${port} within 20s. See \`hearth service logs\`.`); process.exitCode = 1; return;
    }
    if (sub === "uninstall") { for (const n of svc.uninstall()) console.log(n); console.log("Config and sessions were kept."); return; }
    if (sub === "start") return svc.start();
    if (sub === "stop") return svc.stop();
    if (sub === "restart") return svc.restart();
    if (sub === "logs") return console.log(tail(svc.logFile(), Number(str(f.lines) ?? 80)));
    if (sub === "status") { const st = svc.status(); console.log(`${st.manager}: ${st.installed ? (st.running ? `running${st.pid ? ` (pid ${st.pid})` : ""}` : "installed, not running") : "not installed"}${st.file ? `\n  ${st.file}` : ""}${st.detail ? `\n  ${st.detail}` : ""}`); process.exitCode = st.running ? 0 : 3; return; }
    console.error(USAGE); process.exit(2);
  }
  if (cmd === "serve") {
    const cfg = configFromEnv();
    if (cfg.bind !== "127.0.0.1" && cfg.bind !== "::1") console.warn(`WARNING: binding to ${cfg.bind}; Hearth expects to sit behind a local reverse proxy.`);
    const nf = nodeFloorCheck(); if (nf.message) console.warn(`WARNING: ${nf.message}`);
    const h = new Hearth(cfg);
    const port = await h.listen();
    console.log(`hearth ${VERSION} listening on http://${cfg.bind}:${port} (identity=${cfg.identity}, password=${cfg.password.split(":")[0]}, auto-update=${cfg.autoUpdate ? "on" : "off"})`);
    const stop = async () => { await h.close(); process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    return;
  }
  console.error(USAGE); process.exit(2);
}
main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
