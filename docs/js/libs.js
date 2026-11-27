// Versi engine dikunci supaya hasil selalu sama dan tidak rusak karena update.
// "mediabunny" dipetakan lewat import map di index.html (dipakai juga oleh encoder AAC).
export const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.5/dist/bundles/mediabunny.min.mjs';
export const AAC_URL = 'https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.66.5/dist/bundles/mediabunny-aac-encoder.min.mjs';
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
export const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs';
export const ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';

let mbPromise = null;
export function loadMediabunny() {
  mbPromise ??= (async () => {
    const mb = await import('mediabunny');
    // Browser tanpa encoder AAC bawaan (Firefox, Safari lama): pakai encoder AAC versi WebAssembly.
    try {
      if (!(await mb.canEncodeAudio('aac'))) {
        const aac = await import(AAC_URL);
        aac.registerAacEncoder();
      }
    } catch { /* tetap jalan, nanti pakai Opus atau tanpa suara */ }
    return mb;
  })().catch((e) => {
    mbPromise = null;
    throw new Error('Mesin video gagal dimuat. Cek koneksi internet lalu coba lagi. (' + e.message + ')');
  });
  return mbPromise;
}

let ortPromise = null;
export function loadOrt() {
  ortPromise ??= import(ORT_URL).then((m) => {
    const ort = m.default ?? m;
    ort.env.wasm.wasmPaths = ORT_WASM_DIR;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    return ort;
  }).catch((e) => {
    ortPromise = null;
    throw new Error('Mesin AI kamera gagal dimuat. Cek koneksi internet. (' + e.message + ')');
  });
  return ortPromise;
}
