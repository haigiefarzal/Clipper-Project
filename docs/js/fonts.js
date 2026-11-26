// Daftar font bawaan KlipKu (SIL OFL 1.1) + font yang di-upload pengguna.
const BUILTIN = [
  ['Anton', 'Anton-Regular.ttf'],
  ['Archivo Black', 'ArchivoBlack-Regular.ttf'],
  ['Montserrat Black', 'Montserrat-Black.ttf'],
  ['Montserrat ExtraBold', 'Montserrat-ExtraBold.ttf'],
  ['Poppins Bold', 'Poppins-Bold.ttf'],
  ['Inter Black', 'Inter-Black.otf'],
  ['Inter Display Black', 'InterDisplay-Black.otf'],
  ['Roboto Black', 'Roboto-Black.ttf'],
  ['Roboto Condensed Black', 'RobotoCondensed-Black.ttf'],
  ['Open Sans ExtraBold', 'OpenSans-ExtraBold.ttf'],
  ['Open Sans Condensed ExtraBold', 'OpenSansCondensed-ExtraBold.ttf'],
  ['Fira Sans Black', 'FiraSans-Black.ttf'],
  ['Fira Sans ExtraBold', 'FiraSans-ExtraBold.ttf'],
  ['DM Sans Black', 'DMSans-Black.ttf'],
  ['Source Sans 3 Black', 'SourceSans3-Black.ttf'],
  ['Bitter Black', 'Bitter-Black.ttf'],
  ['Lora Bold', 'Lora-Bold.ttf'],
  ['Gelasio Bold', 'Gelasio-Bold.ttf'],
  ['Crimson Text Bold', 'CrimsonText-Bold.ttf'],
  ['Comic Relief Bold', 'ComicRelief-Bold.ttf'],
  ['Anonymous Pro Bold', 'AnonymousPro-Bold.ttf'],
];

const FONTS = new Map();
for (const [name, file] of BUILTIN) {
  const id = file.replace(/\.(ttf|otf)$/i, '').toLowerCase();
  FONTS.set(id, { id, name, family: 'kk-' + id, url: 'fonts/' + file, group: 'Bawaan KlipKu', face: null });
}

export const DEFAULT_FONT = 'montserrat-black';

export function listFonts() {
  return [...FONTS.values()];
}

export function getFont(id) {
  return FONTS.get(id) || FONTS.get(DEFAULT_FONT);
}

/** Pastikan font sudah termuat sebelum dipakai menggambar di canvas. */
export async function ensureFont(id) {
  const f = getFont(id);
  if (!f.face) {
    f.face = new FontFace(f.family, f.buffer ? f.buffer : `url("${f.url}")`);
    f.loading = f.face.load().then((face) => { document.fonts.add(face); return face; })
      .catch((e) => { f.face = null; throw new Error(`Font ${f.name} gagal dimuat: ${e.message}`); });
  }
  await f.loading;
  return f;
}

/** Tambah font dari file .ttf/.otf/.woff/.woff2 milik pengguna. */
export async function addUserFont(file) {
  const buffer = await file.arrayBuffer();
  const base = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
  const id = 'user-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entry = { id, name: base.replace(/[-_]+/g, ' '), family: 'kk-' + id, buffer, group: 'Font kamu', face: null };
  FONTS.set(id, entry);
  await ensureFont(id);
  return entry;
}

/** CSS font string untuk canvas. */
export function cssFont(id, px) {
  return `${Math.max(1, px).toFixed(1)}px "${getFont(id).family}", "Arial Black", Impact, sans-serif`;
}
