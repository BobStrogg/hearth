import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { within } from "../dist/session.js";
import { Auth, hashPassword } from "../dist/auth.js";
import { BUILTIN_AGENTS, CLAUDE_ACP } from "../dist/agents.js";
import { Store } from "../dist/store.js";

test("within() blocks traversal and symlink escapes", () => {
  const r = mkdtempSync(join(tmpdir(), "w-")); mkdirSync(join(r, "a"));
  symlinkSync("/etc", join(r, "a", "link"));
  assert.ok(within(r, join(r, "a/x.txt")));
  assert.ok(within(r, join(r, "new/dir/file")));
  assert.ok(!within(r, join(r, "../x")));
  assert.ok(!within(r, join(r, "a/link/passwd")));
  assert.ok(!within(r + "-other", r));
});

test("builtin agents include tested Claude (pinned) and Grok", () => {
  const c = BUILTIN_AGENTS.find((a) => a.id === "claude");
  assert.match(CLAUDE_ACP, /@\d+\.\d+\.\d+$/); assert.deepEqual(c.args, ["-y", CLAUDE_ACP]);
  assert.deepEqual(BUILTIN_AGENTS.find((a) => a.id === "grok").args, ["agent", "stdio"]);
});

test("store isolates users and rejects bad ids", () => {
  const s = new Store(mkdtempSync(join(tmpdir(), "st-")));
  const m = s.create("a@x", "mock", "/tmp", "t");
  assert.equal(s.get("b@x", m.id), null);
  assert.equal(s.list("b@x").length, 0);
  assert.throws(() => s.dir("a@x", "../../etc"));
});

test("scrypt password and cloudflare JWT verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "au-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const srv = createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const team = `http://127.0.0.1:${srv.address().port}`;
  const a = new Auth({ identity: "cloudflare", cfTeamDomain: team, cfAud: "aud1", password: hashPassword("pw"), unlockTtlHours: 1, allowedOrigins: [], dataDir, allowedUsers: [] });
  const tok = (aud, email = "Alice@Example.com") => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(team).setAudience(aud).setExpirationTime("5m").sign(privateKey);
  assert.equal(await a.identify({ headers: { "cf-access-jwt-assertion": await tok("aud1") } }), "alice@example.com");
  assert.equal(await a.identify({ headers: { "cf-access-jwt-assertion": await tok("other") } }), null);
  assert.equal(await a.identify({ headers: { "cf-access-authenticated-user-email": "alice@example.com" } }), null);
  assert.equal(await a.checkPassword("x", "pw"), true);
  assert.equal(await a.checkPassword("x", "no"), false);
  srv.close();
});

test("OS password check sends the password on stdin, never argv", async () => {
  const { osPasswordOk } = await import("../dist/auth.js");
  process.env.HEARTH_DSCL = new URL("./fake-dscl.sh", import.meta.url).pathname;
  assert.equal(await osPasswordOk("alice", 'pa ss"w\\rd', "darwin"), true);
  assert.equal(await osPasswordOk("alice", "hunter2", "darwin"), false);
  assert.equal(await osPasswordOk("alice", "x\nauthonly alice y", "darwin"), false);
  assert.equal(await osPasswordOk("alice", "", "darwin"), false);
  delete process.env.HEARTH_DSCL;
});

test("file fallback lists Claude and Codex sessions read-only", async () => {
  const { fileFallback } = await import("../dist/importer.js");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  mkdirSync(join(home, ".claude/projects/-p"), { recursive: true });
  writeFileSync(join(home, ".claude/projects/-p/abc.jsonl"), JSON.stringify({ type: "user", cwd: "/p", message: { role: "user", content: "hello claude" } }) + "\n");
  mkdirSync(join(home, ".codex/sessions/2026/10/18"), { recursive: true });
  writeFileSync(join(home, ".codex/sessions/2026/10/18/rollout-x.jsonl"), [
    { type: "session_meta", payload: { id: "cx1", cwd: "/q" } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "<environment_context>..." }] } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "hello codex" }] } }].map((o) => JSON.stringify(o)).join("\n"));
  const c = fileFallback("claude", home)[0];
  assert.deepEqual([c.sessionId, c.cwd, c.title], ["abc", "/p", "hello claude"]);
  const x = fileFallback("codex", home)[0];
  assert.deepEqual([x.sessionId, x.cwd, x.title], ["cx1", "/q", "hello codex"]);
  assert.equal(fileFallback("grok", home), null);
});

test("settings normalize: configOptions win, group/groupId, unknown types skipped, legacy fallback", async () => {
  const { normalize, applyUpdate } = await import("../dist/settings.js");
  const o = normalize({ configOptions: [
    { configId: "m", name: "Model", category: "model", type: "select", currentValue: "b", options: [{ group: "g1", name: "G1", options: [{ value: "a", name: "A" }] }, { groupId: "g2", name: "G2", options: [{ value: "b", name: "B" }] }] },
    { configId: "x", name: "X", type: "_future", currentValue: 1 },
  ], modes: { currentModeId: "c", availableModes: [{ id: "c", name: "C" }] } });
  assert.equal(o.length, 1); assert.deepEqual(o[0].choices.map((c) => c.group), ["G1", "G2"]);
  const l = normalize({ modes: { currentModeId: "c", availableModes: [{ id: "c", name: "C" }] }, models: { currentModelId: "z", availableModels: [{ modelId: "z", name: "Z" }] } });
  assert.deepEqual(l.map((x) => [x.category, x.via]), [["mode", "mode"], ["model", "model"]]);
  assert.equal(applyUpdate({}, { sessionUpdate: "agent_message_chunk" }), null);
  assert.equal(normalize({}).length, 0);
});

test("dedupeFanout repairs 2x/3x fan-out turns only", async () => {
  const { dedupeFanout } = await import("../dist/store.js");
  let seq = 0;
  const pr = () => ({ seq: ++seq, dir: "out", msg: { method: "session/prompt", params: {} } });
  const ch = (t) => ({ seq: ++seq, dir: "in", msg: { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } } });
  const words = ["Implemented ", "the ", "first ", "complete ", "slice"];
  const items = [pr(), ...words.flatMap((w) => [ch(w), ch(w), ch(w)]), pr(), ...["a", "b", "b", "c", "d"].map(ch)];
  const out = dedupeFanout(items);
  const txt = out.filter((e) => e.dir === "in").map((e) => e.msg.params.update.content.text).join("");
  assert.equal(txt, "Implemented the first complete sliceabbcd");
});

test("readPage: backward, turn-aligned paging over big JSONL (chunk-spanning lines, torn tail, byte cap)", async () => {
  const { Store } = await import("../dist/store.js");
  const { appendFileSync } = await import("node:fs");
  const st = new Store(mkdtempSync(join(tmpdir(), "hearth-page-")));
  const m = st.create("u", "a", "/tmp", "t");
  for (let t = 0; t < 40; t++) {
    st.append(m, "out", { method: "session/prompt", params: { prompt: [{ type: "text", text: `q${t}` }] } });
    const n = t % 5 + 1;
    for (let i = 0; i < n; i++) st.append(m, "in", { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (t === 7 ? "x".repeat(150000) : "") + `a${t}.${i} ` } } } });
  }
  appendFileSync(join(st.dir("u", m.id), "transcript.jsonl"), '{"seq":99999,"ts":"x","dir":"in","msg":{"tor'); // torn line being written
  const all = st.read(m);
  const pages = []; let before;
  for (;;) { const p = st.readPage(m, { before, turns: 6 }); pages.push(p); if (!p.hasMore) break; before = p.items[0].seq; }
  const joined = pages.reverse().flatMap((p) => p.items);
  assert.deepEqual(joined.map((e) => e.seq), all.map((e) => e.seq));
  for (const p of pages) assert.equal(p.items[0].msg.method, "session/prompt", "pages start on a turn");
  assert.equal(pages.at(-1).items.filter((e) => e.msg.method === "session/prompt").length, 6);
  const capped = st.readPage(m, { turns: 100, maxBytes: 1000 });
  assert.ok(capped.items.length >= 1 && capped.hasMore);
  assert.deepEqual(st.readPage(st.create("u", "a", "/tmp", "empty")), { items: [], hasMore: false });
});
