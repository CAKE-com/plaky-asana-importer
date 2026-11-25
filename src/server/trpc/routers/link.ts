import { z } from "zod";
import { linkedSources, linkStep, previewLink } from "@/server/pipeline/migration";
import { router } from "../init";
import { linkPreview } from "./provision";
import { dropPlan, scanHomes, scanItemIds, withSetup } from "@/server/jobs/runner";
import { collect, depsFor, migrationProcedure } from "./shared";
import { PreconditionError } from "@/server/errors";
import { loadLinkConfig, loadManifest, saveLinkConfig, setSeedFailures } from "@/server/pipeline/store";
import { changePairing, pairingOf } from "@/server/pipeline/pairing";
import { plakyFieldsFromBoard } from "@/server/pipeline/transform/mapping";

const pairingColumn = z.object({
  id: z.string(), title: z.string(), type: z.string(), state: z.enum(["paired", "skipped", "unpaired"]),
  field: z.object({ key: z.string(), name: z.string(), type: z.string() }).nullable(), labels: z.array(z.string()), labelMap: z.record(z.string(), z.string()),
});
const pairingBoard = z.object({
  asanaBoardId: z.string(), name: z.string(), plakyBoardId: z.number(), columns: z.array(pairingColumn),
  fields: z.array(z.object({ key: z.string(), name: z.string(), type: z.string(), typeLabel: z.string(), labels: z.array(z.string()) })),
});


async function linkedBoards(db: Parameters<typeof loadManifest>[0], migrationId: number) {
  const [loaded, manifest] = await Promise.all([loadLinkConfig(db, migrationId), loadManifest(db, migrationId)]);
  if (!loaded || !manifest) throw new PreconditionError("link the boards first: there is no pairing yet");
  return { loaded, manifest };
}

export const linkRouter = router({
  pairing: migrationProcedure.output(z.object({ boards: z.array(pairingBoard) })).query(async ({ ctx, input }) => {
    const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
    const { plaky } = await depsFor(ctx, input.migrationId, () => undefined);
    const boards = [];
    for (const sync of loaded.config.boards) {
      const board = manifest.boards.find((b) => b.id === sync.asanaBoardId);
      if (!board) continue;
      boards.push(pairingOf(board, sync, plakyFieldsFromBoard(await plaky.getBoard(sync.plakySpaceId, sync.plakyBoardId))));
    }
    return { boards };
  }),

  setPairing: migrationProcedure.input(z.object({
    asanaBoardId: z.string().max(40), columnId: z.string().max(200),
    choice: z.discriminatedUnion("kind", [z.object({ kind: z.literal("field"), key: z.string().max(200) }), z.object({ kind: z.literal("skip") }), z.object({ kind: z.literal("auto") })]),
    labels: z.record(z.string().max(500), z.string().max(500)).optional(),
  })).output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "the column pairing", async () => {
      const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
      const sync = loaded.config.boards.find((b) => b.asanaBoardId === input.asanaBoardId);
      const board = manifest.boards.find((b) => b.id === input.asanaBoardId);
      if (!sync || !board) throw new PreconditionError(`Asana board ${input.asanaBoardId} is not linked in this migration`);
      const { plaky } = await depsFor(ctx, input.migrationId, () => undefined);
      const fields = plakyFieldsFromBoard(await plaky.getBoard(sync.plakySpaceId, sync.plakyBoardId));
      const changed = changePairing(board, sync, fields, input.columnId, input.choice, input.labels);
      await saveLinkConfig(ctx.db, input.migrationId, { ...loaded.config, boards: loaded.config.boards.map((b) => (b === sync ? changed : b)) });
      return { saved: true as const };
    })),

  dismissSeedFailures: migrationProcedure.output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) => {
    await setSeedFailures(ctx.db, input.migrationId, []);
    return { saved: true as const };
  }),

  preview: migrationProcedure.output(linkPreview).mutation(async ({ ctx, input }) => {
    const deps = await depsFor(ctx, input.migrationId, () => undefined);
    const selected = linkedSources((await loadManifest(ctx.db, input.migrationId)) ?? { boards: [] });
    return previewLink(deps, { itemIds: scanItemIds(input.migrationId, deps.asana, selected), homes: scanHomes(input.migrationId) });
  }),

  commit: migrationProcedure.input(z.object({ force: z.boolean().default(false) })).output(z.discriminatedUnion("status", [
    z.object({ status: z.literal("linked"), boards: z.number(), deletedSeeds: z.number(), seedFailures: z.array(z.string()) }),
    z.object({ status: z.literal("blocked"), blocking: z.array(z.string()) }),
    z.object({ status: z.literal("confirm") }),
  ])).mutation(async ({ ctx, input }) => {
    const events = collect();
    const r = await withSetup(input.migrationId, "linking", async () => linkStep(await depsFor(ctx, input.migrationId, events.log), { force: input.force }));
    if (r.ok) dropPlan(input.migrationId);
    if (r.ok) return { status: "linked" as const, boards: r.boards, deletedSeeds: r.deletedSeeds, seedFailures: r.seedFailures };
    return r.reason === "blocked" ? { status: "blocked" as const, blocking: r.blocking } : { status: "confirm" as const };
  }),
});
