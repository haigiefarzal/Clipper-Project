// Penyimpanan file milik pengguna di browser ini (IndexedDB): sound effect, musik, logo, banner, font.
// Tidak ada yang dikirim ke server.
const DB = 'klipku-web', STORE = 'files';
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Penyimpanan browser penuh.'));
  });
}

export const putFile = (rec) => tx('readwrite', (s) => s.put(rec));
export const delFile = (id) => tx('readwrite', (s) => s.delete(id));
export const getFile = async (id) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
};
export const listFiles = async (kind) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => resolve((r.result || []).filter((x) => x.kind === kind).sort((a, b) => a.name.localeCompare(b.name)));
    r.onerror = () => reject(r.error);
  });
};

/** Minta browser supaya file tidak dihapus otomatis saat memori penuh. */
export function keepStorage() {
  try { navigator.storage?.persist?.(); } catch { /* abaikan */ }
}
