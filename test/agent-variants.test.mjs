// Goose's providers as picker entries: Hearth asks Goose (its ACP extension methods) which providers are set up and
// lists each as "Goose · <provider>", started with GOOSE_PROVIDER/GOOSE_MODEL. Model choice inside one stays Goose's own
// ACP Model option. No key is ever read or stored: Goose only says whether it is set.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { askGoose, backendEntry, customBaseUrl, discoverVariants, modelsUrl, restoreVariant, saveVariant, setUp, slug } from "../dist/variants.js";
import { createServer } from "node:http";
import { resolveLaunch } from "../dist/agents.js";
import { Hearth, configFromEnv } from "../dist/server.js";

const win = process.platform === "win32";
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-goose.mjs");
const root = mkdtempSync(join(tmpdir(), "variants-"));

const SECRET = "sk-test-do-not-show";
const KEY = (name) => ({ name, required: false, secret: true, primary: true });
const ENTRIES = [
  { providerId: "custom_cf", providerName: "Cloudflare Workers AI", providerType: "Custom", defaultModel: "@cf/zai-org/glm-4.7-flash", configKeys: [KEY("CF_KEY")],
    models: [{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7-Flash", contextLimit: 200000 }, { id: "@cf/openai/gpt-oss-120b", contextLimit: 131072 }] },
  { providerId: "custom_nokey", providerName: "Custom without its key", providerType: "Custom", defaultModel: "m", configKeys: [KEY("NOKEY_KEY")], models: [{ id: "m" }] },
  { providerId: "custom_open", providerName: "Custom, no key needed", providerType: "Custom", defaultModel: "", configKeys: [], models: [{ id: "local-model" }] },
  { providerId: "anthropic", providerName: "Anthropic", providerType: "Preferred", defaultModel: "claude", configKeys: [KEY("ANTHROPIC_API_KEY")], models: [{ id: "claude", contextLimit: 1000000 }] },
  { providerId: "openai", providerName: "OpenAI", providerType: "Preferred", defaultModel: "gpt", configKeys: [KEY("OPENAI_API_KEY")], models: [{ id: "gpt", contextLimit: 400000 }] },
  { providerId: "lmstudio", providerName: "LM Studio", providerType: "Declarative", defaultModel: "", configKeys: [{ name: "LMSTUDIO_HOST", secret: false }], models: [{ id: "x" }] },
  { providerId: "claude-acp", providerName: "Claude Code", providerType: "Builtin", acp: true, defaultModel: "default", configKeys: [], models: [{ id: "default" }] },
  { providerId: "old", providerName: "Old", providerType: "Builtin", deprecated: true, defaultModel: "o", configKeys: [KEY("OLD_KEY")], models: [{ id: "o" }] },
  { providerId: "hidden", providerName: "Hidden", providerType: "Builtin", visibleInSetup: false, defaultModel: "h", configKeys: [KEY("H_KEY")], models: [{ id: "h" }] },
];
const SET = { custom_cf: ["CF_KEY"], openai: ["OPENAI_API_KEY"], old: ["OLD_KEY"], hidden: ["H_KEY"] };

function fakeGoose(name, fx) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "providers.json"), JSON.stringify(fx));
  const bin = join(dir, "goose"); writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`); chmodSync(bin, 0o755);
  return { dir, agent: { id: "fg", name: "Goose", detect: [bin], command: bin, args: ["acp"], discover: "goose-providers", env: { FAKE_GOOSE_DIR: dir } } };
}
const envs = (dir) => readdirSync(dir).filter((f) => f.startsWith("env-")).sort((x, y) => parseInt(x.slice(4)) - parseInt(y.slice(4))).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

test("which providers count as set up", async () => {
  const keySet = async (id, key) => (SET[id] ?? []).includes(key);
  const b = await setUp(ENTRIES, keySet);
  assert.deepEqual(b, [
    { id: "custom_cf", name: "Cloudflare Workers AI", model: "@cf/zai-org/glm-4.7-flash", contextLimit: 131072 },
    { id: "custom_open", name: "Custom, no key needed", model: "local-model" },
    { id: "openai", name: "OpenAI", model: "gpt", contextLimit: 400000 },
  ]);
  assert.deepEqual(await setUp([{ providerId: "x", providerType: "Custom", models: [] }, null], keySet), [], "no model to start with, or junk");
});

test("entries carry only provider, model and context limit; saved and restored the same", () => {
  const g = { id: "goose", name: "Goose", detect: ["goose"], command: "goose", args: ["acp"], env: { A: "1" } };
  const e = backendEntry(g, { id: "custom_CF home", name: "CF" }, { GOOSE_PROVIDER: "custom_CF home", GOOSE_MODEL: "m", CF_KEY: SECRET });
  assert.equal(e.id, "goose.custom_cf-home"); assert.equal(e.name, "Goose · CF"); assert.equal(e.parent, "goose");
  assert.deepEqual(e.env, { A: "1", GOOSE_PROVIDER: "custom_CF home", GOOSE_MODEL: "m" });
  const s = saveVariant(e);
  assert.doesNotMatch(JSON.stringify(s), /sk-test|"A"/);
  assert.deepEqual(restoreVariant(g, JSON.parse(JSON.stringify(s))), e);
  assert.equal(restoreVariant(g, { ...s, parent: "other" }), null); assert.equal(restoreVariant(g, { ...s, id: "goose.else" }), null);
  assert.equal(slug("on-Mac (fm serve)"), "on-mac-fm-serve");
});

test("Goose over ACP: set-up providers become entries; its default one hides the plain entry; a pinned context limit is replaced", { skip: win }, async () => {
  const { dir, agent } = fakeGoose("ask", { entries: ENTRIES, set: SET, config: { GOOSE_PROVIDER: "openai", GOOSE_CONTEXT_LIMIT: 4096, OPENAI_HOST: "http://x" } });
  const r = await askGoose(agent, ["GOOSE_PROVIDER", "GOOSE_CONTEXT_LIMIT", "MISSING"]);
  assert.deepEqual(r.config, { GOOSE_PROVIDER: "openai", GOOSE_CONTEXT_LIMIT: "4096" });
  assert.deepEqual(r.backends.map((b) => b.id), ["custom_cf", "custom_open", "openai"]);
  const v = await discoverVariants(agent);
  assert.equal(v.coversDefault, true);
  assert.deepEqual(v.entries.map((e) => [e.id, e.name]), [["fg.custom_cf", "Goose · Cloudflare Workers AI"], ["fg.custom_open", "Goose · Custom, no key needed"], ["fg.openai", "Goose · OpenAI"]]);
  const cf = v.entries[0].env;
  assert.deepEqual([cf.GOOSE_PROVIDER, cf.GOOSE_MODEL, cf.GOOSE_CONTEXT_LIMIT], ["custom_cf", "@cf/zai-org/glm-4.7-flash", "131072"], "4096 is for the on-device model: the smallest limit of its own models instead");
  assert.equal(v.entries[1].env.GOOSE_CONTEXT_LIMIT, undefined, "no limit advertised: Goose decides");
  assert.equal(v.entries[2].env.GOOSE_CONTEXT_LIMIT, undefined, "Goose's own default provider keeps its configured limit");
  const l = await resolveLaunch(v.entries[0]);
  assert.equal(l.profile, "Cloudflare Workers AI"); assert.equal(l.env.FAKE_GOOSE_DIR, dir);
  assert.doesNotMatch(JSON.stringify(v), /\*\*\*|sk-/);
  // Not set as default: the plain entry stays.
  const { agent: a2 } = fakeGoose("ask2", { entries: ENTRIES, set: SET, config: { GOOSE_PROVIDER: "lmstudio" } });
  assert.equal((await discoverVariants(a2)).coversDefault, false);
  // An older Goose without the extension: just the plain entry.
  const { agent: a3 } = fakeGoose("old", { entries: [], noExtension: true });
  assert.equal(await askGoose(a3, []), null);
  assert.deepEqual((await discoverVariants(a3)).entries, []);
});

test("custom providers as the home setup writes them: an auth-command one (no key field) is listed; one on this machine only while it answers, and a profile for the same server gives way", { skip: win }, async () => {
  const saved = process.env.XDG_CONFIG_HOME; delete process.env.XDG_CONFIG_HOME;
  const home = join(root, "home-setup"); const cp = join(home, ".config", "goose", "custom_providers"); mkdirSync(cp, { recursive: true });
  const srv = createServer((q, r) => { r.statusCode = q.url === "/v1/models" ? 200 : 404; r.end("{}"); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const port = srv.address().port;
  // Goose 1.56.0 reports neither of these with a primary key: an `auth` command, and `requires_auth: false`.
  const noKey = [{ name: "OPENAI_HOST", required: true, secret: false, primary: false }];
  const entries = [
    { providerId: "home_cf", providerName: "Cloudflare Workers AI (home, free tier)", providerType: "Custom", defaultModel: "@cf/zai-org/glm-4.7-flash", configKeys: noKey, models: [{ id: "@cf/zai-org/glm-4.7-flash", contextLimit: 131072 }] },
    { providerId: "home_fm", providerName: "Apple on-device model (fm serve, private)", providerType: "Custom", defaultModel: "system", configKeys: noKey, models: [{ id: "system", contextLimit: 4096 }] },
  ];
  writeFileSync(join(cp, "home_cf.json"), JSON.stringify({ name: "home_cf", engine: "openai", base_url: "https://ai.example.invalid/v1", auth: { command: "/bin/sh", args: ["-c", `touch "${join(home, "AUTH_RAN")}"`] }, models: [] }));
  writeFileSync(join(cp, "home_fm.json"), JSON.stringify({ name: "home_fm", engine: "openai", base_url: `http://127.0.0.1:${port}/v1`, requires_auth: false, models: [] }));
  writeFileSync(join(cp, "broken.json"), "{");
  assert.equal(customBaseUrl("home_fm", home), `http://127.0.0.1:${port}/v1`); assert.equal(customBaseUrl("nope", home), undefined);
  assert.equal(modelsUrl("http://h/v1/"), "http://h/v1/models"); assert.equal(modelsUrl("http://h/v1/chat/completions"), "http://h/v1/models");
  // A Goose with a profile for the same local server (fm-serve-goose's config.example.yaml).
  const { agent } = fakeGoose("setup", { entries, config: { GOOSE_PROVIDER: "home_cf" } });
  const repo = join(home, "fm"); mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "config.example.yaml"), `GOOSE_PROVIDER: openai\nOPENAI_HOST: http://127.0.0.1:${port}\n`);
  const a = { ...agent, detect: [agent.command], profiles: [{ name: "fm serve", bin: agent.command, envFile: join(repo, "config.example.yaml"), healthUrl: "${OPENAI_HOST}/v1/models" }] };
  try {
    const up = await discoverVariants(a, { home });
    assert.deepEqual(up.entries.map((e) => e.id), ["fg.home_fm", "fg.home_cf"], "the profile gives way to Goose's own definition of the same server");
    assert.equal(up.coversDefault, true);
    await new Promise((ok) => srv.close(ok));
    const down = await discoverVariants(a, { home });
    assert.deepEqual(down.entries.map((e) => e.id), ["fg.home_cf"], "fm serve's proxy stopped: not offered");
    assert.equal(readdirSync(home).includes("AUTH_RAN"), false, "Hearth never runs a provider's auth command");
  } finally { srv.close(); if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved; }
});

let h, base, dataDir, fg;
async function start() {
  const cfg = configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(dataDir, "agents.json"), HEARTH_IDENTITY: "header:x-user" });
  h = new Hearth(cfg); const port = await h.listen(); base = `http://127.0.0.1:${port}`; h.cfg.allowedOrigins.splice(0, Infinity, base);
}
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "x-user": "user@example.com", origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
before(async () => {
  if (win) return;
  fg = fakeGoose("server", { entries: ENTRIES, set: SET, config: { GOOSE_PROVIDER: "custom_cf", GOOSE_CONTEXT_LIMIT: 4096 } });
  dataDir = mkdtempSync(join(tmpdir(), "variants-data-"));
  writeFileSync(join(dataDir, "agents.json"), JSON.stringify([fg.agent]));
  await start();
});
after(async () => { await h?.close(); });

test("/api/agents lists each provider as an agent; a session starts Goose with that provider; it survives a restart", { skip: win }, async () => {
  const list = (await api("GET", "/api/agents")).json;
  const plain = list.find((a) => a.id === "fg");
  assert.equal(plain.installed, true); assert.equal(plain.hidden, true, "its default (custom_cf) has its own entry");
  const mine = list.filter((a) => a.parent === "fg");
  assert.deepEqual(mine.map((a) => [a.id, a.name, a.installed]), [["fg.custom_cf", "Goose · Cloudflare Workers AI", true], ["fg.custom_open", "Goose · Custom, no key needed", true], ["fg.openai", "Goose · OpenAI", true]]);
  assert.doesNotMatch(JSON.stringify(list), /\*\*\*|sk-|FAKE_GOOSE_DIR|GOOSE_PROVIDER/, "no settings or secrets in the API");
  const before = envs(fg.dir).length;
  const s = (await api("POST", "/api/sessions", { agentId: "fg.openai", cwd: root })).json;
  assert.ok(s.id);
  for (let i = 0; i < 100 && envs(fg.dir).length === before; i++) await new Promise((r) => setTimeout(r, 50));
  const env = envs(fg.dir).at(-1);
  assert.equal(env.GOOSE_PROVIDER, "openai"); assert.equal(env.GOOSE_MODEL, "gpt"); assert.equal(env.GOOSE_CONTEXT_LIMIT, "400000");
  // The model is Goose's own ACP option, shown as the session's Model pill.
  let opts = []; for (let i = 0; i < 100 && !opts.length; i++) { opts = h.live.get(s.id)?.options ?? []; if (!opts.length) await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(opts.find((o) => o.category === "model" && o.value === "gpt"), JSON.stringify(opts));
  const saved = readFileSync(join(dataDir, "agent-variants.json"), "utf8");
  assert.doesNotMatch(saved, /\*\*\*|sk-|FAKE_GOOSE_DIR/);
  // Restart, and the provider is no longer set up: the entry is listed as not installed, and its session still starts.
  await h.close();
  writeFileSync(join(fg.dir, "providers.json"), JSON.stringify({ entries: ENTRIES, set: { custom_cf: ["CF_KEY"] }, config: { GOOSE_PROVIDER: "custom_cf" } }));
  await start();
  const l2 = (await api("GET", "/api/agents")).json;
  assert.equal(l2.find((a) => a.id === "fg.openai").installed, false);
  assert.equal(h.agentById("fg.openai").env.GOOSE_PROVIDER, "openai");
  const n = envs(fg.dir).length;
  const r = await api("POST", "/api/sessions", { agentId: "fg.openai", cwd: root });
  assert.equal(r.status, 201);
  for (let i = 0; i < 100 && envs(fg.dir).length === n; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(envs(fg.dir).at(-1).GOOSE_PROVIDER, "openai");
});
