#!/usr/bin/env node
import { hashPassword } from "./auth.js";
import { deepProbe, loadAgents, probe } from "./agents.js";
import { configFromEnv, Hearth } from "./server.js";

const cmd = process.argv[2] ?? "serve";
if (cmd === "hash-password") {
  const pw = process.argv[3];
  if (!pw) { console.error("usage: hearth hash-password <password>"); process.exit(2); }
  console.log(hashPassword(pw));
} else if (cmd === "probe") {
  const cfg = configFromEnv();
  const agents = loadAgents(cfg.agentsFile);
  for (const p of probe(agents)) {
    let extra = "";
    if (p.installed && process.argv.includes("--deep")) { const d = await deepProbe(agents.find((a) => a.id === p.id)!); extra = JSON.stringify(d); }
    console.log(`${p.installed ? "✓" : " "} ${p.id.padEnd(11)} ${p.name.padEnd(16)} ${p.path ?? ""} ${extra}`);
  }
} else if (cmd === "serve") {
  const cfg = configFromEnv();
  if (cfg.bind !== "127.0.0.1" && cfg.bind !== "::1") console.warn(`WARNING: binding to ${cfg.bind}; Hearth expects to sit behind a local reverse proxy.`);
  const h = new Hearth(cfg);
  const port = await h.listen();
  console.log(`hearth listening on http://${cfg.bind}:${port} (identity=${cfg.identity}, password=${cfg.password.split(":")[0]})`);
  const stop = async () => { await h.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} else { console.error("usage: hearth [serve|probe [--deep]|hash-password <pw>]"); process.exit(2); }
