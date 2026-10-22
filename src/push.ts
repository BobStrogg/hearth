import { createECDH, createCipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8188 / RFC 8291), using only
 * node:crypto. Browsers subscribe with the server's VAPID public key; Hearth then POSTs encrypted notifications to the
 * push service (Google, Mozilla, Apple, Microsoft), which delivers them to the device even when no tab is open.
 */
export interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPrefs { done: boolean; perm: boolean }
export interface StoredSub extends PushSubscriptionJSON { prefs: PushPrefs; created: string; label?: string }
export interface PushPayload { title: string; body?: string; url?: string; tag?: string }

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** Push-service hosts Hearth will POST to (suffix match). Extend with HEARTH_PUSH_HOSTS. */
export const DEFAULT_PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function endpointOk(endpoint: string, hosts: string[]): boolean {
  let u: URL; try { u = new URL(endpoint); } catch { return false; }
  const h = u.hostname.toLowerCase();
  const allowed = hosts.some((x) => h === x || h.endsWith("." + x));
  if (!allowed) return false;
  if (u.protocol === "https:") return true;
  // plain http only for loopback hosts that were listed explicitly (tests / local push servers)
  return u.protocol === "http:" && (h === "127.0.0.1" || h === "localhost") && hosts.includes(h);
}

export class Vapid {
  readonly publicKey: string; // base64url, uncompressed P-256 point (65 bytes): what PushManager.subscribe wants
  private key: KeyObject;
  constructor(file: string) {
    let j: { publicKey: string; privateKey: string } | null = null;
    try { j = JSON.parse(readFileSync(file, "utf8")); } catch { /* new */ }
    if (!j?.publicKey || !j?.privateKey) {
      const ec = createECDH("prime256v1"); ec.generateKeys();
      j = { publicKey: b64u(ec.getPublicKey()), privateKey: b64u(ec.getPrivateKey()) };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file + ".tmp", JSON.stringify(j), { mode: 0o600 }); renameSync(file + ".tmp", file);
    }
    this.publicKey = j.publicKey;
    const pub = unb64u(j.publicKey);
    this.key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: j.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  }
  /** `Authorization: vapid t=<jwt>, k=<key>` for one push-service origin. */
  header(endpoint: string, subject: string, now = Date.now()): string {
    const aud = new URL(endpoint).origin;
    const h = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const c = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
    const sig = sign("sha256", Buffer.from(`${h}.${c}`), { key: this.key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${h}.${c}.${b64u(sig)}, k=${this.publicKey}`;
  }
  publicKeyObject(): KeyObject { return createPublicKey(this.key); }
}

/** RFC 8291 aes128gcm body for one subscription (single record). `salt`/`ephemeral` are injectable for tests. */
export function encrypt(payload: Buffer, sub: PushSubscriptionJSON, opts: { salt?: Buffer; ephemeral?: ReturnType<typeof createECDH> } = {}): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh key");
  if (authSecret.length < 16) throw new Error("bad auth secret");
  const as = opts.ephemeral ?? (() => { const e = createECDH("prime256v1"); e.generateKeys(); return e; })();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Per-user subscription file: <user dir>/push.json */
export class PushStore {
  constructor(private file: (owner: string) => string) {}
  list(owner: string): StoredSub[] { try { const j = JSON.parse(readFileSync(this.file(owner), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } }
  private write(owner: string, subs: StoredSub[]) {
    const f = this.file(owner); mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f + ".tmp", JSON.stringify(subs, null, 1), { mode: 0o600 }); renameSync(f + ".tmp", f);
  }
  upsert(owner: string, s: StoredSub) {
    const subs = this.list(owner).filter((x) => x.endpoint !== s.endpoint);
    subs.unshift(s); this.write(owner, subs.slice(0, 10));
  }
  remove(owner: string, endpoint: string): boolean {
    const subs = this.list(owner); const n = subs.filter((x) => x.endpoint !== endpoint);
    if (n.length === subs.length) return false; this.write(owner, n); return true;
  }
}

export function validSubscription(x: unknown): x is PushSubscriptionJSON {
  const s = x as PushSubscriptionJSON;
  return !!s && typeof s.endpoint === "string" && s.endpoint.length < 2048 && !!s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string"
    && /^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh) && /^[A-Za-z0-9_-]{16,44}$/.test(s.keys.auth);
}

export class Push {
  readonly vapid: Vapid; readonly store: PushStore;
  constructor(dataDir: string, userDir: (owner: string) => string, readonly subject: string, readonly hosts: string[]) {
    this.vapid = new Vapid(join(dataDir, "vapid.json"));
    this.store = new PushStore((o) => join(userDir(o), "push.json"));
  }
  /** Send to one subscription. Returns the push service status (0 = network error). Gone subscriptions are removed. */
  async sendOne(owner: string, s: StoredSub, p: PushPayload, topic?: string): Promise<number> {
    if (!endpointOk(s.endpoint, this.hosts)) return -1;
    const body = encrypt(Buffer.from(JSON.stringify(p)), s);
    const headers: Record<string, string> = { authorization: this.vapid.header(s.endpoint, this.subject), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" };
    if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.topic = topic;
    try {
      const r = await fetch(s.endpoint, { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000) });
      if (r.status === 404 || r.status === 410) this.store.remove(owner, s.endpoint);
      return r.status;
    } catch { return 0; }
  }
  /** Send to all of a user's devices that want this kind of notification. */
  async notify(owner: string, kind: keyof PushPrefs, p: PushPayload, topic?: string): Promise<number[]> {
    const subs = this.store.list(owner).filter((s) => s.prefs?.[kind] !== false);
    return Promise.all(subs.map((s) => this.sendOne(owner, s, p, topic)));
  }
}

/** Keeps the tail of the agent's reply in the current turn (for the notification text). */
export function replyTail(prev: string, add: string, max = 400): string { const s = prev + add; return s.length > max ? s.slice(-max) : s; }
export function snippet(s: string, max = 140): string {
  const t = s.replace(/```[\s\S]*?```/g, " [code] ").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? "…" + t.slice(-max + 1) : t;
}
