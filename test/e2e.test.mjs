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
    { id: "mockload", name: "Mock+load", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1" } },
  ]));
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
