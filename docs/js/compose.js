// Penyusun gambar per frame: layout kamera + subtitle + hook + watermark + logo.
// Angka & aturan sama dengan KlipKu versi PC (app.py + engine_subs.py), hanya digambar di canvas.
import { cssFont, getFont } from './fonts.js';

export const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
export const HL = { kuning: '#FFFF00', hijau: '#66FF00', merah: '#FF3A3A', biru: '#40C0FF', pink: '#FF6BC8', oranye: '#FF9000', putih: '#FFFFFF' };
export const TEXTCOL = { putih: '#FFFFFF', kuning: '#FFFF00', hitam: '#000000', merah: '#FF3A3A', biru: '#40C0FF', hijau: '#66FF00' };
const EM = 1.015; // ukuran ASS -> ukuran em (sama seperti faktor "k" di engine_fonts.py)
const HAS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
const HAS_SPACING = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

export const even = (x) => Math.max(2, Math.floor(x / 2) * 2);
const num = (v, d) => (v === '' || v == null || Number.isNaN(+v) ? d : +v);
export const clean = (s) => String(s ?? '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ geometri
export function staticBox(o, sw, sh, W, H) {
  const z = Math.max(0.3, num(o.zoom, 1));
  const s = (W * z) / sw;
  const SW = sw * s, SH = sh * s;
  const CW = Math.min(W, SW), CH = Math.min(H, SH);
  const X = (SW - CW) * num(o.pan_x, 0.5), Y = (SH - CH) * num(o.pan_y, 0.5);
  const top = Math.floor((H - CH) / 2);
  return { s, CW, CH, X, Y, dx: (W - CW) / 2, dy: (H - CH) / 2, top, bot: top + CH, full: CW >= W - 0.5 && CH >= H - 0.5 };
}

export function geom(o, W, H, fgTop = null, fgBot = null) {
  const portrait = H > W;
  let sub_y, hook_y, credit_y;
  if (o.layout === 'facecam') {
    const topH = even((H * num(o.cam_pct, 42)) / 100);
    sub_y = topH; hook_y = 175; credit_y = H - 400;
  } else if (o.layout === 'ai' || fgTop == null || (fgTop <= 2 && fgBot >= H - 2)) {
    sub_y = H * (portrait ? 0.70 : W > H ? 0.84 : 0.80);
    hook_y = H * (portrait ? 0.09 : 0.11);
    credit_y = H * (portrait ? 0.80 : 0.955);
  } else {
    sub_y = fgBot + H * 0.08 < H * 0.86 ? fgBot + H * 0.08 : H * 0.80;
    hook_y = fgTop > H * 0.13 ? fgTop - H * 0.075 : H * 0.09;
    credit_y = portrait ? H * 0.80 : H * 0.955;
    if (portrait && Math.abs(credit_y - sub_y) < 90) credit_y = Math.min(H - 60, sub_y + 120);
  }
  const pct = num(o.sub_y_pct, 0);
  if (pct > 0) sub_y = (H * pct) / 100;
  return { sub_y, hook_y, credit_y };
}

// ------------------------------------------------------------------ latar blur
let blurA = null, blurB = null;
function blurCanvas(w, h) {
  blurA ??= document.createElement('canvas');
  blurB ??= document.createElement('canvas');
  return [blurA, blurB];
}

/** Isi kotak (x,y,w,h) dengan versi blur + sedikit gelap dari sumber (seperti boxblur + eq=brightness=-0.1). */
function drawBlurBg(ctx, src, sw, sh, x, y, w, h, darken = 0.1) {
  const [a, b] = blurCanvas();
  const qw = Math.max(8, Math.round(w / 4)), qh = Math.max(8, Math.round(h / 4));
  if (a.width !== qw || a.height !== qh) { a.width = qw; a.height = qh; }
  const ac = a.getContext('2d');
  // cover-fit sumber ke kotak kecil
  const sc = Math.max(qw / sw, qh / sh);
  const cw = qw / sc, ch = qh / sc;
  ac.filter = 'none';
  ac.imageSmoothingQuality = 'medium';
  if (HAS_FILTER) {
    if (b.width !== qw || b.height !== qh) { b.width = qw; b.height = qh; }
    const bc = b.getContext('2d');
    bc.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, qw, qh);
    ac.clearRect(0, 0, qw, qh);
    ac.filter = 'blur(7px)';
    // gambar dengan sedikit melebar supaya pinggiran blur tidak transparan
    ac.drawImage(b, -12, -12, qw + 24, qh + 24);
    ac.filter = 'none';
  } else {
    // cadangan untuk browser tanpa ctx.filter: perkecil lalu perbesar (blur halus)
    const tw = Math.max(4, Math.round(qw / 6)), th = Math.max(4, Math.round(qh / 6));
    if (b.width !== tw || b.height !== th) { b.width = tw; b.height = th; }
    const bc = b.getContext('2d');
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, tw, th);
    ac.imageSmoothingQuality = 'high';
    ac.drawImage(b, 0, 0, qw, qh);
  }
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(a, x, y, w, h);
  if (darken > 0) { ctx.fillStyle = `rgba(0,0,0,${darken})`; ctx.fillRect(x, y, w, h); }
  ctx.restore();
}

// ------------------------------------------------------------------ layout kamera
/** Gambar video sesuai mode kamera. rect = kotak AI kamera (x,y,w,h dalam piksel sumber) untuk mode 'ai'. */
export function drawBase(ctx, src, sw, sh, o, W, H, { rect = null, behind = null } = {}) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!src) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (o.layout === 'facecam') return drawFacecam(ctx, src, sw, sh, o, W, H);
  if (o.layout === 'ai' && rect) {
    ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, W, H);
    return;
  }
  const b = staticBox(o, sw, sh, W, H);
  if (!b.full) {
    if (o.bg === 'hitam') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    else drawBlurBg(ctx, src, sw, sh, 0, 0, W, H, 0.10);
    if (behind) behind(ctx);
  }
  ctx.drawImage(src, b.X / b.s, b.Y / b.s, b.CW / b.s, b.CH / b.s, b.dx, b.dy, b.CW, b.CH);
}

function drawFacecam(ctx, src, sw, sh, o, W, H) {
  const topH = even((H * num(o.cam_pct, 42)) / 100);
  const botH = H - topH;
  const cam = o.cam || { x: 0.7, y: 0.05, w: 0.28, h: 0.35 };
  let cx = cam.x * sw, cy = cam.y * sh, cw = cam.w * sw, ch = cam.h * sh;
  const dst = W / topH;
  if (cw / ch > dst) { const nw = ch * dst; cx += (cw - nw) / 2; cw = nw; }
  else { const nh = cw / dst; cy += (ch - nh) / 2; ch = nh; }
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, W, topH);

  ctx.save();
  ctx.beginPath(); ctx.rect(0, topH, W, botH); ctx.clip();
  if (o.game_mode === 'utuh') {
    drawBlurBg(ctx, src, sw, sh, 0, topH, W, botH, 0.12);
    const gfgH = (W * sh) / sw;
    ctx.drawImage(src, 0, 0, sw, sh, 0, topH + (botH - gfgH) / 2, W, gfgH);
  } else {
    const zoom = Math.max(1, num(o.game_zoom, 1));
    let gw = (sh * (W / botH)) / zoom;
    if (gw > sw) gw = sw;
    let gh = (gw * botH) / W;
    if (gh > sh) { gh = sh; gw = (gh * W) / botH; }
    const gx = (sw - gw) * num(o.game_x, 0.5), gy = (sh - gh) * num(o.game_y, 0.5);
    ctx.drawImage(src, gx, gy, gw, gh, 0, topH, W, botH);
  }
  ctx.restore();
  if (o.divider !== false) { ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fillRect(0, topH - 4, W, 8); }
}

// ------------------------------------------------------------------ teks
function fontMetrics(ctx) {
  const m = ctx.measureText('HgÁy');
  const a = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  return { a, d };
}

/**
 * Gambar satu "event" teks (bisa beberapa baris) seperti libass: bayangan -> garis tepi -> isi.
 * tokens: [{t, scale, color, ow (tebal garis tepi), oc (warna garis tepi)}]
 */
function drawTextEvent(ctx, tokens, opt) {
  const { fontId, px, x, y, an = 5, maxW = Infinity, shadow = 0, shadowColor = 'rgba(0,0,0,0.5)', alpha = 1,
    rotate = 0, spacing = 0, box = null, popScale = 1 } = opt;
  if (!tokens.length || alpha <= 0) return;
  ctx.save();
  if (HAS_SPACING) ctx.letterSpacing = spacing ? `${spacing}px` : '0px';
  ctx.font = cssFont(fontId, px);
  const { a, d } = fontMetrics(ctx);
  const space = ctx.measureText(' ').width;
  for (const tk of tokens) {
    ctx.font = cssFont(fontId, px * (tk.scale || 1));
    tk.w = ctx.measureText(tk.t).width;
  }
  // bungkus baris (rata, seperti WrapStyle 0)
  const total = tokens.reduce((s, tk) => s + tk.w, 0) + space * (tokens.length - 1);
  const lines = [];
  if (total <= maxW || tokens.length === 1) lines.push(tokens);
  else {
    const n = Math.ceil(total / maxW);
    const target = total / n;
    let cur = [], cw = 0;
    for (const tk of tokens) {
      const add = (cur.length ? space : 0) + tk.w;
      if (cur.length && (cw + add > maxW || (cw + add / 2 > target && lines.length < n - 1))) { lines.push(cur); cur = []; cw = 0; }
      cw += (cur.length ? space : 0) + tk.w;
      cur.push(tk);
    }
    if (cur.length) lines.push(cur);
  }
  const lh = a + d;
  const widths = lines.map((ln) => ln.reduce((s, tk) => s + tk.w, 0) + space * (ln.length - 1));
  const blockW = Math.max(...widths), blockH = lh * lines.length;
  const col = an % 3; // 1 kiri, 2 tengah, 0 kanan
  const row = an >= 7 ? 'top' : an >= 4 ? 'mid' : 'bot';
  ctx.translate(x, y);
  if (rotate) ctx.rotate((-rotate * Math.PI) / 180);
  if (popScale !== 1) ctx.scale(popScale, popScale);
  const top0 = row === 'top' ? 0 : row === 'mid' ? -blockH / 2 : -blockH;
  const place = [];
  lines.forEach((ln, i) => {
    const lw = widths[i];
    let lx = col === 1 ? 0 : col === 2 ? -lw / 2 : -lw;
    const base = top0 + i * lh + a;
    for (const tk of ln) { place.push({ tk, x: lx, base }); lx += tk.w + space; }
    if (box) {
      ctx.fillStyle = box.color;
      const bx = (col === 1 ? 0 : col === 2 ? -lw / 2 : -lw) - box.pad;
      ctx.fillRect(bx, top0 + i * lh - box.pad, lw + box.pad * 2, lh + box.pad * 2);
    }
  });
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  // 1) bayangan
  if (shadow > 0) {
    for (const p of place) {
      ctx.font = cssFont(fontId, px * (p.tk.scale || 1));
      ctx.fillStyle = shadowColor; ctx.strokeStyle = shadowColor;
      if (p.tk.ow > 0) { ctx.lineWidth = p.tk.ow * 2; ctx.strokeText(p.tk.t, p.x + shadow, p.base + shadow); }
      ctx.fillText(p.tk.t, p.x + shadow, p.base + shadow);
    }
  }
  // 2) garis tepi
  for (const p of place) {
    if (!(p.tk.ow > 0)) continue;
    ctx.font = cssFont(fontId, px * (p.tk.scale || 1));
    ctx.strokeStyle = p.tk.oc || '#000';
    ctx.lineWidth = p.tk.ow * 2;
    ctx.strokeText(p.tk.t, p.x, p.base);
  }
  // 3) isi
  for (const p of place) {
    ctx.font = cssFont(fontId, px * (p.tk.scale || 1));
    ctx.fillStyle = p.tk.color;
    ctx.fillText(p.tk.t, p.x, p.base);
  }
  ctx.restore();
}

const fadeAlpha = (t, a, b, fin, fout) => {
  let al = 1;
  if (fin > 0) al = Math.min(al, (t - a) / fin);
  if (fout > 0) al = Math.min(al, (b - t) / fout);
  return Math.max(0, Math.min(1, al));
};

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ------------------------------------------------------------------ watermark
function wmCorner(pos, W, H, safe = 0) {
  const m = Math.round(W * 0.04);
  const top = Math.round(Math.max(H * 0.06, safe + H * 0.012)), bot = Math.round(H > W ? H * 0.12 : H * 0.07);
  return ({
    'kiri-atas': [7, m, top], 'kanan-atas': [9, W - m, top], 'kiri-bawah': [1, m, H - bot],
    'kanan-bawah': [3, W - m, H - bot], 'atas-tengah': [8, W / 2, top], 'bawah-tengah': [2, W / 2, H - bot],
    tengah: [5, W / 2, H / 2],
  })[pos] || [9, W - m, top];
}

export function drawWatermark(ctx, t, o, W, H, fontId, dur, force = false, safe = 0) {
  const text = clean(o.wm_text);
  if (!text) return;
  const mode = o.wm_mode || 'pojok';
  if (mode === 'belakang' && !force) return;
  const op = Math.max(0.03, Math.min(1, num(o.wm_opacity, 70) / 100));
  const size = num(o.wm_size, 40);
  const col = TEXTCOL[o.wm_color] || '#FFFFFF';
  const bord = Math.max(1, Math.round(size * 0.05));
  const tok = () => [{ t: text, color: hexA(col, op), ow: bord, oc: `rgba(0,0,0,${op * 0.7})` }];
  const px = size * EM;
  const ang = num(o.wm_angle, 30);
  if (mode === 'pojok') {
    const [an, x, y] = wmCorner(o.wm_pos || 'kanan-atas', W, H, safe);
    drawTextEvent(ctx, tok(), { fontId, px, x, y, an });
  } else if (mode === 'diagonal' || mode === 'belakang') {
    drawTextEvent(ctx, tok(), { fontId, px, x: W / 2, y: H / 2, an: 5, rotate: ang });
  } else if (mode === 'pola') {
    ctx.save(); ctx.font = cssFont(fontId, px);
    const tw = ctx.measureText(text).width; ctx.restore();
    const sx = tw + size * 2.2, sy = size * 4.2;
    const rows = Math.floor(H / sy) + 3, cols = Math.floor(W / sx) + 3;
    let count = 0;
    outer: for (let r = -1; r < rows; r++) {
      for (let c = -1; c < cols; c++) {
        drawTextEvent(ctx, tok(), { fontId, px, x: c * sx + (r % 2 ? sx / 2 : 0), y: r * sy, an: 5, rotate: ang });
        if (++count >= 120) break outer;
      }
    }
  } else if (mode === 'pindah') {
    const every = Math.max(2, num(o.wm_every, 5));
    const cycle = ['kanan-atas', 'kanan-bawah', 'kiri-bawah', 'kiri-atas'];
    const i = Math.floor(t / every);
    const a = i * every, b = Math.min(dur, a + every);
    const [an, x, y] = wmCorner(cycle[i % 4], W, H, safe);
    drawTextEvent(ctx, tok(), { fontId, px, x, y, an, alpha: fadeAlpha(t, a, b, 0.25, 0.25) });
  }
}

// ------------------------------------------------------------------ logo
export function drawLogo(ctx, logo, o, W, H, safe = 0) {
  if (!logo || !o.logo_on) return;
  const lw = even((W * num(o.logo_size, 18)) / 100);
  const lh = (lw * logo.height) / logo.width;
  const m = Math.round(W * 0.04), bot = Math.round(H * (H > W ? 0.12 : 0.07));
  const top = Math.round(Math.max(H * 0.06, safe + H * 0.012));
  const pos = {
    'kiri-atas': [m, top], 'kanan-atas': [W - lw - m, top], 'kiri-bawah': [m, H - lh - bot],
    'kanan-bawah': [W - lw - m, H - lh - bot], 'atas-tengah': [(W - lw) / 2, top],
    'bawah-tengah': [(W - lw) / 2, H - lh - bot], tengah: [(W - lw) / 2, (H - lh) / 2],
  }[o.logo_pos || 'kanan-atas'] || [W - lw - m, top];
  ctx.save();
  ctx.globalAlpha = Math.max(0.05, Math.min(1, num(o.logo_opacity, 90) / 100));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(logo, pos[0], pos[1], lw, lh);
  ctx.restore();
}

// ------------------------------------------------------------------ judul hook (5 template)
// Rumus tata letak SAMA dengan engine_hook.py / hookLayout() KlipKu PC, supaya hasilnya sama.
const QUOTE = [[0.185, 0], [0.667, 0], [0.481, 0.342], [1, 0.342], [1, 1], [0, 1], [0, 0.395]];
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [255, 255, 255]; const v = m[1]; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };
const isLight = (h) => { const [r, g, b] = hexRgb(h); return 0.299 * r + 0.587 * g + 0.114 * b > 150; };
const shade = (h, f) => '#' + hexRgb(h).map((x) => Math.floor(x * f).toString(16).padStart(2, '0')).join('');
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };

export const HOOK_TEMPLATES = ['kutipan', 'kotak', 'label', 'strip', 'polos'];
const TPL_DEF = {
  kutipan: { bg: '#ffffff', txt: '#161616', acc: '#57c2ae', align: 'kiri' },
  kotak: { bg: '#ffffff', txt: '#000000', acc: '#ff3d68', align: 'tengah' },
  label: { bg: '#000000', txt: '#ffffff', acc: '#ffd400', align: 'kiri' },
  strip: { bg: '#000000', txt: '#ffffff', acc: '#ffd400', align: 'kiri' },
  polos: { bg: '#000000', txt: '#ffffff', acc: '#ffd400', align: 'tengah' },
};
export const hookDefaults = (tpl) => TPL_DEF[tpl] || TPL_DEF.kutipan;

export function hookTokens(text, upper) {
  text = String(text ?? '').replace(/[{}\\]/g, '').replace(/\n/g, ' ').trim();
  if (upper) text = text.toLocaleUpperCase('id');
  const out = [];
  let hl = false;
  for (const raw of text.split(/(\|)|\s+/)) {
    if (raw === undefined || raw === '') continue;
    if (raw === '|') { out.push(null); continue; }
    const word = raw.replace(/^\*+|\*+$/g, '');
    const lead = raw.length - raw.replace(/^\*+/, '').length, trail = raw.length - raw.replace(/\*+$/, '').length;
    if (!word) continue;
    if (lead) hl = true;
    out.push([word, hl]);
    if (trail) hl = false;
  }
  return out;
}

function hookWrap(tok, maxW, measure) {
  const lines = [];
  let cur = [];
  for (const t of tok) {
    if (t === null) { if (cur.length) lines.push(cur); cur = []; continue; }
    const tr = cur.concat([t]);
    if (cur.length && measure(tr.map((x) => x[0]).join(' ')) > maxW) { lines.push(cur); cur = [t]; } else cur = tr;
  }
  if (cur.length) lines.push(cur);
  const n = lines.length;
  if (n >= 2 && lines[n - 1].length === 1 && lines[n - 2].length >= 3) {
    const p = lines[n - 2], cand = [p[p.length - 1]].concat(lines[n - 1]);
    if (measure(cand.map((x) => x[0]).join(' ')) <= maxW) { lines[n - 1] = cand; lines[n - 2] = p.slice(0, -1); }
  }
  return lines;
}

/** Pengaturan hook dari opsi (termasuk pengaturan lama hook_box). */
export function hookCfg(o, W, H, over = {}) {
  let tpl = over.tpl || o.hook_tpl;
  let bg = o.hook_bg, txt = o.hook_txt, acc = o.hook_acc, align = o.hook_align;
  if (!tpl) {
    const box = o.hook_box || '';
    if (box === 'hitam') { tpl = 'kotak'; bg = '#000000'; txt = '#ffffff'; }
    else if (box === 'polos') { tpl = 'polos'; txt = TEXTCOL[o.hook_color] || '#ffffff'; }
    else if (box === 'putih') { tpl = 'kotak'; bg = '#ffffff'; txt = '#000000'; }
    else tpl = 'kutipan';
    align ||= box ? 'tengah' : 'kiri';
  }
  if (!HOOK_TEMPLATES.includes(tpl)) tpl = 'kutipan';
  const d = hookDefaults(tpl);
  return {
    tpl, W, H,
    size: over.size || num(o.hook_size, 58),
    align: over.align || align || d.align,
    pos: over.pos || o.hook_pos || 'auto',
    x: over.x !== undefined ? over.x : num(o.hook_x, 0),
    y: over.y !== undefined ? over.y : num(o.hook_y, 20),
    wpct: num(o.hook_w, 84),
    bg: bg || d.bg, txt: txt || d.txt, acc: acc || d.acc,
    bg_op: (o.hook_bg_op === '' || o.hook_bg_op == null ? (tpl === 'strip' ? 75 : 100) : +o.hook_bg_op) / 100,
    outline: num(o.hook_outline, 10),
    upper: o.hook_upper !== false,
    round: !!o.hook_round,
    label: over.label !== undefined ? over.label : (o.hook_label || ''),
    safe: over.safe || 0,
    anim: over.anim || o.hook_anim || 'halus',
  };
}

/** Teks -> elemen tata letak (kotak, teks, tanda kutip, label). */
export function hookPrepare(text, cfg, fontId, autoCy) {
  const font = getFont(fontId);
  const E = cfg.size * 1.015;
  const ctx = measureCtx();
  const measure = (s) => { ctx.font = cssFont(fontId, E); return ctx.measureText(s).width; };
  const tok = hookTokens(text, cfg.upper);
  const pad = cfg.tpl === 'kutipan' || cfg.tpl === 'kotak' ? 1.2 * E : 0;
  const lines = hookWrap(tok, (cfg.W * cfg.wpct) / 100 - pad, measure);
  const widths = lines.map((l) => measure(l.map((x) => x[0]).join(' ')));
  let labelW = null;
  if (cfg.tpl === 'label' && cfg.label) {
    cfg.label = clean(cfg.label).toLocaleUpperCase('id');
    ctx.font = cssFont(fontId, 0.5 * E);
    labelW = ctx.measureText(cfg.label).width;
  }
  return hookLayout(lines, widths, cfg, font.cap || 0.7, autoCy, labelW);
}
let mc = null;
const measureCtx = () => (mc ??= document.createElement('canvas').getContext('2d'));

function hookLayout(lines, widths, cfg, capR, autoCy, labelW) {
  const { W, H } = cfg;
  const E = cfg.size * 1.015, cap = capR * E, up = cfg.upper;
  const inkTop = cap * (up ? 1 : 1.04), inkBot = up ? 0 : 0.21 * E, ink = inkTop + inkBot, tpl = cfg.tpl;
  const boxed = tpl === 'kutipan' || tpl === 'kotak', padx = 0.6 * E, pady = 0.22 * E, gap = 0.13 * E, n = Math.max(1, lines.length);
  let lh, pitch;
  if (boxed) { lh = ink + 2 * pady; pitch = lh + gap; }
  else { lh = ink; const ol = tpl === 'polos' || tpl === 'label' ? (cfg.size * cfg.outline) / 100 : 0; pitch = ink + 0.3 * E + 1.2 * ol; }
  const textH = n * lh + (n - 1) * (pitch - lh);
  let headH = 0, badge = null, lab = null;
  if (tpl === 'kutipan') { badge = { w: 2.2 * E, h: 1.3 * E }; headH = badge.h + 0.5 * E; }
  else if (tpl === 'label' && cfg.label) {
    const le = 0.5 * E;
    lab = { em: le, padx: 0.42 * le, h: (cap / E) * le + 2 * 0.45 * le, tw: labelW || 0 };
    lab.w = lab.tw + 2 * lab.padx; headH = lab.h + 0.32 * E;
  }
  const stripPad = tpl === 'strip' ? 0.45 * E : 0, blockH = headH + textH, portrait = H > W, pos = cfg.pos;
  let top;
  if (pos === 'atas') top = H * (portrait ? 0.085 : 0.07);
  else if (pos === 'tengah') top = H * 0.5 - blockH / 2;
  else if (pos === 'bawah') top = H * (portrait ? 0.8 : 0.78) - blockH / 2;
  else if (pos === 'bebas') top = (H * cfg.y) / 100 - blockH / 2;
  else top = Math.max(H * 0.035 + stripPad, autoCy - blockH / 2);
  if ((pos === 'auto' || pos === 'atas') && cfg.safe) top = Math.max(top, cfg.safe + stripPad + 0.01 * H);
  const align = cfg.align;
  let ax;
  if (pos === 'bebas' && cfg.x > 0) ax = (W * cfg.x) / 100;
  else {
    ax = W * ({ kiri: 0.085, tengah: 0.5, kanan: 0.915 }[align] || 0.5);
    if (tpl === 'strip' && align !== 'tengah') ax = W * (align === 'kiri' ? 0.07 : 0.93);
  }
  const place = (w) => (align === 'kiri' ? ax : align === 'tengah' ? ax - w / 2 : ax - w);
  const el = { boxes: [], texts: [], badge: null, label: null, marks: [], E, ax, top, blockH };
  let y = top;
  if (badge) {
    const bx = place(badge.w);
    el.badge = { x: bx, y, w: badge.w, h: badge.h };
    const mw = 0.585 * E, mh = 0.83 * E, mg = 0.13 * E, mx = bx + (badge.w - (2 * mw + mg)) / 2, my = y + (badge.h - mh) / 2 + 0.04 * E;
    for (let k = 0; k < 2; k++) { const ox = mx + k * (mw + mg); el.marks.push(QUOTE.map(([px, py]) => [ox + px * mw, my + py * mh])); }
    y += headH;
  } else if (lab) {
    const lx = place(lab.w);
    el.label = { x: lx, y, w: lab.w, h: lab.h, em: lab.em, tx: lx + lab.padx, base: y + lab.h / 2 + ((cap / E) * lab.em) / 2 };
    y += headH;
  }
  lines.forEach((line, i) => {
    const tw = widths[i] || 0, ly = y + i * pitch;
    if (boxed) { const bw = tw + 2 * padx, bx = place(bw); el.boxes.push({ x: bx, y: ly, w: bw, h: lh }); el.texts.push({ x: bx + padx, base: ly + pady + inkTop, line, w: tw }); }
    else el.texts.push({ x: place(tw), base: ly + inkTop, line, w: tw });
  });
  if (tpl === 'strip') {
    el.boxes.unshift({ x: 0, y: top - stripPad, w: W, h: blockH + 2 * stripPad, strip: true },
      { x: 0, y: top - stripPad, w: 0.16 * E, h: blockH + 2 * stripPad, accent: true });
  }
  const xs = [], xe = [];
  el.boxes.filter((b) => !b.strip).forEach((b) => { xs.push(b.x); xe.push(b.x + b.w); });
  el.texts.forEach((t) => { xs.push(t.x); xe.push(t.x + t.w); });
  if (el.badge) { xs.push(el.badge.x); xe.push(el.badge.x + el.badge.w); }
  if (el.label) { xs.push(el.label.x); xe.push(el.label.x + el.label.w); }
  el.bounds = { x0: xs.length ? Math.min(...xs) : ax, y0: top, x1: xe.length ? Math.max(...xe) : ax, y1: top + blockH };
  return el;
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r <= 0.5) { ctx.rect(x, y, w, h); return; }
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Gambar hook. t = waktu sekarang, [t0, t1] = waktu tampil (animasi naik + fade seperti versi PC). */
export function paintHook(ctx, el, cfg, fontId, t = 0, t0 = -1, t1 = 1e9, alphaMul = 1) {
  if (t < t0 || t >= t1) return;
  const smooth = cfg.anim !== 'none';
  let k = 0;
  const anim = () => {
    const st = smooth ? Math.min(t0 + Math.min(k, 6) * 0.06, t1) : t0;
    k++;
    if (t < st) return null;
    let a = smooth ? Math.min(1, (t - st) / 0.2) : 1;
    a = Math.min(a, (t1 - t) / (smooth ? 0.18 : 0.12));
    const dy = smooth ? 16 * (1 - Math.min(1, (t - st) / 0.26)) : 0;
    return { a: Math.max(0, Math.min(1, a)) * alphaMul, dy };
  };
  const tpl = cfg.tpl;
  ctx.save();
  for (const b of el.boxes) {
    const m = anim(); if (!m) continue;
    ctx.globalAlpha = m.a;
    if (b.strip) ctx.fillStyle = rgba(cfg.bg, cfg.bg_op);
    else if (b.accent) ctx.fillStyle = cfg.acc;
    else ctx.fillStyle = rgba(cfg.bg, cfg.bg_op);
    rrect(ctx, b.x, b.y + m.dy, b.w, b.h, !b.strip && !b.accent && cfg.round ? b.h * 0.22 : 0);
    ctx.fill();
  }
  if (el.badge) {
    const b = el.badge, m = anim();
    if (m) {
      ctx.globalAlpha = m.a; ctx.fillStyle = rgba(cfg.acc, 0.93);
      rrect(ctx, b.x, b.y + m.dy, b.w, b.h, cfg.round ? b.h * 0.16 : 0); ctx.fill();
    }
    for (const poly of el.marks) {
      const mm = anim(); if (!mm) continue;
      ctx.globalAlpha = mm.a; ctx.fillStyle = '#fff'; ctx.beginPath();
      poly.forEach(([px, py], i) => (i ? ctx.lineTo(px, py + mm.dy) : ctx.moveTo(px, py + mm.dy)));
      ctx.closePath(); ctx.fill();
    }
  }
  if (el.label) {
    const l = el.label, m = anim(), m2 = anim();
    if (m) { ctx.globalAlpha = m.a; ctx.fillStyle = cfg.acc; rrect(ctx, l.x, l.y + m.dy, l.w, l.h, cfg.round ? l.h * 0.25 : 0); ctx.fill(); }
    if (m2) {
      ctx.globalAlpha = m2.a; ctx.fillStyle = isLight(cfg.acc) ? '#111111' : '#ffffff';
      ctx.font = cssFont(fontId, l.em); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.fillText(cfg.label, l.tx, l.base + m2.dy);
    }
  }
  const hl = (tpl === 'kutipan' || tpl === 'kotak') && isLight(cfg.bg) && isLight(cfg.acc) ? shade(cfg.acc, 0.62) : cfg.acc;
  const ol = tpl === 'polos' || tpl === 'label' ? (cfg.size * cfg.outline) / 100 : 0;
  ctx.font = cssFont(fontId, el.E); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
  for (const tx of el.texts) {
    const m = anim(); if (!m) continue;
    ctx.globalAlpha = m.a;
    let pre = '';
    for (const [w, h] of tx.line) {
      const x = tx.x + ctx.measureText(pre).width;
      pre += w + ' ';
      if (ol > 0) {
        ctx.lineWidth = ol * 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.62)'; ctx.strokeText(w, x + ol * 0.45, tx.base + m.dy + ol * 0.45);
        ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.strokeText(w, x, tx.base + m.dy);
      }
      ctx.fillStyle = h ? hl : cfg.txt; ctx.fillText(w, x, tx.base + m.dy);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ banner program / sponsor
/** Band di atas: teks kiri + logo + teks kanan (atau gambar PNG jadi). -> {bottom, draw(ctx)} */
export function bannerLayout(o, W, H, fontId, logoImg, bannerImg) {
  if (!o.banner_on) return null;
  if (o.banner_mode === 'gambar') {
    if (!bannerImg) return null;
    const bw = even((W * num(o.banner_w, 100)) / 100), bh = (bw * bannerImg.height) / bannerImg.width, y = (H * num(o.banner_y, 4.5)) / 100;
    return { bottom: y + bh, draw: (ctx) => ctx.drawImage(bannerImg, (W - bw) / 2, y, bw, bh) };
  }
  const sc = H > W ? W / 1080 : H / 1080;
  const bh = num(o.banner_h, 104) * sc, by = (H * num(o.banner_y, 4.5)) / 100;
  let s1 = num(o.banner_size, 30) * sc, s2 = num(o.banner_size2, 40) * sc;
  const t1 = clean(o.banner_text1), t2 = clean(o.banner_text2), lx = num(o.banner_lx, 0), cy = by + bh / 2;
  const lh = bh * 0.72, lw = logoImg ? (lh * logoImg.width) / logoImg.height : 0;
  const ctx0 = measureCtx();
  const mw = (s, em) => { if (!s) return 0; ctx0.font = cssFont(fontId, em); return ctx0.measureText(s).width; };
  let w1 = mw(t1, s1 * 1.015), w2 = mw(t2, s2 * 1.015), g1 = t1 && (lw || t2) ? 0.5 * s1 : 0, g2 = t2 && lw ? 0.35 * s2 : 0;
  let total = w1 + g1 + lw + g2 + w2;
  const f = total > 0.94 * W ? Math.min(1, (0.94 * W - lw) / Math.max(1, total - lw)) : 1;
  s1 *= f; s2 *= f; w1 *= f; w2 *= f; g1 *= f; g2 *= f;
  total = w1 + g1 + lw + g2 + w2;
  let x = lw && lx > 0 ? (W * lx) / 100 - lw / 2 - g1 - w1 : (W - total) / 2;
  const cap = getFont(fontId).cap || 0.7;
  const texts = [];
  let logo = null;
  if (t1) texts.push({ t: t1, em: s1 * 1.015, x, base: cy + (cap * s1 * 1.015) / 2 });
  x += w1 + g1;
  if (lw) { logo = { x, y: cy - lh / 2, w: lw, h: lh }; x += lw + g2; }
  if (t2) texts.push({ t: t2, em: s2 * 1.015, x, base: cy + (cap * s2 * 1.015) / 2 });
  const H2 = even(bh);
  return {
    bottom: by + bh,
    draw: (ctx) => {
      ctx.save();
      ctx.fillStyle = rgba(o.banner_bg || '#000000', num(o.banner_op, 60) / 100); ctx.fillRect(0, by, W, H2);
      if (o.banner_line !== false) { ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillRect(0, by + H2 - 3, W, 3); }
      if (logo && logoImg) ctx.drawImage(logoImg, logo.x, logo.y, logo.w, logo.h);
      ctx.restore();
    },
    drawText: (ctx) => {
      ctx.save();
      ctx.fillStyle = o.banner_txt || '#ffffff'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      for (const t of texts) { ctx.font = cssFont(fontId, t.em); ctx.fillText(t.t, t.x, t.base); }
      ctx.restore();
    },
  };
}

// ------------------------------------------------------------------ progress bar
function drawPbar(ctx, t, o, W, H, dur) {
  if (!o.pbar_on || dur <= 0) return;
  const h = Math.max(4, num(o.pbar_h, 10)) * (H > W ? W / 1080 : H / 1080);
  const y = o.pbar_pos === 'atas' ? 0 : H - h;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.31)'; ctx.fillRect(0, y, W, h);
  ctx.fillStyle = o.pbar_col || '#ffd400'; ctx.fillRect(0, y, W * Math.max(0, Math.min(1, t / dur)), h);
  ctx.restore();
}

// ------------------------------------------------------------------ overlay lengkap
/**
 * ov: { o, W, H, g (geom), chunks, dur, hook, hookSpan, credit, flashAt, logo, fonts:{sub,hook,wm}, behind,
 *       banner (hasil bannerLayout), channel }
 */
export function drawOverlay(ctx, t, ov) {
  const { o, W, H, g, dur } = ov;
  const safe = ov.banner?.bottom || 0;
  const up = o.uppercase !== false ? (s) => s.toLocaleUpperCase('id') : (s) => s;
  ov.banner?.draw(ctx);
  drawLogo(ctx, ov.logo, o, W, H, safe);

  // subtitle
  if (ov.chunks?.length) drawSubs(ctx, t, ov, up);

  // sumber + teks banner
  if (ov.credit) {
    const size = H > W ? Math.round((34 * W) / 1080) : 30;
    drawTextEvent(ctx, [{ t: clean(ov.credit), color: '#FFFFFF', ow: 3, oc: '#000' }],
      { fontId: ov.fonts.sub, px: size * EM, x: W / 2, y: g.credit_y, an: 5, alpha: 0.75, maxW: W - 80 });
  }
  ov.banner?.drawText?.(ctx);

  // judul hook
  if (ov.hook) {
    let h0 = 0, h1 = dur;
    if (ov.hookSpan) [h0, h1] = ov.hookSpan;
    else { const hs = num(o.hook_secs, 0); if (hs > 0) h1 = Math.min(dur, hs); }
    if (t >= h0 && t < h1) {
      ov._hook ??= (() => {
        const cfg = hookCfg(o, W, H, { label: o.hook_label || ov.channel || '', safe });
        return { cfg, el: hookPrepare(ov.hook, cfg, ov.fonts.hook, g.hook_y) };
      })();
      paintHook(ctx, ov._hook.el, ov._hook.cfg, ov.fonts.hook, t, h0, h1, ov.hookAlpha ?? 1);
    }
  }

  // watermark
  if (!ov.behind) drawWatermark(ctx, t, o, W, H, ov.fonts.wm, dur, true, safe);

  // teks penutup
  const cta = String(o.cta_text || '').trim();
  if (cta) {
    const secs = Math.max(1, num(o.cta_secs, 3));
    const c0 = Math.max(0, dur - secs);
    if (t >= c0 && t < dur) {
      ov._cta ??= (() => {
        const tpl = { kutipan: 'kotak', kotak: 'kotak', strip: 'strip' }[o.hook_tpl] || 'polos';
        const cfg = hookCfg(o, W, H, { tpl, size: num(o.hook_size, 58) * 0.82, align: 'tengah', pos: 'bebas', x: 0, y: num(o.cta_y, 45), anim: 'halus' });
        return { cfg, el: hookPrepare(cta, cfg, ov.fonts.hook, H * 0.45) };
      })();
      paintHook(ctx, ov._cta.el, ov._cta.cfg, ov.fonts.hook, t, c0, dur);
    }
  }

  // kilat putih
  if (ov.flashAt != null && t >= ov.flashAt && t < ov.flashAt + 0.35) {
    ctx.save();
    ctx.globalAlpha = fadeAlpha(t, ov.flashAt, ov.flashAt + 0.35, 0, 0.3);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  drawPbar(ctx, t, o, W, H, dur);
}

function drawSubs(ctx, t, ov, up) {
  const { o, W, g, dur, chunks } = ov;
  const size = num(o.sub_size, 80);
  const outline = Math.max(2, Math.round((size * num(o.sub_outline, 9)) / 100));
  const hl = HL[o.sub_color] || HL.kuning;
  const tc = TEXTCOL[o.sub_text] || '#FFFFFF';
  const style = o.sub_style || 'highlight';
  const base = { fontId: ov.fonts.sub, px: size * EM, x: W / 2, y: g.sub_y, an: 5, maxW: W - 80,
    shadow: Math.max(1, Math.floor(outline / 2)), spacing: 1 };
  for (let ci = 0; ci < chunks.length; ci++) {
    const ch = chunks[ci];
    if (t < ch.start - 0.01) break;
    let cEnd = Math.min(ch.end + 0.3, dur);
    if (ci + 1 < chunks.length) cEnd = Math.min(cEnd, chunks[ci + 1].start);
    if (t >= cEnd) continue;
    const words = ch.words;
    const texts = words.map((w) => up(clean(w.t))).filter(Boolean);
    if (!texts.length) continue;
    if (style === 'simple') {
      drawTextEvent(ctx, texts.map((x) => ({ t: x, color: tc, ow: outline, oc: '#000' })),
        { ...base, alpha: fadeAlpha(t, ch.start, cEnd, 0.06, 0) });
      return;
    }
    for (let j = 0; j < words.length; j++) {
      const a = words[j].s;
      const z = j + 1 < words.length ? words[j + 1].s : cEnd;
      if (z <= a || t < a || t >= z) continue;
      const shown = style === 'muncul' ? texts.slice(0, j + 1) : texts;
      const tokens = shown.map((x, k) => {
        if (k !== j) return { t: x, color: tc, ow: outline, oc: '#000' };
        if (style === 'kotak') return { t: x, color: tc, ow: Math.round(outline * 2.2), oc: hl };
        return { t: x, color: hl, ow: outline, oc: '#000', scale: 1.14 };
      });
      const pop = j === 0 ? 0.92 + 0.08 * Math.min(1, (t - a) / 0.09) : 1;
      drawTextEvent(ctx, tokens, { ...base, popScale: pop });
      return;
    }
    return;
  }
}
