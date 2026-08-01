import { api } from './api.js';
import { el } from './ui.js';

/**
 * Artwork previews.
 *
 * Every asset the studio makes is already an image the browser can show —
 * except artwork uploaded as a PDF. The server has no way to rasterise one
 * (see server/src/lib/pdfvector.js), so it serves a placeholder as that
 * asset's image and keeps the original file alongside it. Here is where the
 * original becomes something you can actually look at: pdf.js draws page one
 * on the device, which is the one place a canvas exists.
 *
 * The placeholder is still what appears first, and what stays if rendering
 * fails — a preview is worth having, but never worth an empty box.
 */

const PDFJS_BASE = '/vendor/pdfjs/';
// The transpiled build: this runs on whichever phone browser the studio is
// opened in, not on a target we get to choose at build time.
const PDFJS_MODULE = `${PDFJS_BASE}legacy/build/pdf.min.mjs`;

/** Longest edge of a rendered preview, in pixels. */
const MAX_PREVIEW_EDGE = 1400;
/** Ceiling on upscaling a small page, so a postage-stamp logo stays cheap. */
const MAX_PREVIEW_SCALE = 4;

/**
 * How many pixels to render per PDF point. Artwork pages run from a
 * centimetre-wide logo to a page metres across, and both ends need a guard:
 * a phone will refuse to allocate the canvas for the latter, and the former
 * would be a blurry hundred pixels wide the moment it is placed on a shirt.
 */
export function previewScale(width, height) {
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  if (longest <= 0) return 1;
  return Math.min(MAX_PREVIEW_SCALE, MAX_PREVIEW_EDGE / longest);
}

export function isPdfAsset(asset) {
  return asset?.format === 'pdf';
}

let pdfjs = null;

function loadPdfjs() {
  pdfjs ??= import(PDFJS_MODULE).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}legacy/build/pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjs;
}

/** Rendered previews, keyed by asset id. Assets are immutable, so this never
 * needs invalidating: every edit in the studio produces a new asset. */
const previews = new Map();

/**
 * A blob URL of the artwork's first page, or null if it could not be drawn.
 * Rendering is started at most once per asset, however many places show it.
 */
export function pdfPreview(asset) {
  let pending = previews.get(asset.id);
  if (!pending) {
    pending = renderFirstPage(asset).catch((err) => {
      console.warn(`Could not render a preview of "${asset.name}".`, err);
      return null;
    });
    previews.set(asset.id, pending);
  }
  return pending;
}

async function renderFirstPage(asset) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    url: asset.sourceUrl ?? api.assets.sourceUrl(asset.id),
    // Fonts and colour profiles a PDF refers to but does not embed are served
    // from the same copy of the library, so artwork renders the same offline.
    cMapUrl: `${PDFJS_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
    iccUrl: `${PDFJS_BASE}iccs/`,
    wasmUrl: `${PDFJS_BASE}wasm/`,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const scale = previewScale(page.view[2] - page.view[0], page.view[3] - page.view[1]);
    const viewport = page.getViewport({ scale });
    const canvas = el('canvas', {
      width: Math.max(1, Math.ceil(viewport.width)),
      height: Math.max(1, Math.ceil(viewport.height)),
    });

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      // Artwork is placed over a garment, so the page's own emptiness has to
      // stay empty — pdf.js would otherwise paint it white.
      background: 'rgba(0,0,0,0)',
    }).promise;

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    await doc.destroy();
  }
}

/**
 * An `<img>` showing an asset. Use this rather than the file URL directly:
 * it is what makes PDF artwork appear as itself instead of as a placeholder.
 */
export function assetImg(asset, props = {}) {
  const img = el('img', { src: api.assets.fileUrl(asset.id), ...props });

  if (isPdfAsset(asset)) {
    pdfPreview(asset).then((url) => {
      if (url) img.src = url;
    });
  }

  return img;
}
