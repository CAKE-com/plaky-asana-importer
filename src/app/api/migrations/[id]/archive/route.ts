import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createContext } from "@/server/trpc/context";
import { depsFor } from "@/server/trpc/routers/shared";
import { withSetup } from "@/server/jobs/runner";
import { refuseRequest } from "@/server/request-guard";
import { getMigration, loadManifest } from "@/server/pipeline/store";
import { buildArchive } from "@/server/pipeline/archive";
import { explainError } from "@/server/explain-error";
import { PreconditionError } from "@/server/errors";

const STATUS: Partial<Record<ReturnType<typeof explainError>["code"], number>> = {
  BAD_REQUEST: 400, PRECONDITION_FAILED: 409, CONFLICT: 409, TOO_MANY_REQUESTS: 429, BAD_GATEWAY: 502,
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = refuseRequest(request.headers);
  if (refused) return new Response(refused, { status: 403 });
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return new Response("Invalid migration", { status: 400 });
  try {
    const archive = await withSetup(Number(id), "building the archive", async () => {
      const ctx = await createContext();
      const migration = await getMigration(ctx.db, Number(id));
      const manifest = await loadManifest(ctx.db, Number(id));
      if (!manifest) throw new PreconditionError("Read the projects before exporting an archive.");
      const { asana } = await depsFor(ctx, Number(id), () => undefined);
      return buildArchive(asana, manifest.boards.filter((b) => !b.parentBoardId).map((b) => b.id), migration.name, { signal: request.signal });
    });
    const stream = createReadStream(archive.path);
    stream.on("close", () => { void archive.cleanup(); });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { headers: {
      "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="asana-archive-${id}.tar.gz"`,
      "Content-Length": String(archive.bytes), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    const explained = explainError(error);
    return new Response(`Archive not created: ${explained.text}`, { status: STATUS[explained.code] ?? 500, headers: { "Cache-Control": "no-store" } });
  }
}
