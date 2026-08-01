import { createRequire } from 'node:module';
import { CANVAS, renderGarment } from '../templates/garments.js';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

const PT_PER_INCH = 72;
const A4 = { width: 595.28, height: 841.89 };
const MIN_PRINT_DPI = 150;

/**
 * Print production output.
 *
 * Two documents come out of an export because a print vendor needs two
 * different things:
 *
 *  - the mockup, which shows a human what the finished garment looks like
 *    front and back, with the garment colour and placement measurements;
 *  - the artwork file, whose page *is* the print area at its true physical
 *    size, containing nothing but the graphics. That is what gets separated,
 *    filmed or sent to the DTG RIP.
 */

export function collectWarnings(design, resolve) {
  const warnings = [];

  for (const view of ['front', 'back']) {
    for (const layer of design.views[view]?.layers ?? []) {
      const asset = resolve(layer.assetId);
      if (!asset) {
        warnings.push({ view, layer: layer.id, level: 'error', message: 'Artwork is missing from the library.' });
        continue;
      }
      if (asset.kind !== 'raster') continue;

      // Effective resolution once the bitmap is blown up to its printed size.
      const dpi = Math.min(asset.width / layer.width, asset.height / layer.height);
      if (dpi < MIN_PRINT_DPI) {
        warnings.push({
          view,
          layer: layer.id,
          level: dpi < 100 ? 'error' : 'warning',
          message: `"${asset.name}" prints at ${Math.round(dpi)} DPI at this size. Vectorise it or scale it down — vendors want ${MIN_PRINT_DPI} DPI or better.`,
        });
      }
    }
  }

  return warnings;
}

function layersFor(design, view) {
  return (design.views[view]?.layers ?? []).filter((layer) => layer.visible !== false);
}

/**
 * Draws one layer at `scale` points per inch, with the layer's own rotation
 * applied about its centre.
 */
function drawLayer(doc, layer, asset, origin, scale) {
  const x = origin.x + layer.x * scale;
  const y = origin.y + layer.y * scale;
  const width = layer.width * scale;
  const height = layer.height * scale;

  doc.save();
  if (layer.rotation) {
    doc.rotate(layer.rotation, { origin: [x + width / 2, y + height / 2] });
  }
  if (layer.opacity !== undefined && layer.opacity < 1) doc.opacity(layer.opacity);

  if (asset.kind === 'vector') {
    SVGtoPDF(doc, asset.svg, x, y, {
      width,
      height,
      assumePt: true,
      preserveAspectRatio: 'none',
    });
  } else {
    doc.image(asset.buffer, x, y, { width, height });
  }

  doc.restore();
}

/** Where the print area sits on the garment mockup, in canvas coordinates. */
function printAreaBox(shirt, view) {
  return shirt.printAreas[view] ?? shirt.printAreas.front;
}

export function buildMockupPdf(design, ctx) {
  const { shirt, color, resolveAsset, warnings = [] } = ctx;
  const doc = new PDFDocument({ size: [A4.width, A4.height], margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  for (const view of ['front', 'back']) {
    doc.addPage();
    const area = printAreaBox(shirt, view);

    header(doc, design, shirt, color, view);

    // Fit the 1000x1250 garment canvas into the page body.
    const bodyTop = 132;
    const bodyHeight = A4.height - bodyTop - 96;
    const garmentScale = Math.min((A4.width - 96) / CANVAS.width, bodyHeight / CANVAS.height);
    const garmentWidth = CANVAS.width * garmentScale;
    const garmentX = (A4.width - garmentWidth) / 2;
    const garmentY = bodyTop;

    const garmentSvg =
      shirt.source === 'photo'
        ? null
        : renderGarment(shirt.shape, { view, color: color.hex });

    if (garmentSvg) {
      SVGtoPDF(doc, garmentSvg, garmentX, garmentY, {
        width: garmentWidth,
        height: CANVAS.height * garmentScale,
        assumePt: true,
        // svg-to-pdfkit only honours width/height when a preserveAspectRatio is
        // given; without it the SVG's own attributes win and nothing scales.
        preserveAspectRatio: 'xMidYMid meet',
      });
    } else {
      const photo = color.views?.[view];
      if (photo) {
        doc.image(photo, garmentX, garmentY, {
          fit: [garmentWidth, CANVAS.height * garmentScale],
          align: 'center',
        });
      }
    }

    // Print area on the page, and the inches-per-point scale inside it.
    const areaX = garmentX + area.x * garmentScale;
    const areaY = garmentY + area.y * garmentScale;
    const areaWidth = area.width * garmentScale;
    const scale = areaWidth / area.widthIn;

    doc
      .save()
      .rect(areaX, areaY, areaWidth, area.height * garmentScale)
      .clip();

    for (const layer of layersFor(design, view)) {
      const asset = resolveAsset(layer.assetId);
      if (asset) drawLayer(doc, layer, asset, { x: areaX, y: areaY }, scale);
    }
    doc.restore();

    // Placement guide, drawn last so it stays legible over the artwork.
    doc
      .save()
      .dash(4, { space: 4 })
      .lineWidth(0.6)
      .strokeColor('#2f6df6')
      .rect(areaX, areaY, areaWidth, area.height * garmentScale)
      .stroke()
      .undash()
      .restore();

    footer(doc, area, view, warnings);
  }

  doc.end();
  return collect(doc, chunks);
}

function header(doc, design, shirt, color, view) {
  doc
    .fillColor('#111111')
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(design.name || 'Untitled design', 48, 44, { width: A4.width - 96 });

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#555555')
    .text(
      `${shirt.name}${shirt.brand ? ` · ${shirt.brand}` : ''}  |  Colour: ${color.name} (${color.hex})  |  ${view.toUpperCase()} VIEW`,
      48,
      70,
      { width: A4.width - 96 },
    );

  doc
    .moveTo(48, 96)
    .lineTo(A4.width - 48, 96)
    .lineWidth(0.75)
    .strokeColor('#dddddd')
    .stroke();
}

function footer(doc, area, view, warnings) {
  const y = A4.height - 78;
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#555555')
    .text(
      `Print area: ${area.widthIn}" x ${area.heightIn}"  ·  dashed guide is the maximum imprint, not a printed element.`,
      48,
      y,
      { width: A4.width - 96 },
    );

  const relevant = warnings.filter((warning) => warning.view === view);
  if (relevant.length > 0) {
    doc
      .fillColor('#a1341a')
      .text(relevant.map((warning) => `! ${warning.message}`).join('\n'), 48, y + 14, {
        width: A4.width - 96,
      });
  }
}

/**
 * The production file: one page per view that carries artwork, each page sized
 * to the print area itself so the vendor can output at 100% with no scaling.
 */
export function buildArtworkPdf(design, ctx) {
  const { shirt, resolveAsset } = ctx;
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const pages = [];
  for (const view of ['front', 'back']) {
    const layers = layersFor(design, view);
    if (layers.length === 0) continue;

    const area = printAreaBox(shirt, view);
    const width = area.widthIn * PT_PER_INCH;
    const height = area.heightIn * PT_PER_INCH;

    doc.addPage({ size: [width, height], margin: 0 });
    for (const layer of layers) {
      const asset = resolveAsset(layer.assetId);
      if (asset) drawLayer(doc, layer, asset, { x: 0, y: 0 }, PT_PER_INCH);
    }

    pages.push({ view, widthIn: area.widthIn, heightIn: area.heightIn, layers: layers.length });
  }

  if (pages.length === 0) {
    doc.addPage({ size: [PT_PER_INCH * 4, PT_PER_INCH * 4], margin: 24 });
    doc.font('Helvetica').fontSize(11).fillColor('#777777').text('This design has no artwork yet.', 24, 24);
  }

  doc.end();
  return collect(doc, chunks).then((buffer) => ({ buffer, pages }));
}

function collect(doc, chunks) {
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export { PT_PER_INCH, MIN_PRINT_DPI };
