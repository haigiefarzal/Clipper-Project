// Audio: volume standar (LUFS), momen heboh (zoom kejut), potong jeda, dan campuran SFX + musik.
// Port dari engine_audio.py (KlipKu PC). Semua di browser, tanpa server.

export const SR = 48000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dbToGain = (db) => Math.pow(10, db / 20);

// ------------------------------------------------------------------ analisis file SFX / musik
/** Gain (dB) supaya rata-rata kerasnya sekitar -16 dB tanpa pecah (sama seperti volumedetect di PC). */
export function analyzeGain(buf) {
  let sum = 0, peak = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = d[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    n += d.length;
  }
  if (!n || peak <= 0) return 0;
  const mean = 10 * Math.log10(sum / n + 1e-12);
  const max = 20 * Math.log10(peak);
  return Math.round(Math.max(-15, Math.min(-16 - mean, -1 - max, 12)) * 100) / 100;
}

/** Decode file audio jadi AudioBuffer 48 kHz stereo. */
export async function decodeFile(blob) {
  const raw = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, SR, SR);
  const buf = await ctx.decodeAudioData(raw);
  if (buf.sampleRate === SR && buf.numberOfChannels === 2) return buf;
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(buf.duration * SR)), SR);
  const n = off.createBufferSource();
  n.buffer = buf; n.connect(off.destination); n.start();
  return off.startRendering();
}

// ------------------------------------------------------------------ LUFS (ITU-R BS.1770)
function biquad(x, b, a) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Kekerasan terintegrasi (LUFS) audio 48 kHz. null kalau senyap. */
export function lufs(buf) {
  if (!buf || buf.sampleRate !== SR) return null;
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    let d = buf.getChannelData(c);
    d = biquad(d, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
    d = biquad(d, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
    chans.push(d);
  }
  const block = Math.round(0.4 * SR), step = Math.round(0.1 * SR);
  const ms = [];
  for (let s = 0; s + block <= buf.length; s += step) {
    let z = 0;
    for (const d of chans) { let a = 0; for (let i = s; i < s + block; i++) a += d[i] * d[i]; z += a / block; }
    ms.push(z);
  }
  if (!ms.length) return null;
  const L = (z) => -0.691 + 10 * Math.log10(z + 1e-12);
  const abs = ms.filter((z) => L(z) > -70);
  if (!abs.length) return null;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  const v = L(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length));
  return v > -70 ? v : null;
}

// ------------------------------------------------------------------ amplop (16 kHz mono)
function envelopeDb(mono, rate = 16000, hopS = 0.05) {
  const hop = Math.round(rate * hopS);
  const n = Math.max(1, Math.floor(mono.length / hop));
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += mono[k] * mono[k];
    db[i] = 20 * Math.log10(Math.sqrt(s / hop + 1e-10) + 1e-9);
  }
  return { db, hop: hopS };
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))] : 0; };
const median = (arr) => pct(arr, 50);

/** Momen paling keras/heboh -> waktu mulai (detik dalam clip). */
export function loudMoments(mono, { maxN = 4, minGap = 4, thrDb = 9 } = {}) {
  if (!mono) return [];
  const { db, hop } = envelopeDb(mono);
  if (db.length < 10) return [];
  const k = Math.max(1, Math.round(0.25 / hop));
  const sm = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) {
    let s = 0;
    for (let j = i - Math.floor((k - 1) / 2); j <= i + Math.ceil((k - 1) / 2); j++) if (j >= 0 && j < db.length) s += db[j];
    sm[i] = s / k;
  }
  const p20 = pct(sm, 20);
  const voiced = [...sm].filter((v) => v > p20);
  const base = voiced.length ? median(voiced) : median(sm);
  const cand = [];
  for (let i = 1; i < sm.length - 1; i++) if (sm[i] >= base + thrDb && sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1]) cand.push([sm[i], i]);
  cand.sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const [, i] of cand) {
    const t = i * hop;
    if (picked.some((p) => Math.abs(t - p) < minGap)) continue;
    picked.push(t);
    if (picked.length >= maxN) break;
  }
  return picked.sort((a, b) => a - b).map((tp) => {
    const i = Math.round(tp / hop);
    let j = i;
    while (j > 0 && sm[j - 1] >= base + thrDb * 0.5 && (i - j) * hop < 1.0) j--;
    return Math.max(0, j * hop - 0.05);
  });
}

/** Bagian yang ada suaranya: dari kata Whisper (paling tepat) atau dari energi audio. */
export function speechSpans(words, mono, pad = 0.15) {
  if (words?.length) return words.map((w) => [Math.max(0, w.s - pad), w.e + pad]);
  if (!mono) return [];
  const { db, hop } = envelopeDb(mono);
  const thr = pct(db, 35) + 6;
  const spans = [];
  let on = null;
  for (let i = 0; i < db.length; i++) {
    if (db[i] >= thr && on == null) on = i;
    else if (db[i] < thr && on != null) { spans.push([Math.max(0, on * hop - pad), i * hop + pad]); on = null; }
  }
  if (on != null) spans.push([Math.max(0, on * hop - pad), db.length * hop]);
  return spans;
}

/** Potong jeda: buang bagian sepi > minGap detik. -> [[mulai, selesai]] dalam clip. */
export function keepParts(spans, dur, minGap = 0.8, minPart = 0.4) {
  if (!spans.length) return [[0, dur]];
  const sp = spans.map(([a, b]) => [Math.max(0, a), Math.min(dur, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  if (!sp.length) return [[0, dur]];
  const merged = [[...sp[0]]];
  for (const [a, b] of sp.slice(1)) {
    const last = merged[merged.length - 1];
    if (a - last[1] <= minGap) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged[0][0] <= minGap) merged[0][0] = 0;
  if (dur - merged[merged.length - 1][1] <= minGap) merged[merged.length - 1][1] = dur;
  const parts = merged.filter(([a, b]) => b - a >= minPart);
  return parts.length ? parts : [[0, dur]];
}

// ------------------------------------------------------------------ campuran akhir
/**
 * base: AudioBuffer 48 kHz stereo (timeline hasil) atau null.
 * sfx: [{buf, t, vol, len, gain}] waktu dalam timeline hasil.
 * music: {buf, vol (0..1), duck, gain} atau null.
 */
export function mix({ base, outDur, sfx = [], music = null, duckDepth = 0.45, baseGainDb = 0 }) {
  const N = Math.max(1, Math.round(outDur * SR));
  const L = new Float32Array(N), R = new Float32Array(N);
  const has = !!base;
  if (has) {
    const g = dbToGain(baseGainDb);
    const bl = base.getChannelData(0), br = base.getChannelData(base.numberOfChannels > 1 ? 1 : 0);
    const n = Math.min(N, base.length);
    for (let i = 0; i < n; i++) { L[i] = bl[i] * g; R[i] = br[i] * g; }
    // suara asli mengecil saat SFX bunyi
    const spans = sfx.slice(0, 40).map((e) => [e.t, e.t + e.len]);
    if (spans.length && duckDepth < 0.99) {
      const m = new Float32Array(N);
      for (const [a, b] of spans) {
        const i0 = Math.max(0, Math.floor(a * SR)), i1 = Math.min(N, Math.ceil(b * SR));
        for (let i = i0; i < i1; i++) {
          const t = i / SR;
          const v = clamp((t - a) / 0.06, 0, 1) * clamp((b - t) / 0.15, 0, 1);
          if (v > m[i]) m[i] = v;
        }
      }
      for (let i = 0; i < N; i++) if (m[i] > 0) { const g2 = 1 - (1 - duckDepth) * m[i]; L[i] *= g2; R[i] *= g2; }
    }
  }
  if (music?.buf) {
    const ml = music.buf.getChannelData(0), mr = music.buf.getChannelData(music.buf.numberOfChannels > 1 ? 1 : 0);
    const len = music.buf.length;
    const g = dbToGain(music.gain || 0) * Math.max(0, music.vol);
    const fade = Math.min(1.5, outDur / 4);
    const fadeOutAt = Math.max(0, outDur - fade);
    // sidechain: musik mengecil saat ada suara di audio utama (threshold 0.025, rasio 8)
    const atk = Math.exp(-1 / (0.02 * SR)), rel = Math.exp(-1 / (0.4 * SR));
    const thrDb = 20 * Math.log10(0.025);
    let env = 0;
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      let gg = g * Math.min(1, t / 0.5);
      if (t > fadeOutAt) gg *= Math.max(0, (outDur - t) / fade);
      if (music.duck && has) {
        const lvl = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        env = lvl > env ? atk * env + (1 - atk) * lvl : rel * env + (1 - rel) * lvl;
        const ed = 20 * Math.log10(env + 1e-9);
        if (ed > thrDb) gg *= dbToGain(thrDb + (ed - thrDb) / 8 - ed);
      }
      const k = i % len;
      L[i] += ml[k] * gg; R[i] += mr[k] * gg;
    }
  }
  for (const e of sfx) {
    const sl = e.buf.getChannelData(0), sr = e.buf.getChannelData(e.buf.numberOfChannels > 1 ? 1 : 0);
    const dur = e.buf.length / SR;
    const lenS = Math.min(e.buf.length, Math.round(e.len * SR));
    const trim = e.len < dur - 0.05;
    const fadeStart = Math.max(0, e.len - 0.25);
    const g = dbToGain(e.gain || 0) * Math.max(0, e.vol);
    const off = Math.round(Math.max(0, e.t) * SR);
    for (let k = 0; k < lenS && off + k < N; k++) {
      let gg = g;
      if (trim) { const t = k / SR; if (t > fadeStart) gg *= Math.max(0, (e.len - t) / 0.25); }
      L[off + k] += sl[k] * gg; R[off + k] += sr[k] * gg;
    }
  }
  limit(L, R, 0.89);
  const out = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: SR });
  out.copyToChannel(L, 0); out.copyToChannel(R, 1);
  return out;
}

/** Limiter puncak (seperti alimiter limit=0.89): tidak ada yang pecah. */
function limit(L, R, ceiling) {
  const B = Math.round(0.005 * SR);
  const nb = Math.ceil(L.length / B);
  const req = new Float32Array(nb).fill(1);
  for (let b = 0; b < nb; b++) {
    let pk = 0;
    for (let i = b * B; i < Math.min(L.length, (b + 1) * B); i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    req[b] = pk > ceiling ? ceiling / pk : 1;
  }
  const gains = new Float32Array(nb + 1);
  const relK = 1 - Math.exp(-0.005 / 0.06);
  let g = 1;
  for (let b = 0; b < nb; b++) {
    const target = Math.min(req[b], b + 1 < nb ? req[b + 1] : 1);
    g = target < g ? target : g + (target - g) * relK;
    gains[b] = Math.min(g, req[b]);
  }
  gains[nb] = gains[nb - 1];
  for (let b = 0; b < nb; b++) {
    const g0 = b ? Math.min(gains[b - 1], gains[b]) : gains[0], g1 = gains[b];
    for (let i = b * B, k = 0; i < Math.min(L.length, (b + 1) * B); i++, k++) {
      const gg = g0 + ((g1 - g0) * k) / B;
      L[i] *= gg; R[i] *= gg;
    }
  }
}
