#!/usr/bin/env node
// A stand-in for `goose acp` (newline-delimited JSON-RPC): initialize, session/new|prompt, and the Goose ACP extension
// methods Hearth uses to list providers. FAKE_GOOSE_DIR: providers.json ({ entries, config, set: { id: [keys] } }) is
// read from there, and each start writes its environment to env-<n>.json there.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const dir = process.env.FAKE_GOOSE_DIR;
const fx = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"));
writeFileSync(join(dir, `env-${readdirSync(dir).filter((f) => f.startsWith("env-")).length}.json`), JSON.stringify(process.env));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const conf = (k) => process.env[k] ?? fx.config?.[k] ?? null;
let n = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || m.method === undefined) return;
  const ok = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake-goose", version: "0" }, authMethods: [] });
    case "_goose/unstable/providers/list": return fx.noExtension ? send({ id: m.id, error: { code: -32601, message: "Method not found" } }) : ok({ entries: fx.entries });
    case "_goose/unstable/config/read": return ok({ value: conf(m.params.key) });
    case "_goose/unstable/providers/config/read": {
      const e = fx.entries.find((x) => x.providerId === m.params.providerId);
      return ok({ fields: (e?.configKeys ?? []).map((k) => { const set = (fx.set?.[e.providerId] ?? []).includes(k.name); return { key: k.name, value: set ? (k.secret ? "***" : "v") : null, isSet: set, isSecret: !!k.secret, required: !!k.required }; }) });
    }
    case "session/new": return ok({ sessionId: `fake-${++n}`, configOptions: [
      { id: "provider", name: "Provider", type: "select", currentValue: conf("GOOSE_PROVIDER") ?? "", options: fx.entries.map((e) => ({ value: e.providerId, name: e.providerName })) },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: conf("GOOSE_MODEL") ?? "", options: (fx.entries.find((e) => e.providerId === conf("GOOSE_PROVIDER"))?.models ?? []).map((x) => ({ value: x.id, name: x.name ?? x.id })) },
    ] });
    case "session/prompt": return ok({ stopReason: "end_turn" });
    default: return send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
