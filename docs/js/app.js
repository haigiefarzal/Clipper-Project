// KlipKu Web: antarmuka dan alur kerja (port dari KlipKu PC 2.3).
import { Source, resample, sliceBuffer, concatBuffers, encodeMp4, pickVideoCodec, CODEC_LABEL } from './media.js';
import { ASPECTS, geom, staticBox, drawBase, drawOverlay, drawWatermark, hookDefaults, bannerLayout } from './compose.js';
import { listFonts, ensureFont, addUserFont, DEFAULT_FONT, cssFont } from './fonts.js';
import * as SUB from './subs.js';
import * as CAM from './camera.js';
import * as AU from './audio.js';
import { putFile, getFile, delFile, listFiles, keepStorage } from './store.js';

const VERSION = '2.3';
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const S = {
  src: null, stem: '', frame: null, faces: [], pvFrame: null, pvFaces: [], cam: null,
  imgs: { logo: null, banner_logo: null, banner: null }, sfxLib: [], musicLib: [], decoded: new Map(),
  busy: false, cancel: false, pvMode: 'awal', hookEl: null,
};
const MAX_CLIP = 180;

// ================================================================== util
function parseTime(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) throw new Error('Waktu masih kosong.');
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(+p) || +p < 0)) {
    throw new Error(`Format waktu "${text}" belum benar. Contoh: 1:23:45, 23:45, atau 45.`);
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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mbStr = (b) => (b / 1048576).toFixed(b > 1e9 ? 2 : b > 1e7 ? 0 : 1) + ' MB';
const bare = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
const truthy = (v) => v === true || (typeof v === 'number' ? v !== 0 : !!String(v ?? '').trim() && v !== false);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ================================================================== opsi (dibaca dari elemen data-k)
function opts() {
  const o = {};
  for (const el of $$('[data-k]')) {
    const k = el.dataset.k;
    if (el.classList.contains('seg')) o[k] = el.querySelector('button.on')?.dataset.v ?? '';
    else if (el.type === 'checkbox') o[k] = el.checked;
    else if (el.type === 'range') o[k] = +el.value;
    else o[k] = el.value;
  }
  o.font ||= DEFAULT_FONT;
  o.cam = S.cam;
  o.sfx = readSfxRows();
  o.has_sfx = o.sfx.length > 0;
  return o;
}
function setOpt(k, v) {
  const el = document.querySelector(`[data-k="${k}"]`);
  if (!el || v === undefined || v === null) return;
  if (el.classList.contains('seg')) {
    const b = el.querySelector(`button[data-v="${CSS.escape(String(v))}"]`);
    if (b && !b.disabled) el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  } else if (el.type === 'checkbox') el.checked = !!v;
  else if (el.tagName === 'SELECT') { if ([...el.options].some((op) => op.value === String(v))) el.value = String(v); else el.dataset.want = String(v); }
  else el.value = v;
}

const STORE = 'klipku-web-v2', OLD = 'klipku-web-v1', KEYS = 'klipku-web-keys', CAMK = 'klipku-web-cam', PRESETS = 'klipku-web-presets';
const SKIP_SAVE = ['cam', 'sfx', 'has_sfx'];
const saveSettings = debounce(() => {
  const o = opts();
  for (const k of SKIP_SAVE) delete o[k];
  o.sfxRows = readSfxRows();
  try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* penuh */ }
}, 300);

function applySettings(o) {
  if (!o) return;
  for (const [k, v] of Object.entries(o)) if (!SKIP_SAVE.includes(k) && k !== 'sfxRows') setOpt(k, v);
  if (o.font) $('font').dataset.want = o.font;
  if (Array.isArray(o.sfxRows)) { $('sfxRows').innerHTML = ''; o.sfxRows.forEach(addSfxRow); }
}
function loadSettings() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { o = null; }
  if (!o) {
    try { o = JSON.parse(localStorage.getItem(OLD) || 'null'); } catch { o = null; }
    if (o && !o.hook_tpl) {
      const box = o.hook_box || '';
      if (box === 'hitam') Object.assign(o, { hook_tpl: 'kotak', hook_bg: '#000000', hook_txt: '#ffffff', hook_align: 'tengah' });
      else if (box === 'putih') Object.assign(o, { hook_tpl: 'kotak', hook_bg: '#ffffff', hook_txt: '#000000', hook_align: 'tengah' });
      else if (box === 'polos') Object.assign(o, { hook_tpl: 'polos', hook_align: 'tengah' });
    }
  }
  if (!o && isPhone) o = { model: 'base' };
  applySettings(o);
  try { S.cam = JSON.parse(localStorage.getItem(CAMK) || 'null'); } catch { S.cam = null; }
  const k = readKeys();
  $('key_groq').value = k.groq || ''; $('key_gemini').value = k.gemini || ''; $('key_claude').value = k.claude || '';
}
function readKeys() { try { return JSON.parse(localStorage.getItem(KEYS) || '{}'); } catch { return {}; } }
function saveKeys() {
  const k = { groq: $('key_groq').value.trim(), gemini: $('key_gemini').value.trim(), claude: $('key_claude').value.trim() };
  try { localStorage.setItem(KEYS, JSON.stringify(k)); } catch { /* abaikan */ }
  return k;
}

// ================================================================== tampilan dinamis
const FMT = {
  x: (v) => v.toFixed(2) + '×', '%': (v) => Math.round(v) + '%', pct1: (v) => Math.round(v * 100) + '%',
  deg: (v) => v + '°', s: (v) => v + ' dtk', s1: (v) => v.toFixed(1) + ' dtk',
  auto: (v) => (v ? v + '% dari atas' : 'Otomatis'), autoPct: (v) => (v ? v + '%' : 'Tengah'),
};
function cond(expr, o) {
  return expr.split('&').every((part) => {
    part = part.trim();
    if (part.startsWith('!')) return !truthy(o[part.slice(1)]);
    const [k, vals] = part.split('=');
    if (vals === undefined) return truthy(o[k]);
    return vals.split(',').includes(String(o[k]));
  });
}
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', ((+el.value - min) / (max - min || 1)) * 100 + '%');
}
function refreshUI() {
  const o = opts();
  for (const out of $$('output[data-for]')) {
    const el = document.querySelector(`[data-k="${out.dataset.for}"]`);
    if (el) out.textContent = (FMT[out.dataset.fmt] || ((v) => v))(+el.value);
  }
  $$('input[type=range]').forEach(paintRange);
  const fc = document.querySelector('[data-k="layout"] button[data-v="facecam"]');
  fc.disabled = o.aspect !== '9:16';
  if (fc.disabled && o.layout === 'facecam') { setOpt('layout', 'static'); return refreshUI(); }
  for (const el of $$('[data-show]')) el.hidden = !cond(el.dataset.show, o);
  $$('.introRow').forEach((r) => { r.hidden = !o.intro_on; });
  $('pvLabel').textContent = o.aspect;
  $('frameBox').classList.toggle('draw', o.layout === 'facecam');
  const fh = $('frameHint');
  if (S.frame) {
    fh.hidden = false;
    fh.firstElementChild.textContent = o.layout === 'facecam' ? (S.cam ? 'Kotak kuning = facecam. Tarik lagi untuk mengganti.' : 'Tarik kotak di wajah streamer.')
      : o.layout === 'ai' ? (S.faces.length ? `${S.faces.length} wajah terdeteksi.` : 'Mencari wajah...') : 'Gambar ini dipakai untuk preview.';
  }
  drawBoxes();
  updateDock();
}

// ================================================================== font
function fillFonts() {
  const fonts = listFonts();
  const sel = $('font');
  const cur = sel.value || sel.dataset.want || DEFAULT_FONT;
  sel.innerHTML = '';
  const groups = {};
  for (const f of fonts) (groups[f.group] ??= []).push(f);
  for (const [g, arr] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = g;
    arr.forEach((f) => og.append(new Option(f.name, f.id)));
    sel.append(og);
  }
  sel.append(new Option('Tambah font sendiri...', '__add'));
  sel.value = fonts.some((f) => f.id === cur) ? cur : DEFAULT_FONT;
  delete sel.dataset.want;
  for (const id of ['wm_font', 'hook_font']) {
    const s2 = $(id);
    const v = s2.value || s2.dataset.want || '';
    s2.innerHTML = '';
    s2.append(new Option('Sama dengan subtitle', ''));
    fonts.forEach((f) => s2.append(new Option(f.name, f.id)));
    s2.value = fonts.some((f) => f.id === v) ? v : '';
    delete s2.dataset.want;
  }
}
const roleFonts = (o) => ({ sub: o.font || DEFAULT_FONT, hook: o.hook_font || o.font || DEFAULT_FONT, wm: o.wm_font || o.font || DEFAULT_FONT });
async function ensureFonts(o) {
  const f = roleFonts(o);
  await Promise.all([ensureFont(f.sub), ensureFont(f.hook), ensureFont(f.wm)]);
  return f;
}
function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}
async function addFonts(files) {
  let last = null;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      last = await addUserFont(f.name, buf);
      await putFile({ id: 'font:' + last.id, kind: 'font', name: f.name, blob: new Blob([buf]) });
    } catch (e) { alert(`Font ${f.name} tidak bisa dipakai. ${e.message}`); }
  }
  return last;
}

// ================================================================== gambar (logo, banner)
async function loadImg(key) {
  const rec = await getFile('img:' + key).catch(() => null);
  S.imgs[key] = rec ? await createImageBitmap(rec.blob).catch(() => null) : null;
  const th = { logo: 'logoThumb', banner_logo: 'bnLogoThumb', banner: 'bnThumb' }[key];
  if (S.imgs[key] && rec) { $(th).src = URL.createObjectURL(rec.blob); $(th).hidden = false; }
  else $(th).hidden = true;
  if (key === 'banner_logo') $('bnLogoDel').hidden = !S.imgs[key];
}
async function setImg(key, file) {
  if (!file) return;
  try {
    await createImageBitmap(file);
    await putFile({ id: 'img:' + key, kind: 'img', name: file.name, blob: file });
    await loadImg(key);
    if (key === 'logo') setOpt('logo_on', true);
    onChange();
  } catch { alert('Gambar ini tidak bisa dibaca. Coba file PNG atau JPG.'); }
}

// ================================================================== potongan
function addClip(c = {}) {
  const box = document.createElement('div');
  box.className = 'clip';
  const row = (cls, label, ph, v, now = true) => `<label class="cell"><span class="t">${label}</span><input type="text" class="${cls}" placeholder="${ph}" value="${esc(v || '')}" inputmode="decimal">${now ? '<button class="now" type="button" title="isi dari posisi video sekarang">Sekarang</button>' : ''}</label>`;
  box.innerHTML = `<div class="clip-head"><span class="ttl"></span><button class="link danger del" type="button">Hapus</button></div>
    <div class="list">
      ${row('s', 'Mulai', '0:00', c.s)}
      ${row('e', 'Selesai', '0:30', c.e)}
      <label class="cell col"><span class="t">Judul hook</span><input type="text" class="t2" placeholder="kosong berarti tanpa judul" value="${esc(c.t || '')}"></label>
      <div class="introRow" hidden>${row('i', 'Intro dari', 'awal potongan', c.i)}</div>
    </div>`;
  box.querySelector('.t2').setAttribute('inputmode', 'text');
  box.querySelector('.del').onclick = () => { box.remove(); numberClips(); onClipChange(); };
  box.querySelectorAll('.now').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      if (!S.src) return;
      const inp = b.previousElementSibling;
      inp.value = fmtTime($('player').currentTime || 0, true);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
  });
  box.addEventListener('input', (e) => { e.target.classList.remove('bad'); onClipChange(); });
  $('clips').append(box);
  numberClips();
  refreshUI();
}
function numberClips() {
  const all = [...$('clips').children];
  all.forEach((r, i) => {
    r.querySelector('.ttl').textContent = `Potongan ${i + 1}`;
    r.querySelector('.del').hidden = all.length < 2;
  });
  refreshSfxClipOptions();
}
function readClips(strict) {
  const out = [];
  [...$('clips').children].forEach((r, i) => {
    const g = (c) => r.querySelector('.' + c).value.trim();
    const c = { s: g('s'), e: g('e'), t: g('t2'), i: g('i'), row: r, n: i + 1 };
    if (!c.s && !c.e && !strict) return;
    out.push(c);
  });
  return out;
}
function clipTimes(c) {
  const bad = (cls, msg) => { c.row.querySelector('.' + cls).classList.add('bad'); return new Error(`Potongan ${c.n}: ${msg}`); };
  let s, e;
  try { s = parseTime(c.s); } catch (x) { throw bad('s', x.message); }
  try { e = parseTime(c.e); } catch (x) { throw bad('e', x.message); }
  if (e <= s) throw bad('e', 'waktu selesai harus setelah waktu mulai.');
  if (e - s > MAX_CLIP + 0.01) throw bad('e', `maksimal 3 menit per potongan (sekarang ${fmtTime(e - s)}).`);
  if (S.src && s >= S.src.duration) throw bad('s', `videonya cuma ${fmtTime(S.src.duration)}.`);
  if (S.src) e = Math.min(e, S.src.duration);
  return { s, e };
}
/** '1:23:40' (menit video) atau '0:12' (detik di dalam potongan) -> detik relatif. */
function clipRel(raw, s, e, what) {
  raw = String(raw ?? '').trim();
  if (!raw) return null;
  const t = parseTime(raw);
  if (t >= s && t < e) return t - s;
  if (t < e - s && t < s) return t;
  throw new Error(`${what} ${raw} harus di antara ${fmtTime(s)} dan ${fmtTime(e)}.`);
}

// ================================================================== sound effect & musik
const AT_LABEL = { awal: 'Di awal', akhir: 'Di akhir', ulang: 'Saat video diulang', menit: 'Di menit', kata: 'Saat kata diucapkan', zoom: 'Tiap zoom kejut' };
function addSfxRow(r = {}) {
  const box = document.createElement('div');
  box.className = 'sfx';
  box.innerHTML = `<div class="clip-head"><span>Sound effect</span><button class="link danger del" type="button">Hapus</button></div>
    <div class="list">
      <label class="cell"><span class="t">Suara</span><select class="sf"></select></label>
      <div class="cell"><span class="t">Dengar</span><button class="link play" type="button">Putar</button></div>
      <label class="cell"><span class="t">Kapan</span><select class="sa">${Object.entries(AT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="cell st-row"><span class="t st-lbl">Menit</span><input type="text" class="st" placeholder="0:12"></label>
      <label class="cell"><span class="t">Potongan</span><select class="sc"><option value="0">Semua</option></select></label>
      <div class="cell col"><div class="lr"><span class="t">Volume</span><output class="svo">100%</output></div><input type="range" class="sv" min="10" max="200" value="100"></div>
      <label class="cell"><span class="t">Batasi lama (detik)</span><input type="text" class="sl" placeholder="penuh" inputmode="decimal"></label>
    </div>`;
  $('sfxRows').append(box);
  fillSfxSelect(box.querySelector('.sf'), r.file);
  refreshSfxClipOptions();
  box.querySelector('.sa').value = r.at || 'awal';
  box.querySelector('.st').value = r.time || '';
  box.querySelector('.sc').value = String(r.clip || 0);
  box.querySelector('.sv').value = r.vol || 100;
  box.querySelector('.sl').value = r.len || '';
  const sync = () => {
    const at = box.querySelector('.sa').value;
    box.querySelector('.st-row').hidden = !(at === 'menit' || at === 'kata');
    box.querySelector('.st-lbl').textContent = at === 'kata' ? 'Kata' : 'Menit';
    box.querySelector('.st').placeholder = at === 'kata' ? 'anjir' : '0:12';
    box.querySelector('.st').setAttribute('inputmode', at === 'kata' ? 'text' : 'decimal');
    box.querySelector('.svo').textContent = box.querySelector('.sv').value + '%';
    paintRange(box.querySelector('.sv'));
  };
  sync();
  box.addEventListener('input', () => { sync(); saveSettings(); refreshUI(); });
  box.addEventListener('change', () => { sync(); saveSettings(); });
  box.querySelector('.del').onclick = () => { box.remove(); saveSettings(); refreshUI(); };
  box.querySelector('.play').onclick = () => playLib(box.querySelector('.sf').value, 'sfx');
  refreshUI();
}
function fillSfxSelect(sel, want) {
  const v = want ?? (sel.value || sel.dataset.want);
  sel.innerHTML = S.sfxLib.length ? '' : '<option value="">Upload dulu</option>';
  S.sfxLib.forEach((it) => sel.append(new Option(`${it.name} (${it.dur.toFixed(1)} dtk)`, it.id)));
  if (v && S.sfxLib.some((x) => x.id === v)) { sel.value = v; delete sel.dataset.want; } else if (v) sel.dataset.want = v;
}
function refreshSfxClipOptions() {
  const n = $('clips').children.length;
  for (const sel of $$('#sfxRows .sc')) {
    const v = sel.value;
    sel.innerHTML = '<option value="0">Semua</option>' + Array.from({ length: n }, (_, i) => `<option value="${i + 1}">Potongan ${i + 1}</option>`).join('');
    sel.value = +v <= n ? v : '0';
  }
}
function readSfxRows() {
  return $$('#sfxRows .sfx').map((d) => ({
    file: d.querySelector('.sf').value, at: d.querySelector('.sa').value, time: d.querySelector('.st').value.trim(),
    clip: +d.querySelector('.sc').value, vol: +d.querySelector('.sv').value, len: parseFloat(d.querySelector('.sl').value) || 0,
  })).filter((x) => x.file);
}
async function loadLibs() {
  try {
    S.sfxLib = await listFiles('sfx');
    S.musicLib = await listFiles('musik');
  } catch { S.sfxLib = []; S.musicLib = []; }
  $$('#sfxRows .sf').forEach((sel) => fillSfxSelect(sel));
  const ms = $('music');
  const v = ms.value || ms.dataset.want || '';
  ms.innerHTML = '<option value="">Tanpa musik</option>';
  S.musicLib.forEach((it) => ms.append(new Option(it.name, it.id)));
  ms.value = S.musicLib.some((x) => x.id === v) ? v : '';
  delete ms.dataset.want;
  $('sfxFoot').textContent = S.sfxLib.length
    ? `${S.sfxLib.length} sound effect tersimpan di browser ini. Volumenya disamakan otomatis.`
    : 'Upload sound effect milikmu (MP3, WAV, M4A). File tersimpan di browser ini, jadi cukup sekali. Volumenya disamakan otomatis.';
}
async function uploadAudio(files, kind) {
  let lastId = null;
  for (const f of files) {
    try {
      const buf = await AU.decodeFile(f);
      if (buf.duration <= 0.05) throw new Error('kosong');
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 60);
      const id = kind + ':' + slug(name, 40) + '-' + Math.random().toString(36).slice(2, 6);
      await putFile({ id, kind, name, blob: f, dur: buf.duration, gain: AU.analyzeGain(buf) });
      S.decoded.set(id, buf);
      lastId = id;
    } catch { alert(`File ${f.name} tidak bisa dibaca sebagai audio.`); }
  }
  await loadLibs();
  return lastId;
}
let playing = null;
async function playLib(id, kind) {
  if (playing) { playing.pause(); playing = null; return; }
  const it = (kind === 'sfx' ? S.sfxLib : S.musicLib).find((x) => x.id === id);
  if (!it) return;
  playing = new Audio(URL.createObjectURL(it.blob));
  playing.onended = () => { playing = null; };
  playing.play().catch(() => { playing = null; });
}
async function decodedLib(id) {
  if (S.decoded.has(id)) return S.decoded.get(id);
  const it = [...S.sfxLib, ...S.musicLib].find((x) => x.id === id);
  if (!it) return null;
  const buf = await AU.decodeFile(it.blob);
  S.decoded.set(id, buf);
  return buf;
}

// ================================================================== video
async function loadVideo(file, fromLink = null) {
  if (!file) return;
  S.linkInfo = fromLink;
  if (S.busy) return alert('Tunggu proses yang sedang berjalan selesai dulu.');
  $('vbox').hidden = false;
  $('drop').hidden = true;
  $('vname').textContent = file.name;
  $('vmeta').textContent = 'Membuka video...';
  try {
    S.src = await Source.open(file);
  } catch (e) {
    S.src = null;
    $('vmeta').textContent = e.message;
    $('vmeta').style.color = 'var(--red)';
    updateDock();
    return;
  }
  $('vmeta').style.color = '';
  const s = S.src;
  const p = $('player');
  if (p.src) URL.revokeObjectURL(p.src);
  p.src = URL.createObjectURL(file);
  $('vmeta').textContent = `${fmtTime(s.duration)} · ${s.dispW}×${s.dispH} · ${Math.round(s.fps)} fps · ${s.audio ? 'ada suara' : 'tanpa suara'} · ${mbStr(file.size)}`
    + (Math.min(s.dispW, s.dispH) < 720 ? ` · resolusi rendah, hasil bisa kurang tajam` : '');
  if (!readClips(false).length) {
    $('clips').innerHTML = '';
    addClip({ s: '0:00', e: fmtTime(Math.min(30, Math.floor(s.duration))) });
  }
  S.stem = file.name.replace(/\.[^.]+$/, '');
  document.body.classList.add('has-video');
  $('btnFrame').disabled = false;
  $('pvTime').hidden = false;
  updateDock();
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
    if (!fr) throw new Error('Gambar di menit itu tidak bisa dibaca.');
    S.frame = fr; S.faces = [];
    const cv = $('frame');
    cv.width = fr.width; cv.height = fr.height;
    cv.getContext('2d').drawImage(fr, 0, 0);
    $('frameBox').hidden = false;
    setPreviewRange();
    $('pvTime').value = t;
    S.pvFrame = fr; S.pvFaces = [];
    refreshUI();
    await drawPreview();
    if (opts().layout === 'ai') await detectOnFrames();
  } catch (e) {
    $('frameHint').hidden = false;
    $('frameHint').firstElementChild.textContent = e.message;
  } finally {
    $('btnFrame').disabled = false;
  }
}

async function detectOnFrames() {
  if (!S.frame) return;
  try {
    S.faces = await CAM.detectFaces(S.frame, S.frame.width, S.frame.height);
    S.pvFaces = S.pvFrame === S.frame ? S.faces : await CAM.detectFaces(S.pvFrame, S.pvFrame.width, S.pvFrame.height);
    if (!S.faces.length) $('frameHint').firstElementChild.textContent = 'Tidak ada wajah di gambar ini. Kamera AI akan diam di tengah.';
    else refreshUI();
    drawPreview();
  } catch (e) {
    $('frameHint').firstElementChild.textContent = 'Deteksi wajah gagal: ' + e.message;
  }
}

function drawBoxes() {
  const host = $('boxes');
  host.innerHTML = '';
  const layout = document.querySelector('[data-k="layout"] button.on')?.dataset.v;
  const put = (r, cls, label) => {
    const d = document.createElement('div');
    d.className = 'box ' + cls;
    Object.assign(d.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
    d.innerHTML = `<span>${label}</span>`;
    host.append(d);
  };
  if (layout === 'facecam' && S.cam) put(S.cam, '', 'Facecam');
  if (layout === 'ai') S.faces.forEach((f) => put(f, 'face', 'Wajah'));
}

function setupFacecamDraw() {
  const box = $('frameBox');
  let start = null;
  const pos = (e) => {
    const r = box.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  box.addEventListener('pointerdown', (e) => {
    if (opts().layout !== 'facecam') return;
    start = pos(e); box.setPointerCapture(e.pointerId); e.preventDefault();
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
    refreshUI();
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
  paintRange(r);
}
function aiZoom(o, W, H) {
  let z = +o.ai_zoom || (H > W ? 1 : 1.4);
  if (W >= H) z = Math.max(1.15, z);
  return z;
}
function previewChunks(o) {
  const n = Math.max(1, Math.min(3, +o.per_line || 3));
  const ws = ['INI', 'CONTOH', 'TEKS'].slice(0, n);
  return [{ start: 0.2, end: 2.4, words: ws.map((t, i) => ({ s: [0.2, 1.0, 1.6][i], e: 2.4, t })) }];
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
    let rect = null, g, behind = null;
    if (o.layout === 'ai' && fr) {
      const f = S.pvFaces.reduce((a, b) => (!a || b.w * b.h > a.w * a.h ? b : a), null);
      rect = CAM.cropRect(f ? f.x + f.w / 2 : 0.5, f ? f.y + f.h / 2 : 0.5, sw, sh, W, H, aiZoom(o, W, H));
    }
    const banner = bannerLayout(o, W, H, fonts.hook, S.imgs.banner_logo, S.imgs.banner);
    const safe = banner?.bottom || 0;
    if (o.layout === 'static' && fr) {
      const b = staticBox(o, sw, sh, W, H);
      g = geom(o, W, H, b.top, b.bot);
      if (o.wm_mode === 'belakang' && !b.full) behind = (c) => drawWatermark(c, 0, o, W, H, fonts.wm, 10, true, safe);
    } else g = geom(o, W, H);
    drawBase(ctx, fr, sw, sh, o, W, H, { rect, behind });
    if (!fr) {
      const grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, '#3a3a3c'); grd.addColorStop(1, '#1c1c1e');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    }
    const c1 = readClips(false)[0];
    const end = S.pvMode === 'akhir';
    const title = c1?.t || '';
    const ov = {
      o: end ? o : { ...o, cta_text: '' }, W, H, g, dur: 10, chunks: o.subs ? previewChunks(o) : [],
      hook: end ? '' : (title || 'Contoh *judul hook* kamu muncul di sini'), hookAlpha: title ? 1 : 0.55, hookSpan: null,
      credit: o.credit ? `Sumber: ${o.channel || 'nama channel'}` : '', flashAt: null, logo: S.imgs.logo, fonts,
      behind: !!behind || (o.wm_mode === 'belakang'), banner, channel: o.channel,
    };
    if (!end) ov.o = { ...ov.o, hook_secs: 0 };
    drawOverlay(ctx, end ? 9.8 : 1.0, ov);
    S.hookEl = !end && ov._hook ? ov._hook.el : null;
    if (end && !String(o.cta_text || '').trim()) {
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, H * 0.45, W, H * 0.07);
      ctx.fillStyle = '#fff'; ctx.font = `600 ${H * 0.024}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Teks penutup masih kosong', W / 2, H * 0.485); ctx.restore();
    }
    $('pvHint').textContent = !fr ? 'Pilih video untuk melihat preview asli.'
      : end ? 'Ini tampilan akhir video: teks penutup dan garis progres.' : 'Tarik judul untuk memindahkannya.';
  } catch (e) {
    $('pvHint').textContent = 'Preview gagal: ' + e.message;
  } finally {
    pvBusy = false;
    if (pvAgain) { pvAgain = false; drawPreview(); }
  }
}
const drawPreviewSoon = debounce(drawPreview, 50);
const scrubPreview = debounce(async () => {
  if (!S.src) return;
  const fr = await S.src.frameAt(+$('pvTime').value);
  if (!fr) return;
  S.pvFrame = fr; S.pvFaces = [];
  if (opts().layout === 'ai') { try { S.pvFaces = await CAM.detectFaces(fr, fr.width, fr.height); } catch { /* abaikan */ } }
  drawPreview();
}, 120);

function setupHookDrag() {
  const cv = $('pv');
  let d = null;
  const pt = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height };
  };
  const inside = (p) => { const b = S.hookEl?.bounds; return b && p.x >= b.x0 - 24 && p.x <= b.x1 + 24 && p.y >= b.y0 - 24 && p.y <= b.y1 + 24; };
  cv.addEventListener('pointermove', (e) => {
    if (!d) { cv.classList.toggle('can', S.pvMode === 'awal' && !!inside(pt(e))); return; }
    const p = pt(e);
    let x = d.x0 + ((p.x - d.p0.x) / cv.width) * 100, y = d.y0 + ((p.y - d.p0.y) / cv.height) * 100;
    x = Math.max(2, Math.min(98, x)); y = Math.max(3, Math.min(97, y));
    if (opts().hook_align === 'tengah' && Math.abs(x - 50) < 2.5) x = 50;
    setOpt('hook_x', Math.round(x * 2) / 2); setOpt('hook_y', Math.round(y * 2) / 2);
    refreshUI(); drawPreviewSoon();
  });
  cv.addEventListener('pointerdown', (e) => {
    if (S.pvMode !== 'awal') return;
    const p = pt(e);
    if (!inside(p)) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const el = S.hookEl;
    if (opts().hook_pos !== 'bebas') {
      setOpt('hook_y', Math.round(((el.top + el.blockH / 2) / cv.height) * 200) / 2);
      setOpt('hook_x', Math.round((el.ax / cv.width) * 200) / 2);
      setOpt('hook_pos', 'bebas');
    }
    d = { p0: p, x0: +document.querySelector('[data-k="hook_x"]').value, y0: +document.querySelector('[data-k="hook_y"]').value };
    cv.classList.add('drag');
  });
  const up = () => { if (!d) return; d = null; cv.classList.remove('drag'); onChange(); };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
}

// ================================================================== kemampuan browser
let gpuCache = null;
async function gpuInfo() {
  if (gpuCache) return gpuCache;
  gpuCache = { webgpu: false, f16: false };
  try {
    const ad = navigator.gpu && (await navigator.gpu.requestAdapter());
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
    $('encInfo').textContent = codec
      ? `Hasil ${W}×${H}, ${CODEC_LABEL[codec] || codec}, ${(bitrate / 1e6).toFixed(0)} Mbps. Pakai GPU kalau ada.`
      : 'Browser ini tidak bisa membuat video. Pakai Chrome, Edge, atau Safari versi terbaru.';
  } catch (e) {
    $('encInfo').textContent = e.message;
  }
}
async function checkSupport() {
  const miss = [];
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) miss.push('WebCodecs');
  if (!('OfflineAudioContext' in window)) miss.push('Web Audio');
  if (miss.length) {
    $('banner').hidden = false;
    $('banner').textContent = 'Browser ini belum bisa membuat video. Buka KlipKu di Chrome, Edge, atau Safari versi terbaru.';
  }
  const g = await gpuInfo();
  $('gpuInfo').textContent = g.webgpu
    ? 'Subtitle diproses dengan GPU perangkat ini. Model di-download sekali, lalu tersimpan di browser.'
    : 'Perangkat ini memproses subtitle tanpa GPU, jadi lebih lambat. Model paling akurat butuh GPU. Kalau punya kunci Groq, pilih Groq supaya cepat.';
}

// ================================================================== Whisper (worker)
let worker = null;
const getWorker = () => (worker ??= new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' }));
function killWorker() { if (worker) { worker.terminate(); worker = null; } }
const MODEL_ID = {
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo_timestamped',
};
const MODEL_NAME = { base: 'cepat', small: 'seimbang', 'large-v3-turbo': 'paling akurat' };
function whisperConfig(name, g, forceWasm = false) {
  if (forceWasm || !g.webgpu) {
    const n = name === 'large-v3-turbo' ? 'small' : name;
    return { name: n, id: MODEL_ID[n], device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
  }
  const id = MODEL_ID[name] || MODEL_ID.small;
  if (name === 'base') return { name, id, device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
  if (name === 'large-v3-turbo') return { name, id, device: 'webgpu', dtype: g.f16 ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } : { encoder_model: 'q4', decoder_model_merged: 'q4' } };
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
    w.onerror = (e) => reject(new Error(e.message || 'Proses subtitle berhenti.'));
    const copy = pieces.map((p) => ({ start: p.start, data: p.data.slice() }));
    w.postMessage({ type: 'run', model: cfg.id, device: cfg.device, dtype: cfg.dtype, language, pieces: copy }, copy.map((p) => p.data.buffer));
  });
}

// ================================================================== sheet proses
const STEP_LABELS = {
  prep: 'Baca video dan suara', model: 'Siapkan model subtitle', subs: 'Bikin subtitle', fix: 'Rapikan subtitle',
  hookai: 'Judul dari AI', review: 'Cek judul dan subtitle', ai: 'Kamera AI cari wajah', render: 'Render video',
};
const STEP_W = { prep: 8, model: 8, subs: 24, fix: 4, hookai: 4, review: 0, ai: 14, render: 38 };
const J = { steps: {}, keys: [], clipNo: 0, clips: 1, t0: 0, timer: null };

function openSheet(nClips) {
  Object.assign(J, { clipNo: 0, clips: nClips, t0: performance.now() });
  $('sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  ['notes', 'warns', 'steps', 'sheetResults'].forEach((id) => { $(id).innerHTML = ''; });
  $('err').hidden = true; $('rvBox').hidden = true;
  $('btnCancel').hidden = false; $('btnClose').hidden = true;
  $('sheetTitle').textContent = 'Membuat clip';
  clearInterval(J.timer);
  J.timer = setInterval(() => { $('elapsed').textContent = `Berjalan ${fmtTime((performance.now() - J.t0) / 1000)}`; }, 1000);
}
function closeSheet() { $('sheet').hidden = true; document.body.style.overflow = ''; }
function clipBegin(i, keys) {
  J.clipNo = i; J.keys = keys; J.steps = {};
  $('sheetTitle').textContent = J.clips > 1 ? `Clip ${i + 1} dari ${J.clips}` : 'Membuat clip';
  $('steps').innerHTML = keys.map((k) => `<div class="cell stp" id="st-${k}"><span class="dot"></span><span class="t">${STEP_LABELS[k]}<small></small></span><span class="pc"></span></div>`).join('');
  for (const k of keys) J.steps[k] = { p: 0, state: 'tunggu' };
  overall();
}
function step(key, p = null, info = null, state = null) {
  const st = J.steps[key];
  if (!st) return;
  if (p != null) st.p = Math.max(0, Math.min(1, p));
  st.state = state || (st.p >= 1 ? 'selesai' : 'jalan');
  const el = $('st-' + key);
  el.className = 'cell stp ' + st.state;
  el.querySelector('.pc').textContent = st.state === 'jalan' ? Math.round(st.p * 100) + '%' : '';
  if (info != null) el.querySelector('small').textContent = info;
  overall();
}
const skip = (key, info) => step(key, 1, info, 'lewat');
function overall() {
  let tw = 0, done = 0;
  for (const k of J.keys) { tw += STEP_W[k]; done += STEP_W[k] * (J.steps[k]?.p || 0); }
  const all = (J.clipNo + (tw ? done / tw : 0)) / J.clips;
  $('pctAll').textContent = Math.floor(all * 100) + '%';
  $('barFill').style.width = all * 100 + '%';
}
const stage = (t) => { $('stage').textContent = t; $('dockStatus').textContent = t; };
const note = (t) => $('notes').insertAdjacentHTML('beforeend', `<div class="note">${esc(t)}</div>`);
const warn = (t) => $('warns').insertAdjacentHTML('beforeend', `<div class="warnx">${esc(t)}</div>`);
const checkCancel = () => { if (S.cancel) throw new Error('DIBATALKAN'); };

function review(chunks, title, sug) {
  return new Promise((resolve) => {
    $('rvTitle').value = title || '';
    $('rvHooks').hidden = !sug?.hooks?.length;
    $('rvChips').innerHTML = (sug?.hooks || []).map((h, i) => `<button type="button" data-i="${i}">${esc(h)}</button>`).join('');
    $$('#rvChips button').forEach((b) => { b.onclick = () => { $('rvTitle').value = sug.hooks[+b.dataset.i]; }; });
    $('rvCapCell').hidden = !sug?.caption;
    $('rvCaption').value = sug ? [sug.caption, (sug.hashtags || []).join(' ')].filter(Boolean).join('\n\n') : '';
    $('rvRows').innerHTML = chunks.map((c, i) => `<div class="cell sr"><code>${fmtTime(c.start, true)}</code><input type="text" data-i="${i}" value="${esc(c.text)}"></div>`).join('');
    $('rvBox').hidden = false;
    $('rvBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const done = (useEdits) => {
      $('rvBox').hidden = true;
      clearInterval(poll);
      if (!useEdits) return resolve({ chunks, title, caption: null });
      const edited = $$('#rvRows input').map((inp) => { const c = chunks[+inp.dataset.i]; return { start: c.start, end: c.end, text: inp.value }; });
      resolve({ chunks: SUB.applyEdits(chunks, edited), title: $('rvTitle').value.trim(), caption: $('rvCaption').value.trim() || null });
    };
    $('btnRv').onclick = () => done(true);
    $('btnRvSkip').onclick = () => done(false);
    const poll = setInterval(() => { if (S.cancel) done(false); }, 300);
  });
}

// ================================================================== timeline
function fpsOut(o, srcFps) {
  const src = Math.max(1, Math.round(srcFps));
  return o.fps === 'src' ? Math.min(60, src) : Math.min(+o.fps || 30, src);
}
/** Segmen hasil: intro (teaser/rewind) + bagian utama (boleh terpotong oleh potong jeda). */
function makeTimeline(o, dur, rel, F, parts) {
  const segs = [];
  if (o.intro_on) {
    let n = +o.intro_len || 3;
    let t0 = rel ?? 0;
    t0 = Math.min(Math.max(0, t0), Math.max(0, dur - 0.6));
    n = Math.max(0.5, Math.min(n, dur - t0));
    segs.push({ kind: 'play', src: t0, dur: n, teaser: true });
    if (o.intro_fx === 'rewind') segs.push({ kind: 'rewind', src: t0, dur: n });
  }
  for (const [a, b] of parts) segs.push({ kind: 'play', src: a, dur: b - a, main: true });
  let out = 0;
  for (const sg of segs) {
    sg.frames = Math.max(1, Math.round((sg.kind === 'rewind' ? sg.dur / 4 : sg.dur) * F));
    sg.out = out; sg.outDur = sg.frames / F; out += sg.outDur;
  }
  return segs;
}
function outMapper(segs) {
  const main = segs.filter((s) => s.main);
  return (t) => {
    for (const s of main) if (s.src <= t && t < s.src + s.dur) return s.out + t - s.src;
    for (const s of main) if (t < s.src) return s.out;
    return null;
  };
}
function teaserTimes(segs, t) {
  const sg = segs.find((s) => s.teaser);
  return sg && sg.src <= t && t < sg.src + sg.dur ? [sg.out + t - sg.src] : [];
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
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * hop; k < (i + 1) * hop; k++) s += mono[k] * mono[k]; rms[i] = Math.sqrt(s / hop + 1e-9); }
  const med = [...rms].sort((a, b) => a - b)[Math.floor(n / 2)] + 1e-6;
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

// ================================================================== subtitle
async function makeSubtitles(o, mono16, keys, clip) {
  const terms = SUB.parseTerms(o.prompt), rules = SUB.parseRules(o.rules);
  let words = null, dev = '';
  const lang = o.lang === 'auto' ? null : o.lang;
  if (o.engine === 'groq') {
    if (!keys.groq) warn('Groq dipilih tapi kunci API Groq belum diisi. Subtitle dibuat di perangkat ini.');
    else {
      stage(`Potongan ${clip.n}: bikin subtitle di Groq...`);
      skip('model', 'online, tanpa download');
      step('subs', 0.15, 'mengirim suara ke Groq');
      try {
        words = await SUB.groqTranscribe(SUB.wavBlob(mono16, 16000), keys.groq, 'large-v3-turbo', lang, terms);
        dev = 'Groq';
      } catch (e) {
        warn(e.message + ' Subtitle dibuat di perangkat ini.');
        words = null;
      }
    }
  }
  if (!words) {
    const g = await gpuInfo();
    let cfg = whisperConfig(o.model, g);
    if (cfg.name !== o.model) warn(`Model ${MODEL_NAME[o.model]} butuh GPU, jadi dipakai model ${MODEL_NAME[cfg.name]}.`);
    const pieces = SUB.splitForWhisper(mono16, 16000);
    const attempt = async (c) => {
      stage(`Potongan ${clip.n}: siapkan model subtitle...`);
      step('model', 0.02, 'cek model');
      step('subs', 0, '');
      const t0 = performance.now();
      return runWhisper(c, pieces, lang,
        (l, t, ready) => {
          if (ready) { step('model', 1, `model ${MODEL_NAME[c.name]} siap (${c.device === 'webgpu' ? 'GPU' : 'CPU'})`); stage(`Potongan ${clip.n}: bikin subtitle...`); }
          else step('model', l / Math.max(1, t), `download ${mbStr(l)} dari ${mbStr(t)}, sekali saja`);
        },
        (d, n) => step('subs', d / n, `bagian ${d} dari ${n}, ${((performance.now() - t0) / 1000).toFixed(0)} dtk`));
    };
    try {
      words = await attempt(cfg);
    } catch (e) {
      checkCancel();
      if (cfg.device !== 'webgpu') throw new Error('Subtitle gagal dibuat: ' + e.message);
      warn('GPU tidak bisa dipakai untuk subtitle, pindah ke CPU.');
      killWorker();
      cfg = whisperConfig(o.model, g, true);
      words = await attempt(cfg);
    }
    dev = `model ${MODEL_NAME[cfg.name]} di ${cfg.device === 'webgpu' ? 'GPU' : 'CPU'}`;
  }
  step('subs', 1, `${words.length} kata`);
  note(`Subtitle dibuat dengan ${dev}.`);
  checkCancel();
  step('fix', 0.2, 'kamus dan kata khusus');
  let n1, n2;
  [words, n1] = SUB.applyRules(words, rules);
  [words, n2] = SUB.applyTerms(words, terms);
  if (n1 || n2) note(`Kata yang diganti otomatis: ${n1} dari kamus, ${n2} dari kata khusus.`);
  const [W] = ASPECTS[o.aspect];
  let chunks = SUB.makeChunks(words, +o.per_line, maxCharsFor(o, W));
  if (['gemini', 'claude'].includes(o.ai_fix) && chunks.length) {
    const key = keys[o.ai_fix];
    if (!key) warn(`Koreksi AI dilewati karena kunci ${o.ai_fix === 'gemini' ? 'Gemini' : 'Claude'} belum diisi.`);
    else {
      stage(`Potongan ${clip.n}: koreksi AI...`);
      step('fix', 0.4, o.ai_fix === 'gemini' ? 'Gemini mendengarkan audio' : 'Claude membaca subtitle');
      try {
        const fixed = await SUB.aiCorrect(chunks.map((c) => c.text), o.ai_fix, key, o.ai_model.trim(),
          { title: clip.t || S.stem, channel: o.channel, terms }, o.ai_fix === 'gemini' ? SUB.wavBlob(mono16, 16000) : null);
        const changed = chunks.filter((c, i) => c.text !== fixed[i]).length;
        chunks = SUB.applyEdits(chunks, chunks.map((c, i) => ({ start: c.start, end: c.end, text: fixed[i] })));
        note(`Koreksi AI mengubah ${changed} baris.`);
      } catch (e) { warn(e.message); }
    }
  }
  step('fix', 1, `${chunks.length} baris`);
  return { chunks, words };
}

// ================================================================== sound effect per clip
async function sfxEvents(o, clipNo, s, e, segs, outDur, words, punchOut) {
  const toOut = outMapper(segs);
  const intro = segs.some((x) => x.teaser);
  const mainStart = segs.find((x) => x.main)?.out ?? 0;
  const evs = [];
  for (const row of (o.sfx || []).slice(0, 30)) {
    if (row.clip && row.clip !== clipNo) continue;
    const it = S.sfxLib.find((x) => x.id === row.file);
    if (!it) continue;
    const buf = await decodedLib(it.id);
    if (!buf) continue;
    const eff = row.len > 0 ? Math.min(row.len, it.dur) : it.dur;
    let times = [];
    if (row.at === 'awal') times = [0];
    else if (row.at === 'akhir') times = [Math.max(0, outDur - eff)];
    else if (row.at === 'ulang') { if (intro) times = [mainStart]; else warn(`SFX ${it.name} (saat diulang) dilewati karena intro mati.`); }
    else if (row.at === 'menit') {
      try { const r = clipRel(row.time, s, e, `Waktu SFX ${it.name}`); if (r != null) { const t = toOut(r); if (t != null) times = [t]; } } catch (x) { warn(x.message); }
    } else if (row.at === 'kata') {
      const target = String(row.time || '').split(/\s+/).map(bare).filter(Boolean);
      if (!target.length) continue;
      if (!words?.length) { warn(`SFX ${it.name} (saat kata diucapkan) butuh subtitle aktif.`); continue; }
      const bw = words.map((w) => bare(w.t));
      let last = -99;
      for (let i = 0; i + target.length <= words.length; i++) {
        if (target.every((t, k) => bw[i + k] === t)) {
          const t = toOut(words[i].s);
          if (t != null && t - last >= eff && times.length < 6) { times.push(t); last = t; }
        }
      }
      if (!times.length) note(`Kata "${row.time}" tidak terdengar di potongan ${clipNo}, SFX ${it.name} tidak dipasang.`);
    } else if (row.at === 'zoom') {
      times = [...punchOut];
      if (!times.length) note(`SFX ${it.name} tidak dipasang karena tidak ada zoom kejut.`);
    }
    for (const t of times) if (t < outDur - 0.05) evs.push({ buf, t, vol: Math.max(0, row.vol || 100) / 100, len: Math.min(eff, outDur - t), gain: it.gain, name: it.name });
  }
  if (evs.length) note('Sound effect: ' + evs.slice(0, 8).map((x) => `${x.name} di ${x.t.toFixed(1)} dtk`).join(', ') + (evs.length > 8 ? ', ...' : ''));
  return evs;
}

// ================================================================== proses satu potongan
async function processClip(o, clip, idx, keys) {
  const src = S.src;
  const { s, e } = clipTimes(clip);
  let rel = clipRel(clip.i, s, e, 'Intro');
  const dur = e - s;
  const [W, H] = ASPECTS[o.aspect];
  if (o.layout === 'facecam' && !o.cam) throw new Error('Kotak facecam belum dipilih. Ambil gambar, lalu tarik kotak di wajah streamer.');
  const useAI = o.subs && ['gemini', 'claude'].includes(o.hook_ai);
  const stepKeys = ['prep'];
  if (o.subs) stepKeys.push('model', 'subs', 'fix');
  if (useAI) stepKeys.push('hookai');
  if (o.subs && o.review) stepKeys.push('review');
  if (o.layout === 'ai') stepKeys.push('ai');
  stepKeys.push('render');
  clipBegin(idx, stepKeys);
  const fonts = await ensureFonts(o);

  // 1) suara
  stage(`Potongan ${clip.n}: membaca ${fmtTime(s)} sampai ${fmtTime(e)}...`);
  step('prep', 0.1, 'membaca suara');
  const audio48 = await src.audioRange(s, e);
  checkCancel();
  const mono16 = audio48 ? (await resample(audio48, 16000, 1)).getChannelData(0) : null;
  step('prep', 1, audio48 ? `${fmtTime(dur, true)}, ada suara` : `${fmtTime(dur, true)}, tanpa suara`);

  // 2) subtitle, judul AI, cek
  let chunks = [], words = [], title = clip.t, caption = null, peak = null, sug = null;
  if (o.subs) {
    if (!mono16) {
      warn('Video ini tidak punya suara, jadi subtitle dilewati.');
      ['model', 'subs', 'fix', 'hookai', 'review'].forEach((k) => skip(k, 'tanpa suara'));
    } else {
      ({ chunks, words } = await makeSubtitles(o, mono16, keys, clip));
      checkCancel();
      if (useAI) {
        const key = keys[o.hook_ai];
        if (!key || !chunks.length) { skip('hookai', !key ? 'kunci API belum diisi' : 'tidak ada ucapan'); if (!key) warn(`Judul AI dilewati karena kunci ${o.hook_ai === 'gemini' ? 'Gemini' : 'Claude'} belum diisi.`); }
        else {
          stage(`Potongan ${clip.n}: AI membuat judul...`);
          step('hookai', 0.3, o.hook_ai === 'gemini' ? 'Gemini mendengarkan clip' : 'Claude membaca transkrip');
          try {
            sug = await SUB.aiHook(o.hook_ai, key, o.ai_fix === o.hook_ai ? o.ai_model.trim() : '', chunks,
              { title: S.stem, channel: o.channel }, o.hook_ai === 'gemini' ? SUB.wavBlob(mono16, 16000) : null);
            caption = [sug.caption, sug.hashtags.join(' ')].filter(Boolean).join('\n\n') || null;
            peak = sug.puncak;
            if (!title) title = sug.hooks[0];
            step('hookai', 1, `${sug.hooks.length} pilihan judul`);
          } catch (x) { warn(x.message); step('hookai', 1, 'gagal, lanjut tanpa judul AI'); }
        }
      }
      if (o.review && chunks.length) {
        stage(`Potongan ${clip.n}: cek judul dan subtitle, lalu tekan Lanjut render.`);
        step('review', 0.5, 'menunggu kamu');
        const r = await review(chunks, title, sug);
        checkCancel();
        chunks = r.chunks; title = r.title; if (r.caption) caption = r.caption;
        step('review', 1, 'oke');
      } else if (o.review) skip('review', 'tidak ada ucapan');
      if (!chunks.length) warn('Tidak ada ucapan yang terdengar. Clip dibuat tanpa subtitle.');
    }
  }
  if (rel == null && peak != null && o.intro_on) {
    rel = Math.max(0, Math.min(peak - 0.6, dur - 1));
    note(`Intro diambil dari momen pilihan AI (detik ${rel.toFixed(1)}).`);
  }

  // 3) potong jeda & zoom kejut
  const F = fpsOut(o, src.fps);
  let parts = [[0, dur]];
  if (o.jc_on) {
    parts = AU.keepParts(AU.speechSpans(words, mono16), dur, Math.max(0.3, +o.jc_gap || 0.8));
    const cut = dur - parts.reduce((a, [x, y]) => a + y - x, 0);
    if (cut > 0.2) note(`Potong hening: ${Math.max(1, parts.length - 1)} bagian dibuang, hemat ${cut.toFixed(1)} detik.`);
  }
  const pLen = Math.max(0.3, +o.punch_len || 1.2);
  let pSrc = [];
  if (o.punch_on) {
    let ts = o.punch_auto ? AU.loudMoments(mono16, { maxN: +o.punch_max || 4, minGap: pLen + 2.5 }) : [];
    for (const raw of String(o.punch_times || '').split(/[,;\s]+/)) {
      if (!raw) continue;
      try { const r = clipRel(raw, s, e, 'Waktu zoom'); if (r != null) ts.push(r); } catch (x) { warn(x.message); }
    }
    ts = [...new Set(ts.map((x) => Math.round(x * 100) / 100))].filter((t) => t < dur - 0.2).sort((a, b) => a - b);
    for (const t of ts) if (!pSrc.length || t - pSrc[pSrc.length - 1] >= pLen) pSrc.push(t);
    if (o.punch_auto && !pSrc.length) note('Zoom kejut: tidak ada momen yang cukup heboh di potongan ini.');
  }

  // 4) kamera AI
  let planR = null;
  if (o.layout === 'ai') {
    stage(`Potongan ${clip.n}: kamera AI mencari wajah dan siapa yang bicara...`);
    step('ai', 0, 'memuat pendeteksi wajah');
    await CAM.loadDetector();
    const n = Math.max(1, Math.floor(dur * CAM.ANALYSIS_FPS));
    const times = Array.from({ length: n }, (_, k) => s + k / CAM.ANALYSIS_FPS);
    const aw = src.sw >= src.sh ? 640 : 360;
    const ah = Math.round((src.sh * aw) / src.sw / 2) * 2;
    const frames = await CAM.analyze(src.framesAt(times, aw, ah), aw, ah, n, (p) => {
      checkCancel();
      step('ai', p * 0.95, `${Math.round(p * dur)} dari ${Math.round(dur)} detik`);
    });
    const speechAt = words.length ? speechFromWords(words) : speechFromAudio(mono16, 16000);
    planR = CAM.plan(frames, src.sw, src.sh, F, dur, W, H, aiZoom(o, W, H), speechAt, o.ai_style, o.ai_transition);
    step('ai', 1, `${planR.faces} wajah, ${planR.switches} kali pindah`);
    if (!planR.faces) warn('Kamera AI tidak menemukan wajah, jadi kamera diam di tengah.');
  }

  // 5) timeline hasil
  const segs = makeTimeline(o, dur, rel, F, parts);
  const intro = segs.some((x) => x.teaser);
  const complexTl = intro || parts.length > 1 || parts[0][0] > 0.01 || parts[0][1] < dur - 0.01;
  const mainSeg = segs.find((x) => x.main);
  const total = segs.reduce((a, x) => a + x.frames, 0);
  const outDur = total / F;
  const toOut = outMapper(segs);
  const pOut = [...new Set(pSrc.flatMap((t) => [toOut(t), ...teaserTimes(segs, t)]).filter((x) => x != null).map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
  if (pOut.length) note(`Zoom kejut ${pOut.length} kali (${pOut.slice(0, 6).map((x) => x.toFixed(1) + ' dtk').join(', ')}).`);
  const pz = Math.max(1.02, +o.punch_z || 1.18);
  let g, behind = false;
  const banner = bannerLayout(o, W, H, fonts.hook, S.imgs.banner_logo, S.imgs.banner);
  if (o.banner_on && !banner) warn('Banner dilewati karena gambarnya belum dipilih.');
  const safe = banner?.bottom || 0;
  if (o.layout === 'static') {
    const b = staticBox(o, src.sw, src.sh, W, H);
    g = geom(o, W, H, b.top, b.bot);
    if (o.wm_mode === 'belakang' && o.wm_text.trim()) {
      if (b.full) warn('Watermark di belakang tidak terlihat karena video memenuhi layar, jadi dipasang tipis di atas video.');
      else behind = true;
    }
  } else g = geom(o, W, H);
  const oo = behind || o.wm_mode !== 'belakang' ? o : { ...o, wm_mode: 'diagonal' };
  const ov = {
    o: oo, W, H, g, dur: outDur, chunks: complexTl ? SUB.shiftChunks(chunks, segs) : chunks, hook: title,
    hookSpan: intro ? [0, segs[0].outDur] : null, credit: o.credit ? `Sumber: ${o.channel.trim() || 'YouTube'}` : '',
    flashAt: intro && o.intro_fx === 'flash' ? mainSeg.out : null, logo: S.imgs.logo, fonts, behind, banner, channel: o.channel.trim(),
  };

  // 6) suara hasil: timeline + volume standar + SFX + musik
  stage(`Potongan ${clip.n}: menyusun suara...`);
  let base = null, baseGain = 0;
  if (audio48) {
    if (o.loud_on) {
      const lv = AU.lufs(audio48);
      if (lv != null) { baseGain = Math.max(-20, Math.min(20, -14 - lv)); note(`Volume disamakan dari ${lv.toFixed(1)} ke -14 LUFS.`); }
    }
    const many = parts.length > 1;
    const pieces = [];
    for (const sg of segs) {
      let piece = sliceBuffer(audio48, sg.src, sg.src + sg.dur);
      if (sg.kind === 'rewind') piece = await resample(piece, 48000, 2, { reverse: true, speed: 4, gain: 0.6 });
      else if (many && sg.main && sg.dur > 0.1) {
        const f = Math.round(0.015 * 48000);
        for (let c = 0; c < piece.numberOfChannels; c++) {
          const d = piece.getChannelData(c);
          for (let i = 0; i < f && i < d.length; i++) { d[i] *= i / f; d[d.length - 1 - i] *= i / f; }
        }
      }
      pieces.push({ buf: piece, samples: Math.round(sg.outDur * 48000) });
    }
    base = concatBuffers(pieces, 48000, 2);
  }
  const sfx = await sfxEvents(o, clip.n, s, e, segs, outDur, words, pOut);
  let music = null;
  if (o.music) {
    const it = S.musicLib.find((x) => x.id === o.music);
    const buf = it ? await decodedLib(it.id) : null;
    if (buf) { music = { buf, vol: (+o.music_vol || 12) / 100, duck: o.music_duck, gain: it.gain }; note(`Musik latar: ${it.name}, volume ${o.music_vol}%.`); }
    else warn('Musik latar tidak ditemukan di browser ini.');
  }
  const audioOut = base || sfx.length || music
    ? AU.mix({ base, outDur, sfx, music, duckDepth: Math.max(0, Math.min(1, (+o.sfx_duck || 45) / 100)), baseGainDb: baseGain })
    : null;

  // 7) render gambar
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const coverAt = Math.min(0.8, outDur / 2);
  let cover = null;
  const inPunchOut = (t) => pOut.some((a) => a <= t && t < a + pLen);
  const inPunchSrc = (t) => pSrc.some((a) => a <= t && t < a + pLen);
  const drawOne = (cv, cw, chh, rect, tOut, tSrc) => {
    if (rect && inPunchSrc(tSrc)) {
      const nw = rect.w / pz, nh = rect.h / pz;
      rect = { x: rect.x + (rect.w - nw) / 2, y: rect.y + (rect.h - nh) * 0.4, w: nw, h: nh };
    }
    const zoom = !rect && inPunchOut(tOut);
    if (zoom) { ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(pz, pz); ctx.translate(-W / 2, -H / 2); }
    drawBase(ctx, cv, cw, chh, o, W, H, { rect, behind: behind ? (c) => drawWatermark(c, tOut, o, W, H, fonts.wm, outDur, true, safe) : null });
    if (zoom) ctx.restore();
    drawOverlay(ctx, tOut, ov);
  };
  async function* frames() {
    for (const sg of segs) {
      const times = Array.from({ length: sg.frames }, (_, k) => (sg.kind === 'rewind' ? sg.src + sg.dur - (k * 4) / F : sg.src + k / F));
      if (sg.kind === 'rewind') {
        // decoder video hanya aman maju: ambil frame urut maju (diperkecil), lalu putar terbalik
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
          drawOne(bm, rw, rh, rect, tOut, times[k]);
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
        drawOne(cv, src.sw, src.sh, planR ? planR.rectAt(times[k]) : null, tOut, times[k]);
        if (o.cover_on && !cover && tOut >= coverAt) cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
        yield tOut;
        k++;
      }
    }
  }
  stage(`Potongan ${clip.n}: render video ${W}×${H}, ${F} fps...`);
  step('render', 0, 'mulai');
  const t0 = performance.now();
  const res = await encodeMp4({
    canvas, frames: frames(), total, fps: F, audio: audioOut, isCancelled: () => S.cancel,
    onProgress: (p, { speed, eta }) => step('render', p * 0.99, `${speed.toFixed(1)}× kecepatan normal, sisa sekitar ${Math.max(0, eta).toFixed(0)} dtk`),
  });
  step('render', 1, `selesai dalam ${((performance.now() - t0) / 1000).toFixed(0)} dtk`);
  if (res.audioDropped) warn('Browser ini tidak bisa menyimpan suara. Clip dibuat tanpa suara. Coba Chrome atau Edge.');

  const plainTitle = String(title || S.stem).replace(/[*|]/g, '').replace(/\s+/g, ' ').trim();
  const name = `${slug(plainTitle || S.stem)}_${fmtTime(s).replace(/:/g, '-')}_${o.aspect.replace(':', 'x')}.mp4`;
  let srcUrl = S.linkInfo?.source || '';
  if (/youtu\.be\/[\w-]+\?t=\d+$/.test(srcUrl)) srcUrl = srcUrl.replace(/t=\d+$/, 't=' + Math.floor((S.linkInfo.start || 0) + s));
  const srcLine = o.channel.trim() ? `Sumber: ${o.channel.trim()}${srcUrl ? ' ' + srcUrl : ''}` : '';
  const capText = caption
    ? [caption, srcLine].filter(Boolean).join('\n\n')
    : [plainTitle, srcLine, `#${slug(o.channel || 'clip', 30).replace(/-/g, '')} #clip #fyp`].filter(Boolean).join('\n\n');
  addResult({ blob: res.blob, cover, name, caption: capText, len: outDur, aspect: o.aspect, title: plainTitle });
}

function addResult(r) {
  const url = URL.createObjectURL(r.blob);
  const coverUrl = r.cover ? URL.createObjectURL(r.cover) : null;
  const html = `<div class="res">
    <video src="${url}" ${coverUrl ? `poster="${coverUrl}"` : ''} controls playsinline preload="metadata"></video>
    <div><div class="n">${esc(r.title || r.name)}</div><div class="m">${fmtTime(r.len, true)} · ${r.aspect} · ${mbStr(r.blob.size)}</div>
    <div class="acts"><a class="main" href="${url}" download="${esc(r.name)}">Simpan video</a>
    ${coverUrl ? `<a href="${coverUrl}" download="${esc(r.name.replace(/\.mp4$/, '_cover.jpg'))}">Cover</a>` : ''}
    <button type="button" class="cap">Salin caption</button>
    ${navigator.canShare ? '<button type="button" class="share">Bagikan</button>' : ''}</div></div></div>`;
  for (const host of [$('sheetResults'), $('results')]) {
    host.insertAdjacentHTML('afterbegin', html);
    const el = host.firstElementChild;
    el.querySelector('.cap').onclick = async (ev) => {
      try { await navigator.clipboard.writeText(r.caption); ev.target.textContent = 'Tersalin'; } catch { prompt('Salin caption:', r.caption); }
    };
    el.querySelector('.share')?.addEventListener('click', async () => {
      const f = new File([r.blob], r.name, { type: 'video/mp4' });
      if (navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], text: r.caption }); } catch { /* batal */ } }
      else alert('Perangkat ini tidak bisa membagikan file. Pakai Simpan video.');
    });
  }
  $('resGroup').hidden = false;
}

// ================================================================== tombol Buat clip
function updateDock() {
  if (S.busy) return;
  const n = readClips(false).length;
  $('btnGo').disabled = !S.src;
  $('dockStatus').textContent = !S.src ? 'Pilih video dulu' : n ? `${n} potongan siap dibuat` : 'Isi potongan dulu';
}
async function go() {
  if (S.busy) return;
  try {
    if (!S.src) throw new Error('Pilih video dulu.');
    const clips = readClips(true);
    if (!clips.length) throw new Error('Isi minimal satu potongan.');
    clips.forEach((c) => { const { s, e } = clipTimes(c); clipRel(c.i, s, e, `Potongan ${c.n}: intro`); });
    const o = opts();
    if (o.layout === 'facecam' && !S.cam) throw new Error('Kotak facecam belum dipilih. Ambil gambar, lalu tarik kotak di wajah streamer.');
    const keys = saveKeys();
    saveSettings();
    keepStorage();
    S.busy = true; S.cancel = false;
    $('btnGo').disabled = true;
    openSheet(clips.length);
    for (let i = 0; i < clips.length; i++) { await processClip(o, clips[i], i, keys); checkCancel(); }
    J.clipNo = clips.length; J.keys = []; overall();
    $('pctAll').textContent = '100%'; $('barFill').style.width = '100%';
    stage(clips.length > 1 ? `Selesai. ${clips.length} clip siap.` : 'Selesai. Clip siap.');
    $('sheetTitle').textContent = 'Selesai';
    $('sheetResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    if ($('sheet').hidden) { alert(e.message); }
    else if (e.message === 'DIBATALKAN') { stage('Dibatalkan.'); killWorker(); closeSheet(); }
    else { $('err').hidden = false; $('err').textContent = e.message; stage('Berhenti karena ada masalah.'); $('sheetTitle').textContent = 'Gagal'; }
  } finally {
    S.busy = false;
    clearInterval(J.timer);
    $('btnCancel').hidden = true;
    $('btnClose').hidden = false;
    updateDock();
  }
}

// ================================================================== gaya tersimpan
function readPresets() { try { return JSON.parse(localStorage.getItem(PRESETS) || '{}'); } catch { return {}; } }
function fillPresets(sel = '') {
  const p = readPresets();
  $('presetSel').innerHTML = '<option value="">Pilih</option>' + Object.keys(p).sort().map((n) => `<option>${esc(n)}</option>`).join('');
  $('presetSel').value = sel;
  $('btnPresetDel').hidden = !sel;
}

// ================================================================== event
function onChange() { refreshUI(); saveSettings(); drawPreviewSoon(); }
const onClipChange = debounce(() => { setPreviewRange(); updateDock(); drawPreviewSoon(); saveSettings(); }, 200);

async function init() {
  fillFonts();
  loadSettings();
  try {
    for (const rec of await listFiles('font')) await addUserFont(rec.name, await rec.blob.arrayBuffer()).catch(() => null);
  } catch { /* abaikan */ }
  fillFonts();
  // logo lama dari versi sebelumnya
  const oldLogo = localStorage.getItem('klipku-web-logo');
  if (oldLogo) {
    try { const b = await (await fetch(oldLogo)).blob(); await putFile({ id: 'img:logo', kind: 'img', name: 'logo', blob: b }); localStorage.removeItem('klipku-web-logo'); } catch { /* abaikan */ }
  }
  await Promise.all(['logo', 'banner_logo', 'banner'].map(loadImg));
  await loadLibs();

  for (const seg of $$('.seg[data-k]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const k = seg.dataset.k;
      if (k === 'hook_tpl') {
        const d = hookDefaults(b.dataset.v);
        setOpt('hook_bg', d.bg); setOpt('hook_txt', d.txt); setOpt('hook_acc', d.acc); setOpt('hook_align', d.align);
        setOpt('hook_bg_op', b.dataset.v === 'strip' ? 75 : 100);
      }
      onChange();
      if (k === 'aspect' || k === 'fps') refreshEncoder();
      if (k === 'layout' && b.dataset.v === 'ai' && S.frame && !S.faces.length) detectOnFrames();
    });
  }
  for (const el of $$('[data-k]:not(.seg)')) {
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  }
  document.querySelector('[data-k="fps"]').addEventListener('change', refreshEncoder);
  $('font').addEventListener('change', async () => {
    if ($('font').value !== '__add') return;
    $('font').value = DEFAULT_FONT;
    const f = await addFonts(await pickFile('.ttf,.otf,.woff,.woff2', true));
    fillFonts();
    if (f) $('font').value = f.id;
    onChange();
  });
  ['key_groq', 'key_gemini', 'key_claude'].forEach((id) => $(id).addEventListener('change', saveKeys));
  $('logoFile').addEventListener('change', (e) => { setImg('logo', e.target.files[0]); e.target.value = ''; });
  $('bnLogoFile').addEventListener('change', (e) => { setImg('banner_logo', e.target.files[0]); e.target.value = ''; });
  $('bnFile').addEventListener('change', (e) => { setImg('banner', e.target.files[0]); e.target.value = ''; });
  $('bnLogoDel').onclick = async () => { await delFile('img:banner_logo'); await loadImg('banner_logo'); onChange(); };
  $('btnSfxAdd').onclick = () => { addSfxRow({ file: S.sfxLib[0]?.id }); saveSettings(); };
  $('sfxFile').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const id = await uploadAudio(files, 'sfx');
    if (id) { addSfxRow({ file: id }); saveSettings(); }
  });
  $('musicFile').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const id = await uploadAudio(files, 'musik');
    if (id) { setOpt('music', id); onChange(); }
  });
  $('btnAdd').onclick = () => {
    const last = readClips(false).pop();
    let s = '';
    try { if (last) s = fmtTime(clipTimes(last).e); } catch { /* kosong */ }
    addClip({ s });
  };
  $('btnFrame').onclick = grabFrame;
  $('btnGo').onclick = go;
  $('btnCancel').onclick = () => { S.cancel = true; killWorker(); stage('Membatalkan...'); };
  $('btnClose').onclick = closeSheet;
  $('btnChange').onclick = () => $('file').click();
  $('pvTime').addEventListener('input', () => { paintRange($('pvTime')); scrubPreview(); });
  $('pvMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#pvMode button').forEach((x) => x.classList.toggle('on', x === b));
    S.pvMode = b.dataset.v; drawPreview();
  });
  $('file').addEventListener('change', (e) => loadVideo(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadVideo(e.dataTransfer.files[0]));
  $('presetSel').addEventListener('change', () => {
    const n = $('presetSel').value;
    const p = readPresets()[n];
    if (p) { applySettings(p); if (p.cam) S.cam = p.cam; fillFonts(); onChange(); refreshEncoder(); }
    $('btnPresetDel').hidden = !n;
  });
  $('btnPresetSave').onclick = () => {
    const n = (prompt('Nama gaya ini (misal nama channel):', $('presetSel').value || '') || '').trim();
    if (!n) return;
    const p = readPresets();
    const o = opts(); delete o.sfx; delete o.has_sfx;
    o.sfxRows = readSfxRows();
    p[n] = o;
    localStorage.setItem(PRESETS, JSON.stringify(p));
    fillPresets(n);
  };
  $('btnPresetDel').onclick = () => {
    const n = $('presetSel').value;
    if (!n || !confirm(`Hapus gaya "${n}"?`)) return;
    const p = readPresets(); delete p[n];
    localStorage.setItem(PRESETS, JSON.stringify(p));
    fillPresets('');
  };
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  setupFacecamDraw();
  setupHookDrag();
  fillPresets('');
  addClip();
  refreshUI();
  drawPreview();
  checkSupport();
  refreshEncoder();
  document.documentElement.dataset.version = VERSION;
}

init();

// ================================================================== contoh hasil
(() => {
  const v = $('demoVid'), b = $('demoSound');
  if (!v) return;
  const io = new IntersectionObserver((es) => {
    for (const e of es) { if (e.isIntersecting && !document.body.classList.contains('has-video')) v.play().catch(() => {}); else v.pause(); }
  }, { threshold: 0.35 });
  io.observe(v);
  const toggle = () => { v.muted = !v.muted; b.textContent = v.muted ? 'Nyalakan suara' : 'Matikan suara'; if (v.paused) v.play().catch(() => {}); };
  b.onclick = toggle;
  v.onclick = toggle;
})();

// ================================================================== video dari link (diunduh oleh KlipKu PC)
const PCK = 'klipku-web-pc';
const RELAY = 'https://projectgieclips.pages.dev/api/pc/';
const readPc = () => { try { return JSON.parse(localStorage.getItem(PCK) || 'null'); } catch { return null; } };
function setPcState(text, ok = null) {
  $('pcState').textContent = text;
  $('pcState').style.color = ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : '';
}
function refreshPc() {
  const p = readPc();
  $('pcForget').hidden = !p;
  $('linkFoot').innerHTML = p
    ? 'Link diunduh oleh KlipKu di laptop kamu. Laptop harus menyala dan KlipKu terbuka. Selebihnya diproses di HP ini.'
    : 'YouTube tidak mengizinkan website mengunduh video, jadi link diunduh oleh KlipKu di laptop kamu. Pasangkan sekali: buka KlipKu di laptop, tekan <b>Sambungkan HP</b>, lalu scan QR-nya dengan HP ini. Setelah itu tinggal tempel link selama KlipKu di laptop terbuka.';
  if (!p) setPcState('Belum dipasangkan');
  return p;
}
async function findPc(p) {
  let r;
  try { r = await fetch(RELAY + encodeURIComponent(p.id), { cache: 'no-store' }); } catch { r = null; }
  if (!r) throw new Error('Tidak bisa menghubungi buku alamat KlipKu. Cek koneksi internet.');
  if (r.status === 404) throw new Error('KlipKu di laptop sedang tidak menyala. Buka KlipKu di laptop, tunggu sebentar, lalu coba lagi.');
  if (!r.ok) throw new Error('Buku alamat KlipKu sedang bermasalah. Coba lagi sebentar lagi.');
  const { url } = await r.json();
  const ping = await fetch(url + '/api/remote/ping', { headers: { 'X-KlipKu-Key': p.key }, cache: 'no-store' }).catch(() => null);
  if (!ping) throw new Error('Laptop tidak bisa dihubungi. Pastikan laptop menyala, terhubung internet, dan KlipKu terbuka.');
  if (ping.status === 403) throw new Error('Kunci tidak cocok. Scan ulang QR dari tombol Sambungkan HP di KlipKu PC.');
  if (!ping.ok) throw new Error('KlipKu di laptop belum siap. Coba lagi sebentar lagi.');
  return url;
}
async function checkPc() {
  const p = refreshPc();
  if (!p) return;
  setPcState('Mengecek...');
  try { await findPc(p); setPcState('Tersambung', true); } catch { setPcState('Tidak menyala', false); }
}
async function fetchFromLink() {
  const url = $('linkUrl').value.trim();
  if (!url) { $('linkUrl').focus(); return; }
  const p = readPc();
  const prog = (stage, v) => {
    $('linkProg').hidden = false;
    $('linkStage').textContent = stage;
    if (v != null) { $('linkBar').style.width = v * 100 + '%'; $('linkPct').textContent = Math.round(v * 100) + '%'; }
  };
  if (!p) {
    prog('HP ini belum dipasangkan. Buka KlipKu di laptop, tekan Sambungkan HP, lalu scan QR-nya.', 0);
    $('linkPct').textContent = '';
    return;
  }
  if (S.busy) return;
  const btn = $('btnLink');
  btn.disabled = true;
  try {
    prog('Mencari KlipKu di laptop...', 0.01);
    const base = await findPc(p);
    setPcState('Tersambung', true);
    const auth = { 'X-KlipKu-Key': p.key };
    const res = await fetch(base + '/api/remote/fetch', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, start: $('linkS').value.trim(), end: $('linkE').value.trim() }),
    });
    let st = await res.json();
    if (!res.ok || st.ok === false) throw new Error(st.error || 'Video tidak bisa diambil.');
    const id = st.id;
    while (st.status === 'jalan') {
      await new Promise((r) => setTimeout(r, 1200));
      const jr = await fetch(base + '/api/remote/job/' + id, { headers: auth, cache: 'no-store' });
      st = await jr.json();
      if (!jr.ok) throw new Error(st.error || 'Proses di laptop berhenti.');
      prog(`${st.stage} (di laptop)`, st.progress * 0.7);
    }
    if (st.status !== 'selesai') throw new Error(st.error || 'Video tidak bisa diambil.');
    prog('Mengirim video ke HP...', 0.7);
    const fr = await fetch(base + '/api/remote/file/' + id, { headers: auth, cache: 'no-store' });
    if (!fr.ok || !fr.body) throw new Error('Video tidak bisa dikirim ke HP. Coba lagi.');
    const total = +fr.headers.get('Content-Length') || st.size || 0;
    const reader = fr.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total) prog(`Mengirim video ke HP (${mbStr(got)} dari ${mbStr(total)})`, 0.7 + (0.3 * got) / total);
    }
    const info = st.info || {};
    const file = new File(parts, slug(info.title || 'video', 50) + '.mp4', { type: 'video/mp4' });
    prog('Video siap. Atur potongan di bawah.', 1);
    if (info.channel && !document.querySelector('[data-k="channel"]').value.trim()) setOpt('channel', info.channel);
    $('clips').innerHTML = '';
    addClip({ s: '0:00', e: fmtTime(Math.min(180, Math.max(1, (info.end || 0) - (info.start || 0)) || 30)) });
    await loadVideo(file, info);
    if (info.title) $('vname').textContent = info.title;
    onChange();
  } catch (e) {
    prog(e.message, null);
    $('linkPct').textContent = '';
    if (/tidak menyala|tidak bisa dihubungi/.test(e.message)) setPcState('Tidak menyala', false);
  } finally {
    btn.disabled = false;
  }
}
(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('pc') && h.get('k')) {
    try { localStorage.setItem(PCK, JSON.stringify({ id: h.get('pc'), key: h.get('k') })); } catch { /* abaikan */ }
    history.replaceState(null, '', location.pathname + location.search);
  }
  $('btnLink').onclick = fetchFromLink;
  $('linkUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchFromLink(); });
  $('pcForget').onclick = () => {
    if (!confirm('Lupakan KlipKu PC yang dipasangkan di HP ini?')) return;
    localStorage.removeItem(PCK);
    refreshPc();
  };
  checkPc();
})();
