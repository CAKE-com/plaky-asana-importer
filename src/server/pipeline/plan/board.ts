import type { PipelinePlaky } from "../load/guarded";
import { SINCE_MARGIN_MS } from "../names";
import { FIELD_KEY, type BoardSync, type PeopleMap } from "../config";
import { DETAIL_COLUMNS, type BoardExtract } from "../extract";
import { namesWithoutField, withNameValues } from "../name-fields";
import { planItemComments, rethreaded } from "../transform/comments";
import { filesInValue, MAX_UPLOAD_BYTES, safeName, type AsanaFile } from "../transform/files";
import { buildFieldMap, buildItemFields, carriesTime, collectPeople, fieldsTitled, plakyFieldsFromBoard, spellingKey, titleKey, type PlakyField } from "../transform/mapping";
import { planGroupWrites } from "../transform/order";
import { People, isCarried, resolvePeople, type PeopleOverrides } from "../transform/people";
import { pyStrip } from "../transform/pystr";
import { cmpCodePoints } from "../transform/pyvalue";
import { UserDirectory } from "../transform/people";
import { SEED_GROUP_TITLE, SyncSetupError, type PlannedWrite, plannedWrite, type ItemFiles, type ItemComments, type BoardPlan, MAX_TITLE, type PlakyRow, codePoints, TRAILING_SPACE, own } from "./writes";
import { cellHash, findField, holdsValue, planFields, recordable, uncarriedLine, withoutClears } from "./compare";
import { forRow, valueHash, type WrittenEntry, type WrittenView } from "../written";
import { emptyListed, rowOwnership, type OwnedRow } from "./ownership";
import { existingByAsanaId, readPlakyRows, loadDirectory } from "./existing";
import { type GroupInput, groupStates, groupTitleFor, groupTitles, followRenamedGroups, withRenames, wantedGroups } from "./groups";

type PlanBoardOptions = {
  allowDuplicateImport?: boolean;
  rich?: boolean;
  isDelta?: boolean;
  directory?: UserDirectory;
  peopleMap?: PeopleOverrides | PeopleMap | null;
  parentTitles?: ReadonlyMap<string, string>;
  plakyRows?: readonly PlakyRow[];
  plakyGroups?: readonly GroupInput[];
  syncPoint?: string | null;
  written?: WrittenView;
};

function peopleSummary(people: People): string {
  const users = [...people.users.values()];
  const teams = [...people.teams.values()];
  const standIns = users.filter((r) => r.teamId !== null && r.placeholder).length;
  const matched = users.filter((r) => r.userId !== null).length;
  const lost = [...users, ...teams].filter((r) => !isCarried(r)).length;
  const parts = [`${matched} person(s) matched to Plaky users`];
  if (standIns) parts.push(`${standIns} without a Plaky user to assign, on empty stand-in teams`);
  if (teams.length) parts.push(`${teams.filter(isCarried).length} of ${teams.length} team(s) matched`);
  if (lost) parts.push(`${lost} not carried (below)`);
  return parts.join(", ");
}

export function nestedParentProblem(item: { parentId: string | null }, parentIds?: ReadonlySet<string>): string | null {
  if (item.parentId === null) return "no parent in Asana; a nested subitem needs its parent item";
  if (parentIds !== undefined && !parentIds.has(item.parentId)) return `its parent (asana ${item.parentId}) is not an active item on the parent board`;
  return null;
}

const staleEmpty = emptyListed;

const NO_TIME = { id: "", type: "" };

export async function planBoard(read: BoardExtract, plaky: PipelinePlaky, config: BoardSync, options: PlanBoardOptions = {}): Promise<BoardPlan> {
  const extract = withNameValues(read, config.fieldMap, (options.peopleMap ?? {}) as PeopleMap);
  const asanaBoard = extract.board;
  const allowDuplicateImport = options.allowDuplicateImport ?? false;
  const plakyBoard = await plaky.getBoard(config.plakySpaceId, config.plakyBoardId);
  const plakyFieldList = plakyFieldsFromBoard(plakyBoard);
  const notes: string[] = [];
  if (extract.mergedTags?.length) notes.push(`Tags differing only by case share one Plaky label: ${extract.mergedTags.join("; ")}`);
  if (extract.readShort) notes.push(extract.readShort);

  const idField = findField(plakyFieldList, config.asanaIdField);
  if (idField === null) {
    if (!allowDuplicateImport && FIELD_KEY.test(config.asanaIdField ?? "")) {
      throw new SyncSetupError(
        `'${config.name}': the Asana ID field recorded for board ${config.plakyBoardId}, key '${config.asanaIdField}', is gone: deleted, or its type changed in Plaky, which gives a field a new key. If its type was changed, run link again to pair it. If it was deleted, its values went with it: a field added in its place starts empty, and on a board this tool has written to, planning stops while no row carries a Asana ID. Nothing is written until then: every run would create duplicates.`,
      );
    }
    if (!allowDuplicateImport) {
      throw new SyncSetupError(
        `'${config.name}': no Plaky field '${config.asanaIdField ?? "None"}' on board ${config.plakyBoardId}, so existing items cannot be matched and every run would create duplicates. Add a STRING field with that name, or pass --allow-duplicate-import for a deliberate one-shot import.`,
      );
    }
    notes.push("No asana-id field: this run will create items unconditionally and a second run will duplicate them.");
  } else if (idField.type !== "STRING") {
    throw new SyncSetupError(
      `'${config.name}': Plaky field '${idField.name}' (${idField.key}) is ${idField.type}, not STRING. Asana ids cannot be stored there and every item write would fail.`,
    );
  }

  const flat = Boolean(config.subitemsOf) && !config.nested;
  const parentTitleField = flat ? findField(plakyFieldList, config.parentTitleField) : null;
  const parentIdField = flat ? findField(plakyFieldList, config.parentIdField) : null;
  if (flat) {
    for (const [label, wanted, found] of [
      ["parent title", config.parentTitleField, parentTitleField],
      ["parent Asana id", config.parentIdField, parentIdField],
    ] as const) {
      if (wanted && found === null) notes.push(`No Plaky field '${wanted}' for the ${label}; imported subitems will not carry it.`);
    }
  }

  let items = [...extract.items];
  const reserved = new Set([idField, parentTitleField, parentIdField].flatMap((f) => (f ? [f.key] : [])));
  const fieldMap = buildFieldMap(asanaBoard.columns, plakyFieldList, { overrides: config.fieldMap, skipColumns: new Set(config.skipColumns), reservedFieldKeys: reserved });

  const inactive = items.filter((i) => i.state !== "active");
  if (inactive.length) {
    notes.push(`${inactive.length} Asana item(s) are archived or deleted and will not be imported`);
    items = items.filter((i) => i.state === "active");
  }
  const taken = new Set(fieldMap.pairs.map((pair) => pair.target.key));
  const uncarried: string[] = namesWithoutField(extract, config.fieldMap, (options.peopleMap ?? {}) as PeopleMap);
  for (const [column, why] of fieldMap.uncarried) {
    const held = items.filter((item) => holdsValue(item.columnValues[column.id])).length;
    if (held) uncarried.push(uncarriedLine(column, why, held, plakyFieldList, taken));
  }
  const [userIds, teamIds] = collectPeople(items, fieldMap.pairs);
  if (config.syncSubscribers) {
    const known = [...userIds];
    userIds.push(...items.flatMap((item) => item.subscriberIds.filter((uid) => !known.includes(uid))));
  }
  const directory = options.directory ?? (await loadDirectory(plaky));
  const people = resolvePeople({ userIds, teamIds, asanaUsers: extract.users, asanaTeams: extract.teams, directory, overrides: options.peopleMap ?? null });
  if (userIds.length || teamIds.length) {
    notes.push(`People: ${peopleSummary(people)}`);
    notes.push(...people.problems().map((problem) => `   ! ${problem}`));
  }

  const parentTitles = options.parentTitles ?? new Map<string, string>();

  const blankTitles: string[] = [];
  const listing = options.plakyRows ?? (await readPlakyRows(plaky, config));
  const existing = existingByAsanaId(listing, config, idField, blankTitles);
  if (config.applied && existing.size === 0 && blankTitles.length && items.length && !allowDuplicateImport) {
    throw new SyncSetupError(
      `'${config.name}': this tool has written items to Plaky board ${config.plakyBoardId} before, and none of its ${blankTitles.length} rows carries a Asana ID now: the ids were lost, as when the Asana ID field is deleted and added again, and a plan now would create every item a second time beside them. Nothing is written. Bring the old values back in Plaky if you can; if not, delete those rows and run again: the items are created afresh, without the rows' Plaky comments and files.`,
    );
  }
  const groupCandidates = new Map<string, number[]>();
  const plakyGroups = groupStates(options.plakyGroups ?? (await plaky.allItemGroups(config.plakySpaceId, config.plakyBoardId)));
  for (const group of plakyGroups) {
    const key = spellingKey(group.title);
    groupCandidates.set(key, [...(groupCandidates.get(key) ?? []), group.id]);
  }
  const ambiguousGroups = [...groupCandidates].filter(([key, ids]) => key && ids.length > 1);
  if (ambiguousGroups.length) {
    const detail = ambiguousGroups
      .sort(([a], [b]) => cmpCodePoints(a, b))
      .map(([key, ids]) => `${key}: [${ids.join(", ")}]`)
      .join(", ");
    throw new SyncSetupError(`'${config.name}': Plaky has groups whose names collide after normalization (${detail}); rename one before syncing`);
  }
  const groupIds = new Map([...groupCandidates].flatMap(([key, ids]) => (ids[0] === undefined ? [] : [[key, ids[0]] as [string, number]])));
  const titlesOfGroups = groupTitles(asanaBoard);
  const renamedGroups = (config.syncGroups || (asanaBoard.archived && !config.nested)) ? followRenamedGroups(items, existing, titlesOfGroups, plakyGroups, groupIds, config.seedGroupId) : new Map<number, string>();
  const plakyGroupById = new Map(plakyGroups.map((group) => [group.id, group]));
  const written = options.written;
  const keptTitles = new Map<number, string>();
  const boardKept: string[] = [];
  for (const [groupId, oldTitle] of [...renamedGroups]) {
    if (written === undefined || written.get("", `__group_title:${groupId}`) === valueHash(oldTitle)) continue;
    keptTitles.set(groupId, oldTitle);
    renamedGroups.delete(groupId);
    boardKept.push(`Plaky group '${oldTitle}' holds the items of Asana group '${plakyGroupById.get(groupId)?.title}', and was renamed in Plaky since the app titled it (or before this version kept a record), so it keeps its title`);
  }
  for (const [groupId, oldTitle] of renamedGroups) {
    notes.push(
      `Plaky group '${oldTitle}' holds the items of Asana group '${plakyGroupById.get(groupId)?.title}', so it takes Asana's title (the group was renamed in Asana or in Plaky)`,
    );
  }

  const comparators = new Map(fieldMap.pairs.map((pair) => [pair.target.key, pair.target]));
  const paired = new Set(comparators.keys());
  const fieldByKey = new Map(plakyFieldList.map((f) => [f.key, f]));
  const supportKeys = new Set([idField, parentTitleField, parentIdField].flatMap((f) => (f === null ? [] : [f.key])));
  const onBoard = new Set(asanaBoard.columns.map((c) => c.id));
  const titlesOnBoard = new Set(asanaBoard.columns.map((c) => titleKey(c.title)));
  const savedTarget = (named: string): PlakyField | undefined => fieldByKey.get(named) ?? (fieldsTitled(named, plakyFieldList).length === 1 ? fieldsTitled(named, plakyFieldList)[0] : undefined);
  const gone = Object.entries(config.fieldMap)
    .filter(([column]) => !onBoard.has(column) && !titlesOnBoard.has(titleKey(column)))
    .flatMap(([, named]) => { const target = savedTarget(named); return target && !paired.has(target.key) ? [target] : []; });
  const recordOf = (asanaId: string, rowId: number | null | undefined) => forRow(written, asanaId, rowId);
  const unpairedOf = (asanaId: string, rowId: number): PlakyField[] => {
    const record = recordOf(asanaId, rowId);
    if (record === undefined || written === undefined) return [];
    return written.keys(asanaId).filter((key) => !key.startsWith("__") && !paired.has(key) && !supportKeys.has(key) && record(key) !== undefined).flatMap((key) => fieldByKey.get(key) ?? []);
  };
  const owns = written === undefined ? null : rowOwnership(written, plakyFieldList, directory, supportKeys);
  const holdsOthers = (asanaId: string, rowId: number, fields: Readonly<Record<string, unknown>>): string[] => owns?.others(asanaId, rowId, fields) ?? [];
  const ownership = (asanaId: string, row: OwnedRow): string[] => owns?.reasons(asanaId, row) ?? [];
  const unread = new Set(extract.detailsUnread);
  const detailKeys = new Set(Object.entries(config.fieldMap).filter(([column]) => DETAIL_COLUMNS.has(column)).map(([, key]) => key));
  for (const support of [idField, parentTitleField, parentIdField]) if (support !== null) comparators.set(support.key, support);

  const writes: PlannedWrite[] = [];
  const referencedGroups: string[] = [];
  const parentIds = config.nested && options.parentTitles ? new Set(options.parentTitles.keys()) : undefined;
  const unparented: string[] = [];
  for (const item of items) {
    if (config.nested) {
      const problem = nestedParentProblem(item, parentIds);
      if (problem !== null) {
        unparented.push(`${item.name} (${item.id}): ${problem}`);
        continue;
      }
    }
    const built = buildItemFields(item, fieldMap, { labelMaps: config.labelMap, people, ...(options.rich ? { rich: true } : {}) });
    const fields: Record<string, unknown> = built.payload;
    const warnings = built.warnings;
    const notCarried = [...warnings];
    const staleNotes: string[] = [];
    const match = existing.get(item.id);
    if (idField) fields[idField.key] = item.id;

    if (parentTitleField && item.parentId) fields[parentTitleField.key] = parentTitles.get(item.parentId) ?? item.parentId;
    if (parentIdField && item.parentId) fields[parentIdField.key] = item.parentId;
    if (config.subitemsOf && !item.parentId) {
      warnings.push("no parent in Asana: carried without one");
    }
    const record = match ? recordOf(item.id, match.itemId) : undefined;
    const decided = match ? planFields(fields, match.fields, comparators, directory, {
      ...(record === undefined ? {} : { record: { get: record } }),
      partial: new Set(built.partial),
    }) : null;
    const keep = (note: string): void => {
      warnings.push(note);
      notCarried.push(note);
      staleNotes.push(note);
    };
    const holds = (target: PlakyField): boolean => !!match && !staleEmpty(own(match.fields, target.key)) && recordable(own(match.fields, target.key), target, directory) !== null;
    const appWrote = (target: PlakyField): boolean =>
      record === undefined || record(target.key) === valueHash(recordable(own(match?.fields ?? {}, target.key), target, directory));
    for (const target of [...built.uncleared, ...(decided?.emptied ?? [])]) {
      if (!holds(target)) continue;
      keep(appWrote(target)
        ? `'${target.name}' (${target.key}) was cleared in Asana, but the app never clears a value in Plaky, so its value remains until it is cleared by hand in Plaky`
        : `'${target.name}' (${target.key}) holds a value in Plaky that Asana does not have there (typed in Plaky, or written before this version kept a record), so it stays: the app never clears a value in Plaky`);
    }
    const unpaired = match ? unpairedOf(item.id, match.itemId).filter((t) => !gone.some((g) => g.key === t.key)) : [];
    for (const target of [...built.absent, ...gone, ...unpaired]) {
      if (unread.has(item.id) && detailKeys.has(target.key)) continue;
      if (holds(target)) keep(`'${target.name}' (${target.key}) is no longer on the task in Asana, so its value remains in Plaky until it is cleared by hand`);
    }
    for (const note of decided?.left ?? []) keep(note);

    const groupTitle = (config.syncGroups || (asanaBoard.archived && !config.nested)) ? (titlesOfGroups.get(item.groupId ?? "") ?? (item.groupTitle === null ? null : groupTitleFor(item.groupTitle))) : null;
    if (groupTitle && !referencedGroups.includes(groupTitle)) referencedGroups.push(groupTitle);

    let title = pyStrip(item.name) ? item.name : "New Item";
    const length = codePoints(title).length;
    if (length > MAX_TITLE) {
      title = `${codePoints(title).slice(0, MAX_TITLE - 1).join("").replace(TRAILING_SPACE, "")}…`;
      warnings.push(`title is ${codePoints(item.name).length} characters; Plaky accepts ${MAX_TITLE}, so it was truncated`);
    }

    let drifted = false;
    let moveGroup = !!match && !!groupTitle && match.groupId !== (groupIds.get(spellingKey(groupTitle)) ?? null);
    let stayed = false;
    if (moveGroup && record !== undefined && match?.groupId != null && record("__group") !== valueHash(match.groupId)) {
      moveGroup = false;
      stayed = true;
      keep(`moved to another group in Plaky since the app placed it (or before this version kept a record), so it stays there; Asana has it in '${groupTitle}'`);
    }
    if (match && match.title !== title) {
      drifted = true;
      warnings.push(`title drift: Asana '${title}' vs Plaky '${match.title}' (Plaky has no item-title update endpoint)`);
    }
    const subscribers = config.syncSubscribers ? people.subscriberIds(item.subscriberIds) : [];
    const send = decided ? Object.keys(decided.changes) : [];
    const kept = decided ? [...decided.emptied.map((t) => t.key), ...Object.keys(fields).filter((key) => !send.includes(key) && !Object.hasOwn(decided.hashes, key) && !decided.emptied.some((t) => t.key === key))] : [];
    const sameFields = match !== undefined && send.length === 0;
    const sameSubscribers = match !== undefined && subscribers.every((id) => match.subscriberIds.includes(id));

    writes.push(
      plannedWrite({
        asanaItemId: item.id,
        subscriberIds: subscribers,
        title,
        groupTitle,
        fields: match ? fields : withoutClears(fields, comparators),
        existingItemId: match?.itemId ?? null,
        existingTitle: match?.title ?? null,
        existingFields: match ? { ...match.fields } : null,
        existingGroupId: match?.groupId ?? null,
        existingSubscriberIds: match ? [...match.subscriberIds] : [],
        unchanged: !moveGroup && sameFields && (!config.syncSubscribers || subscribers.length === 0 || sameSubscribers),
        sameFields,
        sameSubscribers,
        drifted,
        ...(moveGroup ? { moveGroup: true } : {}),
        ...(stayed ? { stayed: true } : {}),
        ...(match && drifted && holdsOthers(item.id, match.itemId, match.fields).length ? { othersHold: true as const } : {}),
        ...(match && send.length && send.length !== Object.keys(fields).length ? { send } : {}),
        ...(kept.length ? { kept } : {}),
        warnings,
        notCarried,
        parentAsanaItemId: item.parentId,
        uncleared: built.uncleared.map((target) => target.key),
        ...(staleNotes.length ? { stale: staleNotes } : {}),
      }),
    );
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  const dateColumns = fieldMap.pairs.filter((p) => p.target.type === "DATE_TIME").map((p) => [p.column.id, p.target.key] as const);
  const utcTimes = writes.some((w) => !w.unchanged && dateColumns.some(([column, key]) => Object.hasOwn(w.fields, key) && carriesTime(itemById.get(w.asanaItemId)?.columnValues[column] ?? NO_TIME)));
  if (utcTimes) notes.push("Times are written in UTC, so one near midnight can show on another day in Plaky than in Asana");
  if (unparented.length) notes.push(`${unparented.length} subitem(s) have no parent row to nest under and are not carried: ${unparented.join("; ")}`);

  const wanted = (config.syncGroups || (asanaBoard.archived && !config.nested)) ? wantedGroups(asanaBoard, titlesOfGroups, referencedGroups) : [];
  let groupWrites = wanted.length ? planGroupWrites(wanted, plakyGroups) : [];
  if (renamedGroups.size) groupWrites = withRenames(groupWrites, renamedGroups, plakyGroupById, wanted);
  if (keptTitles.size) groupWrites = groupWrites.map((g) => (g.groupId !== null && keptTitles.has(g.groupId) ? { ...g, title: keptTitles.get(g.groupId)!, renamedFrom: null } : g));
  let groupOrderKept = false;
  const orderNow = (): number[] => [...plakyGroups].filter((g) => g.id !== config.seedGroupId).sort((a, b) => cmpCodePoints(a.ranking ?? "", b.ranking ?? "")).map((g) => g.id);
  const recordedOrder = written?.get("", "__group_order");
  const orderOwned = written === undefined || (recordedOrder === undefined ? orderNow().length === 0 : recordedOrder === JSON.stringify(orderNow()));
  if (!orderOwned && groupWrites.some((g) => g.groupId !== null && g.ranking !== (plakyGroupById.get(g.groupId)?.ranking ?? null))) {
    groupOrderKept = true;
    boardKept.push("The groups were reordered in Plaky since the app ordered them (or a group was added or removed there, or before this version kept a record), so they keep Plaky's order");
    groupWrites = groupWrites.flatMap((g) => {
      if (g.groupId === null) return [g];
      const held = plakyGroupById.get(g.groupId);
      return g.renamedFrom !== null ? [{ ...g, ranking: held?.ranking ?? g.ranking }] : [];
    });
  }
  notes.push(...boardKept);
  let seedGroup: { id: number; title: string } | null = null;
  if (config.seedGroupId && wanted.length) {
    const seed = plakyGroups.find((g) => g.id === config.seedGroupId);
    const asanaTitles = new Set(wanted.map(([title]) => spellingKey(title)));
    if (seed !== undefined && !asanaTitles.has(spellingKey(seed.title))) seedGroup = { id: seed.id, title: SEED_GROUP_TITLE };
  }

  const byItem = new Map<string, BoardExtract["updates"]>();
  for (const update of extract.updates) byItem.set(update.itemId, [...(byItem.get(update.itemId) ?? []), update]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const syncPoint = options.syncPoint ? Date.parse(options.syncPoint) - SINCE_MARGIN_MS : NaN;
  const before = (iso: string | null | undefined): boolean => iso != null && Date.parse(iso) <= syncPoint;
  const settled = (itemId: string): boolean =>
    !Number.isNaN(syncPoint) && before(byId.get(itemId)?.columnValues["__updated_at"]?.text)
    && (byItem.get(itemId) ?? []).every((u, _, all) => before(u.createdAt) && !u.editHash && (u.editedAt === null || before(u.editedAt)) && !rethreaded(u, all));

  const comments = new Map<string, ItemComments>();
  if (config.syncComments) {
    if (idField === null) {
      throw new SyncSetupError(`'${config.name}': sync_comments needs the asana-id field, so a re-run can tell which comments are already there`);
    }
    const boardPosts = (byItem.get("") ?? []).filter((u) => !u.parentId).length;
    if (boardPosts) notes.push(`${boardPosts} board-level update(s) belong to no item; Plaky has no board comments, so they are not carried`);
    for (const write of writes) {
      if (unread.has(write.asanaItemId)) continue;
      const planned = planItemComments(byItem.get(write.asanaItemId) ?? [], config.syncFiles, options.rich === true);
      if (planned.length) {
        const match = existing.get(write.asanaItemId);
        comments.set(write.asanaItemId, { planned, plakyItemId: match?.itemId ?? null, commentCount: match?.commentCount ?? 0, settled: settled(write.asanaItemId) });
      }
    }
  }

  const files = new Map<string, ItemFiles>();
  if (config.syncFiles) {
    for (const asset of Object.values(extract.assets)) if (asset.size !== null && asset.size > MAX_UPLOAD_BYTES) {
      notes.push(`${asset.name ?? asset.id} is over Plaky's 100 MB file limit; preserve it in the task archive.`);
    }
  }
  if (config.syncFiles) {
    if (idField === null) {
      throw new SyncSetupError(`'${config.name}': sync_files needs the asana-id field, so a re-run can tell which files are already there`);
    }
    const fileColumns = asanaBoard.columns.filter((c) => c.type === "file").map((c) => c.id);
    const attached = new Map<string, AsanaFile[]>();
    for (const update of extract.updates) {
      for (const [assetId, name] of update.assets) attached.set(update.itemId, [...(attached.get(update.itemId) ?? []), { name, assetId, url: null }]);
    }
    for (const write of writes) {
      const item = byId.get(write.asanaItemId);
      if (item === undefined) throw new Error(`KeyError: ${write.asanaItemId}`);
      const listed: AsanaFile[] = [];
      for (const columnId of fileColumns) listed.push(...filesInValue(item.columnValues[columnId]?.value));
      const images = item.columnValues["__description"]?.["images"];
      if (options.rich && Array.isArray(images)) listed.push(...(images as AsanaFile[]));
      listed.push(...(attached.get(item.id) ?? []));
      const assets = new Map<string, AsanaFile>();
      for (const entry of listed) {
        if (entry.assetId !== null) {
          if (!assets.has(entry.assetId)) assets.set(entry.assetId, entry);
        } else {
          write.warnings.push(`file '${entry.name}' is a link in Asana, not a stored file, so there is nothing to copy; add the link to the Plaky item by hand`);
        }
      }
      if (assets.size) {
        const match = existing.get(item.id);
        files.set(item.id, { assets: [...assets.values()], plakyItemId: match?.itemId ?? null, fileCount: match?.fileCount ?? 0, settled: settled(item.id) });
      }
    }
  }

  const seen = new Set(items.map((item) => item.id));
  const orphans: BoardPlan["orphans"] = options.isDelta || extract.isDelta
    ? []
    : [...existing]
        .sort(([a], [b]) => cmpCodePoints(a, b))
        .filter(([asanaId]) => !seen.has(asanaId))
        .map(([asanaId, existingItem]) => [existingItem.itemId, existingItem.title, { asanaId, read: existingItem.fields }]);
  const protectedOrphans = options.isDelta || extract.isDelta ? [] : [...existing].filter(([asanaId, row]) => !seen.has(asanaId) && holdsOthers(asanaId, row.itemId, row.fields).length).map(([, row]) => row.itemId);

  return {
    config,
    asanaBoardName: asanaBoard.name,
    plakyBoardName: String(plakyBoard.title || plakyBoard["name"] || config.plakyBoardId),
    fieldMap,
    writes,
    groupWrites,
    orphans,
    groupIds,
    notes,
    asanaIdKey: idField?.key ?? null,
    ...(parentTitleField || parentIdField ? { parentFields: [parentTitleField, parentIdField].flatMap((f) => (f === null ? [] : [{ key: f.key, name: f.name }])) } : {}),
    seedGroup,
    comments,
    files,
    uncarried,
    archivedGroups: asanaBoard.groups.filter((g) => g.archived).map((g) => g.title),
    existingIds: new Map([...existing].map(([asanaId, row]) => [asanaId, row.itemId])),
    ...(written === undefined ? {} : { written }),
    ...(boardKept.length ? { kept: boardKept } : {}),
    ...(protectedOrphans.length ? { protectedOrphans } : {}),
    ...(options.isDelta || extract.isDelta ? {} : { inAsana: (asanaId: string) => seen.has(asanaId) }),
    hashOf: (key: string, value: unknown) => cellHash(comparators.get(key), value, directory),
    ownership,
    assetMeta: (assetId: string) => {
      const asset = own(extract.assets, assetId);
      return asset?.name ? [safeName(asset.name), typeof asset.size === "number" ? Math.trunc(asset.size) : null] : undefined;
    },
    groupsRecord: (skipped: ReadonlySet<number> = new Set()): WrittenEntry[] => {
      if (!groupWrites.length) return [];
      const board = config.plakyBoardId;
      const entries: WrittenEntry[] = [];
      const rankOf = new Map(plakyGroups.filter((g) => g.id !== config.seedGroupId).map((g) => [g.id, g.ranking ?? ""]));
      for (const g of groupWrites) {
        const id = g.groupId ?? groupIds.get(spellingKey(g.title));
        if (id === undefined) return [];
        if (skipped.has(id)) continue;
        if (g.groupId === null || g.renamedFrom !== null) entries.push({ plakyBoardId: board, subject: "", key: `__group_title:${id}`, hash: valueHash([...g.title].slice(0, MAX_TITLE).join("")) });
        rankOf.set(id, g.ranking ?? "~");
      }
      if (orderOwned && !groupOrderKept && !skipped.size) entries.push({ plakyBoardId: board, subject: "", key: "__group_order", hash: JSON.stringify([...rankOf].sort((x, y) => cmpCodePoints(x[1], y[1])).map(([id]) => id)) });
      return entries;
    },
    ...(extract.readShort ? { readShort: true as const } : {}),
  };
}

