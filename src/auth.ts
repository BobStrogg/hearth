import { spawn } from "node:child_process";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { osUser, which } from "./agents.js";

export interface AuthConfig {
  identity: string;          // "single:<name>" | "header:<header-name>" | "cloudflare"
  cfTeamDomain?: string;     // e.g. https://myteam.cloudflareaccess.com
  cfAud?: string;            // Access application AUD tag
  allowedUsers?: string[];   // optional allow-list of identities (checked after aliasing)
  userAliases?: Record<string, string>; // alias identity -> canonical identity (lower-case)
  password: string;          // "off" | "os" | "scrypt:<saltHex>:<hashHex>"
  unlockTtlHours: number;
  allowedOrigins: string[];
  dataDir: string;
}

/**
 * Parse HEARTH_USER_ALIASES: comma/semicolon/newline-separated `alias=canonical` pairs, e.g.
 * `me@gmail.com=me@work.example, me@users.noreply.github.com=me@work.example`.
 * Case-insensitive; one hop only (no chaining); malformed entries and self-maps are ignored.
 */
export function parseUserAliases(v?: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const part of (v ?? "").split(/[,;\n]/)) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const from = part.slice(0, i).trim().toLowerCase(), to = part.slice(i + 1).trim().toLowerCase();
    if (from && to && from !== to) out[from] = to;
  }
  return out;
}

/** Map an identity to its canonical form (one hop). */
export function canonicalUser(who: string, aliases?: Record<string, string>): string {
  const k = who.trim().toLowerCase();
  return aliases && Object.prototype.hasOwnProperty.call(aliases, k) ? aliases[k] : k;
}

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 32).toString("hex")}`;
}

export class Auth {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private key: Buffer;
  private failures = new Map<string, { n: number; until: number }>();

  constructor(readonly cfg: AuthConfig) {
    const kp = join(cfg.dataDir, "cookie.key");
    if (!existsSync(kp)) writeFileSync(kp, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.key = Buffer.from(readFileSync(kp, "utf8").trim(), "hex");
    if (cfg.identity === "cloudflare") {
      if (!cfg.cfTeamDomain || !cfg.cfAud) throw new Error("cloudflare identity needs HEARTH_CF_TEAM_DOMAIN and HEARTH_CF_AUD");
      this.jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", cfg.cfTeamDomain));
    }
  }

  /** Resolve the caller's identity, or null if unauthenticated. */
  async identify(req: IncomingMessage): Promise<string | null> {
    const id = this.cfg.identity;
    let who: string | null = null;
    if (id.startsWith("single:")) who = id.slice(7) || osUser();
    else if (id.startsWith("header:")) {
      const v = req.headers[id.slice(7).toLowerCase()];
      who = typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
    } else if (id === "cloudflare") {
      const tok = req.headers["cf-access-jwt-assertion"];
      if (typeof tok !== "string") return null;
      try {
        const { payload } = await jwtVerify(tok, this.jwks!, { issuer: this.cfg.cfTeamDomain!.replace(/\/$/, ""), audience: this.cfg.cfAud });
        who = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
      } catch { return null; }
    }
    if (!who) return null;
    const canon = canonicalUser(who, this.cfg.userAliases);
    // The allow-list may name either the canonical identity or the alias itself.
    if (this.cfg.allowedUsers?.length && !this.cfg.allowedUsers.includes(canon) && !this.cfg.allowedUsers.includes(who)) return null;
    return canon;
  }

  // ---- Origin / Host / CSRF ----
  originOk(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    return typeof o === "string" && this.cfg.allowedOrigins.includes(o);
  }
  hostOk(req: IncomingMessage): boolean {
    const h = req.headers.host;
    return typeof h === "string" && this.cfg.allowedOrigins.some((o) => new URL(o).host === h);
  }
  csrfOk(req: IncomingMessage): boolean {
    return req.headers["x-hearth-csrf"] === "1" && this.originOk(req);
  }

  // ---- password unlock (signed cookie bound to identity) ----
  get needsPassword() { return this.cfg.password !== "off"; }

  private sign(s: string) { return createHmac("sha256", this.key).update(s).digest("base64url"); }

  makeCookie(who: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: who, exp: Date.now() + this.cfg.unlockTtlHours * 3600e3 })).toString("base64url");
    return `hearth_unlock=${payload}.${this.sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${this.cfg.unlockTtlHours * 3600}`;
  }

  unlocked(req: IncomingMessage, who: string): boolean {
    if (!this.needsPassword) return true;
    const m = /(?:^|;\s*)hearth_unlock=([^;]+)/.exec(req.headers.cookie ?? "");
    if (!m) return false;
    const [payload, sig] = m[1].split(".");
    if (!payload || !sig) return false;
    const exp = Buffer.from(this.sign(payload)); const got = Buffer.from(sig);
    if (exp.length !== got.length || !timingSafeEqual(exp, got)) return false;
    try { const p = JSON.parse(Buffer.from(payload, "base64url").toString()); return p.sub === who && p.exp > Date.now(); } catch { return false; }
  }

  async checkPassword(who: string, pw: string): Promise<boolean> {
    const f = this.failures.get(who);
    if (f && f.until > Date.now()) return false;
    const ok = await this.verify(pw);
    if (ok) this.failures.delete(who);
    else { const n = (f?.n ?? 0) + 1; this.failures.set(who, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 }); }
    return ok;
  }

  private async verify(pw: string): Promise<boolean> {
    const p = this.cfg.password;
    if (p.startsWith("scrypt:")) {
      const [, salt, hash] = p.split(":");
      const got = scryptSync(pw, Buffer.from(salt, "hex"), 32);
      return timingSafeEqual(got, Buffer.from(hash, "hex"));
    }
    if (p === "os") return osPasswordOk(osUser(), pw);
    return false;
  }
}

/** Escape a token for dscl's interactive command parser (backslash-escapes whitespace, quotes and backslashes). */
export function dsclEscape(s: string) { return s.replace(/[\\\s"']/g, (c) => "\\" + c); }

/**
 * Check the OS account password of the user running the daemon. The password never appears in argv:
 * macOS runs `dscl .` in interactive mode and writes `authonly <user> <password>` to its stdin;
 * Linux pipes the password to `pamtester` on stdin. Fails closed on any error output.
 */
export function osPasswordOk(user: string, pw: string, platform: string = process.platform): Promise<boolean> {
  if (/[\r\n\0]/.test(pw) || !pw) return Promise.resolve(false);
  return new Promise((res) => {
    let cmd: string, args: string[], input: string;
    if (platform === "darwin") {
      cmd = process.env.HEARTH_DSCL ?? "/usr/bin/dscl"; args = ["."];
      input = `authonly ${dsclEscape(user)} ${dsclEscape(pw)}\nquit\n`;
    } else if (process.env.HEARTH_PAMTESTER || which("pamtester")) {
      cmd = process.env.HEARTH_PAMTESTER ?? "pamtester"; args = [process.env.HEARTH_PAM_SERVICE ?? "login", user, "authenticate"]; input = pw + "\n";
    } else return res(false);
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => { c.kill("SIGKILL"); }, 10000);
    c.on("error", () => { clearTimeout(t); res(false); });
    c.on("exit", (code) => {
      clearTimeout(t);
      if (code !== 0) return res(false);
      // dscl reports failures as "DS Error: ... (eDSAuthFailed)" with exit 0 in interactive mode.
      res(platform === "darwin" ? !/error|fail|invalid|unknown|not found/i.test(out) : true);
    });
    c.stdin.end(input);
  });
}
