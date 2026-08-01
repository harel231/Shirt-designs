import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository-relative root of the server package. */
export const SERVER_ROOT = resolve(here, '..', '..');

/** Checked-in data that ships with the server (font catalog, shirt templates). */
export const BUNDLED_DATA_DIR = join(SERVER_ROOT, 'data');
export const CATALOG_PATH = join(BUNDLED_DATA_DIR, 'google-fonts-catalog.json');

/**
 * Mutable state. Overridable so tests (and multi-tenant deployments) can point
 * at a scratch directory instead of the checked-out tree.
 */
export const STORAGE_ROOT = resolve(
  process.env.SHIRT_DATA_DIR ?? join(SERVER_ROOT, 'data', 'storage'),
);

export const DB_PATH = join(STORAGE_ROOT, 'db.json');
export const UPLOADS_DIR = join(STORAGE_ROOT, 'uploads');
export const ASSETS_DIR = join(STORAGE_ROOT, 'assets');
export const SHIRTS_DIR = join(STORAGE_ROOT, 'shirts');
export const EXPORTS_DIR = join(STORAGE_ROOT, 'exports');
export const FONT_CACHE_DIR = join(STORAGE_ROOT, 'fonts');

export function ensureStorage() {
  for (const dir of [
    STORAGE_ROOT,
    UPLOADS_DIR,
    ASSETS_DIR,
    SHIRTS_DIR,
    EXPORTS_DIR,
    FONT_CACHE_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
