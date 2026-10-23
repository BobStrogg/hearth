import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./platform.js";

/**
 * macOS privacy permissions (Documents, Desktop, Downloads, Full Disk Access…) belong to the "responsible" program of
 * a process: for a LaunchAgent, the program launchd starts, and every process it starts inherits it (Hearth's agents
 * too). A non-app binary is identified by its path and code signature. Homebrew's node lives at a new Cellar path with
 * a new ad-hoc signature after every upgrade, and the hearth binary gets a new signature with every release, so macOS
 * forgets the permission each time and asks again: until someone clicks Allow on the Mac's screen, any access waits.
 *
 * The fix: launchd starts this tiny launcher, which starts Hearth as its child and stays its parent (no exec, so it
 * stays the responsible program). It is built once on the Mac and never rebuilt unless this source changes, so its
 * path and signature, and the permissions given to it, survive Node.js and Hearth updates.
 */
export const LAUNCHER_C = `/* hearth-launch: a stable parent for Hearth, so macOS privacy permissions survive Node.js and Hearth updates. */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static volatile pid_t child = 0;
static volatile sig_atomic_t pending = 0;
static void fwd(int sig) { if (child > 0) kill(child, sig); else pending = sig; }
int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: hearth-launch program [args...]\\n"); return 64; }
  if (argv[0][0] == '/') setenv("HEARTH_LAUNCHER", argv[0], 1);
  int sigs[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = fwd; sigemptyset(&sa.sa_mask);
  for (unsigned i = 0; i < sizeof sigs / sizeof *sigs; i++) sigaction(sigs[i], &sa, NULL);
  pid_t pid;
  int rc = posix_spawnp(&pid, argv[1], NULL, NULL, argv + 1, environ);
  if (rc != 0) { fprintf(stderr, "hearth-launch: can't start %s: %s\\n", argv[1], strerror(rc)); return 127; }
  child = pid;
  if (pending) kill(pid, pending);
  int st;
  while (waitpid(pid, &st, 0) < 0) if (errno != EINTR) return 1;
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) { int s = WTERMSIG(st); signal(s, SIG_DFL); raise(s); return 128 + s; }
  return 1;
}
`;
export const LAUNCHER_ID = "io.github.hearth.launch";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function launcherPath(home = dataDir()) { return join(home, "bin", "hearth-launch"); }

type Run = (cmd: string, args: string[]) => { status: number | null; out: string };
const run: Run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };

/**
 * The launcher's path, building it if needed (macOS only, unless `platform` says otherwise). An existing launcher
 * built from this same source is kept untouched: rebuilding would change its signature and macOS would ask again.
 * Needs a C compiler (Xcode Command Line Tools, which Homebrew installs). Without one: null (Hearth runs directly).
 */
export function ensureLauncher(o: { home?: string; platform?: NodeJS.Platform; run?: Run; cc?: string; exists?: (p: string) => boolean } = {}): { path: string | null; built: boolean; note?: string } {
  const platform = o.platform ?? process.platform, r = o.run ?? run;
  if (platform !== "darwin" && !o.cc) return { path: null, built: false };
  const bin = launcherPath(o.home), stamp = `${bin}.sha256`, want = sha(LAUNCHER_C);
  try { if (existsSync(bin) && readFileSync(stamp, "utf8").trim() === want) return { path: bin, built: false }; } catch { /* rebuild */ }
  // macOS: /usr/bin/cc exists even without the Command Line Tools and would pop up an installer; check for them first.
  // /usr/bin/xcrun and /usr/bin/cc are shims that do the same when the tools are missing, so they only run once the
  // developer directory and a clang in it are known to exist, and there is no fallback to /usr/bin/cc.
  let cc = o.cc;
  if (!cc) {
    const ex = o.exists ?? existsSync;
    const noTools = { path: null, built: false, note: "the Xcode Command Line Tools aren't installed (xcode-select --install), so Hearth runs directly and macOS may ask for folder permission again after each Node.js update" };
    const d = r("/usr/bin/xcode-select", ["-p"]); const dev = d.status === 0 ? d.out.trim().split("\n")[0] : "";
    if (!dev || !ex(dev) || ![join(dev, "usr", "bin", "clang"), join(dev, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "clang")].some((x) => ex(x))) return noTools;
    const f = r("/usr/bin/xcrun", ["--find", "clang"]); cc = f.status === 0 ? f.out.trim().split("\n")[0] : "";
    if (!cc || !ex(cc)) return noTools;
  }
  mkdirSync(join(bin, ".."), { recursive: true, mode: 0o700 });
  const src = `${bin}.c`, tmp = `${bin}.new`;
  writeFileSync(src, LAUNCHER_C, { mode: 0o644 });
  const c = r(cc, ["-O2", "-o", tmp, src]);
  if (c.status !== 0) { rmSync(tmp, { force: true }); return { path: null, built: false, note: `couldn't build the launcher (${c.out.trim().split("\n").slice(-1)[0] || "compiler failed"}), so Hearth runs directly` }; }
  if (platform === "darwin") {
    const s = r("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", LAUNCHER_ID, tmp]);
    if (s.status !== 0) { rmSync(tmp, { force: true }); return { path: null, built: false, note: `couldn't sign the launcher (${s.out.trim().split("\n").slice(-1)[0]}), so Hearth runs directly` }; }
  }
  chmodSync(tmp, 0o755); renameSync(tmp, bin); writeFileSync(stamp, want + "\n", { mode: 0o644 });
  return { path: bin, built: true };
}
