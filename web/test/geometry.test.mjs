import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centerHorizontally,
  clamp,
  clampLayer,
  effectiveDpi,
  fitNewLayer,
  formatInches,
  layerToScreen,
  layoutCanvas,
  normalizeAngle,
  overflowsPrintArea,
  pixelsPerInch,
  pointerSpan,
  printAreaRect,
  scaleAboutCenter,
  screenToInches,
} from '../js/geometry.js';

/**
 * These conversions are the contract between what the user drags on screen and
 * what the printer receives, so they are tested directly rather than through
 * the DOM.
 */

const CANVAS = { width: 1000, height: 1250 };

const AREA = { x: 300, y: 350, width: 400, height: 500, widthIn: 12, heightIn: 15 };

describe('canvas layout', () => {
  it('fits the garment inside the stage and centres it', () => {
    const layout = layoutCanvas({ width: 400, height: 800 }, CANVAS);

    // Width-limited: 400/1000 beats 800/1250.
    assert.equal(layout.scale, 0.4);
    assert.equal(layout.width, 400);
    assert.equal(layout.height, 500);
    assert.equal(layout.left, 0);
    assert.equal(layout.top, 150);
  });

  it('is height-limited on a short, wide stage', () => {
    const layout = layoutCanvas({ width: 2000, height: 625 }, CANVAS);
    assert.equal(layout.scale, 0.5);
    assert.equal(layout.left, 750);
    assert.equal(layout.top, 0);
  });

  it('honours padding', () => {
    const layout = layoutCanvas({ width: 400, height: 800 }, CANVAS, 20);
    assert.equal(layout.scale, 0.36);
    // Still centred in the full container, not in the padded box.
    assert.equal(layout.left, 20);
  });

  it('never produces a zero or negative scale', () => {
    const layout = layoutCanvas({ width: 10, height: 10 }, CANVAS, 40);
    assert.ok(layout.scale > 0);
  });
});

describe('print area mapping', () => {
  const layout = layoutCanvas({ width: 400, height: 800 }, CANVAS);

  it('places the print area on screen', () => {
    assert.deepEqual(printAreaRect(layout, AREA), {
      left: 120,
      top: 290,
      width: 160,
      height: 200,
    });
  });

  it('derives pixels per printed inch', () => {
    // 400 canvas units * 0.4 scale = 160px across 12 inches.
    assert.ok(Math.abs(pixelsPerInch(layout, AREA) - 160 / 12) < 1e-9);
  });

  it('round-trips a layer between inches and screen space', () => {
    const layer = { x: 3, y: 4, width: 6, height: 2 };
    const rect = layerToScreen(layer, layout, AREA);
    const back = screenToInches({ x: rect.left, y: rect.top }, layout, AREA);

    assert.ok(Math.abs(back.x - layer.x) < 1e-9);
    assert.ok(Math.abs(back.y - layer.y) < 1e-9);
  });

  it('keeps a layer at the origin flush with the print area', () => {
    const rect = layerToScreen({ x: 0, y: 0, width: 12, height: 15 }, layout, AREA);
    const area = printAreaRect(layout, AREA);

    assert.equal(rect.left, area.left);
    assert.equal(rect.top, area.top);
    assert.ok(Math.abs(rect.width - area.width) < 1e-9);
  });
});

describe('placing new artwork', () => {
  it('sizes a wide graphic to 70% of the print width', () => {
    const box = fitNewLayer({ width: 1000, height: 500 }, AREA);
    assert.ok(Math.abs(box.width - 8.4) < 1e-9);
    assert.ok(Math.abs(box.height - 4.2) < 1e-9);
    // Centred horizontally.
    assert.ok(Math.abs(box.x - (12 - 8.4) / 2) < 1e-9);
  });

  it('constrains a tall graphic by height instead', () => {
    const box = fitNewLayer({ width: 100, height: 1000 }, AREA);
    assert.ok(box.height <= AREA.heightIn * 0.7 + 1e-9);
    assert.ok(box.width <= AREA.widthIn);
    // Aspect ratio survives.
    assert.ok(Math.abs(box.height / box.width - 10) < 1e-6);
  });

  it('sits high on the chest rather than dead centre', () => {
    const box = fitNewLayer({ width: 1000, height: 300 }, AREA);
    assert.ok(box.y <= AREA.heightIn * 0.22 + 1e-9);
  });

  it('survives a zero-width asset without dividing by zero', () => {
    const box = fitNewLayer({ width: 0, height: 0 }, AREA);
    assert.ok(Number.isFinite(box.width) && Number.isFinite(box.height));
  });
});

describe('layer constraints', () => {
  it('lets artwork bleed off the edge but never out of reach', () => {
    const dragged = clampLayer({ x: -50, y: -50, width: 6, height: 3 }, AREA);
    assert.equal(dragged.x, -5.5);
    assert.equal(dragged.y, -2.5);

    const far = clampLayer({ x: 99, y: 99, width: 6, height: 3 }, AREA);
    assert.equal(far.x, AREA.widthIn - 0.5);
    assert.equal(far.y, AREA.heightIn - 0.5);
  });

  it('refuses to shrink a layer to nothing', () => {
    assert.equal(clampLayer({ x: 0, y: 0, width: 0, height: -4 }, AREA).width, 0.25);
    assert.equal(clampLayer({ x: 0, y: 0, width: 0, height: -4 }, AREA).height, 0.25);
  });

  it('detects overflow of the printable area', () => {
    assert.equal(overflowsPrintArea({ x: 0, y: 0, width: 12, height: 15 }, AREA), false);
    assert.equal(overflowsPrintArea({ x: -0.5, y: 0, width: 6, height: 3 }, AREA), true);
    assert.equal(overflowsPrintArea({ x: 7, y: 0, width: 6, height: 3 }, AREA), true);
    assert.equal(overflowsPrintArea({ x: 0, y: 13, width: 6, height: 3 }, AREA), true);
  });

  it('centres horizontally without moving vertically', () => {
    const centred = centerHorizontally({ x: 0, y: 4, width: 6, height: 3 }, AREA);
    assert.equal(centred.x, 3);
    assert.equal(centred.y, 4);
  });

  it('scales about the centre so artwork does not crawl', () => {
    const scaled = scaleAboutCenter({ x: 2, y: 2, width: 4, height: 4 }, 2);
    assert.equal(scaled.width, 8);
    // Centre was at (4, 4) and must still be.
    assert.equal(scaled.x + scaled.width / 2, 4);
    assert.equal(scaled.y + scaled.height / 2, 4);
  });
});

describe('print resolution', () => {
  it('reports the DPI a bitmap actually prints at', () => {
    assert.equal(effectiveDpi({ width: 1200, height: 1200 }, { width: 4, height: 4 }), 300);
    assert.equal(effectiveDpi({ width: 600, height: 600 }, { width: 10, height: 10 }), 60);
  });

  it('uses the worse of the two axes', () => {
    assert.equal(effectiveDpi({ width: 1200, height: 300 }, { width: 4, height: 4 }), 75);
  });

  it('does not blow up on a zero-sized layer', () => {
    assert.ok(Number.isFinite(effectiveDpi({ width: 100, height: 100 }, { width: 0, height: 0 })));
  });
});

describe('pointer maths', () => {
  it('measures the span between two pointers', () => {
    const span = pointerSpan({ x: 0, y: 0 }, { x: 3, y: 4 });
    assert.equal(span.distance, 5);
    assert.deepEqual(span.center, { x: 1.5, y: 2 });
  });

  it('reports the angle between two pointers in degrees', () => {
    assert.equal(pointerSpan({ x: 0, y: 0 }, { x: 1, y: 0 }).angle, 0);
    assert.equal(pointerSpan({ x: 0, y: 0 }, { x: 0, y: 1 }).angle, 90);
  });

  it('wraps rotation deltas so they never jump a full turn', () => {
    assert.equal(normalizeAngle(370), 10);
    assert.equal(normalizeAngle(-370), -10);
    assert.equal(normalizeAngle(180), 180);
    assert.equal(normalizeAngle(-180), 180);
    assert.equal(normalizeAngle(350), -10);
  });
});

describe('helpers', () => {
  it('clamps, including when the bounds are inverted', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(50, 0, 10), 10);
    assert.equal(clamp(5, 10, 0), 10);
  });

  it('formats inches the way a print shop writes them', () => {
    assert.equal(formatInches(8.4), '8.4"');
    assert.equal(formatInches(8.4567), '8.46"');
    assert.equal(formatInches(12), '12"');
  });
});
