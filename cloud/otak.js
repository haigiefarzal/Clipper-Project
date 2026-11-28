// KlipKu Otak, Cloudflare Worker (gratis, nyala 24 jam).
// Tugas: bot Telegram pusat komando, pantau channel YouTube (RSS tiap 5 menit), antrean tugas untuk
// laptop (tangan), kuota & jadwal posting, peringatan laptop offline, rekap harian.
// Laptop (KlipKu) mengambil tugas lewat /api/poll, mengerjakan (analisis, render, upload), lalu lapor balik.
// Binding: DB (D1). Secret: TG_TOKEN, OWNER_ID, WORKER_KEY, TG_SECRET. Opsional: TG_API (untuk uji).

const VERSI = "1.0";
const LEASE = 45 * 60;          // tugas yang diambil laptop dianggap macet setelah 45 menit tanpa kabar
const UNDO_DEFAULT = 60;        // jendela batal setelah ✅ Upload (detik)
const J = JSON.stringify;

// ============================================================================ util

const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function parseTime(t) {
  t = String(t || "").trim().replace(",", ".");
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return null;
  return t.split(":").reduce((a, x) => a * 60 + parseFloat(x), 0);
}
function json(data, status = 200) {
  return new Response(J(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// ---------------------------------------------------------------- database
const q = (env, sql, ...p) => env.DB.prepare(sql).bind(...p.map((x) => x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
async function all(env, sql, ...p) { return (await q(env, sql, ...p).all()).results || []; }
async function one(env, sql, ...p) { return (await q(env, sql, ...p).first()) || null; }
async function run(env, sql, ...p) { return await q(env, sql, ...p).run(); }
async function getKV(env, k, d = null) { const r = await one(env, "SELECT v FROM kv WHERE k=?", k); return r ? r.v : d; }
async function setKV(env, k, v) { await run(env, "INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v)); }

async function settings(env) {
  const rows = await all(env, "SELECT k,v FROM kv");
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  return {
    quota: parseInt(m.quota ?? "5"),
    gap: parseInt(m.gap ?? "60"),
    prime: (m.prime ?? "12,17,19,21").split(",").map((x) => parseInt(x)).filter((x) => x >= 0 && x < 24),
    tz: parseFloat(m.tz ?? "7"),
    paused: m.paused === "1",
    undo: parseInt(m.undo ?? String(UNDO_DEFAULT)),
    last_seen: parseInt(m.last_seen ?? "0"),
    laptop: m.laptop ? JSON.parse(m.laptop) : null,
    presets: m.presets ? JSON.parse(m.presets) : [],
    upload_ok: m.upload_ok === "1",
  };
}

// ---------------------------------------------------------------- waktu lokal (WIB default +7)
const local = (t, tz) => new Date((t + tz * 3600) * 1000);          // pakai getUTC* untuk komponen lokal
function dayKey(t, tz) { const d = local(t, tz); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; }
function fmtWhen(t, tz) {
  const d = local(t, tz), n = local(now(), tz);
  const hh = `${String(d.getUTCHours()).padStart(2, "0")}.${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const same = dayKey(t, tz) === dayKey(now(), tz);
  const tmr = dayKey(t, tz) === dayKey(now() + 86400, tz);
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][d.getUTCDay()];
  return same ? `hari ini ${hh}` : tmr ? `besok ${hh}` : `${hari} ${d.getUTCDate()}/${d.getUTCMonth() + 1} ${hh}`;
}
function atLocalHour(base, hour, tz) {   // epoch detik untuk jam lokal 'hour' pada hari lokal 'base'
  const d = local(base, tz);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0) / 1000) - tz * 3600;
}

// ============================================================================ Telegram

async function tg(env, method, body) {
  const base = env.TG_API || "https://api.telegram.org";
  try {
    const r = await fetch(`${base}/bot${env.TG_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: J(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.log("telegram gagal", method, J(d).slice(0, 300));
    return d;
  } catch (e) { console.log("telegram error", method, String(e)); return { ok: false }; }
}
const kbd = (rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const btn = (text, data) => ({ text, callback_data: data });
async function say(env, text, rows, extra = {}) {
  const d = await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text, parse_mode: "HTML",
    disable_web_page_preview: true, ...(rows ? { reply_markup: kbd(rows) } : {}), ...extra });
  return d.ok ? d.result.message_id : null;
}
async function edit(env, msg_id, text, rows) {
  if (!msg_id) return say(env, text, rows);
  const d = await tg(env, "editMessageText", { chat_id: env.OWNER_ID, message_id: msg_id, text, parse_mode: "HTML",
    disable_web_page_preview: true, ...(rows ? { reply_markup: kbd(rows) } : {}) });
  return d.ok ? msg_id : null;
}
async function setKb(env, msg_id, rows) {
  if (!msg_id) return;
  await tg(env, "editMessageReplyMarkup", { chat_id: env.OWNER_ID, message_id: msg_id, reply_markup: kbd(rows || []) });
}

// ============================================================================ link

function videoFromUrl(u) {
  u = String(u || "").trim();
  let m = u.match(/twitch\.tv\/(?:[^/?#\s]+\/v(?:ideo)?|videos)\/(\d+)/i);
  if (m) return { id: `tw:v${m[1]}`, platform: "twitch", url: `https://www.twitch.tv/videos/${m[1]}` };
  m = u.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i) || u.match(/twitch\.tv\/(?:[^/?#\s]+\/)?clip\/([A-Za-z0-9_-]+)/i);
  if (m) return { id: `tw:c${m[1]}`, platform: "twitch", url: `https://clips.twitch.tv/${m[1]}` };
  m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (m) return { id: `yt:${m[1]}`, platform: "youtube", url: `https://www.youtube.com/watch?v=${m[1]}` };
  return null;
}
function channelFromUrl(u) {
  u = String(u || "").trim();
  let m = u.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  if (m) return { platform: "youtube", ref: m[1], url: `https://www.youtube.com/channel/${m[1]}` };
  m = u.match(/youtube\.com\/(@[\w.\-%]+)/i) || u.match(/youtube\.com\/(?:c|user)\/([\w.\-%]+)/i);
  if (m) return { platform: "youtube", ref: null, url: `https://www.youtube.com/${m[1].startsWith("@") ? m[1] : "c/" + m[1]}` };
  if (/^@[\w.\-]+$/.test(u)) return { platform: "youtube", ref: null, url: `https://www.youtube.com/${u}` };
  m = u.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})\/?(?:[?#].*)?$/i);
  if (m && !["videos", "directory", "settings"].includes(m[1].toLowerCase()))
    return { platform: "twitch", ref: m[1].toLowerCase(), url: `https://www.twitch.tv/${m[1].toLowerCase()}` };
  return null;
}

async function resolveYouTube(url) {
  try {
    const r = await fetch(url, { headers: { "accept-language": "id,en;q=0.8", cookie: "CONSENT=YES+1; SOCS=CAI",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" } });
    const html = await r.text();
    const id = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)
      || html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1];
    const name = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1];
    return id ? { ref: id, name: name ? name.replace(/&amp;/g, "&") : null } : null;
  } catch (e) { return null; }
}

// ============================================================================ tugas (antrean untuk laptop)

const PRIO = { upload: 5, recaption: 4, render: 3, resolve: 2, analyze: 1 };
async function addJob(env, kind, payload, { ref = null, delay = 0, status_msg = null } = {}) {
  const r = await run(env, "INSERT INTO jobs(kind,payload,prio,status,not_before,created_at,ref,status_msg) VALUES(?,?,?,?,?,?,?,?)",
    kind, J(payload), PRIO[kind] ?? 0, "antre", now() + delay, now(), ref, status_msg);
  return r.meta.last_row_id;
}
async function queueInfo(env) {
  const r = await one(env, "SELECT COUNT(*) n FROM jobs WHERE status IN ('antre','diambil')");
  return r ? r.n : 0;
}
function laptopOnline(s) { return now() - (s.last_seen || 0) < 90; }

// ============================================================================ jadwal & kuota

async function nextSlot(env, pref, s) {
  const tz = s.tz, gap = Math.max(1, s.gap) * 60, start = now() + Math.max(30, s.undo) + 60;
  const busy = (await all(env, "SELECT scheduled_at t FROM clips WHERE status IN ('akan_upload','terjadwal','terposting') AND scheduled_at>=?",
    now() - 2 * 86400)).map((r) => r.t).filter(Boolean);
  const perDay = (t) => busy.filter((b) => dayKey(b, tz) === dayKey(t, tz)).length;
  const primeAfter = (t) => {
    for (let k = 0; k < 3; k++) {
      for (const h of [...s.prime].sort((a, b) => a - b)) {
        const c = atLocalHour(t + k * 86400, h, tz);
        if (c >= t) return c;
      }
    }
    return t;
  };
  let t;
  if (pref === "sekarang") t = start;
  else if (/^\d{1,2}$/.test(pref)) { t = atLocalHour(start, parseInt(pref), tz); if (t < start) t += 86400; }
  else t = primeAfter(start);
  let note = "";
  for (let i = 0; i < 40; i++) {
    if (perDay(t) >= s.quota) {   // kuota hari itu penuh -> hari berikutnya
      const nextDay = atLocalHour(t + 86400, 0, tz);
      t = pref === "sekarang" ? primeAfter(nextDay) : /^\d{1,2}$/.test(pref) ? atLocalHour(nextDay, parseInt(pref), tz) : primeAfter(nextDay);
      note = `kuota ${s.quota}/hari sudah penuh, jadi digeser`;
      continue;
    }
    const clash = busy.find((b) => Math.abs(b - t) < gap);
    if (clash) { t = clash + gap; note = note || `jarak minimal ${s.gap} menit antar posting`; continue; }
    break;
  }
  return { t, note };
}
const WHEN_LABEL = { sekarang: "secepatnya", jam_ramai: "jam ramai berikutnya" };
const whenLabel = (p) => WHEN_LABEL[p] || (/^\d+$/.test(p) ? `jam ${String(p).padStart(2, "0")}.00` : p);

// ============================================================================ keyboard

function kbMoment(m) {
  if (m.status === "dibuat") return [[btn("🎬 Sudah dibuat, lihat clip di bawah", `m:${m.id}:noop`)]];
  if (m.status === "dilewati") return [[btn("⏭ Dilewati · ↩️ batalkan", `m:${m.id}:unskip`)]];
  return [[btn("🎬 Buat clip", `m:${m.id}:mk`), btn("⏭ Lewati", `m:${m.id}:skip`)]];
}
function kbClip(c) {
  const caps = c.captions ? JSON.parse(c.captions) : [];
  const nums = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  const capRow = caps.slice(0, 4).map((_, i) => btn((c.cap_pick === i ? "✅ " : "") + nums[i], `c:${c.id}:cap:${i}`));
  if (c.status === "akan_upload") return [[btn("↩️ Batal upload", `c:${c.id}:undo`)]];
  if (c.status === "terjadwal" || c.status === "terposting") return [];
  if (c.status === "dibuang") return [[btn("🗑 Dibuang · ↩️ kembalikan", `c:${c.id}:restore`)]];
  return [
    capRow,
    [btn(`🕒 ${whenLabel(c.when_pref)}`, `c:${c.id}:when`), btn("✂️ Edit", `c:${c.id}:edit`), btn("🎭 Caption lain", `c:${c.id}:recap`)],
    [btn("✅ Upload ke TikTok", `c:${c.id}:ok`)],
    [btn(c.status === "cadangan" ? "💾 Di cadangan" : "💾 Cadangan", `c:${c.id}:save`), btn("❌ Buang", `c:${c.id}:del`)],
  ];
}
function kbWhen(c, s) {
  const hours = [...s.prime].sort((a, b) => a - b).map((h) => btn(`${String(h).padStart(2, "0")}.00`, `c:${c.id}:t:${h}`));
  return [[btn("⚡ Secepatnya", `c:${c.id}:t:sekarang`), btn("🔥 Jam ramai berikutnya", `c:${c.id}:t:jam_ramai`)],
    hours.slice(0, 4), hours.slice(4, 8), [btn("⬅️ Kembali", `c:${c.id}:back`)]];
}
function kbEdit(c) {
  return [[btn("⏪ Awal −2 dtk", `c:${c.id}:e:s:-2`), btn("Awal +2 dtk ⏩", `c:${c.id}:e:s:2`)],
    [btn("⏪ Akhir −2 dtk", `c:${c.id}:e:e:-2`), btn("Akhir +2 dtk ⏩", `c:${c.id}:e:e:2`)],
    [btn(`🔁 Render ulang (${hms(c.start)}–${hms(c.end)})`, `c:${c.id}:rerender`)], [btn("⬅️ Kembali", `c:${c.id}:back`)]];
}
function kbChannel(ch, s) {
  return [
    [btn(ch.auto ? "🤖 Auto analisis: ON" : "🤖 Auto analisis: OFF", `ch:${ch.id}:auto`),
      btn(`🎯 Maks ${ch.per_video} momen/video`, `ch:${ch.id}:per`)],
    [btn(`🎨 Gaya: ${ch.gaya || "pengaturan terakhir"}`, `ch:${ch.id}:gaya`)],
    [btn(ch.status === "pause" ? "▶️ Lanjut pantau" : "⏸ Pause", `ch:${ch.id}:pause`), btn("🗑 Hapus", `ch:${ch.id}:del`)],
    [btn("⬅️ Daftar channel", `ch:0:list`)],
  ];
}

// ============================================================================ pesan status

async function statusText(env) {
  const s = await settings(env);
  const tz = s.tz;
  const seen = s.last_seen ? Math.round((now() - s.last_seen)) : null;
  const lap = laptopOnline(s)
    ? `🟢 Laptop online${s.laptop?.busy ? ` · sedang: ${esc(s.laptop.busy)}` : " · siap"}`
    : `🔴 Laptop offline${seen !== null && s.last_seen ? ` (terakhir ${fmtWhen(s.last_seen, tz)})` : " (belum pernah tersambung)"}`;
  const q1 = await one(env, "SELECT COUNT(*) n FROM jobs WHERE status='antre'");
  const today = (await all(env, "SELECT scheduled_at t FROM clips WHERE status IN ('akan_upload','terjadwal','terposting') AND scheduled_at>=?", now() - 2 * 86400))
    .filter((r) => dayKey(r.t, tz) === dayKey(now(), tz)).length;
  const nxt = await one(env, "SELECT scheduled_at t FROM clips WHERE status IN ('akan_upload','terjadwal') AND scheduled_at>=? ORDER BY scheduled_at LIMIT 1", now());
  const ch = await one(env, "SELECT COUNT(*) n, SUM(status='pantau') a FROM channels");
  const cad = await one(env, "SELECT COUNT(*) n FROM clips WHERE status IN ('siap','cadangan')");
  return [
    `<b>🧠 KlipKu Otak v${VERSI}</b>${s.paused ? " · ⏸ <b>DIJEDA</b>" : ""}`,
    lap,
    `📋 Antrean tugas: ${q1?.n || 0}`,
    `📤 Posting hari ini: ${today}/${s.quota}${nxt ? ` · berikutnya ${fmtWhen(nxt.t, tz)}` : ""}`,
    `💾 Clip siap/cadangan: ${cad?.n || 0}`,
    `📺 Channel dipantau: ${ch?.a || 0} dari ${ch?.n || 0}`,
    s.upload_ok ? "🔗 Layanan upload: tersambung" : "⚠️ Layanan upload belum diatur di laptop (KlipKu → Autopilot)",
  ].join("\n");
}

const HELP = `<b>Perintah KlipKu</b>
/status - kondisi sistem & laptop
/tambah &lt;link channel&gt; - pantau channel YouTube/Twitch
/channel - daftar & atur channel
/kuota 5 - maks posting TikTok per hari
/jarak 60 - jarak minimal antar posting (menit)
/jamramai 12,17,19,21 - jam tayang favorit
/antrian - tugas yang menunggu laptop
/jadwal - posting yang sudah dijadwalkan
/cadangan - clip yang belum diposting
/pause · /lanjut - jeda/lanjut pemantauan otomatis
/stop - hentikan semua tugas yang menunggu

<b>Clip manual:</b> kirim link video YouTube/Twitch.
<b>Menit sendiri:</b> <code>/clip &lt;link&gt; 1:23:40-1:24:30 Judul hook</code>
<b>Caption sendiri:</b> balas (reply) pesan clip dengan teks caption.`;

// ============================================================================ Telegram: pesan masuk

async function onMessage(env, msg) {
  const text = (msg.text || msg.caption || "").trim();
  const s = await settings(env);
  // balasan ke pesan clip = caption sendiri
  if (msg.reply_to_message && text && !text.startsWith("/")) {
    const c = await one(env, "SELECT * FROM clips WHERE msg_id=?", msg.reply_to_message.message_id);
    if (c) {
      const caps = c.captions ? JSON.parse(c.captions) : [];
      caps.push(text);
      await run(env, "UPDATE clips SET captions=?, cap_pick=?, caption=? WHERE id=?", J(caps), caps.length - 1, text, c.id);
      await run(env, "INSERT INTO taste(channel,caption,how,at) VALUES(?,?,?,?)", c.video_id, text, "ketik", now());
      const c2 = await one(env, "SELECT * FROM clips WHERE id=?", c.id);
      await setKb(env, c.msg_id, kbClip(c2));
      return say(env, `✍️ Caption sendiri dipakai untuk clip #${c.id} (pilihan ${caps.length}). Tekan <b>✅ Upload</b> di pesan clip.`);
    }
  }
  const [cmd0, ...rest] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\w+$/, "");
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/start": case "/bantuan": case "/help":
      return say(env, `👋 Halo Agie! Ini otak KlipKu yang nyala 24 jam.\n\n${await statusText(env)}\n\n${HELP}`);
    case "/status": case "/sehat":
      return say(env, await statusText(env));
    case "/kuota": {
      const n = parseInt(arg);
      if (!(n >= 1 && n <= 15)) return say(env, "Format: <code>/kuota 5</code> (1–15, batas TikTok lewat API ±15/hari).");
      await setKV(env, "quota", n);
      return say(env, `✅ Kuota posting jadi <b>${n} per hari</b>. Sisanya otomatis digeser ke hari berikutnya.`);
    }
    case "/jarak": {
      const n = parseInt(arg);
      if (!(n >= 5 && n <= 720)) return say(env, "Format: <code>/jarak 60</code> (menit, 5–720).");
      await setKV(env, "gap", n);
      return say(env, `✅ Jarak minimal antar posting: <b>${n} menit</b>.`);
    }
    case "/jamramai": {
      const hs = arg.split(/[,\s]+/).map((x) => parseInt(x)).filter((x) => x >= 0 && x < 24);
      if (!hs.length) return say(env, "Format: <code>/jamramai 12,17,19,21</code> (jam WIB).");
      await setKV(env, "prime", [...new Set(hs)].sort((a, b) => a - b).join(","));
      return say(env, `✅ Jam ramai: ${[...new Set(hs)].sort((a, b) => a - b).map((h) => `${h}.00`).join(", ")}`);
    }
    case "/pause": await setKV(env, "paused", "1"); return say(env, "⏸ Pemantauan & analisis otomatis dijeda. Clip yang kamu minta tetap diproses. /lanjut untuk menyalakan lagi.");
    case "/lanjut": await setKV(env, "paused", "0"); return say(env, "▶️ Pemantauan otomatis jalan lagi.");
    case "/stop": {
      const r = await run(env, "UPDATE jobs SET status='batal' WHERE status='antre'");
      await setKV(env, "paused", "1");
      await run(env, "UPDATE clips SET status='siap' WHERE status='akan_upload'");
      return say(env, `🛑 Stop darurat: ${r.meta.changes || 0} tugas dibatalkan, pemantauan dijeda. Tugas yang sedang dikerjakan laptop selesai dulu. /lanjut untuk menyalakan lagi.`);
    }
    case "/tambah": return cmdTambah(env, arg);
    case "/channel": case "/channels": return listChannels(env);
    case "/hapus": {
      const ch = await one(env, "SELECT * FROM channels WHERE lower(name) LIKE ? OR ref=?", `%${arg.toLowerCase()}%`, arg);
      if (!arg || !ch) return say(env, "Channel tidak ketemu. Lihat /channel.");
      await run(env, "DELETE FROM channels WHERE id=?", ch.id);
      return say(env, `🗑 ${esc(ch.name || ch.ref)} dihapus dari pantauan.`);
    }
    case "/antrian": return listJobs(env);
    case "/jadwal": return listSchedule(env);
    case "/cadangan": return listBackup(env);
    case "/clip": return cmdClip(env, arg);
  }
  if (cmd.startsWith("/")) return say(env, `Perintah tidak dikenal.\n\n${HELP}`);
  const v = videoFromUrl(text);
  if (v) return offerVideo(env, v, text);
  const ch = channelFromUrl(text);
  if (ch) return say(env, `Itu link channel. Mau dipantau? Kirim:\n<code>/tambah ${esc(ch.url)}</code>`);
  return say(env, `Kirim link video YouTube/Twitch untuk dicari momennya, atau /bantuan.`);
}

async function offerVideo(env, v, raw) {
  await run(env, "INSERT OR IGNORE INTO videos(id,channel_id,platform,url,title,status,found_at) VALUES(?,?,?,?,?,?,?)",
    v.id, null, v.platform, v.url, null, "baru", now());
  return say(env, `🎬 Video ${v.platform === "twitch" ? "Twitch" : "YouTube"} diterima.\nMau aku carikan momen terbaiknya, atau kamu tentukan menitnya sendiri?\n\nMenit sendiri: <code>/clip ${esc(v.url)} 1:23:40-1:24:30 Judul</code>`,
    [[btn("🔍 Cari momen otomatis", `v:${v.id}:an`)]]);
}

async function cmdClip(env, arg) {
  const m = arg.match(/^(\S+)\s+([\d:.]+)\s*[-–]\s*([\d:.]+)\s*(.*)$/);
  const v = m && videoFromUrl(m[1]);
  if (!v) return say(env, "Format: <code>/clip &lt;link&gt; 1:23:40-1:24:30 Judul hook (opsional)</code>");
  const a = parseTime(m[2]), b = parseTime(m[3]);
  if (a === null || b === null || b <= a) return say(env, "Menit tidak valid. Contoh: 1:23:40-1:24:30");
  if (b - a > 180) return say(env, "Maksimal 3 menit per clip.");
  await run(env, "INSERT OR IGNORE INTO videos(id,channel_id,platform,url,status,found_at) VALUES(?,?,?,?,?,?)", v.id, null, v.platform, v.url, "baru", now());
  const r = await run(env, "INSERT INTO clips(moment_id,video_id,url,start,end,intro,hook,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    null, v.id, v.url, a, b, null, m[4] || "", "render", now());
  const cid = r.meta.last_row_id;
  const msg = await say(env, `✂️ Clip #${cid} masuk antrean render: ${hms(a)}–${hms(b)}${m[4] ? `\n🪝 ${esc(m[4])}` : ""}`);
  await addJob(env, "render", { clip_id: cid, video_id: v.id, url: v.url, start: a, end: b, intro: null, hook: m[4] || "", gaya: "" },
    { ref: `clip:${cid}`, status_msg: msg });
  return msg;
}

async function cmdTambah(env, arg) {
  const ch = channelFromUrl(arg);
  if (!ch) return say(env, "Format: <code>/tambah https://www.youtube.com/@namachannel</code> atau <code>/tambah https://www.twitch.tv/nama</code>");
  let ref = ch.ref, name = ch.platform === "twitch" ? ch.ref : null;
  if (ch.platform === "youtube" && !ref) {
    const r = await resolveYouTube(ch.url);
    if (r) { ref = r.ref; name = r.name; }
  }
  const exists = ref && await one(env, "SELECT * FROM channels WHERE ref=?", ref);
  if (exists) return say(env, `ℹ️ ${esc(exists.name || exists.ref)} sudah dipantau.`, kbChannel(exists, await settings(env)));
  const r = await run(env, "INSERT INTO channels(platform,ref,name,url,added_at,last_check) VALUES(?,?,?,?,?,?)",
    ch.platform, ref || `url:${ch.url}`, name || ch.url, ch.url, now(), 0);
  const id = r.meta.last_row_id;
  if (!ref) {
    await addJob(env, "resolve", { channel_id: id, url: ch.url }, { ref: `ch:${id}` });
    return say(env, `➕ Channel ditambahkan. ID channel-nya akan dibaca laptop saat online.\n${esc(ch.url)}`);
  }
  if (ch.platform === "youtube") await checkChannel(env, await one(env, "SELECT * FROM channels WHERE id=?", id), true);
  const row = await one(env, "SELECT * FROM channels WHERE id=?", id);
  return say(env, `➕ <b>${esc(row.name || row.ref)}</b> (${ch.platform === "twitch" ? "Twitch" : "YouTube"}) mulai dipantau.\n` +
    (ch.platform === "twitch" ? "Channel Twitch dicek oleh laptop tiap 10 menit saat KlipKu nyala." : "Dicek tiap 5 menit. Video lama tidak diproses, hanya video baru.") +
    `\nAtur di bawah:`, kbChannel(row, await settings(env)));
}

async function listChannels(env) {
  const rows = await all(env, "SELECT * FROM channels ORDER BY id");
  if (!rows.length) return say(env, "Belum ada channel. Tambah: <code>/tambah https://www.youtube.com/@namachannel</code>");
  const lines = rows.map((c, i) => `${i + 1}. ${c.status === "pause" ? "⏸" : c.platform === "twitch" ? "🟣" : "🔴"} <b>${esc(c.name || c.ref)}</b> · ${c.auto ? "auto" : "manual"} · maks ${c.per_video}${c.gaya ? ` · gaya ${esc(c.gaya)}` : ""}${c.last_error ? ` · ⚠️ ${esc(cut(c.last_error, 60))}` : ""}`);
  return say(env, `<b>📺 Channel dipantau</b>\n${lines.join("\n")}\n\nKetuk untuk mengatur:`,
    rows.map((c) => [btn(`⚙️ ${cut(c.name || c.ref, 30)}`, `ch:${c.id}:show`)]));
}
async function listJobs(env) {
  const rows = await all(env, "SELECT * FROM jobs WHERE status IN ('antre','diambil') ORDER BY prio DESC, id LIMIT 20");
  if (!rows.length) return say(env, "📋 Antrean kosong.");
  const name = { analyze: "🔍 Analisis", render: "🎬 Render", upload: "📤 Upload", resolve: "🔎 Baca channel", recaption: "🎭 Caption" };
  const lines = rows.map((j) => {
    const p = JSON.parse(j.payload || "{}");
    return `${j.status === "diambil" ? "⚙️" : "⏳"} #${j.id} ${name[j.kind] || j.kind} ${esc(cut(p.title || p.video_id || p.clip_id || "", 40))}${j.not_before > now() ? ` (mulai ${fmtWhen(j.not_before, 7)})` : ""}`;
  });
  return say(env, `<b>📋 Antrean</b> (dikerjakan laptop)\n${lines.join("\n")}`);
}
async function listSchedule(env) {
  const s = await settings(env);
  const rows = await all(env, "SELECT * FROM clips WHERE status IN ('akan_upload','terjadwal') ORDER BY scheduled_at LIMIT 20");
  if (!rows.length) return say(env, "🗓 Belum ada posting terjadwal.");
  return say(env, `<b>🗓 Jadwal posting</b>\n` + rows.map((c) => `• ${fmtWhen(c.scheduled_at, s.tz)}, clip #${c.id} ${esc(cut(c.caption || c.hook || "", 50))}${c.status === "akan_upload" ? " (menunggu upload)" : ""}`).join("\n"));
}
async function listBackup(env) {
  const rows = await all(env, "SELECT * FROM clips WHERE status IN ('siap','cadangan') ORDER BY id DESC LIMIT 15");
  if (!rows.length) return say(env, "💾 Tidak ada clip cadangan.");
  return say(env, `<b>💾 Clip belum diposting</b>\nKetuk untuk memunculkan lagi:`,
    rows.map((c) => [btn(`#${c.id} ${cut(c.hook || c.caption || "clip", 40)}`, `c:${c.id}:resend`)]));
}

// ============================================================================ Telegram: tombol

async function onCallback(env, cb) {
  const data = cb.data || "";
  const msgId = cb.message?.message_id;
  const parts = data.split(":");
  const [kind, idRaw, act, a1, a2] = parts;
  let note = "";
  const s = await settings(env);
  try {
    if (kind === "v") {
      const vid = parts.slice(1, -1).join(":");
      const action = parts[parts.length - 1];
      const v = await one(env, "SELECT * FROM videos WHERE id=?", vid);
      if (!v) note = "Video tidak ditemukan";
      else if (action === "an") {
        const active = await one(env, "SELECT id FROM jobs WHERE ref=? AND status IN ('antre','diambil')", `an:${vid}`);
        if (active) note = "Sudah di antrean";
        else {
          const ch = v.channel_id ? await one(env, "SELECT * FROM channels WHERE id=?", v.channel_id) : null;
          await run(env, "UPDATE videos SET status='antre' WHERE id=?", vid);
          await addJob(env, "analyze", { video_id: vid, url: v.url, title: v.title, channel: ch?.name || "", gaya: ch?.gaya || "",
            per_video: ch?.per_video || 5 }, { ref: `an:${vid}`, status_msg: msgId });
          await edit(env, msgId, `🔍 <b>Masuk antrean analisis</b>\n${esc(v.title || v.url)}\n${laptopOnline(s) ? "Laptop online, segera dikerjakan." : "💤 Laptop offline, dikerjakan saat KlipKu di laptop menyala."}`);
          note = "Masuk antrean";
        }
      } else if (action === "skip") {
        await run(env, "UPDATE videos SET status='diabaikan' WHERE id=?", vid);
        await setKb(env, msgId, []);
        note = "Diabaikan";
      } else if (action === "top") {
        const ms = await all(env, "SELECT * FROM moments WHERE video_id=? AND status='kandidat' ORDER BY skor DESC", vid);
        for (const m of ms) await makeClip(env, m, s);
        note = `${ms.length} clip masuk antrean render`;
      }
    } else if (kind === "m") {
      const m = await one(env, "SELECT * FROM moments WHERE id=?", parseInt(idRaw));
      if (!m) note = "Momen tidak ditemukan";
      else if (act === "mk") { if (m.status !== "dibuat") { await makeClip(env, m, s); note = "Masuk antrean render"; } else note = "Sudah dibuat"; }
      else if (act === "skip") { await run(env, "UPDATE moments SET status='dilewati' WHERE id=?", m.id); m.status = "dilewati"; await setKb(env, m.msg_id || msgId, kbMoment(m)); note = "Dilewati"; }
      else if (act === "unskip") { await run(env, "UPDATE moments SET status='kandidat' WHERE id=?", m.id); m.status = "kandidat"; await setKb(env, m.msg_id || msgId, kbMoment(m)); }
    } else if (kind === "c") {
      note = await onClipButton(env, parseInt(idRaw), act, a1, a2, msgId, s);
    } else if (kind === "ch") {
      note = await onChannelButton(env, parseInt(idRaw), act, msgId, s);
    } else if (kind === "j") {
      const j = await one(env, "SELECT * FROM jobs WHERE id=?", parseInt(idRaw));
      if (j && act === "retry" && ["gagal", "batal"].includes(j.status)) {
        await run(env, "UPDATE jobs SET status='antre', not_before=?, tries=0 WHERE id=?", now(), j.id);
        await setKb(env, msgId, []);
        note = "Dicoba lagi";
      }
    }
  } catch (e) { console.log("callback error", String(e && e.stack || e)); note = "Error: " + String(e).slice(0, 150); }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: note || "" });
}

async function makeClip(env, m, s) {
  const v = await one(env, "SELECT * FROM videos WHERE id=?", m.video_id);
  const ch = v?.channel_id ? await one(env, "SELECT * FROM channels WHERE id=?", v.channel_id) : null;
  const hooks = m.hooks ? JSON.parse(m.hooks) : [];
  const r = await run(env, "INSERT INTO clips(moment_id,video_id,url,start,end,intro,hook,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    m.id, m.video_id, v?.url, m.start, m.end, m.intro, hooks[0] || "", "render", now());
  const cid = r.meta.last_row_id;
  await run(env, "UPDATE moments SET status='dibuat' WHERE id=?", m.id);
  m.status = "dibuat";
  await setKb(env, m.msg_id, kbMoment(m));
  const msg = await say(env, `🎬 Clip #${cid} masuk antrean render (${hms(m.start)}–${hms(m.end)})${laptopOnline(s) ? "" : "\n💤 Laptop offline, dirender saat KlipKu menyala."}`);
  await addJob(env, "render", { clip_id: cid, video_id: m.video_id, url: v?.url, start: m.start, end: m.end, intro: m.intro,
    hook: hooks[0] || "", hooks, caption: m.caption || "", info: m.info || "", kategori: m.kategori || "", title: v?.title || "",
    channel: ch?.name || "", gaya: ch?.gaya || "" }, { ref: `clip:${cid}`, status_msg: msg });
  return cid;
}

async function onClipButton(env, id, act, a1, a2, msgId, s) {
  const c = await one(env, "SELECT * FROM clips WHERE id=?", id);
  if (!c) return "Clip tidak ditemukan";
  const mid = c.msg_id || msgId;
  const refresh = async () => setKb(env, mid, kbClip(await one(env, "SELECT * FROM clips WHERE id=?", id)));
  const caps = c.captions ? JSON.parse(c.captions) : [];
  switch (act) {
    case "noop": return "";
    case "cap": {
      const i = parseInt(a1);
      if (!(i >= 0 && i < caps.length)) return "Caption tidak ada";
      await run(env, "UPDATE clips SET cap_pick=?, caption=? WHERE id=?", i, caps[i], id);
      await refresh();
      return `Caption ${i + 1} dipilih`;
    }
    case "when": await setKb(env, mid, kbWhen(c, s)); return "Pilih jam tayang";
    case "t": await run(env, "UPDATE clips SET when_pref=? WHERE id=?", a1, id); await refresh(); return `Tayang: ${whenLabel(a1)}`;
    case "back": await refresh(); return "";
    case "edit": await setKb(env, mid, kbEdit(c)); return "Geser awal/akhir lalu Render ulang";
    case "e": {
      const d = parseFloat(a2) || 0;
      let st = c.start, en = c.end;
      if (a1 === "s") st = Math.max(0, st + d); else en = en + d;
      if (en - st < 3) return "Clip terlalu pendek";
      if (en - st > 180) return "Maksimal 3 menit";
      await run(env, "UPDATE clips SET start=?, end=? WHERE id=?", st, en, id);
      await setKb(env, mid, kbEdit({ ...c, start: st, end: en }));
      return `${hms(st)}–${hms(en)}`;
    }
    case "rerender": {
      const v = await one(env, "SELECT * FROM videos WHERE id=?", c.video_id);
      const ch = v?.channel_id ? await one(env, "SELECT * FROM channels WHERE id=?", v.channel_id) : null;
      const m = c.moment_id ? await one(env, "SELECT * FROM moments WHERE id=?", c.moment_id) : null;
      const r = await run(env, "INSERT INTO clips(moment_id,video_id,url,start,end,intro,hook,status,created_at,parent_id,when_pref) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        c.moment_id, c.video_id, c.url, c.start, c.end, c.intro, c.hook, "render", now(), c.id, c.when_pref);
      const nid = r.meta.last_row_id;
      await run(env, "UPDATE clips SET status='dibuang' WHERE id=?", id);
      await setKb(env, mid, [[btn(`🔁 Diganti clip #${nid}`, `c:${id}:noop`)]]);
      const msg = await say(env, `🔁 Clip #${nid} (versi baru #${id}) masuk antrean render: ${hms(c.start)}–${hms(c.end)}`);
      await addJob(env, "render", { clip_id: nid, video_id: c.video_id, url: c.url, start: c.start, end: c.end, intro: c.intro,
        hook: c.hook || "", hooks: m?.hooks ? JSON.parse(m.hooks) : [], caption: m?.caption || "", info: m?.info || "",
        title: v?.title || "", channel: ch?.name || "", gaya: ch?.gaya || "", old_captions: caps }, { ref: `clip:${nid}`, status_msg: msg });
      return "Render ulang masuk antrean";
    }
    case "recap": {
      const active = await one(env, "SELECT id FROM jobs WHERE ref=? AND status IN ('antre','diambil')", `recap:${id}`);
      if (active) return "Sedang dibuatkan";
      await addJob(env, "recaption", { clip_id: id, captions: caps, hook: c.hook, video_id: c.video_id }, { ref: `recap:${id}` });
      return laptopOnline(s) ? "AI menulis caption baru..." : "Laptop offline, dibuat saat online";
    }
    case "save": await run(env, "UPDATE clips SET status='cadangan' WHERE id=?", id); await refresh(); return "Disimpan di cadangan (/cadangan)";
    case "del": await run(env, "UPDATE clips SET status='dibuang' WHERE id=?", id); await refresh(); return "Dibuang";
    case "restore": await run(env, "UPDATE clips SET status='siap' WHERE id=?", id); await refresh(); return "Dikembalikan";
    case "resend": {
      if (!c.msg_id) return "Pesan clip tidak ada";
      await tg(env, "copyMessage", { chat_id: env.OWNER_ID, from_chat_id: env.OWNER_ID, message_id: c.msg_id, reply_markup: kbd(kbClip(c)) })
        .then(async (d) => { if (d.ok) await run(env, "UPDATE clips SET msg_id=? WHERE id=?", d.result.message_id, id); });
      return "";
    }
    case "ok": {
      if (!["siap", "cadangan"].includes(c.status)) return `Status clip: ${c.status}`;
      if (!s.upload_ok) { await say(env, "⚠️ Layanan upload belum diatur. Buka KlipKu di laptop → <b>Autopilot</b> → Layanan upload."); return "Upload belum diatur"; }
      const caption = c.caption || caps[0] || c.hook || "";
      if (!caption) return "Pilih / ketik caption dulu";
      const slot = await nextSlot(env, c.when_pref || "jam_ramai", s);
      await run(env, "UPDATE clips SET status='akan_upload', scheduled_at=?, caption=? WHERE id=?", slot.t, caption, id);
      if (c.cap_pick >= 0) await run(env, "INSERT INTO taste(channel,caption,how,at) VALUES(?,?,?,?)", c.video_id, caption, "pilih", now());
      const jid = await addJob(env, "upload", { clip_id: id, caption, scheduled_at: slot.t, file_key: c.file_key, video_id: c.video_id },
        { ref: `up:${id}`, delay: s.undo });
      await setKb(env, mid, kbClip({ ...c, status: "akan_upload" }));
      await say(env, `⏳ Clip #${id} akan dikirim ke TikTok <b>${s.undo} detik lagi</b>, tayang <b>${fmtWhen(slot.t, s.tz)}</b>${slot.note ? ` (${slot.note})` : ""}.\nMasih bisa dibatalkan dengan tombol ↩️ di pesan clip.`,
        [[btn("↩️ Batal", `c:${id}:undo`)]]);
      return `Dijadwalkan ${fmtWhen(slot.t, s.tz)}`;
    }
    case "undo": {
      const j = await one(env, "SELECT * FROM jobs WHERE ref=? AND kind='upload' ORDER BY id DESC LIMIT 1", `up:${id}`);
      if (!j || j.status !== "antre") return "Sudah terlanjur dikirim, tidak bisa dibatalkan di sini";
      await run(env, "UPDATE jobs SET status='batal' WHERE id=?", j.id);
      await run(env, "UPDATE clips SET status='siap', scheduled_at=NULL WHERE id=?", id);
      await refresh();
      await say(env, `↩️ Upload clip #${id} dibatalkan.`);
      return "Dibatalkan";
    }
  }
  return "";
}

async function onChannelButton(env, id, act, msgId, s) {
  if (act === "list") { await listChannels(env); return ""; }
  const ch = await one(env, "SELECT * FROM channels WHERE id=?", id);
  if (!ch) return "Channel tidak ada";
  if (act === "show") { await say(env, `⚙️ <b>${esc(ch.name || ch.ref)}</b>\n${esc(ch.url || "")}`, kbChannel(ch, s)); return ""; }
  if (act === "auto") ch.auto = ch.auto ? 0 : 1;
  else if (act === "per") ch.per_video = { 3: 5, 5: 8, 8: 3 }[ch.per_video] || 5;
  else if (act === "pause") ch.status = ch.status === "pause" ? "pantau" : "pause";
  else if (act === "gaya") {
    const list = ["", ...(s.presets || [])];
    ch.gaya = list[(list.indexOf(ch.gaya || "") + 1) % list.length];
    if (list.length === 1) await say(env, "Belum ada Gaya tersimpan di KlipKu. Buat dulu di laptop: atur tampilan → 💾 Simpan gaya sekarang.");
  } else if (act === "del") {
    await run(env, "DELETE FROM channels WHERE id=?", id);
    await edit(env, msgId, `🗑 ${esc(ch.name || ch.ref)} dihapus dari pantauan.`);
    return "Dihapus";
  }
  await run(env, "UPDATE channels SET auto=?, per_video=?, status=?, gaya=? WHERE id=?", ch.auto, ch.per_video, ch.status, ch.gaya || "", id);
  await setKb(env, msgId, kbChannel(ch, s));
  return "Tersimpan";
}

// ============================================================================ pemantau RSS YouTube

async function checkChannel(env, ch, first = false) {
  if (ch.platform !== "youtube" || !/^UC[\w-]{22}$/.test(ch.ref)) return 0;
  let xml;
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.ref}`, { headers: { "user-agent": "Mozilla/5.0 KlipKu" } });
    if (!r.ok) throw new Error(`RSS HTTP ${r.status}`);
    xml = await r.text();
  } catch (e) {
    await run(env, "UPDATE channels SET last_check=?, last_error=? WHERE id=?", now(), String(e).slice(0, 200), ch.id);
    return 0;
  }
  const name = (xml.match(/<author>\s*<name>([^<]+)<\/name>/) || [])[1];
  if (name && (!ch.name || ch.name.startsWith("http"))) await run(env, "UPDATE channels SET name=? WHERE id=?", decodeXml(name), ch.id);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
    id: (m[1].match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1],
    title: decodeXml((m[1].match(/<title>([^<]*)<\/title>/) || [])[1] || ""),
    published: (m[1].match(/<published>([^<]+)<\/published>/) || [])[1] || "",
  })).filter((e) => e.id);
  let fresh = 0;
  const s = await settings(env);
  for (const e of entries) {
    const vid = `yt:${e.id}`;
    const ex = await one(env, "SELECT id FROM videos WHERE id=?", vid);
    if (ex) continue;
    const url = `https://www.youtube.com/watch?v=${e.id}`;
    // saat channel baru ditambahkan / data lama, video yang sudah ada tidak diproses
    const old = first || (Date.now() - Date.parse(e.published || 0)) > 3 * 86400 * 1000;
    await run(env, "INSERT INTO videos(id,channel_id,platform,url,title,published,status,found_at) VALUES(?,?,?,?,?,?,?,?)",
      vid, ch.id, "youtube", url, e.title, e.published, old ? "lama" : "baru", now());
    if (!old) { fresh++; await newVideo(env, vid, ch, s); }
  }
  await run(env, "UPDATE channels SET last_check=?, last_error=NULL WHERE id=?", now(), ch.id);
  return fresh;
}
const decodeXml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function newVideo(env, vid, ch, s) {
  const v = await one(env, "SELECT * FROM videos WHERE id=?", vid);
  const auto = ch.auto && !s.paused;
  const head = `🔔 <b>${esc(ch.name || ch.ref)}</b> ${ch.platform === "twitch" ? "selesai siaran (VOD baru)" : "punya video baru"}\n${esc(v.title || "")}\n${esc(v.url)}`;
  if (auto) {
    const msg = await say(env, `${head}\n\n🔍 Otomatis masuk antrean analisis.${laptopOnline(s) ? "" : " 💤 Laptop offline, dikerjakan saat KlipKu menyala."}`,
      [[btn("⏭ Batalkan analisis", `v:${vid}:skip`)]]);
    await run(env, "UPDATE videos SET status='antre', msg_id=? WHERE id=?", msg, vid);
    await addJob(env, "analyze", { video_id: vid, url: v.url, title: v.title, channel: ch.name || ch.ref, gaya: ch.gaya || "",
      per_video: ch.per_video || 5 }, { ref: `an:${vid}`, status_msg: msg });
  } else {
    const msg = await say(env, head, [[btn("🔍 Cari momen", `v:${vid}:an`), btn("⏭ Abaikan", `v:${vid}:skip`)]]);
    await run(env, "UPDATE videos SET msg_id=? WHERE id=?", msg, vid);
  }
}

// ============================================================================ cron (tiap 5 menit)

async function cron(env) {
  const s = await settings(env);
  if (!s.paused) {
    const chans = await all(env, "SELECT * FROM channels WHERE status='pantau' AND platform='youtube' AND (last_check IS NULL OR last_check<?) ORDER BY last_check LIMIT 20", now() - 240);
    for (const ch of chans) await checkChannel(env, ch);
  }
  // tugas macet -> kembalikan ke antrean
  await run(env, "UPDATE jobs SET status='antre', taken_at=NULL WHERE status='diambil' AND taken_at<?", now() - LEASE);
  // laptop offline padahal ada tugas
  const waiting = await one(env, "SELECT COUNT(*) n FROM jobs WHERE status='antre' AND not_before<=?", now());
  if (waiting?.n && now() - s.last_seen > 15 * 60 && (await getKV(env, "offline_note", "0")) !== "1") {
    await setKV(env, "offline_note", "1");
    await say(env, `💤 Laptop belum online, <b>${waiting.n} tugas</b> menunggu.\nNyalakan laptop & buka KlipKu supaya dikerjakan.`);
  }
  // posting terjadwal yang waktunya lewat tapi belum terupload (laptop mati)
  const late = await all(env, "SELECT id, scheduled_at FROM clips WHERE status='akan_upload' AND scheduled_at<? AND late_note IS NULL", now() - 600);
  for (const c of late) {
    await run(env, "UPDATE clips SET late_note=1 WHERE id=?", c.id);
    await say(env, `⚠️ Clip #${c.id} harusnya tayang ${fmtWhen(c.scheduled_at, s.tz)} tapi belum terkirim (laptop offline). Akan dikirim secepatnya saat laptop online.`);
  }
  // rekap harian jam 21.00
  const d = local(now(), s.tz);
  const today = dayKey(now(), s.tz);
  if (d.getUTCHours() === 21 && (await getKV(env, "recap_day", "")) !== today) {
    await setKV(env, "recap_day", today);
    await dailyRecap(env, s);
  }
}

async function dailyRecap(env, s) {
  const from = atLocalHour(now(), 0, s.tz);
  const posted = await all(env, "SELECT * FROM clips WHERE status IN ('terjadwal','terposting') AND scheduled_at>=? AND scheduled_at<?", from, from + 86400);
  const made = await one(env, "SELECT COUNT(*) n FROM clips WHERE created_at>=?", from);
  const vids = await one(env, "SELECT COUNT(*) n FROM videos WHERE found_at>=? AND status!='lama'", from);
  const backup = await one(env, "SELECT COUNT(*) n FROM clips WHERE status IN ('siap','cadangan')");
  const tomorrow = await one(env, "SELECT COUNT(*) n FROM clips WHERE status IN ('akan_upload','terjadwal') AND scheduled_at>=?", from + 86400);
  await say(env, `🌙 <b>Rekap hari ini</b>\n📺 Video baru: ${vids?.n || 0}\n🎬 Clip dibuat: ${made?.n || 0}\n📤 Tayang hari ini: ${posted.length}/${s.quota}\n🗓 Terjadwal besok+: ${tomorrow?.n || 0}\n💾 Cadangan: ${backup?.n || 0}` +
    (posted.length ? "\n\n" + posted.map((c) => `• ${fmtWhen(c.scheduled_at, s.tz)} ${esc(cut(c.caption || c.hook, 50))}${c.posted_url ? `, ${esc(c.posted_url)}` : ""}`).join("\n") : ""));
}

// ============================================================================ API untuk laptop

async function laptopApi(req, env, path) {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const s = await settings(env);
  if (path === "/api/poll") {
    const wasOff = now() - s.last_seen > 15 * 60 && s.last_seen > 0;
    // hemat kuota tulis D1: hanya tulis kalau berubah
    if (now() - s.last_seen >= 30) await setKV(env, "last_seen", now());
    if (body.host !== undefined) {
      const lap = J({ host: body.host || "", version: body.version || "", busy: body.busy || "" });
      if (lap !== J(s.laptop || {})) await setKV(env, "laptop", lap);
    }
    if (Array.isArray(body.presets) && J(body.presets.slice(0, 30)) !== J(s.presets)) await setKV(env, "presets", J(body.presets.slice(0, 30)));
    if (typeof body.upload_ok === "boolean" && body.upload_ok !== s.upload_ok) await setKV(env, "upload_ok", body.upload_ok ? "1" : "0");
    if ((await getKV(env, "offline_note", "0")) === "1" || (wasOff && body.announce)) {
      await setKV(env, "offline_note", "0");
      const n = await one(env, "SELECT COUNT(*) n FROM jobs WHERE status='antre'");
      await say(env, `💻 Laptop online lagi. ${n?.n ? `Mengerjakan ${n.n} tugas yang menunggu.` : "Tidak ada tugas yang menunggu."}`);
    }
    const twitch = await all(env, "SELECT id, ref, name FROM channels WHERE platform='twitch' AND status='pantau'");
    const resp = { ok: true, job: null, paused: s.paused, twitch: s.paused ? [] : twitch, quota: s.quota };
    if (body.want_job === false) return json(resp);
    const kinds = Array.isArray(body.kinds) ? body.kinds : null;
    const cands = await all(env, "SELECT * FROM jobs WHERE status='antre' AND not_before<=? ORDER BY prio DESC, id LIMIT 10", now());
    for (const j of cands) {
      if (kinds && !kinds.includes(j.kind)) continue;
      if (s.paused && j.kind === "analyze") continue;
      const r = await run(env, "UPDATE jobs SET status='diambil', taken_at=?, tries=tries+1 WHERE id=? AND status='antre'", now(), j.id);
      if (!r.meta.changes) continue;
      if (j.kind === "analyze") {
        const p = JSON.parse(j.payload);
        await run(env, "UPDATE videos SET status='analisis' WHERE id=?", p.video_id);
        if (j.status_msg) await edit(env, j.status_msg, `🔍 <b>Laptop mulai menganalisis</b>\n${esc(p.title || p.url)}`);
      } else if (j.kind === "render" && j.status_msg) {
        await edit(env, j.status_msg, `🎬 <b>Laptop mulai merender clip</b> (tugas #${j.id})`);
      }
      resp.job = { id: j.id, kind: j.kind, payload: JSON.parse(j.payload), tries: j.tries + 1 };
      if (j.kind === "upload") {
        const c = await one(env, "SELECT * FROM clips WHERE id=?", resp.job.payload.clip_id);
        resp.job.payload.scheduled_at = c?.scheduled_at || resp.job.payload.scheduled_at;
        resp.job.payload.file_key = c?.file_key || resp.job.payload.file_key;
      }
      break;
    }
    return json(resp);
  }
  let m = path.match(/^\/api\/job\/(\d+)\/(progress|done|fail)$/);
  if (m) {
    const j = await one(env, "SELECT * FROM jobs WHERE id=?", parseInt(m[1]));
    if (!j) return json({ ok: false, error: "tugas tidak ada" }, 404);
    const p = JSON.parse(j.payload || "{}");
    if (m[2] === "progress") {
      await run(env, "UPDATE jobs SET taken_at=? WHERE id=?", now(), j.id);
      if (j.status_msg && body.text && (!j.edited_at || now() - j.edited_at >= 20)) {
        await run(env, "UPDATE jobs SET edited_at=? WHERE id=?", now(), j.id);
        const icon = { analyze: "🔍", render: "🎬", upload: "📤" }[j.kind] || "⚙️";
        await edit(env, j.status_msg, `${icon} ${esc(body.title || p.title || "")}\n${esc(body.text)}`, j.kind === "analyze" ? null : null);
      }
      return json({ ok: true, cancel: j.status === "batal" });
    }
    if (m[2] === "fail") {
      const retry = body.retry && (body.defer || j.tries < 3);
      await run(env, "UPDATE jobs SET status=?, result=?, not_before=?, tries=? WHERE id=?", retry ? "antre" : "gagal", J({ error: body.error }),
        now() + (body.delay || 600), body.defer ? Math.max(0, j.tries - 1) : j.tries, j.id);
      if (j.kind === "analyze") await run(env, "UPDATE videos SET status=? WHERE id=?", retry ? "antre" : "gagal", p.video_id);
      if (j.kind === "render") await run(env, "UPDATE clips SET status=? WHERE id=?", retry ? "render" : "gagal", p.clip_id);
      if (j.kind === "upload" && !retry) await run(env, "UPDATE clips SET status='siap', scheduled_at=NULL WHERE id=?", p.clip_id);
      const what = { analyze: "Analisis", render: "Render", upload: "Upload", resolve: "Baca channel", recaption: "Caption baru" }[j.kind] || j.kind;
      const text = retry ? `⏳ ${what} ditunda: ${esc(cut(body.error, 300))}\nDicoba lagi ${fmtWhen(now() + (body.delay || 600), s.tz)}.`
        : `❌ <b>${what} gagal</b>${p.title ? `\n${esc(p.title)}` : ""}\n${esc(cut(body.error, 600))}`;
      if (j.status_msg) await edit(env, j.status_msg, text, retry ? null : [[btn("🔁 Coba lagi", `j:${j.id}:retry`)]]);
      else await say(env, text, retry ? null : [[btn("🔁 Coba lagi", `j:${j.id}:retry`)]]);
      return json({ ok: true });
    }
    // done
    await run(env, "UPDATE jobs SET status='selesai', result=? WHERE id=?", J(body.result || {}), j.id);
    const res = body.result || {};
    if (j.kind === "analyze") {
      await run(env, "UPDATE videos SET status='dianalisis', title=COALESCE(?, title) WHERE id=?", res.title || null, p.video_id);
      const n = res.moments || 0;
      if (j.status_msg) await edit(env, j.status_msg, n ? `✅ <b>${n} momen ditemukan</b>\n${esc(res.title || p.title || "")}\nKartu momen ada di bawah ⬇️`
        : `🤷 Tidak ada momen yang cukup bagus.\n${esc(res.title || p.title || "")}${res.note ? `\n${esc(res.note)}` : ""}`,
        n > 1 ? [[btn(`🎬 Buat semua (${n})`, `v:${p.video_id}:top`)]] : null);
    } else if (j.kind === "render") {
      if (j.status_msg) await edit(env, j.status_msg, `✅ Clip #${p.clip_id} selesai dirender ⬇️`);
    } else if (j.kind === "upload") {
      await run(env, "UPDATE clips SET status=?, post_id=?, posted_url=? WHERE id=?", res.published ? "terposting" : "terjadwal", res.post_id || "", res.url || null, p.clip_id);
      const c = await one(env, "SELECT * FROM clips WHERE id=?", p.clip_id);
      await setKb(env, c?.msg_id, []);
      await say(env, res.published ? `✅ Clip #${p.clip_id} <b>sudah tayang</b> di TikTok${res.url ? `\n${esc(res.url)}` : ""}`
        : `✅ Clip #${p.clip_id} <b>terjadwal</b> di ${esc(res.provider || "layanan upload")}: tayang ${fmtWhen(c?.scheduled_at || now(), s.tz)}`);
    } else if (j.kind === "resolve") {
      if (res.ref) {
        const dup = await one(env, "SELECT id FROM channels WHERE ref=? AND id!=?", res.ref, p.channel_id);
        if (dup) { await run(env, "DELETE FROM channels WHERE id=?", p.channel_id); await say(env, "ℹ️ Channel itu ternyata sudah dipantau."); }
        else {
          await run(env, "UPDATE channels SET ref=?, name=?, platform=? WHERE id=?", res.ref, res.name || res.ref, res.platform || "youtube", p.channel_id);
          const ch = await one(env, "SELECT * FROM channels WHERE id=?", p.channel_id);
          if (ch.platform === "youtube") await checkChannel(env, ch, true);
          await say(env, `✅ Channel terbaca: <b>${esc(res.name || res.ref)}</b>, mulai dipantau.`, kbChannel(ch, s));
        }
      }
    } else if (j.kind === "recaption") {
      if (Array.isArray(res.captions) && res.captions.length) {
        await run(env, "UPDATE clips SET captions=?, cap_pick=-1, caption=NULL WHERE id=?", J(res.captions), p.clip_id);
        const c = await one(env, "SELECT * FROM clips WHERE id=?", p.clip_id);
        if (c?.msg_id && res.text) await tg(env, "editMessageCaption", { chat_id: env.OWNER_ID, message_id: c.msg_id, caption: res.text, parse_mode: "HTML", reply_markup: kbd(kbClip(c)) });
        else if (c?.msg_id) await setKb(env, c.msg_id, kbClip(c));
      }
    }
    return json({ ok: true });
  }
  if (path === "/api/moments") {
    const v = await one(env, "SELECT * FROM videos WHERE id=?", body.video_id);
    if (!v) return json({ ok: false, error: "video tidak ada" }, 404);
    const ids = [];
    for (const x of (body.moments || []).slice(0, 15)) {
      const r = await run(env, "INSERT INTO moments(video_id,start,end,intro,skor,kategori,info,hooks,caption,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        body.video_id, x.start, x.end, x.intro ?? null, Math.round(x.skor || 0), x.kategori || "", x.info || "", J(x.hooks || []), x.caption || "", now());
      ids.push(r.meta.last_row_id);
    }
    return json({ ok: true, ids });
  }
  if (path === "/api/msgs") {   // laptop sudah mengirim media ke Telegram -> otak memasang tombol
    for (const it of body.items || []) {
      if (it.type === "moment") {
        await run(env, "UPDATE moments SET msg_id=? WHERE id=?", it.msg_id, it.id);
        const mm = await one(env, "SELECT * FROM moments WHERE id=?", it.id);
        if (mm) await setKb(env, it.msg_id, kbMoment(mm));
      } else if (it.type === "clip") {
        await run(env, "UPDATE clips SET msg_id=?, captions=?, cap_pick=-1, caption=NULL, file_key=?, duration=?, hook=COALESCE(?,hook), status='siap' WHERE id=?",
          it.msg_id, J(it.captions || []), it.file_key || null, it.duration || null, it.hook || null, it.id);
        const c = await one(env, "SELECT * FROM clips WHERE id=?", it.id);
        if (c) await setKb(env, it.msg_id, kbClip(c));
      }
    }
    return json({ ok: true });
  }
  if (path === "/api/video") {   // laptop menemukan VOD baru (Twitch)
    const ch = await one(env, "SELECT * FROM channels WHERE id=?", body.channel_id);
    if (!ch) return json({ ok: false }, 404);
    const vid = body.video_id;
    if (await one(env, "SELECT id FROM videos WHERE id=?", vid)) return json({ ok: true, known: true });
    await run(env, "INSERT INTO videos(id,channel_id,platform,url,title,published,status,found_at) VALUES(?,?,?,?,?,?,?,?)",
      vid, ch.id, ch.platform, body.url, body.title || "", body.published || "", body.old ? "lama" : "baru", now());
    if (!body.old) await newVideo(env, vid, ch, s);
    return json({ ok: true });
  }
  if (path === "/api/posted") {   // laptop memastikan clip sudah tayang
    await run(env, "UPDATE clips SET status='terposting', posted_url=? WHERE id=?", body.url || null, body.clip_id);
    if (body.notify !== false) await say(env, `🎉 Clip #${body.clip_id} sudah tayang di TikTok${body.url ? `\n${esc(body.url)}` : ""}`);
    return json({ ok: true });
  }
  if (path === "/api/state") {
    return json({ ok: true, settings: s, status: await statusText(env),
      taste: await all(env, "SELECT caption, how FROM taste ORDER BY id DESC LIMIT 12"),
      channels: await all(env, "SELECT * FROM channels ORDER BY id"),
      scheduled: await all(env, "SELECT id, scheduled_at, status, post_id FROM clips WHERE status IN ('terjadwal','akan_upload') ORDER BY scheduled_at") });
  }
  if (path === "/api/notify") { await say(env, String(body.text || "").slice(0, 3500)); return json({ ok: true }); }
  return json({ ok: false, error: "tidak dikenal" }, 404);
}

// ============================================================================ entry

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/" || path === "/sehat") return new Response(`KlipKu Otak v${VERSI} OK`, { status: 200 });
    if (path === "/tg" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TG_SECRET) return new Response("forbidden", { status: 403 });
      const upd = await req.json().catch(() => ({}));
      const from = upd.message?.from?.id || upd.callback_query?.from?.id || upd.edited_message?.from?.id;
      if (String(from) !== String(env.OWNER_ID)) {
        const chat = upd.message?.chat?.id;
        if (chat) await tg(env, "sendMessage", { chat_id: chat, text: "🔒 Ini bot pribadi." });
        return new Response("ok");
      }
      try {
        if (upd.callback_query) await onCallback(env, upd.callback_query);
        else if (upd.message) await onMessage(env, upd.message);
      } catch (e) { console.log("update error", String(e && e.stack || e)); await say(env, "⚠️ Error di otak: " + esc(String(e).slice(0, 300))); }
      return new Response("ok");
    }
    if (path.startsWith("/api/")) {
      if (req.headers.get("authorization") !== `Bearer ${env.WORKER_KEY}`) return json({ ok: false, error: "kunci salah" }, 401);
      try { return await laptopApi(req, env, path); }
      catch (e) { console.log("api error", String(e && e.stack || e)); return json({ ok: false, error: String(e) }, 500); }
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env)); },
};
