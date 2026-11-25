import { z } from "zod";
import { DEFAULT_REQUESTS_PER_MINUTE, PAID_REQUESTS_PER_MINUTE } from "@/server/clients/asana";
import { scopeReport } from "@/lib/scope-report";
import { env } from "@/server/env";
import { DEFAULT_OPTIONS, createMigration, getMigration, loadManifest, renameMigration, updateSetup } from "@/server/pipeline/store";
import { discoverStep } from "@/server/pipeline/migration";
import { loadDirectory } from "@/server/pipeline/plan";
import { defaultChoices } from "@/server/pipeline/people-match";
import { boardWarnings, fieldCount, importable, manifestWarnings, type Manifest } from "@/server/pipeline/manifest";
import { seedOf } from "@/server/pipeline/provision";
import { BOARD_TYPE, privacyFlag } from "@/server/pipeline/discover";
import { lossyColumns } from "@/server/pipeline/transform/compat";
import { router } from "../init";

import { dropPlan, withSetup } from "@/server/jobs/runner";
import { PreconditionError } from "@/server/errors";
import { collect, depsFor, migrationProcedure } from "./shared";
import { manifestSummary, type ManifestSummary } from "@/lib/reports";

const optionsInput = z.object({
  syncComments: z.boolean(), syncFiles: z.boolean(), syncSubscribers: z.boolean(), paidAsana: z.boolean().default(false), withCreated: z.boolean(), withLink: z.boolean(),
  subitems: z.enum(["auto", "board", "nested"]).default("auto"),
});


function summarizeManifest(m: Manifest): ManifestSummary {
  return {
    generatedAt: m.generatedAt,
    boards: m.boards.map((b) => ({
      id: b.id, name: b.name, items: b.itemsCount, subitemsOf: b.parentBoardId, nested: b.nested, plakyBoardId: b.plakyBoardId, fields: fieldCount(b), carried: importable(b).length,
      notCarried: b.columns.filter((c) => c.plakyType === null).map((c) => ({ title: c.title, type: c.type, reason: c.reason ?? "" })),
      warnings: boardWarnings(seedOf(b, m)), byHand: [...b.byHand], archivedItems: b.archivedItems, deletedItems: b.deletedItems,
      asText: lossyColumns([...b.columns, ...b.nestedColumns]),
    })),
    skipped: m.skipped.map((s) => ({ id: s.id, name: s.name, kind: s.kind, reason: s.reason })),
    warnings: manifestWarnings(m),
    people: m.people.length,
  };
}

export const discoveryRouter = router({
  catalog: migrationProcedure.input(z.object({ includeMyTasks: z.boolean().default(false) }).default({ includeMyTasks: false })).output(z.object({
    boards: z.array(z.object({
      id: z.string(), name: z.string(), items: z.number(), kind: z.string(), selectable: z.boolean(), why: z.string().nullable(), privacy: z.string().nullable(),
      archived: z.boolean(),
      workspace: z.string(), workspaceId: z.string().nullable(), folder: z.string().nullable(),
    })),
    spaces: z.array(z.object({ id: z.number(), title: z.string() })),
  })).query(async ({ ctx, input }) => {
    const { asana, plaky } = await depsFor(ctx, input.migrationId, () => undefined);
    const [projects, personal, spaces] = await Promise.all([asana.listProjects(), input.includeMyTasks ? asana.listPersonalProjects() : [], plaky.allSpaces()]);
    const listed = [...projects, ...personal];
    return {
      boards: listed.map((p) => ({
        id: p.gid, name: p.name, items: p.tasks, kind: BOARD_TYPE,
        selectable: true,
        archived: p.archived,
        why: p.archived ? "archived in Asana: carried only if ticked" : p.gid.startsWith("mytasks:") ? "Only tasks outside projects; choose a private destination. Counted when read." : null,
        privacy: privacyFlag(p.privacy === "private" ? "private" : p.privacy === "private_to_team" ? "team" : null),
        workspace: p.workspace.name, workspaceId: p.workspace.gid, folder: p.team,
      })),
      spaces: spaces.map((s) => ({ id: Number(s.id), title: s.title ?? String(s.id) })),
    };
  }),

  split: migrationProcedure.output(z.object({ migrations: z.array(z.object({ migrationId: z.number(), workspace: z.string(), boards: z.number() })) })).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "the split", async () => {
      if (await loadManifest(ctx.db, input.migrationId)) throw new PreconditionError("split before reading the boards: this migration has read them already");
      const { asana } = await depsFor(ctx, input.migrationId, () => undefined);
      const listed = await asana.listProjects({ counts: false });
      const groups = new Map<string, { name: string; ids: string[] }>();
      for (const p of listed) {
        if (p.archived) continue;
        const group = groups.get(p.workspace.gid) ?? { name: p.workspace.name, ids: [] };
        group.ids.push(p.gid);
        groups.set(p.workspace.gid, group);
      }
      if (groups.size < 2) throw new PreconditionError("the boards are all in one workspace: there is nothing to split");
      const current = await getMigration(ctx.db, input.migrationId);
      const [first, ...rest] = [...groups.values()];
      const out = [{ migrationId: input.migrationId, workspace: first!.name, boards: first!.ids.length }];
      await updateSetup(ctx.db, input.migrationId, { options: { ...current.options, pick: first!.ids } });
      await renameMigration(ctx.db, input.migrationId, `${current.name} — ${first!.name}`);
      for (const group of rest) {
        const migrationId = await createMigration(ctx.db, { connectionId: current.connectionId, name: `${current.name} — ${group.name}`, plakySpaceId: current.plakySpaceId, options: { ...current.options, pick: group.ids } });
        out.push({ migrationId, workspace: group.name, boards: group.ids.length });
      }
      return { migrations: out };
    });
  }),

  run: migrationProcedure.input(z.object({ boardIds: z.array(z.string().regex(/^(?:mytasks:)?\d{1,20}$/, "an Asana board id")).min(1).max(500), spaceId: z.number().int().positive(), options: optionsInput })).output(z.object({ manifest: manifestSummary, messages: z.array(z.object({ level: z.string(), code: z.string(), message: z.string() })) })).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "discovery", async () => {
      const events = collect();
      const deps = await depsFor(ctx, input.migrationId, events.log);
      const known = (await deps.plaky.allSpaces()).some((s) => Number(s.id) === input.spaceId);
      if (!known) throw new PreconditionError(`Plaky space ${input.spaceId} does not exist in this workspace`);
      await updateSetup(ctx.db, input.migrationId, { plakySpaceId: input.spaceId, options: input.options });
      const extras = [...(input.options.withCreated ? ["created"] : []), ...(input.options.withLink ? ["link"] : [])];
      const seen = new Set(((await loadManifest(ctx.db, input.migrationId))?.people ?? []).map((p) => p.id));
      const manifest = await discoverStep(deps, { only: input.boardIds, extras, listArchived: true, handLists: true, subitems: input.options.subitems });
      dropPlan(input.migrationId);
      if (manifest.people.some((p) => p.kind === "person" && !seen.has(p.id))) await defaultChoices(ctx.db, input.migrationId, manifest, await loadDirectory(deps.plaky), { seen });
      return { manifest: summarizeManifest((await loadManifest(ctx.db, input.migrationId)) ?? manifest), messages: events.messages() };
    });
  }),

  scope: migrationProcedure.query(async ({ ctx, input }) => {
    const manifest = await loadManifest(ctx.db, input.migrationId);
    const paid = (await getMigration(ctx.db, input.migrationId)).options.paidAsana === true;
    return manifest ? scopeReport(manifest, paid ? PAID_REQUESTS_PER_MINUTE : DEFAULT_REQUESTS_PER_MINUTE) : null;
  }),

  manifest: migrationProcedure.output(z.object({
    draftIdentity: z.string(),
    manifest: manifestSummary.nullable(), spaceId: z.number().nullable(), options: optionsInput.extend({ prune: z.boolean(), recreateDrifted: z.boolean() }), selected: z.array(z.string()),
    pick: z.array(z.string()).nullable(),
    seedFailures: z.array(z.string()),
  })).query(async ({ ctx, input }) => {
    const [migration, manifest] = await Promise.all([getMigration(ctx.db, input.migrationId), loadManifest(ctx.db, input.migrationId)]);
    const o = { ...DEFAULT_OPTIONS, ...migration.options };
    return {
      draftIdentity: `${migration.connectionId}:${migration.createdAt.getTime()}`,
      seedFailures: migration.seedFailures,
      manifest: manifest ? summarizeManifest(manifest) : null,
      spaceId: migration.plakySpaceId ?? env.PLAKY_E2E_SPACE_ID ?? null,
      options: { syncComments: o.syncComments, syncFiles: o.syncFiles, syncSubscribers: o.syncSubscribers, paidAsana: o.paidAsana === true, withCreated: o.withCreated, withLink: o.withLink, subitems: o.subitems ?? "auto", prune: o.prune, recreateDrifted: o.recreateDrifted },
      selected: manifest ? manifest.boards.filter((b) => b.parentBoardId === null).map((b) => b.id) : [],
      pick: migration.options.pick ?? null,
    };
  }),
});
