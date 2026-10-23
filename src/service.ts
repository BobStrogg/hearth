import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { searchPath, which } from "./agents.js";
import { dataDir, envFilePath } from "./platform.js";
import { selfCommand } from "./install-info.js";
import { ensureLauncher } from "./launcher.js";

export interface ServiceStatus { manager: string; installed: boolean; running: boolean; pid?: number; detail?: string; file?: string }
export interface InstallOpts { system?: boolean; user?: string; ensureLauncher?: () => { path: string | null; built: boolean; note?: string } }
export interface ServiceManager {
  readonly name: string;
  available(): boolean;
  install(o?: InstallOpts): string[];
  uninstall(): string[];
  start(): void;
  stop(): void;
  restart(): void;
  status(): ServiceStatus;
  logFile(): string;
}

export const LABEL = "io.github.hearth";
const run = (cmd: string, args: string[], quiet = true) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Environment baked into the service definition. */
function serviceEnv(manager: string, home: string): Record<string, string> {
  return { PATH: searchPath(), HEARTH_SERVICE: manager, HEARTH_ENV_FILE: envFilePath(), HOME: home };
}

/** macOS: a per-user LaunchAgent (default) or, with --system, a LaunchDaemon that runs as the given user at boot. */
export class Launchd implements ServiceManager {
  readonly name = "launchd";
  constructor(private system = existsSync(`/Library/LaunchDaemons/${LABEL}.plist`) && !existsSync(join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`))) {}
  available() { return process.platform === "darwin" && existsSync("/bin/launchctl"); }
  private plist() { return this.system ? `/Library/LaunchDaemons/${LABEL}.plist` : join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`); }
  private domain() { return this.system ? "system" : `gui/${process.getuid?.() ?? 501}`; }
  logFile() { return join(dataDir(), "hearth.log"); }
  install(o: InstallOpts = {}) {
    this.system = !!o.system;
    const notes: string[] = [];
    const user = o.user ?? process.env.SUDO_USER ?? userInfo().username;
    if (this.system && process.getuid?.() !== 0) throw new Error("--system needs root: run it with sudo");
    const env = serviceEnv(this.name, homedir());
    // Per-user LaunchAgent: run through the stable launcher, so macOS folder permissions survive Node.js and Hearth
    // updates (see launcher.ts). HEARTH_NO_LAUNCHER=1 runs Hearth directly.
    const l = !this.system && process.env.HEARTH_NO_LAUNCHER !== "1" ? (o.ensureLauncher ?? ensureLauncher)() : { path: null, built: false };
    if (l.path) notes.push(`Runs through ${l.path}${l.built ? " (just built)" : ""}: macOS folder permissions given to it last across Node.js and Hearth updates. If macOS asks about "hearth-launch", click Allow once.`);
    else if (l.note) notes.push(`Note: ${l.note}.`);
    const argv = [...(l.path ? [l.path] : []), ...selfCommand(), "serve"];
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>WorkingDirectory</key><string>${xml(homedir())}</string>
${this.system ? `<key>UserName</key><string>${xml(user)}</string>\n` : ""}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(this.logFile())}</string><key>StandardErrorPath</key><string>${xml(this.logFile())}</string>
</dict></plist>
`;
    const p = this.plist();
    const old = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (old && /run\.sh/.test(old)) notes.push("Migrated the old run.sh-based LaunchAgent to run Hearth directly (config and sessions unchanged).");
    mkdirSync(dirname(p), { recursive: true }); mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(p, body, { mode: 0o644 });
    run("launchctl", ["bootout", this.domain(), p]);
    const r = run("launchctl", ["bootstrap", this.domain(), p]);
    if (r.code !== 0) { run("launchctl", ["bootout", `${this.domain()}/${LABEL}`]); const r2 = run("launchctl", ["bootstrap", this.domain(), p]); if (r2.code !== 0) throw new Error(`launchctl bootstrap failed: ${r2.out.trim()}`); }
    notes.push(`Installed ${p}`);
    return notes;
  }
  uninstall() { const p = this.plist(); run("launchctl", ["bootout", this.domain(), p]); rmSync(p, { force: true }); return [`Removed ${p}`]; }
  start() { if (run("launchctl", ["print", `${this.domain()}/${LABEL}`]).code !== 0) run("launchctl", ["bootstrap", this.domain(), this.plist()]); else run("launchctl", ["kickstart", `${this.domain()}/${LABEL}`]); }
  stop() { run("launchctl", ["bootout", `${this.domain()}/${LABEL}`]); }
  restart() { const r = run("launchctl", ["kickstart", "-k", `${this.domain()}/${LABEL}`]); if (r.code !== 0) this.start(); }
  status(): ServiceStatus {
    const file = this.plist(); const installed = existsSync(file);
    const r = run("launchctl", ["print", `${this.domain()}/${LABEL}`]);
    const pid = Number(/\bpid = (\d+)/.exec(r.out)?.[1]) || undefined;
    return { manager: this.system ? "launchd (LaunchDaemon)" : "launchd (LaunchAgent)", installed, running: r.code === 0 && /state = running/.test(r.out), pid, file,
      detail: installed && /run\.sh/.test(readFileSync(file, "utf8")) ? "old run.sh-style agent: run `hearth service install` to migrate" : undefined };
  }
}

/** Linux: a systemd --user unit (default) or, with --system, a system unit with User=. */
export class Systemd implements ServiceManager {
  readonly name = "systemd";
  constructor(private system = existsSync("/etc/systemd/system/hearth.service") && !existsSync(join(homedir(), ".config/systemd/user/hearth.service"))) {}
  available() {
    if (process.platform !== "linux" || !which("systemctl")) return false;
    if (this.system) return existsSync("/run/systemd/system");
    return run("systemctl", ["--user", "show-environment"]).code === 0;
  }
  private unit() { return this.system ? "/etc/systemd/system/hearth.service" : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user/hearth.service"); }
  private ctl(...a: string[]) { return run("systemctl", [...(this.system ? [] : ["--user"]), ...a]); }
  logFile() { return join(dataDir(), "hearth.log"); }
  install(o: InstallOpts = {}) {
    this.system = !!o.system;
    if (this.system && process.getuid?.() !== 0) throw new Error("--system needs root: run it with sudo");
    if (!this.available()) throw new Error(this.system ? "systemd isn't running on this machine" : "systemd --user isn't available in this session (try `hearth service install --system` with sudo, or run `hearth` under your own supervisor)");
    const user = o.user ?? process.env.SUDO_USER ?? userInfo().username;
    const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    const env = serviceEnv(this.name, homedir());
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const body = `[Unit]
Description=Hearth (web UI for ACP coding agents)
After=network-online.target

[Service]
Type=simple
ExecStart=${[...selfCommand(), "serve"].map(q).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}
WorkingDirectory=${homedir()}
${this.system ? `User=${user}\n` : ""}Restart=always
RestartSec=2
# Agents and the updater are separate process groups; Hearth stops its own agents on SIGTERM.
KillMode=process
StandardOutput=append:${this.logFile()}
StandardError=append:${this.logFile()}

[Install]
WantedBy=${this.system ? "multi-user.target" : "default.target"}
`;
    const p = this.unit(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, { mode: 0o644 });
    this.ctl("daemon-reload");
    const r = this.ctl("enable", "--now", "hearth.service"); if (r.code !== 0) throw new Error(`systemctl enable failed: ${r.out.trim()}`);
    this.ctl("restart", "hearth.service");
    const notes = [`Installed ${p}`];
    if (!this.system) {
      const linger = run("loginctl", ["show-user", userInfo().username, "-p", "Linger"]).out.trim();
      if (!/Linger=yes/.test(linger)) notes.push(`Tip: \`loginctl enable-linger ${userInfo().username}\` keeps Hearth running while you're logged out and starts it at boot.`);
    }
    return notes;
  }
  uninstall() { this.ctl("disable", "--now", "hearth.service"); rmSync(this.unit(), { force: true }); this.ctl("daemon-reload"); return [`Removed ${this.unit()}`]; }
  start() { this.ctl("start", "hearth.service"); }
  stop() { this.ctl("stop", "hearth.service"); }
  restart() { this.ctl("restart", "hearth.service"); }
  status(): ServiceStatus {
    const file = this.unit(); const installed = existsSync(file);
    const r = this.ctl("show", "hearth.service", "-p", "ActiveState", "-p", "MainPID", "-p", "SubState");
    const pid = Number(/MainPID=(\d+)/.exec(r.out)?.[1]) || undefined;
    return { manager: this.system ? "systemd (system)" : "systemd (--user)", installed, running: /ActiveState=active/.test(r.out), pid, file };
  }
}

/** Windows (experimental): a Task Scheduler task that starts Hearth at logon via a small restart loop. */
export class WindowsTask implements ServiceManager {
  readonly name = "windows";
  available() { return process.platform === "win32"; }
  private cmdFile() { return join(dataDir(), "hearth-service.cmd"); }
  logFile() { return join(dataDir(), "hearth.log"); }
  install() {
    mkdirSync(dataDir(), { recursive: true });
    const env = serviceEnv(this.name, homedir());
    const cmd = ["@echo off", ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`), ":loop",
      `${selfCommand().map((a) => `"${a}"`).join(" ")} serve >> "${this.logFile()}" 2>&1`, "timeout /t 3 /nobreak >nul", "goto loop", ""].join("\r\n");
    writeFileSync(this.cmdFile(), cmd);
    const r = run("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", "Hearth", "/TR", `cmd.exe /d /c "${this.cmdFile()}"`]);
    if (r.code !== 0) throw new Error(`schtasks failed: ${r.out.trim()}`);
    run("schtasks", ["/Run", "/TN", "Hearth"]);
    return [`Created scheduled task "Hearth" (runs at logon): ${this.cmdFile()}`, "Windows support is experimental."];
  }
  uninstall() { this.stop(); run("schtasks", ["/Delete", "/F", "/TN", "Hearth"]); rmSync(this.cmdFile(), { force: true }); return ["Removed scheduled task \"Hearth\""]; }
  start() { run("schtasks", ["/Run", "/TN", "Hearth"]); }
  stop() { run("schtasks", ["/End", "/TN", "Hearth"]); const pid = readPid(); if (pid) { try { process.kill(pid); } catch { /* gone */ } } }
  restart() { const pid = readPid(); if (pid) { try { process.kill(pid); } catch { /* gone */ } } else this.start(); } // the loop restarts it
  status(): ServiceStatus {
    const r = run("schtasks", ["/Query", "/TN", "Hearth"]); const pid = readPid();
    return { manager: "Task Scheduler (experimental)", installed: r.code === 0, running: !!pid && alive(pid), pid: pid ?? undefined, file: this.cmdFile() };
  }
}

export const pidFile = () => join(dataDir(), "hearth.pid");
export function readPid(): number | null { try { return Number(readFileSync(pidFile(), "utf8").trim()) || null; } catch { return null; } }
export function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** The service manager for this OS (null if none is usable). */
export function serviceManager(system?: boolean): ServiceManager | null {
  const all: ServiceManager[] = process.platform === "darwin" ? [new Launchd(system)] : process.platform === "linux" ? [new Systemd(system)] : process.platform === "win32" ? [new WindowsTask()] : [];
  return all.find((m) => m.available()) ?? null;
}

/** Last n lines of the log file. */
export function tail(file: string, n = 80): string {
  if (!existsSync(file)) return `(no log yet at ${file})`;
  const lines = readFileSync(file, "utf8").split("\n"); return lines.slice(-n - 1).join("\n");
}
