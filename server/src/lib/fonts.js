import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CATALOG_PATH, FONT_CACHE_DIR } from './paths.js';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

/**
 * Google Fonts access.
 *
 * The full 1,900+ family catalog ships with the server (see
 * scripts/build-font-catalog.js) so browsing and searching never needs the
 * network. Actual font binaries are fetched from Google on first use and
 * cached on disk, because a font file is only needed once a family is
 * genuinely used in a design.
 */

const GOOGLE_CSS_ENDPOINT = 'https://fonts.googleapis.com/css2';
// Google serves woff2 to modern browsers and TrueType to anything older.
// opentype.js only reads TTF/OTF, so we ask for the older format directly and
// keep a woff2 decompressor around in case Google changes its mind.
const TTF_USER_AGENT = 'Mozilla/5.0';

let catalog = null;
const fontCache = new Map();
const inFlight = new Map();

export function loadCatalog() {
  if (catalog) return catalog;
  if (!existsSync(CATALOG_PATH)) {
    catalog = { source: 'empty', generatedAt: null, families: [] };
    return catalog;
  }
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  catalog.index = new Map(catalog.families.map((font) => [font.family.toLowerCase(), font]));
  return catalog;
}

export function findFamily(family) {
  return loadCatalog().index?.get(String(family ?? '').toLowerCase());
}

export function searchFonts({ query = '', category = '', subset = '', limit = 50, offset = 0 }) {
  const { families } = loadCatalog();
  const q = query.trim().toLowerCase();

  const matches = families.filter((font) => {
    if (q && !font.family.toLowerCase().includes(q)) return false;
    if (category && font.category !== category) return false;
    if (subset && !font.subsets.includes(subset)) return false;
    return true;
  });

  // Exact-prefix matches first so typing "rob" surfaces Roboto immediately.
  if (q) {
    matches.sort((a, b) => {
      const aStarts = a.family.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.family.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.family.localeCompare(b.family);
    });
  }

  return {
    total: matches.length,
    items: matches.slice(offset, offset + limit).map((font) => ({
      family: font.family,
      category: font.category,
      subsets: font.subsets,
      weights: availableWeights(font),
      hasItalic: font.variants.some((v) => v.includes('italic')),
    })),
  };
}

export function availableWeights(font) {
  const weights = new Set();
  for (const variant of font.variants) {
    if (variant === 'regular' || variant === 'italic') weights.add(400);
    else {
      const weight = Number.parseInt(variant, 10);
      if (Number.isFinite(weight)) weights.add(weight);
    }
  }
  return [...weights].sort((a, b) => a - b);
}

/** Snaps a requested weight/style onto something the family actually ships. */
export function resolveVariant(font, weight = 400, italic = false) {
  const weights = availableWeights(font);
  const target = Number.isFinite(weight) ? weight : 400;
  const closest = weights.length
    ? weights.reduce((best, w) => (Math.abs(w - target) < Math.abs(best - target) ? w : best))
    : 400;
  const wantsItalic = italic && font.variants.some((v) => v.includes('italic'));
  return { weight: closest, italic: wantsItalic };
}

function cacheKey(family, weight, italic) {
  return `${family.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${weight}${italic ? 'i' : ''}`;
}

async function downloadFont(family, weight, italic) {
  const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
  const url = `${GOOGLE_CSS_ENDPOINT}?family=${encodeURIComponent(family)}:${axis}`;
  const cssRes = await fetch(url, { headers: { 'User-Agent': TTF_USER_AGENT } });
  if (!cssRes.ok) {
    throw Object.assign(new Error(`Google Fonts has no "${family}" ${weight}${italic ? ' italic' : ''}`), {
      status: 404,
    });
  }

  const css = await cssRes.text();
  const srcUrls = [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
  if (srcUrls.length === 0) throw new Error(`No font file in Google's response for "${family}"`);

  // Prefer a format opentype.js reads natively.
  const preferred =
    srcUrls.find((u) => /\.ttf($|\?)/.test(u)) ?? srcUrls.find((u) => /\.otf($|\?)/.test(u)) ?? srcUrls[0];

  const fileRes = await fetch(preferred, { headers: { 'User-Agent': TTF_USER_AGENT } });
  if (!fileRes.ok) throw new Error(`Downloading ${family} failed with ${fileRes.status}`);
  let bytes = Buffer.from(await fileRes.arrayBuffer());

  if (bytes.length > 4 && bytes.toString('ascii', 0, 4) === 'wOF2') {
    const { decompress } = await import('wawoff2');
    bytes = Buffer.from(await decompress(bytes));
  }

  return bytes;
}

/**
 * Returns the raw TTF bytes for a family/weight/style, fetching from Google on
 * a cache miss. Concurrent requests for the same font share one download.
 */
export async function fetchFontBytes(family, weight = 400, italic = false) {
  const key = cacheKey(family, weight, italic);
  const file = join(FONT_CACHE_DIR, `${key}.ttf`);

  if (existsSync(file)) return readFile(file);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const bytes = await downloadFont(family, weight, italic);
    await mkdir(FONT_CACHE_DIR, { recursive: true });
    await writeFile(file, bytes);
    return bytes;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/**
 * @returns {Promise<{font: object, family: string, weight: number, italic: boolean, file: string}>}
 */
export async function loadFont(family, { weight = 400, italic = false } = {}) {
  const known = findFamily(family);
  const resolved = known
    ? resolveVariant(known, weight, italic)
    : { weight: Number.isFinite(weight) ? weight : 400, italic: Boolean(italic) };
  const name = known?.family ?? family;
  const key = cacheKey(name, resolved.weight, resolved.italic);

  if (fontCache.has(key)) return fontCache.get(key);

  const bytes = await fetchFontBytes(name, resolved.weight, resolved.italic);
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const entry = {
    font,
    family: name,
    weight: resolved.weight,
    italic: resolved.italic,
    file: join(FONT_CACHE_DIR, `${key}.ttf`),
  };
  fontCache.set(key, entry);
  return entry;
}

/** Fonts already on disk — the picker marks these as instantly usable offline. */
export function cachedFamilies() {
  return [...fontCache.values()].map(({ family, weight, italic }) => ({ family, weight, italic }));
}

export { opentype };
