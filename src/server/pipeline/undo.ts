import { canInspectForUndo, entityState } from "./load/entity-state";
import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { entityMappings, migrationLogs, migrationRuns } from "@/db/schema";
import { isNotSent, isOutcomeUnknown, isPlakyNotFound, isRateLimited, type PlakyItem } from "../clients/plaky";
import type { PipelinePlaky } from "./load/guarded";
import { deleteGroup, deleteRow, type Deleted } from "./load/guarded";
import { PreconditionError } from "../errors";
import type { BoardSync } from "./config";
import type { PipelineLog } from "./events";
import { withBoardLocks } from "./load";
import { cellHash, findField } from "./plan";
import { DbLoadStore } from "./store-load";
import { clearSyncPoints, loadLinkConfig, markBoardUnapplied } from "./store";
import { asId, plakyFieldsFromBoard } from "./transform/mapping";
import { pyStrip } from "./transform/pystr";
import { linkCellsMoved, madeInPlaky, type LinkCells } from "./load/owned";
import { forRow, forgetWritten, loadWritten, valueHash, writtenView, type WrittenView } from "./written";
import { rowOwnership } from "./plan/ownership";
import { loadDirectory } from "./plan/existing";
import type { PlakyField } from "./transform/mapping";

export type UndoItem = { asanaId: string; plakyId: number; title: string; comments?: number | undefined; files?: number | undefined };
export type UndoGroup = { plakyId: number; title: string };
export type UndoPreview = {
  board: { asanaBoardId: string; name: string; plakySpaceId: number; plakyBoardId: number };
  items: UndoItem[];
  groups: UndoGroup[];
  kept: string[];
  gone: string[];
  goneIds: string[];
  goneNestedIds: string[];
  goneMappings: number[];
  goneRows: number[];
  keptItems: number;
  nested: (UndoItem & { parent: number })[];
};
export type UndoResult = UndoPreview & { deletedItems: number; deletedNested: number; deletedGroups: number; failures: string[]; reset: boolean };

type Mapping = typeof entityMappings.$inferSelect;

const FORGET_SLICE = 500;

async function createdByMigration(db: Db, migrationId: number, code: "item.created" | "group.created", key: "plakyItemId" | "plakyGroupId", ids: ReadonlySet<number>): Promise<Set<number>> {
  if (!ids.size) return new Set();
  const types = code === "group.created" ? (["group"] as const) : (["item", "subitem"] as const);
  const recorded = await db.select({ id: entityMappings.createdPlakyId }).from(entityMappings)
    .where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, [...types]), isNotNull(entityMappings.createdPlakyId)));
  const rows = await db.select({ data: migrationLogs.data }).from(migrationLogs).innerJoin(migrationRuns, eq(migrationRuns.id, migrationLogs.runId))
    .where(and(eq(migrationRuns.migrationId, migrationId), eq(migrationLogs.code, code)));
  const logged = rows.map((r) => (r.data as Record<string, unknown> | null)?.[key]);
  return new Set([...recorded.map((r) => r.id), ...logged].filter((id): id is number => typeof id === "number" && ids.has(id)));
}
type Row = {
  id: number; title: string; group: number | null; parent: number | null; asanaId: string | null; comments: number | null; files: number | null;
  fields: { key: string; value?: unknown }[];
};

function boardOf(config: { boards: readonly BoardSync[] }, asanaBoardId: string): BoardSync {
  const board = config.boards.find((b) => b.asanaBoardId === asanaBoardId);
  if (!board) throw new PreconditionError(`Asana board ${asanaBoardId} is not linked in this migration`);
  return board;
}

const rowOf = (item: PlakyItem, idKey: string | null): Row => {
  const value = idKey === null ? undefined : (item.fields ?? []).find((f) => f.key === idKey)?.value;
  return {
    id: Number(item.id), title: item.title ?? "", group: asId(item.group), parent: asId(item.parent), asanaId: typeof value === "string" && pyStrip(value) ? pyStrip(value) : null,
    comments: item.commentCount ?? null, files: item.fileCount ?? null, fields: (item.fields ?? []).map((f) => ({ key: f.key, value: f.value })),
  };
};

async function mappingsOf(db: Db, migrationId: number, board: BoardSync, onBoard: ReadonlySet<string>): Promise<{ items: Mapping[]; groups: Mapping[]; nested: Mapping[] }> {
  const type = board.subitemsOf ? "subitem" : "item";
  const all = await db.select().from(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, ["item", "subitem", "group"])));
  return {
    items: all.filter((m) => m.entityType === type && (m.plakyParentId === board.plakyBoardId || (m.plakyParentId === null && (m.scope === board.asanaBoardId || (m.scope === "" && onBoard.has(m.asanaId)))))),
    groups: all.filter((m) => m.entityType === "group" && m.scope === board.asanaBoardId && m.plakyParentId === board.plakyBoardId),
    nested: board.subitemsOf ? [] : all.filter((m) => m.entityType === "subitem" && m.plakyParentId === board.plakyBoardId),
  };
}

async function readBoard(plaky: PipelinePlaky, board: BoardSync): Promise<{ rows: Row[]; groups: Map<number, string>; fields: PlakyField[]; idKey: string | null }> {
  const plakyBoard = await plaky.getBoard(board.plakySpaceId, board.plakyBoardId).catch((error: unknown) => {
    if (isPlakyNotFound(error)) {
      throw new PreconditionError(`"${board.name}" is no longer in Plaky (board ${board.plakyBoardId} was deleted, or moved to another space), so there is nothing on it to undo.`);
    }
    throw error;
  });
  const fields = plakyFieldsFromBoard(plakyBoard);
  const idField = findField(fields, board.asanaIdField);
  const items = await plaky.allItems(board.plakySpaceId, board.plakyBoardId, "INCLUDE");
  const groups = await plaky.allItemGroups(board.plakySpaceId, board.plakyBoardId);
  return {
    rows: items.filter((i) => !i.archived && !i.deleted).map((i) => rowOf(i, idField?.key ?? null)), groups: new Map(groups.map((g) => [Number(g.id), g.title ?? ""])),
    fields, idKey: idField?.key ?? null,
  };
}

type Judge = (asanaId: string, row: Row) => Promise<string[]>;

async function judgeOf(db: Db, migrationId: number, plaky: PipelinePlaky, board: BoardSync, fields: readonly PlakyField[]): Promise<{ judge: Judge; view: WrittenView }> {
  const view = (await loadWritten(db, migrationId, [board.plakyBoardId])).get(board.plakyBoardId) ?? writtenView(new Map());
  const support = new Set([board.asanaIdField, board.parentTitleField, board.parentIdField].flatMap((named) => {
    const field = named ? findField(fields, named) : null;
    return field ? [field.key] : [];
  }));
  const owns = rowOwnership(view, fields, await loadDirectory(plaky), support);
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const parentFields = board.subitemsOf && !board.nested ? [board.parentTitleField, board.parentIdField].flatMap((named) => {
    const field = named ? findField(fields, named) : null;
    return field ? [{ key: field.key, name: field.name }] : [];
  }) : [];
  const linkCells: LinkCells = { asanaIdKey: findField(fields, board.asanaIdField)?.key ?? null, parentFields, hash: (key, value) => cellHash(fieldByKey.get(key), value) };
  const ourFiles = new Set((await db.select({ plakyId: entityMappings.plakyId }).from(entityMappings)
    .where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, "file")))).flatMap((r) => (r.plakyId === null ? [] : [r.plakyId])));
  const judge: Judge = async (asanaId, row) => {
    const record = forRow(view, asanaId, row.id);
    const made = await madeInPlaky(plaky, board.plakySpaceId, board.plakyBoardId, { id: row.id, commentCount: row.comments, fileCount: row.files },
      (fileId) => ourFiles.has(fileId) || record?.(`__file:${fileId}`) !== undefined,
      (commentId, content) => record?.(`__comment:${commentId}`) === valueHash(content));
    const moved = record?.("__row") === undefined ? [] : linkCellsMoved(row.fields, { asanaId, record }, linkCells);
    return [...moved, ...owns.reasons(asanaId, row), ...(made.length ? [`holds ${made.join(" and ")}`] : [])];
  };
  return { judge, view };
}

export async function previewUndo(db: Db, migrationId: number, plaky: PipelinePlaky, asanaBoardId: string): Promise<UndoPreview> {
  return (await previewWith(db, migrationId, plaky, asanaBoardId)).preview;
}

async function previewWith(db: Db, migrationId: number, plaky: PipelinePlaky, asanaBoardId: string): Promise<{ preview: UndoPreview; judge: Judge; idKey: string | null }> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const board = boardOf(loaded.config, asanaBoardId);
  const { rows, groups, fields, idKey } = await readBoard(plaky, board);
  const { judge, view } = await judgeOf(db, migrationId, plaky, board, fields);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mapped = await mappingsOf(db, migrationId, board, new Set(rows.flatMap((r) => (r.asanaId ? [r.asanaId] : []))));
  const out: UndoPreview = { board: { asanaBoardId, name: board.name, plakySpaceId: board.plakySpaceId, plakyBoardId: board.plakyBoardId }, items: [], groups: [], kept: [], gone: [], goneIds: [], goneNestedIds: [], goneMappings: [], goneRows: [], keptItems: 0, nested: [] };
  const keep = (why: string): void => {
    out.kept.push(why);
    out.keptItems++;
  };

  const ours = new Set<number>();
  for (const m of mapped.items) {
    const label = `Asana item ${m.asanaId}`;
    const refusedForGood = entityState(m) === "refused";
    if (!canInspectForUndo(m)) {
      keep(`${label}: its last write is ${refusedForGood ? "refused for good" : m.status}${m.lastError ? ` (${m.lastError.slice(0, 200)})` : ""}, so what Plaky holds for it is not known; not deleted`);
      continue;
    }
    const row = m.plakyId === null ? undefined : byId.get(m.plakyId);
    if (!row) {
      out.gone.push(`${label}: Plaky row ${m.plakyId ?? "?"} is not on the board any more`);
      out.goneIds.push(m.asanaId);
      out.goneMappings.push(m.id);
      if (m.plakyId !== null) out.goneRows.push(m.plakyId);
      continue;
    }
    if (row.asanaId !== m.asanaId) {
      keep(`${label}: Plaky row ${row.id} '${row.title}' carries Asana ID ${row.asanaId ?? "(none)"} now; not deleted`);
      continue;
    }
    ours.add(row.id);
  }
  const created = await createdByMigration(db, migrationId, "item.created", "plakyItemId", ours);
  const mappingOf = new Map(mapped.items.flatMap((m) => (m.plakyId === null ? [] : [[m.plakyId, m] as const])));
  for (const id of [...ours]) {
    if (created.has(id)) continue;
    ours.delete(id);
    keep(`Asana item ${mappingOf.get(id)!.asanaId}: Plaky row ${id} '${byId.get(id)!.title}' was not created by a run of this migration (it existed before, or its create was never confirmed); not deleted`);
  }
  const nestedCandidates = mapped.nested.filter((m) => m.plakyId !== null && canInspectForUndo(m));
  const nestedCreated = await createdByMigration(db, migrationId, "item.created", "plakyItemId", new Set(nestedCandidates.map((m) => m.plakyId!)));
  const nestedOurs = new Map<number, string>();
  const nestedProtected = new Set<number>();
  for (const m of nestedCandidates.filter((x) => nestedCreated.has(x.plakyId!))) {
    const row = byId.get(m.plakyId!);
    if (!row) {
      out.gone.push(`nested Asana item ${m.asanaId}: Plaky row ${m.plakyId} is not on the board any more`);
      out.goneNestedIds.push(m.asanaId);
      out.goneMappings.push(m.id);
      out.goneRows.push(m.plakyId!);
      continue;
    }
    if (row.asanaId !== m.asanaId || (await judge(m.asanaId, row)).length) nestedProtected.add(row.id);
    else nestedOurs.set(row.id, m.asanaId);
  }
  for (const id of [...ours]) {
    const row = byId.get(id)!;
    const why = await judge(mappingOf.get(id)!.asanaId, row);
    if (why.length) {
      ours.delete(id);
      keep(`Plaky row ${id} '${row.title}': ${why.join("; ")}; not deleted`);
    }
  }
  const childrenOf = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.parent === null) continue;
    const siblings = childrenOf.get(r.parent);
    if (siblings) siblings.push(r);
    else childrenOf.set(r.parent, [r]);
  }
  for (const id of [...ours]) {
    const children = childrenOf.get(id) ?? [];
    const foreign = children.filter((r) => !ours.has(r.id) && !nestedOurs.has(r.id) && !nestedProtected.has(r.id));
    const guarded = children.filter((r) => nestedProtected.has(r.id));
    if (foreign.length || guarded.length) {
      ours.delete(id);
      const why = [
        ...(foreign.length ? [`holds ${foreign.length} nested row(s) this migration did not write`] : []),
        ...(guarded.length ? [`holds ${guarded.length} nested row(s) with work made or changed in Plaky`] : []),
      ];
      keep(`Plaky row ${id} '${byId.get(id)!.title}': ${why.join("; ")}; not deleted`);
    }
  }
  const asanaOf = new Map(mapped.items.filter((m) => m.plakyId !== null && ours.has(m.plakyId)).map((m) => [m.plakyId!, m.asanaId]));
  const counts = (r: Row) => ({ ...(r.comments ? { comments: r.comments } : {}), ...(r.files ? { files: r.files } : {}) });
  out.items = rows.filter((r) => ours.has(r.id)).map((r) => ({ asanaId: asanaOf.get(r.id)!, plakyId: r.id, title: r.title, ...counts(r) }));
  out.nested = rows.filter((r) => r.parent !== null && ours.has(r.parent) && nestedOurs.has(r.id)).map((r) => ({ asanaId: nestedOurs.get(r.id)!, plakyId: r.id, title: r.title, parent: r.parent!, ...counts(r) }));

  const mappedPlaky = new Set(mapped.items.flatMap((m) => (m.plakyId === null ? [] : [m.plakyId])));
  const mappedAsana = new Set(mapped.items.map((m) => m.asanaId));
  const foreignIds = rows.filter((r) => r.asanaId !== null && !ours.has(r.id) && !nestedOurs.has(r.id) && !mappedPlaky.has(r.id) && !mappedAsana.has(r.asanaId));
  if (foreignIds.length) out.kept.push(`${foreignIds.length} row(s) carry an Asana ID this migration has no record of writing; not deleted`);

  const createdGroups = await createdByMigration(db, migrationId, "group.created", "plakyGroupId", new Set(mapped.groups.flatMap((m) => (m.plakyId === null ? [] : [m.plakyId]))));
  const stayingIn = new Map<number | null, number>();
  for (const r of rows) if (!ours.has(r.id) && !(r.parent !== null && ours.has(r.parent))) stayingIn.set(r.group, (stayingIn.get(r.group) ?? 0) + 1);
  for (const m of mapped.groups) {
    if (m.plakyId === null || !createdGroups.has(m.plakyId)) continue;
    const title = groups.get(m.plakyId);
    if (title === undefined) {
      out.gone.push(`group ${m.plakyId}: not on the board any more`);
      continue;
    }
    if (m.plakyId === board.seedGroupId) continue;
    if (view.get("", `__group_title:${m.plakyId}`) !== valueHash(title)) {
      out.kept.push(`group '${title}': renamed in Plaky since the app titled it (or there is no record of the title it gave); not deleted`);
      continue;
    }
    const staying = stayingIn.get(m.plakyId) ?? 0;
    if (staying) out.kept.push(`group '${title}': still holds ${staying} row(s) that are not deleted; not deleted`);
    else out.groups.push({ plakyId: m.plakyId, title });
  }
  if (out.groups.length && out.groups.length === groups.size) {
    const last = out.groups.pop()!;
    out.kept.push(`group '${last.title}': a Plaky board keeps one group, so it stays, empty; the next move uses it again`);
  }
  return { preview: out, judge, idKey };
}

const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export type UndoExpected = { items: readonly number[]; groups: readonly number[]; nested?: readonly number[] };

export const sameIdSet = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  const [x, y] = [[...a].sort((p, q) => p - q), [...b].sort((p, q) => p - q)];
  return x.every((id, i) => id === y[i]);
};

export async function applyUndo(
  db: Db, migrationId: number, plaky: PipelinePlaky, asanaBoardId: string, confirm: string, log: PipelineLog = () => undefined, expected?: UndoExpected,
  owner?: string,
  hooks: { beforeDelete?: () => Promise<unknown> } = {},
): Promise<UndoResult> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const board = boardOf(loaded.config, asanaBoardId);
  if (confirm.trim() !== board.name.trim()) throw new PreconditionError(`type the board's name, "${board.name}", to confirm`);
  const store = new DbLoadStore({ db, migrationId, ...(owner === undefined ? {} : { owner }) });
  return withBoardLocks(store, [{ space: board.plakySpaceId, board: board.plakyBoardId }], async () => {
    const { preview, judge, idKey } = await previewWith(db, migrationId, plaky, asanaBoardId);
    const sameNested = expected?.nested === undefined || sameIdSet(expected.nested, preview.nested.map((n) => n.plakyId));
    if (expected && !(sameIdSet(expected.items, preview.items.map((i) => i.plakyId)) && sameIdSet(expected.groups, preview.groups.map((g) => g.plakyId)) && sameNested)) {
      throw new PreconditionError("Plaky changed since the dry run (a run wrote to the board meanwhile): preview the undo again");
    }
    const result: UndoResult = { ...preview, deletedItems: 0, deletedNested: 0, deletedGroups: 0, failures: [], reset: false };
    const type = board.subitemsOf ? "subitem" : "item";
    const forget = async (o: { rows?: readonly number[]; mappings?: readonly number[]; asanaIds?: readonly string[] }, entityType: "item" | "subitem" = type): Promise<void> => {
      const rows = o.rows ?? [];
      for (let at = 0; at < rows.length; at += FORGET_SLICE) {
        const slice = rows.slice(at, at + FORGET_SLICE);
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, entityType), eq(entityMappings.plakyParentId, board.plakyBoardId), inArray(entityMappings.plakyId, slice)));
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, ["comment", "file"]), inArray(entityMappings.plakyParentId, slice)));
      }
      const asanaIds = o.asanaIds ?? [];
      for (let at = 0; at < asanaIds.length; at += FORGET_SLICE) {
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, ["comment", "file"]), isNull(entityMappings.plakyParentId), inArray(entityMappings.scope, asanaIds.slice(at, at + FORGET_SLICE))));
      }
      const mappings = o.mappings ?? [];
      for (let at = 0; at < mappings.length; at += FORGET_SLICE) {
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.id, mappings.slice(at, at + FORGET_SLICE))));
      }
    };
    const nestedUnder = new Map<number, string[]>();
    const nestedRows = new Map<number, typeof preview.nested>();
    for (const n of preview.nested) {
      nestedUnder.set(n.parent, [...(nestedUnder.get(n.parent) ?? []), n.asanaId]);
      nestedRows.set(n.parent, [...(nestedRows.get(n.parent) ?? []), n]);
    }
    let announced = false;
    const beforeDelete = async (): Promise<void> => {
      if (announced) return;
      announced = true;
      await hooks.beforeDelete?.();
    };
    const changedSince = async (item: UndoItem, fresh: PlakyItem, children: readonly PlakyItem[]): Promise<string[]> => {
      const now = rowOf(fresh, idKey);
      if (now.asanaId !== item.asanaId) return [`carries Asana ID ${now.asanaId ?? "(none)"} now`];
      const why = await judge(item.asanaId, now);
      const listed = nestedRows.get(item.plakyId) ?? [];
      const known = new Set(listed.map((n) => n.plakyId));
      if (children.some((c) => !known.has(Number(c.id)))) why.push("holds a nested row added since the dry run");
      for (const n of listed) {
        const child = children.find((c) => Number(c.id) === n.plakyId);
        if (child === undefined) continue;
        const row = rowOf(child, idKey);
        if (row.asanaId !== n.asanaId || (await judge(n.asanaId, row)).length) why.push(`its nested row '${n.title}' holds work made or changed in Plaky`);
      }
      return why;
    };
    const held = async (): Promise<boolean> => {
      let ok = false;
      try {
        ok = await store.heartbeat();
      } catch {
        ok = false;
      }
      if (!ok) result.failures.push(`stopped: the lease on Plaky board ${board.plakySpaceId}/${board.plakyBoardId} was lost; undo again to finish`);
      return ok;
    };
    await forget({ mappings: preview.goneMappings, asanaIds: [...preview.goneIds, ...preview.goneNestedIds] });
    await forget({ rows: preview.goneRows }, "subitem");
    const forgotten: string[] = [...preview.goneIds, ...preview.goneNestedIds];
    const groupsForgotten: number[] = [];
    const nestedHere = loaded.config.boards.filter((b) => b.nested && b.subitemsOf === asanaBoardId).map((b) => b.asanaBoardId);
    if (preview.items.length || preview.groups.length) await clearSyncPoints(db, migrationId, [asanaBoardId, ...nestedHere]);
    const left = new Set(preview.items.map((i) => i.plakyId));
    let stopped = false;
    for (const item of preview.items) {
      if (!(await held())) {
        stopped = true;
        break;
      }
      let attempted = false;
      let deleted: Deleted;
      try {
        deleted = await deleteRow(plaky, { space: board.plakySpaceId, board: board.plakyBoardId, row: item.plakyId }, (fresh, children) => changedSince(item, fresh, children), async (request) => {
          attempted = true;
          await beforeDelete();
          return request();
        });
      } catch (error) {
        if (!attempted) throw error;
        const why = isOutcomeUnknown(error) ? `delete dispatched, outcome unknown (${textOf(error)}); the next undo checks again` : textOf(error);
        result.failures.push(`item '${item.title}' (asana ${item.asanaId}): ${why}`);
        log({ level: isOutcomeUnknown(error) ? "ambiguous" : "error", code: "undo.item_failed", board: board.name, message: `item '${item.title}': ${why}`, data: { asanaItemId: item.asanaId, plakyItemId: item.plakyId } });
        if (isRateLimited(error) || isNotSent(error, "held")) {
          stopped = true;
          break;
        }
        continue;
      }
      if (deleted.done === "gone") await beforeDelete();
      if (deleted.done === "kept") {
        result.kept.push(deleted.slow
          ? `Plaky row ${item.plakyId} '${item.title}': ${deleted.why.join("; ")}; undo again, or delete it by hand if it should go`
          : `Plaky row ${item.plakyId} '${item.title}': ${deleted.why.join("; ")} (since the dry run); not deleted`);
        continue;
      }
      await forget({ rows: [item.plakyId], asanaIds: [item.asanaId] });
      await forget({ rows: (nestedRows.get(item.plakyId) ?? []).map((n) => n.plakyId), asanaIds: nestedUnder.get(item.plakyId) ?? [] }, "subitem");
      forgotten.push(item.asanaId, ...(nestedUnder.get(item.plakyId) ?? []));
      left.delete(item.plakyId);
      if (deleted.done === "gone") {
        result.gone.push(`item '${item.title}' (asana ${item.asanaId}): Plaky row ${item.plakyId} was gone from the board already, so the undo did not delete it; its record is cleared`);
        continue;
      }
      result.deletedItems++;
      result.deletedNested += nestedUnder.get(item.plakyId)?.length ?? 0;
      log({ level: "info", code: "undo.item_deleted", board: board.name, message: `item '${item.title}' deleted`, data: { asanaItemId: item.asanaId, plakyItemId: item.plakyId } });
    }
    if (left.size === 0 && preview.keptItems === 0) {
      await markBoardUnapplied(db, migrationId, asanaBoardId);
      const nestedLeft = nestedHere.length
        ? (await db.select({ n: count() }).from(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, "subitem"), eq(entityMappings.plakyParentId, board.plakyBoardId))))[0]?.n ?? 0
        : 0;
      if (nestedLeft === 0) for (const nested of nestedHere) await markBoardUnapplied(db, migrationId, nested);
      result.reset = true;
    }
    try {
      const now = stopped || !preview.groups.length ? null : await readBoard(plaky, board);
      const stillIn = new Set((now?.rows ?? []).map((r) => r.group));
      for (const group of stopped ? [] : preview.groups) {
        if (stillIn.has(group.plakyId)) {
          result.kept.push(`group '${group.title}': still holds rows; not deleted`);
          continue;
        }
        if (!(await held())) break;
        let gone = false;
        try {
          const deleted = await deleteGroup(plaky, { space: board.plakySpaceId, board: board.plakyBoardId, group: group.plakyId }, (fresh) => (fresh.title ?? "") !== group.title, async (request) => {
            await beforeDelete();
            return request();
          });
          if (deleted.done === "left") {
            result.kept.push(`group '${group.title}': renamed in Plaky since the dry run; not deleted`);
            continue;
          }
          if (deleted.done === "holds") {
            result.kept.push(`group '${group.title}': still holds rows; not deleted`);
            continue;
          }
          if (deleted.done === "slow") {
            result.kept.push(`group '${group.title}': its checks took longer than 5 s three times, so it was not deleted; undo again, or delete it by hand if it should go`);
            continue;
          }
          gone = deleted.done === "gone";
        } catch (error) {
          result.failures.push(`group '${group.title}': ${textOf(error)}`);
          log({ level: "error", code: "undo.group_failed", board: board.name, message: `group '${group.title}': ${textOf(error)}` });
          if (isRateLimited(error)) break;
          continue;
        }
        if (gone) await beforeDelete();
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, "group"), eq(entityMappings.scope, board.asanaBoardId), eq(entityMappings.plakyId, group.plakyId)));
        groupsForgotten.push(group.plakyId);
        if (gone) {
          result.gone.push(`group '${group.title}': Plaky group ${group.plakyId} was gone from the board already, so the undo did not delete it; its record is cleared`);
          continue;
        }
        result.deletedGroups++;
        log({ level: "info", code: "undo.group_deleted", board: board.name, message: `group '${group.title}' deleted`, data: { plakyGroupId: group.plakyId } });
      }
    } finally {
      await forgetWritten(db, migrationId, board.plakyBoardId, forgotten, groupsForgotten);
    }
    return result;
  });
}
