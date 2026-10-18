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
