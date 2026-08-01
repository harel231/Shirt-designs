import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasRtl,
  needsShaping,
  normalizeDirection,
  resolveDirection,
  scriptHint,
  toVisualLine,
  toVisualOrder,
} from '../src/lib/bidi.js';

/**
 * Logical order is what you type; visual order is what the pen draws, left to
 * right. These read as "typed this, must be drawn like that".
 */

const SHALOM = 'שלום'; // ש ל ו ם — drawn ם ו ל ש
const SHALOM_VISUAL = 'םולש';

describe('paragraph direction', () => {
  it('takes the first strong character', () => {
    assert.equal(resolveDirection(SHALOM), 'rtl');
    assert.equal(resolveDirection('Hello'), 'ltr');
    assert.equal(resolveDirection(`Hello ${SHALOM}`), 'ltr');
    assert.equal(resolveDirection(`${SHALOM} Hello`), 'rtl');
  });

  it('ignores anything that is not a letter when deciding', () => {
    assert.equal(resolveDirection(`"'( 1994 ${SHALOM}`), 'rtl');
    assert.equal(resolveDirection('1994'), 'ltr');
    assert.equal(resolveDirection('   '), 'ltr');
    assert.equal(resolveDirection(''), 'ltr');
  });

  it('lets an explicit choice win over the text', () => {
    assert.equal(resolveDirection('Hello', 'rtl'), 'rtl');
    assert.equal(resolveDirection(SHALOM, 'ltr'), 'ltr');
    assert.equal(resolveDirection(SHALOM, 'auto'), 'rtl');
  });

  it('treats an unknown preference as auto', () => {
    assert.equal(normalizeDirection('sideways'), 'auto');
    assert.equal(normalizeDirection(undefined), 'auto');
    assert.equal(resolveDirection(SHALOM, 'sideways'), 'rtl');
  });
});

describe('reordering a line for the pen', () => {
  it('draws a Hebrew word right to left', () => {
    assert.equal(toVisualLine(SHALOM, 'rtl'), SHALOM_VISUAL);
  });

  it('leaves a Latin line exactly as typed', () => {
    assert.equal(toVisualLine('BROOKLYN ATHLETIC', 'ltr'), 'BROOKLYN ATHLETIC');
    // Nothing to reorder means nothing is touched at all.
    assert.equal(toVisualLine('BROOKLYN', 'rtl'), 'BROOKLYN');
  });

  it('keeps two Hebrew words in reading order, right to left', () => {
    // "שלום עולם" reads shalom-then-olam; drawn, olam comes first from the left.
    assert.equal(toVisualLine('שלום עולם', 'rtl'), 'םלוע םולש');
  });

  it('keeps digits running left to right inside a Hebrew line', () => {
    // The year must not come out as "4991".
    const visual = toVisualLine(`${SHALOM} 1994`, 'rtl');
    assert.equal(visual, `1994 ${SHALOM_VISUAL}`);
    assert.ok(visual.includes('1994'));
  });

  it('keeps a Latin brand name readable inside a Hebrew line', () => {
    const visual = toVisualLine(`${SHALOM} Brooklyn`, 'rtl');
    assert.equal(visual, `Brooklyn ${SHALOM_VISUAL}`);
  });

  it('reverses a Hebrew phrase embedded in an English line', () => {
    assert.equal(toVisualLine(`We say ${SHALOM} here`, 'ltr'), `We say ${SHALOM_VISUAL} here`);
  });

  it('mirrors brackets so they still open towards the reader', () => {
    assert.equal(toVisualLine(`(${SHALOM})`, 'rtl'), `(${SHALOM_VISUAL})`);
    assert.equal(toVisualLine(`[${SHALOM}]`, 'rtl'), `[${SHALOM_VISUAL}]`);
  });

  it('hands trailing punctuation to the paragraph direction', () => {
    // The full stop belongs at the visual left of an RTL line, not the right.
    assert.equal(toVisualLine(`${SHALOM}.`, 'rtl'), `.${SHALOM_VISUAL}`);
  });

  it('keeps a vowel point attached to the letter it belongs to', () => {
    // Shin + sheva: the mark must stay immediately after its base so it is
    // drawn over that letter rather than over its neighbour.
    const withMark = 'שְׁלום';
    const visual = toVisualLine(withMark, 'rtl');
    assert.equal(visual.indexOf('ְ'), visual.indexOf('ש') + 1);
    assert.equal([...visual].length, [...withMark].length);
  });
});

describe('reordering a whole block', () => {
  it('uses one direction for every line', () => {
    // Line two starts with a Latin word but belongs to a Hebrew block, so it
    // must not flip to left-to-right on its own.
    const block = `${SHALOM}\nBrooklyn ${SHALOM}`;
    assert.equal(toVisualOrder(block), `${SHALOM_VISUAL}\n${SHALOM_VISUAL} Brooklyn`);
  });

  it('leaves an English block alone', () => {
    assert.equal(toVisualOrder('BROOKLYN\nATHLETIC CLUB'), 'BROOKLYN\nATHLETIC CLUB');
  });

  it('honours a forced direction across the block', () => {
    // The line starts with a Latin word, so auto reads it left to right and
    // the Hebrew sits at the end. Forcing RTL moves the Hebrew to the right of
    // the line — which is the whole point of having the override.
    assert.equal(toVisualOrder(`Hello ${SHALOM}`), `Hello ${SHALOM_VISUAL}`);
    assert.equal(toVisualOrder(`Hello ${SHALOM}`, 'rtl'), `${SHALOM_VISUAL} Hello`);
  });

  it('leaves a single left-to-right run alone even in an RTL block', () => {
    // Nothing to reorder: "one two" is still "one two", it just sits on the
    // right of the line. Reversing the words here would be a bug.
    assert.equal(toVisualOrder('one two', 'rtl'), 'one two');
  });
});

describe('what the text needs from a font', () => {
  it('spots right-to-left text', () => {
    assert.equal(hasRtl(SHALOM), true);
    assert.equal(hasRtl('مرحبا'), true);
    assert.equal(hasRtl('Brooklyn'), false);
  });

  it('names the subset that can draw it', () => {
    assert.equal(scriptHint(SHALOM), 'hebrew');
    assert.equal(scriptHint('مرحبا'), 'arabic');
    assert.equal(scriptHint('Brooklyn'), null);
  });

  it('flags the script this outliner reorders but cannot join', () => {
    assert.equal(needsShaping('مرحبا'), true);
    assert.equal(needsShaping(SHALOM), false);
  });
});
