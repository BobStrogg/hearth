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

test("settings normalize: configOptions win, group/groupId, unknown types skipped, legacy fills missing categories", async () => {
  const { normalize, applyUpdate } = await import("../dist/settings.js");
  const o = normalize({ configOptions: [
    { configId: "m", name: "Model", category: "model", type: "select", currentValue: "b", options: [{ group: "g1", name: "G1", options: [{ value: "a", name: "A" }] }, { groupId: "g2", name: "G2", options: [{ value: "b", name: "B" }] }] },
    { configId: "x", name: "X", type: "_future", currentValue: 1 },
  ], modes: { currentModeId: "c", availableModes: [{ id: "c", name: "C" }] }, models: { currentModelId: "z", availableModels: [{ modelId: "z", name: "Z" }] } });
  // model comes from configOptions (legacy models ignored); mode only exists as legacy modes, so it fills in
  assert.deepEqual(o.map((x) => [x.id, x.via]), [["m", "config"], ["_hearth_mode", "mode"]]); assert.deepEqual(o[0].choices.map((c) => c.group), ["G1", "G2"]);
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

test("settings normalize: spec `id` (Claude Code / Grok Build / Devin payloads), wrapped values, setLocal by id", async () => {
  const { normalize, setLocal, applyUpdate } = await import("../dist/settings.js");
  // trimmed from a real claude-agent-acp 0.93.0 session/new response (it also sends legacy `modes`)
  const claude = { configOptions: [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Manual" }, { value: "plan", name: "Plan" }] },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet" }] },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
  ], modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Manual" }] } };
  const o = normalize(claude);
  assert.deepEqual(o.map((x) => [x.id, x.category, x.via]), [["mode", "mode", "config"], ["model", "model", "config"], ["effort", "thought_level", "config"]]);
  // Grok Build style: model + reasoning effort as config options, permission mode only as legacy modes
  const grok = normalize({ configOptions: [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "g-1", options: [{ value: "g-1", name: "G1" }, { value: "g-2", name: "G2" }] },
    { id: "reasoning_effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: { value: "high" }, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ], modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } });
  assert.deepEqual(grok.map((x) => [x.id, x.value]), [["model", "g-1"], ["reasoning_effort", "high"], ["_hearth_mode", "default"]]);
  const next = setLocal(claude, o[1], "sonnet");
  assert.equal(normalize(next).find((x) => x.id === "model").value, "sonnet");
  const up = applyUpdate(claude, { sessionUpdate: "current_mode_update", currentModeId: "plan" });
  assert.equal(normalize(up).find((x) => x.id === "mode").value, "plan");
  // a select with no usable choices is skipped; configOptions that yield nothing fall back to legacy entirely
  assert.deepEqual(normalize({ configOptions: [{ id: "q", name: "Q", type: "select", currentValue: "a", options: [] }], models: { currentModelId: "z", availableModels: [{ modelId: "z", name: "Z" }] } }).map((x) => x.via), ["model"]);
});

test("HEARTH_USER_ALIASES: parsing and canonical identity", async () => {
  const { parseUserAliases, canonicalUser } = await import("../dist/auth.js");
  const m = parseUserAliases(" Alt@Example.org = Main@Example.com ;gh@example.com=main@example.com\nbad, =x, y=, self@x=self@x");
  assert.deepEqual({ ...m }, { "alt@example.org": "main@example.com", "gh@example.com": "main@example.com" });
  assert.equal(canonicalUser("ALT@example.org", m), "main@example.com");
  assert.equal(canonicalUser("other@example.com", m), "other@example.com");
  assert.equal(canonicalUser("__proto__", m), "__proto__");
  assert.equal(canonicalUser("constructor", m), "constructor");
  assert.deepEqual({ ...parseUserAliases(undefined) }, {});
  // one hop only
  const c = parseUserAliases("a@x=b@x,b@x=c@x");
  assert.equal(canonicalUser("a@x", c), "b@x");
});

test("user aliases: JWT identity is canonicalised (same owner, same sessions), allow-list honoured", async () => {
  const { parseUserAliases } = await import("../dist/auth.js");
  const dataDir = mkdtempSync(join(tmpdir(), "al-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const srv = createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const team = `http://127.0.0.1:${srv.address().port}`;
  const tok = (email) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(team).setAudience("aud1").setExpirationTime("5m").sign(privateKey);
  const userAliases = parseUserAliases("alice@gmail.example=alice@example.com,Alice-GH@example.com=alice@example.com");
  const base = { identity: "cloudflare", cfTeamDomain: team, cfAud: "aud1", password: "off", unlockTtlHours: 1, allowedOrigins: [], dataDir, userAliases };
  const a = new Auth({ ...base, allowedUsers: [] });
  const h = async (e) => a.identify({ headers: { "cf-access-jwt-assertion": await tok(e) } });
  assert.equal(await h("Alice@Example.com"), "alice@example.com");
  assert.equal(await h("alice@gmail.example"), "alice@example.com");
  assert.equal(await h("alice-gh@example.com"), "alice@example.com");
  assert.equal(await h("bob@example.com"), "bob@example.com");
  // the canonical owner's sessions are visible through an alias login
  const s = new Store(mkdtempSync(join(tmpdir(), "als-")));
  const m = s.create(await h("alice@example.com"), "mock", "/tmp", "t");
  assert.ok(s.get(await h("alice-gh@example.com"), m.id));
  assert.equal(s.get(await h("bob@example.com"), m.id), null);
  // allow-list may name the canonical identity (aliases pass) ...
  const b = new Auth({ ...base, allowedUsers: ["alice@example.com"] });
  assert.equal(await b.identify({ headers: { "cf-access-jwt-assertion": await tok("alice@gmail.example") } }), "alice@example.com");
  assert.equal(await b.identify({ headers: { "cf-access-jwt-assertion": await tok("bob@example.com") } }), null);
  // ... or the alias itself
  const c = new Auth({ ...base, allowedUsers: ["alice-gh@example.com"] });
  assert.equal(await c.identify({ headers: { "cf-access-jwt-assertion": await tok("alice-gh@example.com") } }), "alice@example.com");
  srv.close();
});

test("writeEnvFile records HEARTH_USER_ALIASES on create and on update", async () => {
  const { writeEnvFile, parseEnv } = await import("../dist/platform.js");
  const { readFileSync } = await import("node:fs");
  const f = join(mkdtempSync(join(tmpdir(), "ev-")), "env");
  writeEnvFile(f, {}, { userAliases: "a@x=b@x" }, "linux", "/home/u");
  assert.equal(parseEnv(readFileSync(f, "utf8")).HEARTH_USER_ALIASES, "a@x=b@x");
  const w = writeEnvFile(f, { userAliases: "a@x=b@x,c@x=b@x" }, {}, "linux", "/home/u");
  assert.deepEqual(w.changed, ["HEARTH_USER_ALIASES"]);
  assert.equal(parseEnv(readFileSync(f, "utf8")).HEARTH_USER_ALIASES, "a@x=b@x,c@x=b@x");
  const f2 = join(mkdtempSync(join(tmpdir(), "ev-")), "env");
  writeEnvFile(f2, {}, {}, "linux", "/home/u");
  assert.equal(parseEnv(readFileSync(f2, "utf8")).HEARTH_USER_ALIASES, undefined);
});

test("PromptQueue: persistence, ordering, edit/move/delete, cap, writes only on change", async () => {
  const { PromptQueue, QUEUE_MAX } = await import("../dist/queue.js");
  const { existsSync, statSync, readFileSync } = await import("node:fs");
  const f = join(mkdtempSync(join(tmpdir(), "q-")), "queue.json");
  const views = []; const q = new PromptQueue(f, (v) => views.push(v));
  assert.equal(existsSync(f), false);
  const t = (s) => [{ type: "text", text: s }];
  const a = q.add(t("a")), b = q.add(t("b")), c = q.add([{ type: "text", text: "c" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  assert.deepEqual(q.view().items.map((i) => i.text), ["a", "b", "c"]);
  assert.equal(q.view().items[2].attachments, 1);
  const ino = () => statSync(f).ino + ":" + statSync(f).mtimeMs;
  const before = ino(); const nViews = views.length;
  q.move(a.id, 0); q.edit(b.id, " b "); q.setPaused(false); // no-ops: no write, no broadcast
  assert.equal(ino(), before); assert.equal(views.length, nViews);
  q.move(c.id, 0); q.move(a.id, 99);
  assert.deepEqual(q.items.map((i) => i.id), [c.id, b.id, a.id]);
  q.edit(c.id, "c2"); // keeps the image
  assert.deepEqual(q.items[0].content.map((x) => x.type), ["text", "image"]); assert.equal(q.items[0].content[0].text, "c2");
  assert.throws(() => q.edit(b.id, "   "), /empty/);
  q.edit(c.id, ""); assert.deepEqual(q.items[0].content.map((x) => x.type), ["image"]); // image-only is fine
  q.remove(b.id); assert.throws(() => q.remove(b.id), /gone/);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).items.map((i) => i.id), [c.id, a.id]);
  // reload (restart): same order, NOT paused (the server drains it when the agent is idle), file untouched
  const st = ino();
  const r = new PromptQueue(f);
  assert.deepEqual(r.items.map((i) => i.id), [c.id, a.id]); assert.equal(r.paused, false); assert.equal(r.reason, null);
  assert.equal(ino(), st);
  r.setPaused(false); assert.equal(ino(), st); // back to the persisted state: still no write
  assert.equal(r.shift().id, c.id);
  // cap
  while (r.items.length < QUEUE_MAX) r.add(t("x"));
  assert.throws(() => r.add(t("y")), /full/);
  r.clear(); assert.equal(existsSync(f), false); // empty: no file
  assert.equal(new PromptQueue(f).items.length, 0);
  // corrupt file: start empty
  const { writeFileSync } = await import("node:fs"); writeFileSync(f, "{nope");
  assert.equal(new PromptQueue(f).items.length, 0);
});
