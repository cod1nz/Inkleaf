/**
 * Desktop RFC 3161 bridge: the renderer has no network, so the DER TimeStampReq built by the signing library is
 * handed to the main process together with an allowlisted TSA id (never a URL). Main asks the user for consent.
 */
import { getNetApi, parseAddonError } from './api';

/** Host -> TSA id. Mirrors electron/net/tsa-allowlist.js (main re-validates the id). */
const TSA_IDS: Record<string, string> = {
  'timestamp.digicert.com': 'digicert',
  'timestamp.sectigo.com': 'sectigo',
  'ts.ssl.com': 'sslcom',
  'freetsa.org': 'freetsa',
  'tsa.mesign.com': 'mesign',
};

export function tsaIdForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return Object.prototype.hasOwnProperty.call(TSA_IDS, host)
      ? TSA_IDS[host]
      : null;
  } catch {
    return null;
  }
}

function toArrayBuffer(body: unknown): ArrayBuffer | null {
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength
    ) as ArrayBuffer;
  }
  return null;
}

/**
 * Drop-in replacement for the library's POST fetch. Resolves a synthetic Response so the caller's
 * `.ok` / `.arrayBuffer()` handling keeps working.
 */
export async function desktopTimestampFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const net = getNetApi();
  if (!net) throw new Error('Timestamping is not available in this build');
  const tsaId = tsaIdForUrl(url);
  if (!tsaId) throw new Error('This timestamp server is not allowed');
  const request = toArrayBuffer(init?.body);
  if (!request) throw new Error('Invalid timestamp request');
  try {
    const reply = await net.timestamp({ tsaId, request });
    return new Response(reply, {
      status: 200,
      headers: { 'Content-Type': 'application/timestamp-reply' },
    });
  } catch (e) {
    const { code, message } = parseAddonError(e);
    return new Response(message, {
      status: code === 'cancelled' ? 499 : 502,
    });
  }
}
