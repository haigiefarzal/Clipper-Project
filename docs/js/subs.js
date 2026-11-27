// Subtitle: kamus ganti, kata khusus (koreksi bunyi), potongan per baris, koreksi AI, Groq.
// Port dari engine_subs.py.

export const parseTerms = (text) => String(text || '').split(/[,\n;]+/).map((t) => t.trim()).filter((t) => t.length >= 2);

export function parseRules(text) {
  const rules = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*(?:=>|->|=)\s*(.+?)\s*$/);
    if (m && m[1] && m[2]) rules.push([m[1], m[2]]);
  }
  return rules;
}

const bare = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
const tailPunct = (t) => (String(t).match(/[^\p{L}\p{N}_]+$/u) || [''])[0];

export function phon(s) {
  s = bare(s);
  for (const [a, b] of [['ph', 'f'], ['kh', 'k'], ['sy', 's'], ['ch', 'c'], ['oo', 'u'], ['ou', 'u'], ['ee', 'i'],
    ['ea', 'i'], ['v', 'f'], ['z', 's'], ['q', 'k'], ['x', 'ks'], ['c', 'k'], ['y', 'i'], ['l', 'r'],
    ['w', 'u'], ['e', 'a']]) s = s.split(a).join(b);
  return s.replace(/(.)\1+/gu, '$1');
}

function replaceWords(words, i, n, newText) {
  const first = words[i], last = words[i + n - 1];
  const merged = { s: first.s, e: last.e, t: newText + tailPunct(last.t) };
  return [...words.slice(0, i), merged, ...words.slice(i + n)];
}

export function applyRules(words, rules) {
  let fixes = 0;
  for (const [src, dst] of rules) {
    const key = src.split(/\s+/).map(bare);
    const n = key.length;
    if (!n || !key.every(Boolean)) continue;
    let i = 0;
    while (i <= words.length - n) {
      if (words.slice(i, i + n).every((w, k) => bare(w.t) === key[k])) { words = replaceWords(words, i, n, dst); fixes++; }
      i++;
    }
  }
  return [words, fixes];
}

/** difflib.SequenceMatcher(None, a, b).ratio() (Ratcliff/Obershelp). */
function ratio(a, b) {
  const matches = (a0, a1, b0, b1) => {
    let best = 0, bi = 0, bj = 0;
    for (let i = a0; i < a1; i++) {
      for (let j = b0; j < b1; j++) {
        let k = 0;
        while (i + k < a1 && j + k < b1 && a[i + k] === b[j + k]) k++;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    if (!best) return 0;
    return best + matches(a0, bi, b0, bj) + matches(bi + best, a1, bj + best, b1);
  };
  const T = a.length + b.length;
  return T ? (2 * matches(0, a.length, 0, b.length)) / T : 1;
}

const FIRST = { b: 'p', d: 't', g: 'k', j: 'c' };
const f1 = (c) => FIRST[c] || c;

export function applyTerms(words, terms, threshold = 0.8) {
  let fixes = 0;
  for (const term of terms) {
    const tw = term.split(/\s+/);
    const target = phon(term);
    if (target.length < 4) continue;
    const sizes = [...new Set([tw.length, tw.length + 1, Math.max(1, tw.length - 1)])].sort((a, b) => a - b);
    let i = 0;
    while (i < words.length) {
      let best = null; // [r, -n, n]
      for (const n of sizes) {
        if (i + n > words.length) continue;
        const win = words.slice(i, i + n);
        const raw = win.map((w) => w.t).join(' ');
        let r;
        if (bare(raw.replace(/ /g, '')) === bare(term.replace(/ /g, ''))) r = 1.01;
        else {
          const cand = phon(win.map((w) => w.t).join(''));
          if (!cand || f1(cand[0]) !== f1(target[0]) || cand.length < 4 || Math.abs(cand.length - target.length) > 3) continue;
          r = ratio(cand, target);
        }
        if (r >= threshold && (!best || r > best[0] || (r === best[0] && -n > best[1]))) best = [r, -n, n];
      }
      if (best) {
        const n = best[2];
        const raw = words.slice(i, i + n).map((w) => w.t).join(' ');
        if (raw.replace(/[.,!?]+$/, '') !== term) {
          words = replaceWords(words, i, n, term);
          if (best[0] <= 1.0) fixes++;
        }
      }
      i++;
    }
  }
  return [words, fixes];
}

export function makeChunks(words, perLine, maxChars) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= perLine || cur.reduce((s, x) => s + x.t.length + 1, 0) + w.t.length > maxChars
      || w.s - cur[cur.length - 1].e > 0.7 || '.?!'.includes(cur[cur.length - 1].t.slice(-1)))) {
      chunks.push(cur); cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => ({ start: c[0].s, end: c[c.length - 1].e, text: c.map((x) => x.t).join(' '), words: c }));
}

export function applyEdits(chunks, edited) {
  const out = [];
  edited.forEach((e, i) => {
    const text = String(e.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const start = +e.start, end = +e.end;
    const orig = chunks[i];
    const toks = text.split(' ');
    let words;
    if (orig && orig.words.length === toks.length) words = orig.words.map((w, k) => ({ ...w, t: toks[k] }));
    else {
      const step = (end - start) / toks.length;
      words = toks.map((t, k) => ({ s: start + k * step, e: start + (k + 1) * step, t }));
    }
    out.push({ start, end, text, words });
  });
  return out;
}

/** Susun ulang subtitle mengikuti timeline output (intro teaser + ulang). */
export function shiftChunks(chunks, segs) {
  const out = [];
  for (const sg of segs) {
    if (sg.kind !== 'play') continue;
    const a = sg.src, b = sg.src + sg.dur, off = sg.out - sg.src;
    for (const c of chunks) {
      const ws = c.words.filter((w) => a - 0.05 <= w.s && w.s < b).map((w) => ({ ...w, s: w.s + off, e: Math.min(w.e, b) + off }));
      if (ws.length) out.push({ start: ws[0].s, end: ws[ws.length - 1].e, text: ws.map((w) => w.t).join(' '), words: ws });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

// ------------------------------------------------------------------ audio helpers
export function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Potong audio 16 kHz jadi bagian <= 28 dtk, dipotong di bagian paling sepi supaya kata tidak terbelah. */
export function splitForWhisper(audio, rate = 16000, maxLen = 28) {
  const pieces = [];
  const hop = Math.round(rate * 0.05);
  let start = 0;
  while (start < audio.length) {
    let end = Math.min(audio.length, start + Math.round(maxLen * rate));
    if (end < audio.length) {
      const from = start + Math.round(maxLen * 0.6 * rate);
      let best = end, bestE = Infinity;
      for (let p = from; p + hop <= end; p += hop) {
        let e = 0;
        for (let k = p; k < p + hop; k++) e += audio[k] * audio[k];
        if (e < bestE) { bestE = e; best = p + Math.floor(hop / 2); }
      }
      end = best;
    }
    if (end - start > rate * 0.3) pieces.push({ start: start / rate, data: audio.slice(start, end) });
    start = end;
  }
  return pieces;
}

// ------------------------------------------------------------------ Groq (Whisper online)
export async function groqTranscribe(wav, key, model, lang, terms) {
  const fd = new FormData();
  fd.append('file', wav, 'clip.wav');
  fd.append('model', model === 'large-v3' ? 'whisper-large-v3' : 'whisper-large-v3-turbo');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('temperature', '0');
  if (lang && lang !== 'auto') fd.append('language', lang);
  if (terms.length) fd.append('prompt', terms.join(', ').slice(0, 800));
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  if (!r.ok) throw new Error(`Groq gagal (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const words = (j.words || []).map((w) => ({ s: +w.start, e: +w.end, t: String(w.word || '').trim() })).filter((w) => w.t);
  if (!words.length && j.text?.trim()) throw new Error('Groq tidak mengirim waktu per kata.');
  return words;
}

// ------------------------------------------------------------------ koreksi AI
function parseList(text, n) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Koreksi AI: jawaban tidak berisi daftar.');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || arr.length !== n) throw new Error(`Koreksi AI: jumlah baris tidak cocok (${Array.isArray(arr) ? arr.length : '?'} vs ${n}).`);
  return arr.map(String);
}

export async function aiCorrect(lines, provider, key, model, context, wav) {
  const n = lines.length;
  const prompt = 'Kamu memperbaiki subtitle otomatis dari potongan video/livestream.\n'
    + `Judul video: ${context.title || '-'}\nChannel: ${context.channel || '-'}\n`
    + `Nama/istilah penting: ${context.terms.join(', ') || '-'}\n`
    + 'Bahasanya obrolan santai (slang/gaul tetap dipertahankan).\n'
    + (wav ? 'Dengarkan AUDIO terlampir. ' : '')
    + `Di bawah ini ${n} baris subtitle berurutan (JSON). Perbaiki HANYA kata yang salah dengar `
    + '(nama orang, tempat, kampus, merek, istilah game, slang). Jangan terjemahkan, jangan parafrase, '
    + 'jangan menambah atau menghapus baris, panjang tiap baris kira-kira sama.\n'
    + `Jawab HANYA dengan JSON array berisi tepat ${n} string.\n\n${JSON.stringify(lines)}`;
  let text;
  if (provider === 'gemini') {
    const parts = [];
    if (wav) parts.push({ inline_data: { mime_type: 'audio/wav', data: await blobToBase64(wav) } });
    parts.push({ text: prompt });
    const mdl = model || 'gemini-flash-latest';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    });
    if (!r.ok) throw new Error(`Koreksi AI gagal (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) throw new Error('Koreksi AI (Gemini): jawaban kosong.');
  } else if (provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Koreksi AI gagal (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    text = (j.content || []).map((b) => b.text || '').join('');
  } else return lines;
  return parseList(text, n);
}

// ------------------------------------------------------------------ judul hook dari AI
/** 3 judul hook + caption + hashtag + detik momen puncak dari transkrip (Gemini juga mendengarkan audio). */
export async function aiHook(provider, key, model, chunks, context, wav) {
  const lines = chunks.slice(0, 220).map((c) => `[${c.start.toFixed(1)}s] ${c.text}`);
  const dur = chunks.length ? chunks[chunks.length - 1].end : 0;
  const prompt = 'Kamu editor clip TikTok Indonesia yang jago bikin judul hook.\n'
    + `Channel: ${context.channel || '-'}\nJudul video asli: ${context.title || '-'}\n`
    + `Durasi clip: ${dur.toFixed(0)} detik. Transkrip clip (detik dari awal clip):\n${lines.join('\n')}\n\n`
    + (wav ? 'Dengarkan juga AUDIO terlampir untuk menangkap reaksi (teriak, ketawa, kaget).\n' : '')
    + 'Tugas:\n'
    + '1. Buat 3 judul hook berbeda, masing-masing 4-10 kata, bahasa Indonesia santai, bikin penasaran, '
    + 'sesuai isi clip (jangan bohong/clickbait palsu), tanpa emoji, tanpa tanda pagar. Sebut nama streamer '
    + 'kalau relevan. Tandai 1-2 kata paling penting dengan bintang, contoh: MOMEN *WINDAH* KAGET.\n'
    + '2. Caption TikTok 1-2 kalimat (boleh 1 emoji).\n'
    + '3. 4-6 hashtag relevan (tanpa spasi).\n'
    + '4. Detik momen puncak (paling heboh/lucu) di dalam clip, untuk intro.\n'
    + 'Jawab HANYA JSON: {"hooks":["..","..",".."],"caption":"..","hashtags":["#..",".."],"puncak":12.5}';
  let text;
  if (provider === 'gemini') {
    const parts = [];
    if (wav) parts.push({ inline_data: { mime_type: 'audio/wav', data: await blobToBase64(wav) } });
    parts.push({ text: prompt });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-flash-latest')}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.8, responseMimeType: 'application/json' } }),
    });
    if (!r.ok) throw new Error(`Judul AI gagal (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  } else if (provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Judul AI gagal (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    text = (j.content || []).map((b) => b.text || '').join('');
  } else return null;
  let data = {};
  try { const m = String(text || '').match(/\{[\s\S]*\}/); data = m ? JSON.parse(m[0]) : {}; } catch { data = {}; }
  const hooks = (data.hooks || []).map((h) => String(h).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
  if (!hooks.length) throw new Error('Judul AI: jawaban tidak berisi judul.');
  const tags = (data.hashtags || []).map((t) => ('#' + String(t).replace(/^#+/, '')).replace(/\s+/g, '')).filter((t) => t.length > 1).slice(0, 8);
  let peak = Number(data.puncak);
  if (!(peak >= 0 && peak <= dur + 1)) peak = null;
  return { hooks, caption: String(data.caption || '').trim(), hashtags: tags, puncak: peak };
}
