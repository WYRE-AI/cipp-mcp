import { createHmac } from 'node:crypto';
import { verifyS2sHeader } from '../src/s2s-verify.js';

function deriveRecipientSubkey(masterSecret: string, slug: string): string {
  return createHmac('sha256', masterSecret).update(`s2s-recipient:${slug}`).digest('hex');
}

function mintHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

describe('verifyS2sHeader', () => {
  const MASTER = 'test-master-secret-do-not-use-in-prod';
  const cippSubkey = deriveRecipientSubkey(MASTER, 'cipp');
  const siblingSubkey = deriveRecipientSubkey(MASTER, 'halopsa');
  const now = Math.floor(Date.now() / 1000);

  it('accepts a header minted with this vendor\'s own derived subkey', () => {
    expect(verifyS2sHeader(mintHeader(cippSubkey, now), cippSubkey)).toBe(true);
  });

  it('REJECTS a header minted for a different vendor\'s derived subkey (recipient-binding proof)', () => {
    expect(verifyS2sHeader(mintHeader(siblingSubkey, now), cippSubkey)).toBe(false);
  });

  it('rejects a stale timestamp outside the skew window', () => {
    expect(verifyS2sHeader(mintHeader(cippSubkey, now - 301), cippSubkey)).toBe(false);
  });

  it('rejects a future timestamp outside the skew window', () => {
    expect(verifyS2sHeader(mintHeader(cippSubkey, now + 301), cippSubkey)).toBe(false);
  });

  it('accepts a timestamp at the edge of the skew window', () => {
    expect(verifyS2sHeader(mintHeader(cippSubkey, now - 300), cippSubkey)).toBe(true);
  });

  it('rejects a malformed header value', () => {
    expect(verifyS2sHeader('not-a-valid-header', cippSubkey)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyS2sHeader(undefined, cippSubkey)).toBe(false);
  });

  it('rejects when the secret is empty (dark-by-default guarantee)', () => {
    expect(verifyS2sHeader(mintHeader(cippSubkey, now), '')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const header = mintHeader(cippSubkey, now);
    const tampered = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');
    expect(verifyS2sHeader(tampered, cippSubkey)).toBe(false);
  });
});
