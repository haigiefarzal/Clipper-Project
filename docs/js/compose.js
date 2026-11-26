// Penyusun gambar per frame: layout kamera + subtitle + hook + watermark + logo.
// Angka & aturan sama dengan KlipKu versi PC (app.py + engine_subs.py), hanya digambar di canvas.
import { cssFont } from './fonts.js';

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
function wmCorner(pos, W, H) {
  const m = Math.round(W * 0.04);
  const top = Math.round(H * 0.06), bot = Math.round(H > W ? H * 0.12 : H * 0.07);
  return ({
    'kiri-atas': [7, m, top], 'kanan-atas': [9, W - m, top], 'kiri-bawah': [1, m, H - bot],
    'kanan-bawah': [3, W - m, H - bot], 'atas-tengah': [8, W / 2, top], 'bawah-tengah': [2, W / 2, H - bot],
    tengah: [5, W / 2, H / 2],
  })[pos] || [9, W - m, top];
}

export function drawWatermark(ctx, t, o, W, H, fontId, dur, force = false) {
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
    const [an, x, y] = wmCorner(o.wm_pos || 'kanan-atas', W, H);
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
    const [an, x, y] = wmCorner(cycle[i % 4], W, H);
    drawTextEvent(ctx, tok(), { fontId, px, x, y, an, alpha: fadeAlpha(t, a, b, 0.25, 0.25) });
  }
}

// ------------------------------------------------------------------ logo
export function drawLogo(ctx, logo, o, W, H) {
  if (!logo || !o.logo_on) return;
  const lw = even((W * num(o.logo_size, 18)) / 100);
  const lh = (lw * logo.height) / logo.width;
  const m = Math.round(W * 0.04), top = Math.round(H * 0.06), bot = Math.round(H * (H > W ? 0.12 : 0.07));
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

// ------------------------------------------------------------------ overlay lengkap
/**
 * ov: { o, W, H, g (geom), chunks, dur, hook, hookSpan, credit, flashAt, logo, fonts:{sub,hook,wm}, behind }
 */
export function drawOverlay(ctx, t, ov) {
  const { o, W, H, g, dur } = ov;
  const up = o.uppercase !== false ? (s) => s.toLocaleUpperCase('id') : (s) => s;
  drawLogo(ctx, ov.logo, o, W, H);

  // subtitle (layer 0)
  if (ov.chunks?.length) drawSubs(ctx, t, ov, up);

  // sumber (layer 1)
  if (ov.credit) {
    const size = H > W ? Math.round((34 * W) / 1080) : 30;
    drawTextEvent(ctx, [{ t: clean(ov.credit), color: '#FFFFFF', ow: 3, oc: '#000' }],
      { fontId: ov.fonts.sub, px: size * EM, x: W / 2, y: g.credit_y, an: 5, alpha: 0.75, maxW: W - 80 });
  }

  // judul hook (layer 2)
  if (ov.hook) {
    let h0 = 0, h1 = dur;
    if (ov.hookSpan) [h0, h1] = ov.hookSpan;
    else { const hs = num(o.hook_secs, 0); h1 = hs <= 0 ? dur : Math.min(dur, hs); }
    if (t >= h0 && t < h1) drawHook(ctx, up(clean(ov.hook)), o, W, H, g, ov.fonts.hook, fadeAlpha(t, h0, h1, 0.12, 0.2));
  }

  // watermark (layer 3)
  if (!ov.behind) drawWatermark(ctx, t, o, W, H, ov.fonts.wm, dur, true);

  // kilat putih (layer 6)
  if (ov.flashAt != null && t >= ov.flashAt && t < ov.flashAt + 0.35) {
    ctx.save();
    ctx.globalAlpha = fadeAlpha(t, ov.flashAt, ov.flashAt + 0.35, 0, 0.3);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

function drawHook(ctx, text, o, W, H, g, fontId, alpha) {
  const size = num(o.hook_size, 58);
  const px = size * EM;
  const hm = Math.round(W * 0.09);
  const box = o.hook_box || 'putih';
  const base = { fontId, px, x: W / 2, y: g.hook_y, an: 5, maxW: W - hm * 2, alpha };
  const tokens = text.split(' ').filter(Boolean);
  if (box === 'polos') {
    const hc = TEXTCOL[o.hook_color] || '#FFFFFF';
    const hol = Math.max(0, Math.round((size * num(o.hook_outline, 10)) / 100));
    drawTextEvent(ctx, tokens.map((t) => ({ t, color: hc, ow: hol, oc: '#000' })),
      { ...base, shadow: Math.max(0, Math.floor(hol / 2)) });
  } else {
    const dark = box === 'hitam';
    drawTextEvent(ctx, tokens.map((t) => ({ t, color: dark ? '#FFFFFF' : '#000000', ow: 0 })),
      { ...base, box: { color: dark ? '#000000' : '#FFFFFF', pad: Math.round(size * 0.3) } });
  }
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
