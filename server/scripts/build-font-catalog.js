#!/usr/bin/env node
/**
 * Regenerates the bundled Google Fonts catalog.
 *
 * The catalog ships with the server so the font picker works with zero network
 * access. `npm run fonts:sync` refreshes it, preferring the live Google Fonts
 * Developer API (set GOOGLE_FONTS_API_KEY) and falling back to the snapshot
 * that ships inside the `google-font-metadata` dev dependency.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG_PATH, SERVER_ROOT } from '../src/lib/paths.js';

function compact(families) {
  return families
    .map((font) => ({
      family: font.family,
      category: font.category ?? 'sans-serif',
      variants: font.variants ?? ['regular'],
      subsets: font.subsets ?? ['latin'],
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

async function fromApi(key) {
  const url = `https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Fonts API responded ${res.status}`);
  const body = await res.json();
  return compact(body.items ?? []);
}

function fromSnapshot() {
  // The package blocks subpath exports, so read the shipped JSON off disk.
  for (const base of [join(SERVER_ROOT, 'node_modules'), join(SERVER_ROOT, '..', 'node_modules')]) {
    const file = join(base, 'google-font-metadata', 'data', 'api-response.json');
    if (existsSync(file)) return compact(JSON.parse(readFileSync(file, 'utf8')));
  }
  throw new Error('google-font-metadata is not installed; run `npm install` first.');
}

const key = process.env.GOOGLE_FONTS_API_KEY;
let families;
let source;

if (key) {
  try {
    families = await fromApi(key);
    source = 'google-fonts-developer-api';
  } catch (err) {
    console.warn(`Live API fetch failed (${err.message}); using bundled snapshot.`);
  }
}

if (!families) {
  families = fromSnapshot();
  source = 'google-font-metadata-snapshot';
}

const catalog = { source, generatedAt: new Date().toISOString(), families };
await writeFile(CATALOG_PATH, `${JSON.stringify(catalog)}\n`);
console.log(`Wrote ${families.length} families to ${CATALOG_PATH} (source: ${source}).`);
