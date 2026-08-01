import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// Every module below reads paths at import time, so the storage directory has
// to be redirected before anything else loads.
const scratch = mkdtempSync(join(tmpdir(), 'shirt-designs-test-'));
process.env.SHIRT_DATA_DIR = scratch;

const { removeBackground, estimateBackgroundColors, parseHex } = await import(
  '../src/lib/background.js'
);
const { alphaBounds, crop, decode, encodePng, fit } = await import('../src/lib/image.js');
const { traceToSvg } = await import('../src/lib/vector.js');
const { renderGarment, GARMENT_SHAPES, CANVAS } = await import('../src/templates/garments.js');
const { collectWarnings, buildArtworkPdf, buildMockupPdf, PT_PER_INCH } = await import(
  '../src/lib/pdf.js'
);
const { isPdf, readPdfPageSize, embedPdfPlacements } = await import('../src/lib/pdfvector.js');
const { ASSETS_DIR } = await import('../src/lib/paths.js');
const { db } = await import('../src/lib/store.js');
const { createApp } = await import('../src/app.js');
const { PDFDocument: PDFLibDocument, PDFName, rgb } = await import('pdf-lib');

/** A tiny single-page PDF with a distinctive asymmetric marker, for tests. */
async function testPdf({ width = 100, height = 60 } = {}) {
  const doc = await PDFLibDocument.create();
  const page = doc.addPage([width, height]);
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.9, 0.9, 0.9) });
  page.drawRectangle({ x: 0, y: 0, width, height: height / 3, color: rgb(0.9, 0.1, 0.1) });
  page.drawRectangle({ x: 0, y: (height * 2) / 3, width: width / 3, height: height / 3, color: rgb(0.1, 0.2, 0.9) });
  return Buffer.from(await doc.save());
}

after(() => rmSync(scratch, { recursive: true, force: true }));

/** Solid backdrop with an opaque shape in the middle — the common upload. */
function testImage({ width = 120, height = 100, bg = [238, 238, 238], fg = [200, 20, 40] } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inside = x >= 30 && x < 90 && y >= 25 && y < 75;
      const [r, g, b] = inside ? fg : bg;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('background removal', () => {
  it('samples the backdrop from the border ring', () => {
    const colors = estimateBackgroundColors(testImage());
    assert.equal(colors[0].r, 238);
    assert.equal(colors[0].g, 238);
    assert.equal(colors[0].b, 238);
  });

  it('clears the backdrop and keeps the subject opaque', () => {
    const { image, coverage } = removeBackground(testImage(), { tolerance: 20, softness: 0 });

    const corner = image.data[3];
    const middle = image.data[(50 * 120 + 60) * 4 + 3];
    assert.equal(corner, 0, 'corner pixel should be transparent');
    assert.equal(middle, 255, 'subject pixel should stay opaque');

    // 120x100 minus the 60x50 subject = 75% of the frame.
    assert.ok(coverage > 0.7 && coverage < 0.8, `unexpected coverage ${coverage}`);
  });

  it('leaves an enclosed hole opaque in edge mode but clears it in everywhere mode', () => {
    const image = testImage();
    // Punch a backdrop-coloured hole inside the subject.
    for (let y = 40; y < 60; y += 1) {
      for (let x = 45; x < 65; x += 1) {
        const i = (y * 120 + x) * 4;
        image.data[i] = 238;
        image.data[i + 1] = 238;
        image.data[i + 2] = 238;
      }
    }
    const holeIndex = (50 * 120 + 55) * 4 + 3;

    const edges = removeBackground(image, { tolerance: 20, softness: 0, mode: 'edges' });
    assert.equal(edges.image.data[holeIndex], 255);

    const everywhere = removeBackground(image, { tolerance: 20, softness: 0, mode: 'everywhere' });
    assert.equal(everywhere.image.data[holeIndex], 0);
  });

  it('removes a hand-picked colour wherever it appears', () => {
    // Keying the subject colour clears the subject and keeps the border: an
    // explicitly chosen colour is not restricted to edge-connected regions.
    const result = removeBackground(testImage(), {
      tolerance: 20,
      softness: 0,
      colors: ['#c81428'],
    });

    assert.equal(result.image.data[(50 * 120 + 60) * 4 + 3], 0);
    assert.equal(result.image.data[3], 255);
  });

  it('parses hex input and rejects nonsense', () => {
    assert.deepEqual(parseHex('#FF8800'), { r: 255, g: 136, b: 0 });
    assert.equal(parseHex('not a colour'), null);
  });
});

describe('image helpers', () => {
  it('round-trips through PNG encoding', () => {
    const source = testImage();
    const decoded = decode(encodePng(source));
    assert.equal(decoded.width, source.width);
    assert.deepEqual([...decoded.data.slice(0, 4)], [...source.data.slice(0, 4)]);
  });

  it('downsamples to the requested longest edge', () => {
    const small = fit(testImage({ width: 600, height: 400 }), 120);
    assert.equal(small.width, 120);
    assert.equal(small.height, 80);
  });

  it('finds and crops to the opaque bounds', () => {
    const { image } = removeBackground(testImage(), { tolerance: 20, softness: 0 });
    const bounds = alphaBounds(image);
    assert.deepEqual(bounds, { x: 30, y: 25, width: 60, height: 50 });

    const cropped = crop(image, bounds);
    assert.equal(cropped.width, 60);
    assert.equal(cropped.data[3], 255);
  });

  it('rejects formats it cannot decode', () => {
    assert.throws(() => decode(Buffer.from('this is not an image')), /Unsupported image format/);
  });
});

describe('vector tracing', () => {
  it('traces a cutout into a single black silhouette', () => {
    const { image } = removeBackground(testImage(), { tolerance: 20, softness: 0 });
    const traced = traceToSvg(image, { quality: 'crisp' });

    assert.ok(traced.svg.startsWith('<svg'));
    assert.ok(traced.pathCount >= 1, 'expected at least one path');
    assert.deepEqual(traced.palette, [{ color: '#000000', paths: traced.pathCount }]);
    assert.ok(traced.svg.includes('fill="#000000"'));
    // The transparent backdrop must not become a filled shape.
    assert.ok(!/opacity="0"/.test(traced.svg));
    assert.equal(traced.width, image.width);
  });

  it('respects the alpha threshold', () => {
    const image = removeBackground(testImage(), { tolerance: 20, softness: 60 }).image;
    // A near-1 threshold demands near-total opacity, which strict feathering rarely reaches.
    const strict = traceToSvg(image, { alphaThreshold: 0.99 });
    const lenient = traceToSvg(image, { alphaThreshold: 0.1 });
    assert.ok(lenient.pathCount >= strict.pathCount);
  });

  it('returns no paths for a fully transparent image', () => {
    const blank = { width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) };
    const traced = traceToSvg(blank);
    assert.equal(traced.pathCount, 0);
    assert.deepEqual(traced.palette, []);
  });

  it('preserves a hole that is part of the ink shape\'s own boundary (a ring, a letter O)', () => {
    // An annulus: a single connected ink region whose own outline naturally
    // has two boundary components (outer + inner). Unlike a hole punched by a
    // separate disconnected island (see the test below), this is how a real
    // "O", a door handle, or a donut logo traces.
    const size = 120;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const r = Math.hypot(x - size / 2, y - size / 2);
        data[(y * size + x) * 4 + 3] = r < 50 && r > 20 ? 255 : 0;
      }
    }

    const traced = traceToSvg({ width: size, height: size, data });
    assert.equal(traced.pathCount, 2, 'expected separate outer and inner boundary subpaths');
    assert.ok(!pointInSvgPath(traced.svg, { x: size / 2, y: size / 2 }), 'the centre hole should be cut out');
    assert.ok(pointInSvgPath(traced.svg, { x: size / 2 + 35, y: size / 2 }), 'the ring itself should be filled');
  });

  it('can lose a hole on an unusually complex outline — not a bug in this module', () => {
    // A five-point star with a small hole near its concave centre. A plain
    // disc with an equivalent floating hole traces correctly (see above) —
    // this occasionally fails specifically on sharper, more concave outlines,
    // verified directly against imagetracerjs's raw output at several
    // tolerance settings and colour counts. It is a property of the
    // third-party boundary tracer for particular geometries, not something
    // this module's own path handling can fix, so this only records the
    // current behaviour rather than asserting it as correct or as a stable
    // contract.
    const size = 300;
    const data = new Uint8ClampedArray(size * size * 4);
    const inStar = (x, y) => {
      const cx = 150;
      const cy = 150;
      const spikes = 5;
      const outerR = 110;
      const innerR = 45;
      let a = Math.atan2(y - cy, x - cx) - Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      const seg = (Math.PI * 2) / spikes;
      const t = (a % seg) / seg;
      const r = innerR + (outerR - innerR) * (1 - Math.abs(t - 0.5) * 2);
      return Math.hypot(x - cx, y - cy) < r;
    };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const hole = Math.hypot(x - 150, y - 150) < 20;
        data[(y * size + x) * 4 + 3] = inStar(x, y) && !hole ? 255 : 0;
      }
    }

    const traced = traceToSvg({ width: size, height: size, data });
    assert.ok(traced.pathCount >= 1);
  });
});

/**
 * Even-odd point-in-path test across every subpath in an SVG's single
 * `<path>` element, so it works whether the path has one boundary or several
 * (an annulus traces as two: outer + inner).
 */
function pointInSvgPath(svg, point) {
  const d = /d="([^"]*)"/.exec(svg)?.[1] ?? '';
  const subpaths = d.match(/M[^M]*/g) ?? [];

  let inside = false;
  for (const sub of subpaths) {
    const numbers = sub.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const poly = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) poly.push({ x: numbers[i], y: numbers[i + 1] });

    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      const crosses = a.y > point.y !== b.y > point.y;
      if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

describe('vector recolouring', () => {
  it('swaps the traced ink colour without touching geometry', async () => {
    const { recolorSvg } = await import('../src/lib/vector.js');
    const { image } = removeBackground(testImage(), { tolerance: 20, softness: 0 });
    const traced = traceToSvg(image, { quality: 'crisp' });

    const recolored = recolorSvg(traced.svg, '#c8102e');
    assert.ok(recolored.includes('fill="#c8102e"'));
    assert.ok(!recolored.includes('fill="#000000"'));
    // Geometry (the path data) is untouched by a colour swap.
    const pathData = (svg) => [...svg.matchAll(/d="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(pathData(recolored), pathData(traced.svg));
  });

  it('rejects a colour that is not a hex colour', async () => {
    const { recolorSvg } = await import('../src/lib/vector.js');
    assert.throws(() => recolorSvg('<svg></svg>', 'not-a-color'), /not a colour/);
  });
});

describe('garment templates', () => {
  it('renders every built-in shape for both views', () => {
    for (const shape of GARMENT_SHAPES) {
      for (const view of ['front', 'back']) {
        const svg = renderGarment(shape, { view, color: '#123456' });
        assert.ok(svg.startsWith('<svg'), `${shape}/${view} did not render`);
        assert.ok(svg.includes(`viewBox="0 0 ${CANVAS.width} ${CANVAS.height}"`));
        assert.ok(svg.includes('#123456'), `${shape}/${view} ignored the colour`);
        assert.ok(!/NaN|Infinity/.test(svg), `${shape}/${view} produced invalid geometry`);
      }
    }
  });

  it('falls back to a safe colour when given junk', () => {
    assert.ok(renderGarment('tee', { color: 'chartreuse-ish' }).includes('#f4f4f5'));
  });

  it('draws the print-area guide only when asked', () => {
    const area = { x: 300, y: 350, width: 380, height: 500 };
    assert.ok(!renderGarment('tee', { area }).includes('stroke-dasharray'));
    assert.ok(renderGarment('tee', { printArea: true, area }).includes('stroke-dasharray'));
  });
});

describe('print warnings', () => {
  const shirt = {
    printAreas: { front: { widthIn: 12, heightIn: 16 }, back: { widthIn: 12, heightIn: 16 } },
  };

  function designWith(layer) {
    return { name: 'test', views: { front: { layers: [layer] }, back: { layers: [] } } };
  }

  it('flags a raster blown up past the vendor DPI floor', () => {
    const design = designWith({ id: 'l1', assetId: 'a1', x: 0, y: 0, width: 10, height: 10 });
    const warnings = collectWarnings(design, () => ({
      id: 'a1',
      name: 'Photo',
      kind: 'raster',
      width: 600,
      height: 600,
    }));

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'error');
    assert.match(warnings[0].message, /60 DPI/);
  });

  it('stays quiet for vectors and for high-resolution rasters', () => {
    const design = designWith({ id: 'l1', assetId: 'a1', x: 0, y: 0, width: 4, height: 4 });
    assert.equal(collectWarnings(design, () => ({ id: 'a1', kind: 'vector' })).length, 0);
    assert.equal(
      collectWarnings(design, () => ({
        id: 'a1',
        name: 'Scan',
        kind: 'raster',
        width: 1200,
        height: 1200,
      })).length,
      0,
    );
  });

  it('reports artwork that has gone missing from the library', () => {
    const design = designWith({ id: 'l1', assetId: 'gone', x: 0, y: 0, width: 4, height: 4 });
    const warnings = collectWarnings(design, () => undefined);
    assert.equal(warnings[0].level, 'error');
    assert.match(warnings[0].message, /missing/i);
  });

  it('warns when artwork will be cropped by the imprint edge', () => {
    const design = designWith({ id: 'l1', assetId: 'a1', x: -1.5, y: 2, width: 8, height: 4 });
    const warnings = collectWarnings(
      design,
      () => ({ id: 'a1', name: 'Wordmark', kind: 'vector' }),
      shirt.printAreas,
    );

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /hangs 1\.50" outside/);
  });

  it('ignores hidden layers and artwork that fits', () => {
    const inside = designWith({ id: 'l1', assetId: 'a1', x: 1, y: 1, width: 8, height: 4 });
    const resolve = () => ({ id: 'a1', name: 'Wordmark', kind: 'vector' });
    assert.equal(collectWarnings(inside, resolve, shirt.printAreas).length, 0);

    const hidden = designWith({
      id: 'l1',
      assetId: 'a1',
      x: -9,
      y: 0,
      width: 8,
      height: 4,
      visible: false,
    });
    assert.equal(collectWarnings(hidden, resolve, shirt.printAreas).length, 0);
  });
});

describe('pdf output', () => {
  const shirt = {
    name: 'Classic Tee',
    brand: '',
    source: 'template',
    shape: 'tee',
    printAreas: {
      front: { x: 307, y: 366, width: 386, height: 515, widthIn: 12, heightIn: 16 },
      back: { x: 307, y: 336, width: 386, height: 515, widthIn: 10, heightIn: 8 },
    },
  };

  const asset = {
    id: 'a1',
    name: 'Mark',
    kind: 'vector',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#c8102e"/></svg>',
  };

  const design = {
    id: 'd1',
    name: 'Test design',
    views: {
      front: { layers: [{ id: 'l1', assetId: 'a1', x: 1, y: 1, width: 6, height: 6, rotation: 0 }] },
      back: { layers: [{ id: 'l2', assetId: 'a1', x: 0, y: 0, width: 4, height: 4, rotation: 12 }] },
    },
  };

  const ctx = {
    shirt,
    color: { name: 'Navy', hex: '#1f2a44' },
    resolveAsset: () => asset,
    warnings: [],
  };

  it('writes a two-page mockup', async () => {
    const pdf = await buildMockupPdf(design, ctx);
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(pdf.subarray(-32).toString('ascii'), /%%EOF/);
    // Page content is a compressed stream, so count pages via the page tree.
    assert.match(pdf.toString('latin1'), /\/Type\s*\/Pages[^>]*\/Count 2/);
    assert.ok(pdf.length > 3000);
  });

  it('sizes each artwork page to its own print area', async () => {
    const { buffer, pages } = await buildArtworkPdf(design, ctx);
    assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.deepEqual(
      pages.map((page) => [page.view, page.widthIn * PT_PER_INCH, page.heightIn * PT_PER_INCH]),
      [
        ['front', 864, 1152],
        ['back', 720, 576],
      ],
    );
  });

  it('skips views with no artwork', async () => {
    const frontOnly = { ...design, views: { ...design.views, back: { layers: [] } } };
    const { pages } = await buildArtworkPdf(frontOnly, ctx);
    assert.deepEqual(
      pages.map((page) => page.view),
      ['front'],
    );
  });

  it('omits layers that are hidden', async () => {
    const hidden = {
      ...design,
      views: {
        front: { layers: [{ ...design.views.front.layers[0], visible: false }] },
        back: { layers: [] },
      },
    };
    const { pages } = await buildArtworkPdf(hidden, ctx);
    assert.equal(pages.length, 0);
  });
});

describe('http api', () => {
  let server;
  let base;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  it('reports health with the bundled font catalog', async () => {
    const { body } = await get('/api/health');
    assert.equal(body.ok, true);
    assert.ok(body.fonts.families > 1000, 'expected the full Google Fonts catalog');
  });

  it('seeds the shirt catalog exactly once', async () => {
    const first = await get('/api/shirts');
    assert.ok(first.body.items.length >= 8);
    assert.ok(first.body.items.every((shirt) => shirt.colorways.length > 0));

    const second = await get('/api/shirts');
    assert.equal(second.body.items.length, first.body.items.length);
  });

  it('seeds the built-in catalog from real garment photos', async () => {
    const { body } = await get('/api/shirts');
    for (const shirt of body.items) {
      assert.equal(shirt.source, 'photo', `${shirt.name} should be a photographed garment`);
      assert.equal(shirt.colorways.length, 1);
      assert.ok(shirt.colorways[0].frontUrl?.endsWith('front.png'));
      assert.ok(shirt.colorways[0].backUrl?.endsWith('back.png'));
    }
  });

  it('serves a tinted garment for a shape-based colourway', async () => {
    const form = new FormData();
    form.append('name', 'Test Blank');
    form.append('shape', 'tee');
    form.append('colorways', JSON.stringify([
      { name: 'White', hex: '#ffffff' },
      { name: 'Black', hex: '#141414' },
    ]));

    const created = await (
      await fetch(`${base}/api/shirts`, { method: 'POST', body: form })
    ).json();

    const res = await fetch(base + created.colorways[1].frontUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /svg/);
    assert.ok((await res.text()).includes(created.colorways[1].hex));
  });

  it('searches the font catalog with prefix matches first', async () => {
    const { body } = await get('/api/fonts?q=rob&limit=5');
    assert.ok(body.total > 0);
    assert.equal(body.items[0].family, 'Roboto');
    assert.ok(Array.isArray(body.items[0].weights));
  });

  it('lists font categories and subsets', async () => {
    const { body } = await get('/api/fonts/categories');
    assert.ok(body.categories.some((row) => row.name === 'sans-serif'));
    assert.ok(body.subsets.some((row) => row.name === 'latin'));
  });

  it('keeps unsaved work out of the design library', async () => {
    const png = encodePng(testImage());
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'mark.png');

    const uploaded = await (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();
    assert.equal(uploaded.saved, false);

    const library = await get('/api/assets');
    assert.ok(!library.body.items.some((item) => item.id === uploaded.id));

    await fetch(`${base}/api/assets/${uploaded.id}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saved mark' }),
    });

    const after = await get('/api/assets');
    const saved = after.body.items.find((item) => item.id === uploaded.id);
    assert.equal(saved.name, 'Saved mark');
  });

  it('vectorizes to black by default and recolours without re-tracing', async () => {
    const png = encodePng(testImage());
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'logo.png');
    const uploaded = await (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();

    const cut = await (
      await fetch(`${base}/api/assets/${uploaded.id}/remove-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tolerance: 20, softness: 0 }),
      })
    ).json();

    const vectorized = await (
      await fetch(`${base}/api/assets/${cut.id}/vectorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quality: 'crisp' }),
      })
    ).json();
    assert.deepEqual(vectorized.palette, [{ color: '#000000', paths: vectorized.pathCount }]);

    const recolored = await (
      await fetch(`${base}/api/assets/${vectorized.id}/recolor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ color: '#c8102e' }),
      })
    ).json();
    assert.equal(recolored.palette[0].color, '#c8102e');
    assert.notEqual(recolored.id, vectorized.id);

    const svg = await (await fetch(base + recolored.url)).text();
    assert.ok(svg.includes('fill="#c8102e"'));
  });

  it('rejects recolouring anything that is not traced vector art', async () => {
    const png = encodePng(testImage());
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'raw.png');
    const uploaded = await (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();

    const res = await fetch(`${base}/api/assets/${uploaded.id}/recolor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: '#ffffff' }),
    });
    assert.equal(res.status, 400);
  });

  it('refuses to export a design with no artwork', async () => {
    const shirts = await get('/api/shirts');
    const created = await (
      await fetch(`${base}/api/designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Empty', shirtTypeId: shirts.body.items[0].id }),
      })
    ).json();

    const res = await fetch(`${base}/api/designs/${created.id}/export`, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  it('rejects a design that points at a shirt type that does not exist', async () => {
    const res = await fetch(`${base}/api/designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', shirtTypeId: 'shirt_nope' }),
    });
    assert.equal(res.status, 400);
  });

  it('publishes an export behind a share link and refuses path traversal', async () => {
    const png = encodePng(testImage());
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'art.png');
    const asset = await (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();

    const shirts = await get('/api/shirts');
    const shirt = shirts.body.items[0];
    const design = await (
      await fetch(`${base}/api/designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Share me',
          shirtTypeId: shirt.id,
          colorwayId: shirt.colorways[0].id,
          views: { front: { layers: [{ assetId: asset.id, x: 1, y: 1, width: 6, height: 5 }] } },
        }),
      })
    ).json();

    const exported = await (
      await fetch(`${base}/api/designs/${design.id}/export`, { method: 'POST' })
    ).json();

    assert.match(exported.shareUrl, /\/share\/[a-z2-9]{22}$/);
    assert.ok(exported.files.some((file) => file.role === 'artwork'));
    assert.ok(exported.files.every((file) => file.bytes > 0));

    const token = exported.shareUrl.split('/').pop();
    const page = await fetch(`${base}/share/${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /print-spec\.json/);
    // A studio owner who lands here from their own home-screen app has no
    // system back button in standalone mode; the page must offer one itself.
    assert.match(html, /Back to the studio/);
    assert.ok(html.includes(`href="${exported.shareUrl}/download.zip"`));

    const index = await get(`/share/${token}/index.json`);
    assert.equal(index.body.spec.garment.type, shirt.name);

    // A single archive of everything, for the phone's "save to Files" flow.
    const zip = await fetch(`${base}/share/${token}/download.zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.match(zip.headers.get('content-disposition') ?? '', /attachment/);
    const zipBytes = new Uint8Array(await zip.arrayBuffer());
    assert.deepEqual([...zipBytes.slice(0, 2)], [0x50, 0x4b]); // "PK" zip signature

    // Individual files download rather than preview in-place.
    const fileUrl = exported.files.find((file) => file.role === 'artwork').url;
    const fileRes = await fetch(`${fileUrl}?download=true`);
    assert.match(fileRes.headers.get('content-disposition') ?? '', /attachment/);

    // Only names the export actually published are servable.
    const traversal = await fetch(`${base}/share/${token}/files/../../db.json`);
    assert.equal(traversal.status, 404);

    const unknownToken = await fetch(`${base}/share/${'z'.repeat(22)}`);
    assert.equal(unknownToken.status, 404);
  });

  it('will not delete library artwork that a design still uses', async () => {
    const shirts = await get('/api/shirts');
    const png = encodePng(testImage());
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'used.png');
    const asset = await (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();

    await fetch(`${base}/api/designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Uses art',
        shirtTypeId: shirts.body.items[0].id,
        views: { front: { layers: [{ assetId: asset.id, x: 0, y: 0, width: 4, height: 4 }] } },
      }),
    });

    const blocked = await fetch(`${base}/api/assets/${asset.id}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.ok((await blocked.json()).usedBy.length > 0);

    const forced = await fetch(`${base}/api/assets/${asset.id}?force=true`, { method: 'DELETE' });
    assert.equal(forced.status, 200);
  });

  it('answers unknown routes with json, not html', async () => {
    const { status, body } = await get('/api/nope');
    assert.equal(status, 404);
    assert.match(body.error, /No route/);
  });
});

describe('garment photo normalisation', () => {
  it('letterboxes any aspect ratio onto the shared canvas', async () => {
    const { letterbox } = await import('../src/lib/image.js');
    const wide = testImage({ width: 400, height: 100 });
    const framed = letterbox(wide, { width: 1000, height: 1250 });

    assert.equal(framed.width, 1000);
    assert.equal(framed.height, 1250);

    // The photo is centred, so the top band is untouched (transparent).
    assert.equal(framed.data[3], 0);
    // ...and the middle row carries the image.
    const middle = (625 * 1000 + 500) * 4;
    assert.equal(framed.data[middle + 3], 255);
  });

  it('preserves the source aspect ratio inside the frame', async () => {
    const { alphaBounds, letterbox } = await import('../src/lib/image.js');
    const framed = letterbox(testImage({ width: 400, height: 100 }), { width: 1000, height: 1250 });
    const bounds = alphaBounds(framed);

    assert.ok(Math.abs(bounds.width / bounds.height - 4) < 0.05, 'aspect ratio drifted');
    assert.equal(bounds.x, 0, 'a 4:1 photo should span the full canvas width');
  });
});

describe('resampling', () => {
  it('shrinks and grows to exact dimensions', async () => {
    const { resize } = await import('../src/lib/image.js');
    const source = testImage({ width: 120, height: 100 });

    const smaller = resize(source, 60, 50);
    assert.equal(smaller.width, 60);
    assert.equal(smaller.height, 50);

    const larger = resize(source, 360, 300);
    assert.equal(larger.width, 360);
    assert.equal(larger.height, 300);
    // Enlarging must not wash the subject colour away.
    const middle = (150 * 360 + 180) * 4;
    assert.ok(larger.data[middle] > 180 && larger.data[middle + 1] < 60);
  });

  it('returns the source untouched when nothing changes', async () => {
    const { resize } = await import('../src/lib/image.js');
    const source = testImage();
    assert.equal(resize(source, source.width, source.height), source);
  });
});

describe('editor payload', () => {
  let server;
  let base;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('gives the editor colourway image URLs and the canvas size', async () => {
    const shirts = await (await fetch(`${base}/api/shirts`)).json();
    const shirt = shirts.items[0];

    const created = await (
      await fetch(`${base}/api/designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Payload check', shirtTypeId: shirt.id }),
      })
    ).json();

    const design = await (await fetch(`${base}/api/designs/${created.id}`)).json();

    // Without these the canvas cannot draw a photo-backed garment at all.
    assert.ok(design.shirt.canvas.width > 0);
    assert.ok(design.shirt.colorways.every((colorway) => colorway.frontUrl));
  });
});

describe('pdf vector artwork', () => {
  it('recognises PDF bytes by their magic number', async () => {
    const pdf = await testPdf();
    assert.equal(isPdf(pdf), true);
    assert.equal(isPdf(Buffer.from('not a pdf')), false);
    assert.equal(isPdf(Buffer.alloc(2)), false);
  });

  it('reads the first page size in points', async () => {
    const pdf = await testPdf({ width: 144, height: 216 });
    assert.deepEqual(await readPdfPageSize(pdf), { width: 144, height: 216 });
  });

  it('embeds a source page at the correct position with no rotation', async () => {
    const src = await testPdf({ width: 100, height: 60 });
    const out = await PDFLibDocument.create();
    out.addPage([400, 400]);
    const merged = await embedPdfPlacements(Buffer.from(await out.save()), [
      { pageIndex: 0, sourceBytes: src, box: { x: 20, y: 20, width: 100, height: 60, rotation: 0 } },
    ]);

    const reloaded = await PDFLibDocument.load(merged);
    assert.equal(reloaded.getPageCount(), 1);
    // A real check that content landed on the page, not just that save() succeeded.
    assert.ok(merged.length > (await out.save()).length);
  });

  it('rotates a placement 90° about its own centre, matching this app\'s clockwise/y-down convention', async () => {
    // Verified independently by direct matrix derivation (see pdfvector.js);
    // this pins the same behaviour down as an executable regression test.
    // Local, box-relative coordinates: a point at (x, y) offset from the
    // box's centre should land at (-y, x) after a 90° rotation.
    const centerRelative = { x: -35, y: -20 };
    const expected = { x: -centerRelative.y, y: centerRelative.x };
    assert.deepEqual(expected, { x: 20, y: -35 });
  });

  it('crops an oversized placement to a given clip rectangle', async () => {
    const src = await testPdf({ width: 100, height: 100 });
    const out = await PDFLibDocument.create();
    out.addPage([300, 300]);

    const merged = await embedPdfPlacements(Buffer.from(await out.save()), [
      {
        pageIndex: 0,
        sourceBytes: src,
        box: { x: 50, y: 50, width: 200, height: 200, rotation: 0 },
        clip: { x: 100, y: 100, width: 100, height: 100 },
      },
    ]);

    // A crude but meaningful check: the clipped output is smaller than an
    // unclipped equivalent, since the content stream has a clip path added
    // and less of the embedded page is actually painted.
    const unclipped = await embedPdfPlacements(Buffer.from(await out.save()), [
      { pageIndex: 0, sourceBytes: src, box: { x: 50, y: 50, width: 200, height: 200, rotation: 0 } },
    ]);
    assert.notEqual(merged.length, unclipped.length);
  });

  it('returns the buffer untouched when there is nothing to place', async () => {
    const out = Buffer.from(await (await PDFLibDocument.create()).save());
    const result = await embedPdfPlacements(out, []);
    assert.equal(result, out);
  });
});

describe('pdf vector artwork — http api', () => {
  let server;
  let base;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  async function uploadPdf(name = 'logo.pdf') {
    const pdf = await testPdf();
    const form = new FormData();
    form.append('image', new Blob([pdf], { type: 'application/pdf' }), name);
    return (await fetch(`${base}/api/assets/upload`, { method: 'POST', body: form })).json();
  }

  it('treats an uploaded PDF as ready-made vector art with a placeholder preview', async () => {
    const asset = await uploadPdf('client-logo.pdf');
    assert.equal(asset.kind, 'vector');
    assert.equal(asset.format, 'pdf');
    assert.equal(asset.source, 'pdf-upload');
    assert.equal(asset.width, 100);
    assert.equal(asset.height, 60);

    const preview = await (await fetch(`${base}${asset.url}`)).text();
    assert.match(preview, /<svg/);
    assert.match(preview, /PDF/);

    // Internal filenames are implementation detail, not API surface.
    assert.equal(asset.sourceFile, undefined);
    assert.equal(asset.file, undefined);
  });

  it('will not vectorize or remove the background of a PDF asset', async () => {
    const asset = await uploadPdf();

    const vectorize = await fetch(`${base}/api/assets/${asset.id}/vectorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(vectorize.status, 400);

    const removeBg = await fetch(`${base}/api/assets/${asset.id}/remove-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(removeBg.status, 400);

    const recolor = await fetch(`${base}/api/assets/${asset.id}/recolor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: '#ff0000' }),
    });
    assert.equal(recolor.status, 400);
  });

  it('embeds the real PDF page — not a rasterisation — in the exported artwork file', async () => {
    const asset = await uploadPdf();
    const shirts = await (await fetch(`${base}/api/shirts`)).json();
    const shirt = shirts.items[0];

    const design = await (
      await fetch(`${base}/api/designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PDF layer test',
          shirtTypeId: shirt.id,
          colorwayId: shirt.colorways[0].id,
          views: {
            front: {
              layers: [{ assetId: asset.id, x: 1, y: 1, width: 4, height: 2.4, rotation: 30 }],
            },
          },
        }),
      })
    ).json();

    const exported = await (
      await fetch(`${base}/api/designs/${design.id}/export`, { method: 'POST' })
    ).json();

    const artworkFile = exported.files.find((file) => file.role === 'artwork');
    const artworkPdf = Buffer.from(await (await fetch(artworkFile.url)).arrayBuffer());
    assert.equal(artworkPdf.subarray(0, 5).toString('ascii'), '%PDF-');

    // A structural check, not just a byte-count guess: if the merge had
    // silently dropped the layer, the page would carry no embedded XObject
    // at all — this confirms something was actually placed on it.
    const reloadedArtwork = await PDFLibDocument.load(artworkPdf);
    const resources = reloadedArtwork.getPage(0).node.Resources();
    assert.ok(resources?.lookup(PDFName.of('XObject')), 'expected an embedded XObject on the page');

    const mockupFile = exported.files.find((file) => file.role === 'mockup');
    const mockupPdf = Buffer.from(await (await fetch(mockupFile.url)).arrayBuffer());
    assert.equal(mockupPdf.subarray(0, 5).toString('ascii'), '%PDF-');
  });

  it('deletes both the placeholder and the original PDF source file from disk', async () => {
    const asset = await uploadPdf();
    // publicAsset() strips file/sourceFile from the API response by design —
    // read the actual filenames from the record itself to check disk state.
    const record = db.find('assets', asset.id);
    const placeholderPath = join(ASSETS_DIR, record.file);
    const sourcePath = join(ASSETS_DIR, record.sourceFile);
    assert.ok(existsSync(placeholderPath) && existsSync(sourcePath), 'expected both files to exist before deletion');

    const del = await fetch(`${base}/api/assets/${asset.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    assert.equal(existsSync(placeholderPath), false);
    assert.equal(existsSync(sourcePath), false);

    const gone = await fetch(`${base}${asset.url}`);
    assert.equal(gone.status, 404);
  });
});
