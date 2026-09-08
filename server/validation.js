export const DECK = ['0', '1', '2', '3', '5', '8', '13', '21', 'coffee', 'question'];
export const NUMERIC_DECK = ['0', '1', '2', '3', '5', '8', '13', '21'];
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY234679';

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Name required' };
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return { ok: false, error: 'Name required' };
  if (name.length > 24) return { ok: false, error: 'Name too long' };
  return { ok: true, name };
}

export function sanitizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140);
}

export function isValidVote(v) {
  return DECK.includes(v);
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const re = new RegExp(`[^${CODE_ALPHABET}]`, 'g');
  return raw.toUpperCase().replace(re, '');
}