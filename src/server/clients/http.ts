import packageJson from "../../../package.json";

export const USER_AGENT = `${packageJson.name}/${packageJson.version}`;

export type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  }),
};

export const fetchTransport: Transport = (url, init) => fetch(url, { redirect: "error", ...init });

export type RetryDecision = "retry" | "failed" | "unknown" | "rate-limited";
export function retryDecision(event: "rate-limit" | "uncertain", write: boolean, attempt: number, budget: number): RetryDecision {
  if (event === "uncertain" && write) return "unknown";
  if (attempt < budget) return "retry";
  return event === "rate-limit" ? "rate-limited" : "failed";
}

export function retryAfterSeconds(response: Response, now: number = Date.now()): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
