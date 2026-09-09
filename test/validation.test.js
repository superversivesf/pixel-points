import { describe, it, expect } from 'vitest';
import {
  sanitizeName, sanitizeDescription, isValidVote, normalizeCode,
  DECK, NUMERIC_DECK, CODE_ALPHABET,
} from '../server/validation.js';

describe('sanitizeName', () => {
  it('trims and allows normal names', () => {
    expect(sanitizeName('  Jason ')).toEqual({ ok: true, name: 'Jason' });
  });
  it('rejects empty', () => {
    expect(sanitizeName('   ')).toEqual({ ok: false, error: 'Name required' });
  });
  it('rejects non-strings', () => {
    expect(sanitizeName(42)).toEqual({ ok: false, error: 'Name required' });
  });
  it('strips control chars', () => {
    expect(sanitizeName('Ja\x00son\x1b')).toEqual({ ok: true, name: 'Jason' });
  });
  it('strips bidi and zero-width chars (visual spoofing)', () => {
    expect(sanitizeName('Boss\u200b')).toEqual({ ok: true, name: 'Boss' });
    expect(sanitizeName('a\u202eb')).toEqual({ ok: true, name: 'ab' });
    expect(sanitizeName('x\u2066y\u2069')).toEqual({ ok: true, name: 'xy' });
    expect(sanitizeName('n\ufeffm')).toEqual({ ok: true, name: 'nm' });
  });
  it('NFC-normalizes so visually identical names collide for dedup', () => {
    expect(sanitizeName('e\u0301').name).toBe(sanitizeName('\u00e9').name);
  });
  it('rejects a name that is only unsafe chars', () => {
    expect(sanitizeName('\u200b\u202e\ufeff')).toEqual({ ok: false, error: 'Name required' });
  });
  it('rejects over 24 chars', () => {
    expect(sanitizeName('a'.repeat(30))).toEqual({ ok: false, error: 'Name too long' });
  });
});

describe('sanitizeDescription', () => {
  it('truncates to 140', () => {
    expect(sanitizeDescription('a'.repeat(200)).length).toBe(140);
  });
  it('trims and strips control chars', () => {
    expect(sanitizeDescription(' h\x00i ')).toBe('hi');
  });
  it('strips bidi and zero-width chars', () => {
    expect(sanitizeDescription('hi\u200b\u202ethere')).toBe('hithere');
  });
  it('returns empty string for non-strings', () => {
    expect(sanitizeDescription(undefined)).toBe('');
  });
});

describe('isValidVote', () => {
  it('accepts every deck value and nothing else', () => {
    for (const v of DECK) expect(isValidVote(v)).toBe(true);
    expect(isValidVote('99')).toBe(false);
    expect(isValidVote('Coffee')).toBe(false);
    expect(isValidVote('')).toBe(false);
  });
  it('explicitly rejects non-strings', () => {
    expect(isValidVote(0)).toBe(false);
    expect(isValidVote(null)).toBe(false);
    expect(isValidVote({ toString: () => '0' })).toBe(false);
  });
});

describe('normalizeCode', () => {
  it('uppercases and filters to alphabet', () => {
    expect(normalizeCode('a c-d')).toBe('ACD');
  });
  it('empty for junk', () => {
    expect(normalizeCode('0OIl')).toBe('');
    expect(normalizeCode(123)).toBe('');
  });
  it('caps input length before processing', () => {
    expect(normalizeCode('a'.repeat(10000))).toBe('A'.repeat(16));
  });
});

describe('constants', () => {
  it('deck has 10 values; numeric deck is the 8 numbers', () => {
    expect(DECK).toEqual(['0','1','2','3','5','8','13','21','coffee','question']);
    expect(NUMERIC_DECK).toEqual(['0','1','2','3','5','8','13','21']);
  });
  it('code alphabet excludes ambiguous chars', () => {
    expect(CODE_ALPHABET).toBe('ACDEFGHJKMNPQRTUVWXY234679');
  });
});