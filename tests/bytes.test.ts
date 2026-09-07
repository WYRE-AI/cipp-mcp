import { toBytes, formatBytes, percentOfQuota, fromGigabytes, GIB } from '../src/utils/bytes.js';

// CIPP hands back sizes in three different vocabularies depending on the
// endpoint: raw byte counts from the reporting database, gigabyte floats from
// the per-user endpoint, and Exchange's own display strings inside the raw
// Get-Mailbox object. All three have to land on the same number.
describe('toBytes', () => {
  it('passes a raw byte count through', () => {
    expect(toBytes(1_325_400_000)).toBe(1_325_400_000);
  });

  // Exchange rounds the leading figure for humans but prints the exact count in
  // parentheses, so the parenthesised value is the one to trust.
  it('prefers the exact count in an Exchange size string over the rounded prefix', () => {
    expect(toBytes('1.234 GB (1,325,400,000 bytes)')).toBe(1_325_400_000);
    expect(toBytes('3.322 KB (3,402 bytes)')).toBe(3_402);
  });

  it('falls back to the scaled figure when no exact count is given', () => {
    expect(toBytes('50 GB')).toBe(50 * 1024 ** 3);
    expect(toBytes('1.5 MB')).toBe(Math.round(1.5 * 1024 ** 2));
  });

  it('reads a bare numeric string as bytes', () => {
    expect(toBytes('4096')).toBe(4096);
    expect(toBytes('1,048,576')).toBe(1_048_576);
  });

  // An unlimited quota is not a quota of zero. Reporting it as zero would make
  // every mailbox on it look infinitely over its limit.
  it.each([['Unlimited'], [''], ['   '], ['not a size']])(
    'returns undefined for %p rather than guessing a size',
    (value) => {
      expect(toBytes(value)).toBeUndefined();
    }
  );

  it.each([[undefined], [null], [{}], [NaN], [Infinity]])(
    'returns undefined for %p',
    (value) => {
      expect(toBytes(value)).toBeUndefined();
    }
  );
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.00 KB'],
    [1024 ** 2, '1.00 MB'],
    [1024 ** 3, '1.00 GB'],
    [1024 ** 4, '1.00 TB'],
    [Math.round(12.3 * 1024 ** 3), '12.30 GB'],
  ])('renders %p as %p', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('keeps scaling past TB rather than inventing a unit', () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2048.00 TB');
  });

  it.each([[undefined], [-1]])('returns undefined for %p', (bytes) => {
    expect(formatBytes(bytes as number | undefined)).toBeUndefined();
  });
});

describe('percentOfQuota', () => {
  it('reports one decimal place', () => {
    expect(percentOfQuota(25 * GIB, 100 * GIB)).toBe(25);
    expect(percentOfQuota(1, 3)).toBe(33.3);
  });

  it('reports over-quota mailboxes above 100 rather than clamping', () => {
    expect(percentOfQuota(110, 100)).toBe(110);
  });

  // A quota of zero is what the reporting database writes when it has no quota
  // data, not a real limit of nothing.
  it.each([
    ['an unknown size', undefined, 100],
    ['an unknown quota', 100, undefined],
    ['a zero quota', 100, 0],
  ])('returns undefined for %s', (_label, used, quota) => {
    expect(percentOfQuota(used, quota)).toBeUndefined();
  });
});

describe('fromGigabytes', () => {
  it('uses binary gigabytes, matching PowerShell 1Gb', () => {
    expect(fromGigabytes(1)).toBe(1024 ** 3);
    expect(fromGigabytes(12.3)).toBe(Math.round(12.3 * 1024 ** 3));
  });

  it('accepts a numeric string', () => {
    expect(fromGigabytes('2')).toBe(2 * 1024 ** 3);
  });

  it.each([[undefined], [null], ['x'], [-1]])('returns undefined for %p', (value) => {
    expect(fromGigabytes(value)).toBeUndefined();
  });
});
