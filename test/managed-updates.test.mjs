// HEARTH_UPDATES_URL: updates managed elsewhere -> no release check, no self-update, the UI links there.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hearth, configFromEnv, updatesUrl } from "../dist/server.js";
import { writeEnvFile } from "../dist/platform.js";
import { readFileSync } from "node:fs";

test("updatesUrl accepts only http(s)", () => {
  assert.equal(updatesUrl("https://dash.example/"), "https://dash.example/");
  assert.equal(updatesUrl("javascript:alert(1)"), undefined); assert.equal(updatesUrl(""), undefined); assert.equal(updatesUrl(undefined), undefined);
});

test("managed install: /api/version says managed and never calls GitHub; /api/update refused; auto-update off", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hearth-mu-"));
  let gh = 0; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes("/releases/latest")) { gh++; throw new Error("no GitHub in this test"); } return realFetch(u, o); };
  const cfg = configFromEnv({ HEARTH_PORT: "0", HEARTH_DATA_DIR: dataDir, HEARTH_ROOTS: dataDir, HEARTH_IDENTITY: "header:x-user", HEARTH_PASSWORD: "off",
    HEARTH_AUTO_UPDATE: "on", HEARTH_UPDATES_URL: "https://dash.example/" });
  assert.equal(cfg.autoUpdate, false);
  const h = new Hearth(cfg); const port = await h.listen(); const base = `http://127.0.0.1:${port}`; h.cfg.allowedOrigins.splice(0, Infinity, base);
  try {
    const H = { "x-user": "u@example.com", origin: base, "x-hearth-csrf": "1", "content-type": "application/json" };
    const v = await (await realFetch(`${base}/api/version?check=1`, { headers: H })).json();
    assert.equal(v.managed, "https://dash.example/"); assert.equal(v.updateAvailable, false); assert.equal(v.canApply, false); assert.equal(gh, 0);
    const r = await realFetch(`${base}/api/update`, { method: "POST", headers: H, body: "{}" });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /managed at https:\/\/dash\.example\//);
  } finally { await h.close(); globalThis.fetch = realFetch; }
});

test("service install persists --updates-url in the env file (new and existing files)", () => {
  const f = join(mkdtempSync(join(tmpdir(), "hearth-env-")), "hearth.env");
  writeEnvFile(f, {}, { updatesUrl: "https://a.example/" }, "darwin", "/Users/x");
  assert.match(readFileSync(f, "utf8"), /^HEARTH_UPDATES_URL=https:\/\/a\.example\/$/m);
  const w = writeEnvFile(f, { updatesUrl: "https://b.example/" }, {}, "darwin", "/Users/x");
  assert.deepEqual(w.changed, ["HEARTH_UPDATES_URL"]); assert.match(readFileSync(f, "utf8"), /^HEARTH_UPDATES_URL=https:\/\/b\.example\/$/m);
});
