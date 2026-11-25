import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { migrationLogs } from "@/db/schema";
import { cancelResume, cancelSchedule, withSetup } from "@/server/jobs/runner";
import { PreconditionError } from "@/server/errors";
import { dbLog, finishRun, getMigration, loadLinkConfig, setStatusUnlessOtherRun, startRun } from "@/server/pipeline/store";
import { applyUndo, previewUndo } from "@/server/pipeline/undo";
import { router } from "../init";
import { depsFor, plakyBoardUrl, plakyLinksFor, migrationProcedure } from "./shared";
import type { Db } from "@/db/client";

const boardInput = z.object({ asanaBoardId: z.string().regex(/^(?:mytasks:)?\d{1,20}(?::level2)?$/, "an Asana board id") });
const preview = z.object({
  board: z.object({ asanaBoardId: z.string(), name: z.string(), plakySpaceId: z.number(), plakyBoardId: z.number(), url: z.string().nullable() }),
  items: z.array(z.object({ asanaId: z.string(), plakyId: z.number(), title: z.string(), comments: z.number().optional(), files: z.number().optional() })),
  groups: z.array(z.object({ plakyId: z.number(), title: z.string() })),
  nested: z.array(z.object({ asanaId: z.string(), plakyId: z.number(), title: z.string(), parent: z.number(), comments: z.number().optional(), files: z.number().optional() })),
  kept: z.array(z.string()),
  gone: z.array(z.string()),
});
const withUrl = <T extends { board: { plakySpaceId: number; plakyBoardId: number } }>(p: T, links: typeof plakyBoardUrl | null) => ({ ...p, board: { ...p.board, url: links ? links(p.board.plakySpaceId, p.board.plakyBoardId) : null } });

async function recordUndone(db: Db, migrationId: number, runId: number, undone: boolean): Promise<{ scheduleCancelled: boolean }> {
  if (!undone) return { scheduleCancelled: false };
  await cancelResume(db, migrationId);
  const scheduleCancelled = await cancelSchedule(db, migrationId);
  if ((await getMigration(db, migrationId)).status === "completed") await setStatusUnlessOtherRun(db, migrationId, "linked", runId);
  return { scheduleCancelled };
}

export const undoRouter = router({
  boards: migrationProcedure.output(z.array(z.object({ asanaBoardId: z.string(), name: z.string(), applied: z.boolean() }))).query(async ({ ctx, input }) =>
    ((await loadLinkConfig(ctx.db, input.migrationId))?.config.boards ?? []).filter((b) => !b.nested).map((b) => ({ asanaBoardId: b.asanaBoardId, name: b.name, applied: b.applied }))),

  preview: migrationProcedure.input(boardInput).output(preview).mutation(async ({ ctx, input }) =>
    withUrl(await previewUndo(ctx.db, input.migrationId, (await depsFor(ctx, input.migrationId, () => undefined)).plaky, input.asanaBoardId), await plakyLinksFor(ctx.db, input.migrationId))),

  commit: migrationProcedure.input(boardInput.extend({
    confirm: z.string().max(300),
    expected: z.object({
      items: z.array(z.number().int().positive()).max(100_000), groups: z.array(z.number().int().positive()).max(10_000),
      nested: z.array(z.number().int().positive()).max(100_000).default([]),
    }),
  })).output(preview.extend({ runId: z.number(), deletedItems: z.number(), deletedNested: z.number(), deletedGroups: z.number(), failures: z.array(z.string()), reset: z.boolean(), undone: z.boolean(), scheduleCancelled: z.boolean() })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "an undo", async () => {
      await getMigration(ctx.db, input.migrationId);
      const loaded = await loadLinkConfig(ctx.db, input.migrationId);
      if (!loaded) throw new PreconditionError("link first: this migration has no config");
      const board = loaded.config.boards.find((b) => b.asanaBoardId === input.asanaBoardId);
      const name = board?.name;
      if (board === undefined || name === undefined || input.confirm.trim() !== name.trim()) throw new PreconditionError(name === undefined ? `Asana board ${input.asanaBoardId} is not linked in this migration` : `type the board's name, "${name}", to confirm`);
      const runId = await startRun(ctx.db, input.migrationId, "undo");
      const { log, flush } = dbLog(ctx.db, runId);
      try {
        log({ level: "info", code: "undo.started", message: `Undo of Asana board ${input.asanaBoardId} started.`, data: { asanaBoardId: input.asanaBoardId } });
        const r = await applyUndo(ctx.db, input.migrationId, (await depsFor(ctx, input.migrationId, () => undefined)).plaky, input.asanaBoardId, input.confirm, log, input.expected, String(runId), {
          beforeDelete: () => cancelResume(ctx.db, input.migrationId),
        });
        log({ level: "info", code: "undo.finished", message: `Deleted ${r.deletedItems} item(s)${r.deletedNested ? `, ${r.deletedNested} nested subitem(s)` : ""} and ${r.deletedGroups} group(s); ${r.kept.length} kept, ${r.failures.length} failed.` });
        const undone = r.deletedItems + r.deletedGroups > 0 || (r.reset && board.applied);
        const { scheduleCancelled } = await recordUndone(ctx.db, input.migrationId, runId, undone);
        await flush();
        await finishRun(ctx.db, runId, r.failures.length ? "failed" : "succeeded", { counts: { deletedItems: r.deletedItems, deletedNested: r.deletedNested, deletedGroups: r.deletedGroups, kept: r.kept.length, failures: r.failures.length, undone: undone ? 1 : 0 } });
        return { ...withUrl(r, await plakyLinksFor(ctx.db, input.migrationId)), runId, undone, scheduleCancelled };
      } catch (error) {
        log({ level: "error", code: "undo.crashed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
        await flush();
        const deleted = (await ctx.db.select({ n: count() }).from(migrationLogs).where(and(eq(migrationLogs.runId, runId), inArray(migrationLogs.code, ["undo.item_deleted", "undo.group_deleted"]))))[0]?.n ?? 0;
        if (deleted > 0) await recordUndone(ctx.db, input.migrationId, runId, true).catch(() => undefined);
        await finishRun(ctx.db, runId, "failed", { counts: { undone: deleted > 0 ? 1 : 0 } }).catch(() => undefined);
        throw error;
      }
    })),
});
