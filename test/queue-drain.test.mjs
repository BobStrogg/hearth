// The server-side prompt queue drains whenever the agent is idle: after a Stop, after the agent dies (respawned),
// when the agent is restarted, on Hearth startup with a leftover queue, and on the periodic idle check.
// Order is kept and nothing is sent twice.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";
import { LiveSession } from "../dist/session.js";
import { hashPassword } from "../dist/auth.js";

const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const PW = "s3cret", U = "q@example.com";
let root, dataDir, agentsFile, h, base;
const cookies = {};

const cfgFor = () => configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: agentsFile,
  HEARTH_IDENTITY: "header:x-user", HEARTH_PASSWORD: hashPassword(PW), HEARTH_QUEUE_CHECK_MS: "100" });
async function start() {
  h = new Hearth(cfgFor()); const port = await h.listen(); base = `http://127.0.0.1:${port}`;
  h.cfg.allowedOrigins.splice(0, Infinity, base);
  await api("POST", "/api/unlock", { password: PW });
}
async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: { "x-user": U, origin: base, "x-hearth-csrf": "1", "content-type": "application/json", ...(cookies[U] ? { cookie: cookies[U] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookies[U] = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
function ws(id) {
  const sock = new WebSocket(`${base.replace("http", "ws")}/ws?session=${id}&since=0`, { headers: { "x-user": U, origin: base, cookie: cookies[U] ?? "" } });
  sock.msgs = []; sock.on("message", (d) => sock.msgs.push(JSON.parse(String(d))));
  return new Promise((res, rej) => { sock.on("open", () => res(sock)); sock.on("unexpected-response", (_q, r) => rej(new Error("ws " + r.statusCode))); sock.on("error", rej); });
}
const send = (s, o) => s.send(JSON.stringify(o));
const prompts = (id) => h.store.read(h.store.get(U, id)).filter((e) => e.dir === "out" && e.msg.method === "session/prompt").map((e) => e.msg.params.prompt.map((c) => c.text).join(""));
async function until(f, what, ms = 10000) {
  for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
}
const newSession = async (title) => (await api("POST", "/api/sessions", { agentId: "mock", cwd: join(root, "proj"), title })).json.id;
const text = (t) => [{ type: "text", text: t }];
const RETRY = LiveSession.RETRY_MS;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-qroot-")); mkdirSync(join(root, "proj"));
  dataDir = mkdtempSync(join(tmpdir(), "hearth-qdata-"));
  agentsFile = join(dataDir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  await start();
});
after(async () => { LiveSession.RETRY_MS = RETRY; await h.close(); });

test("after a Stop the queue carries on by itself, in order, each prompt once", async () => {
  const id = await newSession("stop"); const s = await ws(id);
  send(s, { type: "prompt", text: "slow 1" });
  await until(() => prompts(id).length === 1, "first prompt");
  for (const t of ["2", "3", "4"]) send(s, { type: "prompt", text: t });
  await until(() => h.live.get(id).queue.items.length === 3, "queued");
  send(s, { type: "cancel" });
  await until(() => prompts(id).length === 4 && h.live.get(id).queue.items.length === 0 && !h.live.get(id).turnActive, "drained");
  assert.deepEqual(prompts(id), ["slow 1", "2", "3", "4"]);
  assert.equal(s.msgs.some((m) => m.type === "queue" && m.paused), false);
  s.close();
});

test("the agent dies mid-turn: the queue pauses, then respawns the agent by itself and drains", async () => {
  LiveSession.RETRY_MS = [300, 300];
  try {
    const id = await newSession("crash"); const s = await ws(id);
    send(s, { type: "prompt", text: "crashlater" });
    await until(() => prompts(id).length === 1, "first prompt");
    send(s, { type: "prompt", text: "B" }); send(s, { type: "prompt", text: "C" });
    await until(() => s.msgs.some((m) => m.type === "queue" && m.paused && /failed \(trying again in/.test(m.reason)), "paused with a retry");
    assert.deepEqual(h.live.get(id).queue.items.map((i) => i.content[0].text), ["B", "C"]);
    await until(() => prompts(id).length === 3 && !h.live.get(id).turnActive, "drained after respawn");
    assert.deepEqual(prompts(id), ["crashlater", "B", "C"]);
    assert.equal(h.live.get(id).alive, true, "agent respawned");
    assert.equal(h.live.get(id).queue.paused, false);
    s.close();
  } finally { LiveSession.RETRY_MS = RETRY; }
});

test("retries give up after the last delay and wait for Resume; restarting the agent drains it straight away", async () => {
  LiveSession.RETRY_MS = [60_000];
  try {
    const id = await newSession("restart"); const s = await ws(id);
    send(s, { type: "prompt", text: "crashlater" });
    await until(() => prompts(id).length === 1, "first prompt");
    send(s, { type: "prompt", text: "B" });
    await until(() => h.live.get(id).queue.paused && /trying again in 1 min/.test(h.live.get(id).queue.reason), "paused, retry in 1 min");
    await new Promise((r) => setTimeout(r, 400)); // several idle checks: still waiting
    assert.equal(prompts(id).length, 1);
    send(s, { type: "resume" }); // the Restart/Resume-agent action: the agent comes back and the queue goes
    await until(() => prompts(id).length === 2 && !h.live.get(id).turnActive, "drained after restart");
    assert.deepEqual(prompts(id), ["crashlater", "B"]);
    // no delays left: a failure waits for Resume
    LiveSession.RETRY_MS = [];
    send(s, { type: "prompt", text: "crashlater" });
    await until(() => prompts(id).length === 3, "third");
    send(s, { type: "prompt", text: "D" });
    await until(() => h.live.get(id).queue.paused && /press Resume/.test(h.live.get(id).queue.reason), "waits for Resume");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(prompts(id).length, 3);
    send(s, { type: "queue_resume" });
    await until(() => prompts(id).length === 4 && !h.live.get(id).turnActive, "drained after Resume");
    assert.equal(prompts(id).at(-1), "D");
    s.close();
  } finally { LiveSession.RETRY_MS = RETRY; }
});

test("periodic idle check: a queue left behind while the agent is idle drains with no client connected", async () => {
  const id = await newSession("idle");
  const l = h.live.get(id); await l.ensureRunning();
  await until(() => !l.turnActive, "idle");
  l.queue.add(text("I1")); l.queue.add(text("I2")); // nothing kicks it except the timer
  await until(() => prompts(id).length === 2 && !l.turnActive, "drained by the idle check");
  assert.deepEqual(prompts(id), ["I1", "I2"]);
});

test("no double-send: many kicks at once still run each prompt exactly once, in order", async () => {
  const id = await newSession("kicks");
  const l = h.live.get(id); await l.ensureRunning();
  for (const t of ["K1", "K2", "K3"]) l.queue.add(text(t));
  for (let i = 0; i < 20; i++) { l.kick(); h.kickQueues(); }
  await until(() => prompts(id).length >= 3 && l.queue.items.length === 0 && !l.turnActive, "drained");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(prompts(id), ["K1", "K2", "K3"]);
});

test("Hearth startup: a leftover queue (even one paused by a failure) drains without anyone opening it", async () => {
  const id = await newSession("startup");
  await until(() => h.live.get(id)?.alive, "agent up");
  await h.close();
  const dir = h.store.dir(U, id);
  const at = new Date().toISOString();
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ paused: true, items: ["S1", "S2", "S3"].map((t) => ({ id: randomUUID(), content: text(t), at })) }));
  await start();
  await until(() => prompts(id).length === 3 && !h.live.get(id).turnActive && h.live.get(id).queue.items.length === 0, "drained after startup");
  assert.deepEqual(prompts(id), ["S1", "S2", "S3"]);
});
