// Buku alamat KlipKu (Cloudflare Pages Function, ikut ter-deploy bersama projectgieclips.pages.dev).
// KlipKu PC menyimpan alamat tunnel-nya, HP membacanya. Tidak menyimpan video, kunci API, atau data lain.
// Butuh binding KV bernama PAIRS di pengaturan proyek Pages.
const ORIGINS = [
  'https://haigiefarzal.github.io',
  'https://projectgieclips.pages.dev',
  'https://projectgieclips.netlify.app',
];
const ID = /^[A-Za-z0-9_-]{20,64}$/;
const TUNNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : {};
}
const json = (data, status, h) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } });

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest({ request, env, params }) {
  const h = cors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const id = String(params.id || '');
  if (!ID.test(id)) return json({ error: 'tidak ditemukan' }, 404, h);
  if (!env.PAIRS) return json({ error: 'buku alamat belum disiapkan' }, 503, h);
  if (request.method === 'GET') {
    const v = await env.PAIRS.get(id, 'json');
    if (!v || !v.url) return json({ error: 'KlipKu PC belum menyala' }, 404, h);
    return json({ url: v.url, updated: v.updated }, 200, h);
  }
  if (request.method === 'PUT' || request.method === 'DELETE') {
    let body = {};
    try { body = await request.json(); } catch { /* kosong */ }
    const token = String(body.token || '');
    if (token.length < 24) return json({ error: 'token salah' }, 403, h);
    const hash = await sha(token);
    const prev = await env.PAIRS.get(id, 'json');
    if (prev && prev.h !== hash) return json({ error: 'token salah' }, 403, h);
    const url = request.method === 'PUT' ? String(body.url || '') : '';
    if (url && !TUNNEL.test(url)) return json({ error: 'alamat tidak valid' }, 400, h);
    await env.PAIRS.put(id, JSON.stringify({ url, h: hash, updated: Date.now() }), { expirationTtl: 60 * 60 * 24 * 60 });
    return json({ ok: true }, 200, h);
  }
  return json({ error: 'metode tidak didukung' }, 405, h);
}
