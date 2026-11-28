-- KlipKu Otak (Cloudflare D1). Aman dijalankan berulang.
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,           -- youtube | twitch
  ref TEXT NOT NULL UNIQUE,         -- youtube: UC... ; twitch: login ; atau 'url:...' kalau belum terbaca
  name TEXT, url TEXT,
  gaya TEXT DEFAULT '',             -- nama Gaya tersimpan KlipKu ('' = pengaturan terakhir)
  auto INTEGER DEFAULT 1,           -- 1 = video baru langsung dianalisis
  per_video INTEGER DEFAULT 5,      -- maks kandidat momen per video
  status TEXT DEFAULT 'pantau',     -- pantau | pause
  added_at INTEGER, last_check INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,              -- 'yt:<id>' / 'tw:<id>'
  channel_id INTEGER, platform TEXT, url TEXT, title TEXT, published TEXT,
  status TEXT DEFAULT 'baru',       -- lama | baru | antre | analisis | dianalisis | diabaikan | gagal
  found_at INTEGER, msg_id INTEGER
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT, start REAL, end REAL, intro REAL, skor INTEGER, kategori TEXT,
  info TEXT, hooks TEXT, caption TEXT,
  status TEXT DEFAULT 'kandidat',   -- kandidat | dibuat | dilewati
  msg_id INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id INTEGER, video_id TEXT, url TEXT, start REAL, end REAL, intro REAL, hook TEXT,
  captions TEXT, caption TEXT, cap_pick INTEGER DEFAULT -1, when_pref TEXT DEFAULT 'jam_ramai',
  status TEXT DEFAULT 'render',     -- render | siap | akan_upload | terjadwal | terposting | cadangan | dibuang | gagal
  msg_id INTEGER, file_key TEXT, duration REAL,
  created_at INTEGER, scheduled_at INTEGER, post_id TEXT, posted_url TEXT, parent_id INTEGER, late_note INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, payload TEXT, prio INTEGER DEFAULT 0,
  status TEXT DEFAULT 'antre',      -- antre | diambil | selesai | gagal | batal
  not_before INTEGER DEFAULT 0, taken_at INTEGER, tries INTEGER DEFAULT 0,
  result TEXT, created_at INTEGER, ref TEXT, status_msg INTEGER, edited_at INTEGER
);
CREATE TABLE IF NOT EXISTS taste (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, caption TEXT, how TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, not_before);
CREATE INDEX IF NOT EXISTS clips_status ON clips(status, scheduled_at);
CREATE INDEX IF NOT EXISTS videos_channel ON videos(channel_id);
