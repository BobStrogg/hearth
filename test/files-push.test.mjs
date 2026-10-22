import { strict as assert } from "node:assert";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";
import { encrypt, endpointOk, Vapid, snippet, DEFAULT_PUSH_HOSTS } from "../dist/push.js";
import { validName } from "../dist/files.js";

const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const b64u = (b) => Buffer.from(b).toString("base64url");

/** Browser side of RFC 8291: a subscription key pair, and decrypting what the push service delivers. */
function fakeBrowser() {
  const ec = createECDH("prime256v1"); ec.generateKeys(); const auth = randomBytes(16);
  return {
    keys: { p256dh: b64u(ec.getPublicKey()), auth: b64u(auth) },
    decrypt(body) {
      const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const secret = ec.computeSecret(asPub);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ec.getPublicKey(), asPub]), 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
      const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(pt.at(-1), 2, "last-record delimiter");
      return JSON.parse(pt.subarray(0, pt.length - 1).toString());
    },
  };
}

test("push crypto: aes128gcm round trip and a verifiable VAPID ES256 token", () => {
  const br = fakeBrowser();
  const body = encrypt(Buffer.from(JSON.stringify({ title: "t", body: "héllo" })), { endpoint: "https://x", keys: br.keys });
  assert.equal(body.readUInt32BE(16), 4096); assert.equal(body[20], 65);
  assert.deepEqual(br.decrypt(body), { title: "t", body: "héllo" });
  const dir = mkdtempSync(join(tmpdir(), "hearth-vapid-"));
  const v = new Vapid(join(dir, "vapid.json")); const v2 = new Vapid(join(dir, "vapid.json"));
  assert.equal(v.publicKey, v2.publicKey, "keys persist"); assert.equal((readFileSync(join(dir, "vapid.json")).length > 0), true);
  const hdr = v.header("https://fcm.googleapis.com/fcm/send/abc", "https://example.com");
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(hdr); assert.equal(k, v.publicKey);
  const [h, c, s] = t.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url")); assert.equal(claims.aud, "https://fcm.googleapis.com"); assert.equal(claims.sub, "https://example.com"); assert.ok(claims.exp > Date.now() / 1000);
  const pub = Buffer.from(v.publicKey, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.ok(endpointOk("https://fcm.googleapis.com/fcm/send/x", DEFAULT_PUSH_HOSTS));
  assert.ok(endpointOk("https://web.push.apple.com/abc", DEFAULT_PUSH_HOSTS));
  assert.ok(!endpointOk("https://evil.example/fcm.googleapis.com", DEFAULT_PUSH_HOSTS));
  assert.ok(!endpointOk("https://fcm.googleapis.com.evil.example/", DEFAULT_PUSH_HOSTS));
  assert.ok(!endpointOk("http://fcm.googleapis.com/x", DEFAULT_PUSH_HOSTS));
  assert.ok(!endpointOk("http://127.0.0.1:9/x", DEFAULT_PUSH_HOSTS));
  assert.ok(endpointOk("http://127.0.0.1:9/x", [...DEFAULT_PUSH_HOSTS, "127.0.0.1"]));
  assert.equal(snippet("x".repeat(10) + " ```js\ncode\n``` done **ok**", 200), "xxxxxxxxxx [code] done ok");
  assert.ok(validName("a.txt") && !validName("..") && !validName("a/b") && !validName("") && !validName("x.hearth-upload-1"));
});

// ---- server: files + push over HTTP/WS ----
let h, base, origin, home, outside, dataDir, pushSrv, pushPort; const got = [];
let pushStatus = 201;
before(async () => {
  home = mkdtempSync(join(tmpdir(), "hearth-home-")); outside = mkdtempSync(join(tmpdir(), "hearth-outside-"));
  dataDir = mkdtempSync(join(tmpdir(), "hearth-data-"));
  mkdirSync(join(home, "proj")); mkdirSync(join(home, "docs")); writeFileSync(join(home, "docs", "a.txt"), "alpha"); writeFileSync(join(home, ".secret"), "hidden");
  writeFileSync(join(outside, "x.txt"), "outside!"); symlinkSync(outside, join(home, "escape")); symlinkSync(join(home, "docs"), join(home, "docslink"));
  pushSrv = createServer((q, s) => { const ch = []; q.on("data", (c) => ch.push(c)); q.on("end", () => { got.push({ url: q.url, headers: q.headers, body: Buffer.concat(ch) }); s.writeHead(pushStatus); s.end(); }); });
  await new Promise((r) => pushSrv.listen(0, "127.0.0.1", r)); pushPort = pushSrv.address().port;
  const agentsFile = join(dataDir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const cfg = configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: home, HEARTH_AGENTS_FILE: agentsFile, HEARTH_IDENTITY: "header:x-user", HEARTH_PASSWORD: "off",
    HEARTH_FILES_ROOT: home, HEARTH_PUSH_HOSTS: "127.0.0.1", HEARTH_PUSH_SUBJECT: "mailto:admin@example.com" });
  h = new Hearth(cfg); const port = await h.listen();
  base = `http://127.0.0.1:${port}`; origin = base; h.cfg.allowedOrigins.splice(0, Infinity, origin);
});
after(async () => { await h.close(); pushSrv.close(); });
const hdrs = (user = "alice@example.com", extra = {}) => ({ "x-user": user, origin, "x-hearth-csrf": "1", "content-type": "application/json", ...extra });
async function api(method, path, body, user, extra) {
  const r = await fetch(base + path, { method, headers: hdrs(user, extra), body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, json: ct.includes("json") ? await r.json() : null, text: ct.includes("json") ? null : await r.text() };
}

test("files: list (hidden toggle), download headers, traversal and symlink escapes blocked", async () => {
  const me = await api("GET", "/api/me"); assert.equal(me.json.files, true); assert.equal(me.json.push, true);
  let r = await api("GET", "/api/files?path="); assert.equal(r.status, 200);
  assert.deepEqual(r.json.entries.filter((e) => e.dir).map((e) => e.name), ["docs", "docslink", "proj"], "symlinks that leave the root are not listed");
  assert.ok(!r.json.entries.some((e) => e.name === ".secret")); assert.equal(r.json.parent, null);
  r = await api("GET", "/api/files?path=&hidden=1"); assert.ok(r.json.entries.some((e) => e.name === ".secret"));
  r = await api("GET", "/api/files?path=docs"); assert.equal(r.json.path, "docs"); assert.equal(r.json.parent, ""); assert.equal(r.json.entries[0].size, 5);
  r = await api("GET", "/api/files/download?path=docs/a.txt"); assert.equal(r.status, 200); assert.equal(r.text, "alpha");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="a.txt"/); assert.equal(r.headers.get("content-type"), "application/octet-stream"); assert.match(r.headers.get("content-security-policy"), /sandbox/);
  for (const p of ["../", "..%2F..%2Fetc", "/etc/passwd", "docs/../../", "escape", "escape/x.txt", "docs/../escape/x.txt", `..${"/"}${outside.split("/").pop()}/x.txt`]) {
    const a = await api("GET", "/api/files?path=" + encodeURIComponent(p)), b = await api("GET", "/api/files/download?path=" + encodeURIComponent(p));
    assert.ok([403, 404, 400].includes(a.status) && a.status !== 200, `list ${p} -> ${a.status}`); assert.ok(b.status !== 200, `download ${p} -> ${b.status}`);
    assert.ok(!(b.text || "").includes("outside!"));
  }
  assert.equal((await api("GET", "/api/files?path=" + encodeURIComponent("/etc"))).status, 404, "absolute paths are relative to the root");
  assert.equal((await api("GET", "/api/files/download?path=docslink/a.txt")).text, "alpha", "symlinks inside the root work");
  assert.equal((await api("GET", "/api/files", undefined, "")).status, 401);
});

test("files: chunked upload with resume, overwrite guard, mkdir, CSRF", async () => {
  const up = (q, body, extra) => api("POST", "/api/files/upload?" + new URLSearchParams(q), body, undefined, { "content-type": "application/octet-stream", ...extra });
  const data = randomBytes(300_000);
  let r = await up({ path: "proj", name: "blob.bin", id: "abcdefgh12", offset: 0, total: data.length }, data.subarray(0, 100_000)); assert.equal(r.status, 200); assert.equal(r.json.received, 100_000);
  assert.ok(!(await api("GET", "/api/files?path=proj&hidden=1")).json.entries.some((e) => e.name.includes("hearth-upload")), "temp file hidden from listings");
  r = await up({ path: "proj", name: "blob.bin", id: "abcdefgh12", offset: 0, total: data.length }, data.subarray(0, 10)); assert.equal(r.status, 409); assert.equal(r.json.have, 100_000, "resume point");
  r = await up({ path: "proj", name: "blob.bin", id: "abcdefgh12", offset: 100_000, total: data.length }, data.subarray(100_000)); assert.equal(r.status, 201); assert.equal(r.json.done, true);
  assert.ok(readFileSync(join(home, "proj/blob.bin")).equals(data));
  assert.ok(!readdirSync(join(home, "proj")).some((n) => n.includes("hearth-upload")));
  r = await up({ path: "proj", name: "blob.bin", id: "zzzzzzzz12", offset: 0, total: 3 }, "abc"); assert.equal(r.status, 409); assert.equal(r.json.error, "exists");
  r = await up({ path: "proj", name: "blob.bin", id: "zzzzzzzz12", offset: 0, total: 3, overwrite: 1 }, "abc"); assert.equal(r.status, 201); assert.equal(readFileSync(join(home, "proj/blob.bin"), "utf8"), "abc");
  r = await up({ path: "proj", name: "empty", id: "emptyemp12", offset: 0, total: 0 }, ""); assert.equal(r.status, 201); assert.equal(readFileSync(join(home, "proj/empty"), "utf8"), "");
  r = await up({ path: "proj", name: "big", id: "bigbigbig1", offset: 0, total: 5 }, "123456789"); assert.equal(r.status, 413, "more than announced");
  for (const name of ["../evil", "a/b", "..", ".x.hearth-upload-1"]) assert.equal((await up({ path: "proj", name, id: "abcdefgh99", offset: 0, total: 1 }, "x")).status, 400, name);
  assert.equal((await up({ path: "escape", name: "pwn.txt", id: "abcdefgh98", offset: 0, total: 1 }, "x")).status, 403);
  assert.equal((await up({ path: "../", name: "pwn.txt", id: "abcdefgh97", offset: 0, total: 1 }, "x")).status, 403);
  assert.ok(!existsSync(join(outside, "pwn.txt")));
  assert.equal((await up({ path: "proj", name: "c.txt", id: "abcdefgh96", offset: 0, total: 1 }, "x", { "x-hearth-csrf": "" })).status, 403, "csrf");
  assert.equal((await up({ path: "proj", name: "c.txt", id: "abcdefgh96", offset: 0, total: 1 }, "x", { origin: "https://evil.example" })).status, 403, "origin");
  r = await api("POST", "/api/files/mkdir", { path: "proj", name: "new dir" }); assert.equal(r.status, 201); assert.equal(r.json.path, "proj/new dir");
  assert.equal((await api("POST", "/api/files/mkdir", { path: "proj", name: "new dir" })).status, 409);
  assert.equal((await api("POST", "/api/files/mkdir", { path: "proj", name: "../x" })).status, 400);
  assert.equal((await api("POST", "/api/files/mkdir", { path: "escape", name: "x" })).status, 403);
});

function ws(user, id) {
  const sock = new WebSocket(`${base.replace("http", "ws")}/ws?session=${id}&since=0`, { headers: { "x-user": user, origin } });
  const msgs = []; sock.on("message", (d) => msgs.push(JSON.parse(String(d))));
  sock.until = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const f = msgs.find(pred); if (f) return f; if (Date.now() - t0 > ms) throw new Error("timeout: " + JSON.stringify(msgs.map((m) => m.type))); await new Promise((r) => setTimeout(r, 20)); } };
  sock.msgs = msgs;
  return new Promise((res, rej) => { sock.on("open", () => res(sock)); sock.on("error", rej); });
}
const waitPush = async (n, ms = 5000) => { const t0 = Date.now(); while (got.length < n) { if (Date.now() - t0 > ms) throw new Error(`expected ${n} pushes, got ${got.length}`); await new Promise((r) => setTimeout(r, 20)); } };

test("push: subscribe, finished + approval notifications, skipped while watching, gone subscriptions dropped", async () => {
  const br = fakeBrowser(); const endpoint = `http://127.0.0.1:${pushPort}/push/dev1`;
  const info = await api("GET", "/api/push"); assert.equal(info.json.enabled, true); assert.match(info.json.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://evil.example/x", keys: br.keys } })).status, 400, "unknown push service");
  assert.equal((await api("POST", "/api/push/subscribe", { subscription: { endpoint, keys: { p256dh: "x", auth: "y" } } })).status, 400);
  assert.equal((await api("POST", "/api/push/subscribe", { subscription: { endpoint, keys: br.keys }, prefs: { done: true, perm: true }, label: "Test · Browser" })).status, 200);
  assert.equal((await api("GET", "/api/push", undefined, "bob@example.com")).json.devices.length, 0, "per user");
  // test notification
  let r = await api("POST", "/api/push/test", { endpoint }); assert.equal(r.status, 200); await waitPush(1);
  assert.match(got[0].headers.authorization, /^vapid t=.+, k=/); assert.equal(got[0].headers["content-encoding"], "aes128gcm"); assert.equal(got[0].headers.ttl, "86400");
  assert.equal(br.decrypt(got[0].body).tag, "hearth-test");
  // a turn finishing while nobody is looking -> "done" with the reply's tail
  const c = await api("POST", "/api/sessions", { agentId: "mock", cwd: join(home, "proj"), title: "Parser" }); const sid = c.json.id;
  const s = await ws("alice@example.com", sid); await s.until((m) => m.type === "state" && m.state === "idle");
  s.send(JSON.stringify({ type: "visibility", visible: false }));
  s.send(JSON.stringify({ type: "prompt", text: "hi" })); await s.until((m) => m.type === "prompt_done"); await waitPush(2);
  let p = br.decrypt(got[1].body); assert.equal(p.title, "Parser: done"); assert.match(p.body, /Hello world!/); assert.equal(p.url, `./#/s/${sid}`); assert.equal(got[1].headers.topic, sid.replace(/-/g, ""));
  // permission request -> "needs your approval"
  s.send(JSON.stringify({ type: "prompt", text: "write" })); const perm = await s.until((m) => m.type === "permission"); await waitPush(3);
  p = br.decrypt(got[2].body); assert.equal(p.title, "Parser: needs your approval"); assert.equal(p.body, "Write hello.txt");
  // while the tab is visible: nothing is pushed
  s.send(JSON.stringify({ type: "visibility", visible: true })); await new Promise((r) => setTimeout(r, 50));
  s.send(JSON.stringify({ type: "permission", id: perm.id, optionId: "allow" }));
  await s.until((m) => m.type === "prompt_done" && s.msgs.filter((x) => x.type === "prompt_done").length === 2);
  await new Promise((r) => setTimeout(r, 300)); assert.equal(got.length, 3, "no push while watching");
  // user's own Stop: no push
  s.send(JSON.stringify({ type: "visibility", visible: false }));
  s.send(JSON.stringify({ type: "prompt", text: "slow" })); await new Promise((r) => setTimeout(r, 200)); s.send(JSON.stringify({ type: "cancel" }));
  await s.until((m) => m.type === "prompt_done" && m.stopReason === "cancelled"); await new Promise((r) => setTimeout(r, 300)); assert.equal(got.length, 3, "no push for your own Stop");
  // errors notify
  s.send(JSON.stringify({ type: "prompt", text: "explode" })); await waitPush(4); p = br.decrypt(got[3].body); assert.equal(p.title, "Parser: needs a look"); assert.match(p.body, /^Failed: .*exploded/);
  // prefs: perm off -> no approval push
  await api("POST", "/api/push/subscribe", { subscription: { endpoint, keys: br.keys }, prefs: { done: true, perm: false } });
  s.send(JSON.stringify({ type: "prompt", text: "write" })); const perm2 = await s.until((m) => m.type === "permission" && m.id !== perm.id);
  await new Promise((r) => setTimeout(r, 300)); assert.equal(got.length, 4, "approval pushes turned off");
  // gone (410) -> subscription removed
  pushStatus = 410; s.send(JSON.stringify({ type: "permission", id: perm2.id, optionId: "deny" }));
  await waitPush(5); await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api("GET", "/api/push")).json.devices.length, 0);
  pushStatus = 201; s.close();
  assert.equal((await api("POST", "/api/push/test", { endpoint })).status, 404);
});
