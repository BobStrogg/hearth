"use strict";
// Voice helpers with no DOM access (unit-tested in Node): reply text for text-to-speech, sentence chunks, voice
// choice, and 16 kHz mono WAV encoding for the recorder fallback. The UI wiring lives in app.js.
(function (root) {
  const OMIT_CODE = " (code omitted) ";
  const OMIT_DIFF = " (diff omitted) ";
  /** Markdown reply -> plain text worth hearing: code blocks, diffs, tables' rules, images and URLs are dropped. */
  function speakable(md, max = 4000) {
    let s = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
    // fenced code (an unclosed fence at the end counts too: the reply may still be streaming)
    s = s.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, `$1${OMIT_CODE}\n`);
    s = s.replace(/```[\s\S]*?(```|$)/g, OMIT_CODE); // a fence that doesn't start its own line
    const lines = s.split("\n"), out = [];
    for (let i = 0; i < lines.length; i++) {
      // a run of 3+ diff-looking lines (unified diff, +/- lines) outside a fence
      if (/^(diff --git |@@ |\+\+\+ |--- a\/|[+-](?![-+\s]*$)\S?)/.test(lines[i])) {
        let j = i; while (j < lines.length && /^(diff --git |index [0-9a-f]|@@ |\+\+\+ |--- |[+-]| )/.test(lines[j]) && lines[j].trim() !== "") j++;
        const run = lines.slice(i, j), diffy = run.filter((l) => /^(diff --git |@@ |\+\+\+ |--- a\/)/.test(l)).length;
        const pm = run.every((l) => /^[+-]/.test(l)) && run.some((l) => /^-/.test(l)) && run.some((l) => /^\+/.test(l)) && run.some((l) => /^[+-]\S/.test(l));
        if (j - i >= 3 && (diffy || pm)) { out.push(OMIT_DIFF); i = j - 1; continue; }
      }
      let l = lines[i];
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)) continue;    // table rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) continue;                          // horizontal rule
      if (/\|/.test(l) && /^\s*\|.*\|\s*$/.test(l)) l = l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".";
      const block = /^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(l);
      l = l.replace(/^\s*(#{1,6}\s+|(>\s?)+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "");
      if (block && l.trim() && !/[.!?:;,…]\s*$/.test(l)) l += ".";                   // a pause after list items and headings
      out.push(l);
    }
    s = out.join("\n")
      .replace(/<\/?[a-z][^>\n]*>/gi, " ")                                          // HTML tags
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, " ")                                      // images
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")                         // [text](url) -> text
      .replace(/<?\bhttps?:\/\/[^\s)>\]]+>?/gi, " (link) ")                          // bare URLs
      .replace(/`{1,2}([^`\n]+)`{1,2}/g, (all, c) => (c.length <= 40 ? c : " (code) ")) // inline code
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")                               // bold
      .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,!?:;]|$)/g, "$1$2")      // italics
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/(\s*\((code|diff) omitted\)\s*)+/g, (m) => ` (${/diff/.test(m) && !/code/.test(m) ? "diff" : "code"} omitted) `)
      .replace(/\s+/g, " ").trim();
    if (s.replace(/\((code|diff) omitted\)|\(link\)|[\s.,]/g, "") === "") return s ? "Code omitted." : "";
    if (s.length > max) {
      let cut = s.slice(0, max); const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      if (end > max * 0.6) cut = cut.slice(0, end + 1);
      s = `${cut.trim()} … The rest is on screen.`;
    }
    return s;
  }
  /** Chunks of at most `max` characters, split at sentence ends, then commas, then spaces (long utterances stall in Chrome). */
  function splitSentences(text, max = 220) {
    const parts = String(text || "").match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [];
    const out = [];
    for (let p of parts) {
      p = p.trim(); if (!p) continue;
      while (p.length > max) {
        let at = p.lastIndexOf(", ", max - 1), skip = 2; // keep the comma, drop the space
        if (at < max / 3) { at = p.lastIndexOf(" ", max); skip = 1; if (at >= max / 3) { out.push(p.slice(0, at).trim()); p = p.slice(at + skip).trim(); continue; } }
        if (at < max / 3) { out.push(p.slice(0, max)); p = p.slice(max); continue; } // no break point: cut, losing nothing
        out.push(p.slice(0, at + 1).trim()); p = p.slice(at + skip).trim();
      }
      if (p) out.push(p);
    }
    // merge tiny pieces so speech doesn't stutter
    const merged = [];
    for (const p of out) { const last = merged[merged.length - 1]; if (last && last.length + p.length + 1 <= Math.min(max, 120)) merged[merged.length - 1] = `${last} ${p}`; else merged.push(p); }
    return merged;
  }
  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Princess|Pipe Organ)\b/i;
  /** The best voice for `lang`: on-device first (private), premium/enhanced/neural over compact, no novelty voices. */
  function pickVoice(voices, lang, preferredURI) {
    const list = Array.from(voices || []);
    if (preferredURI) { const v = list.find((x) => x.voiceURI === preferredURI); if (v) return v; }
    const want = String(lang || "en-US").toLowerCase().replace("_", "-"), base = want.split("-")[0];
    let best = null, bestScore = -Infinity;
    for (const v of list) {
      const vl = String(v.lang || "").toLowerCase().replace("_", "-");
      if (vl.split("-")[0] !== base) continue;
      let sc = vl === want ? 3 : 0;
      const n = String(v.name || "");
      if (/premium/i.test(n)) sc += 8; else if (/enhanced|neural|natural/i.test(n)) sc += 6; else if (/siri/i.test(n)) sc += 5;
      if (v.localService !== false) sc += 4; else sc -= 2; // network voices send the text to the browser's vendor
      if (/compact|eloquence/i.test(n)) sc -= 3;
      if (NOVELTY.test(n)) sc -= 20;
      if (v.default) sc += 1;
      if (sc > bestScore) { best = v; bestScore = sc; }
    }
    return best;
  }
  /** Average-downsample mono float samples to `outRate` (16 kHz for whisper.cpp). */
  function downsample(samples, inRate, outRate = 16000) {
    if (inRate === outRate) return samples;
    if (inRate < outRate) throw new Error("input rate below output rate");
    const ratio = inRate / outRate, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = a; j < b; j++) sum += samples[j];
      out[i] = b > a ? sum / (b - a) : 0;
    }
    return out;
  }
  /** 16-bit PCM mono WAV (ArrayBuffer). */
  function encodeWav(samples, rate = 16000) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return buf;
  }
  function rms(samples) { let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]; return Math.sqrt(s / (samples.length || 1)); }
  /** Concatenate Float32Array chunks. */
  function concat(chunks) { let n = 0; for (const c of chunks) n += c.length; const out = new Float32Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
  /** Dictated text appended to what is already in the box (one space between). */
  function joinDictation(base, said) { const t = String(said || "").trim(); if (!t) return base; return base && !/\s$/.test(base) ? `${base} ${t}` : `${base}${t}`; }
  const api = { speakable, splitSentences, pickVoice, downsample, encodeWav, rms, concat, joinDictation };
  root.HearthVoice = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
