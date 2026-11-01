/**
 * Local view of the preload `desk.addons` / `desk.net` API (main process owns all network access).
 * Types are local on purpose, like desk.ts.
 */

export type AddonState =
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'error';

export interface AddonStatus {
  name: string;
  title: string;
  state: AddonState;
  version: string;
  sizeBytes: number;
  host: string;
  /** False while the pack has not been published (placeholder checksum). */
  available: boolean;
  /** e.g. /addons/libreoffice/1.0.0/ when installed. */
  basePath: string | null;
  progress: { received: number; total: number; percent: number } | null;
  error: { code: string; message: string } | null;
}

export interface AddonProgressEvent {
  name: string;
  state: AddonState;
  progress: { received: number; total: number; percent: number } | null;
  error: { code: string; message: string } | null;
}

export interface AddonsApi {
  status(name: string): Promise<AddonStatus>;
  install(name: string): Promise<AddonStatus>;
  installFromFile(name: string): Promise<AddonStatus>;
  cancel(name: string): Promise<unknown>;
  remove(name: string): Promise<AddonStatus>;
  onProgress(cb: (ev: AddonProgressEvent) => void): () => void;
}

export interface NetApi {
  timestamp(opts: {
    tsaId: string;
    request: ArrayBuffer;
    digestHex?: string;
    hashAlgo?: string;
  }): Promise<ArrayBuffer>;
}

interface DeskWithNet {
  addons?: AddonsApi;
  net?: NetApi;
}

function desk(): DeskWithNet | undefined {
  try {
    const d = (window as unknown as { desk?: DeskWithNet }).desk;
    return typeof d === 'object' && d ? d : undefined;
  } catch {
    return undefined;
  }
}

export const getAddonsApi = (): AddonsApi | undefined => desk()?.addons;
export const getNetApi = (): NetApi | undefined => desk()?.net;

/** "[code] text" -> { code, message } as produced by the preload wrapper. */
export function parseAddonError(e: unknown): { code: string; message: string } {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = /^\[([a-z_]+)\]\s*(.*)$/i.exec(msg);
  return m ? { code: m[1], message: m[2] } : { code: 'internal', message: msg };
}

export function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
