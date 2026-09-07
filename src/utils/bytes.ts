// Byte-size normalisation for mailbox reporting.
//
// CIPP reports mailbox sizes in two different vocabularies depending on where
// the number came from: Graph's usage reports hand back raw byte counts, while
// anything sourced from an Exchange Online cmdlet returns Exchange's display
// form — `"1.234 GB (1,325,400,000 bytes)"`. A caller trying to answer "who is
// near quota" should not have to know which one it got, so both are parsed to
// a plain byte count here and re-rendered once, consistently.

/**
 * Read a value CIPP may serialise as a number or as a numeric string.
 *
 * Deliberately not `Number(value)`: that coerces `null`, `''` and `false` to
 * `0`, which would turn "CIPP reported nothing here" into a confident zero —
 * the difference between an unmeasured mailbox and an empty one.
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One binary gigabyte. CIPP's per-user endpoint reports sizes pre-divided by this. */
export const GIB = 1024 ** 3;

/** The unit ladder, smallest first. Index doubles as the power of 1024. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Exchange's display form carries the exact count in parentheses:
 * `"1.234 GB (1,325,400,000 bytes)"`. That value is authoritative — the
 * leading figure is rounded for humans — so it is preferred when present.
 */
const EXACT_BYTES_RE = /\(([\d,]+)\s*bytes\)/i;

/** A bare `"<number> <unit>"` size, used when no exact byte count is given. */
const SCALED_SIZE_RE = /^\s*([\d.,]+)\s*(B|KB|MB|GB|TB)\b/i;

/**
 * Parse a CIPP/Exchange size into bytes.
 *
 * @param value - A raw byte count, an Exchange size string, or neither.
 * @returns Byte count, or `undefined` when the value carries no usable size.
 *          `"Unlimited"` quotas and absent fields both land here — a quota
 *          that does not exist is not a quota of zero, and reporting it as
 *          zero would make every mailbox look infinitely over its limit.
 */
export function toBytes(value: unknown): number | undefined {
  if (typeof value === 'number') return toFiniteNumber(value);
  if (typeof value !== 'string') return undefined;

  const exact = EXACT_BYTES_RE.exec(value);
  if (exact) return toFiniteNumber(exact[1].replace(/,/g, ''));

  const scaled = SCALED_SIZE_RE.exec(value);
  if (scaled) {
    const parsed = toFiniteNumber(scaled[1].replace(/,/g, ''));
    if (parsed === undefined) return undefined;
    const power = UNITS.indexOf(scaled[2].toUpperCase() as (typeof UNITS)[number]);
    return Math.round(parsed * 1024 ** power);
  }

  // A bare numeric string is a byte count; anything else ("Unlimited") is not
  // a size we can act on.
  return toFiniteNumber(value.replace(/,/g, ''));
}

/**
 * Render a byte count in the largest unit that keeps it readable.
 *
 * @param bytes - Byte count, or `undefined` when the size is unknown.
 * @returns e.g. `"1.23 GB"`, or `undefined` when `bytes` is.
 */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 0) return undefined;
  if (bytes === 0) return '0 B';

  let index = 0;
  let scaled = bytes;
  while (scaled >= 1024 && index < UNITS.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  // Whole bytes read oddly with decimals; every larger unit needs them.
  const decimals = index === 0 ? 0 : 2;
  return `${scaled.toFixed(decimals)} ${UNITS[index]}`;
}

/**
 * Percentage of `quota` consumed by `used`, rounded to one decimal place.
 *
 * @returns `undefined` when either side is unknown or the quota is zero —
 *          an unlimited or unreported quota has no meaningful percentage,
 *          and inventing one would let a caller alert on nothing.
 */
export function percentOfQuota(
  used: number | undefined,
  quota: number | undefined
): number | undefined {
  if (used === undefined || quota === undefined || quota <= 0) return undefined;
  return Math.round((used / quota) * 1000) / 10;
}

/**
 * Convert a gigabyte figure to bytes.
 *
 * `Invoke-ListUserMailboxDetails` divides every size by PowerShell's `1Gb`
 * (binary) and rounds to two decimals before returning it, so a value read
 * back from there is accurate to roughly 10 MB rather than to the byte.
 *
 * @returns Byte count, or `undefined` when `gb` is not a usable number.
 */
export function fromGigabytes(gb: unknown): number | undefined {
  const value = toFiniteNumber(gb);
  if (value === undefined || value < 0) return undefined;
  return Math.round(value * GIB);
}
