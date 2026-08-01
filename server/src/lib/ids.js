import { customAlphabet } from 'nanoid';

// Unambiguous alphabet: no 0/O or 1/l, so share codes survive being read aloud
// down a phone line to a print shop.
const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';

const short = customAlphabet(alphabet, 10);
const token = customAlphabet(alphabet, 22);

export function newId(prefix) {
  return `${prefix}_${short()}`;
}

export function newShareToken() {
  return token();
}
