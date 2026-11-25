import type { PipelinePlaky } from "./load/guarded";
import { isHeader, isSkipped } from "@/lib/people-entry";
import { TEAM_KEY, type BoardSync, type PeopleMap, type SyncConfig } from "./config";
import type { BoardExtract, ColumnValue } from "./extract";
import { isSeedMarker } from "./names";
import {
  SHARED_ID_FIX,
  failureText,
  findField,
  holdsValue,
  loadDirectory,
  planBoard,
  nestedParentProblem,
  readPlakyRows,
  rowsByKey,
  uncarriedLine,
  writeAction,
  type ParentTitles,
  type PlakyRow,
} from "./plan";
import { MAX_COMMENTS_PER_ITEM, commentHeader, headerOf, markerOf, threads, type AsanaUpdate, type PlannedComment } from "./transform/comments";
import { filesInValue, MAX_UPLOAD_BYTES } from "./transform/files";
import { goneField, personRefs, plakyFieldsFromBoard, type PlakyField } from "./transform/mapping";
import { withNameValues } from "./name-fields";
import { resolvePeople, type UserDirectory } from "./transform/people";
import { isDict, pyStr, pyStrip, truthy } from "./transform/pystr";
import { cmpCodePoints } from "./transform/pyvalue";
import { forRow, writtenView, type WrittenView } from "./written";

export type FieldCoverage = { name: string; asanaFilled: number; plakyFilled: number };
export const shortfall = (coverage: FieldCoverage): number => Math.max(0, coverage.asanaFilled - coverage.plakyFilled);

export type BoardReport = {
  name: string;
  asanaBoardId: string;
  plakyBoardId: number;
  asanaItems: number;
  plakyItems: number;
  matched: number;
  missing: string[];
  extra: string[];
  unidentified: string[];
  seedRows: number;
  coverage: FieldCoverage[];
  dropped: string[];
  notes: string[];
  assigned: [kind: string, id: string][];
  differing: string[];
  notCarried: string[];
  commentsOrFilesShort: boolean;
  shortWithinLimits: boolean;
  uncarried: string[];
};

export function boardReport(
  init: Pick<BoardReport, "name" | "asanaBoardId" | "plakyBoardId" | "asanaItems" | "plakyItems" | "matched"> & Partial<BoardReport>,
): BoardReport {
  return {
    missing: [],
    extra: [],
    unidentified: [],
    seedRows: 0,
    coverage: [],
    dropped: [],
    notes: [],
    assigned: [],
    differing: [],
    notCarried: [],
    commentsOrFilesShort: false,
    shortWithinLimits: false,
    uncarried: [],
    ...init,
  };
}

export function boardComplete(board: BoardReport): boolean {
  return (
    board.missing.length === 0 &&
    board.extra.length === 0 &&
    board.unidentified.length === 0 &&
    !board.seedRows &&
    board.differing.length === 0 &&
    board.notCarried.length === 0 &&
    !board.commentsOrFilesShort &&
    board.uncarried.length === 0 &&
    !board.coverage.some((cov) => shortfall(cov)) &&
    board.asanaItems === board.plakyItems
  );
}

export type Receipt = { boards: BoardReport[]; unmatchedUsers: string[]; failures: string[] };

export const receipt = (init: Partial<Receipt> = {}): Receipt => ({ boards: [], unmatchedUsers: [], failures: [], ...init });
export const receiptOk = (r: Receipt): boolean => r.boards.every(boardComplete) && r.failures.length === 0 && r.unmatchedUsers.length === 0;
export const receiptAsanaItems = (r: Receipt): number => r.boards.reduce((sum, b) => sum + b.asanaItems, 0);
export const receiptMatched = (r: Receipt): number => r.boards.reduce((sum, b) => sum + b.matched, 0);

export type ManifestLike = { boards: readonly { id: string; dropped: readonly { title: string; type: string; reason: string }[] }[] };

const filled = (value: unknown): boolean => !(value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0));

function plakyFilled(value: unknown, target: PlakyField): boolean {
  if (target.type === "STATUS" || target.type === "TAG") {
    const empty = new Set(target.labelsByKey.filter(([, title]) => !title).map(([key]) => key));
    return (Array.isArray(value) ? value : [value]).some((v) => filled(v) && !empty.has(String(v)));
  }
  return filled(value);
}

function leftOut(refs: readonly (readonly [string, string])[], people: PeopleMap): boolean {
  const keys = refs.map(([kind, ref]) => (kind === "team" ? `${TEAM_KEY}${ref}` : ref));
  return keys.length > 0 && keys.every((key) => Object.hasOwn(people, key) && (isSkipped(people[key] as Record<string, unknown>) || isHeader(people[key] as Record<string, unknown>)));
}

const NO_VALUE: ColumnValue = { id: "", type: "" };

export type VerifyBoardOptions = {
  people?: PeopleMap | undefined;
  parentIds?: ReadonlySet<string> | undefined;
  rowsRead?: PlakyRow[] | undefined;
  rich?: boolean | undefined;
};

function requireAsanaIdField(config: BoardSync): void {
  if (!config.asanaIdField) {
    throw new Error(`'${config.name}' has no asana-id field; verification cannot match Plaky rows to Asana items`);
  }
}

export async function verifyBoard(
  read: BoardExtract,
  plaky: PipelinePlaky,
  config: BoardSync,
  manifest: ManifestLike | null = null,
  options: VerifyBoardOptions = {},
): Promise<BoardReport> {
  requireAsanaIdField(config);
  const people = options.people ?? {};
  const extract = withNameValues(read, config.fieldMap, people);
  const fields = plakyFieldsFromBoard(await plaky.getBoard(config.plakySpaceId, config.plakyBoardId));
  const idField = findField(fields, config.asanaIdField);
  if (idField === null) {
    throw new Error(`'${config.name}': no Plaky field '${config.asanaIdField}' on board ${config.plakyBoardId}; verification cannot match Plaky rows to Asana items`);
  }

  const plakyRows: Record<string, unknown>[] = [];
  const identities: [unknown, string, string][] = [];
  let seedRows = 0;
  const commentCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  for (const listed of await readPlakyRows(plaky, config)) {
    if (truthy(listed["archived"]) || truthy(listed["deleted"])) continue;
    options.rowsRead?.push(listed);
    const row: Record<string, unknown> = {};
    for (const f of Array.isArray(listed["fields"]) ? listed["fields"] : []) if (isDict(f) && typeof f["key"] === "string") row[f["key"]] = f["value"];
    const value = row[idField.key];
    const key = typeof value === "string" ? pyStrip(value) : "";
    if (isSeedMarker(key)) {
      seedRows++;
      continue;
    }
    commentCounts.set(key, Math.trunc(Number(truthy(listed["commentCount"]) ? listed["commentCount"] : 0)));
    fileCounts.set(key, Math.trunc(Number(truthy(listed["fileCount"]) ? listed["fileCount"] : 0)));
    plakyRows.push(row);
    identities.push([listed["id"], String(truthy(listed["title"]) ? listed["title"] : ""), key]);
  }

  const byAsanaId = new Map<string, Record<string, unknown>>();
  const carriers = new Map<string, [unknown, string][]>();
  identities.forEach(([itemId, title, key], index) => {
    if (!key) return;
    carriers.set(key, [...(carriers.get(key) ?? []), [itemId, title]]);
    if (!byAsanaId.has(key)) byAsanaId.set(key, plakyRows[index] ?? {});
  });
  const duplicates = new Map([...carriers].filter(([, found]) => found.length > 1));
  if (duplicates.size) {
    throw new Error(`board ${config.plakyBoardId} has more than one row with the same Asana ID (${rowsByKey(duplicates)}). ${SHARED_ID_FIX}`);
  }

  const active = extract.items.filter((item) => item.state === "active");
  const unparented = config.nested ? active.flatMap((item) => { const problem = nestedParentProblem(item, options.parentIds); return problem === null ? [] : [[item, problem] as const]; }) : [];
  const left = new Set(unparented.map(([item]) => item.id));
  const asanaItems = active.filter((item) => !left.has(item.id));
  const missing = asanaItems.filter((i) => !byAsanaId.has(i.id)).map((i) => `${i.name} (${i.id})`);

  const asanaIds = new Set(asanaItems.map((i) => i.id));
  const extra = [...identities]
    .sort((a, b) => cmpCodePoints(a[2], b[2]))
    .filter(([, , key]) => key && !asanaIds.has(key))
    .map(([itemId, title, key]) => `'${title}' (#${pyStr(itemId)}, Asana ID ${key})`);
  const unidentified = identities.filter(([, , key]) => !key).map(([itemId, title]) => `'${title}' (#${pyStr(itemId)})`);

  const coverage: FieldCoverage[] = [];
  const gone: string[] = [];
  const taken = new Set<string>();
  for (const [columnId, fieldKey] of Object.entries(config.fieldMap)) {
    const target = findField(fields, fieldKey);
    if (target === null) {
      gone.push(columnId);
      continue;
    }
    taken.add(target.key);
    let asanaFilled = 0;
    let plakyFilledCount = 0;
    for (const item of asanaItems) {
      const stored = byAsanaId.get(item.id);
      if (stored === undefined) continue;
      const cv = item.columnValues[columnId] ?? NO_VALUE;
      if (target.type === "PERSON" && leftOut(personRefs(cv), people)) continue;
      if (holdsValue(cv)) {
        asanaFilled++;
        if (plakyFilled(stored[target.key], target)) plakyFilledCount++;
      }
    }
    if (asanaFilled) coverage.push({ name: target.name, asanaFilled, plakyFilled: plakyFilledCount });
  }

  const uncarried: string[] = [];
  if (gone.length) {
    const columns = new Map(extract.board.columns.map((c) => [c.id, c]));
    for (const columnId of gone) {
      const held = asanaItems.filter((item) => holdsValue(item.columnValues[columnId])).length;
      const column = columns.get(columnId);
      if (held && column) uncarried.push(uncarriedLine(column, goneField(config.fieldMap[columnId] ?? ""), held, fields, taken));
    }
  }

  const assigned = new Map<string, [string, string]>();
  for (const [columnId, fieldKey] of Object.entries(config.fieldMap)) {
    const target = findField(fields, fieldKey);
    if (target === null || target.type !== "PERSON") continue;
    for (const item of asanaItems) for (const ref of personRefs(item.columnValues[columnId] ?? NO_VALUE)) assigned.set(JSON.stringify(ref), ref);
  }

  const notes: string[] = [];
  let commentsOrFilesShort = false;
  let shortWithinLimits = false;
  if (config.syncComments) {
    const wanted = new Map<string, number>();
    const byItem = new Map<string, AsanaUpdate[]>();
    for (const update of extract.updates) if (byAsanaId.has(update.itemId)) byItem.set(update.itemId, [...(byItem.get(update.itemId) ?? []), update]);
    for (const [itemId, updates] of byItem) wanted.set(itemId, threads(updates).top.length);
    const short = [...wanted].filter(([mid, n]) => (commentCounts.get(mid) ?? 0) < n);
    commentsOrFilesShort = short.length > 0;
    shortWithinLimits = short.some(([mid, n]) => (commentCounts.get(mid) ?? 0) < Math.min(n, MAX_COMMENTS_PER_ITEM));
    const total = [...wanted.values()].reduce((sum, n) => sum + n, 0);
    notes.push(`comments: ${total} Asana update(s) on ${wanted.size} item(s)` + (short.length ? `; ${short.length} item(s) hold fewer in Plaky` : ", all carried"));
  }

  if (config.syncFiles) {
    const assets = new Map<string, Set<string>>();
    const assetsOf = (itemId: string): Set<string> => {
      const ids = assets.get(itemId) ?? new Set<string>();
      assets.set(itemId, ids);
      return ids;
    };
    for (const item of asanaItems) {
      if (!byAsanaId.has(item.id)) continue;
      for (const cv of Object.values(item.columnValues)) {
        if (cv["type"] === "file") for (const f of filesInValue(cv["value"])) if (f.assetId) assetsOf(item.id).add(f.assetId);
      }
      const images = item.columnValues["__description"]?.["images"];
      if (options.rich && Array.isArray(images)) for (const image of images as { assetId?: string | null }[]) if (image.assetId) assetsOf(item.id).add(image.assetId);
    }
    for (const update of extract.updates) {
      if (byAsanaId.has(update.itemId) && update.assets.length) for (const [assetId] of update.assets) assetsOf(update.itemId).add(assetId);
    }
    const short = [...assets].filter(([mid, ids]) => (fileCounts.get(mid) ?? 0) < ids.size);
    commentsOrFilesShort = commentsOrFilesShort || short.length > 0;
    const uploadable = (ids: Set<string>): number => [...ids].filter((id) => (extract.assets[id]?.size ?? 0) <= MAX_UPLOAD_BYTES).length;
    shortWithinLimits = shortWithinLimits || short.some(([mid, ids]) => (fileCounts.get(mid) ?? 0) < uploadable(ids));
    const total = [...assets.values()].reduce((sum, ids) => sum + ids.size, 0);
    const holding = [...assets.values()].filter((ids) => ids.size).length;
    notes.push(`files: ${total} Asana file(s) on ${holding} item(s)` + (short.length ? `; ${short.length} item(s) hold fewer in Plaky` : ", all carried"));
  }

  const board = manifest?.boards.find((b) => b.id === config.asanaBoardId);
  const dropped = board ? board.dropped.map((c) => `${c.title} (${c.type}): ${c.reason}`) : [];

  return boardReport({
    name: config.name,
    asanaBoardId: config.asanaBoardId,
    plakyBoardId: config.plakyBoardId,
    asanaItems: asanaItems.length,
    plakyItems: plakyRows.length,
    matched: asanaItems.length - missing.length,
    missing,
    extra,
    unidentified,
    seedRows,
    coverage,
    dropped,
    notes,
    assigned: [...assigned.values()],
    notCarried: unparented.map(([item, problem]) => `subitem '${item.name}' (${item.id}): ${problem}, so it is not carried`),
    commentsOrFilesShort,
    shortWithinLimits,
    uncarried,
  });
}

async function checkValues(
  extract: BoardExtract,
  plaky: PipelinePlaky,
  config: BoardSync,
  directory: UserDirectory,
  people: PeopleMap,
  options: { plakyRows?: readonly PlakyRow[]; parentTitles?: ReadonlyMap<string, string>; parentRows?: readonly PlakyRow[]; rich?: boolean; written?: WrittenView; syncPoint?: string | null } = {},
): Promise<[differing: string[], drifted: string[], notCarried: string[], uncarried: string[], notes: string[], commentsMissing: string[]]> {
  const plan = await planBoard(extract, plaky, config, {
    ...(options.syncPoint ? { syncPoint: options.syncPoint } : {}),
    ...(options.written === undefined ? {} : { written: options.written }),
    directory,
    peopleMap: people,
    ...(options.rich ? { rich: true } : {}),
    ...(options.plakyRows === undefined ? {} : { plakyRows: options.plakyRows }),
    ...(options.parentTitles === undefined ? {} : { parentTitles: options.parentTitles }),
  });
  const label = (w: { title: string; asanaItemId: string }): string => `${w.title} (${w.asanaItemId})`;
  const editsNotCarried: string[] = [];
  const commentsMissing: string[] = [];
  if (config.syncComments) {
    const edited = new Set(extract.updates.filter((u) => u.editHash).map((u) => u.id));
    for (const [asanaId, entry] of plan.comments) {
      const wantedEdits = entry.planned.filter((c) => edited.has(c.asanaId));
      const updates = entry.planned.filter((c) => c.kind === "update");
      const byMarker = entry.settled !== true && updates.length <= MAX_COMMENTS_PER_ITEM && entry.commentCount >= updates.length;
      if ((!wantedEdits.length && !byMarker) || entry.plakyItemId === null) continue;
      const held = new Map<string, string>();
      for (const top of await plaky.listItemComments(config.plakySpaceId, config.plakyBoardId, entry.plakyItemId)) {
        for (const c of [top, ...(top.replies ?? [])]) {
          const marker = c.deleted ? null : markerOf(String(c.content ?? ""));
          if (marker !== null && !held.has(marker[1])) held.set(marker[1], headerOf(String(c.content ?? "")));
        }
      }
      const write = plan.writes.find((w) => w.asanaItemId === asanaId);
      const record = forRow(plan.written, asanaId, entry.plakyItemId);
      const wrote = (c: PlannedComment): boolean => record?.(`__comment:${c.asanaId}`) !== undefined;
      const missing = (c: PlannedComment): boolean => !held.has(c.asanaId) && !edited.has(c.asanaId);
      const gone = byMarker ? entry.planned.filter((c) => missing(c) && (c.kind === "update" || (c.replyTo !== null && held.has(c.replyTo)))) : [];
      const absent = gone.filter((c) => c.kind === "update" && !wrote(c)).length;
      if (absent) commentsMissing.push(`${write ? label(write) : asanaId}: ${absent} Asana update(s) not in Plaky, though the item holds as many comments (some made in Plaky)`);
      const replies = gone.filter((c) => c.kind === "reply" && !wrote(c)).length;
      if (replies) commentsMissing.push(`${write ? label(write) : asanaId}: ${replies} Asana repl${replies === 1 ? "y" : "ies"} not in Plaky under the comment it answers`);
      const removed = gone.filter(wrote).length;
      if (removed) editsNotCarried.push(`${write ? label(write) : asanaId}: ${removed} comment(s) the app wrote were changed or removed in Plaky, so they are not posted again`);
      for (const comment of wantedEdits) {
        const have = held.get(comment.asanaId);
        if (have === commentHeader(comment)) continue;
        editsNotCarried.push(`${write ? label(write) : asanaId}: comment ${comment.asanaId} was edited in Asana, and ${have === undefined ? "the comment the app wrote is no longer in Plaky as written" : "Plaky holds another version of it (changed in Plaky)"}, so the edit is not carried`);
      }
    }
  }
  return [
    plan.writes.filter((w) => writeAction(w) === "update" || (w.drifted && w.existingItemId)).map(label),
    plan.writes.filter((w) => w.drifted && w.existingItemId).map(label),
    [...plan.writes.filter((w) => w.existingItemId).flatMap((w) => w.notCarried.map((note) => `${label(w)}: ${note}`)), ...editsNotCarried],
    plan.uncarried,
    structureNotes(plan, options.plakyRows ?? [], options.parentRows ?? []),
    commentsMissing,
  ];
}

const idOf = (value: unknown): number | null => {
  const raw = value !== null && typeof value === "object" ? (value as { id?: unknown }).id : value;
  const n = Number(raw);
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(n) ? null : n;
};

function structureNotes(plan: Awaited<ReturnType<typeof planBoard>>, plakyRows: readonly PlakyRow[], parentRows: readonly PlakyRow[]): string[] {
  const notes: string[] = [];
  if (plan.groupWrites.length) notes.push(`${plan.groupWrites.length} group write(s) pending (a group renamed, added or reordered in Asana since): the next Move makes them`);
  notes.push(...(plan.kept ?? []));
  const listed = plakyRows.map((row) => idOf(row["id"])).filter((id): id is number => id !== null);
  const position = new Map(listed.map((id, at) => [id, at]));
  const byGroup = new Map<string, number[]>();
  for (const w of plan.writes) {
    if (!w.existingItemId || position.get(w.existingItemId) === undefined) continue;
    const key = plan.config.nested ? `parent ${w.parentAsanaItemId ?? ""}` : (w.groupTitle ?? "");
    byGroup.set(key, [...(byGroup.get(key) ?? []), w.existingItemId]);
  }
  const outOfOrder = [...byGroup].filter(([, ids]) => ids.some((id, at) => at > 0 && position.get(id)! < position.get(ids[at - 1]!)!)).map(([key]) => key);
  if (outOfOrder.length) {
    notes.push(`items in ${outOfOrder.length} ${plan.config.nested ? "parent row(s)" : "group(s)"} are not in Asana's order in Plaky (Plaky's API cannot reorder items): ${outOfOrder.slice(0, 5).map((k) => `'${k}'`).join(", ")}`);
  }
  if (plan.config.nested && plan.asanaIdKey !== null) {
    const key = plan.asanaIdKey;
    const plakyIdOf = new Map<string, number>();
    for (const row of parentRows) {
      const id = idOf(row["id"]);
      const field = rowsOf(row["fields"]).find((f) => (f as { key?: unknown }).key === key) as { value?: unknown } | undefined;
      if (id !== null && typeof field?.value === "string" && field.value) plakyIdOf.set(field.value, id);
    }
    const parentOf = new Map(plakyRows.flatMap((row) => { const id = idOf(row["id"]); return id === null ? [] : [[id, idOf(row["parent"])] as const]; }));
    const moved = plan.writes.filter((w) => {
      if (!w.existingItemId || !w.parentAsanaItemId) return false;
      const want = plakyIdOf.get(w.parentAsanaItemId);
      return want !== undefined && parentOf.get(w.existingItemId) !== want;
    });
    if (moved.length) {
      notes.push(`${moved.length} subitem(s) sit under another parent row in Plaky than in Asana (Plaky's API sets the parent only when a row is created): ${moved.slice(0, 5).map((w) => `${w.title} (${w.asanaItemId})`).join(", ")}`);
    }
  }
  return notes;
}
const rowsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export async function verify(
  read: (board: BoardSync) => Promise<BoardExtract>,
  plaky: PipelinePlaky,
  config: Pick<SyncConfig, "boards" | "people">,
  manifest: ManifestLike | null = null,
  options: { parentTitles?: ParentTitles; rich?: boolean; written?: ReadonlyMap<number, WrittenView>; syncPoint?: (asanaBoardId: string) => string | null | undefined } = {},
): Promise<Receipt> {
  const result = receipt();
  let directory: UserDirectory | null = null;
  const users: BoardExtract["users"] = {};
  const teams: BoardExtract["teams"] = {};
  const names = new Map<string, ReadonlyMap<string, string>>();
  const listings = new Map<string, PlakyRow[]>();
  for (const board of config.boards) {
    try {
      requireAsanaIdField(board);
      const extract = await read(board);
      Object.assign(users, extract.users);
      Object.assign(teams, extract.teams);
      if (!extract.isDelta) names.set(extract.board.id, new Map(extract.items.map((item) => [item.id, item.name])));
      const rows: PlakyRow[] = [];
      const parentTitles = board.subitemsOf ? (names.get(board.subitemsOf) ?? (await options.parentTitles?.(board.subitemsOf))) : undefined;
      const report = await verifyBoard(extract, plaky, board, manifest, {
        people: config.people, rowsRead: rows, ...(board.nested && parentTitles ? { parentIds: new Set(parentTitles.keys()) } : {}), ...(options.rich ? { rich: true } : {}),
      });
      try {
        directory ??= await loadDirectory(plaky);
        listings.set(board.asanaBoardId, rows);
        const parentRows = board.nested && board.subitemsOf ? listings.get(board.subitemsOf) : undefined;
        const [differing, drifted, notCarried, uncarried, structure, commentsMissing] = await checkValues(extract, plaky, board, directory, config.people, {
          plakyRows: rows, ...(options.rich ? { rich: true } : {}), syncPoint: options.syncPoint?.(board.asanaBoardId) ?? null,
          ...(options.written === undefined ? {} : { written: options.written.get(board.plakyBoardId) ?? writtenView(new Map()) }),
          ...(parentRows === undefined ? {} : { parentRows }),
          ...(parentTitles === undefined ? {} : { parentTitles }),
        });
        report.differing = differing;
        report.notCarried = [...report.notCarried, ...notCarried];
        report.uncarried = uncarried;
        if (drifted.length) {
          report.notes.push(`${drifted.length} item(s) need renaming by hand in Plaky: ${drifted.slice(0, 5).join(", ")}`);
        }
        report.notes.push(...structure);
        if (commentsMissing.length) {
          report.commentsOrFilesShort = true;
          report.shortWithinLimits = true;
          report.notes = report.notes.map((n) => (n.startsWith("comments: ") ? n.replace(/, all carried$/, `; ${commentsMissing.length} item(s) miss a migrated comment in Plaky`) : n));
          report.notes.push(...commentsMissing);
        }
      } catch (error) {
        result.failures.push(`${board.name}: values not compared: ${failureText(error)}`);
      }
      result.boards.push(report);
    } catch (error) {
      result.failures.push(`${board.name}: ${failureText(error)}`);
    }
  }
  const refs = new Map<string, [string, string]>();
  for (const b of result.boards) for (const ref of b.assigned) refs.set(JSON.stringify(ref), ref);
  if (refs.size) {
    const all = [...refs.values()];
    try {
      const people = resolvePeople({
        userIds: all.filter(([kind]) => kind === "person").map(([, id]) => id),
        teamIds: all.filter(([kind]) => kind === "team").map(([, id]) => id),
        asanaUsers: users,
        asanaTeams: teams,
        directory: directory ?? (await loadDirectory(plaky)),
        overrides: config.people,
      });
      result.unmatchedUsers = people.problems();
    } catch (error) {
      result.failures.push(`people not checked: ${failureText(error)}`);
    }
  }
  return result;
}

export function receiptJson(r: Receipt): Record<string, unknown> {
  return {
    ok: receiptOk(r),
    asana_items: receiptAsanaItems(r),
    matched: receiptMatched(r),
    boards: r.boards.map((b) => ({
      name: b.name,
      asana_board_id: b.asanaBoardId,
      plaky_board_id: b.plakyBoardId,
      asana_items: b.asanaItems,
      plaky_items: b.plakyItems,
      matched: b.matched,
      missing: b.missing,
      extra: b.extra,
      unidentified: b.unidentified,
      seed_rows: b.seedRows,
      coverage: b.coverage.map((cov) => ({ name: cov.name, asana_filled: cov.asanaFilled, plaky_filled: cov.plakyFilled, shortfall: shortfall(cov) })),
      dropped: b.dropped,
      notes: b.notes,
      assigned: b.assigned,
      differing: b.differing,
      not_carried: b.notCarried,
      comments_or_files_short: b.commentsOrFilesShort,
      uncarried: b.uncarried,
      complete: boardComplete(b),
    })),
    failures: [...r.failures],
    unmatched_users: [...r.unmatchedUsers],
  };
}
