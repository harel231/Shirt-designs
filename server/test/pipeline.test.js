import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
const { createApp } = await import('../src/app.js');

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
  it('traces a cutout into filled paths and reports the ink palette', () => {
    const { image } = removeBackground(testImage(), { tolerance: 20, softness: 0 });
    const traced = traceToSvg(image, { colors: 4, quality: 'crisp' });

    assert.ok(traced.svg.startsWith('<svg'));
    assert.ok(traced.pathCount >= 1, 'expected at least one path');
    assert.ok(traced.palette.length >= 1);
    // The transparent backdrop must not become a filled rectangle.
    assert.ok(!/opacity="0"/.test(traced.svg));
    assert.equal(traced.width, image.width);
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

  it('serves a tinted garment for any colourway', async () => {
    const { body } = await get('/api/shirts');
    const shirt = body.items[0];
    const res = await fetch(base + shirt.colorways[1].frontUrl);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /svg/);
    assert.ok((await res.text()).includes(shirt.colorways[1].hex));
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
    assert.match(await page.text(), /print-spec\.json/);

    const index = await get(`/share/${token}/index.json`);
    assert.equal(index.body.spec.garment.type, shirt.name);

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
