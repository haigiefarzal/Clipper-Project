// Whisper di browser (Transformers.js) — berjalan di Web Worker supaya halaman tetap lancar.
import { TRANSFORMERS_URL } from './libs.js';

let lib = null;
let asr = null;
let loadedKey = '';

async function getPipeline(model, device, dtype) {
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
  if (asr && key === loadedKey) return asr;
  if (asr) { try { await asr.dispose(); } catch { /* abaikan */ } asr = null; loadedKey = ''; }
  lib ??= await import(TRANSFORMERS_URL);
  lib.env.allowLocalModels = false;
  lib.env.useBrowserCache = true;
  const files = {};
  asr = await lib.pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files[p.file] = [p.loaded, p.total];
        let L = 0, T = 0;
        for (const [l, t] of Object.values(files)) { L += l; T += t; }
        postMessage({ type: 'load', loaded: L, total: T });
      }
    },
  });
  loadedKey = key;
  return asr;
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type !== 'run') return;
  try {
    const pipe = await getPipeline(msg.model, msg.device, msg.dtype);
    postMessage({ type: 'ready' });
    const words = [];
    const opts = { task: 'transcribe', return_timestamps: 'word' };
    if (msg.language) opts.language = msg.language;
    for (let i = 0; i < msg.pieces.length; i++) {
      const pc = msg.pieces[i];
      const out = await pipe(pc.data, opts);
      for (const c of out.chunks || []) {
        const t = String(c.text || '').trim();
        if (!t) continue;
        let [s, e] = c.timestamp || [];
        if (s == null || Number.isNaN(s)) continue;
        if (e == null || Number.isNaN(e) || e < s) e = s + 0.3;
        words.push({ s: s + pc.start, e: e + pc.start, t });
      }
      postMessage({ type: 'progress', done: i + 1, total: msg.pieces.length });
    }
    words.sort((a, b) => a.s - b.s);
    postMessage({ type: 'done', words });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
