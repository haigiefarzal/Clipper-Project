// Daftar font bawaan KlipKu (SIL OFL 1.1) + font yang ditambahkan pengguna.
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
  FONTS.set(id, { id, name, family: 'kk-' + id, url: 'fonts/' + file, group: 'Bawaan', face: null });
}

export const DEFAULT_FONT = 'montserrat-black';

export const listFonts = () => [...FONTS.values()];
export const getFont = (id) => FONTS.get(id) || FONTS.get(DEFAULT_FONT);

/** Pastikan font sudah termuat sebelum dipakai menggambar di canvas. */
export async function ensureFont(id) {
  const f = getFont(id);
  if (!f.face) {
    f.face = new FontFace(f.family, f.buffer ? f.buffer : `url("${f.url}")`);
    f.loading = f.face.load().then((face) => { document.fonts.add(face); measure(f); return face; })
      .catch((e) => { f.face = null; throw new Error(`Font ${f.name} gagal dimuat: ${e.message}`); });
  }
  await f.loading;
  return f;
}

// tinggi huruf kapital (cap) relatif ukuran em, dipakai tata letak judul hook
let mctx = null;
function measure(f) {
  mctx ??= document.createElement('canvas').getContext('2d');
  mctx.font = `100px "${f.family}"`;
  const m = mctx.measureText('H');
  const cap = m.actualBoundingBoxAscent / 100;
  f.cap = cap > 0.4 && cap < 1 ? cap : 0.7;
  const avg = mctx.measureText('ABCDEFGHIJKLMNOPRSTUWY').width / 22 / 100;
  f.aw = avg > 0.2 && avg < 1.5 ? avg : 0.65;
}

/** Tambah font dari file .ttf/.otf/.woff/.woff2. */
export async function addUserFont(name, buffer) {
  const base = name.replace(/\.(ttf|otf|woff2?)$/i, '');
  const id = 'user-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  FONTS.set(id, { id, name: base.replace(/[-_]+/g, ' '), family: 'kk-' + id, buffer, group: 'Font kamu', face: null });
  await ensureFont(id);
  return getFont(id);
}

/** CSS font untuk canvas. */
export function cssFont(id, px) {
  return `${Math.max(1, px).toFixed(1)}px "${getFont(id).family}", "Arial Black", Impact, sans-serif`;
}
