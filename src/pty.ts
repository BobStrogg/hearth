import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "./agents.js";
import { type CompileRun, macCompiler } from "./launcher.js";
import { dataDir } from "./platform.js";

/**
 * Hearth's terminals need a real pseudo-terminal (so shells, editors and TUIs like Devin CLI work), and Node.js has no
 * built-in way to open one. Rather than ship a native addon (which the single-file binary can't load), Hearth builds
 * this tiny helper with the system C compiler on first use, the same way it builds its macOS launcher.
 *
 *   hearth-pty <cols> <rows> <cwd> <program> [args...]
 *
 * fd 0: keystrokes for the terminal. fd 1: everything the terminal prints. fd 3 (a socket pair): control.
 *   Hearth → helper: "R <cols> <rows>\n" resize (and nudge the foreground program to redraw), "H\n" hang up.
 *   helper → Hearth: "P <pid>\n" once started (pid = the program, also its session id), "E <code> <signal>\n" when it ends.
 * SIGHUP/SIGTERM to the helper, or Hearth going away (fd 0 or fd 3 closing), hang the terminal up like closing a
 * terminal window: the helper closes the pty (the kernel sends SIGHUP to the foreground job) and SIGHUPs the shell.
 */
export const PTY_C = `/* hearth-pty: run a program on a pseudo-terminal for Hearth's terminals. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
static volatile sig_atomic_t hup = 0;
static void onsig(int s) { (void)s; hup = 1; }
static void say(const char *fmt, ...) {
  char b[128]; va_list ap; va_start(ap, fmt); int n = vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  if (n > 0) { ssize_t w = write(3, b, (size_t)n); (void)w; }
}
static long long ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int writeall(int fd, const char *p, size_t n) {
  while (n) { ssize_t w = write(fd, p, n); if (w < 0) { if (errno == EINTR) continue; return -1; } p += w; n -= (size_t)w; }
  return 0;
}
#define PEND_MAX (1 << 20)
int main(int argc, char **argv) {
  if (argc < 5) { fprintf(stderr, "usage: hearth-pty cols rows cwd program [args...]\\n"); return 64; }
  struct winsize ws; memset(&ws, 0, sizeof ws);
  int c = atoi(argv[1]), r = atoi(argv[2]);
  ws.ws_col = (unsigned short)(c > 0 && c < 1000 ? c : 80); ws.ws_row = (unsigned short)(r > 0 && r < 1000 ? r : 24);
  int master = -1;
  pid_t pid = forkpty(&master, NULL, NULL, &ws);
  if (pid < 0) { say("F forkpty: %s\\n", strerror(errno)); return 1; }
  if (pid == 0) {
    for (int fd = 3; fd < 256; fd++) close(fd);
    if (chdir(argv[3]) != 0) fprintf(stderr, "hearth-pty: can't open %s: %s\\r\\n", argv[3], strerror(errno));
    execvp(argv[4], argv + 4);
    fprintf(stderr, "hearth-pty: can't start %s: %s\\r\\n", argv[4], strerror(errno));
    _exit(127);
  }
  say("P %d\\n", (int)pid);
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = onsig; sigemptyset(&sa.sa_mask);
  sigaction(SIGHUP, &sa, NULL); sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  char *pend = malloc(PEND_MAX); size_t plen = 0, poff = 0;
  char buf[65536], ctl[256]; size_t clen = 0;
  int status = 0, exited = 0, in_open = 1, ctl_open = 1, out_ok = 1, closing = 0;
  long long deadline = 0;
  if (!pend) return 1;
  for (;;) {
    if (hup && !closing) { closing = 1; kill(-pid, SIGHUP); kill(pid, SIGHUP); if (master >= 0) { close(master); master = -1; } plen = poff = 0; }
    struct pollfd fds[3]; int n = 0, im = -1, ii = -1, ic = -1;
    if (master >= 0) { im = n; fds[n].fd = master; fds[n].events = POLLIN | (plen > poff ? POLLOUT : 0); fds[n++].revents = 0; }
    if (in_open && master >= 0 && plen == poff) { ii = n; fds[n].fd = 0; fds[n].events = POLLIN; fds[n++].revents = 0; }
    if (ctl_open) { ic = n; fds[n].fd = 3; fds[n].events = POLLIN; fds[n++].revents = 0; }
    int pr = poll(fds, (nfds_t)n, exited ? 50 : 250);
    if (pr < 0 && errno != EINTR) break;
    if (!exited) { pid_t w = waitpid(pid, &status, WNOHANG); if (w == pid) { exited = 1; deadline = ms() + 300; } }
    if (pr > 0 && im >= 0 && master >= 0 && (fds[im].revents & (POLLIN | POLLHUP | POLLERR))) {
      for (;;) {
        ssize_t k = read(master, buf, sizeof buf);
        if (k > 0) { if (out_ok && writeall(1, buf, (size_t)k) < 0) { out_ok = 0; hup = 1; } continue; }
        if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) break;
        close(master); master = -1; break; /* EOF or EIO: nothing has the terminal open any more */
      }
    }
    if (pr > 0 && im >= 0 && master >= 0 && (fds[im].revents & POLLOUT) && plen > poff) {
      ssize_t w = write(master, pend + poff, plen - poff);
      if (w > 0) { poff += (size_t)w; if (poff == plen) poff = plen = 0; }
    }
    if (pr > 0 && ii >= 0 && (fds[ii].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t k = read(0, pend, PEND_MAX);
      if (k > 0) { plen = (size_t)k; poff = 0; }
      else if (k == 0 || (errno != EAGAIN && errno != EINTR)) { in_open = 0; hup = 1; }
    }
    if (pr > 0 && ic >= 0 && (fds[ic].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t k = read(3, ctl + clen, sizeof ctl - 1 - clen);
      if (k > 0) {
        clen += (size_t)k; ctl[clen] = 0;
        char *nl;
        while ((nl = memchr(ctl, '\\n', clen))) {
          *nl = 0;
          int cc = 0, rr = 0;
          if (ctl[0] == 'R' && sscanf(ctl + 1, "%d %d", &cc, &rr) == 2 && cc > 0 && rr > 0 && cc < 1000 && rr < 1000 && master >= 0) {
            ws.ws_col = (unsigned short)cc; ws.ws_row = (unsigned short)rr; ioctl(master, TIOCSWINSZ, &ws);
            pid_t fg = tcgetpgrp(master); if (fg > 0) kill(-fg, SIGWINCH);
          } else if (ctl[0] == 'H') hup = 1;
          size_t used = (size_t)(nl - ctl) + 1; memmove(ctl, nl + 1, clen - used); clen -= used;
        }
        if (clen >= sizeof ctl - 1) clen = 0;
      } else if (k == 0 || (errno != EAGAIN && errno != EINTR)) { ctl_open = 0; hup = 1; }
    }
    if (exited && (master < 0 || ms() > deadline)) break;
  }
  if (master >= 0) close(master);
  if (!exited) waitpid(pid, &status, 0);
  if (WIFSIGNALED(status)) say("E -1 %d\\n", WTERMSIG(status)); else say("E %d 0\\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
  return 0;
}
`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function ptyHelperPath(home = dataDir()) { return join(home, "bin", "hearth-pty"); }
const run: CompileRun = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };

export type PtyHelper = { path: string; built: boolean } | { path: null; note: string };
/**
 * The pty helper's path, building it from PTY_C if it is missing or out of date. Needs a C compiler: the Xcode Command
 * Line Tools on macOS (Homebrew installs them), cc on Linux. Windows has no terminals.
 */
export function ensurePtyHelper(o: { home?: string; platform?: NodeJS.Platform; run?: CompileRun; cc?: string } = {}): PtyHelper {
  const platform = o.platform ?? process.platform, r = o.run ?? run;
  if (platform === "win32") return { path: null, note: "terminals aren't available on Windows yet" };
  const bin = ptyHelperPath(o.home), stamp = `${bin}.sha256`, want = sha(PTY_C);
  try { if (existsSync(bin) && readFileSync(stamp, "utf8").trim() === want) return { path: bin, built: false }; } catch { /* build */ }
  const cc = o.cc ?? (platform === "darwin" ? macCompiler(r) : which("cc") ?? which("gcc") ?? which("clang"));
  if (!cc) return { path: null, note: platform === "darwin" ? "terminals need the Xcode Command Line Tools: run xcode-select --install on this Mac" : "terminals need a C compiler (cc) on this computer to build their small pty helper" };
  mkdirSync(join(bin, ".."), { recursive: true, mode: 0o700 });
  const src = `${bin}.c`, tmp = `${bin}.new`;
  writeFileSync(src, PTY_C, { mode: 0o644 });
  const c = r(cc, ["-O2", "-o", tmp, src, ...(platform === "darwin" ? [] : ["-lutil"])]);
  if (c.status !== 0) {
    rmSync(tmp, { force: true });
    const lines = c.out.trim().split("\n"); const why = lines.find((l) => /\berror\b/i.test(l)) ?? lines.at(-1);
    return { path: null, note: `couldn't build the terminal helper (${why?.replace(src, "hearth-pty.c").trim() || "compiler failed"})` };
  }
  if (platform === "darwin") r("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.github.hearth.pty", tmp]); // the linker signs too; best effort
  chmodSync(tmp, 0o755); renameSync(tmp, bin); writeFileSync(stamp, want + "\n", { mode: 0o644 });
  return { path: bin, built: true };
}
