import { describe, it, expect } from 'vitest';
import { _internal } from '../server/index.js';

const { normalizeIp, parseProxyList, isTrustedProxy, ipInCidr } = _internal;

describe('normalizeIp', () => {
  it('strips ipv6-mapped ipv4', () => {
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });
  it('lowercases and trims', () => {
    expect(normalizeIp('  ABC::DEF ')).toBe('abc::def');
  });
  it('null for junk', () => {
    expect(normalizeIp(null)).toBe(null);
    expect(normalizeIp('   ')).toBe(null);
  });
});

describe('parseProxyList', () => {
  it('null on empty', () => {
    expect(parseProxyList('')).toBe(null);
    expect(parseProxyList(' ,  ')).toBe(null);
  });
  it('parses exact ips and cidrs', () => {
    expect(parseProxyList('127.0.0.1, ::1, 172.16.0.0/12')).toEqual([
      { base: '127.0.0.1', bits: null },
      { base: '::1', bits: null },
      { base: '172.16.0.0', bits: 12 },
    ]);
  });
  it('normalizes mapped ipv4 in cidr base', () => {
    expect(parseProxyList('::ffff:10.1.2.0/24')).toEqual([
      { base: '10.1.2.0', bits: 24 },
    ]);
  });
});

describe('isTrustedProxy', () => {
  it('exact matches', () => {
    const list = parseProxyList('127.0.0.1,::1');
    expect(isTrustedProxy('127.0.0.1', list)).toBe(true);
    expect(isTrustedProxy('::1', list)).toBe(true);
    expect(isTrustedProxy('10.0.0.16', list)).toBe(false);
  });
  it('mapped ipv4 normalizes to exact match', () => {
    const list = parseProxyList('192.168.1.1');
    expect(isTrustedProxy('::ffff:192.168.1.1', list)).toBe(true);
  });
  it('ipv4 cidr match', () => {
    const list = parseProxyList('172.16.0.0/12');
    expect(isTrustedProxy('172.17.0.2', list)).toBe(true);
    expect(isTrustedProxy('172.32.0.1', list)).toBe(false);
    expect(isTrustedProxy('192.168.0.1', list)).toBe(false);
  });
  it('ipv6 cidr match', () => {
    const list = parseProxyList('fd00::/8');
    expect(isTrustedProxy('fd12:3456::1', list)).toBe(true);
    expect(isTrustedProxy('fe80::1', list)).toBe(false);
  });
  it('rejects mixed-family comparisons', () => {
    const list = parseProxyList('172.16.0.0/12');
    expect(isTrustedProxy('::1', list)).toBe(false);
  });
});

describe('ipInCidr', () => {
  it('full-width prefix matches everything in family', () => {
    expect(ipInCidr('1.2.3.4', '0.0.0.0', 0)).toBe(true);
  });
  it('zero-width never matches other family', () => {
    expect(ipInCidr('::1', '0.0.0.0', 0)).toBe(false);
  });
});