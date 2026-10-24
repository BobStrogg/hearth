// Agent discovery beyond the PATH: "~/" detect paths, and per-install profiles (e.g. Goose set up for a local model
// through fm-serve-goose): each is its own picker entry while that install's health URL answers; the plain agent always
// starts with its own config.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_AGENTS, deepProbe, expandHome, localUrl, matchProfile, probe, readEnvFile, resolveLaunch } from "../dist/agents.js";
import { discoverVariants, profileEntry } from "../dist/variants.js";

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
QUOTED2: 'http://x' # with a comment
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
  assert.equal(g.command, "goose"); assert.deepEqual(g.args, ["acp"]); assert.equal(g.discover, "goose-providers");
  assert.equal(g.profiles[0].name, "on-Mac (fm serve)");
  assert.equal(profileEntry(g, g.profiles[0].name).id, "goose.on-mac-fm-serve"); assert.equal(profileEntry(g, g.profiles[0].name).name, "Goose · on-Mac (fm serve)");
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
  assert.deepEqual(all, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "system", OPENAI_HOST: "http://127.0.0.1:1", OPENAI_BASE_PATH: "v1/chat/completions", GOOSE_CONTEXT_LIMIT: "4096", GOOSE_MODE: "auto", QUOTED: "a # b", QUOTED2: "http://x" });
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

test("found only at its ~/ path: launched from there; its profile is its own entry, only while its health URL answers", { skip: win }, async () => {
  const bin = fakeAgent(join(repo, "bin", NAME), "a");
  const srv = await healthServer(); const port = srv.address().port;
  try {
    const a = profileAgent(port);
    const [p] = probe([a]);
    assert.equal(p.installed, true); assert.equal(p.path, bin); assert.equal(p.profile, "fm serve");
    // The plain agent: that binary, its own config.
    const plain = await resolveLaunch(a);
    assert.equal(plain.command, bin); assert.equal(plain.profile, undefined); assert.deepEqual(plain.env, {});
    // The profile's entry: the repo's settings.
    const v = await discoverVariants(a, { home });
    assert.deepEqual(v.entries.map((e) => [e.id, e.name, e.parent, e.profile]), [["tg.fm-serve", "Test Goose · fm serve", "tg", "fm serve"]]);
    assert.equal(v.coversDefault, false, "not a provider-discovering agent: nothing says what its own config is");
    const fe = v.entries[0];
    const up = await resolveLaunch(fe);
    assert.equal(up.command, bin); assert.equal(up.profile, "fm serve");
    assert.deepEqual(up.env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "system", OPENAI_HOST: `http://127.0.0.1:${port}`, OPENAI_BASE_PATH: "v1/chat/completions", GOOSE_CONTEXT_LIMIT: "4096" });
    // Hearth's own env for the agent (agents.json) still wins.
    assert.equal((await resolveLaunch(profileEntry({ ...a, env: { GOOSE_MODEL: "mine" } }, "fm serve"))).env.GOOSE_MODEL, "mine");
    // A real start: the agent sees the settings and answers initialize.
    const d = await deepProbe(fe, 15000);
    assert.equal(d.ok, true, d.error); assert.equal(d.agentName, "mock-agent"); assert.equal(d.profile, "fm serve");
    assert.equal(envOf("a").OPENAI_HOST, `http://127.0.0.1:${port}`); assert.equal(envOf("a").GOOSE_PROVIDER, "openai");
    const d2 = await deepProbe(a, 15000);
    assert.equal(d2.ok, true, d2.error); assert.equal(d2.profile, undefined); assert.equal(envOf("a").GOOSE_PROVIDER, undefined);
  } finally { await new Promise((ok) => srv.close(ok)); }
  // The proxy isn't running (e.g. no fm serve before macOS 27): no entry, and starting one says why (never quietly
  // starts without the settings).
  const a = profileAgent(await freePort());
  assert.deepEqual((await discoverVariants(a, { home })).entries, []);
  const fe = profileEntry(a, "fm serve");
  await assert.rejects(resolveLaunch(fe), /Test Goose · fm serve: http:\/\/127\.0\.0\.1:\d+\/v1\/models didn't answer; start it/);
  const d = await deepProbe(fe, 15000);
  assert.equal(d.ok, false); assert.match(d.error, /didn't answer/);
  assert.deepEqual((await resolveLaunch(a)).env, {}, "the plain agent is unaffected");
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
    const l = await resolveLaunch(profileEntry(a, "fm serve"));
    assert.equal(l.profile, "fm serve"); assert.equal(l.command, link); assert.equal(l.env.GOOSE_MODEL, "system");
    assert.equal((await discoverVariants(a, { home })).entries.length, 1);
    // A different goose comes first on the PATH (say Homebrew's): that one is used, with the user's own config, and
    // the profile isn't offered (it describes the other install).
    process.env.PATH = `${dirname(other)}${delimiter}${dirname(link)}${delimiter}${saved}`;
    const [p] = probe([a]); assert.equal(p.path, other); assert.equal(p.profile, undefined);
    const o = await resolveLaunch(a);
    assert.equal(o.command, NAME); assert.equal(o.profile, undefined); assert.deepEqual(o.env, {});
    assert.equal(matchProfile(a, other), null);
    assert.deepEqual((await discoverVariants(a, { home })).entries, []);
    await assert.rejects(resolveLaunch(profileEntry(a, "fm serve")), /isn't there \(or isn't the hearth-test-goose found\)/);
  } finally { process.env.PATH = saved; await new Promise((ok) => srv.close(ok)); }
});

test("a profile whose config file is gone isn't offered", { skip: win }, async () => {
  const a = profileAgent(1); a.profiles[0].envFile = "~/Developer/fake-fm/nope.yaml";
  fakeAgent(join(repo, "bin", NAME), "d");
  assert.equal(probe([a])[0].profile, undefined);
  assert.deepEqual((await discoverVariants(a, { home })).entries, []);
  const l = await resolveLaunch(a); assert.equal(l.profile, undefined); assert.deepEqual(l.env, {});
  await assert.rejects(resolveLaunch(profileEntry(a, "fm serve")), /nope\.yaml isn't there/);
});

test("an agent whose command isn't found is never started as a different detect binary", { skip: win }, async () => {
  const det = fakeAgent(join(root, "detbin", "hearth-test-cli"), "e");
  const a = { id: "x", name: "X", detect: [det], command: "hearth-test-missing-npx", args: ["-y", "pkg"] };
  assert.equal(probe([a])[0].installed, true);
  assert.equal((await resolveLaunch(a)).command, "hearth-test-missing-npx");
});

test("health URLs: loopback only, the launch's own host, and never credentials in messages", { skip: win }, async () => {
  assert.ok(localUrl("http://127.0.0.1:1/x") && localUrl("http://localhost:1/") && localUrl("http://[::1]:1/"));
  assert.equal(localUrl("http://example.com/v1/models"), null); assert.equal(localUrl("file:///etc/passwd"), null); assert.equal(localUrl("nope"), null);
  fakeAgent(join(repo, "bin", NAME), "f");
  const srv = await healthServer(); const port = srv.address().port;
  try {
    // agents.json moves OPENAI_HOST to the live server: that host is checked (and used), not the file's dead one.
    const a = { ...profileAgent(await freePort()), env: { OPENAI_HOST: `http://127.0.0.1:${port}` } };
    const l = await resolveLaunch(profileEntry(a, "fm serve")); assert.equal(l.profile, "fm serve"); assert.equal(l.env.OPENAI_HOST, `http://127.0.0.1:${port}`);
    assert.equal((await discoverVariants(a, { home })).entries.length, 1);
    // A remote host is never contacted, and the message shows no user, password or query.
    const r = { ...a, env: { OPENAI_HOST: "http://user:secret@example.com" } };
    assert.deepEqual((await discoverVariants(r, { home })).entries, []);
    const e = await resolveLaunch(profileEntry(r, "fm serve")).then(() => null, (x) => x.message);
    assert.match(e, /http:\/\/example\.com\/v1\/models isn't a local http\(s\) URL/); assert.doesNotMatch(e, /secret|user/);
    const q = await resolveLaunch(profileEntry({ ...a, profiles: [{ ...a.profiles[0], healthUrl: "http://u:pw@127.0.0.1:1/h?token=abc" }] }, "fm serve")).then(() => null, (x) => x.message);
    assert.match(q, /didn't answer/); assert.doesNotMatch(q, /pw|token|abc/);
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test("a ~/ command is started from the home folder", { skip: win }, async () => {
  const bin = fakeAgent(join(home, "tools", "hearth-test-tilde"), "g");
  const a = { id: "t", name: "T", detect: ["~/tools/hearth-test-tilde"], command: "~/tools/hearth-test-tilde", args: [] };
  assert.equal((await resolveLaunch(a)).command, bin);
  const d = await deepProbe(a, 15000); assert.equal(d.ok, true, d.error);
});

// A real Goose, when one is given (not in CI): HEARTH_TEST_GOOSE=/path/to/goose npm test
test("real Goose answers ACP initialize", { skip: !process.env.HEARTH_TEST_GOOSE }, async () => {
  const g = BUILTIN_AGENTS.find((a) => a.id === "goose");
  const d = await deepProbe({ ...g, detect: [process.env.HEARTH_TEST_GOOSE], command: process.env.HEARTH_TEST_GOOSE, env: { GOOSE_DISABLE_KEYRING: "1" } }, 30000);
  assert.equal(d.ok, true, d.error); assert.equal(d.agentName, "goose"); assert.equal(d.loadSession, true);
});
