/**
 * Appearance.
 *
 * The studio opens light whatever the phone is set to. Artwork is judged
 * against white far more often than against black, and a screen printer's
 * proof is a white page — a phone that happens to be in dark mode is not a
 * reason to show the design canvas dark. Following the device is still one of
 * the three choices here; it just isn't the assumed one.
 *
 * The resolved theme is stamped on <html> as `data-theme`, which is the only
 * thing the stylesheet looks at. index.html applies the stored choice inline
 * before first paint so the app never flashes the wrong theme; this module
 * owns everything after that.
 */

export const THEME_STORAGE_KEY = 'shirt-designs.theme';

export const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match device' },
];

const DEFAULT_PREFERENCE = 'light';

/** Browser chrome colour per theme, kept in step with the app background. */
const BAR_COLOR = { light: '#f4f5f8', dark: '#101116' };

/** Anything unrecognised — a stale value, a hand-edited store — reads as the default. */
export function normalizePreference(value) {
  return THEME_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_PREFERENCE;
}

/** The theme a preference actually resolves to, given what the device asks for. */
export function resolveTheme(preference, prefersDark = false) {
  const normalized = normalizePreference(preference);
  if (normalized === 'system') return prefersDark ? 'dark' : 'light';
  return normalized;
}

const darkQuery =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(prefers-color-scheme: dark)')
    : null;

function readStored() {
  // Safari in private mode throws on localStorage rather than returning null.
  try {
    return globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

let preference = normalizePreference(readStored());

export function getThemePreference() {
  return preference;
}

export function getTheme() {
  return resolveTheme(preference, darkQuery?.matches ?? false);
}

export function setThemePreference(value) {
  preference = normalizePreference(value);
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A choice that cannot be stored still applies for this session.
  }
  applyTheme();
  return preference;
}

function applyTheme() {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[theme]);
}

export function initTheme() {
  // "Match device" is a live setting, not a one-off reading: a phone can flip
  // to dark at sunset with the studio still open.
  darkQuery?.addEventListener('change', () => {
    if (preference === 'system') applyTheme();
  });
  applyTheme();
}
