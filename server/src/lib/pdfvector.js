import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  rectangle,
  clip,
  endPath,
} = require('pdf-lib');

/**
 * PDF vector artwork: logos and line art a client hands over as a PDF rather
 * than an image. These are embedded into the final production file as the
 * genuine original vector page — not a rasterised preview of it — so a
 * complex logo prints exactly as sharp as the source, at any size.
 *
 * The design canvas itself shows a plain placeholder for this artwork (see
 * placeholderSvg below) rather than a faithful render of the PDF's content:
 * there is no pure-JS, native-dependency-free way to rasterise arbitrary PDF
 * vector content in this stack. Print fidelity comes from embedding the real
 * page at export time; the placeholder is only ever a stand-in for placement
 * on screen.
 */

export function isPdf(buffer) {
  return buffer.length > 4 && buffer.toString('ascii', 0, 5) === '%PDF-';
}

/** Reads the first page's size in points, the same unit layer geometry uses. */
export async function readPdfPageSize(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const page = doc.getPages()[0];
  if (!page) throw Object.assign(new Error('This PDF has no pages.'), { status: 400 });
  return { width: page.getWidth(), height: page.getHeight() };
}

/** A neutral stand-in shown on the design canvas in place of the real PDF content. */
export function placeholderSvg(width, height, label) {
  const short = String(label ?? 'PDF').slice(0, 24);
  const fontSize = Math.max(10, Math.min(width, height) * 0.09);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#ffffff" stroke="#c7cad3" stroke-width="2" stroke-dasharray="6 5"/>
<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="700" font-size="${fontSize}" fill="#8992a6">PDF</text>
<text x="${width / 2}" y="${height / 2 + fontSize}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${fontSize * 0.5}" fill="#a7acb9">${escapeXml(short)}</text>
</svg>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Embeds page 1 of `sourceBytes` onto an already-built PDF page, positioned
 * to match a box given in the same top-left, y-down coordinate system pdfkit
 * draws everything else in — so a PDF-vector layer lines up exactly where its
 * counterpart SVG/raster layers would.
 *
 * pdf-lib's own coordinate space is bottom-up (PDF native), and its `rotate`
 * pivots on the box's corner, not its centre — pdfkit's (and this app's own)
 * layers rotate about their centre. This wraps the embed in an explicit
 * translate/rotate/translate so the two systems agree.
 */
export async function embedPdfPlacements(pdfBuffer, placements) {
  if (placements.length === 0) return pdfBuffer;

  const outputDoc = await PDFDocument.load(pdfBuffer);
  const sourceCache = new Map();

  for (const placement of placements) {
    const { pageIndex, sourceBytes, box, clip: clipRect } = placement;
    const page = outputDoc.getPage(pageIndex);
    const pageHeight = page.getHeight();

    const cacheKey = sourceBytes;
    let embedded = sourceCache.get(cacheKey);
    if (!embedded) {
      const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      embedded = await outputDoc.embedPage(sourceDoc.getPages()[0]);
      sourceCache.set(cacheKey, embedded);
    }

    const centerX = box.x + box.width / 2;
    const centerYBottomUp = pageHeight - (box.y + box.height / 2);
    // PDF rotation is counter-clockwise-positive in a y-up space; this app's
    // layer rotation is clockwise-positive in a y-down space. Flipping the
    // vertical axis is equivalent to negating the angle.
    const radians = (-(box.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    page.pushOperators(pushGraphicsState());

    // Mirrors the print-area clip pdfkit applies to every other layer kind
    // (see buildMockupPdf) — without it, a PDF layer would be the one kind of
    // artwork that isn't cropped to the imprint guide on the mockup preview.
    if (clipRect) {
      const clipYBottomUp = pageHeight - (clipRect.y + clipRect.height);
      page.pushOperators(
        rectangle(clipRect.x, clipYBottomUp, clipRect.width, clipRect.height),
        clip(),
        endPath(),
      );
    }

    // A nested coordinate frame — centre the box at the origin, rotate, then
    // recentre — established via raw content-stream operators before
    // drawPage()'s own (corner-pivot) transform runs inside it.
    page.pushOperators(
      concatTransformationMatrix(cos, sin, -sin, cos, centerX, centerYBottomUp),
      concatTransformationMatrix(1, 0, 0, 1, -box.width / 2, -box.height / 2),
    );
    page.drawPage(embedded, { x: 0, y: 0, width: box.width, height: box.height });
    page.pushOperators(popGraphicsState());
  }

  return Buffer.from(await outputDoc.save());
}
