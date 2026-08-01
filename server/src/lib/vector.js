import { createRequire } from 'node:module';
import { normalizeHex } from './text.js';

const require = createRequire(import.meta.url);
const ImageTracer = require('imagetracerjs');

/**
 * Raster -> vector tracing.
 *
 * This produces a single-colour silhouette, not a multi-colour reproduction of
 * the source image: every pixel above the alpha threshold becomes solid ink,
 * everything else is cut away. That is what a print shop wants from a traced
 * logo or line-art upload — one clean shape, one screen. The trace itself is
 * always black; colour is applied afterwards as a cheap fill swap (see
 * {@link recolorSvg}) so trying a different ink colour never means re-tracing.
 */

const QUALITY = {
  // ltres/qtres: how far a traced line may drift from the pixel edge.
  // Lower = closer to the source, larger files.
  crisp: { ltres: 0.5, qtres: 0.5, pathomit: 4, blurradius: 0 },
  balanced: { ltres: 1, qtres: 1, pathomit: 8, blurradius: 0 },
  smooth: { ltres: 1.6, qtres: 1.6, pathomit: 16, blurradius: 1, blurdelta: 20 },
};

const TRACE_INK = '#000000';

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {object} [options]
 * @param {'crisp'|'balanced'|'smooth'} [options.quality]
 * @param {number} [options.alphaThreshold] 0-1. Alpha above which a pixel
 *   counts as ink rather than being cut away.
 */
export function traceToSvg(image, options = {}) {
  const quality = QUALITY[options.quality] ?? QUALITY.balanced;
  const alphaThreshold = clamp01(options.alphaThreshold ?? 0.5);
  const silhouette = binarize(image, alphaThreshold);

  const svg = ImageTracer.imagedataToSVG(
    { width: silhouette.width, height: silhouette.height, data: silhouette.data },
    {
      ...quality,
      // imagetracerjs's default 2-colour palette is pure black and pure
      // white, both fully opaque (see generatepalette() in its source), and
      // the input below is pre-quantised to land exactly on those anchors.
      // colorquantcycles must stay >= 2 here: numberofcolors:2 combined with
      // exactly 1 cycle is a real bug in imagetracerjs — verified empirically
      // (it collapses the whole canvas into a single region regardless of
      // actual pixel classification) — 3 cycles matches the value already
      // proven correct for the original multi-colour trace.
      numberofcolors: 2,
      colorquantcycles: 3,
      strokewidth: 0,
      linefilter: true,
      roundcoords: 2,
      viewbox: true,
      desc: false,
    },
  );

  return finalize(svg, image.width, image.height);
}

/**
 * Every pixel becomes either solid opaque black (ink) or solid opaque white
 * (background) — no partial transparency at all. This deliberately avoids
 * alpha: imagetracerjs's colour quantiser clusters on RGB distance first, and
 * a transparent-vs-opaque encoding with identical RGB everywhere gives it no
 * way to separate the two (verified empirically — it collapsed the whole
 * canvas into one region). Two RGB colours that land exactly on its default
 * black/white anchors give a clean, unambiguous split instead.
 */
function binarize(image, alphaThreshold) {
  const cutoff = alphaThreshold * 255;
  const data = new Uint8ClampedArray(image.width * image.height * 4);

  for (let i = 0; i < data.length; i += 4) {
    const ink = image.data[i + 3] >= cutoff;
    const value = ink ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  return { width: image.width, height: image.height, data };
}

/**
 * ImageTracer emits one path per colour region. The white (background) region
 * is dropped — that is what would otherwise print as a solid rectangle — and
 * every surviving black subpath is forced to the canonical trace ink so the
 * result is a single flat shape regardless of any antialiasing imagetracerjs
 * introduced at the boundary.
 *
 * Known limitation: enclosed negative space (the hole in an "O", a door
 * handle) does not survive the trace. imagetracerjs's own boundary tracer
 * does not discover a small fully-enclosed same-colour region as a distinct
 * feature here — verified directly against its output at several tolerance
 * settings and colour counts, not assumed — so there is no hole geometry to
 * recover on our side; a shape like that traces as solid ink. A future fix
 * would mean replacing the tracing engine, not adjusting these options.
 */
function finalize(svg, width, height) {
  const kept = [];

  const pathRe = /<path\s+([^>]*?)\/?>/g;
  let match;
  while ((match = pathRe.exec(svg)) !== null) {
    const attrs = match[1];
    const fill = /fill="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const d = /\sd="([^"]*)"/.exec(attrs)?.[1];
    if (!d || !isBlack(fill)) continue;

    kept.push(...splitSubpaths(d));
  }

  const pathCount = kept.length;
  const body = pathCount > 0 ? `<path fill="${TRACE_INK}" d="${kept.join(' ')}"/>` : '';

  const out =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">${body}</svg>`;

  return {
    svg: out,
    width,
    height,
    palette: pathCount > 0 ? [{ color: TRACE_INK, paths: pathCount }] : [],
    pathCount,
  };
}

/** Splits a multi-contour `d` string into one string per closed subpath. */
function splitSubpaths(d) {
  return d.match(/M[^M]*/g) ?? [];
}

/**
 * Swaps the ink colour on an already-traced single-colour SVG. No re-tracing:
 * every path this module produces carries the exact literal
 * `fill="#000000"`, so this is a precise, safe substitution rather than a
 * general-purpose SVG recolour.
 */
export function recolorSvg(svg, hex) {
  const color = normalizeHex(hex);
  if (!color) throw Object.assign(new Error(`"${hex}" is not a colour.`), { status: 400 });
  return svg.replaceAll(`fill="${TRACE_INK}"`, `fill="${color}"`);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** True for imagetracerjs's rendering of pure black — its "ink" cluster here. */
function isBlack(fill) {
  if (/^#0{6}$/i.test(fill)) return true;
  const match = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,.*)?\)/i.exec(fill);
  return Boolean(match);
}

export { TRACE_INK };
