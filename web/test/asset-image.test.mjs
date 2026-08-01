import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPdfAsset, previewScale } from '../js/asset-image.js';

describe('pdf preview scaling', () => {
  it('renders a page at its own size when that is already a sensible preview', () => {
    assert.equal(previewScale(800, 600), 1400 / 800);
    assert.ok(previewScale(1400, 1000) === 1);
  });

  it('shrinks a page too large for a phone to allocate a canvas for', () => {
    // The kind of page a wide banner design arrives on: 5579 x 1998 points.
    const scale = previewScale(5579.465588, 1997.877323);
    assert.ok(scale < 1);
    assert.ok(Math.ceil(5579.465588 * scale) <= 1400);
  });

  it('upscales a small logo, but only so far', () => {
    assert.equal(previewScale(100, 60), 4);
    assert.equal(previewScale(1, 1), 4);
  });

  it('falls back to 1:1 for a page with no usable size', () => {
    assert.equal(previewScale(0, 0), 1);
    assert.equal(previewScale(undefined, undefined), 1);
    assert.equal(previewScale(-10, -10), 1);
  });
});

describe('pdf asset detection', () => {
  it('is the format, not the kind — traced artwork is vector too', () => {
    assert.equal(isPdfAsset({ kind: 'vector', format: 'pdf' }), true);
    assert.equal(isPdfAsset({ kind: 'vector', source: 'vectorized' }), false);
    assert.equal(isPdfAsset({ kind: 'raster' }), false);
    assert.equal(isPdfAsset(null), false);
  });
});
