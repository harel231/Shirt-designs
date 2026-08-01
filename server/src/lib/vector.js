import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ImageTracer = require('imagetracerjs');

/**
 * Raster -> vector tracing.
 *
 * Print vendors want outlines, not pixels: vector art can be scaled to any
 * garment size and, for screen printing, each colour becomes a separate screen.
 * So alongside the SVG we report the palette that came out of the trace — that
 * count is the number of inks the job needs.
 */

const QUALITY = {
  // ltres/qtres: how far a traced line may drift from the pixel edge.
  // Lower = closer to the source, larger files.
  crisp: { ltres: 0.5, qtres: 0.5, pathomit: 4, blurradius: 0 },
  balanced: { ltres: 1, qtres: 1, pathomit: 8, blurradius: 0 },
  smooth: { ltres: 1.6, qtres: 1.6, pathomit: 16, blurradius: 1, blurdelta: 20 },
};

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {object} [options]
 * @param {number} [options.colors] Target ink count (2-64).
 * @param {'crisp'|'balanced'|'smooth'} [options.quality]
 * @param {number} [options.alphaThreshold] Alpha below which a traced region is
 *   dropped instead of being filled.
 */
export function traceToSvg(image, options = {}) {
  const colors = Math.min(64, Math.max(2, Math.round(options.colors ?? 8)));
  const quality = QUALITY[options.quality] ?? QUALITY.balanced;
  const alphaThreshold = options.alphaThreshold ?? 0.5;

  const svg = ImageTracer.imagedataToSVG(
    { width: image.width, height: image.height, data: image.data },
    {
      ...quality,
      numberofcolors: colors,
      colorquantcycles: 3,
      strokewidth: 0,
      linefilter: true,
      roundcoords: 2,
      viewbox: true,
      desc: false,
    },
  );

  return finalize(svg, image, alphaThreshold);
}

/**
 * ImageTracer emits a path per colour region, including the fully transparent
 * ones it traced out of a cutout. Those would print as solid rectangles, so
 * they are stripped here rather than shipped to a vendor.
 */
function finalize(svg, image, alphaThreshold) {
  const palette = new Map();
  const kept = [];

  const pathRe = /<path\s+([^>]*?)\/?>/g;
  let match;
  while ((match = pathRe.exec(svg)) !== null) {
    const attrs = match[1];
    const fill = /fill="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const opacityAttr = /opacity="([^"]*)"/.exec(attrs)?.[1];
    const opacity = opacityAttr === undefined ? 1 : Number.parseFloat(opacityAttr);
    const d = /\sd="([^"]*)"/.exec(attrs)?.[1];
    if (!d || !Number.isFinite(opacity) || opacity < alphaThreshold) continue;

    const hex = rgbStringToHex(fill);
    if (!hex) continue;
    palette.set(hex, (palette.get(hex) ?? 0) + 1);
    kept.push(`<path fill="${hex}" d="${d}"/>`);
  }

  const body = kept.join('');
  const out =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" ` +
    `viewBox="0 0 ${image.width} ${image.height}" shape-rendering="geometricPrecision">${body}</svg>`;

  return {
    svg: out,
    width: image.width,
    height: image.height,
    palette: [...palette.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([color, paths]) => ({ color, paths })),
    pathCount: kept.length,
  };
}

function rgbStringToHex(fill) {
  const match = /rgba?\(([^)]+)\)/.exec(fill);
  if (!match) return /^#[0-9a-f]{6}$/i.test(fill) ? fill.toLowerCase() : null;
  const [r, g, b] = match[1].split(',').map((part) => Number.parseInt(part.trim(), 10));
  if ([r, g, b].some((c) => !Number.isFinite(c))) return null;
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}
