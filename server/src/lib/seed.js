import { db } from './store.js';
import { newId } from './ids.js';

/**
 * The starting shirt catalog.
 *
 * These are generic blank-garment templates, not any brand's actual product.
 * Real products (a specific Carhartt or Saucony style) are added by the user
 * from the app, with their own photographs and measured print areas — see
 * POST /api/shirts.
 */

const STOCK_COLORS = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Black', hex: '#141414' },
  { name: 'Athletic Heather', hex: '#c9ccd1' },
  { name: 'Navy', hex: '#1f2a44' },
  { name: 'Red', hex: '#c8102e' },
  { name: 'Royal', hex: '#1b4fa0' },
  { name: 'Forest', hex: '#1f4032' },
  { name: 'Sand', hex: '#d9c9a8' },
  { name: 'Maroon', hex: '#5a1a2b' },
  { name: 'Military Green', hex: '#4b5320' },
];

/**
 * Print areas are given in canvas pixels (where they sit on the mockup) and in
 * inches (their true printed size). Both are needed: the first positions the
 * artwork on the mockup, the second scales the production PDF.
 */
const TEMPLATES = [
  {
    name: 'Classic Tee',
    category: 'T-shirt',
    shape: 'tee',
    printAreas: {
      front: { x: 307, y: 366, width: 386, height: 515, widthIn: 12, heightIn: 16 },
      back: { x: 307, y: 336, width: 386, height: 515, widthIn: 12, heightIn: 16 },
    },
  },
  {
    name: 'V-Neck Tee',
    category: 'T-shirt',
    shape: 'vneck',
    printAreas: {
      front: { x: 307, y: 430, width: 386, height: 450, widthIn: 12, heightIn: 14 },
      back: { x: 307, y: 336, width: 386, height: 515, widthIn: 12, heightIn: 16 },
    },
  },
  {
    name: 'Long Sleeve Tee',
    category: 'T-shirt',
    shape: 'longsleeve',
    printAreas: {
      front: { x: 307, y: 366, width: 386, height: 515, widthIn: 12, heightIn: 16 },
      back: { x: 307, y: 336, width: 386, height: 515, widthIn: 12, heightIn: 16 },
    },
  },
  {
    name: 'Tank Top',
    category: 'Tank',
    shape: 'tank',
    printAreas: {
      front: { x: 338, y: 420, width: 324, height: 454, widthIn: 10, heightIn: 14 },
      back: { x: 338, y: 400, width: 324, height: 454, widthIn: 10, heightIn: 14 },
    },
  },
  {
    name: 'Crewneck Sweatshirt',
    category: 'Fleece',
    shape: 'crewneck',
    printAreas: {
      front: { x: 296, y: 380, width: 408, height: 476, widthIn: 12, heightIn: 14 },
      back: { x: 296, y: 356, width: 408, height: 476, widthIn: 12, heightIn: 14 },
    },
  },
  {
    name: 'Pullover Hoodie',
    category: 'Fleece',
    shape: 'hoodie',
    // The kangaroo pocket caps how low a front print can go.
    printAreas: {
      front: { x: 296, y: 430, width: 408, height: 374, widthIn: 12, heightIn: 11 },
      back: { x: 296, y: 400, width: 408, height: 476, widthIn: 12, heightIn: 14 },
    },
  },
  {
    name: 'Polo Shirt',
    category: 'Polo',
    shape: 'polo',
    // Polos are normally decorated left-chest only; the placket blocks the centre.
    printAreas: {
      front: { x: 560, y: 380, width: 129, height: 129, widthIn: 4, heightIn: 4 },
      back: { x: 307, y: 336, width: 386, height: 450, widthIn: 12, heightIn: 14 },
    },
  },
  {
    name: 'Heavyweight Work Shirt',
    category: 'Workwear',
    shape: 'workshirt',
    printAreas: {
      front: { x: 307, y: 380, width: 386, height: 450, widthIn: 12, heightIn: 14 },
      back: { x: 296, y: 350, width: 408, height: 515, widthIn: 12, heightIn: 16 },
    },
  },
];

export function seedShirtCatalog() {
  if (db.all('shirtTypes').length > 0) return { seeded: 0 };

  const now = new Date().toISOString();
  for (const template of TEMPLATES) {
    db.insert('shirtTypes', {
      id: newId('shirt'),
      name: template.name,
      brand: '',
      category: template.category,
      source: 'template',
      shape: template.shape,
      builtIn: true,
      printAreas: template.printAreas,
      colorways: STOCK_COLORS.map((color) => ({
        id: newId('color'),
        name: color.name,
        hex: color.hex,
        source: 'template',
      })),
      createdAt: now,
      updatedAt: now,
    });
  }

  return { seeded: TEMPLATES.length };
}

export { STOCK_COLORS, TEMPLATES };
