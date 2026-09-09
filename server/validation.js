export const DECK = ['0', '1', '2', '3', '5', '8', '13', '21', 'coffee', 'question'];
export const NUMERIC_DECK = ['0', '1', '2', '3', '5', '8', '13', '21'];
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY234679';

// Strip ASCII control chars, bidi/paragraph controls, and zero-width/format
// characters (U+200B-U+200F, U+2028-U+202E, U+2060-U+206F, U+FEFF) that enable
// visually-spoofed or colliding display names.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Name required' };
  const name = raw.replace(UNSAFE_CHARS, '').normalize('NFC').trim();
  if (!name) return { ok: false, error: 'Name required' };
  if (name.length > 24) return { ok: false, error: 'Name too long' };
  return { ok: true, name };
}

export function sanitizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(UNSAFE_CHARS, '').normalize('NFC').trim().slice(0, 140);
}

export function isValidVote(v) {
  return typeof v === 'string' && DECK.includes(v);
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const re = new RegExp(`[^${CODE_ALPHABET}]`, 'g');
  return raw.slice(0, 16).toUpperCase().replace(re, '');
}