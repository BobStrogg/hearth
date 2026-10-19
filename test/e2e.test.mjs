import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";
import { hashPassword } from "../dist/auth.js";

const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
let h, base, origin, root, dataDir;
const PW = "s3cret";

before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-root-")); mkdirSync(join(root, "proj"));
  dataDir = mkdtempSync(join(tmpdir(), "hearth-data-"));
  const agentsFile = join(dataDir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify([
    { id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] },
    { id: "mockfull", name: "Mock full", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1", MOCK_LIST: "1", MOCK_RESUME: "1", MOCK_STORE: join(dataDir, "store.json") } },
    { id: "mockresume", name: "Mock resume", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LIST: "1", MOCK_RESUME: "1", MOCK_STORE: join(dataDir, "store.json") } },
    { id: "mockcfg", name: "Mock config", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_CONFIG: "1" } },
    { id: "devinfail", name: "Devin-like (load fails after attaching)", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1", MOCK_LIST: "1", MOCK_RESUME: "1", MOCK_LOAD_FAIL: "1", MOCK_STORE: join(dataDir, "store.json") } },
    { id: "devinlate", name: "Devin-like (late replay)", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1", MOCK_LIST: "1", MOCK_RESUME: "1", MOCK_LATE_REPLAY: "1", MOCK_STORE: join(dataDir, "store.json") } },
    { id: "mockload", name: "Mock+load", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1" } },
  ]));
  writeFileSync(join(dataDir, "store.json"), JSON.stringify({
    "cli-1": { cwd: join(root, "proj"), title: "Fix the parser", updatedAt: "2026-10-18T10:00:00Z", history: [{ role: "user", text: "fix the parser" }, { role: "agent", text: "Parser fixed." }] },
    "cli-2": { cwd: "/etc", title: "Outside roots", updatedAt: "2026-10-18T11:00:00Z", history: [] },
  }));
  const cfg = configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: agentsFile,
    HEARTH_IDENTITY: "header:x-user", HEARTH_PASSWORD: hashPassword(PW) });
  h = new Hearth(cfg);
  const port = await h.listen();
  base = `http://127.0.0.1:${port}`; origin = base;
  h.cfg.allowedOrigins.splice(0, Infinity, origin); // port was 0 at config time
});
after(async () => { await h.close(); });

const cookies = {};
async function api(user, method, path, body, extra = {}) {
  const headers = { "x-user": user, origin, "x-hearth-csrf": "1", "content-type": "application/json", ...(cookies[user] ? { cookie: cookies[user] } : {}), ...extra };
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookies[user] = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
function ws(user, id, since = 0, o = origin) {
  const sock = new WebSocket(`${base.replace("http", "ws")}/ws?session=${id}&since=${since}`, { headers: { "x-user": user, origin: o, cookie: cookies[user] ?? "" } });
  const msgs = []; const waiters = [];
  sock.on("message", (d) => { const m = JSON.parse(String(d)); msgs.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } });
  sock.until = (pred, ms = 8000) => { const f = msgs.find(pred); if (f) return Promise.resolve(f); return new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error("timeout waiting; got " + JSON.stringify(msgs.map((m) => m.type)))), ms).unref(); }); };
  sock.msgs = msgs;
  return new Promise((res, rej) => { sock.on("open", () => res(sock)); sock.on("unexpected-response", (_q, r) => rej(new Error("ws " + r.statusCode))); sock.on("error", rej); });
}
const text = (items) => items.filter((e) => e.msg?.method === "session/update" && e.msg.params.update.sessionUpdate === "agent_message_chunk").map((e) => e.msg.params.update.content.text).join("");

test("host, origin, csrf and identity checks", async () => {
  const { request } = await import("node:http");
  const code = await new Promise((res) => request(base + "/api/me", { headers: { host: "evil.example", "x-user": "a" } }, (r) => { r.resume(); res(r.statusCode); }).end());
  assert.equal(code, 421);
  assert.equal((await api("", "GET", "/api/me", null, { "x-user": "" })).status, 401);
  assert.equal((await api("alice@example.com", "POST", "/api/sessions", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await api("alice@example.com", "POST", "/api/sessions", {}, { "x-hearth-csrf": "" })).status, 403);
  const r = await fetch(base + "/");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
});

test("password unlock", async () => {
  assert.equal((await api("alice@example.com", "GET", "/api/sessions")).status, 423);
  assert.equal((await api("alice@example.com", "POST", "/api/unlock", { password: "nope" })).status, 403);
  assert.equal((await api("alice@example.com", "POST", "/api/unlock", { password: PW })).status, 200);
  assert.equal((await api("alice@example.com", "GET", "/api/sessions")).status, 200);
  // Cookie is bound to the identity: bob can't reuse alice's cookie.
  assert.equal((await api("bob@example.com", "GET", "/api/sessions", null, { cookie: cookies["alice@example.com"] })).status, 423);
  assert.equal((await api("bob@example.com", "POST", "/api/unlock", { password: PW })).status, 200);
});

test("probe lists agents and folder picker is scoped", async () => {
  const a = (await api("alice@example.com", "GET", "/api/agents")).json;
  assert.ok(a.find((x) => x.id === "mock" && x.installed));
  assert.ok(a.find((x) => x.id === "claude")); assert.ok(a.find((x) => x.id === "grok"));
  const d = (await api("alice@example.com", "GET", "/api/agents?deep=mockload")).json;
  assert.equal(d.ok, true); assert.equal(d.loadSession, true);
  const fs = (await api("alice@example.com", "GET", `/api/fs?path=${encodeURIComponent(root)}`)).json;
  assert.deepEqual(fs.dirs, ["proj"]);
  assert.equal((await api("alice@example.com", "GET", "/api/fs?path=/etc")).status, 403);
});

let sid;
test("session lifecycle: stream, permission, diff, plan, fs scope, terminal", async () => {
  assert.equal((await api("alice@example.com", "POST", "/api/sessions", { agentId: "mock", cwd: "/etc" })).status, 400);
  const c = await api("alice@example.com", "POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj") });
  assert.equal(c.status, 201); sid = c.json.id;
  const s = await ws("alice@example.com", sid);
  await s.until((m) => m.type === "state" && m.state === "idle");
  s.send(JSON.stringify({ type: "prompt", text: "plan then write" }));
  const perm = await s.until((m) => m.type === "permission");
  assert.equal(perm.params.toolCall.toolCallId, "tc1");
  s.close();
  // Reconnect: pending permission is re-sent, missed entries replayed.
  const s2 = await ws("alice@example.com", sid);
  const replay = await s2.until((m) => m.type === "replay");
  assert.ok(replay.items.some((e) => e.msg?.params?.update?.sessionUpdate === "plan"));
  assert.ok(replay.items.some((e) => e.msg?.params?.update?.content?.[0]?.type === "diff"));
  const p2 = await s2.until((m) => m.type === "permission");
  s2.send(JSON.stringify({ type: "permission", id: p2.id, optionId: "allow" }));
  await s2.until((m) => m.type === "prompt_done");
  assert.equal(readFileSync(join(root, "proj/hello.txt"), "utf8"), "hello\n");
  s2.send(JSON.stringify({ type: "prompt", text: "escape terminal" }));
  await s2.until((m) => m.type === "prompt_done" && s2.msgs.filter((x) => x.type === "prompt_done").length === 2);
  const all = (await ws("alice@example.com", sid)); const rp = await all.until((m) => m.type === "replay"); all.close();
  const t = text(rp.items);
  assert.match(t, /blocked: /); assert.doesNotMatch(t, /ESCAPED/); assert.match(t, /terminal said term-ok \(exit 0\)/); assert.match(t, /Hello \*\*world\*\*!/);
  // replay by seq
  const since = rp.items.at(-3).seq;
  const part = await ws("alice@example.com", sid, since); const pr = await part.until((m) => m.type === "replay"); part.close();
  assert.equal(pr.items.length, 2); assert.ok(pr.items.every((e) => e.seq > since));
  s2.close();
  // transcript on disk is JSONL with both directions
  const lines = h.store.read(h.store.get("alice@example.com", sid));
  assert.ok(lines.some((e) => e.dir === "out" && e.msg.method === "session/prompt"));
  assert.ok(lines.some((e) => e.dir === "in" && e.msg.method === "session/request_permission"));
});

test("cancel stops a running prompt", async () => {
  const s = await ws("alice@example.com", sid);
  s.send(JSON.stringify({ type: "prompt", text: "slow" }));
  await s.until((m) => m.type === "state" && m.state === "running");
  s.send(JSON.stringify({ type: "cancel" }));
  const d = await s.until((m) => m.type === "prompt_done" && m.stopReason === "cancelled");
  assert.equal(d.stopReason, "cancelled"); s.close();
});

test("sessions are strictly private per user", async () => {
  assert.equal((await api("bob@example.com", "GET", "/api/sessions")).json.length, 0);
  assert.equal((await api("bob@example.com", "GET", `/api/sessions/${sid}`)).status, 404);
  assert.equal((await api("bob@example.com", "PATCH", `/api/sessions/${sid}`, { title: "pwn" })).status, 404);
  assert.equal((await api("bob@example.com", "DELETE", `/api/sessions/${sid}`)).status, 404);
  await assert.rejects(ws("bob@example.com", sid), /ws 404/);
  await assert.rejects(ws("alice@example.com", sid, 0, "https://evil.example"), /ws 403/);
});

test("rename, list, terminate, purge", async () => {
  assert.equal((await api("alice@example.com", "PATCH", `/api/sessions/${sid}`, { title: "Renamed" })).json.title, "Renamed");
  const l = (await api("alice@example.com", "GET", "/api/sessions")).json;
  assert.equal(l[0].title, "Renamed");
  const pid = h.live.get(sid).child.pid;
  assert.equal((await api("alice@example.com", "DELETE", `/api/sessions/${sid}`)).status, 200);
  assert.throws(() => process.kill(pid, 0));
  assert.equal((await api("alice@example.com", "GET", `/api/sessions/${sid}`)).json.state, "exited");
  // History still readable after terminate
  const s = await ws("alice@example.com", sid); const r = await s.until((m) => m.type === "replay"); s.close();
  assert.ok(r.items.length > 5);
  await api("alice@example.com", "DELETE", `/api/sessions/${sid}?purge=1`);
  assert.equal((await api("alice@example.com", "GET", `/api/sessions/${sid}`)).status, 404);
});

test("agent restart uses session/load when supported, else resets context", async () => {
  for (const [agentId, expect] of [["mockload", "session_loaded"], ["mock", "context_reset"]]) {
    const c = await api("alice@example.com", "POST", "/api/sessions", { agentId, cwd: join(root, "proj") });
    const s = await ws("alice@example.com", c.json.id);
    await s.until((m) => m.type === "state" && m.state === "idle");
    s.send(JSON.stringify({ type: "prompt", text: "hi" })); await s.until((m) => m.type === "prompt_done");
    const live = h.live.get(c.json.id);
    live.child.kill("SIGKILL");
    await s.until((m) => m.type === "state" && m.state === "stopped");
    s.send(JSON.stringify({ type: "prompt", text: "again" }));
    await s.until((m) => m.type === "prompt_done" && s.msgs.filter((x) => x.type === "prompt_done").length === 2);
    const ev = h.store.read(live.meta).filter((e) => e.dir === "sys").map((e) => e.msg.event);
    assert.ok(ev.includes(expect), `${agentId}: ${ev}`);
    // replayed history from session/load is not duplicated into the transcript
    assert.doesNotMatch(text(h.store.read(live.meta)), /replayed history/);
    s.close();
    await api("alice@example.com", "DELETE", `/api/sessions/${c.json.id}`);
  }
});

test("import existing agent sessions (list + load seeds transcript; resume-only; unsupported)", async () => {
  const U = "alice@example.com";
  const l = (await api(U, "GET", "/api/agents/mockfull/sessions")).json;
  assert.equal(l.source, "acp"); assert.equal(l.importable, true);
  assert.deepEqual(l.sessions.map((x) => [x.sessionId, x.allowed]), [["cli-2", false], ["cli-1", true]]);
  assert.equal((await api(U, "POST", "/api/sessions/import", { agentId: "mockfull", agentSessionId: "cli-2", cwd: "/etc" })).status, 400);
  const imp = await api(U, "POST", "/api/sessions/import", { agentId: "mockfull", agentSessionId: "cli-1", cwd: join(root, "proj"), title: "Fix the parser" });
  assert.equal(imp.status, 201); assert.equal(imp.json.importedFrom.via, "load");
  const s = await ws(U, imp.json.id); const rp = await s.until((m) => m.type === "replay");
  const ups = rp.items.filter((e) => e.msg?.method === "session/update").map((e) => e.msg.params.update);
  assert.deepEqual(ups.map((u) => [u.sessionUpdate, u.content.text]), [["user_message_chunk", "fix the parser"], ["agent_message_chunk", "Parser fixed."]]);
  // continues in the same agent session
  s.send(JSON.stringify({ type: "prompt", text: "hi" })); await s.until((m) => m.type === "prompt_done");
  const out = h.store.read(h.live.get(imp.json.id).meta).find((e) => e.dir === "out" && e.msg.method === "session/prompt");
  assert.equal(out.msg.params.sessionId, "cli-1");
  // restart after import: history is NOT replayed again
  h.live.get(imp.json.id).child.kill("SIGKILL"); await s.until((m) => m.type === "state" && m.state === "stopped");
  s.send(JSON.stringify({ type: "prompt", text: "again" })); await s.until((m) => m.type === "prompt_done" && s.msgs.filter((x) => x.type === "prompt_done").length === 2);
  const chunks = h.store.read(h.live.get(imp.json.id).meta).filter((e) => e.msg?.params?.update?.content?.text === "Parser fixed.");
  assert.equal(chunks.length, 1); s.close();
  // listing marks it as already imported; re-import returns the same Hearth session
  const l2 = (await api(U, "GET", "/api/agents/mockfull/sessions")).json;
  assert.equal(l2.sessions.find((x) => x.sessionId === "cli-1").hearthId, imp.json.id);
  assert.equal((await api(U, "POST", "/api/sessions/import", { agentId: "mockfull", agentSessionId: "cli-1", cwd: join(root, "proj") })).json.id, imp.json.id);
  // other users don't see the import
  assert.equal((await api("bob@example.com", "GET", "/api/agents/mockfull/sessions")).json.sessions.find((x) => x.sessionId === "cli-1").hearthId, null);
  // resume-only agent: imported without history
  const r2 = await api(U, "POST", "/api/sessions/import", { agentId: "mockresume", agentSessionId: "cli-1", cwd: join(root, "proj") });
  assert.equal(r2.status, 201); assert.equal(r2.json.importedFrom.via, "resume");
  // unknown session id fails cleanly and leaves nothing behind
  const before = (await api(U, "GET", "/api/sessions")).json.length;
  assert.equal((await api(U, "POST", "/api/sessions/import", { agentId: "mockresume", agentSessionId: "nope", cwd: join(root, "proj") })).status, 502);
  assert.equal((await api(U, "GET", "/api/sessions")).json.length, before);
  // agent without list/load/resume
  const n = (await api(U, "GET", "/api/agents/mock/sessions")).json;
  assert.equal(n.source, "none"); assert.equal(n.importable, false);
  for (const x of [imp.json.id, r2.json.id]) await api(U, "DELETE", `/api/sessions/${x}`);
});

test("terminal: shell lines, relative cwd, args, missing binary, byte limit (Devin-style)", async () => {
  const U = "alice@example.com";
  const c = await api(U, "POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj") });
  const s = await ws(U, c.json.id); await s.until((m) => m.type === "state" && m.state === "idle");
  s.send(JSON.stringify({ type: "prompt", text: "shellcmd" })); await s.until((m) => m.type === "prompt_done");
  const t = text(h.store.read(h.live.get(c.json.id).meta));
  assert.ok(t.includes(`A="X2\\n${join(root, "proj")}" exit=0`), t);
  assert.match(t, /status=\{"exitCode":0,"signal":null\}/);
  assert.match(t, /B=a b-c/); assert.match(t, /C=127/); assert.match(t, /D=100,true/);
  s.close(); await api(U, "DELETE", `/api/sessions/${c.json.id}`);
});

test("streaming: message and thought chunks reach the browser before the turn ends", async () => {
  const U = "alice@example.com";
  const c = await api(U, "POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj") });
  const s = await ws(U, c.json.id); await s.until((m) => m.type === "state" && m.state === "idle");
  const seen = []; s.on("message", (d) => { const m = JSON.parse(String(d)); const u = m.entry?.msg?.params?.update; if (u) seen.push([u.sessionUpdate, Date.now()]); if (m.type === "prompt_done") seen.push(["done", Date.now()]); });
  s.send(JSON.stringify({ type: "prompt", text: "stream" }));
  await s.until((m) => m.type === "prompt_done");
  const done = seen.find((x) => x[0] === "done")[1];
  const msg = seen.filter((x) => x[0] === "agent_message_chunk"), th = seen.filter((x) => x[0] === "agent_thought_chunk");
  assert.ok(msg.length >= 4 && th.length >= 4);
  assert.ok(done - msg[0][1] >= 400, `first chunk only ${done - msg[0][1]}ms before done`);
  assert.ok(msg[1][1] - msg[0][1] >= 100, "chunks were batched");
  s.close(); await api(U, "DELETE", `/api/sessions/${c.json.id}`);
});

const settled = (s, pred) => s.until((m) => m.type === "settings" && pred(m.options));
const val = (opts, id) => opts.find((o) => o.id === id)?.value;

test("config options: select/boolean, grouped choices, dependent options, agent pushes, reconnect, per-agent defaults", async () => {
  const u = "cfg@example.com";
  for (const x of [u, "other@example.com"]) await api(x, "POST", "/api/unlock", { password: PW });
  const c = await api(u, "POST", "/api/sessions", { agentId: "mockcfg", cwd: join(root, "proj") });
  const s = await ws(u, c.json.id);
  const first = await settled(s, (o) => o.length === 4);
  const model = first.options.find((o) => o.id === "model");
  assert.equal(model.category, "model"); assert.equal(model.via, "config");
  assert.deepEqual(model.choices.map((x) => [x.value, x.group]), [["m-small", "Fast"], ["m-large", "Smart"]]);
  assert.ok(!first.options.some((o) => o.via !== "config"), "legacy modes/models are ignored when configOptions exist");
  s.send(JSON.stringify({ type: "setOption", configId: "model", value: "m-large" }));
  await settled(s, (o) => val(o, "model") === "m-large" && o.find((x) => x.id === "effort").choices.length === 2);
  s.send(JSON.stringify({ type: "setOption", configId: "effort", value: "high" }));
  s.send(JSON.stringify({ type: "setOption", configId: "web", value: true }));
  await settled(s, (o) => val(o, "web") === true && val(o, "effort") === "high");
  s.send(JSON.stringify({ type: "setOption", configId: "model", value: "nope" }));
  await s.until((m) => m.type === "error" && /invalid value/.test(m.message));
  s.send(JSON.stringify({ type: "prompt", text: "whoami pushcfg" }));
  await settled(s, (o) => val(o, "mode") === "ask");
  await s.until((m) => m.type === "prompt_done");
  assert.match(text(h.store.read(h.live.get(c.json.id).meta)), /model=m-large mode=code effort=high web=true/);
  s.close();
  // reconnect gets current state immediately
  const s2 = await ws(u, c.json.id); const r = await s2.until((m) => m.type === "settings");
  assert.equal(val(r.options, "mode"), "ask"); assert.equal(val(r.options, "web"), true); s2.close();
  // a new session with this agent starts with the remembered choices (model applied before effort)
  const c2 = await api(u, "POST", "/api/sessions", { agentId: "mockcfg", cwd: join(root, "proj") });
  const s3 = await ws(u, c2.json.id);
  await settled(s3, (o) => val(o, "model") === "m-large" && val(o, "effort") === "high" && val(o, "web") === true && val(o, "mode") === "code"); // agent-pushed mode is not a user preference
  // another user is unaffected
  const c3 = await api("other@example.com", "POST", "/api/sessions", { agentId: "mockcfg", cwd: join(root, "proj") });
  const s4 = await ws("other@example.com", c3.json.id);
  const o4 = await settled(s4, (o) => o.length === 4); await s4.until((m) => m.type === "state" && m.state === "idle");
  assert.equal(val(o4.options, "model"), "m-small");
  s3.close(); s4.close();
});

test("legacy modes + unstable models: set_mode, set_model, current_mode_update", async () => {
  const u = "legacy@example.com"; await api(u, "POST", "/api/unlock", { password: PW });
  const c = await api(u, "POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj") });
  const s = await ws(u, c.json.id);
  const first = await settled(s, (o) => o.length === 2);
  const mode = first.options.find((o) => o.category === "mode"), model = first.options.find((o) => o.category === "model");
  assert.equal(mode.via, "mode"); assert.equal(model.via, "model");
  s.send(JSON.stringify({ type: "setOption", configId: model.id, value: "lm-b" }));
  await settled(s, (o) => val(o, model.id) === "lm-b");
  s.send(JSON.stringify({ type: "setOption", configId: mode.id, value: "ask" }));
  await settled(s, (o) => val(o, mode.id) === "ask");
  s.send(JSON.stringify({ type: "prompt", text: "whoami" })); await s.until((m) => m.type === "prompt_done");
  assert.match(text(h.store.read(h.live.get(c.json.id).meta)), /model=lm-b mode=ask/);
  s.send(JSON.stringify({ type: "setOption", configId: mode.id, value: "code" }));
  await settled(s, (o) => val(o, mode.id) === "code");
  s.send(JSON.stringify({ type: "prompt", text: "pushmode" }));
  await settled(s, (o) => val(o, mode.id) === "ask");
  s.close();
});

test("import + resume (Devin-like): no duplicated live stream or history", async () => {
  const U = "devin@example.com"; await api(U, "POST", "/api/unlock", { password: PW });
  const words = (t, w) => t.split(w).length - 1;
  for (const agentId of ["devinfail", "devinlate"]) {
    const imp = await api(U, "POST", "/api/sessions/import", { agentId, agentSessionId: "cli-1", cwd: join(root, "proj"), title: "imp" });
    assert.ok([200, 201].includes(imp.status), `${agentId}: ${JSON.stringify(imp.json)}`);
    const s = await ws(U, imp.json.id);
    await s.until((m) => m.type === "state" && m.state === "idle");
    await new Promise((r) => setTimeout(r, 200)); // let any late replay land
    for (let round = 0; round < 2; round++) {
      s.send(JSON.stringify({ type: "prompt", text: "stream" }));
      await s.until((m) => m.type === "prompt_done" && s.msgs.filter((x) => x.type === "prompt_done").length === round + 1);
      await new Promise((r) => setTimeout(r, 200));
      if (round === 0) { h.live.get(imp.json.id).child.kill("SIGKILL"); await s.until((m) => m.type === "state" && m.state === "stopped"); await api(U, "POST", `/api/sessions/${imp.json.id}/resume`); await new Promise((r) => setTimeout(r, 200)); }
    }
    const t = text(h.store.read(h.live.get(imp.json.id).meta));
    assert.equal(words(t, "one "), 2, `${agentId}: one copy per turn: ${t}`);
    if (agentId === "devinlate") assert.equal(words(t, "Parser fixed."), 1, `${agentId}: history once: ${t}`);
    s.close(); await api(U, "DELETE", `/api/sessions/${imp.json.id}?purge=1`);
  }
});

test("history paging over WebSocket: tail on open, cursor pages, live entries meanwhile, reconnect unaffected", async () => {
  const U = "pager@example.com"; await api(U, "POST", "/api/unlock", { password: PW });
  const c = await api(U, "POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj") });
  const l = h.live.get(c.json.id); await l.ensureRunning();
  for (let t = 0; t < 20; t++) { l.log("out", { method: "session/prompt", params: { prompt: [{ type: "text", text: `q${t}` }] } }); l.log("in", { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `a${t}` } } } }); }
  const s = await ws(U, c.json.id);
  const rp = await s.until((m) => m.type === "replay");
  assert.equal(rp.hasMore, true); assert.equal(rp.items.filter((e) => e.msg?.method === "session/prompt").length, 8);
  const seen = [...rp.items];
  s.send(JSON.stringify({ type: "prompt", text: "hi" })); // live stream while paging
  let before = rp.firstSeq, more = true, n = 0;
  while (more) {
    s.send(JSON.stringify({ type: "history", before }));
    const pg = await s.until((m) => m.type === "history" && m.before === before);
    assert.ok(pg.items.every((e) => e.seq < before)); seen.unshift(...pg.items);
    more = pg.hasMore; if (pg.items.length) before = pg.items[0].seq; n++;
  }
  await s.until((m) => m.type === "prompt_done");
  for (const m of s.msgs) if (m.type === "entry") seen.push(m.entry);
  const seqs = seen.map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), "no gaps in order, no duplicates");
  assert.deepEqual(seqs, h.store.read(l.meta).map((e) => e.seq), "everything exactly once");
  assert.ok(n >= 2);
  s.close();
  // reconnect with since gets only what's new, not a tail page
  const s2 = await ws(U, c.json.id, seqs.at(-3)); const r2 = await s2.until((m) => m.type === "replay");
  assert.equal(r2.items.length, 2); s2.close();
});
