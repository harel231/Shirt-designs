import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePreference, resolveTheme, THEME_OPTIONS } from '../js/theme.js';

describe('appearance preference', () => {
  it('offers light, dark and following the device', () => {
    assert.deepEqual(THEME_OPTIONS.map((option) => option.value), ['light', 'dark', 'system']);
  });

  it('defaults to light, not to whatever the phone is set to', () => {
    assert.equal(normalizePreference(null), 'light');
    assert.equal(normalizePreference(undefined), 'light');
    assert.equal(normalizePreference(''), 'light');
    assert.equal(resolveTheme(null, true), 'light');
  });

  it('keeps a stored choice', () => {
    assert.equal(normalizePreference('dark'), 'dark');
    assert.equal(normalizePreference('system'), 'system');
  });

  it('ignores a value that is not a theme', () => {
    assert.equal(normalizePreference('midnight'), 'light');
    assert.equal(resolveTheme('midnight', true), 'light');
  });
});

describe('resolving a preference to a theme', () => {
  it('holds an explicit choice against the device', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
  });

  it('follows the device only when asked to', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('treats an unknown device state as light', () => {
    assert.equal(resolveTheme('system'), 'light');
  });
});
