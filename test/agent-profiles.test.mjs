// Agent discovery beyond the PATH: "~/" detect paths, and per-install profiles (e.g. Goose set up for a local model
// through fm-serve-goose) whose settings apply only while that install's health URL answers.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_AGENTS, deepProbe, expandHome, matchProfile, probe, readEnvFile, resolveLaunch } from "../dist/agents.js";

const win = process.platform === "win32";
const MOCK = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");
const root = mkdtempSync(join(tmpdir(), "prof-"));
const home = join(root, "home"); mkdirSync(home, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
// A program name no runner has, so nothing outside this test can be found.
const NAME = "hearth-test-goose";

/** A fake agent binary: records its env to <home>/<tag>.env, then speaks ACP (the mock agent). */
function fakeAgent(path, tag) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nenv > "${join(home, tag + ".env")}"\nexec "${process.execPath}" "${MOCK}"\n`); chmodSync(path, 0o755);
  return path;
}
const envOf = (tag) => Object.fromEntries(readFileSync(join(home, tag + ".env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const CONFIG = `# Goose config for a local OpenAI-compatible server
GOOSE_PROVIDER: openai
GOOSE_MODEL: system            # the only model id
OPENAI_HOST: PLACEHOLDER   # proxy
OPENAI_BASE_PATH: v1/chat/completions
GOOSE_CONTEXT_LIMIT: 4096
GOOSE_MODE: auto
QUOTED: "a # b"
extensions:
  developer:
    enabled: true
    NESTED_KEY: ignored
`;
const repo = join(home, "Developer", "fake-fm");
function profileAgent(port) {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "config.example.yaml"), CONFIG.replace("PLACEHOLDER", `http://127.0.0.1:${port}`));
  return { id: "tg", name: "Test Goose", detect: [NAME, `~/Developer/fake-fm/bin/${NAME}`], command: NAME, args: ["acp"],
    profiles: [{ name: "fm serve", bin: `~/Developer/fake-fm/bin/${NAME}`, envFile: "~/Developer/fake-fm/config.example.yaml",
      keys: ["GOOSE_PROVIDER", "GOOSE_MODEL", "OPENAI_HOST", "OPENAI_BASE_PATH", "GOOSE_CONTEXT_LIMIT"], healthUrl: "${OPENAI_HOST}/v1/models" }] };
}
async function healthServer() {
  const s = createServer((q, r) => { if (q.url === "/v1/models") { r.setHeader("content-type", "application/json"); r.end('{"data":[{"id":"system"}]}'); } else { r.statusCode = 404; r.end(); } });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return s;
}
async function freePort() { const s = await healthServer(); const p = s.address().port; await new Promise((ok) => s.close(ok)); return p; }

test("builtin Goose: `goose acp`, also found where fm-serve-goose installs it, with that install's profile", () => {
  const g = BUILTIN_AGENTS.find((a) => a.id === "goose");
  assert.equal(g.command, "goose"); assert.deepEqual(g.args, ["acp"]);
  assert.ok(g.detect.includes("goose") && g.detect.includes("~/Developer/fm-serve-goose/bin/goose"));
  const p = g.profiles[0];
  assert.equal(p.bin, "~/Developer/fm-serve-goose/bin/goose");
  assert.match(p.envFile, /fm-serve-goose\/config\.example\.yaml$/);
  assert.ok(p.keys.includes("OPENAI_HOST") && !p.keys.includes("GOOSE_MODE"), "Hearth asks for permission itself: GOOSE_MODE stays the user's");
  assert.equal(p.healthUrl, "${OPENAI_HOST}/v1/models");
});

test("expandHome and readEnvFile (top-level UPPER_CASE keys, comments and quotes, an allow-list)", () => {
  assert.equal(expandHome("~/a/b", "/h"), join("/h", "a/b")); assert.equal(expandHome("/x/~/y", "/h"), "/x/~/y"); assert.equal(expandHome("goose", "/h"), "goose");
  const f = join(root, "c.yaml"); writeFileSync(f, CONFIG.replace("PLACEHOLDER", "http://127.0.0.1:1"));
  const all = readEnvFile(f);
  assert.deepEqual(all, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "system", OPENAI_HOST: "http://127.0.0.1:1", OPENAI_BASE_PATH: "v1/chat/completions", GOOSE_CONTEXT_LIMIT: "4096", GOOSE_MODE: "auto", QUOTED: "a # b" });
  assert.deepEqual(Object.keys(readEnvFile(f, ["GOOSE_MODEL", "NESTED_KEY"])), ["GOOSE_MODEL"]);
  assert.deepEqual(readEnvFile(join(root, "missing.yaml")), {});
  const e = join(root, "x.env"); writeFileSync(e, "export A_B=1\nC='two'\nlower=no\n"); assert.deepEqual(readEnvFile(e), { A_B: "1", C: "two" });
});

test("not installed: not listed as installed, no profile, the plain command", { skip: win }, async () => {
  const a = profileAgent(1);
  const [p] = probe([a]);
  assert.equal(p.installed, false); assert.equal(p.profile, undefined);
  const l = await resolveLaunch(a);
  assert.equal(l.command, NAME); assert.deepEqual(l.env, {}); assert.equal(l.profile, undefined);
});

test("found only at its ~/ path: launched from there; the profile's env only while its health URL answers", { skip: win }, async () => {
  const bin = fakeAgent(join(repo, "bin", NAME), "a");
  const srv = await healthServer(); const port = srv.address().port;
  try {
    const a = profileAgent(port);
    const [p] = probe([a]);
    assert.equal(p.installed, true); assert.equal(p.path, bin); assert.equal(p.profile, "fm serve");
    const up = await resolveLaunch(a);
    assert.equal(up.command, bin); assert.equal(up.profile, "fm serve"); assert.equal(up.note, undefined);
    assert.deepEqual(up.env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "system", OPENAI_HOST: `http://127.0.0.1:${port}`, OPENAI_BASE_PATH: "v1/chat/completions", GOOSE_CONTEXT_LIMIT: "4096" });
    // Hearth's own env for the agent (agents.json) still wins.
    assert.equal((await resolveLaunch({ ...a, env: { GOOSE_MODEL: "mine" } })).env.GOOSE_MODEL, "mine");
    // A real start: the agent sees the settings and answers initialize.
    const d = await deepProbe(a, 15000);
    assert.equal(d.ok, true, d.error); assert.equal(d.agentName, "mock-agent"); assert.equal(d.profile, "fm serve");
    assert.equal(envOf("a").OPENAI_HOST, `http://127.0.0.1:${port}`); assert.equal(envOf("a").GOOSE_PROVIDER, "openai");
  } finally { await new Promise((ok) => srv.close(ok)); }
  // The proxy isn't running (e.g. no fm serve before macOS 27): same binary, its own config, and a note why.
  const a = profileAgent(await freePort());
  const down = await resolveLaunch(a);
  assert.equal(down.command, bin); assert.equal(down.profile, undefined); assert.deepEqual(down.env, {});
  assert.match(down.note, /fm serve: http:\/\/127\.0\.0\.1:\d+\/v1\/models didn't answer, so Test Goose uses its own config/);
  const d = await deepProbe(a, 15000);
  assert.equal(d.ok, true, d.error); assert.equal(d.profile, undefined); assert.equal(envOf("a").GOOSE_PROVIDER, undefined);
});

test("a symlink on the PATH (~/.local/bin) to that install still gets its profile; another install never does", { skip: win }, async () => {
  const target = fakeAgent(join(repo, "bin", NAME), "b");
  const link = join(root, "pathbin", NAME); mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link);
  const other = fakeAgent(join(root, "otherbin", NAME), "c");
  const srv = await healthServer();
  const saved = process.env.PATH;
  try {
    const a = profileAgent(srv.address().port);
    process.env.PATH = `${dirname(link)}${delimiter}${saved}`;
    const l = await resolveLaunch(a);
    assert.equal(l.profile, "fm serve"); assert.equal(l.command, link); assert.equal(l.env.GOOSE_MODEL, "system");
    // A different goose comes first on the PATH (say Homebrew's): that one is used, with the user's own config.
    process.env.PATH = `${dirname(other)}${delimiter}${dirname(link)}${delimiter}${saved}`;
    const [p] = probe([a]); assert.equal(p.path, other); assert.equal(p.profile, undefined);
    const o = await resolveLaunch(a);
    assert.equal(o.command, NAME); assert.equal(o.profile, undefined); assert.deepEqual(o.env, {}); assert.equal(o.note, undefined);
    assert.equal(matchProfile(a, other), null);
  } finally { process.env.PATH = saved; await new Promise((ok) => srv.close(ok)); }
});

test("a profile whose config file is gone doesn't apply", { skip: win }, async () => {
  const a = profileAgent(1); a.profiles[0].envFile = "~/Developer/fake-fm/nope.yaml";
  fakeAgent(join(repo, "bin", NAME), "d");
  assert.equal(probe([a])[0].profile, undefined);
  const l = await resolveLaunch(a); assert.equal(l.profile, undefined); assert.equal(l.note, undefined);
});

test("an agent whose command isn't found is never started as a different detect binary", { skip: win }, async () => {
  const det = fakeAgent(join(root, "detbin", "hearth-test-cli"), "e");
  const a = { id: "x", name: "X", detect: [det], command: "hearth-test-missing-npx", args: ["-y", "pkg"] };
  assert.equal(probe([a])[0].installed, true);
  assert.equal((await resolveLaunch(a)).command, "hearth-test-missing-npx");
});

// A real Goose, when one is given (not in CI): HEARTH_TEST_GOOSE=/path/to/goose npm test
test("real Goose answers ACP initialize", { skip: !process.env.HEARTH_TEST_GOOSE }, async () => {
  const g = BUILTIN_AGENTS.find((a) => a.id === "goose");
  const d = await deepProbe({ ...g, detect: [process.env.HEARTH_TEST_GOOSE], command: process.env.HEARTH_TEST_GOOSE, env: { GOOSE_DISABLE_KEYRING: "1" } }, 30000);
  assert.equal(d.ok, true, d.error); assert.equal(d.agentName, "goose"); assert.equal(d.loadSession, true);
});
