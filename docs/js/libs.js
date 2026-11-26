// Versi engine dikunci (pinned) supaya hasil selalu sama dan tidak rusak karena update.
export const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.5/dist/bundles/mediabunny.min.mjs';
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
export const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs';
export const ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';

let mbPromise = null;
export function loadMediabunny() {
  mbPromise ??= import(MEDIABUNNY_URL).catch((e) => {
    mbPromise = null;
    throw new Error('Gagal memuat mesin video (Mediabunny). Cek koneksi internet lalu coba lagi. ' + e.message);
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
    throw new Error('Gagal memuat mesin AI kamera (ONNX Runtime). Cek koneksi internet. ' + e.message);
  });
  return ortPromise;
}
