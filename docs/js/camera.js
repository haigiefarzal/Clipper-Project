// AI Kamera: port langsung dari engine_camera.py (KlipKu PC).
// 1) Deteksi wajah YuNet (model ONNX yang sama) 8x per detik.  2) Lacak wajah jadi "track".
// 3) Nilai aktivitas: gerak mulut + gerak kepala, diperkuat saat ada ucapan.
// 4) "Sutradara": tetap di karakter utama, pindah ke yang bereaksi, group shot kalau muat.
// 5) Kamera pegas teredam (stabil + whip pan / cut).
import { loadOrt } from './libs.js';

export const ANALYSIS_FPS = 8;
const IN = 640;
const MODEL_URL = 'models/face_detection_yunet_2023mar.onnx';

let sessionPromise = null;
export function loadDetector() {
  sessionPromise ??= (async () => {
    const ort = await loadOrt();
    const s = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return { ort, s };
  })().catch((e) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

let lb = null;
function letterboxCanvas() {
  if (!lb) { lb = document.createElement('canvas'); lb.width = IN; lb.height = IN; }
  return lb;
}

function iou(a, b) {
  const iw = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const ih = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-6);
}

/** Deteksi wajah pada gambar (canvas/bitmap). -> [{x,y,w,h,score}] ternormalisasi 0..1 */
export async function detectFaces(img, iw, ih, scoreTh = 0.6) {
  const { ort, s } = await loadDetector();
  const c = letterboxCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const sc = Math.min(IN / iw, IN / ih);
  const dw = iw * sc, dh = ih * sc;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, IN, IN);
  ctx.drawImage(img, 0, 0, iw, ih, 0, 0, dw, dh);
  const px = ctx.getImageData(0, 0, IN, IN).data;
  const N = IN * IN;
  const data = new Float32Array(3 * N);
  for (let i = 0, j = 0; i < N; i++, j += 4) { data[i] = px[j + 2]; data[N + i] = px[j + 1]; data[2 * N + i] = px[j]; } // BGR
  const out = await s.run({ input: new ort.Tensor('float32', data, [1, 3, IN, IN]) });
  const cand = [];
  for (const st of [8, 16, 32]) {
    const cols = IN / st;
    const cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data;
    for (let i = 0; i < cols * cols; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < scoreTh) continue;
      const col = i % cols, row = (i / cols) | 0;
      const cx = (col + bb[i * 4]) * st, cy = (row + bb[i * 4 + 1]) * st;
      const w = Math.exp(bb[i * 4 + 2]) * st, h = Math.exp(bb[i * 4 + 3]) * st;
      cand.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of cand) {
    if (keep.every((k) => iou(b, k) < 0.3)) keep.push(b);
    if (keep.length >= 50) break;
  }
  return keep
    .map((f) => ({ x: f.x / dw, y: f.y / dh, w: f.w / dw, h: f.h / dh, score: f.score }))
    .filter((f) => f.w > 0.01 && f.h > 0.01 && f.x < 1 && f.y < 1);
}

// ------------------------------------------------------------------ analisis (wajah + gerak mulut)
/**
 * frameIter: async iterable canvas ukuran aw x ah, berurutan 8 fps.
 * -> frames: [[t, [{cx,cy,w,h,m}]]]
 */
export async function analyze(frameIter, aw, ah, total, onProgress) {
  const work = document.createElement('canvas');
  work.width = aw; work.height = ah;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let prev = null, i = 0;
  for await (const cv of frameIter) {
    if (!cv) { frames.push([i / ANALYSIS_FPS, []]); i++; continue; }
    wctx.drawImage(cv, 0, 0, aw, ah);
    const rgba = wctx.getImageData(0, 0, aw, ah).data;
    const gray = new Uint8ClampedArray(aw * ah);
    for (let p = 0, q = 0; p < gray.length; p++, q += 4) gray[p] = (rgba[q] * 299 + rgba[q + 1] * 587 + rgba[q + 2] * 114) / 1000;
    const faces = await detectFaces(work, aw, ah);
    const items = [];
    for (const f of faces) {
      const x = f.x * aw, y = f.y * ah, w = f.w * aw, h = f.h * ah;
      if (w < 8 || h < 8) continue;
      let m = 0;
      if (prev) {
        const region = (fy0, fy1, fx0 = 0.2, fx1 = 0.8) => {
          const x0 = Math.max(0, Math.floor(x + fx0 * w)), x1 = Math.min(aw, Math.floor(x + fx1 * w));
          const y0 = Math.max(0, Math.floor(y + fy0 * h)), y1 = Math.min(ah, Math.floor(y + fy1 * h));
          if (x1 - x0 < 3 || y1 - y0 < 3) return 0;
          let sum = 0;
          for (let yy = y0; yy < y1; yy++) {
            const r = yy * aw;
            for (let xx = x0; xx < x1; xx++) sum += Math.abs(gray[r + xx] - prev[r + xx]);
          }
          return sum / ((x1 - x0) * (y1 - y0));
        };
        const mouth = region(0.62, 1.0, 0.22, 0.78);
        const upper = region(0.15, 0.5);
        m = Math.max(0, mouth - 0.8 * upper);
      }
      items.push({ cx: (x + w / 2) / aw, cy: (y + h / 2) / ah, w: w / aw, h: h / ah, m });
    }
    frames.push([i / ANALYSIS_FPS, items]);
    prev = gray;
    i++;
    if (onProgress && i % 4 === 0) onProgress(Math.min(1, i / Math.max(1, total)));
  }
  return frames;
}

// ------------------------------------------------------------------ track
function buildTracks(frames, aspect) {
  const tracks = [];
  for (const [t, items] of frames) {
    const cands = [];
    tracks.forEach((tr, ti) => {
      if (t - tr.last > 1.0) return;
      const p = tr.pts[tr.pts.length - 1];
      items.forEach((it, ii) => {
        const d = Math.hypot(it.cx - p.cx, (it.cy - p.cy) / aspect);
        const ratio = it.w / Math.max(p.w, 1e-6);
        if (d < Math.max(p.w, it.w) * 0.9 && ratio > 0.5 && ratio < 2.0) cands.push([d, ti, ii]);
      });
    });
    cands.sort((a, b) => a[0] - b[0]);
    const usedT = new Set(), usedI = new Set();
    for (const [, ti, ii] of cands) {
      if (usedT.has(ti) || usedI.has(ii)) continue;
      usedT.add(ti); usedI.add(ii);
      tracks[ti].pts.push({ ...items[ii], t });
      tracks[ti].last = t;
    }
    items.forEach((it, ii) => { if (!usedI.has(ii)) tracks.push({ pts: [{ ...it, t }], last: t }); });
  }
  const good = tracks.filter((tr) => tr.pts.length >= 4 && tr.pts[tr.pts.length - 1].t - tr.pts[0].t >= 0.5);
  good.forEach((tr, k) => { tr.id = k; });
  return good;
}

function smooth(vals, win) {
  if (win <= 1 || vals.length < 3) return vals.slice();
  const h = Math.floor(win / 2);
  return vals.map((_, i) => {
    const a = Math.max(0, i - h), b = Math.min(vals.length, i + h + 1);
    let s = 0;
    for (let k = a; k < b; k++) s += vals[k];
    return s / (b - a);
  });
}

function trackSeries(tracks, n, dt) {
  const series = new Map();
  for (const tr of tracks) {
    const cx = new Array(n).fill(null), cy = new Array(n).fill(null), w = new Array(n).fill(null);
    const m = new Array(n).fill(0), vis = new Array(n).fill(false);
    for (const p of tr.pts) {
      const k = Math.round(p.t / dt);
      if (k >= 0 && k < n) { cx[k] = p.cx; cy[k] = p.cy; w[k] = p.w; m[k] = p.m; vis[k] = true; }
    }
    const idx = [];
    for (let k = 0; k < n; k++) if (vis[k]) idx.push(k);
    if (!idx.length) continue;
    const gap = Math.floor(0.6 / dt) + 1;
    for (let q = 0; q + 1 < idx.length; q++) {
      const a = idx[q], b = idx[q + 1];
      if (b - a > 1 && b - a <= gap) {
        for (let k = a + 1; k < b; k++) {
          const f = (k - a) / (b - a);
          cx[k] = cx[a] + (cx[b] - cx[a]) * f;
          cy[k] = cy[a] + (cy[b] - cy[a]) * f;
          w[k] = w[a] + (w[b] - w[a]) * f;
          vis[k] = true;
        }
      }
    }
    const first = idx[0], last = idx[idx.length - 1];
    let lastSeen = first;
    for (let k = 0; k < n; k++) {
      if (cx[k] != null) { lastSeen = k; continue; }
      const src = k < first ? first : k > last ? last : lastSeen;
      cx[k] = cx[src]; cy[k] = cy[src]; w[k] = w[src];
    }
    const win = Math.max(3, Math.floor(0.5 / dt) | 1);
    const sx = smooth(cx, win), sy = smooth(cy, win);
    const motion = [0];
    for (let k = 1; k < n; k++) {
      const mv = vis[k] && vis[k - 1] ? Math.abs(cx[k] - cx[k - 1]) + Math.abs(cy[k] - cy[k - 1]) : 0;
      motion.push(mv / Math.max(w[k], 1e-3));
    }
    series.set(tr.id, { cx: sx, cy: sy, w, m, vis, motion });
  }
  return series;
}

// ------------------------------------------------------------------ sutradara
function direct(series, n, dt, speech, cropWNorm, style) {
  if (!series.size) return null;
  const ids = [...series.keys()];
  const mainScore = (i) => {
    const s = series.get(i);
    let tot = 0;
    for (let k = 0; k < n; k++) if (s.vis[k]) tot += s.w[k] * (1.2 - Math.abs(s.cx[k] - 0.5));
    return tot;
  };
  const main = ids.reduce((a, b) => (mainScore(b) > mainScore(a) ? b : a));
  const win = Math.max(3, Math.floor(0.6 / dt) | 1);
  const act = new Map();
  for (const i of ids) {
    const s = series.get(i);
    const mv = s.m.filter((_, k) => s.vis[k]).sort((a, b) => a - b);
    const base = mv.length ? mv[Math.floor(mv.length * 0.3)] : 0;
    const talk = smooth(s.m.map((v, k) => (s.vis[k] ? v / (base + 0.6) : 0)), win);
    const mot = smooth(s.motion.map((v) => Math.min(3, v * 6)), win);
    act.set(i, talk.map((tv, k) => (s.vis[k] ? tv * (0.45 + 0.55 * speech[k]) + 0.5 * mot[k] : -1)));
  }
  const fast = style === 'dinamis';
  const minHold = (fast ? 0.8 : 1.3) / dt, maxReact = (fast ? 2.2 : 3.2) / dt;
  const need = (fast ? 0.25 : 0.4) / dt, margin = fast ? 1.3 : 1.45;
  const visible = (i, k) => series.get(i).vis[k];
  let cur = visible(main, 0) ? main : ids.reduce((a, b) => (act.get(b)[0] > act.get(a)[0] ? b : a));
  let held = 0, chal = null, chalT = 0, lost = 0;
  const out = [];
  for (let k = 0; k < n; k++) {
    let switched = false;
    const scores = new Map();
    for (const i of ids) if (visible(i, k)) scores.set(i, act.get(i)[k] + (i === main ? 0.35 : 0));
    const bestOf = () => [...scores.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    if (!scores.has(cur)) {
      lost += 1;
      if (lost > 0.5 / dt && scores.size) {
        cur = scores.has(main) ? main : bestOf();
        switched = true; held = 0; lost = 0;
      }
    } else {
      lost = 0;
      const best = bestOf();
      if (best !== cur && scores.get(best) > scores.get(cur) * margin + 0.25) {
        if (chal === best) chalT += 1; else { chal = best; chalT = 1; }
        if (chalT >= need && held >= minHold) { cur = best; switched = true; held = 0; chal = null; chalT = 0; }
      } else { chal = null; chalT = 0; }
      if (!switched && cur !== main && scores.has(main) && held > maxReact && scores.get(main) >= 0.5 * scores.get(cur)) {
        cur = main; switched = true; held = 0;
      }
    }
    held += 1;
    const s = series.get(cur);
    let tx = s.cx[k], ty = s.cy[k];
    if (scores.has(cur)) {
      const sc = scores.get(cur);
      for (const [o, v] of scores) {
        if (o === cur || !(v >= 0.7 * sc && sc > 0.6)) continue;
        const so = series.get(o);
        const left = Math.min(s.cx[k] - s.w[k] / 2, so.cx[k] - so.w[k] / 2);
        const right = Math.max(s.cx[k] + s.w[k] / 2, so.cx[k] + so.w[k] / 2);
        if (right - left <= cropWNorm * 0.85) { tx = (left + right) / 2; ty = (s.cy[k] + so.cy[k]) / 2; break; }
      }
    }
    out.push([tx, ty, switched]);
  }
  return out;
}

function cameraPath(targets, dt, fps, nframes, transition, style) {
  const omFollow = style === 'dinamis' ? 7.0 : 4.5, omFast = 16.0;
  let px = targets[0][0], py = targets[0][1], vx = 0, vy = 0, fastUntil = -1;
  const path = [];
  const h = 1 / fps, n = targets.length;
  for (let f = 0; f < nframes; f++) {
    const t = f * h;
    const k = Math.min(n - 1, Math.floor(t / dt));
    const k2 = Math.min(n - 1, k + 1);
    const fr = t / dt - k;
    const tx = !targets[k2][2] ? targets[k][0] + (targets[k2][0] - targets[k][0]) * fr : targets[k][0];
    const ty = !targets[k2][2] ? targets[k][1] + (targets[k2][1] - targets[k][1]) * fr : targets[k][1];
    if (targets[k][2] && (f === 0 || Math.floor((t - h) / dt) !== k)) {
      if (transition === 'potong') { px = tx; py = ty; vx = 0; vy = 0; }
      else fastUntil = t + 0.5;
    }
    const om = t < fastUntil ? omFast : omFollow;
    for (let r = 0; r < 2; r++) {
      const sh = h / 2;
      const ax = om * om * (tx - px) - 2 * om * vx;
      const ay = om * om * (ty - py) - 2 * om * vy;
      vx += ax * sh; vy += ay * sh; px += vx * sh; py += vy * sh;
    }
    path.push([px, py]);
  }
  return path;
}

export function cropRect(cx, cy, sw, sh, W, H, zoom) {
  let ch = sh / Math.max(1, zoom);
  let cw = (ch * W) / H;
  if (cw > sw) { cw = sw; ch = (cw * H) / W; }
  let x = cx * sw - cw / 2, y = cy * sh - ch * 0.40; // wajah di ±40% dari atas
  x = Math.min(Math.max(0, x), sw - cw);
  y = Math.min(Math.max(0, y), sh - ch);
  return { x, y, w: cw, h: ch };
}

/** Rencana kamera lengkap. speechAt(t) -> 0..1. -> { rectAt(t), faces, switches } */
export function plan(frames, sw, sh, fpsOut, dur, W, H, zoom, speechAt, style, transition) {
  const nframes = Math.max(1, Math.round(dur * fpsOut));
  const center = cropRect(0.5, 0.5, sw, sh, W, H, zoom);
  const fixed = { rectAt: () => center, faces: 0, switches: 0 };
  const n = frames.length;
  if (!n) return fixed;
  const dt = 1 / ANALYSIS_FPS;
  const tracks = buildTracks(frames, sw / sh);
  if (!tracks.length) return fixed;
  const series = trackSeries(tracks, n, dt);
  const speech = Array.from({ length: n }, (_, k) => speechAt(k * dt));
  const targets = direct(series, n, dt, speech, center.w / sw, style);
  if (!targets) return fixed;
  const path = cameraPath(targets, dt, fpsOut, nframes, transition, style);
  const rects = path.map(([x, y]) => cropRect(x, y, sw, sh, W, H, zoom));
  return {
    rectAt: (t) => rects[Math.min(rects.length - 1, Math.max(0, Math.round(t * fpsOut)))],
    faces: tracks.length,
    switches: targets.filter((x) => x[2]).length,
  };
}
