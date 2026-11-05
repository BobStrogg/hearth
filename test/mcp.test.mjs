// Streamable-HTTP MCP: auth, the initialize handshake, and send-then-poll against a real session.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mcpAvailability, mcpDoctorCheck, resolveMcpOwner, summarizeTranscript, tokenMatches } from "../dist/mcp.js";
import { Hearth, configFromEnv } from "../dist/server.js";
import { hashPassword } from "../dist/auth.js";

const TOKEN = "a".repeat(32);
const OTHER = "b".repeat(32);
const PW = "s3cret";
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;

test("MCP token, owner, and transcript summary", async () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, OTHER), false);
  assert.equal(tokenMatches(TOKEN, TOKEN + "x"), false);
  assert.equal(mcpAvailability(undefined)?.status, 404);
  assert.equal(mcpAvailability("short")?.status, 503);
  assert.equal(mcpAvailability("has space inside!!")?.status, 503);
  assert.equal(mcpAvailability(TOKEN), null);
  assert.deepEqual(resolveMcpOwner({ identity: "single:Me" }), { owner: "me" });
  assert.deepEqual(resolveMcpOwner({ identity: "header:x-user" }).error?.length > 0, true);
  assert.deepEqual(resolveMcpOwner({ identity: "cloudflare", mcpUser: "Alice@Example.com" }), { owner: "alice@example.com" });
  assert.equal("error" in resolveMcpOwner({ identity: "single:me", mcpUser: "nope@x", allowedUsers: ["me"] }), true);
  assert.equal(mcpDoctorCheck({ identity: "single:me" }).level, "info");
  assert.equal(mcpDoctorCheck({ identity: "single:me", mcpToken: "short" }).level, "fail");
  assert.equal(mcpDoctorCheck({ identity: "header:x-user", mcpToken: TOKEN }).level, "fail");
  assert.match(mcpDoctorCheck({ identity: "single:me", mcpToken: TOKEN }).title, /\/mcp/);

  const { writeEnvFile, parseEnv } = await import("../dist/platform.js");
  const f = join(mkdtempSync(join(tmpdir(), "mcp-env-")), "env");
  writeEnvFile(f, { mcpToken: TOKEN, mcpUser: "mcp@example.com" }, {}, "linux", "/home/u");
  const saved = parseEnv(readFileSync(f, "utf8"));
  assert.equal(saved.HEARTH_MCP_TOKEN, TOKEN);
  assert.equal(saved.HEARTH_MCP_USER, "mcp@example.com");

  let seq = 0;
  const line = (dir, msg) => ({ seq: ++seq, ts: "t", dir, msg });
  const sum = summarizeTranscript([
    line("out", { method: "session/prompt", params: { prompt: [{ type: "text", text: "hi" }] } }),
    line("in", { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } } }),
    line("in", { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } } }),
    line("in", { method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Write hello.txt", status: "pending" } } }),
    line("in", { method: "session/request_permission", params: { toolCall: { title: "Write hello.txt" } } }),
    line("in", { result: { stopReason: "end_turn" } }),
  ]);
  assert.deepEqual(sum.events.map((e) => e.kind), ["user", "assistant", "tool", "permission", "done"]);
  assert.equal(sum.events[1].text, "Hello world");
  assert.equal(sum.events.at(-1).stopReason, "end_turn");
  assert.equal(sum.cursor, 6);
  assert.equal(sum.hasMore, false);
});

let h, base, root, proj;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-mcp-")); proj = join(root, "proj"); mkdirSync(proj);
  const data = mkdtempSync(join(tmpdir(), "hearth-mcp-data-"));
  const agentsFile = join(data, "agents.json");
  writeFileSync(agentsFile, JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const cfg = configFromEnv({
    HEARTH_PORT: "0", HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: agentsFile,
    HEARTH_IDENTITY: "header:x-user", HEARTH_PASSWORD: hashPassword(PW), HEARTH_MCP_TOKEN: TOKEN, HEARTH_MCP_USER: "mcp@example.com",
    HEARTH_QUEUE_CHECK_MS: "100",
  });
  h = new Hearth(cfg);
  const port = await h.listen();
  base = `http://127.0.0.1:${port}`;
  h.cfg.allowedOrigins.splice(0, Infinity, base);
});
after(async () => { await h?.close(); });

const cookies = {};
async function api(user, method, path, body, extra = {}) {
  const headers = { "x-user": user, origin: base, "x-hearth-csrf": "1", "content-type": "application/json", ...(cookies[user] ? { cookie: cookies[user] } : {}), ...extra };
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookies[user] = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function rpc(method, params, opt = {}) {
  const headers = { "content-type": "application/json", accept: opt.accept ?? "application/json, text/event-stream", ...(opt.headers ?? {}) };
  if (opt.token !== null) headers.authorization = `Bearer ${opt.token ?? TOKEN}`;
  const body = JSON.stringify({ jsonrpc: "2.0", ...(opt.notification ? {} : { id: opt.id ?? 1 }), method, ...(params ? { params } : {}) });
  const r = await fetch(base + (opt.path ?? "/mcp"), { method: opt.http ?? "POST", headers, body: opt.http === "GET" ? undefined : (opt.rawBody ?? body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* sse or empty */ }
  return { status: r.status, json, text, headers: r.headers };
}
function data(r) {
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json?.result?.isError, true, r.json?.result?.content?.[0]?.text);
  return r.json.result.structuredContent;
}
async function pollUntil(id, since, pred, ms = 12000) {
  const t = Date.now(); let cursor = since; const events = []; let last;
  while (Date.now() - t < ms) {
    last = data(await rpc("tools/call", { name: "poll_events", arguments: { sessionId: id, since: cursor } }));
    events.push(...last.events);
    cursor = last.cursor;
    const view = { ...last, events };
    if (pred(view)) return view;
    if (!last.hasMore) await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timeout " + JSON.stringify({ awaiting: last?.awaiting, events }));
}

test("MCP stays off without a usable token, and a bad token is not the web UI login", async () => {
  const offDir = mkdtempSync(join(tmpdir(), "hearth-mcp-off-"));
  const off = new Hearth(configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: offDir, HEARTH_ROOTS: offDir, HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  const port = await off.listen();
  off.cfg.allowedOrigins.splice(0, Infinity, `http://127.0.0.1:${port}`);
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /HEARTH_MCP_TOKEN/);
  await off.close();

  const bad = new Hearth(configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: mkdtempSync(join(tmpdir(), "hearth-mcp-short-")), HEARTH_ROOTS: offDir, HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off", HEARTH_MCP_TOKEN: "too-short" }));
  const p2 = await bad.listen();
  bad.cfg.allowedOrigins.splice(0, Infinity, `http://127.0.0.1:${p2}`);
  const r2 = await fetch(`http://127.0.0.1:${p2}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer too-short" }, body: "{}" });
  assert.equal(r2.status, 503);
  await bad.close();
});

test("bearer auth, alternate header, and rejections", async () => {
  const no = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } }, { token: null });
  assert.equal(no.status, 401);
  assert.match(no.headers.get("www-authenticate") ?? "", /Bearer/);
  const wrong = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} }, { token: OTHER });
  assert.equal(wrong.status, 401);
  const mismatch = await rpc("ping", {}, { headers: { "x-hearth-mcp-token": OTHER } });
  assert.equal(mismatch.status, 401);
  const q = await fetch(base + "/mcp?token=" + TOKEN, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(q.status, 400);
  assert.match(await q.text(), /query string/);
  const header = await fetch(base + "/mcp", { method: "POST", headers: { "x-hearth-mcp-token": TOKEN, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(header.status, 200);
  assert.deepEqual((await header.json()).result, {});
  const evil = await rpc("ping", {}, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const host = await new Promise((res) => request(base + "/mcp", { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } }, (r) => { r.resume(); res(r.statusCode); }).end("{}"));
  assert.equal(host, 421);
  const get = await rpc("ping", {}, { http: "GET" });
  assert.equal(get.status, 405);
  const badJson = await rpc("ping", {}, { rawBody: "{" });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, -32700);
  // The bearer does not authenticate the web UI, and the UI stays behind its own checks.
  assert.equal((await api("", "GET", "/api/sessions", null, { authorization: `Bearer ${TOKEN}`, "x-user": "" })).status, 401);
  assert.equal((await api("alice@example.com", "GET", "/api/sessions")).status, 423);
  assert.equal((await api("alice@example.com", "POST", "/api/sessions", {}, { "x-hearth-csrf": "" })).status, 403);
});

test("initialize, discover, tools/list, and one-event SSE", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.name, "hearth");
  assert.equal(init.json.result.resultType, undefined);
  assert.match(init.json.result.instructions, /poll_events/);
  const down = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
  assert.equal(down.json.result.protocolVersion, "2025-11-25");
  const note = await rpc("notifications/initialized", {}, { notification: true });
  assert.equal(note.status, 202);
  assert.equal(note.text, "");
  const list = await rpc("tools/list");
  assert.ok(list.json.result.tools.some((t) => t.name === "send_prompt" && /poll_events/.test(t.description)));
  assert.ok(list.json.result.tools.some((t) => t.name === "poll_events"));
  const discover = await rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }, { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" } });
  assert.equal(discover.status, 200);
  assert.ok(discover.json.result.supportedVersions.includes("2026-07-28"));
  assert.ok(discover.json.result.supportedVersions.includes("2025-11-25"));
  assert.equal(discover.json.result.resultType, "complete");
  assert.equal(discover.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "hearth");
  const modernList = await rpc("tools/list", {}, { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" } });
  assert.equal(modernList.json.result.resultType, "complete");
  const mismatch = await rpc("tools/call", { name: "list_agents", arguments: {} }, { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", "mcp-name": "list_agents" } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, -32020);
  const old = await rpc("tools/list", {}, { headers: { "mcp-protocol-version": "1999-01-01" } });
  assert.equal(old.status, 400);
  assert.equal(old.json.error.code, -32022);
  const sse = await rpc("ping", {}, { accept: "text/event-stream" });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const line = sse.text.split("\n").find((l) => l.startsWith("data: "));
  assert.deepEqual(JSON.parse(line.slice(6)).result, {});
});

test("list agents matches the UI catalog, without filesystem paths", async () => {
  assert.equal((await api("alice@example.com", "POST", "/api/unlock", { password: PW })).status, 200);
  const ui = (await api("alice@example.com", "GET", "/api/agents")).json.filter((a) => !a.hidden);
  const mcp = data(await rpc("tools/call", { name: "list_agents" }));
  assert.deepEqual(mcp.agents.map((a) => a.id), ui.map((a) => a.id));
  const mock = mcp.agents.find((a) => a.id === "mock");
  assert.equal(mock.installed, true);
  assert.equal(mock.path, undefined);
  assert.ok(mcp.roots.includes(root));
});

test("sessions stay with the MCP user, and send_prompt returns before the agent finishes", async () => {
  const alice = await api("alice@example.com", "POST", "/api/sessions", { agentId: "mock", cwd: proj, title: "Alice" });
  assert.equal(alice.status, 201);
  const listed = data(await rpc("tools/call", { name: "list_sessions" }));
  assert.equal(listed.sessions.some((s) => s.id === alice.json.id), false);
  assert.equal((await rpc("tools/call", { name: "get_session", arguments: { sessionId: alice.json.id } })).json.result.isError, true);

  const outside = await rpc("tools/call", { name: "create_session", arguments: { agentId: "mock", cwd: "/etc" } });
  assert.equal(outside.json.result.isError, true);
  const created = data(await rpc("tools/call", { name: "create_session", arguments: { agentId: "mock", cwd: proj, title: "From MCP" } }));
  const id = created.session.id;
  assert.equal(created.session.title, "From MCP");
  assert.equal(created.session.agentId, "mock");
  const aliceList = (await api("alice@example.com", "GET", "/api/sessions")).json;
  assert.equal(aliceList.some((s) => s.id === id), false);

  const t0 = Date.now();
  const sent = data(await rpc("tools/call", { name: "send_prompt", arguments: { sessionId: id, text: "slow please" } }));
  assert.ok(Date.now() - t0 < 2000, `send_prompt blocked for ${Date.now() - t0}ms`);
  assert.equal(sent.accepted, true);
  assert.equal(sent.queued, false);
  assert.equal(sent.session.busy, true);
  const early = data(await rpc("tools/call", { name: "poll_events", arguments: { sessionId: id, since: sent.cursor } }));
  assert.equal(early.events.some((e) => e.kind === "done"), false);

  const queued = data(await rpc("tools/call", { name: "send_prompt", arguments: { sessionId: id, text: "afterwards please" } }));
  assert.equal(queued.queued, true);
  assert.ok(queued.session.queued >= 1);
  // The mock clears a cancel that arrives before prompt() starts, so wait until that turn is actually running.
  await pollUntil(id, sent.cursor, (v) => v.events.some((e) => e.kind === "user"));
  await new Promise((r) => setTimeout(r, 400));
  assert.notEqual((await rpc("tools/call", { name: "cancel_prompt", arguments: { sessionId: id } })).json.result.isError, true);
  await pollUntil(id, sent.cursor, (v) => !v.busy && v.events.some((e) => e.stopReason === "cancelled"));
  await rpc("tools/call", { name: "close_session", arguments: { sessionId: id } });
});

test("poll reads the reply, permissions can be answered, rename and close work", async () => {
  const created = data(await rpc("tools/call", { name: "create_session", arguments: { agentId: "mock", cwd: proj } }));
  const id = created.session.id;
  const sent = data(await rpc("tools/call", { name: "send_prompt", arguments: { sessionId: id, text: "say hi" } }));
  const done = await pollUntil(id, sent.cursor, (v) => !v.busy);
  assert.match(done.events.filter((e) => e.kind === "assistant").map((e) => e.text).join(""), /Hello/);
  assert.ok(done.events.some((e) => e.stopReason === "end_turn"));
  const got = data(await rpc("tools/call", { name: "get_session", arguments: { sessionId: id } }));
  assert.match(got.recent.filter((e) => e.kind === "assistant").map((e) => e.text).join(""), /Hello/);
  const renamed = data(await rpc("tools/call", { name: "rename_session", arguments: { sessionId: id, title: "Renamed over MCP" } }));
  assert.equal(renamed.session.title, "Renamed over MCP");
  assert.equal(data(await rpc("tools/call", { name: "resume_queue", arguments: { sessionId: id } })).ok, true);

  const perm = data(await rpc("tools/call", { name: "create_session", arguments: { agentId: "mock", cwd: proj } }));
  const pid = perm.session.id;
  const ask = data(await rpc("tools/call", { name: "send_prompt", arguments: { sessionId: pid, text: "write a file" } }));
  const waiting = await pollUntil(pid, ask.cursor, (v) => v.pendingPermissions.length > 0);
  const reqp = waiting.pendingPermissions[0];
  assert.equal(reqp.title, "Write hello.txt");
  assert.ok(reqp.options.some((o) => o.optionId === "allow"));
  const answered = data(await rpc("tools/call", { name: "answer_permission", arguments: { sessionId: pid, permissionId: reqp.id, optionId: "allow" } }));
  assert.equal(answered.session.pendingPermissions.length, 0);
  await pollUntil(pid, waiting.cursor, (v) => !v.busy);
  assert.equal(readFileSync(join(proj, "hello.txt"), "utf8"), "hello\n");
  const stale = await rpc("tools/call", { name: "answer_permission", arguments: { sessionId: pid, permissionId: reqp.id, optionId: "allow" } });
  assert.equal(stale.json.result.isError, true);

  assert.equal(data(await rpc("tools/call", { name: "close_session", arguments: { sessionId: pid, purge: true } })).purged, true);
  assert.equal((await rpc("tools/call", { name: "get_session", arguments: { sessionId: pid } })).json.result.isError, true);
  assert.equal(existsSync(join(h.store.dir("mcp@example.com", pid), "meta.json")), false);
  await rpc("tools/call", { name: "close_session", arguments: { sessionId: id } });
  const open = data(await rpc("tools/call", { name: "list_sessions" }));
  assert.equal(open.sessions.some((s) => s.id === id), false);
  const ended = data(await rpc("tools/call", { name: "list_sessions", arguments: { includeEnded: true } }));
  assert.equal(ended.sessions.some((s) => s.id === id && s.state === "exited"), true);
});
