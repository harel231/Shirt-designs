import { loadFont } from './fonts.js';

/**
 * Text -> vector outlines.
 *
 * Every piece of text in a design is converted to filled paths rather than
 * live text. That is what a print vendor expects: outlined type needs no font
 * licence at the printer, cannot reflow or substitute, and RIPs identically on
 * every machine.
 */

const DEFAULTS = {
  size: 72,
  letterSpacing: 0,
  lineHeight: 1.2,
  align: 'center',
  color: '#111111',
  arc: 0,
};

export async function textToVector(input) {
  const options = { ...DEFAULTS, ...input };
  const text = String(options.text ?? '');
  if (!text.trim()) {
    throw Object.assign(new Error('Text is empty.'), { status: 400 });
  }

  const { font, family, weight, italic } = await loadFont(options.family ?? 'Roboto', {
    weight: options.weight,
    italic: options.italic,
  });

  const size = clamp(Number(options.size) || DEFAULTS.size, 4, 2000);
  const scale = size / font.unitsPerEm;
  const letterSpacing = Number(options.letterSpacing) || 0;
  const lineHeight = clamp(Number(options.lineHeight) || DEFAULTS.lineHeight, 0.5, 4) * size;
  const arc = clamp(Number(options.arc) || 0, -300, 300);
  const align = ['left', 'center', 'right'].includes(options.align) ? options.align : 'center';
  const color = normalizeHex(options.color) ?? DEFAULTS.color;

  const lines = text.split('\n').map((line) => measureLine(font, line, scale, size, letterSpacing));
  const blockWidth = Math.max(1, ...lines.map((line) => line.width));

  const ascent = font.ascender * scale;
  const descent = Math.abs(font.descender) * scale;

  const commands = [];
  lines.forEach((line, index) => {
    const baseline = ascent + index * lineHeight;
    const offset =
      align === 'left' ? 0 : align === 'right' ? blockWidth - line.width : (blockWidth - line.width) / 2;
    if (arc === 0) placeStraight(commands, line, offset, baseline);
    else placeOnArc(commands, line, offset, baseline, arc);
  });

  const box = boundsOf(commands);
  const height = lines.length === 1 ? ascent + descent : (lines.length - 1) * lineHeight + ascent + descent;
  const layoutBox = box ?? { x: 0, y: 0, width: blockWidth, height };

  // Normalise so the artwork starts at the origin: downstream placement on the
  // shirt is easier when a shape's own box is its coordinate system.
  const shifted = translate(commands, -layoutBox.x, -layoutBox.y);
  const width = Math.max(1, Math.ceil(layoutBox.width));
  const outHeight = Math.max(1, Math.ceil(layoutBox.height));

  const pathData = toPathData(shifted);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${outHeight}" ` +
    `viewBox="0 0 ${width} ${outHeight}"><path fill="${color}" d="${pathData}"/></svg>`;

  return {
    svg,
    pathData,
    width,
    outlined: true,
    height: outHeight,
    color,
    font: { family, weight, italic, size },
    lineCount: lines.length,
    glyphCount: lines.reduce((sum, line) => sum + line.glyphs.length, 0),
  };
}

function measureLine(font, line, scale, size, letterSpacing) {
  const glyphs = font.stringToGlyphs(line);
  const placed = [];
  let x = 0;

  glyphs.forEach((glyph, index) => {
    const advance = glyph.advanceWidth * scale;
    placed.push({ glyph, x, advance });
    x += advance + letterSpacing;
    const next = glyphs[index + 1];
    if (next && typeof font.getKerningValue === 'function') {
      x += font.getKerningValue(glyph, next) * scale;
    }
  });

  // The trailing letter-spacing slot is not part of the visible line.
  const width = Math.max(0, x - (glyphs.length ? letterSpacing : 0));
  return { glyphs: placed, width, size };
}

function placeStraight(commands, line, offsetX, baseline) {
  for (const { glyph, x } of line.glyphs) {
    commands.push(...glyph.getPath(offsetX + x, baseline, line.size).commands);
  }
}

/**
 * Arched / curved type — the classic collegiate shirt front. Each glyph is
 * rotated onto a circle whose arc length equals the straight line width, so
 * letter spacing stays even around the bend.
 */
function placeOnArc(commands, line, offsetX, baseline, arcDegrees) {
  const arcRadians = (Math.abs(arcDegrees) * Math.PI) / 180;
  const radius = line.width / arcRadians;
  const up = arcDegrees > 0;
  const centerX = offsetX + line.width / 2;
  // Circle centre sits below the baseline for an upward arch, above for a dip.
  const circleY = up ? baseline + radius : baseline - radius;

  for (const { glyph, x, advance } of line.glyphs) {
    const centerOffset = x + advance / 2 - line.width / 2;
    const theta = (centerOffset / radius) * (up ? 1 : -1);
    const px = centerX + radius * Math.sin(theta) * (up ? 1 : -1);
    const py = up ? circleY - radius * Math.cos(theta) : circleY + radius * Math.cos(theta);
    const rotation = up ? theta : -theta;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    // One matrix per glyph: centre it on its own advance, spin it to the arc
    // tangent, then drop it at the point on the circle. SVG's matrix(a,b,c,d,e,f)
    // in a y-down space turns clockwise for a positive angle.
    const path = glyph.getPath(0, 0, line.size);
    commands.push(
      ...transform(path.commands, [
        cos,
        sin,
        -sin,
        cos,
        px - (cos * advance) / 2,
        py - (sin * advance) / 2,
      ]),
    );
  }
}

function transform(commands, [a, b, c, d, e, f]) {
  const point = (x, y) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  return commands.map((cmd) => {
    if (cmd.type === 'Z') return { type: 'Z' };
    const out = { type: cmd.type };
    if (cmd.x1 !== undefined) {
      const p = point(cmd.x1, cmd.y1);
      out.x1 = p.x;
      out.y1 = p.y;
    }
    if (cmd.x2 !== undefined) {
      const p = point(cmd.x2, cmd.y2);
      out.x2 = p.x;
      out.y2 = p.y;
    }
    const p = point(cmd.x, cmd.y);
    out.x = p.x;
    out.y = p.y;
    return out;
  });
}

function translate(commands, dx, dy) {
  return transform(commands, [1, 0, 0, 1, dx, dy]);
}

function boundsOf(commands) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const cmd of commands) {
    if (cmd.type === 'Z') continue;
    // Control points bound the curve, so this box is a safe superset.
    if (cmd.x1 !== undefined) visit(cmd.x1, cmd.y1);
    if (cmd.x2 !== undefined) visit(cmd.x2, cmd.y2);
    visit(cmd.x, cmd.y);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function toPathData(commands, decimals = 2) {
  const n = (value) => Number.parseFloat(value.toFixed(decimals));
  return commands
    .map((cmd) => {
      switch (cmd.type) {
        case 'M':
          return `M${n(cmd.x)} ${n(cmd.y)}`;
        case 'L':
          return `L${n(cmd.x)} ${n(cmd.y)}`;
        case 'C':
          return `C${n(cmd.x1)} ${n(cmd.y1)} ${n(cmd.x2)} ${n(cmd.y2)} ${n(cmd.x)} ${n(cmd.y)}`;
        case 'Q':
          return `Q${n(cmd.x1)} ${n(cmd.y1)} ${n(cmd.x)} ${n(cmd.y)}`;
        case 'Z':
          return 'Z';
        default:
          return '';
      }
    })
    .join('');
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function normalizeHex(value) {
  const raw = String(value ?? '').trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    return `#${short[1]
      .split('')
      .map((c) => c + c)
      .join('')}`.toLowerCase();
  }
  const long = /^#?([0-9a-f]{6})$/i.exec(raw);
  return long ? `#${long[1].toLowerCase()}` : null;
}
