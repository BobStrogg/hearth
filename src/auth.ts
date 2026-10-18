import { execFile, spawn } from "node:child_process";
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
  allowedUsers?: string[];   // optional allow-list of identities
  password: string;          // "off" | "os" | "scrypt:<saltHex>:<hashHex>"
  unlockTtlHours: number;
  allowedOrigins: string[];
  dataDir: string;
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
    if (who && this.cfg.allowedUsers?.length && !this.cfg.allowedUsers.includes(who)) return null;
    return who;
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

/** Check the OS account password of the user running the daemon (macOS: dscl; Linux: pamtester). */
export function osPasswordOk(user: string, pw: string): Promise<boolean> {
  return new Promise((res) => {
    if (process.platform === "darwin") {
      execFile("/usr/bin/dscl", [".", "-authonly", user, pw], { timeout: 10000 }, (err) => res(!err));
    } else if (which("pamtester")) {
      const c = spawn("pamtester", [process.env.HEARTH_PAM_SERVICE ?? "login", user, "authenticate"], { stdio: ["pipe", "ignore", "ignore"] });
      c.stdin.end(pw + "\n");
      c.on("exit", (code) => res(code === 0));
      c.on("error", () => res(false));
    } else res(false);
  });
}
