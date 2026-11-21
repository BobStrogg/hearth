// Persistent terminals: the pty helper, the registry (create / detach / reattach with replay / resize / close with the
// SIGKILL fallback / limits / idle and ended clean-up), and the HTTP + WebSocket API with per-user isolation.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { ensurePtyHelper, PTY_C } from "../dist/pty.js";
import { Terminals, TermError } from "../dist/terminals.js";
import { Hearth, configFromEnv } from "../dist/server.js";

const home = mkdtempSync(join(tmpdir(), "hearth-pty-"));
const helper = process.platform === "win32" ? { path: null, note: "windows" } : ensurePtyHelper({ home });
const skip = helper.path === null ? `no pty helper: ${helper.note}` : false;
const SHELL = existsSync("/bin/bash") ? { command: "/bin/bash", args: ["--norc", "--noprofile", "-i"] } : { command: "/bin/sh", args: ["-i"] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake viewer that collects output and JSON events. */
function viewer() {
  const v = { out: "", events: [], send(d) { if (typeof d === "string") v.events.push(JSON.parse(d)); else v.out += d.toString("utf8"); } };
  v.until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred(v)) return; await sleep(20); } throw new Error(`timeout; output so far: ${JSON.stringify(v.out.slice(-400))} events: ${JSON.stringify(v.events.map((e) => e.type))}`); };
  return v;
}
const mk = (o = {}) => new Terminals({ helper: () => helper, shell: () => SHELL, graceMs: 400, ...o });

test("pty helper: built once, reused while the source is unchanged, not on Windows", { skip }, () => {
  assert.equal(helper.built, true);
  assert.deepEqual(ensurePtyHelper({ home }), { path: helper.path, built: false });
  assert.equal(ensurePtyHelper({ home, platform: "win32" }).path, null);
  const none = ensurePtyHelper({ home: mkdtempSync(join(tmpdir(), "hearth-pty-none-")), platform: "darwin", run: () => ({ status: 1, out: "" }) });
  assert.equal(none.path, null); assert.match(none.note, /Command Line Tools/);
  assert.match(PTY_C, /forkpty/);
});

describe("terminal registry", { skip }, () => {
  let T; const cwd = mkdtempSync(join(tmpdir(), "hearth-term-cwd-"));
  before(() => { T = mk(); });
  after(async () => { await T.shutdown(); });

  test("output reaches a viewer; the shell keeps running after it detaches; reattach replays what it missed", async () => {
    const t = T.create("alice", { cwd, cols: 100, rows: 30 });
    assert.equal(t.info().title, "Terminal 1"); assert.equal(t.info().state, "running");
    const v = viewer(); const detach = t.attach(v);
    assert.equal(v.events[0].type, "hello"); assert.equal(v.events[0].terminal.viewers, 1);
    t.input("echo hello-$((40+2)); pwd\n");
    await v.until((x) => x.out.includes("hello-42"));
    assert.ok(v.out.includes(cwd), "starts in the requested folder");
    assert.equal(T.list("alice")[0].viewers, 1);
    t.input("sleep 0.4; echo while-away-$((6*7))\n");
    detach();
    assert.equal(T.list("alice")[0].viewers, 0);
    await sleep(900);
    const v2 = viewer(); t.attach(v2);
    assert.ok(v2.out.includes("while-away-42"), "the replay has output produced while nobody watched");
    assert.ok(v2.out.includes("hello-42"));
    assert.equal(T.list("bob").length, 0, "other users don't see it");
    assert.equal(T.get("bob", t.id), undefined);
  });

  test("resize reaches the program; input and env: TERM set, Hearth's secrets not passed on", async () => {
    process.env.HEARTH_MCP_TOKEN = "super-secret-token-value";
    const t = T.create("alice", { cwd, title: "  sized  " });
    delete process.env.HEARTH_MCP_TOKEN;
    assert.equal(t.title, "sized");
    const v = viewer(); t.attach(v);
    t.resize(123, 45);
    t.input("stty size; echo T=$TERM S=${HEARTH_MCP_TOKEN:-none} ID=$HEARTH_TERMINAL\n");
    await v.until((x) => x.out.includes("ID=" + t.id));
    assert.match(v.out, /45 123/);
    assert.match(v.out, /T=xterm-256color S=none/);
    assert.equal(t.info().cols, 123);
  });

  test("the shell exiting ends the terminal: exit code, an exit event, kept in the list until removed", async () => {
    const t = T.create("alice", { cwd });
    const v = viewer(); t.attach(v);
    t.input("exit 3\n");
    await v.until((x) => x.events.some((e) => e.type === "exit"));
    const ev = v.events.find((e) => e.type === "exit");
    assert.equal(ev.terminal.state, "exited"); assert.equal(ev.terminal.exitCode, 3);
    assert.ok(T.list("alice").some((x) => x.id === t.id && x.state === "exited"));
    const late = viewer(); t.attach(late);
    assert.ok(late.events.some((e) => e.type === "exit"), "attaching to an ended terminal shows its output and that it ended");
    await T.close("alice", t.id); // already ended: just leaves the list
    assert.ok(!T.list("alice").some((x) => x.id === t.id));
  });

  test("close hangs up, then SIGKILLs a job that ignores SIGHUP", async () => {
    const t = T.create("alice", { cwd });
    const v = viewer(); t.attach(v);
    t.input(`sh -c 'trap "" HUP; echo JOB=$$; exec sleep 60'\n`);
    await v.until((x) => /JOB=\d+/.test(x.out));
    const job = Number(/JOB=(\d+)/.exec(v.out)[1]);
    await sleep(100);
    process.kill(job, 0); // alive
    const info = await T.close("alice", t.id);
    assert.equal(info.state, "exited");
    await sleep(100); // close() resolved once the session was empty (the job was SIGKILLed after the 400 ms grace)
    assert.throws(() => process.kill(job, 0), /ESRCH/, "the HUP-ignoring job was killed");
    assert.ok(T.list("alice").some((x) => x.id === t.id), "a closed terminal stays listed (ended) until removed");
    await T.close("alice", t.id, { remove: true });
    assert.ok(!T.list("alice").some((x) => x.id === t.id));
  });

  test("foreground program shows in the detailed list", async () => {
    const t = T.create("alice", { cwd });
    const v = viewer(); t.attach(v);
    t.input("echo ready; sleep 30\n");
    await v.until((x) => x.out.includes("ready\r\n"));
    await sleep(300);
    const row = (await T.listDetailed("alice")).find((x) => x.id === t.id);
    assert.equal(row.running, "sleep");
    await T.close("alice", t.id, { remove: true });
  });
});

test("limits: at most `max` running per user; idle ones close; ended ones age out", { skip }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hearth-term-lim-"));
  const T = mk({ max: 1, idleMs: 200, keepExitedMs: 100, sweepMs: 3600_000 });
  try {
    const a = T.create("u", { cwd });
    assert.throws(() => T.create("u", { cwd }), (e) => e instanceof TermError && e.status === 409);
    const keep = viewer(); const other = T.create("someone-else", { cwd }); other.attach(keep); // per user; viewed, so never idle
    assert.throws(() => T.create("u", { cwd: join(cwd, "missing") }), /doesn't exist/);
    const v = viewer(); const detach = a.attach(v);
    await sleep(400);
    T.sweep(); assert.equal(a.state, "running", "not idle while someone is viewing");
    detach(); a.lastActivity = Date.now() - 1000;
    T.sweep(); await a.done;
    assert.equal(a.state, "exited");
    await sleep(50);
    assert.ok(!T.list("u").some((x) => x.id === a.id), "an idle-closed terminal is removed");
    await T.close("someone-else", other.id);
    T.sweep(Date.now() + 1000);
    assert.equal(T.list("someone-else").length, 0, "ended terminals leave the list after keepExitedMs");
    T.create("u", { cwd }); // room again
  } finally { await T.shutdown(); }
});

test("unavailable helper: a clear error, nothing started", async () => {
  const T = new Terminals({ helper: () => ({ path: null, note: "no compiler here" }) });
  assert.deepEqual(T.status(), { available: false, note: "no compiler here" });
  assert.throws(() => T.create("u", { cwd: tmpdir() }), (e) => e.status === 503 && /no compiler here/.test(e.message));
  await T.shutdown();
});

describe("terminals over HTTP and WebSocket", { skip }, () => {
  let h, base, origin, root, dataDir;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "hearth-troot-")); mkdirSync(join(root, "proj"));
    dataDir = mkdtempSync(join(tmpdir(), "hearth-tdata-"));
    h = new Hearth(configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: root, HEARTH_IDENTITY: "header:x-user", HEARTH_AGENTS_FILE: join(dataDir, "agents.json") }));
    h.terminals.o.shell = () => SHELL; h.terminals.o.graceMs = 400;
    const port = await h.listen(); base = `http://127.0.0.1:${port}`; origin = base;
    h.cfg.allowedOrigins.splice(0, Infinity, origin);
  });
  after(async () => { await h.close(); });
  const api = async (user, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "x-user": user, origin, "x-hearth-csrf": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const open = (user, id) => new Promise((res, rej) => {
    const sock = new WebSocket(`${base.replace("http", "ws")}/ws/term?id=${id}`, { headers: { "x-user": user, origin } });
    sock.out = ""; sock.events = [];
    sock.on("message", (d, bin) => { if (bin) sock.out += d.toString("utf8"); else sock.events.push(JSON.parse(String(d))); });
    sock.until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred(sock)) return; await sleep(20); } throw new Error("timeout: " + JSON.stringify(sock.out.slice(-300))); };
    sock.on("open", () => res(sock)); sock.on("unexpected-response", (_q, r) => rej(new Error("ws " + r.statusCode))); sock.on("error", rej);
  });

  test("create, attach, type, reload (reattach), rename, close", async () => {
    assert.equal((await api("alice", "GET", "/api/me")).json.terminals, true);
    assert.equal((await api("alice", "POST", "/api/terminals", { cwd: "/etc" })).status, 403);
    const c = await api("alice", "POST", "/api/terminals", { cwd: join(root, "proj"), cols: 90, rows: 20 });
    assert.equal(c.status, 201); const id = c.json.id;
    assert.match(id, /^[a-f0-9]{16}$/); assert.equal(c.json.cwd, join(root, "proj"));
    const s1 = await open("alice", id);
    s1.send(JSON.stringify({ type: "input", data: "echo over-ws-$((2+3))\n" }));
    await s1.until((s) => s.out.includes("over-ws-5"));
    s1.close(); await sleep(100);
    const list = await api("alice", "GET", "/api/terminals");
    assert.equal(list.json.length, 1); assert.equal(list.json[0].state, "running"); assert.equal(list.json[0].viewers, 0);
    const s2 = await open("alice", id); // the shell survived the disconnect
    await s2.until((s) => s.out.includes("over-ws-5"));
    s2.send(Buffer.from("echo binary-in\n"));
    await s2.until((s) => s.out.includes("binary-in\r\n"));
    assert.equal((await api("alice", "PATCH", `/api/terminals/${id}`, { title: "Devin" })).json.title, "Devin");
    await s2.until((s) => s.events.some((e) => e.type === "info" && e.terminal.title === "Devin"));
    // Someone else can't see, attach to or close it.
    assert.equal((await api("bob", "GET", "/api/terminals")).json.length, 0);
    assert.equal((await api("bob", "DELETE", `/api/terminals/${id}`)).status, 404);
    await assert.rejects(open("bob", id), /ws 404/);
    const d = await api("alice", "DELETE", `/api/terminals/${id}`);
    assert.equal(d.status, 200); assert.equal(d.json.state, "exited");
    await s2.until((s) => s.events.some((e) => e.type === "exit"));
    assert.equal((await api("alice", "DELETE", `/api/terminals/${id}`)).status, 200); // remove the ended one
    assert.equal((await api("alice", "GET", "/api/terminals")).json.length, 0);
  });

  test("HEARTH_TERMINALS=off turns them off", () => {
    assert.equal(configFromEnv({ HEARTH_TERMINALS: "off" }).terminals, false);
    assert.equal(configFromEnv({}).terminals, process.platform !== "win32");
    assert.equal(configFromEnv({ HEARTH_TERMINAL_IDLE_HOURS: "0" }).terminalIdleHours, 0);
  });
});
