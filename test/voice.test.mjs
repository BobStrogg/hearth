// Voice: the WAV parser and transcript clean-up, model lookup and download checks, the /api/voice endpoints (auth,
// CSRF, size/length limits, temp files removed) with stand-in whisper-cli and espeak-ng, and web/voice.js (reply text
// for text-to-speech, sentence chunks, voice choice, WAV encoding).
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";
import { canonicalWav, cleanTranscript, downloadModel, findModel, parseWav, ttsInput, Voice, MAX_AUDIO_BYTES } from "../dist/voice.js";

const WIN = process.platform === "win32";
const ctx = {}; vm.createContext(ctx); vm.runInContext(readFileSync(new URL("../web/voice.js", import.meta.url), "utf8"), ctx);
const HV = ctx.HearthVoice;
const wav = (seconds, rate = 16000) => Buffer.from(HV.encodeWav(new Float32Array(Math.round(seconds * rate)).map((_, i) => Math.sin(i / 8) * 0.3), rate));

test("parseWav accepts the browser's 16 kHz mono PCM and rejects anything else", () => {
  const w = parseWav(wav(1.5));
  assert.equal(w.sampleRate, 16000); assert.equal(w.channels, 1); assert.equal(w.bits, 16); assert.ok(Math.abs(w.seconds - 1.5) < 0.001);
  assert.throws(() => parseWav(Buffer.from("hello world, definitely not a wav file at all......")), /not a WAV/);
  const b = wav(0.1); b.writeUInt16LE(3, 20); assert.throws(() => parseWav(b), /16-bit PCM/); // float format
  const c = wav(0.1); c.writeUInt32LE(4000, 24); assert.throws(() => parseWav(c), /unsupported/);
  assert.throws(() => parseWav(wav(0.1).subarray(0, 40)), /not a WAV/);
  // audio appended after the declared data is not passed on (the length check covers what the engine gets)
  const tail = Buffer.concat([wav(1), Buffer.alloc(64000, 1)]), ti = parseWav(tail), cw = canonicalWav(tail, ti);
  assert.equal(cw.length, 44 + 32000); assert.equal(parseWav(cw).seconds, 1);
});

test("cleanTranscript drops whisper's annotations and timestamps; ttsInput is one capped line", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n Add a test for the parser.\n (music) "), "Add a test for the parser.");
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Hello there."), "Hello there.");
  assert.equal(ttsInput("a\u0000b\n\nc  d"), "a b c d");
  assert.equal(ttsInput("x".repeat(10000)).length, 6000);
});

test("findModel prefers the default English model; downloadModel checks size and SHA-256", async () => {
  const d = mkdtempSync(join(tmpdir(), "hv-")); mkdirSync(join(d, "models"));
  assert.equal(findModel(d, {}), null);
  writeFileSync(join(d, "models", "ggml-tiny.en.bin"), "t"); writeFileSync(join(d, "models", "ggml-base.en-q5_1.bin"), "b");
  assert.match(findModel(d, {}), /ggml-base\.en-q5_1\.bin$/);
  assert.equal(findModel(d, { HEARTH_WHISPER_MODEL: join(d, "nope.bin") }), null);
  const body = Buffer.from("pretend model bytes");
  const m = { name: "m.bin", url: "https://example.invalid/m.bin", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
  const fake = async () => new Response(body);
  const out = join(d, "dl"); assert.equal(await downloadModel(out, m, fake), join(out, "m.bin"));
  assert.deepEqual(readFileSync(join(out, "m.bin")), body);
  await assert.rejects(downloadModel(join(d, "bad"), { ...m, sha256: "0".repeat(64) }, fake), /checksum/);
  assert.deepEqual(readdirSync(join(d, "bad")), [], "no partial file left behind");
  await assert.rejects(downloadModel(join(d, "big"), { ...m, bytes: 4 }, fake), /larger than expected/);
  await assert.rejects(downloadModel(join(d, "404"), m, async () => new Response("no", { status: 404 })), /HTTP 404/);
  if (!WIN && process.getuid?.() !== 0) { // a write error fails the download instead of crashing the process
    const ro = join(d, "ro"); mkdirSync(ro); chmodSync(ro, 0o500);
    await assert.rejects(downloadModel(ro, m, fake), /EACCES|permission/i); chmodSync(ro, 0o700);
  }
});

// ---- endpoints, with stand-in engines ----
let h, base, data, bin, argLog;
before(async () => {
  data = mkdtempSync(join(tmpdir(), "hvdata-")); bin = mkdtempSync(join(tmpdir(), "hvbin-")); argLog = join(bin, "args.txt");
  if (!WIN) {
    // whisper-cli stand-in: records its arguments and whether the input file exists, prints a transcript
    writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nf=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done\necho "$f $(test -f "$f" && echo present)" > "${argLog}"\necho " [BLANK_AUDIO]"\necho " Hello world."\n`);
    writeFileSync(join(bin, "espeak-ng"), `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-w" ] && out="$2"; shift; done\nprintf 'RIFFfakeWAVEdata' > "$out"\n`);
    chmodSync(join(bin, "whisper-cli"), 0o755); chmodSync(join(bin, "espeak-ng"), 0o755);
  }
  mkdirSync(join(data, "models")); writeFileSync(join(data, "models", "ggml-base.en-q5_1.bin"), "model");
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: data, HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`;
  h.voice = new Voice(data, { HEARTH_WHISPER_BIN: join(bin, "whisper-cli") }, "linux");
  await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { await h?.close(); });
const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", ...headers }, body });

test("GET /api/voice says what this computer can do; /api/me advertises voice", { skip: WIN && "shell stand-ins" }, async () => {
  const c = await (await fetch(base + "/api/voice")).json();
  assert.equal(c.stt.available, true); assert.equal(c.stt.engine, "whisper.cpp"); assert.equal(c.stt.model, "ggml-base.en-q5_1.bin");
  assert.equal(c.tts.available, true); assert.equal(c.tts.engine, "espeak-ng");
  assert.equal(c.limits.maxBytes, MAX_AUDIO_BYTES);
  assert.equal((await (await fetch(base + "/api/me")).json()).voice, true);
});

test("POST /api/voice/transcribe: CSRF, type, size and length limits; text back; temp file deleted", { skip: WIN && "shell stand-ins" }, async () => {
  let r = await fetch(base + "/api/voice/transcribe", { method: "POST", headers: { origin: base, "content-type": "audio/wav" }, body: wav(1) });
  assert.equal(r.status, 403, "no CSRF header");
  r = await post("/api/voice/transcribe", wav(1), { "content-type": "application/octet-stream" }); assert.equal(r.status, 415);
  r = await post("/api/voice/transcribe", Buffer.from("x".repeat(100)), { "content-type": "audio/wav" }); assert.equal(r.status, 415);
  r = await post("/api/voice/transcribe", Buffer.alloc(MAX_AUDIO_BYTES + 10), { "content-type": "audio/wav" }); assert.equal(r.status, 413);
  r = await post("/api/voice/transcribe", wav(125), { "content-type": "audio/wav" }); assert.equal(r.status, 413, "over 120 s");
  r = await post("/api/voice/transcribe", wav(2), { "content-type": "audio/wav" });
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.text, "Hello world."); assert.ok(Math.abs(j.seconds - 2) < 0.01);
  const [file, present] = readFileSync(argLog, "utf8").trim().split(" ");
  assert.equal(present, "present", "the engine got the recording"); assert.ok(!existsSync(file), "and it was deleted afterwards");
  r = await post("/api/voice/transcribe", wav(0.1), { "content-type": "audio/wav" }); assert.equal((await r.json()).text, "", "too short to bother");
});

test("POST /api/voice/speak returns audio from this computer's engine; empty text is refused", { skip: WIN && "shell stand-ins" }, async () => {
  let r = await post("/api/voice/speak", JSON.stringify({ text: "Hello from Hearth." }), { "content-type": "application/json" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "audio/wav"); assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "RIFFfakeWAVEdata");
  r = await post("/api/voice/speak", JSON.stringify({ text: "   " }), { "content-type": "application/json" }); assert.equal(r.status, 400);
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("hearth-voice-")).length, 0, "no temp dirs left");
});

test("without whisper.cpp: 501 for transcribe, install refused on Linux without it; HEARTH_VOICE=off hides it all", async () => {
  const saved = h.voice;
  h.voice = new Voice(mkdtempSync(join(tmpdir(), "hvnone-")), { HEARTH_WHISPER_BIN: join(bin, "missing") }, "linux");
  try {
    const c = await (await fetch(base + "/api/voice")).json();
    assert.equal(c.stt.available, false); assert.deepEqual(c.stt.missing, ["whisper.cpp", "a speech model"]); assert.equal(c.stt.canInstall, false);
    assert.equal((await post("/api/voice/transcribe", wav(1), { "content-type": "audio/wav" })).status, 501);
    assert.equal((await post("/api/voice/install", "")).status, 409);
    h.voice = null;
    assert.equal((await fetch(base + "/api/voice")).status, 404);
    assert.equal((await (await fetch(base + "/api/me")).json()).voice, false);
  } finally { h.voice = saved; }
  assert.equal(configFromEnv({ HEARTH_VOICE: "off" }).voice, false); assert.equal(configFromEnv({}).voice, true);
});

// ---- web/voice.js ----
test("speakable: final reply text only, code, diffs, links and markup left out", () => {
  const md = "## Summary\nI fixed the **parser** bug in `tokenize()`. See [the docs](https://x.example/z).\n\n```js\nconst a = 1;\n```\n\n- Added tests\n- Ran the linter\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ndiff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n\nVisit https://example.com now. ![img](a.png) Done!";
  assert.equal(HV.speakable(md), "Summary. I fixed the parser bug in tokenize(). See the docs. (code omitted) Added tests. Ran the linter. a, b. 1, 2. (diff omitted) Visit (link) now. Done!");
  assert.equal(HV.speakable("```\nonly code\n```"), "Code omitted.");
  assert.equal(HV.speakable("Streaming ```js\nconst partial"), "Streaming (code omitted)");
  assert.equal(HV.speakable("- a\n- b\n+ c"), "a. b. c.", "a list is not a diff");
  assert.equal(HV.speakable("Values -1 and +2, file_name_here and *this*."), "Values -1 and +2, file_name_here and this.");
  assert.equal(HV.speakable("Run `" + "x".repeat(60) + "` now"), "Run (code) now");
  assert.equal(HV.speakable(""), "");
  const long = HV.speakable("This is a sentence. ".repeat(400), 1000);
  assert.ok(long.length < 1040 && long.endsWith("The rest is on screen."));
});

test("splitSentences, pickVoice, WAV encoding and downsampling", () => {
  const parts = HV.splitSentences("Hello there. This is a test! " + "word ".repeat(80) + "end.");
  assert.ok(parts.every((p) => p.length <= 220)); assert.equal(parts[0], "Hello there. This is a test!");
  const id = "x".repeat(500); assert.equal(HV.splitSentences(id).join(""), id, "a long word loses no characters");
  const commas = "alpha, ".repeat(60).trim(); assert.equal(HV.splitSentences(commas).join(" ").replace(/\s+/g, " "), commas);
  const voices = [
    { name: "Albert", lang: "en-US", localService: true, voiceURI: "a" }, { name: "Samantha (Compact)", lang: "en-US", localService: true, voiceURI: "s" },
    { name: "Google US English", lang: "en-US", localService: false, voiceURI: "g" }, { name: "Ava (Premium)", lang: "en-US", localService: true, voiceURI: "ava" },
    { name: "Thomas", lang: "fr-FR", localService: true, voiceURI: "t" }];
  assert.equal(HV.pickVoice(voices, "en-US").voiceURI, "ava");
  assert.equal(HV.pickVoice(voices.slice(0, 3), "en-GB").voiceURI, "s", "same language, on-device over online, never novelty voices");
  assert.equal(HV.pickVoice(voices, "en-US", "g").voiceURI, "g", "your choice wins");
  assert.equal(HV.pickVoice(voices, "de-DE"), null);
  const down = HV.downsample(new Float32Array(48000).fill(0.5), 48000, 16000); assert.equal(down.length, 16000); assert.ok(Math.abs(down[100] - 0.5) < 1e-6);
  const w = parseWav(Buffer.from(HV.encodeWav(down))); assert.equal(w.seconds, 1);
  assert.equal(HV.joinDictation("Fix the", "parser please"), "Fix the parser please"); assert.equal(HV.joinDictation("", " hi "), "hi"); assert.equal(HV.joinDictation("x ", ""), "x ");
  assert.ok(Math.abs(HV.rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9);
});

test("one voice job at a time: requests wait their turn (no overlap); beyond three, busy", { skip: WIN && "shell stand-ins" }, async () => {
  const d = mkdtempSync(join(tmpdir(), "hvslot-")), lock = join(d, "lock"), log = join(d, "overlap");
  writeFileSync(join(d, "whisper-cli"), `#!/bin/sh\n[ -e "${lock}" ] && echo overlap >> "${log}"\ntouch "${lock}"\nsleep 0.3\nrm -f "${lock}"\necho " ok"\n`); chmodSync(join(d, "whisper-cli"), 0o755);
  mkdirSync(join(d, "models")); writeFileSync(join(d, "models", "ggml-base.en-q5_1.bin"), "m");
  const v = new Voice(d, { HEARTH_WHISPER_BIN: join(d, "whisper-cli") }, "linux");
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => v.transcribe(wav(1))));
  assert.deepEqual(rs.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled", "rejected", "rejected"]);
  assert.equal(rs[3].reason.status, 429);
  assert.ok(!existsSync(log), "never two engines at once");
  assert.equal((await v.transcribe(wav(1))).text, "ok", "free again afterwards");
});
