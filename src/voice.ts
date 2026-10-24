/**
 * Voice on this computer (opt-in, nothing leaves the machine):
 * - Speech to text for browsers without a usable SpeechRecognition (the Tesla browser, Firefox) or when you prefer
 *   recognition to stay private: the browser records 16 kHz mono WAV and Hearth runs whisper.cpp (`whisper-cli`) on it.
 * - Text to speech for browsers without speechSynthesis voices: macOS `say` (AAC via afconvert), else piper or
 *   espeak-ng on Linux.
 * Uploads are size- and length-capped, each job has a deadline, and temp files are deleted afterwards.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { searchPath, which } from "./agents.js";

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;   // 16 kHz mono 16-bit = 32 KB/s: about 4 minutes
export const MAX_AUDIO_SECONDS = 120;
export const MAX_SPEAK_CHARS = 6000;
const STT_TIMEOUT_MS = 90_000, TTS_TIMEOUT_MS = 60_000, INSTALL_TIMEOUT_MS = 20 * 60_000;

/** The default model `hearth voice install` downloads: English base, 5-bit quantised (60 MB, fast on any Mac). */
export const DEFAULT_MODEL = {
  name: "ggml-base.en-q5_1.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
  sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
  bytes: 59721011,
};
/** Preference order when several models are present (the first found wins). */
const MODEL_PREF = ["ggml-base.en-q5_1.bin", "ggml-base.en.bin", "ggml-small.en-q5_1.bin", "ggml-small.en.bin", "ggml-base.bin", "ggml-tiny.en.bin"];

export interface WavInfo { sampleRate: number; channels: number; bits: number; dataOffset: number; dataBytes: number; seconds: number }
/** A PCM WAV header (what the browser sends). Throws with a short reason when it isn't one. */
export function parseWav(b: Buffer): WavInfo {
  if (b.length < 44 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("latin1", off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new Error("bad WAV format chunk");
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before its format");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("WAV must be 16-bit PCM");
      if (fmt.channels < 1 || fmt.channels > 2 || fmt.sampleRate < 8000 || fmt.sampleRate > 48000) throw new Error("unsupported WAV layout");
      const dataBytes = Math.min(size, b.length - body);
      return { ...fmt, dataOffset: body, dataBytes, seconds: dataBytes / (fmt.sampleRate * fmt.channels * 2) };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no audio data");
}

/** whisper.cpp output as plain text: no timestamps, no [BLANK_AUDIO] / (music) style annotations, single spaces. */
export function cleanTranscript(s: string): string {
  return String(s)
    .replace(/^\s*\[\d\d:\d\d[^\]]*\]\s*/gm, "")
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|SOUND|APPLAUSE|LAUGHTER)[^\]]*\]/gi, " ")
    .replace(/\((?:music|silence|noise|inaudible|blank audio|laughs|applause|wind blowing|static)[^)]*\)/gi, " ")
    .replace(/\*(?:music|silence|noise)[^*]*\*/gi, " ")
    .replace(/\s+/g, " ").trim();
}

const homebrewDirs = ["/opt/homebrew/bin", "/usr/local/bin"];
export function findWhisper(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HEARTH_WHISPER_BIN) return existsSync(env.HEARTH_WHISPER_BIN) ? env.HEARTH_WHISPER_BIN : null;
  const p = searchPath();
  return which("whisper-cli", p) ?? which("whisper-cpp", p) ?? null;
}
export function modelsDir(dataDir: string) { return join(dataDir, "models"); }
export function findModel(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HEARTH_WHISPER_MODEL) return existsSync(env.HEARTH_WHISPER_MODEL) ? env.HEARTH_WHISPER_MODEL : null;
  const dirs = [modelsDir(dataDir), "/opt/homebrew/share/whisper-cpp", "/usr/local/share/whisper-cpp"];
  for (const name of MODEL_PREF) for (const d of dirs) { const f = join(d, name); if (existsSync(f)) return f; }
  for (const d of dirs) {
    try { const f = readdirSync(d).filter((n) => /^ggml-.+\.bin$/.test(n) && !/silero|vad/i.test(n)).sort()[0]; if (f) return join(d, f); } catch { /* none */ }
  }
  return null;
}
export interface Tts { engine: "say" | "piper" | "espeak-ng" | "espeak"; bin: string; model?: string; convert?: string }
export function findTts(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Tts | null {
  if (/^(off|0|false|no)$/i.test(env.HEARTH_TTS ?? "")) return null;
  const p = searchPath();
  if (platform === "darwin" && existsSync("/usr/bin/say")) return { engine: "say", bin: "/usr/bin/say", convert: existsSync("/usr/bin/afconvert") ? "/usr/bin/afconvert" : undefined };
  const piper = which("piper", p), pm = env.HEARTH_PIPER_MODEL;
  if (piper && pm && existsSync(pm)) return { engine: "piper", bin: piper, model: pm };
  const es = which("espeak-ng", p); if (es) return { engine: "espeak-ng", bin: es };
  const e1 = which("espeak", p); if (e1) return { engine: "espeak", bin: e1 };
  return null;
}
export function findBrew(): string | null { for (const d of homebrewDirs) { const b = join(d, "brew"); if (existsSync(b)) return b; } return null; }

/** Text for the speech engine: one line, no control characters, capped. (The browser already strips markdown.) */
export function ttsInput(s: string): string {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SPEAK_CHARS);
}

export class VoiceError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

const run = (bin: string, args: string[], opts: { timeout: number; input?: string; env?: NodeJS.ProcessEnv }) => new Promise<{ stdout: string; stderr: string }>((res, rej) => {
  const c = execFile(bin, args, { timeout: opts.timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: opts.env ?? process.env, windowsHide: true }, (err, stdout, stderr) => {
    if (err) { const e = err as NodeJS.ErrnoException & { killed?: boolean }; return rej(new Error(e.killed ? `${basename(bin)} took too long` : `${basename(bin)} failed: ${String(stderr || e.message).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`)); }
    res({ stdout: String(stdout), stderr: String(stderr) });
  });
  if (opts.input !== undefined) { c.stdin?.on("error", () => {}); c.stdin?.end(opts.input); }
});

export interface InstallState { running: boolean; step?: string; error?: string; done?: boolean; at?: number }

export class Voice {
  private busy = 0; private waiting = 0;
  install: InstallState = { running: false };
  constructor(readonly dataDir: string, readonly env: NodeJS.ProcessEnv = process.env, readonly platform = process.platform) {}

  caps() {
    const bin = findWhisper(this.env), model = findModel(this.dataDir, this.env), tts = findTts(this.env, this.platform);
    const brew = this.platform === "darwin" ? findBrew() : null;
    const missing = [!bin && "whisper.cpp", !model && "a speech model"].filter(Boolean) as string[];
    return {
      stt: { available: !!(bin && model), engine: bin && model ? "whisper.cpp" : null, model: model ? basename(model) : null,
        missing, canInstall: !bin ? !!brew : !model, install: this.install },
      tts: { available: !!tts, engine: tts?.engine ?? null },
      limits: { maxBytes: MAX_AUDIO_BYTES, maxSeconds: MAX_AUDIO_SECONDS, maxChars: MAX_SPEAK_CHARS },
    };
  }

  /** One job at a time per Hearth (a second waits; more get "busy"). */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy && this.waiting >= 2) throw new VoiceError(429, "busy with other voice requests; try again in a moment");
    this.waiting++;
    try { while (this.busy) await new Promise((r) => setTimeout(r, 100)); } finally { this.waiting--; }
    this.busy++;
    try { return await fn(); } finally { this.busy--; }
  }
  private tmp(): string { return mkdtempSync(join(tmpdir(), "hearth-voice-")); } // mode 0700

  async transcribe(wav: Buffer, lang?: string): Promise<{ text: string; seconds: number; ms: number }> {
    const bin = findWhisper(this.env), model = findModel(this.dataDir, this.env);
    if (!bin || !model) throw new VoiceError(501, "speech to text isn't set up on this computer (run `hearth voice install`)");
    let info: WavInfo;
    try { info = parseWav(wav); } catch (e) { throw new VoiceError(415, (e as Error).message); }
    if (info.seconds > MAX_AUDIO_SECONDS + 1) throw new VoiceError(413, `recording too long (max ${MAX_AUDIO_SECONDS} s)`);
    if (info.seconds < 0.2) return { text: "", seconds: info.seconds, ms: 0 };
    return this.slot(async () => {
      const dir = this.tmp(), f = join(dir, "in.wav"), t0 = Date.now();
      try {
        writeFileSync(f, wav, { mode: 0o600 });
        const english = /\.en[.-]/.test(basename(model));
        const l = english ? "en" : /^[a-z]{2}$/.test(lang ?? "") ? lang! : "auto";
        const threads = String(Math.max(1, Math.min(8, cpus().length - 1)));
        const { stdout } = await run(bin, ["-m", model, "-f", f, "-l", l, "-t", threads, "-nt", "-np"], { timeout: STT_TIMEOUT_MS });
        return { text: cleanTranscript(stdout), seconds: info.seconds, ms: Date.now() - t0 };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  async speak(text: string): Promise<{ type: string; body: Buffer }> {
    const tts = findTts(this.env, this.platform);
    if (!tts) throw new VoiceError(501, "no text-to-speech engine on this computer (macOS `say`, or piper / espeak-ng on Linux)");
    const t = ttsInput(text);
    if (!t) throw new VoiceError(400, "nothing to say");
    return this.slot(async () => {
      const dir = this.tmp(), txt = join(dir, "in.txt"), wav = join(dir, "out.wav");
      try {
        writeFileSync(txt, t, { mode: 0o600 });
        if (tts.engine === "say") {
          const voice = this.env.HEARTH_SAY_VOICE && /^[\w .()-]{1,60}$/.test(this.env.HEARTH_SAY_VOICE) ? ["-v", this.env.HEARTH_SAY_VOICE] : [];
          await run(tts.bin, [...voice, "-f", txt, "-o", wav, "--file-format=WAVE", "--data-format=LEI16@22050"], { timeout: TTS_TIMEOUT_MS });
          if (tts.convert) {
            const m4a = join(dir, "out.m4a");
            try { await run(tts.convert, ["-f", "m4af", "-d", "aac", "-b", "64000", wav, m4a], { timeout: TTS_TIMEOUT_MS }); return { type: "audio/mp4", body: readFileSync(m4a) }; }
            catch { /* fall back to WAV */ }
          }
        } else if (tts.engine === "piper") await run(tts.bin, ["--model", tts.model!, "--output_file", wav], { timeout: TTS_TIMEOUT_MS, input: t });
        else await run(tts.bin, ["-w", wav, "-f", txt], { timeout: TTS_TIMEOUT_MS });
        return { type: "audio/wav", body: readFileSync(wav) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  /**
   * Set up speech to text: `brew install whisper-cpp` when whisper-cli is missing (macOS with Homebrew), then download
   * the default model (fixed URL, SHA-256 checked). Takes no input; runs in the background; progress in caps().
   */
  startInstall(log: (s: string) => void = () => {}): InstallState {
    if (this.install.running) return this.install;
    this.install = { running: true, step: "starting", at: Date.now() };
    void this.runInstall(log).then(() => { this.install = { running: false, done: true, at: Date.now() }; },
      (e) => { this.install = { running: false, error: String((e as Error).message ?? e), at: Date.now() }; });
    return this.install;
  }
  async runInstall(log: (s: string) => void = () => {}): Promise<void> {
    if (!findWhisper(this.env)) {
      const brew = this.platform === "darwin" ? findBrew() : null;
      if (!brew) throw new Error(this.platform === "darwin" ? "Homebrew isn't installed: install whisper.cpp (`brew install whisper-cpp`) or set HEARTH_WHISPER_BIN" : "install whisper.cpp (whisper-cli) yourself, e.g. build it from https://github.com/ggml-org/whisper.cpp, or set HEARTH_WHISPER_BIN");
      this.install.step = "brew install whisper-cpp"; log("Installing whisper.cpp with Homebrew…");
      await run(brew, ["install", "whisper-cpp"], { timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1", PATH: `${homebrewDirs.join(":")}:${process.env.PATH ?? "/usr/bin:/bin"}` } });
      if (!findWhisper(this.env)) throw new Error("whisper.cpp installed, but whisper-cli wasn't found");
    }
    if (!findModel(this.dataDir, this.env)) {
      this.install.step = `downloading ${DEFAULT_MODEL.name} (60 MB)`; log(`Downloading ${DEFAULT_MODEL.name}…`);
      await downloadModel(modelsDir(this.dataDir));
    }
    log("Speech to text is ready.");
  }
}

/** Download the default model into `dir` (temp file, SHA-256 and size checked, then renamed into place). */
export async function downloadModel(dir: string, m = DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, m.name), part = `${dest}.part`;
  const r = await fetchImpl(m.url, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS), redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`model download failed: HTTP ${r.status}`);
  const hash = createHash("sha256"); let n = 0;
  const out = createWriteStream(part, { mode: 0o600 });
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      n += chunk.length; if (n > m.bytes) throw new Error("model download is larger than expected");
      hash.update(chunk); if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    const got = hash.digest("hex");
    if (n !== m.bytes || got !== m.sha256) throw new Error("model download didn't match its checksum");
    renameSync(part, dest);
    return dest;
  } catch (e) { out.destroy(); rmSync(part, { force: true }); throw e; }
}

/** `hearth voice [status|install]` output lines. */
export function describe(v: Voice): string[] {
  const c = v.caps();
  return [
    `Speech to text (private, on this computer): ${c.stt.available ? `ready (whisper.cpp, ${c.stt.model})` : `not set up (missing ${c.stt.missing.join(" and ")})`}`,
    `Text to speech on this computer: ${c.tts.available ? c.tts.engine : "none (install piper or espeak-ng)"}`,
    ...(c.stt.available ? [] : [c.stt.canInstall ? "Run `hearth voice install` to set it up." : process.platform === "darwin" ? "Install Homebrew (https://brew.sh), then run `hearth voice install`." : "Install whisper.cpp (whisper-cli), then run `hearth voice install` for the model."]),
  ];
}
