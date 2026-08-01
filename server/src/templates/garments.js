import { normalizeHex } from '../lib/text.js';

/**
 * Built-in garment artwork.
 *
 * Shirt mockups are generated as vector silhouettes rather than shipped as
 * photographs, so any colour can be produced on demand (`?color=#1b3a5c`)
 * without stocking a photo per colourway. A user-added shirt type can instead
 * carry real photographs — see the `photo` source in the shirts route.
 *
 * Canvas is a fixed 1000 x 1250 so print areas can be expressed once, in the
 * same coordinate space, for both views.
 */

export const CANVAS = { width: 1000, height: 1250 };
const CX = CANVAS.width / 2;

/**
 * Builds a closed path from a point list.
 *
 * Each point may carry `r` to round the corner, and `bow` to bend the segment
 * that *leaves* it — positive bows outward from the garment centre, negative
 * scoops inward (armholes, necklines). Corners plus bows describe every
 * silhouette here as plain numbers that stay easy to tune.
 */
function roundedPath(points) {
  const n = points.length;
  const parts = [];

  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const radius = curr.r ?? 0;

    let exit = curr;
    if (radius > 0) {
      const inVec = unit(curr.x - prev.x, curr.y - prev.y);
      const outVec = unit(next.x - curr.x, next.y - curr.y);
      const inLen = Math.min(radius, dist(prev, curr) / 2);
      const outLen = Math.min(radius, dist(curr, next) / 2);
      const start = { x: curr.x - inVec.x * inLen, y: curr.y - inVec.y * inLen };
      exit = { x: curr.x + outVec.x * outLen, y: curr.y + outVec.y * outLen };

      parts.push(`${i === 0 ? 'M' : 'L'}${round(start.x)} ${round(start.y)}`);
      parts.push(`Q${round(curr.x)} ${round(curr.y)} ${round(exit.x)} ${round(exit.y)}`);
    } else {
      parts.push(`${i === 0 ? 'M' : 'L'}${round(curr.x)} ${round(curr.y)}`);
    }

    if (curr.bow) {
      const target = nextEntryPoint(points, i);
      const midX = (exit.x + target.x) / 2;
      const midY = (exit.y + target.y) / 2;
      const normal = unit(-(target.y - exit.y), target.x - exit.x);
      // Flip the normal so a positive bow always pushes away from the centre.
      const sign = (midX - CX) * normal.x >= 0 ? 1 : -1;
      parts.push(
        `Q${round(midX + normal.x * curr.bow * sign)} ${round(midY + normal.y * curr.bow * sign)} ${round(target.x)} ${round(target.y)}`,
      );
    }
  }

  return `${parts.join('')}Z`;
}

/** Where the next segment actually begins, accounting for its corner rounding. */
function nextEntryPoint(points, i) {
  const n = points.length;
  const curr = points[i];
  const next = points[(i + 1) % n];
  const after = points[(i + 2) % n];
  const radius = next.r ?? 0;
  if (radius <= 0) return next;
  const inVec = unit(next.x - curr.x, next.y - curr.y);
  const inLen = Math.min(radius, dist(curr, next) / 2, dist(next, after) / 2);
  return { x: next.x - inVec.x * inLen, y: next.y - inVec.y * inLen };
}

function unit(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(value) {
  return Number.parseFloat(value.toFixed(1));
}

/**
 * Mirrors the half-outline. A `bow` belongs to the segment *leaving* its point,
 * so reversing the traversal order also shifts each bow back by one point.
 */
function mirror(points) {
  const out = [];
  for (let k = 0; k < points.length; k += 1) {
    const point = points[points.length - 1 - k];
    const leaving = points[points.length - 2 - k];
    out.push({ x: CANVAS.width - point.x, y: point.y, r: point.r, bow: leaving?.bow });
  }
  return out;
}

/**
 * Sleeve geometry.
 *
 * The sleeve is built off an axis running from the middle of the armhole
 * outwards, so length, splay and cuff width are three independent numbers and
 * a short sleeve, a splayed long sleeve and a raglan all stay in proportion.
 */
function sleeveCorners(shape) {
  const shoulder = { x: CX - shape.shoulderHalfW, y: shape.shoulderY + 16 };
  const armpit = { x: CX - shape.chestHalfW, y: shape.shoulderY + shape.armpitDrop };
  const theta = (shape.sleeveAngle * Math.PI) / 180;

  // Axis points down and away from the body by `sleeveAngle` degrees.
  const axis = { x: -Math.sin(theta), y: Math.cos(theta) };
  const perp = { x: -axis.y, y: axis.x };
  const mid = { x: (shoulder.x + armpit.x) / 2, y: (shoulder.y + armpit.y) / 2 };
  const cuffMid = { x: mid.x + axis.x * shape.sleeveLength, y: mid.y + axis.y * shape.sleeveLength };

  return {
    shoulder,
    armpit,
    outer: { x: cuffMid.x + perp.x * shape.cuffHalfW, y: cuffMid.y + perp.y * shape.cuffHalfW },
    inner: { x: cuffMid.x - perp.x * shape.cuffHalfW, y: cuffMid.y - perp.y * shape.cuffHalfW },
  };
}

/**
 * Half-silhouette (left side, neck -> hem). The right half is mirrored, which
 * guarantees a symmetric garment.
 */
function halfOutline(shape) {
  const { shoulderY, shoulderHalfW, neckHalfW, chestHalfW, waistHalfW, hemY, sleeve } = shape;
  const points = [{ x: CX - neckHalfW, y: shoulderY - 6, r: 0 }];

  if (sleeve === 'none') {
    // Tank: a narrow strap dropping into a deep scooped armhole.
    points.push({ x: CX - shoulderHalfW, y: shoulderY + 24, r: 26, bow: -shape.armholeScoop });
    points.push({ x: CX - chestHalfW, y: shoulderY + shape.armpitDrop, r: 30 });
  } else {
    const { shoulder, outer, inner, armpit } = sleeveCorners(shape);
    points.push({ x: shoulder.x, y: shoulder.y, r: 26, bow: 14 });
    points.push({ x: outer.x, y: outer.y, r: 22 });
    points.push({ x: inner.x, y: inner.y, r: 22, bow: -12 });
    points.push({ x: armpit.x, y: armpit.y, r: 26 });
  }

  points.push({ x: CX - waistHalfW, y: hemY, r: 24 });
  return points;
}

function outlinePath(shape) {
  const half = halfOutline(shape);
  return roundedPath([...half, ...mirror(half)]);
}

/** Neckline opening, subtracted from the body so the backdrop shows through. */
function necklinePath(shape, view) {
  const { shoulderY, neckHalfW, neckDepthFront, neckDepthBack, collar } = shape;
  const depth = view === 'back' ? neckDepthBack : neckDepthFront;
  const halfW = view === 'back' ? neckHalfW * 0.98 : neckHalfW;

  if (collar === 'v' && view === 'front') {
    return (
      `M${CX - halfW} ${shoulderY}` +
      `Q${CX - halfW * 0.5} ${shoulderY + depth * 0.35} ${CX} ${shoulderY + depth}` +
      `Q${CX + halfW * 0.5} ${shoulderY + depth * 0.35} ${CX + halfW} ${shoulderY}` +
      `Q${CX} ${shoulderY - 26} ${CX - halfW} ${shoulderY}Z`
    );
  }

  return (
    `M${CX - halfW} ${shoulderY}` +
    `C${CX - halfW} ${shoulderY + depth * 1.35} ${CX + halfW} ${shoulderY + depth * 1.35} ${CX + halfW} ${shoulderY}` +
    `C${CX + halfW} ${shoulderY - depth * 0.55} ${CX - halfW} ${shoulderY - depth * 0.55} ${CX - halfW} ${shoulderY}Z`
  );
}

/** Seam and fold lines that sell the mockup as fabric rather than a flat shape. */
function detailPaths(shape, view) {
  const { shoulderY, waistHalfW, hemY, sleeve } = shape;
  const lines = [];

  // Hem stitching.
  const hemLine = hemY - 26;
  lines.push(
    `M${CX - waistHalfW + 14} ${hemLine}Q${CX} ${hemLine + 14} ${CX + waistHalfW - 14} ${hemLine}`,
  );

  if (sleeve !== 'none') {
    const { shoulder, outer, inner, armpit } = sleeveCorners(shape);
    // Cuff hem, parallel to the sleeve opening and inset by a stitch width.
    const inset = 30;
    const axis = unit(outer.x - shoulder.x, outer.y - shoulder.y);
    const cuffOuter = { x: outer.x - axis.x * inset, y: outer.y - axis.y * inset };
    const cuffInner = { x: inner.x - axis.x * inset * 0.8, y: inner.y - axis.y * inset * 0.8 };
    lines.push(segment(cuffOuter, cuffInner, 10), mirrorSegment(segment(cuffOuter, cuffInner, 10)));

    // Armhole seam, from the shoulder down to the armpit.
    const seam = `M${round(shoulder.x + 12)} ${round(shoulder.y - 6)}Q${round(armpit.x - 26)} ${round((shoulder.y + armpit.y) / 2)} ${round(armpit.x + 6)} ${round(armpit.y)}`;
    lines.push(seam, mirrorSegment(seam));
  }

  if (view === 'back') {
    // Yoke seam across the shoulder blades.
    lines.push(`M${CX - 160} ${shoulderY + 34}Q${CX} ${shoulderY + 58} ${CX + 160} ${shoulderY + 34}`);
  }

  return lines;
}

function segment(from, to, bow = 0) {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const normal = unit(-(to.y - from.y), to.x - from.x);
  return `M${round(from.x)} ${round(from.y)}Q${round(midX + normal.x * bow)} ${round(midY + normal.y * bow)} ${round(to.x)} ${round(to.y)}`;
}

/** Reflects an already-built path string across the canvas centre line. */
function mirrorSegment(path) {
  return path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${round(CANVAS.width - Number(x))} ${y}`);
}

const TEE = {
  shoulderY: 210,
  shoulderHalfW: 306,
  neckHalfW: 108,
  neckDepthFront: 58,
  neckDepthBack: 28,
  chestHalfW: 322,
  waistHalfW: 312,
  hemY: 1120,
  armpitDrop: 330,
  sleeve: 'short',
  sleeveAngle: 26,
  sleeveLength: 190,
  cuffHalfW: 96,
  armholeScoop: 0,
  collar: 'crew',
};

const SHAPES = {
  tee: { ...TEE },
  vneck: { ...TEE, neckHalfW: 116, neckDepthFront: 150, collar: 'v' },
  longsleeve: {
    ...TEE,
    sleeve: 'long',
    sleeveAngle: 22,
    sleeveLength: 620,
    cuffHalfW: 72,
  },
  tank: {
    ...TEE,
    shoulderHalfW: 186,
    neckHalfW: 116,
    neckDepthFront: 92,
    neckDepthBack: 58,
    chestHalfW: 292,
    waistHalfW: 284,
    armpitDrop: 380,
    sleeve: 'none',
    armholeScoop: 78,
  },
  crewneck: {
    ...TEE,
    shoulderY: 206,
    shoulderHalfW: 322,
    neckHalfW: 120,
    neckDepthFront: 62,
    chestHalfW: 340,
    waistHalfW: 330,
    hemY: 1090,
    sleeve: 'long',
    sleeveAngle: 20,
    sleeveLength: 600,
    cuffHalfW: 78,
  },
  hoodie: {
    ...TEE,
    shoulderY: 262,
    shoulderHalfW: 326,
    neckHalfW: 126,
    neckDepthFront: 68,
    chestHalfW: 344,
    waistHalfW: 334,
    hemY: 1110,
    sleeve: 'long',
    sleeveAngle: 20,
    sleeveLength: 580,
    cuffHalfW: 80,
    hood: true,
    pocket: true,
  },
  polo: { ...TEE, neckHalfW: 100, collar: 'polo', placket: true },
  workshirt: {
    ...TEE,
    shoulderHalfW: 318,
    chestHalfW: 336,
    waistHalfW: 328,
    hemY: 1140,
    sleeveLength: 210,
    cuffHalfW: 104,
    chestPocket: true,
  },
};

/** Extra garment furniture drawn on top of the body. */
function accessories(shape, view, palette) {
  const parts = [];

  if (shape.hood) {
    const top = shape.shoulderY - 132;
    // A hood bunched behind the neck: wide and low, not a sphere.
    parts.push(
      `<path d="M${CX - 246} ${shape.shoulderY + 58}C${CX - 258} ${top} ${CX + 258} ${top} ${CX + 246} ${shape.shoulderY + 58}C${CX + 150} ${shape.shoulderY + 128} ${CX - 150} ${shape.shoulderY + 128} ${CX - 246} ${shape.shoulderY + 58}Z" fill="${palette.shade}" stroke="${palette.edge}" stroke-width="3"/>`,
    );
    if (view === 'front') {
      parts.push(
        `<path d="M${CX - 176} ${shape.shoulderY + 34}C${CX - 120} ${shape.shoulderY + 128} ${CX + 120} ${shape.shoulderY + 128} ${CX + 176} ${shape.shoulderY + 34}" fill="none" stroke="${palette.line}" stroke-width="7"/>`,
        `<path d="M${CX - 32} ${shape.shoulderY + 96}v206" stroke="${palette.line}" stroke-width="9" stroke-linecap="round" fill="none"/>`,
        `<path d="M${CX + 32} ${shape.shoulderY + 96}v226" stroke="${palette.line}" stroke-width="9" stroke-linecap="round" fill="none"/>`,
      );
    }
  }

  if (shape.pocket && view === 'front') {
    parts.push(
      `<path d="M${CX - 218} 820h436v168h-436Z" fill="none" stroke="${palette.line}" stroke-width="6"/>`,
    );
  }

  if (shape.placket && view === 'front') {
    const top = shape.shoulderY + shape.neckDepthFront;
    parts.push(
      `<path d="M${CX - 34} ${top}h68v250h-68Z" fill="none" stroke="${palette.line}" stroke-width="6"/>`,
      `<circle cx="${CX}" cy="${top + 70}" r="9" fill="${palette.line}"/>`,
      `<circle cx="${CX}" cy="${top + 170}" r="9" fill="${palette.line}"/>`,
    );
  }

  if (shape.collar === 'polo' && view === 'front') {
    parts.push(
      `<path d="M${CX - 118} ${shape.shoulderY - 6}L${CX - 20} ${shape.shoulderY + 128}L${CX - 130} ${shape.shoulderY + 74}Z" fill="${palette.shade}"/>`,
      `<path d="M${CX + 118} ${shape.shoulderY - 6}L${CX + 20} ${shape.shoulderY + 128}L${CX + 130} ${shape.shoulderY + 74}Z" fill="${palette.shade}"/>`,
    );
  }

  if (shape.chestPocket && view === 'front') {
    parts.push(
      `<path d="M${CX + 90} 470h172v150l-86 34l-86-34Z" fill="none" stroke="${palette.line}" stroke-width="6"/>`,
    );
  }

  return parts.join('');
}

function paletteFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Light garments need darker seams; dark garments need lighter ones.
  const mix = (target, amount) => rgbToHex(blend({ r, g, b }, target, amount));
  const dark = { r: 0, g: 0, b: 0 };
  const light = { r: 255, g: 255, b: 255 };

  return {
    body: hex,
    shade: luminance > 0.55 ? mix(dark, 0.09) : mix(light, 0.09),
    line: luminance > 0.55 ? mix(dark, 0.24) : mix(light, 0.26),
    edge: luminance > 0.55 ? mix(dark, 0.18) : mix(light, 0.2),
  };
}

function blend(from, to, amount) {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

function hexToRgb(hex) {
  const int = Number.parseInt(hex.slice(1), 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {string} shapeId key of SHAPES
 * @param {object} [options]
 * @param {'front'|'back'} [options.view]
 * @param {string} [options.color] garment colour as hex
 * @param {boolean} [options.printArea] draw the printable-area guide
 * @param {{x:number,y:number,width:number,height:number}} [options.area]
 */
export function renderGarment(shapeId, options = {}) {
  const shape = SHAPES[shapeId] ?? SHAPES.tee;
  const view = options.view === 'back' ? 'back' : 'front';
  const color = normalizeHex(options.color) ?? '#f4f4f5';
  const palette = paletteFor(color);
  const id = `g${Math.abs(hashCode(`${shapeId}${view}${color}`))}`;

  const body = outlinePath(shape);
  const neck = necklinePath(shape, view);
  const details = detailPaths(shape, view)
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${palette.line}" stroke-width="5" stroke-linecap="round" opacity="0.75"/>`,
    )
    .join('');

  const guide =
    options.printArea && options.area
      ? `<rect x="${options.area.x}" y="${options.area.y}" width="${options.area.width}" height="${options.area.height}" fill="none" stroke="#2f6df6" stroke-width="4" stroke-dasharray="14 12" opacity="0.85"/>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">
<defs>
<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="${palette.shade}" stop-opacity="0.7"/>
<stop offset="0.34" stop-color="${palette.shade}" stop-opacity="0"/>
<stop offset="0.66" stop-color="${palette.shade}" stop-opacity="0"/>
<stop offset="1" stop-color="${palette.shade}" stop-opacity="0.7"/>
</linearGradient>
<clipPath id="${id}c"><path d="${body}"/></clipPath>
</defs>
<g>
<path d="${body}" fill="${color}" stroke="${palette.edge}" stroke-width="3"/>
<rect x="0" y="0" width="${CANVAS.width}" height="${CANVAS.height}" fill="url(#${id}s)" clip-path="url(#${id}c)"/>
${accessories(shape, view, palette)}
${details}
<path d="${neck}" fill="#ffffff" fill-opacity="0" stroke="${palette.line}" stroke-width="16"/>
</g>
${guide}
</svg>`;
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

export const GARMENT_SHAPES = Object.keys(SHAPES);
export { SHAPES };
