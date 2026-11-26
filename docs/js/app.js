// KlipKu Web — antarmuka & alur kerja (port dari KlipKu PC).
import { Source, resample, sliceBuffer, concatBuffers, encodeMp4, pickVideoCodec, CODEC_LABEL } from './media.js';
import { ASPECTS, geom, staticBox, drawBase, drawOverlay, drawWatermark } from './compose.js';
import { listFonts, getFont, ensureFont, addUserFont, DEFAULT_FONT, cssFont } from './fonts.js';
import * as SUB from './subs.js';
import * as CAM from './camera.js';

const VERSION = '2.1 web';
const $ = (id) => document.getElementById(id);
const S = { src: null, pvFrame: null, pvFaces: [], frame: null, faces: [], cam: null, logo: null, busy: false, cancel: false };
const MAX_CLIP = 180;

// ================================================================== util
function parseTime(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) throw new Error('Waktu kosong.');
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(+p) || +p < 0)) {
    throw new Error(`Format waktu "${text}" salah. Contoh: 1:23:45, 23:45, atau 45.`);
  }
  return parts.reduce((acc, p) => acc * 60 + +p, 0);
}
function fmtTime(sec, dec = false) {
  sec = Math.max(0, sec);
  let whole = Math.floor(sec);
  let frac = dec ? Math.round((sec - whole) * 10) : 0;
  if (frac === 10) { whole += 1; frac = 0; }
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, '0') + (frac ? '.' + frac : '');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const slug = (t, n = 40) => (String(t).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, n) || 'clip');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (b) => (b / 1048576).toFixed(b > 1e9 ? 2 : 0) + ' MB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ================================================================== pengaturan
const STORE = 'klipku-web-v1', KEYS = 'klipku-web-keys', LOGO = 'klipku-web-logo', CAMK = 'klipku-web-cam';
const FIELDS = ['zoom', 'bg', 'pan_x', 'pan_y', 'ai_zoom', 'ai_style', 'ai_transition', 'cam_pct', 'game_zoom', 'game_x', 'game_y',
  'divider', 'fps', 'subs', 'sub_text', 'sub_color', 'sub_y_pct', 'sub_size', 'sub_outline', 'per_line', 'uppercase', 'engine',
  'model', 'lang', 'prompt', 'rules', 'ai_fix', 'ai_model', 'review', 'wm_text', 'wm_mode', 'wm_pos', 'wm_opacity', 'wm_size',
  'wm_angle', 'wm_every', 'wm_color', 'wm_font', 'logo_on', 'logo_pos', 'logo_size', 'logo_opacity', 'hook_box', 'hook_color',
  'hook_outline', 'hook_size', 'hook_font', 'hook_secs', 'intro_on', 'intro_len', 'intro_fx', 'credit', 'channel'];
const SEGS = { segAspect: 'aspect', segLayout: 'layout', segGame: 'game_mode', segStyle: 'sub_style' };

function readKeys() { try { return JSON.parse(localStorage.getItem(KEYS) || '{}'); } catch { return {}; } }
function saveKeys() {
  const k = readKeys();
  const g = $('groq_key').value.trim(); if (g) k.groq = g;
  const a = $('ai_key').value.trim(); if (a && ['gemini', 'claude'].includes($('ai_fix').value)) k[$('ai_fix').value] = a;
  try { localStorage.setItem(KEYS, JSON.stringify(k)); } catch { /* penuh */ }
  return k;
}
function segVal(id) { return document.querySelector(`#${id} button.on`)?.dataset.v; }
function setSeg(id, v) {
  const btn = document.querySelector(`#${id} button[data-v="${v}"]`);
  if (!btn || btn.disabled) return;
  document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b === btn));
}

function opts() {
  const o = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    o[f] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
  }
  for (const [id, k] of Object.entries(SEGS)) o[k] = segVal(id);
  o.font = $('font').value || DEFAULT_FONT;
  o.cam = S.cam;
  return o;
}
const saveSettings = debounce(() => {
  const o = opts();
  delete o.cam;
  try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* abaikan */ }
}, 300);

function loadSettings() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* abaikan */ }
  for (const f of FIELDS) {
    const el = $(f);
    if (!el || o[f] === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!o[f]; else el.value = o[f];
  }
  for (const [id, k] of Object.entries(SEGS)) if (o[k]) setSeg(id, o[k]);
  if (o.font) $('font').dataset.want = o.font;
  try { S.cam = JSON.parse(localStorage.getItem(CAMK) || 'null'); } catch { S.cam = null; }
  const keys = readKeys();
  $('groq_key').value = keys.groq || '';
  const prov = $('ai_fix').value;
  $('ai_key').value = keys[prov] || '';
  const logo = localStorage.getItem(LOGO);
  if (logo) setLogo(logo, false);
}

// ================================================================== font UI
function fillFonts() {
  const fonts = listFonts();
  const q = $('fontSearch').value.trim().toLowerCase();
  const sel = $('font');
  const cur = sel.value || sel.dataset.want || DEFAULT_FONT;
  sel.innerHTML = '';
  const groups = {};
  for (const f of fonts) {
    if (q && !f.name.toLowerCase().includes(q) && f.id !== cur) continue;
    (groups[f.group] ??= []).push(f);
  }
  for (const [g, arr] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = g;
    for (const f of arr) og.append(new Option(f.name, f.id));
    sel.append(og);
  }
  sel.value = fonts.some((f) => f.id === cur) ? cur : DEFAULT_FONT;
  delete sel.dataset.want;
  $('fontCount').textContent = `${fonts.length} font`;
  for (const id of ['wm_font', 'hook_font']) {
    const s2 = $(id);
    const v = s2.value || s2.dataset.want || '';
    s2.innerHTML = '';
    s2.append(new Option('(sama dengan subtitle)', ''));
    for (const f of fonts) s2.append(new Option(f.name, f.id));
    s2.value = fonts.some((f) => f.id === v) ? v : '';
  }
}
function roleFonts(o) {
  return { sub: o.font || DEFAULT_FONT, hook: o.hook_font || o.font || DEFAULT_FONT, wm: o.wm_font || o.font || DEFAULT_FONT };
}
async function ensureFonts(o) {
  const f = roleFonts(o);
  await Promise.all([ensureFont(f.sub), ensureFont(f.hook), ensureFont(f.wm)]);
  return f;
}

// ================================================================== tampilan dinamis
const LABELS = {
  zoom: ['vZoom', (v) => v.toFixed(2) + '×'], ai_zoom: ['vAiz', (v) => v.toFixed(2) + '×'], cam_pct: ['vCam', (v) => v + '%'],
  game_zoom: ['vGz', (v) => v.toFixed(2) + '×'], sub_y_pct: ['vPos', (v) => (v ? v + '% dari atas' : 'otomatis')],
  sub_size: ['vSz', (v) => v], sub_outline: ['vOl', (v) => v], per_line: ['vPl', (v) => v], wm_opacity: ['vOp', (v) => v + '%'],
  wm_size: ['vWs', (v) => v], wm_angle: ['vAng', (v) => v + '°'], wm_every: ['vEv', (v) => v + ' dtk'], logo_size: ['vLs', (v) => v + '%'],
  logo_opacity: ['vLo', (v) => v + '%'], hook_outline: ['vHo', (v) => v], hook_size: ['vHs', (v) => v],
};
const show = (sel, on) => document.querySelectorAll(sel).forEach((el) => { el.style.display = on ? '' : 'none'; });

function refreshUI() {
  const o = opts();
  for (const [k, [id, f]] of Object.entries(LABELS)) $(id).textContent = f(+$(k).value);
  // facecam hanya 9:16
  const fcBtn = document.querySelector('#segLayout button[data-v="facecam"]');
  fcBtn.disabled = o.aspect !== '9:16';
  fcBtn.title = fcBtn.disabled ? 'Facecam + Gameplay hanya untuk 9:16' : '';
  if (fcBtn.disabled && o.layout === 'facecam') { setSeg('segLayout', 'static'); o.layout = 'static'; }
  document.querySelectorAll('.only').forEach((el) => { el.style.display = el.dataset.show === o.layout ? 'block' : 'none'; });
  show('.gz', o.game_mode !== 'utuh');
  $('subOpts').style.display = o.subs ? '' : 'none';
  show('.groqkey', o.engine === 'groq');
  show('.lokal', o.engine !== 'groq');
  show('.aikey', o.ai_fix !== 'off');
  show('.wmpos', o.wm_mode === 'pojok');
  show('.wmang', ['diagonal', 'pola', 'belakang'].includes(o.wm_mode));
  show('.wmevery', o.wm_mode === 'pindah');
  show('.hkpolos', o.hook_box === 'polos');
  show('.hksecs', !o.intro_on);
  show('.intro', o.intro_on);
  $('wmHint').textContent = o.wm_mode === 'belakang'
    ? 'Watermark di belakang hanya terlihat di area blur (mode Tengah dengan zoom kecil).' : '';
  const keys = readKeys();
  $('groqState').textContent = keys.groq ? 'tersimpan' : '';
  $('keyState').textContent = o.ai_fix !== 'off' && keys[o.ai_fix] ? 'tersimpan' : '';
  $('pvLabel').textContent = o.aspect;
  $('frameHint').textContent = o.layout === 'facecam' ? 'Lalu tarik kotak di facecam streamer.'
    : o.layout === 'ai' ? 'Wajah yang terdeteksi ditandai kotak hijau.' : 'Untuk preview yang akurat.';
  $('frameBox').classList.toggle('draw', o.layout === 'facecam');
  drawBoxes();
}

// ================================================================== clip rows
function addClip(c = {}) {
  const row = document.createElement('div');
  row.className = 'clip';
  const tin = (cls, ph, v, extra = '') => `<div class="tin"><input type="text" class="${cls} ${extra}" placeholder="${ph}" value="${esc(v || '')}"><button class="now" title="isi dari posisi video sekarang" type="button">⏱</button></div>`;
  row.innerHTML = `<b></b>${tin('s', '1:23:10', c.s)}${tin('e', '1:24:00', c.e)}
    <input type="text" class="t" placeholder="judul hook (kosong = tidak ada)" value="${esc(c.t || '')}">
    ${tin('i ci', 'menit intro', c.i)}<button class="del" title="hapus" type="button">✕</button>`;
  row.querySelector('.del').onclick = () => { row.remove(); numberClips(); onChange(); };
  row.querySelectorAll('.now').forEach((b) => {
    b.onclick = () => {
      const p = $('player');
      if (!S.src) return;
      b.previousElementSibling.value = fmtTime(p.currentTime || 0, true);
      b.previousElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
    };
  });
  row.addEventListener('input', (e) => { e.target.classList.remove('bad'); onClipChange(); });
  $('clips').append(row);
  numberClips();
}
function numberClips() { [...$('clips').children].forEach((r, i) => { r.querySelector('b').textContent = i + 1; }); }
function readClips(strict) {
  const out = [];
  [...$('clips').children].forEach((r, i) => {
    const g = (c) => r.querySelector('.' + c).value.trim();
    const c = { s: g('s'), e: g('e'), t: g('t'), i: g('i'), row: r, n: i + 1 };
    if (!c.s && !c.e && !strict) return;
    out.push(c);
  });
  return out;
}
function clipTimes(c) {
  const bad = (cls, msg) => { c.row.querySelector('.' + cls).classList.add('bad'); return new Error(`Clip ${c.n}: ${msg}`); };
  let s, e;
  try { s = parseTime(c.s); } catch (x) { throw bad('s', x.message); }
  try { e = parseTime(c.e); } catch (x) { throw bad('e', x.message); }
  if (e <= s) throw bad('e', 'waktu selesai harus setelah waktu mulai.');
  if (e - s > MAX_CLIP + 0.01) throw bad('e', `maksimal ${MAX_CLIP / 60} menit per clip (sekarang ${fmtTime(e - s)}).`);
  if (S.src && s >= S.src.duration) throw bad('s', `video cuma ${fmtTime(S.src.duration)}.`);
  if (S.src) e = Math.min(e, S.src.duration);
  return { s, e };
}
function introRel(c, s, e) {
  if (!c.i) return null;
  const t = parseTime(c.i);
  if (t >= s && t < e) return t - s;
  if (t < e - s && t < s) return t;
  c.row.querySelector('.i').classList.add('bad');
  throw new Error(`Clip ${c.n}: intro ${c.i} harus di antara mulai (${fmtTime(s)}) dan selesai (${fmtTime(e)}).`);
}

// ================================================================== video
async function loadVideo(file) {
  if (!file) return;
  if (S.busy) return alert('Tunggu proses yang sedang berjalan selesai dulu.');
  const info = $('vinfo');
  info.style.display = 'block';
  info.innerHTML = `Membuka <b>${esc(file.name)}</b>...`;
  try {
    S.src = await Source.open(file);
  } catch (e) {
    S.src = null;
    info.innerHTML = `<span style="color:var(--err)">❌ ${esc(e.message)}</span>`;
    $('btnGo').disabled = true; $('btnFrame').disabled = true;
    return;
  }
  const s = S.src;
  const p = $('player');
  if (p.src) URL.revokeObjectURL(p.src);
  p.src = URL.createObjectURL(file);
  p.style.display = 'block';
  info.innerHTML = `✅ <b>${esc(file.name)}</b><br><span class="muted">Durasi ${fmtTime(s.duration)} · ${s.dispW}×${s.dispH}`
    + ` · ${Math.round(s.fps)} fps · ${esc((s.codec || '?').toUpperCase())} · ${s.audio ? 'ada audio' : '<b style="color:var(--err)">tanpa audio</b>'}`
    + ` · ${mb(file.size)}</span>`;
  if (Math.min(s.dispW, s.dispH) < 720) info.innerHTML += `<div class="warn">Resolusi video ini cuma ${Math.min(s.dispW, s.dispH)}p — hasil bisa kurang tajam.</div>`;
  if (!readClips(false).length) {
    $('clips').innerHTML = '';
    addClip({ s: '0:00', e: fmtTime(Math.min(30, Math.floor(s.duration))) });
  }
  S.stem = file.name.replace(/\.[^.]+$/, '');
  $('btnGo').disabled = false; $('btnFrame').disabled = false;
  $('pvCtl').style.display = 'block';
  await grabFrame();
}

async function grabFrame() {
  if (!S.src) return;
  const c = readClips(false)[0];
  let t = 0;
  try { if (c) t = clipTimes(c).s; } catch { /* pakai 0 */ }
  $('btnFrame').disabled = true;
  try {
    const fr = await S.src.frameAt(t);
    if (!fr) throw new Error('Frame tidak bisa dibaca di menit itu.');
    S.frame = fr; S.faces = [];
    const cv = $('frame');
    cv.width = fr.width; cv.height = fr.height;
    cv.getContext('2d').drawImage(fr, 0, 0);
    $('frameBox').style.display = 'block';
    setPreviewRange();
    $('pvTime').value = t;
    S.pvFrame = fr; S.pvFaces = [];
    drawBoxes();
    await drawPreview();
    if (opts().layout === 'ai') await detectOnFrames();
  } catch (e) {
    $('frameHint').textContent = '❌ ' + e.message;
  } finally {
    $('btnFrame').disabled = false;
  }
}

async function detectOnFrames() {
  if (!S.frame) return;
  try {
    $('frameHint').textContent = 'mendeteksi wajah...';
    S.faces = await CAM.detectFaces(S.frame, S.frame.width, S.frame.height);
    S.pvFaces = S.pvFrame === S.frame ? S.faces : await CAM.detectFaces(S.pvFrame, S.pvFrame.width, S.pvFrame.height);
    $('frameHint').textContent = S.faces.length ? `${S.faces.length} wajah terdeteksi (kotak hijau).` : 'Tidak ada wajah terdeteksi di frame ini — kamera AI akan diam di tengah.';
    drawBoxes();
    drawPreview();
  } catch (e) {
    $('frameHint').textContent = '❌ Deteksi wajah gagal: ' + e.message;
  }
}

function drawBoxes() {
  const host = $('boxes');
  host.innerHTML = '';
  const o = { layout: segVal('segLayout') };
  const put = (r, cls, label) => {
    const d = document.createElement('div');
    d.className = 'box ' + cls;
    Object.assign(d.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
    d.innerHTML = `<span>${label}</span>`;
    host.append(d);
  };
  if (o.layout === 'facecam' && S.cam) put(S.cam, '', 'Facecam');
  if (o.layout === 'ai') S.faces.forEach((f) => put(f, 'face', 'wajah'));
}

function setupFacecamDraw() {
  const box = $('frameBox');
  let start = null;
  const pos = (e) => {
    const r = box.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  box.addEventListener('pointerdown', (e) => {
    if (segVal('segLayout') !== 'facecam') return;
    start = pos(e); box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = pos(e);
    S.cam = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawBoxes();
  });
  const end = () => {
    if (!start) return;
    start = null;
    if (!S.cam || S.cam.w < 0.03 || S.cam.h < 0.03) { S.cam = null; drawBoxes(); return; }
    try { localStorage.setItem(CAMK, JSON.stringify(S.cam)); } catch { /* abaikan */ }
    drawPreview();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ================================================================== preview
function setPreviewRange() {
  const c = readClips(false)[0];
  let s = 0, e = S.src ? S.src.duration : 1;
  try { if (c) ({ s, e } = clipTimes(c)); } catch { /* biarkan */ }
  const r = $('pvTime');
  r.min = s; r.max = Math.max(s + 0.1, e); r.step = 0.05;
  if (+r.value < s || +r.value > e) r.value = s;
  $('pvT').textContent = fmtTime(+r.value, true);
}

function aiZoom(o, W, H) {
  let z = +o.ai_zoom || (H > W ? 1 : 1.4);
  if (W >= H) z = Math.max(1.15, z);
  return z;
}

function previewChunks() {
  return [{ start: 0.2, end: 2.4, words: [{ s: 0.2, e: 0.9, t: 'INI' }, { s: 1.0, e: 1.5, t: 'CONTOH' }, { s: 1.6, e: 2.4, t: 'TEKS' }] }];
}

let pvBusy = false, pvAgain = false;
async function drawPreview() {
  if (pvBusy) { pvAgain = true; return; }
  pvBusy = true;
  try {
    const o = opts();
    const [W, H] = ASPECTS[o.aspect] || ASPECTS['9:16'];
    const cv = $('pv');
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    const fonts = await ensureFonts(o);
    const fr = S.pvFrame, sw = S.src?.sw || 1920, sh = S.src?.sh || 1080;
    let rect = null, g;
    if (o.layout === 'ai' && fr) {
      const f = S.pvFaces.reduce((a, b) => (!a || b.w * b.h > a.w * a.h ? b : a), null);
      rect = CAM.cropRect(f ? f.x + f.w / 2 : 0.5, f ? f.y + f.h / 2 : 0.5, sw, sh, W, H, aiZoom(o, W, H));
    }
    let behind = null;
    if (o.layout === 'static' && fr) {
      const b = staticBox(o, sw, sh, W, H);
      g = geom(o, W, H, b.top, b.bot);
      if (o.wm_mode === 'belakang' && !b.full) behind = (c) => drawWatermark(c, 0, o, W, H, fonts.wm, 10, true);
    } else g = geom(o, W, H);
    drawBase(ctx, fr, sw, sh, o, W, H, { rect, behind });
    if (!fr) {
      ctx.fillStyle = '#1a1d24'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#5b6372'; ctx.textAlign = 'center'; ctx.font = cssFont(DEFAULT_FONT, W * 0.06);
      ctx.fillText('PILIH VIDEO DULU', W / 2, H / 2);
      ctx.textAlign = 'start';
    }
    const c1 = readClips(false)[0];
    drawOverlay(ctx, 1.0, {
      o, W, H, g, dur: 10, chunks: o.subs ? previewChunks() : [], hook: c1?.t || (fr ? '' : 'JUDUL HOOK KAMU'),
      hookSpan: null, credit: o.credit ? `Sumber: ${o.channel || 'nama channel'}` : '', flashAt: null, logo: S.logo, fonts,
      behind: o.wm_mode === 'belakang',
    });
    $('pvHint').textContent = fr ? 'Preview memakai mesin gambar yang sama dengan hasil render.' : 'Pilih video dulu.';
  } catch (e) {
    $('pvHint').textContent = '❌ Preview gagal: ' + e.message;
  } finally {
    pvBusy = false;
    if (pvAgain) { pvAgain = false; drawPreview(); }
  }
}
const drawPreviewSoon = debounce(drawPreview, 60);

const scrubPreview = debounce(async () => {
  if (!S.src) return;
  const t = +$('pvTime').value;
  const fr = await S.src.frameAt(t);
  if (!fr) return;
  S.pvFrame = fr;
  S.pvFaces = [];
  if (opts().layout === 'ai') {
    try { S.pvFaces = await CAM.detectFaces(fr, fr.width, fr.height); } catch { /* abaikan */ }
  }
  drawPreview();
}, 120);

// ================================================================== logo
async function setLogo(dataUrl, persist = true) {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    S.logo = await createImageBitmap(img);
    $('logoThumb').src = dataUrl;
    $('logoThumb').style.display = 'inline-block';
    if (persist) { try { localStorage.setItem(LOGO, dataUrl); } catch { /* terlalu besar, tetap dipakai sesi ini */ } }
    drawPreview();
  } catch {
    S.logo = null;
  }
}

// ================================================================== cek kemampuan browser
let gpuCache = null;
async function gpuInfo() {
  if (gpuCache) return gpuCache;
  gpuCache = { webgpu: false, f16: false };
  try {
    const ad = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    if (ad) gpuCache = { webgpu: true, f16: ad.features.has('shader-f16') };
  } catch { /* tidak ada */ }
  return gpuCache;
}

async function refreshEncoder() {
  const o = opts();
  const [W, H] = ASPECTS[o.aspect];
  const F = o.fps === 'src' ? 30 : +o.fps;
  try {
    const { codec, bitrate } = await pickVideoCodec(W, H, F);
    $('encInfo').innerHTML = codec
      ? `Mesin render: <b>${CODEC_LABEL[codec] || codec}</b> ${W}×${H} · ${(bitrate / 1e6).toFixed(0)} Mbps · WebCodecs (GPU otomatis kalau ada)`
      : '<span style="color:var(--err)">Browser ini tidak bisa meng-encode video. Pakai Chrome / Edge versi terbaru.</span>';
  } catch (e) {
    $('encInfo').textContent = 'Mesin render belum termuat: ' + e.message;
  }
}

async function checkSupport() {
  const miss = [];
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) miss.push('WebCodecs (encode/decode video)');
  if (!('OfflineAudioContext' in window)) miss.push('Web Audio');
  if (miss.length) {
    const b = $('banner');
    b.style.display = 'block';
    b.innerHTML = `Browser ini belum mendukung: <b>${miss.join(', ')}</b>. Pakai <b>Chrome / Edge / Opera</b> versi terbaru di laptop/PC (Safari 17+ / Firefox 130+ juga bisa, tapi lebih lambat).`;
  }
  const g = await gpuInfo();
  $('gpuInfo').innerHTML = g.webgpu
    ? `⚡ GPU (WebGPU) terdeteksi${g.f16 ? ' + fp16' : ''} — subtitle diproses cepat di GPU. Model di-download sekali lalu tersimpan di browser.`
    : '⚠️ WebGPU tidak tersedia di browser ini — subtitle diproses di CPU (lebih lambat). Model "large-v3-turbo" butuh GPU, jadi otomatis pakai "small". Pakai Chrome/Edge terbaru untuk GPU.';
}

// ================================================================== Whisper (worker)
let worker = null;
function getWorker() {
  worker ??= new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return worker;
}
function killWorker() { if (worker) { worker.terminate(); worker = null; } }

const MODEL_ID = {
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo_timestamped',
};
function whisperConfig(name, g, forceWasm = false) {
  if (forceWasm || !g.webgpu) {
    const n = name === 'large-v3-turbo' ? 'small' : name;
    return { name: n, id: MODEL_ID[n], device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
  }
  const id = MODEL_ID[name] || MODEL_ID.small;
  if (name === 'base') return { name, id, device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
  if (name === 'large-v3-turbo') {
    return { name, id, device: 'webgpu', dtype: g.f16 ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } : { encoder_model: 'q4', decoder_model_merged: 'q4' } };
  }
  return { name: 'small', id, device: 'webgpu', dtype: g.f16 ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } : { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
}

function runWhisper(cfg, pieces, language, onLoad, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    w.onmessage = ({ data: m }) => {
      if (m.type === 'load') onLoad(m.loaded, m.total);
      else if (m.type === 'ready') onLoad(1, 1, true);
      else if (m.type === 'progress') onProgress(m.done, m.total);
      else if (m.type === 'done') resolve(m.words);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'Worker subtitle error'));
    const copy = pieces.map((p) => ({ start: p.start, data: p.data }));
    w.postMessage({ type: 'run', model: cfg.id, device: cfg.device, dtype: cfg.dtype, language, pieces: copy }, copy.map((p) => p.data.buffer));
  });
}

// ================================================================== tampilan proses
const STEP_LABELS = {
  prep: 'Siapkan potongan video & audio', model: 'Siapkan model subtitle', subs: 'Bikin subtitle (Whisper)',
  fix: 'Koreksi subtitle', review: 'Cek subtitle (menunggu kamu)', ai: 'AI kamera: analisis wajah & pembicara', render: 'Render & encode video',
};
const STEP_W = { prep: 8, model: 8, subs: 26, fix: 4, review: 0, ai: 14, render: 40 };
const J = { steps: {}, keys: [], clipNo: 0, clips: 1, t0: 0, timer: null };

function jobStart(nClips) {
  Object.assign(J, { clipNo: 0, clips: nClips, t0: performance.now() });
  $('job').style.display = 'block';
  ['notes', 'warns', 'steps'].forEach((id) => { $(id).innerHTML = ''; });
  $('err').style.display = 'none';
  $('rvBox').style.display = 'none';
  $('btnCancel').style.display = '';
  clearInterval(J.timer);
  J.timer = setInterval(() => { $('elapsed').textContent = `berjalan ${fmtTime((performance.now() - J.t0) / 1000)}`; }, 1000);
  $('job').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clipBegin(i, keys) {
  J.clipNo = i; J.keys = keys; J.steps = {};
  $('clipNo').textContent = `clip ${i + 1} dari ${J.clips}`;
  $('steps').innerHTML = keys.map((k) => `<div class="stp" id="st-${k}"><span class="ic">⏳</span><span class="lb">${STEP_LABELS[k]}<small></small></span><span class="mb"><i style="width:0"></i></span><span class="pc">0%</span></div>`).join('');
  for (const k of keys) J.steps[k] = { p: 0, state: 'tunggu' };
  overall();
}
function step(key, p = null, info = null, state = null) {
  const st = J.steps[key];
  if (!st) return;
  if (p != null) st.p = Math.max(0, Math.min(1, p));
  st.state = state || (st.p >= 1 ? 'selesai' : 'jalan');
  for (const [k, v] of Object.entries(J.steps)) if (k !== key && v.state === 'jalan' && st.state === 'jalan') v.state = v.p >= 1 ? 'selesai' : 'jalan';
  const el = $('st-' + key);
  el.className = 'stp ' + st.state;
  el.querySelector('.ic').textContent = { tunggu: '⏳', jalan: '▶️', selesai: '✅', lewat: '⏭️' }[st.state] || '▶️';
  el.querySelector('i').style.width = st.p * 100 + '%';
  el.querySelector('.pc').textContent = st.state === 'lewat' ? '—' : Math.round(st.p * 100) + '%';
  if (info != null) el.querySelector('small').textContent = info;
  overall();
}
function skip(key, info) { step(key, 1, info, 'lewat'); }
function overall() {
  let tw = 0, done = 0;
  for (const k of J.keys) { const w = STEP_W[k]; tw += w; done += w * (J.steps[k]?.p || 0); }
  const clipP = tw ? done / tw : 0;
  const all = (J.clipNo + clipP) / J.clips;
  $('pctAll').textContent = Math.floor(all * 100) + '%';
  $('barFill').style.width = all * 100 + '%';
}
const stage = (t) => { $('stage').textContent = t; };
const note = (t) => { $('notes').insertAdjacentHTML('beforeend', `<div class="note">${esc(t)}</div>`); };
const warn = (t) => { $('warns').insertAdjacentHTML('beforeend', `<div class="warn">${esc(t)}</div>`); };
const checkCancel = () => { if (S.cancel) throw new Error('DIBATALKAN'); };

function reviewSubs(chunks) {
  return new Promise((resolve) => {
    const box = $('rvBox');
    $('rvRows').innerHTML = chunks.map((c, i) => `<div class="sr"><code>${fmtTime(c.start, true)}</code><input type="text" data-i="${i}" value="${esc(c.text)}"></div>`).join('');
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const done = (useEdits) => {
      box.style.display = 'none';
      clearInterval(poll);
      if (!useEdits) return resolve(chunks);
      const edited = [...$('rvRows').querySelectorAll('input')].map((inp) => {
        const c = chunks[+inp.dataset.i];
        return { start: c.start, end: c.end, text: inp.value };
      });
      resolve(SUB.applyEdits(chunks, edited));
    };
    $('btnRv').onclick = () => done(true);
    $('btnRvSkip').onclick = () => done(false);
    const poll = setInterval(() => { if (S.cancel) { done(false); } }, 300);
  });
}

// ================================================================== proses satu clip
function fpsOut(o, srcFps) {
  const src = Math.max(1, Math.round(srcFps));
  return o.fps === 'src' ? Math.min(60, src) : Math.min(+o.fps || 30, src);
}

function makeTimeline(o, dur, rel, F) {
  const main = { kind: 'play', src: 0, dur };
  let segs;
  if (!o.intro_on) segs = [main];
  else {
    let n = +o.intro_len || 3;
    let t0 = rel ?? 0;
    t0 = Math.min(Math.max(0, t0), Math.max(0, dur - 0.6));
    n = Math.max(0.5, Math.min(n, dur - t0));
    segs = [{ kind: 'play', src: t0, dur: n, teaser: true }];
    if (o.intro_fx === 'rewind') segs.push({ kind: 'rewind', src: t0, dur: n });
    segs.push({ ...main, main: true });
  }
  let out = 0;
  for (const sg of segs) {
    sg.frames = Math.max(1, Math.round((sg.kind === 'rewind' ? sg.dur / 4 : sg.dur) * F));
    sg.out = out;
    sg.outDur = sg.frames / F;
    out += sg.outDur;
  }
  return segs;
}

function speechFromWords(words) {
  const spans = words.map((w) => [w.s - 0.15, w.e + 0.15]);
  return (t) => (spans.some(([a, b]) => a <= t && t <= b) ? 1 : 0);
}
function speechFromAudio(mono, rate) {
  if (!mono) return () => 0.6;
  const hop = Math.round(rate * 0.125);
  const n = Math.max(1, Math.floor(mono.length / hop));
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += mono[k] * mono[k];
    rms[i] = Math.sqrt(s / hop + 1e-9);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const med = sorted[Math.floor(n / 2)] + 1e-6;
  const vals = [...rms].map((r) => Math.max(0, Math.min(1, (r / med - 0.8) / 1.2)));
  return (t) => vals[Math.min(n - 1, Math.max(0, Math.floor(t * 8)))];
}

function maxCharsFor(o, W) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = cssFont(o.font, 100);
  let aw = ctx.measureText('ABCDEFGHIJKLMNOPRSTUWY').width / 22 / 100;
  if (!(aw > 0.2 && aw < 1.5)) aw = 0.65;
  aw *= o.uppercase ? 1.0 : 0.82;
  return Math.max(6, Math.floor((W * 0.86) / (+o.sub_size * aw * 1.06)));
}

async function makeSubtitles(o, mono16, keysStore, clip) {
  const terms = SUB.parseTerms(o.prompt), rules = SUB.parseRules(o.rules);
  let words = null, dev = '';
  const lang = o.lang === 'auto' ? null : o.lang;
  if (o.engine === 'groq') {
    if (!keysStore.groq) warn('Mesin Groq dipilih tapi API key belum diisi — pakai mesin di browser.');
    else {
      stage(`Clip ${clip.n}: bikin subtitle (Groq online)...`);
      skip('model', 'online — tidak perlu download model');
      step('subs', 0.15, 'mengirim audio ke Groq...');
      try {
        words = await SUB.groqTranscribe(SUB.wavBlob(mono16, 16000), keysStore.groq, o.model, lang, terms);
        dev = 'Groq ⚡';
      } catch (e) {
        warn(e.message + ' — otomatis pindah ke mesin di browser.');
        words = null;
      }
    }
  }
  if (!words) {
    const g = await gpuInfo();
    let cfg = whisperConfig(o.model, g);
    if (cfg.name !== o.model) warn(`Model ${o.model} butuh WebGPU — dipakai model "${cfg.name}".`);
    const pieces = SUB.splitForWhisper(mono16, 16000);
    const attempt = async (c) => {
      stage(`Clip ${clip.n}: siapkan model Whisper ${c.name} (${c.device === 'webgpu' ? 'GPU' : 'CPU'})...`);
      step('model', 0.02, 'cek model...');
      step('subs', 0, '');
      const t0 = performance.now();
      return runWhisper(c, pieces.map((p) => ({ start: p.start, data: p.data.slice() })), lang,
        (l, t, ready) => {
          if (ready) { step('model', 1, `model ${c.name} siap (${c.device === 'webgpu' ? 'GPU' : 'CPU'})`); stage(`Clip ${clip.n}: bikin subtitle (Whisper ${c.name})...`); }
          else step('model', l / Math.max(1, t), `download ${mb(l)} / ${mb(t)} (sekali saja)`);
        },
        (d, n) => {
          const el = (performance.now() - t0) / 1000;
          step('subs', d / n, `bagian ${d}/${n} · ${el.toFixed(0)} dtk`);
        });
    };
    try {
      words = await attempt(cfg);
    } catch (e) {
      checkCancel();
      if (cfg.device !== 'webgpu') throw new Error('Whisper gagal: ' + e.message);
      warn(`Whisper di GPU gagal (${e.message.slice(0, 160)}) — otomatis pindah ke CPU.`);
      killWorker();
      cfg = whisperConfig(o.model, g, true);
      words = await attempt(cfg);
    }
    dev = `Whisper ${cfg.name} · ${cfg.device === 'webgpu' ? 'GPU' : 'CPU'}`;
  }
  step('subs', 1, `${words.length} kata`);
  note(`Subtitle diproses oleh ${dev}.`);
  checkCancel();

  step('fix', 0.2, 'kamus & kata khusus...');
  let n1, n2;
  [words, n1] = SUB.applyRules(words, rules);
  [words, n2] = SUB.applyTerms(words, terms);
  if (n1 || n2) note(`Koreksi otomatis: ${n1} dari kamus, ${n2} dari kata khusus.`);
  const [W] = ASPECTS[o.aspect];
  let chunks = SUB.makeChunks(words, +o.per_line, maxCharsFor(o, W));
  if (['gemini', 'claude'].includes(o.ai_fix) && chunks.length) {
    const key = keysStore[o.ai_fix];
    if (!key) warn(`Koreksi AI ${o.ai_fix} dilewati: API key belum diisi.`);
    else {
      stage(`Clip ${clip.n}: koreksi AI (${o.ai_fix})...`);
      step('fix', 0.4, `koreksi AI ${o.ai_fix}` + (o.ai_fix === 'gemini' ? ' (mendengarkan audio)' : ''));
      try {
        const fixed = await SUB.aiCorrect(chunks.map((c) => c.text), o.ai_fix, key, o.ai_model.trim(),
          { title: clip.t || S.stem, channel: o.channel, terms }, o.ai_fix === 'gemini' ? SUB.wavBlob(mono16, 16000) : null);
        const changed = chunks.filter((c, i) => c.text !== fixed[i]).length;
        chunks = SUB.applyEdits(chunks, chunks.map((c, i) => ({ start: c.start, end: c.end, text: fixed[i] })));
        note(`Koreksi AI mengubah ${changed} baris.`);
      } catch (e) {
        warn(e.message);
      }
    }
  }
  step('fix', 1, `${chunks.length} baris`);
  return { chunks, words };
}

async function processClip(o, clip, idx, keysStore) {
  const src = S.src;
  const { s, e } = clipTimes(clip);
  const rel = introRel(clip, s, e);
  const dur = e - s;
  const [W, H] = ASPECTS[o.aspect];
  if (o.layout === 'facecam' && !o.cam) throw new Error('Kotak facecam belum dipilih. Klik "Ambil gambar" lalu tarik kotak di wajah streamer.');
  const wantSubs = o.subs;
  const keys = ['prep'];
  if (wantSubs) keys.push('model', 'subs', 'fix');
  if (wantSubs && o.review) keys.push('review');
  if (o.layout === 'ai') keys.push('ai');
  keys.push('render');
  clipBegin(idx, keys);
  const tag = `Clip ${clip.n}`;
  const fonts = await ensureFonts(o);

  // 1) audio
  stage(`${tag}: siapkan potongan ${fmtTime(s)}–${fmtTime(e)}...`);
  step('prep', 0.1, 'membaca audio...');
  const audio48 = await src.audioRange(s, e);
  checkCancel();
  step('prep', 0.7, audio48 ? 'audio siap' : 'video ini tanpa audio');
  const mono16 = audio48 ? (await resample(audio48, 16000, 1)).getChannelData(0) : null;
  step('prep', 1, `${fmtTime(dur, true)} · ${audio48 ? 'audio 48 kHz stereo' : 'tanpa audio'}`);

  // 2) subtitle
  let chunks = [], words = [];
  if (wantSubs) {
    if (!mono16) {
      warn('Video ini tidak punya audio — subtitle dilewati.');
      ['model', 'subs', 'fix', 'review'].forEach((k) => skip(k, 'tanpa audio'));
    } else {
      ({ chunks, words } = await makeSubtitles(o, mono16, keysStore, clip));
      checkCancel();
      if (o.review && chunks.length) {
        stage(`${tag}: cek subtitle — edit kalau ada yang salah, lalu klik "Lanjut Render".`);
        step('review', 0.5, 'menunggu kamu...');
        chunks = await reviewSubs(chunks);
        checkCancel();
        step('review', 1, 'oke');
      } else if (o.review) skip('review', 'tidak ada ucapan terdeteksi');
      if (!chunks.length) warn('Tidak ada ucapan yang terdeteksi — clip dibuat tanpa subtitle.');
    }
  }

  // 3) AI kamera
  const F = fpsOut(o, src.fps);
  let planR = null;
  if (o.layout === 'ai') {
    stage(`${tag}: AI kamera menganalisis wajah & siapa yang bicara...`);
    step('ai', 0, 'memuat detektor wajah YuNet...');
    await CAM.loadDetector();
    const n = Math.max(1, Math.floor(dur * CAM.ANALYSIS_FPS));
    const times = Array.from({ length: n }, (_, k) => s + k / CAM.ANALYSIS_FPS);
    const aw = src.sw >= src.sh ? 640 : 360;
    const ah = Math.round((src.sh * aw) / src.sw / 2) * 2;
    const frames = await CAM.analyze(src.framesAt(times, aw, ah), aw, ah, n, (p) => {
      checkCancel();
      step('ai', p * 0.95, `${Math.round(p * dur)} / ${Math.round(dur)} detik video`);
    });
    checkCancel();
    const speechAt = words.length ? speechFromWords(words) : speechFromAudio(mono16, 16000);
    planR = CAM.plan(frames, src.sw, src.sh, F, dur, W, H, aiZoom(o, W, H), speechAt, o.ai_style, o.ai_transition);
    step('ai', 1, `${planR.faces} wajah · ${planR.switches} perpindahan kamera`);
    note(`AI kamera: ${planR.faces} wajah terlacak, ${planR.switches} perpindahan kamera, detektor YuNet.`);
    if (!planR.faces) warn('AI kamera tidak menemukan wajah — kamera diam di tengah.');
  }

  // 4) render
  const segs = makeTimeline(o, dur, rel, F);
  const intro = segs.length > 1;
  const mainSeg = segs.find((x) => x.main) || segs[0];
  const total = segs.reduce((a, x) => a + x.frames, 0);
  const outDur = total / F;
  let g, behind = false;
  if (o.layout === 'static') {
    const b = staticBox(o, src.sw, src.sh, W, H);
    g = geom(o, W, H, b.top, b.bot);
    if (o.wm_mode === 'belakang' && o.wm_text.trim()) {
      if (b.full) warn("Watermark 'di belakang video' tidak terlihat karena video memenuhi layar; dipasang transparan di atas video.");
      else behind = true;
    }
  } else g = geom(o, W, H);
  const oo = behind || o.wm_mode !== 'belakang' ? o : { ...o, wm_mode: 'diagonal' };
  const ov = {
    o: oo, W, H, g, dur: outDur, chunks: intro ? SUB.shiftChunks(chunks, segs) : chunks, hook: clip.t,
    hookSpan: intro ? [0, segs[0].outDur] : null, credit: o.credit ? `Sumber: ${o.channel.trim() || 'YouTube'}` : '',
    flashAt: intro && o.intro_fx === 'flash' ? mainSeg.out : null, logo: S.logo, fonts, behind,
  };

  stage(`${tag}: siapkan audio hasil...`);
  let audioOut = null;
  if (audio48) {
    const parts = [];
    for (const sg of segs) {
      const piece = sliceBuffer(audio48, sg.src, sg.src + sg.dur);
      const buf = sg.kind === 'rewind' ? await resample(piece, 48000, 2, { reverse: true, speed: 4, gain: 0.6 }) : piece;
      parts.push({ buf, samples: Math.round(sg.outDur * 48000) });
    }
    audioOut = concatBuffers(parts, 48000, 2);
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const drawOne = (cv, cw, chh, rect, tOut) => {
    drawBase(ctx, cv, cw, chh, o, W, H, {
      rect, behind: behind ? (c) => drawWatermark(c, tOut, o, W, H, fonts.wm, outDur, true) : null,
    });
    drawOverlay(ctx, tOut, ov);
  };
  async function* frames() {
    for (const sg of segs) {
      const times = Array.from({ length: sg.frames }, (_, k) => (sg.kind === 'rewind' ? sg.src + sg.dur - (k * 4) / F : sg.src + k / F));
      if (sg.kind === 'rewind') {
        // decoder video hanya aman maju: ambil frame urut maju (resolusi diperkecil), lalu putar terbalik
        const k2 = Math.min(1, (sg.frames > 45 ? 960 : 1280) / Math.max(src.sw, src.sh));
        const rw = Math.round((src.sw * k2) / 2) * 2, rh = Math.round((src.sh * k2) / 2) * 2;
        const order = times.map((t, k) => ({ t, k })).sort((a, b) => a.t - b.t);
        const bmps = new Array(times.length).fill(null);
        let j = 0;
        for await (const cv of src.framesAt(order.map((x) => s + Math.min(x.t, dur - 0.001)), rw, rh)) {
          if (cv) bmps[order[j].k] = await createImageBitmap(cv);
          j++;
          checkCancel();
        }
        let last = null;
        for (let k = 0; k < times.length; k++) {
          const tOut = sg.out + k / F;
          const bm = bmps[k] || last;
          let rect = planR ? planR.rectAt(times[k]) : null;
          if (rect) rect = { x: rect.x * k2, y: rect.y * k2, w: rect.w * k2, h: rect.h * k2 };
          drawOne(bm, rw, rh, rect, tOut);
          if (last && last !== bm) last.close();
          last = bm;
          yield tOut;
        }
        last?.close();
        continue;
      }
      let k = 0;
      for await (const cv of src.framesAt(times.map((t) => s + Math.min(t, dur - 0.001)))) {
        const tOut = sg.out + k / F;
        drawOne(cv, src.sw, src.sh, planR ? planR.rectAt(times[k]) : null, tOut);
        yield tOut;
        k++;
      }
    }
  }
  stage(`${tag}: render video ${W}×${H} @ ${F} fps...`);
  step('render', 0, 'mulai encode...');
  const t0 = performance.now();
  const res = await encodeMp4({
    canvas, frames: frames(), total, fps: F, audio: audioOut, isCancelled: () => S.cancel,
    onProgress: (p, { speed, eta }) => step('render', p * 0.99, `${speed.toFixed(1)}× realtime · sisa ±${Math.max(0, eta).toFixed(0)} dtk`),
  });
  step('render', 1, `selesai dalam ${((performance.now() - t0) / 1000).toFixed(0)} dtk · ${CODEC_LABEL[res.codec] || res.codec}${res.acodec ? ' + ' + (CODEC_LABEL[res.acodec] || res.acodec) : ''}`);
  if (res.audioDropped) warn('Browser ini tidak bisa meng-encode audio (AAC/Opus) — clip dibuat tanpa suara. Pakai Chrome/Edge.');
  if (res.acodec === 'opus') note('Audio memakai Opus (browser ini tidak punya encoder AAC). Kalau aplikasi upload menolak, coba Chrome/Edge di Windows/Mac.');

  const name = `${slug(S.stem)}_${fmtTime(s).replace(/:/g, '-')}_${o.aspect.replace(':', 'x')}.mp4`;
  const caption = `${clip.t || S.stem}\n\nSumber: ${o.channel.trim() || '-'}\n#clip #fyp`;
  addResult(res.blob, name, caption, fmtTime(outDur, true), o.aspect);
}

function addResult(blob, name, caption, len, aspect) {
  const url = URL.createObjectURL(blob);
  const d = document.createElement('div');
  d.className = 'res';
  d.innerHTML = `<video src="${url}" controls playsinline preload="metadata"></video>
    <div class="n">${esc(name)}<br><span class="muted">${len} · ${aspect} · ${mb(blob.size)}</span></div>
    <a class="dl" href="${url}" download="${esc(name)}">⬇ Download</a><button type="button">📋 Salin caption</button>`;
  d.querySelector('button').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(caption); ev.target.textContent = '✅ Tersalin'; } catch { prompt('Salin caption:', caption); }
  };
  $('results').prepend(d);
  $('resCard').style.display = 'block';
}

// ================================================================== tombol Buat Clip
async function go() {
  if (S.busy) return;
  const err = $('err');
  err.style.display = 'none';
  try {
    if (!S.src) throw new Error('Pilih video dulu di langkah 1.');
    const clips = readClips(true);
    if (!clips.length) throw new Error('Isi minimal satu clip.');
    clips.forEach((c) => { const { s, e } = clipTimes(c); introRel(c, s, e); });
    const o = opts();
    if (o.layout === 'facecam' && !S.cam) throw new Error('Kotak facecam belum dipilih. Klik "Ambil gambar" lalu tarik kotak di wajah streamer.');
    const keysStore = saveKeys();
    saveSettings();
    S.busy = true; S.cancel = false;
    $('btnGo').disabled = true;
    jobStart(clips.length);
    for (let i = 0; i < clips.length; i++) {
      await processClip(o, clips[i], i, keysStore);
      checkCancel();
    }
    J.clipNo = clips.length; J.keys = []; overall();
    $('pctAll').textContent = '100%'; $('barFill').style.width = '100%';
    stage(`✅ Selesai! ${clips.length} clip siap di bawah.`);
    $('resCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    if (e.message === 'DIBATALKAN') { stage('Dibatalkan.'); killWorker(); }
    else {
      $('job').style.display = 'block';
      err.style.display = 'block';
      err.textContent = '❌ ' + e.message;
      stage('Berhenti karena error.');
    }
  } finally {
    S.busy = false;
    clearInterval(J.timer);
    $('btnGo').disabled = !S.src;
    $('btnCancel').style.display = 'none';
  }
}

// ================================================================== event
function onChange() { refreshUI(); saveSettings(); drawPreviewSoon(); }
const onClipChange = debounce(() => { setPreviewRange(); drawPreviewSoon(); }, 250);

function init() {
  $('ver').textContent = 'versi ' + VERSION;
  fillFonts();
  loadSettings();
  fillFonts();
  for (const id of Object.keys(SEGS)) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      setSeg(id, b.dataset.v);
      onChange();
      if (id === 'segAspect') refreshEncoder();
      if (id === 'segLayout' && b.dataset.v === 'ai' && S.frame && !S.faces.length) detectOnFrames();
    });
  }
  document.querySelectorAll('main input, main select, main textarea').forEach((el) => {
    if (el.closest('#clips') || el.closest('#rvBox') || ['file', 'pvTime', 'fontSearch', 'fontFile', 'logoFile', 'groq_key', 'ai_key'].includes(el.id)) return;
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
  $('fps').addEventListener('change', refreshEncoder);
  $('ai_fix').addEventListener('change', () => { $('ai_key').value = readKeys()[$('ai_fix').value] || ''; refreshUI(); });
  $('groq_key').addEventListener('change', () => { saveKeys(); refreshUI(); });
  $('ai_key').addEventListener('change', () => { saveKeys(); refreshUI(); });
  $('fontSearch').addEventListener('input', fillFonts);
  $('font').addEventListener('change', onChange);
  $('fontFile').addEventListener('change', async (e) => {
    let last = null;
    for (const f of e.target.files) {
      try { last = await addUserFont(f); } catch (x) { alert(`Font ${f.name} gagal dipakai: ${x.message}`); }
    }
    e.target.value = '';
    if (last) { fillFonts(); $('font').value = last.id; onChange(); }
  });
  $('logoFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setLogo(r.result); $('logo_on').checked = true; onChange(); };
    r.readAsDataURL(f);
    e.target.value = '';
  });
  $('btnLogoDel').onclick = () => {
    S.logo = null; localStorage.removeItem(LOGO);
    $('logoThumb').style.display = 'none'; $('logo_on').checked = false; onChange();
  };
  $('btnAdd').onclick = () => {
    const last = readClips(false).pop();
    let s = '';
    try { if (last) s = fmtTime(clipTimes(last).e); } catch { /* kosong */ }
    addClip({ s });
  };
  $('btnFrame').onclick = grabFrame;
  $('btnGo').onclick = go;
  $('btnCancel').onclick = () => { S.cancel = true; killWorker(); stage('Membatalkan...'); };
  $('pvTime').addEventListener('input', () => { $('pvT').textContent = fmtTime(+$('pvTime').value, true); scrubPreview(); });
  $('file').addEventListener('change', (e) => loadVideo(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadVideo(e.dataTransfer.files[0]));
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  setupFacecamDraw();
  addClip();
  refreshUI();
  drawPreview();
  checkSupport();
  refreshEncoder();
}

init();
void sleep; void getFont;
