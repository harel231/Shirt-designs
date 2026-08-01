/**
 * Right-to-left type.
 *
 * The outliner draws glyphs left to right along a baseline, one after the
 * next. Hebrew — like any RTL script — is *stored* in the order it is read but
 * has to be *drawn* the other way round, and a line is rarely purely one
 * direction: a Hebrew sentence carries Latin brand names and Western digits
 * that still run left to right inside it.
 *
 * So before anything is measured, a line is rewritten from logical order into
 * visual order: the exact sequence of characters, left to right, that the pen
 * should lay down. Everything downstream — kerning, letter spacing, arching —
 * then works unchanged, because by that point the line really is left to right.
 *
 * This is the Unicode bidirectional algorithm (UAX #9) reduced to what shirt
 * artwork needs: one paragraph direction per text block, strong characters,
 * neutrals resolved by their surroundings, and mirrored brackets. Explicit
 * embedding controls (RLE/LRO and friends) are not interpreted — they do not
 * survive a phone keyboard, and treating them as invisible neutrals is closer
 * to right than pretending they are letters.
 *
 * Note on Arabic: reordering is only half of what that script needs — its
 * letters also change shape depending on their neighbours, which is a shaping
 * engine's job and not something opentype.js does for us. Arabic text comes
 * out in the right order but in isolated forms, so the text tool warns rather
 * than quietly producing a wrong shirt.
 */

/**
 * Scripts written right to left. Deliberately a list of scripts rather than a
 * range soup: this is the set the reordering below claims to handle.
 */
const RTL_SCRIPT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

/**
 * Anything else that pins a direction. Digits count: "1994" inside a Hebrew
 * line still reads left to right, which is exactly how a left-to-right run
 * behaves here.
 */
const STRONG_LTR = /[\p{Letter}\p{Number}]/u;

/** Combining marks belong to the character before them and never reorder alone. */
const COMBINING_MARK = /\p{Mark}/u;

const HEBREW = /\p{Script=Hebrew}/u;
const ARABIC = /\p{Script=Arabic}/u;

/**
 * Brackets and quotes that point the other way in an RTL run: an opening
 * parenthesis still has to open towards the reader.
 */
const MIRRORED = new Map(
  Object.entries({
    '(': ')',
    ')': '(',
    '[': ']',
    ']': '[',
    '{': '}',
    '}': '{',
    '<': '>',
    '>': '<',
    '«': '»',
    '»': '«',
    '‹': '›',
    '›': '‹',
  }),
);

export const DIRECTIONS = ['auto', 'ltr', 'rtl'];

/** Anything unrecognised means "work it out from the text". */
export function normalizeDirection(value) {
  return DIRECTIONS.includes(value) ? value : 'auto';
}

export function hasRtl(text) {
  return RTL_SCRIPT.test(String(text ?? ''));
}

/**
 * The font subset a piece of text needs, for filtering the font picker down to
 * families that can actually render it. Null when plain Latin will do.
 */
export function scriptHint(text) {
  const value = String(text ?? '');
  if (HEBREW.test(value)) return 'hebrew';
  if (ARABIC.test(value)) return 'arabic';
  return null;
}

/** True for text this outliner reorders correctly but cannot shape correctly. */
export function needsShaping(text) {
  return ARABIC.test(String(text ?? ''));
}

/**
 * The paragraph direction: an explicit choice, or UAX #9's P2/P3 — the first
 * strong character decides, and text with no strong character reads as LTR.
 */
export function resolveDirection(text, preference = 'auto') {
  const chosen = normalizeDirection(preference);
  if (chosen !== 'auto') return chosen;

  for (const char of String(text ?? '')) {
    if (RTL_SCRIPT.test(char)) return 'rtl';
    if (/\p{Letter}/u.test(char)) return 'ltr';
  }
  return 'ltr';
}

/**
 * One line, rewritten from logical order into the order the pen draws it.
 * `base` is the resolved paragraph direction — pass the whole block's, so a
 * Hebrew paragraph does not flip direction on the one line that happens to
 * start with a Latin word.
 */
export function toVisualLine(line, base = 'ltr') {
  const text = String(line ?? '');
  if (base !== 'rtl' && !RTL_SCRIPT.test(text)) return text;

  const clusters = toClusters(text);
  if (clusters.length === 0) return text;

  const types = resolveNeutrals(clusters, base);
  return orderRuns(clusters, types, base);
}

/** Every line of a block, using one direction for the block. */
export function toVisualOrder(text, preference = 'auto') {
  const base = resolveDirection(text, preference);
  return String(text ?? '')
    .split('\n')
    .map((line) => toVisualLine(line, base))
    .join('\n');
}

/** A base character plus the combining marks that hang off it, kept as one unit. */
function toClusters(text) {
  const clusters = [];
  for (const char of text) {
    const previous = clusters[clusters.length - 1];
    if (previous && COMBINING_MARK.test(char)) {
      previous.text += char;
      continue;
    }
    clusters.push({ text: char, type: classify(char) });
  }
  return clusters;
}

function classify(char) {
  if (RTL_SCRIPT.test(char)) return 'rtl';
  if (STRONG_LTR.test(char)) return 'ltr';
  return 'neutral';
}

/**
 * UAX #9 N1/N2: spaces and punctuation between two runs of the same direction
 * join that direction; anything else — including at the ends of the line —
 * falls back to the paragraph direction.
 */
function resolveNeutrals(clusters, base) {
  const types = clusters.map((cluster) => cluster.type);

  for (let i = 0; i < types.length; i += 1) {
    if (types[i] !== 'neutral') continue;

    let end = i;
    while (end + 1 < types.length && types[end + 1] === 'neutral') end += 1;

    // Everything before i is already resolved, so this reads a real direction.
    const before = i > 0 ? types[i - 1] : base;
    const after = end + 1 < types.length ? types[end + 1] : base;
    const resolved = before === after ? before : base;

    for (let j = i; j <= end; j += 1) types[j] = resolved;
    i = end;
  }

  return types;
}

/**
 * Runs of one direction, laid out left to right. In an RTL paragraph the runs
 * themselves run backwards; inside any RTL run, so do the characters.
 */
function orderRuns(clusters, types, base) {
  const runs = [];
  clusters.forEach((cluster, index) => {
    const last = runs[runs.length - 1];
    if (last && last.type === types[index]) last.items.push(cluster);
    else runs.push({ type: types[index], items: [cluster] });
  });

  const ordered = base === 'rtl' ? [...runs].reverse() : runs;

  return ordered
    .map((run) => {
      const items = run.type === 'rtl' ? [...run.items].reverse() : run.items;
      return items.map((item) => (run.type === 'rtl' ? mirror(item.text) : item.text)).join('');
    })
    .join('');
}

/** Mirrors a cluster's base character, leaving any combining marks alone. */
function mirror(text) {
  const [base, ...rest] = text;
  return (MIRRORED.get(base) ?? base) + rest.join('');
}
