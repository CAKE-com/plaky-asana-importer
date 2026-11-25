import { z } from "zod";
import { PreconditionError } from "@/server/errors";
import { commentsToWrite, filesToUpload, writeAction } from "@/server/pipeline/plan";
import type { PlanStepResult } from "@/server/pipeline/migration";
import { PLAN_MAX_AGE_MS, dropPlan, dryRun, finishPlanRun, lastPlan, withSetup } from "@/server/jobs/runner";
import { clearSyncPoints, finishRun, getMigration, asanaCallsOn, loadLinkConfig, loadManifest, updateSetup } from "@/server/pipeline/store";
import { planDetails, planSummary, estimateMinutes, type PlanSummary } from "@/lib/reports";
import { skippedByChoice } from "@/lib/outside";
import { dropped } from "@/server/pipeline/manifest";
import { migrationRuns } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { router } from "../init";
import { migrationProcedure, clientsOf } from "./shared";
import { runStatus } from "./run";

function summarizePlan(planned: PlanStepResult, notCarried: ReadonlyMap<string, ReadonlySet<string>>): PlanSummary {
  return {
    at: Date.now(),
    boards: planned.plans.map((p) => {
      let creates = 0, updates = 0, unchanged = 0, drifted = 0, notCarriedValues = 0;
      for (const w of p.writes) {
        const a = writeAction(w);
        if (a === "create") creates++;
        else if (a === "update") updates++;
        else unchanged++;
        if (w.drifted) drifted++;
        notCarriedValues += w.notCarried.length;
      }
      return {
        name: p.asanaBoardName, asanaBoardId: p.config.asanaBoardId, creates, updates, unchanged, drifted, orphans: p.orphans.length, groupWrites: p.groupWrites.length,
        comments: commentsToWrite(p), files: filesToUpload(p), uncarried: [...p.uncarried], notCarriedValues, archivedGroups: [...p.archivedGroups],
        skippedByChoice: skippedByChoice(p.fieldMap.skipped, notCarried.get(p.config.asanaBoardId) ?? new Set()),
      };
    }),
    plannedWrites: planned.plannedWrites,
    estimateMinutes: estimateMinutes(planned.plannedWrites),
    failures: planned.failures,
  };
}


const held = z.object({ until: z.number() }).nullable();
function heldUntil(migrationId: number): { until: number } | null {
  const plan = lastPlan(migrationId);
  return plan ? { until: plan.at + PLAN_MAX_AGE_MS } : null;
}

export const planRouter = router({
  run: migrationProcedure.output(planSummary.extend({ held })).mutation(async ({ ctx, input }) => {
    const { planned, runId, asanaCalls } = await dryRun(ctx.db, input.migrationId, await clientsOf(ctx, input.migrationId));
    try {
      const manifest = await loadManifest(ctx.db, input.migrationId);
      const notCarried = new Map((manifest?.boards ?? []).map((b) => [b.id, new Set(dropped(b).map((c) => c.id))]));
      const summary = { ...summarizePlan(planned, notCarried), asanaCalls };
      await finishPlanRun(ctx.db, runId, planned.plannedWrites, summary, asanaCalls);
      return { ...summary, held: heldUntil(input.migrationId) };
    } catch (error) {
      await finishRun(ctx.db, runId, "failed").catch(() => undefined);
      throw error;
    }
  }),

  latest: migrationProcedure.output(z.object({
    summary: planSummary.nullable(), latestRun: z.object({ at: z.number(), status: runStatus }).nullable(), prune: z.boolean(), recreateDrifted: z.boolean(), asanaCallsToday: z.number(), held,
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const plans = (status?: "succeeded") => ctx.db.select().from(migrationRuns)
      .where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "plan"), ...(status ? [eq(migrationRuns.status, status)] : []))).orderBy(desc(migrationRuns.id)).limit(1);
    const manifest = await loadManifest(ctx.db, input.migrationId);
    const discoveredAt = Date.parse(manifest?.generatedAt ?? "") || 0;
    const [row] = await plans("succeeded");
    const [last] = await plans();
    const parsed = row && row.startedAt.getTime() >= discoveredAt ? planSummary.safeParse(row.receipt) : null;
    return {
      summary: parsed?.success ? parsed.data : null,
      latestRun: last && last.startedAt.getTime() >= discoveredAt ? { at: (last.finishedAt ?? last.startedAt).getTime(), status: last.status } : null,
      prune: migration.options.prune, recreateDrifted: migration.options.recreateDrifted, asanaCallsToday: await asanaCallsOn(ctx.db), held: heldUntil(input.migrationId),
    };
  }),

  details: migrationProcedure.input(z.object({ showValues: z.boolean() })).output(planDetails.nullable()).query(({ input }) => {
    const held = lastPlan(input.migrationId);
    if (!input.showValues || !held) return null;
    return {
      boards: held.planned.plans.map((p) => ({
        name: p.asanaBoardName,
        creates: p.writes.filter((w) => writeAction(w) === "create").map((w) => w.title).slice(0, 200),
        updates: p.writes.filter((w) => writeAction(w) === "update").map((w) => w.title).slice(0, 200),
        notCarried: p.writes.flatMap((w) => w.notCarried).slice(0, 200),
      })),
    };
  }),

  setOptions: migrationProcedure.input(z.object({ prune: z.boolean().optional(), recreateDrifted: z.boolean().optional(), paidAsana: z.boolean().optional() }))
    .output(z.object({ ok: z.literal(true), prune: z.boolean(), recreateDrifted: z.boolean() })).mutation(async ({ ctx, input }) => {
      const stored = await withSetup(input.migrationId, "saving the options", async () => {
        const { options } = await getMigration(ctx.db, input.migrationId);
        const next = { prune: input.prune ?? options.prune, recreateDrifted: input.recreateDrifted ?? options.recreateDrifted, paidAsana: input.paidAsana ?? options.paidAsana ?? false };
        if (next.recreateDrifted && ((await loadManifest(ctx.db, input.migrationId))?.boards.some((b) => b.nested) || (await loadLinkConfig(ctx.db, input.migrationId))?.config.boards.some((b) => b.nested))) {
          throw new PreconditionError("Re-creating items is unavailable with nested subitems. Turn this option off.");
        }
        if (next.prune !== options.prune || next.recreateDrifted !== options.recreateDrifted) {
          await clearSyncPoints(ctx.db, input.migrationId);
          dropPlan(input.migrationId);
        }
        await updateSetup(ctx.db, input.migrationId, { options: next });
        return next;
      });
      return { ok: true as const, prune: stored.prune, recreateDrifted: stored.recreateDrifted };
    }),
});
