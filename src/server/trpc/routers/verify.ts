import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { migrationBoards, migrationRuns } from "@/db/schema";
import { withSetup } from "@/server/jobs/runner";
import { verifyStep } from "@/server/pipeline/migration";
import { clearSyncPoints, finishRun, getMigration, loadLinkConfig, setStatusUnlessOtherRun, startRun } from "@/server/pipeline/store";
import { changesPlan, shortAtVerify } from "@/server/pipeline/changes";
import { PreconditionError } from "@/server/errors";
import type { Db } from "@/db/client";
import { receiptJson } from "@/server/pipeline/verify";
import { receiptSchema } from "@/lib/reports";
import { router } from "../init";
import { depsFor, migrationProcedure, plakyLinksFor } from "./shared";
import { runSchema } from "./run";


async function changesNow(db: Db, migrationId: number): Promise<{ full: string[] } | null> {
  try {
    const { full } = await changesPlan(db, migrationId);
    const names = new Map((await db.select().from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId))).map((b) => [b.asanaBoardId, b.asanaBoardName]));
    return { full: full.map((id) => names.get(id) ?? id) };
  } catch (error) {
    if (error instanceof PreconditionError) return null;
    throw error;
  }
}

export const verifyRouter = router({
  summary: migrationProcedure.output(z.object({
    migrationName: z.string(), receipt: receiptSchema.nullable(), receiptRunId: z.number().nullable(), run: runSchema.nullable(), links: z.array(z.object({ asana_board_id: z.string(), name: z.string(), url: z.string() })),
    receiptAt: z.number().nullable(),
    changes: z.object({ full: z.array(z.string()) }).nullable(),
    undoneAfter: z.boolean(),
    quietSince: z.boolean(),
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const links = await plakyLinksFor(ctx.db, input.migrationId);
    const ofMigration = and(eq(migrationRuns.migrationId, input.migrationId), inArray(migrationRuns.kind, ["apply", "verify"]));
    const row = (await ctx.db.select().from(migrationRuns).where(ofMigration).orderBy(desc(migrationRuns.id)).limit(1))[0];
    const receipts = await ctx.db.select({ id: migrationRuns.id, receipt: migrationRuns.receipt, finishedAt: migrationRuns.finishedAt }).from(migrationRuns)
      .where(and(ofMigration, isNotNull(migrationRuns.receipt))).orderBy(desc(migrationRuns.id)).limit(10);
    const withReceipt = receipts.map((r) => ({ id: r.id, at: r.finishedAt?.getTime() ?? null, parsed: receiptSchema.safeParse(r.receipt) })).find((p) => p.parsed.success);
    const receipt = withReceipt?.parsed.data ?? null;
    const undos = await ctx.db.select({ counts: migrationRuns.counts }).from(migrationRuns)
      .where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "undo"), gt(migrationRuns.id, Math.max(withReceipt?.id ?? 0, row?.id ?? 0))));
    const later = withReceipt ? await ctx.db.select({ status: migrationRuns.status, counts: migrationRuns.counts }).from(migrationRuns).where(and(ofMigration, gt(migrationRuns.id, withReceipt.id))) : [];
    return {
      quietSince: later.length > 0 && later.every((r) => r.status === "succeeded" && r.counts?.writes === 0),
      undoneAfter: undos.some((u) => u.counts?.undone === 1),
      migrationName: migration.name,
      receipt,
      receiptRunId: withReceipt?.id ?? null,
      receiptAt: withReceipt?.at ?? null,
      run: row ? { id: row.id, kind: row.kind, status: row.status, plannedWrites: row.plannedWrites, counts: row.counts, startedAt: row.startedAt.getTime(), finishedAt: row.finishedAt?.getTime() ?? null } : null,
      links: migration.plakySpaceId === null || !links ? [] : (receipt?.boards ?? []).map((b) => ({ asana_board_id: b.asana_board_id, name: b.name, url: links(migration.plakySpaceId!, b.plaky_board_id) })),
      changes: await changesNow(ctx.db, input.migrationId),
    };
  }),

  run: migrationProcedure.output(receiptSchema).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "verification", async () => {
      const deps = await depsFor(ctx, input.migrationId, () => undefined);
      const asana = deps.asana;
      if (!(await loadLinkConfig(ctx.db, input.migrationId))) throw new PreconditionError("link the boards first");
      const runId = await startRun(ctx.db, input.migrationId, "verify");
      await setStatusUnlessOtherRun(ctx.db, input.migrationId, "running", runId);
      try {
        const report = await verifyStep(deps);
        await clearSyncPoints(ctx.db, input.migrationId, shortAtVerify(report));
        const receipt = receiptSchema.parse(receiptJson(report));
        await settleCheck(ctx.db, input.migrationId, runId, receipt.ok);
        await finishRun(ctx.db, runId, receipt.ok ? "succeeded" : "failed", { receipt, counts: { writes: 0, asanaCalls: asana.requests } });
        return receipt;
      } catch (error) {
        await settleCheck(ctx.db, input.migrationId, runId, false).catch(() => undefined);
        await finishRun(ctx.db, runId, "failed", { counts: { asanaCalls: asana.requests } });
        throw error;
      }
    });
  }),
});

export async function settleCheck(db: Db, migrationId: number, runId: number, ok: boolean): Promise<void> {
  await setStatusUnlessOtherRun(db, migrationId, ok ? "completed" : "failed", runId);
}
