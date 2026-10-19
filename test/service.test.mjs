// Service managers: unit/plist content and the systemctl/launchctl calls they make. A real systemd is exercised in CI
// (ubuntu-latest has it); this box has no PID 1 systemd, so systemctl is stubbed here.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Systemd, Launchd, LABEL } from "../dist/service.js";
import { selfCommand } from "../dist/install-info.js";

function stub(dir, name, script) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_CTL_LOG"\n${script}\n`, { mode: 0o755 });
  return bin;
}

test("systemd --user: unit content and systemctl enable/disable", () => {
  if (process.platform !== "linux") return;
  const d = mkdtempSync(join(tmpdir(), "hsvc-")); const home = join(d, "home"); mkdirSync(home);
  const bin = stub(d, "systemctl", `case "$*" in *"--user show-environment"*) exit 0;; *"show hearth.service"*) echo ActiveState=active; echo MainPID=4242; echo SubState=running;; esac\nexit 0`);
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, ".config"); process.env.HEARTH_DATA_DIR = join(d, "data");
  process.env.FAKE_CTL_LOG = join(d, "log"); process.env.PATH = `${bin}:${process.env.PATH}`;
  writeFileSync(join(d, "log"), "");
  const s = new Systemd(false);
  assert.ok(s.available());
  const notes = s.install();
  assert.match(notes.join("\n"), /Installed .*hearth\.service/);
  const unit = readFileSync(join(home, ".config/systemd/user/hearth.service"), "utf8");
  const [node, main] = selfCommand();
  assert.match(unit, new RegExp(`ExecStart="${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" "${main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" "serve"`));
  assert.match(unit, /Restart=always/); assert.match(unit, /KillMode=process/); assert.match(unit, /Environment="HEARTH_SERVICE=systemd"/);
  assert.match(unit, /WantedBy=default\.target/); assert.doesNotMatch(unit, /^User=/m);
  const st = s.status(); assert.ok(st.installed && st.running && st.pid === 4242);
  s.restart(); s.uninstall();
  const log = readFileSync(join(d, "log"), "utf8");
  assert.match(log, /daemon-reload/); assert.match(log, /enable --now hearth\.service/); assert.match(log, /restart hearth\.service/); assert.match(log, /disable --now hearth\.service/);
  assert.throws(() => readFileSync(join(home, ".config/systemd/user/hearth.service")));
  rmSync(d, { recursive: true, force: true });
});

test("launchd: plist content (LaunchAgent), migration note, status", { skip: process.platform !== "darwin" && "macOS only" }, () => {
  const d = mkdtempSync(join(tmpdir(), "hla-")); const home = join(d, "home"); mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  const bin = stub(d, "launchctl", `case "$*" in *"print "*) echo "state = running"; echo "pid = 99";; esac\nexit 0`);
  process.env.HOME = home; process.env.HEARTH_DATA_DIR = join(d, "data"); process.env.FAKE_CTL_LOG = join(d, "log"); process.env.PATH = `${bin}:${process.env.PATH}`;
  writeFileSync(join(d, "log"), "");
  // Existing run.sh-style agent: install should mention the migration.
  writeFileSync(join(home, "Library/LaunchAgents", `${LABEL}.plist`), "<plist><string>run.sh</string></plist>");
  const s = new Launchd(false); assert.ok(s.available());
  const notes = s.install(); assert.match(notes.join("\n"), /Migrated the old run\.sh/);
  const pl = readFileSync(join(home, "Library/LaunchAgents", `${LABEL}.plist`), "utf8");
  assert.match(pl, /io\.github\.hearth/); assert.match(pl, /KeepAlive/); assert.doesNotMatch(pl, /run\.sh/);
  assert.match(pl, /HEARTH_SERVICE/); assert.match(pl, /ProgramArguments/);
  const st = s.status(); assert.ok(st.installed && st.running);
  s.uninstall(); assert.throws(() => readFileSync(join(home, "Library/LaunchAgents", `${LABEL}.plist`)));
  rmSync(d, { recursive: true, force: true });
});
