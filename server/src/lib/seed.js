import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, encodePng, letterbox } from './image.js';
import { newId } from './ids.js';
import { BUNDLED_DATA_DIR, SHIRTS_DIR } from './paths.js';
import { CANVAS } from '../templates/garments.js';
import { db } from './store.js';

/**
 * The starting shirt catalog: real garments the studio photographed, not
 * generated silhouettes. Each entry ships a front and back photo under
 * data/stock-shirts/ and is seeded as a `photo`-sourced shirt type, the same
 * shape the app produces when a user adds their own garment from photos — see
 * POST /api/shirts.
 */

const STOCK_DIR = join(BUNDLED_DATA_DIR, 'stock-shirts');

/**
 * Print area shared by every stock garment: a 12" x 16" chest print,
 * positioned in canvas pixels. Matches the default a freshly photographed
 * shirt gets in the shirts route — adjustable per shirt afterwards from the
 * app ("Adjust print area").
 */
const DEFAULT_AREA = {
  front: { x: 307, y: 366, width: 386, height: 515, widthIn: 12, heightIn: 16 },
  back: { x: 307, y: 336, width: 386, height: 515, widthIn: 12, heightIn: 16 },
};

const STOCK_GARMENTS = [
  {
    slug: 'carhartt-pocket-tan',
    name: 'Carhartt Pocket Tee — Tan',
    brand: 'Carhartt',
    colorName: 'Tan',
    colorHex: '#96876f',
  },
  {
    slug: 'boxy-tee-black',
    name: 'Boxy Tee — Black',
    brand: '',
    colorName: 'Black',
    colorHex: '#1a1a1a',
  },
  {
    slug: 'boxy-tee-white',
    name: 'Boxy Tee — White',
    brand: '',
    colorName: 'White',
    colorHex: '#f5f5f5',
  },
  {
    slug: 'carhartt-pocket-black',
    name: 'Carhartt Pocket Tee — Black',
    brand: 'Carhartt',
    colorName: 'Black',
    colorHex: '#1a1a1a',
  },
  {
    slug: 'carhartt-pocket-white',
    name: 'Carhartt Pocket Tee — White',
    brand: 'Carhartt',
    colorName: 'White',
    colorHex: '#f7f7f5',
  },
  {
    slug: 'classic-tee-pink',
    name: 'Classic Tee — Pink',
    brand: '',
    colorName: 'Pink',
    colorHex: '#f6cdd3',
  },
  {
    slug: 'saucony-performance-black',
    name: 'Saucony Performance Tee — Black',
    brand: 'Saucony',
    colorName: 'Black',
    colorHex: '#202020',
  },
  {
    slug: 'military-tee-olive',
    name: 'Military Tee — Olive',
    brand: '',
    colorName: 'Olive',
    colorHex: '#6b6b47',
  },
];

/** Decodes a bundled stock photo and letterboxes it onto the shared canvas. */
function storeStockImage(shirtId, colorwayId, view, slug) {
  const buffer = readFileSync(join(STOCK_DIR, `${slug}-${view}.jpg`));
  const image = letterbox(decode(buffer), CANVAS);
  const file = `${shirtId}-${colorwayId}-${view}.png`;
  writeFileSync(join(SHIRTS_DIR, file), encodePng(image));
  return file;
}

export function seedShirtCatalog() {
  if (db.all('shirtTypes').length > 0) return { seeded: 0 };

  const now = new Date().toISOString();
  for (const garment of STOCK_GARMENTS) {
    const id = newId('shirt');
    const colorwayId = newId('color');
    const views = {
      front: storeStockImage(id, colorwayId, 'front', garment.slug),
      back: storeStockImage(id, colorwayId, 'back', garment.slug),
    };

    db.insert('shirtTypes', {
      id,
      name: garment.name,
      brand: garment.brand,
      category: 'T-shirt',
      source: 'photo',
      shape: null,
      builtIn: true,
      printAreas: structuredClone(DEFAULT_AREA),
      colorways: [
        {
          id: colorwayId,
          name: garment.colorName,
          hex: garment.colorHex,
          source: 'photo',
          views,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }

  return { seeded: STOCK_GARMENTS.length };
}

export { STOCK_GARMENTS, DEFAULT_AREA };
