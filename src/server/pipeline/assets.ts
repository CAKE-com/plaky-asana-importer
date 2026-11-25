import type { AsanaClient } from "../clients/asana";
import { MAX_UPLOAD_BYTES, safeName, URL_LIFETIME_SECONDS } from "./transform/files";

const DOWNLOAD_IDLE_MS = 60_000;

export class FileTooLarge extends Error {
  override readonly name = "FileTooLarge";
}
export class DownloadStatusError extends Error {
  override readonly name = "DownloadStatusError";
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export type AssetInfo = { name: string | null; size: number | null; url: string | null };
export type FetchAssetUrls = (ids: readonly string[]) => Promise<Map<string, AssetInfo>>;
export type Download = (url: string, maxBytes: number) => Promise<Uint8Array>;

export type DownloadOptions = { fetch?: (url: string, init: RequestInit) => Promise<Response>; idleMs?: number };

export const asanaAssetUrls =
  (asana: Pick<AsanaClient, "assets">): FetchAssetUrls =>
  async (ids) =>
    new Map(
      [...(await asana.assets([...ids]))].map(([id, row]): [string, AssetInfo] => [id, { name: row.name ?? null, size: row.size ?? null, url: row.download_url ?? null }]),
    );

export interface AssetSource {
  meta(assetId: string): Promise<[name: string, size: number | null]>;
  fetch(assetId: string): Promise<[name: string, data: Uint8Array]>;
}

export async function streamDownload(url: string, maxBytes: number, take: (chunk: Uint8Array) => void | Promise<void>, o: DownloadOptions = {}): Promise<number> {
  if (!isHttps(url)) throw new Error("not an https download link");
  const idle = new AbortController();
  const idleMs = o.idleMs ?? DOWNLOAD_IDLE_MS;
  let timer = setTimeout(() => idle.abort(new Error("the download stalled")), idleMs);
  const awake = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error("the download stalled")), idleMs);
  };
  try {
    const response = await (o.fetch ?? fetch)(url, { redirect: "follow", signal: idle.signal });
    if (response.url && !isHttps(response.url)) {
      await response.body?.cancel();
      throw new Error("the download link redirected off https");
    }
    if (response.status >= 400) {
      await response.body?.cancel();
      throw new DownloadStatusError(response.status);
    }
    let length = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const part = await reader?.read();
      if (!part || part.done) break;
      awake();
      length += part.value.length;
      if (length > maxBytes) {
        await reader?.cancel();
        throw new FileTooLarge(`over the API's ${maxBytes} bytes`);
      }
      await take(part.value);
    }
    return length;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchDownload = async (url: string, maxBytes: number, o: DownloadOptions = {}): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const length = await streamDownload(url, maxBytes, (chunk) => void chunks.push(chunk), o);
  const data = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data;
};

export type AssetFetcherOptions = {
  fetchAssetUrls: FetchAssetUrls;
  download?: Download;
  maxBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DOWNLOAD_RETRY_MS = [1_000, 3_000];
const retriable = (error: unknown): boolean =>
  error instanceof DownloadStatusError ? error.status === 429 || error.status >= 500 : !(error instanceof FileTooLarge);

type Meta = { name: string; size: number | null; url: string | null; at: number; unread?: true };

export class AssetFetcher implements AssetSource {
  private readonly fetchAssetUrls: FetchAssetUrls;
  private readonly download: Download;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, Meta>();

  constructor(options: AssetFetcherOptions) {
    this.fetchAssetUrls = options.fetchAssetUrls;
    this.download = options.download ?? fetchDownload;
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async meta(assetId: string): Promise<[string, number | null]> {
    const row = await this.resolve(assetId);
    return [row.name, row.size];
  }

  async fetch(assetId: string): Promise<[string, Uint8Array]> {
    const { name, size, url, unread } = await this.resolve(assetId);
    if (unread) throw new Error(`Asana did not give ${name}: it was deleted, or this token may not read it`);
    if (size !== null && size > this.maxBytes) throw new FileTooLarge(`${name} is ${size} bytes, over the API's ${this.maxBytes}`);
    if (!url || !isHttps(url)) throw new Error(`Asana gave no https download link for ${name}`);
    let data: Uint8Array;
    try {
      data = await this.downloadWithRetries(url);
    } catch (error) {
      if (error instanceof FileTooLarge) throw new FileTooLarge(`${name} is over the API's ${this.maxBytes} bytes`);
      if (error instanceof DownloadStatusError) throw new Error(`downloading ${name} from Asana failed: ${error.status}`);
      throw new Error(`downloading ${name} from Asana failed: ${error instanceof Error ? error.name : "error"}`);
    }
    if (data.length > this.maxBytes) throw new FileTooLarge(`${name} is over the API's ${this.maxBytes} bytes`);
    if (size !== null && size >= 0 && data.byteLength !== size) throw new Error(`downloading ${name} from Asana failed: expected ${size} bytes, received ${data.byteLength}`);
    return [name, data];
  }

  private async downloadWithRetries(url: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.download(url, this.maxBytes);
      } catch (error) {
        const wait = DOWNLOAD_RETRY_MS[attempt];
        if (wait === undefined || !retriable(error)) throw error;
        await this.sleep(wait);
      }
    }
  }

  private stale(assetId: string): boolean {
    const cached = this.cache.get(assetId);
    return cached === undefined || this.now() - cached.at > URL_LIFETIME_SECONDS * 1000;
  }

  private async resolve(assetId: string): Promise<Meta> {
    if (this.stale(assetId)) {
      const batch = [assetId];
      const rows: Map<string, AssetInfo> = await this.fetchAssetUrls(batch);
      const at = this.now();
      for (const id of batch) {
        const row = rows.get(id);
        this.cache.set(id, { name: safeName(row?.name || `asset-${id}`), size: typeof row?.size === "number" ? Math.trunc(row.size) : null, url: row?.url ?? null, at, ...(row ? {} : { unread: true as const }) });
      }
    }
    return this.cache.get(assetId)!;
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
