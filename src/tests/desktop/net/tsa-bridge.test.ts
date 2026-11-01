import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  tsaIdForUrl,
  desktopTimestampFetch,
} from '../../../desktop/addons/tsa-bridge';
import { TIMESTAMP_TSA_PRESETS } from '../../../js/config/timestamp-tsa';

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('tsa bridge', () => {
  it('maps every preset URL to an id and rejects unknown hosts', () => {
    for (const p of TIMESTAMP_TSA_PRESETS)
      expect(tsaIdForUrl(p.url)).toBeTruthy();
    expect(tsaIdForUrl('https://evil.example.com/tsr')).toBeNull();
    expect(tsaIdForUrl('not a url')).toBeNull();
  });

  it('sends only the id and the request bytes to desk.net.timestamp', async () => {
    const timestamp = vi.fn(async () => new Uint8Array([0x30, 1, 2]).buffer);
    (globalThis as { window?: unknown }).window = {
      desk: { net: { timestamp } },
    };
    const body = new Uint8Array([0x30, 3, 1, 2, 3]);
    const res = await desktopTimestampFetch('http://timestamp.digicert.com', {
      method: 'POST',
      body,
    });
    expect(res.ok).toBe(true);
    const arg = (timestamp.mock.calls[0] as unknown[])[0] as {
      tsaId: string;
      request: ArrayBuffer;
    };
    expect(arg.tsaId).toBe('digicert');
    expect(new Uint8Array(arg.request)).toEqual(body);
  });

  it('turns a refused/cancelled call into a non-ok response', async () => {
    const timestamp = vi.fn(async () => {
      throw new Error('[cancelled] Timestamping was cancelled');
    });
    (globalThis as { window?: unknown }).window = {
      desk: { net: { timestamp } },
    };
    const res = await desktopTimestampFetch('https://freetsa.org/tsr', {
      body: new Uint8Array([0x30]),
    });
    expect(res.ok).toBe(false);
  });
});
