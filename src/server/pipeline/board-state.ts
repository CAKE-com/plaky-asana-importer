import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "@/db/client";
import { entityMappings, migrationBoards, migrationColumns, migrations } from "@/db/schema";
import { boardWarnings, type Manifest } from "./manifest";
import { seedOf } from "./provision";
import { boardsWritingDifferently, checkConfig, type BoardSync, type PeopleMap, type SyncConfig } from "./config";

export type Pairing = "unpaired" | "found" | "linked" | "gone";

export function pairingOf(row: Pick<typeof migrationBoards.$inferSelect, "plakyBoardId" | "plakySpaceId" | "linkPosition"> | null, manifestPlakyBoardId: number | null): Pairing {
  const linked = row !== null && row.linkPosition !== null && row.plakyBoardId !== null && row.plakySpaceId !== null;
  if (linked) return manifestPlakyBoardId === null ? "gone" : "linked";
  return manifestPlakyBoardId === null ? "unpaired" : "found";
}

export async function recordManifestBoards(db: Db, id: number, manifest: Manifest): Promise<void> {
  for (const board of manifest.boards) {
    const values = {
      asanaBoardName: board.name, hierarchyType: board.hierarchyType, itemsCount: board.itemsCount, subitemsOf: board.parentBoardId,
      ...(board.plakyBoardId === null ? {} : { plakyBoardId: board.plakyBoardId }), byHand: [...board.byHand], warnings: boardWarnings(seedOf(board, manifest)),
    };
    const [row] = await db.insert(migrationBoards).values({ migrationId: id, asanaBoardId: board.id, ...values })
      .onConflictDoUpdate({ target: [migrationBoards.migrationId, migrationBoards.asanaBoardId], set: values }).returning({ id: migrationBoards.id });
    const replace: BatchItem<"sqlite">[] = [db.delete(migrationColumns).where(eq(migrationColumns.migrationBoardId, row!.id))];
    if (board.columns.length) {
      replace.push(db.insert(migrationColumns).values(board.columns.map((c, position) => ({
        migrationBoardId: row!.id, asanaColumnId: c.id, title: c.title, asanaType: c.type, fieldName: c.fieldName,
        plakyType: c.plakyType as (typeof migrationColumns.$inferInsert)["plakyType"], reason: c.reason, labels: [...c.labels],
        labelCollisions: [...c.labelCollisions], position,
      }))));
    }
    await db.batch(replace as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

export async function saveLinkConfig(db: Db, id: number, config: SyncConfig): Promise<SyncConfig> {
  checkConfig(config.boards, `migration ${id} config`);
  const previous = await loadLinkConfig(db, id);
  const differently = previous ? boardsWritingDifferently(previous.config, config) : [];
  const batch: BatchItem<"sqlite">[] = [
    db.update(migrations).set({ people: config.people as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, id)),
    db.update(migrationBoards).set({ linkPosition: null }).where(eq(migrationBoards.migrationId, id)),
  ];
  if (differently.length) batch.push(db.update(migrationBoards).set({ syncedReadAt: null }).where(and(eq(migrationBoards.migrationId, id), inArray(migrationBoards.asanaBoardId, differently))));
  for (const [linkPosition, b] of config.boards.entries()) {
    const values = {
      asanaBoardName: b.name, plakySpaceId: b.plakySpaceId, plakyBoardId: b.plakyBoardId, linkPosition, fieldMap: b.fieldMap, skipColumns: b.skipColumns, labelMap: b.labelMap,
      asanaIdFieldKey: b.asanaIdField, subitemsOf: b.subitemsOf, nested: b.nested, parentTitleFieldKey: b.parentTitleField, parentIdFieldKey: b.parentIdField,
      syncGroups: b.syncGroups, syncSubscribers: b.syncSubscribers, syncComments: b.syncComments, syncFiles: b.syncFiles, seedGroupId: b.seedGroupId, applied: b.applied,
    };
    batch.push(db.insert(migrationBoards).values({ migrationId: id, asanaBoardId: b.asanaBoardId, ...values })
      .onConflictDoUpdate({ target: [migrationBoards.migrationId, migrationBoards.asanaBoardId], set: values }));
  }
  await db.batch(batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return config;
}

export async function linkedRows(db: Db, id: number): Promise<(typeof migrationBoards.$inferSelect & { plakySpaceId: number; plakyBoardId: number })[]> {
  const rows = await db.select().from(migrationBoards).where(and(eq(migrationBoards.migrationId, id), isNotNull(migrationBoards.linkPosition))).orderBy(asc(migrationBoards.linkPosition));
  return rows.map((r) => {
    if (r.plakySpaceId === null || r.plakyBoardId === null) throw new Error(`migration ${id}: linked board ${r.asanaBoardId} has no Plaky board recorded`);
    return { ...r, plakySpaceId: r.plakySpaceId, plakyBoardId: r.plakyBoardId };
  });
}

export async function loadLinkConfig(db: Db, id: number): Promise<{ config: SyncConfig } | null> {
  const rows = await linkedRows(db, id);
  if (!rows.length) return null;
  const boards = rows.map((r): BoardSync => ({
    name: r.asanaBoardName, asanaBoardId: r.asanaBoardId, plakySpaceId: r.plakySpaceId, plakyBoardId: r.plakyBoardId, fieldMap: r.fieldMap, skipColumns: r.skipColumns, labelMap: r.labelMap,
    asanaIdField: r.asanaIdFieldKey, subitemsOf: r.subitemsOf, nested: r.nested, parentTitleField: r.parentTitleFieldKey, parentIdField: r.parentIdFieldKey,
    syncGroups: r.syncGroups, syncSubscribers: r.syncSubscribers, syncComments: r.syncComments, syncFiles: r.syncFiles, seedGroupId: r.seedGroupId, applied: r.applied,
  }));
  const people = (await db.select({ people: migrations.people }).from(migrations).where(eq(migrations.id, id)).limit(1))[0]?.people;
  if (people === undefined) throw new Error(`no migration ${id}`);
  return { config: { boards, people: people as PeopleMap } };
}

export async function markBoardApplied(db: Db, id: number, asanaBoardId: string): Promise<boolean> {
  const updated = await db.update(migrationBoards).set({ applied: true })
    .where(and(eq(migrationBoards.migrationId, id), eq(migrationBoards.asanaBoardId, asanaBoardId))).returning({ id: migrationBoards.id });
  return updated.length > 0;
}

export async function markBoardUnapplied(db: Db, id: number, asanaBoardId: string): Promise<void> {
  await db.update(migrationBoards).set({ applied: false, syncedReadAt: null }).where(and(eq(migrationBoards.migrationId, id), eq(migrationBoards.asanaBoardId, asanaBoardId)));
}

export async function forgetPlakyBoard(db: Db, id: number, plakyBoardId: number): Promise<void> {
  const rows = await db.select({ plakyId: entityMappings.plakyId, asanaId: entityMappings.asanaId }).from(entityMappings)
    .where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["item", "subitem"]), eq(entityMappings.plakyParentId, plakyBoardId)));
  const items = rows.flatMap((r) => (r.plakyId === null ? [] : [r.plakyId]));
  for (let start = 0; start < items.length; start += 500) {
    await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["comment", "file"]), inArray(entityMappings.plakyParentId, items.slice(start, start + 500))));
  }
  const asanaIds = rows.map((r) => r.asanaId);
  for (let start = 0; start < asanaIds.length; start += 500) {
    await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["comment", "file"]), isNull(entityMappings.plakyParentId), inArray(entityMappings.scope, asanaIds.slice(start, start + 500))));
  }
  await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["item", "subitem", "group"]), eq(entityMappings.plakyParentId, plakyBoardId)));
}

export async function setSyncPoints(db: Db, id: number, asanaBoardIds: readonly string[], readAt: number): Promise<void> {
  if (!asanaBoardIds.length) return;
  await db.update(migrationBoards).set({ syncedReadAt: new Date(readAt) }).where(and(eq(migrationBoards.migrationId, id), inArray(migrationBoards.asanaBoardId, [...asanaBoardIds])));
}

export async function setEventTokens(db: Db, id: number, asanaBoardIds: readonly string[], tokens: ReadonlyMap<string, string>): Promise<void> {
  for (const board of asanaBoardIds) {
    const token = tokens.get(board);
    if (token) await db.update(migrationBoards).set({ eventToken: token }).where(and(eq(migrationBoards.migrationId, id), eq(migrationBoards.asanaBoardId, board)));
  }
}

export async function eventTokens(db: Db, id: number): Promise<Map<string, string>> {
  const rows = await db.select({ board: migrationBoards.asanaBoardId, token: migrationBoards.eventToken }).from(migrationBoards).where(eq(migrationBoards.migrationId, id));
  return new Map(rows.flatMap((r) => (r.token ? [[r.board, r.token] as [string, string]] : [])));
}

export async function clearSyncPoints(db: Db, id: number, asanaBoardIds?: readonly string[]): Promise<void> {
  if (asanaBoardIds && !asanaBoardIds.length) return;
  await db.update(migrationBoards).set({ syncedReadAt: null })
    .where(and(eq(migrationBoards.migrationId, id), ...(asanaBoardIds ? [inArray(migrationBoards.asanaBoardId, [...asanaBoardIds])] : [])));
}
