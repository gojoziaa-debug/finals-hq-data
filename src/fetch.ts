import type { SourceInfo } from "./types.ts";

const KEPT_HEADERS = [
  "date",
  "age",
  "etag",
  "last-modified",
  "cache-control",
  "expires",
  "content-length",
  "content-type",
  "cf-cache-status",
  "x-cache",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "retry-after",
  "server",
];

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  /** Number of retries after the first attempt. */
  retries?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchResult {
  body: string;
  source: SourceInfo;
}

export class UpstreamError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(2_000 * 2 ** attempt, 30_000);
}

/** GET with timeout and bounded retries on network errors, 429 and 5xx. */
export async function fetchText(url: string, options: FetchOptions): Promise<FetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 2;
  let lastError: UpstreamError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = Date.now();
    let retryAfter: string | null = null;
    try {
      const response = await fetchImpl(url, {
        headers: { "user-agent": options.userAgent, accept: "application/json" },
        signal: controller.signal,
      });
      const body = await response.text();
      const durationMs = Date.now() - startedAt;
      const headers: { [name: string]: string } = {};
      for (const name of KEPT_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      if (response.ok) {
        return {
          body,
          source: { url, fetchedAt: new Date(startedAt).toISOString(), status: response.status, durationMs, headers },
        };
      }
      lastError = new UpstreamError(`HTTP ${response.status} for ${url}`, response.status);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
      retryAfter = response.headers.get("retry-after");
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const reason = (error as Error).name === "AbortError" ? `timeout after ${options.timeoutMs} ms` : (error as Error).message;
      lastError = new UpstreamError(`network error for ${url}: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(retryDelayMs(attempt, retryAfter));
  }
  throw lastError ?? new UpstreamError(`unreachable: ${url}`, null);
}
