import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { MAX_BATCH } from "@/lib/trpc-limits";
import { Explanation } from "@/server/explain-error";
import { logger } from "@/server/redact";
import { refuseRequest } from "@/server/request-guard";
import type { Context } from "@/server/trpc/context";
import { appRouter } from "@/server/trpc/router";

const REFUSALS = new Set(["PRECONDITION_FAILED", "CONFLICT", "BAD_REQUEST"]);

const MAX_BODY_BYTES = 1_000_000;

const TOO_LARGE = () => Response.json({ error: "refused: request body too large" }, { status: 413 });
const NOT_JSON = () => Response.json({ error: "refused: the request's input is not JSON" }, { status: 400 });

async function boundedText(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export async function handleTrpc(req: Request, createContext: () => Promise<Context>): Promise<Response> {
  const refusal = refuseRequest(req.headers);
  if (refusal) return Response.json({ error: refusal }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return TOO_LARGE();
  const input = new URL(req.url).searchParams.get("input");
  if (input !== null && !isJson(input)) return NOT_JSON();
  let request = req;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await boundedText(req);
    if (text === null) return TOO_LARGE();
    if (!isJson(text)) return NOT_JSON();
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    request = new Request(req.url, { method: req.method, headers, body: text, signal: req.signal });
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext,
    maxBatchSize: MAX_BATCH,
    onError: ({ path, error }) => {
      const technical = error.cause instanceof Explanation ? error.cause.technical : null;
      const refused = REFUSALS.has(error.code) && !technical;
      (refused ? logger.info : logger.error)(`tRPC ${refused ? "refused" : "failed on"} ${path ?? "<no-path>"}: ${error.message}${technical ? ` [${technical}]` : ""}`);
    },
  });
}
