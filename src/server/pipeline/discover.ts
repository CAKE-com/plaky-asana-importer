import type { AsanaClient } from "../clients/asana";
import { CUSTOM_FIELDS_HIDDEN_NOTE, customFieldsHiddenIn, namedByWork, numberFormatOf, OPTIONAL_COLUMNS, SYNTHETIC_COLUMNS, levelFields, projectBoard, readMembers, readProject, subtaskBoard, tagVocabulary, type ExtractedBoard, type ExtractedUser, type ListTrees, type NumberFormat, type ProjectRead } from "./extract";
import {
  columnPlan,
  discoveredBoard,
  discoveredPerson,
  isImportable,
  isSubtaskBoard,
  type ColumnPlan,
  type DiscoveredBoard,
  type DiscoveredPerson,
  type ImportAs,
  type Manifest,
  type SkippedBoard,
} from "./manifest";
import { RESERVED_FIELD_NAMES, baseBoardId, isLevelTwo, levelTwoId } from "./names";
import { RENAME_STEP, boardTitles } from "./provision";
import { UNMAPPABLE_REASON, compatibleTypes, asanaLabels, preferredType, singleSelect } from "./transform/compat";
import { spellingKey, titleKey } from "./transform/mapping";
import { asanaState, placeholderTitles, type AsanaUserRow, type UserDirectory } from "./transform/people";
import { isDict, pyOr, pyStr, pyStrip, truthy } from "./transform/pystr";
import { pyRepr, sortedStrings, strOf } from "./transform/pyvalue";

export const BOARD_TYPE = "board";
const SUBITEM_TYPE = "sub_items_board";
const SKIP_TYPES: Readonly<Record<string, string>> = {};

const EXTRA_FIELDS: Readonly<Record<string, readonly [name: string, plakyType: string]>> = {
  __description: ["Description", "RICH_TEXT"],
  __created_at: ["Created", "DATE_TIME"],
  __created_by: ["Asana created by", "STRING"],
  __url: ["Asana link", "LINK"],
};

export type ListedBoard = {
  id: string;
  name?: string | null | undefined;
  itemsCount?: number | null | undefined;
  type?: string | null | undefined;
  state?: string | null | undefined;
};

export type BoardReferences = { people: readonly (readonly [kind: string, id: string])[]; tagIds: readonly string[]; byColumn?: readonly (readonly [columnId: string, personId: string])[] };

export type AsanaTeamRow = { name?: string | null | undefined; users?: readonly { email?: string | null | undefined }[] | null | undefined };

export type SubtaskRead = {
  top: readonly string[]; sub: readonly string[]; count: number;
  depth: number;
  board: () => Promise<ExtractedBoard>;
};

export type DiscoverSource = {
  listBoards(): Promise<readonly ListedBoard[]>;
  boards(ids: string[]): Promise<readonly ExtractedBoard[]>;
  references(boardId: string, columnIds: string[]): Promise<BoardReferences>;
  tagNames(ids: string[]): Promise<ReadonlyMap<string, string>>;
  users(ids: string[]): Promise<Readonly<Record<string, AsanaUserRow>>>;
  teams(ids: string[]): Promise<Readonly<Record<string, AsanaTeamRow>>>;
  subtasks?(boardId: string): Promise<SubtaskRead>;
  notes?(): Promise<string[]>;
};

export function asanaSource(client: AsanaClient, personalIds: readonly string[] = []): DiscoverSource {
  const reads = new Map<string, Promise<ProjectRead>>();
  const lists: ListTrees = new Map();
  const read = (gid: string): Promise<ProjectRead> => {
    let found = reads.get(gid);
    if (!found) reads.set(gid, (found = readProject(client, gid, personalIds, lists)));
    return found;
  };
  return {
    async notes() {
      const read = await Promise.all(reads.values());
      const hidden = read.filter((r) => r.customFieldsHidden);
      if (!hidden.length) return [];
      return [hidden.length === read.length ? CUSTOM_FIELDS_HIDDEN_NOTE : customFieldsHiddenIn(hidden.map((r) => r.project.name ?? r.project.gid))];
    },
    async listBoards() {
      return [...(await client.listProjects()).map((row) => ({ id: row.gid, name: row.name, itemsCount: row.tasks, type: BOARD_TYPE, state: "active" })), ...await Promise.all(personalIds.map(async (id) => {
        const personal = await read(id);
        return { id, name: personal.project.name, itemsCount: personal.tree.filter((row) => row.level === 1).length, type: BOARD_TYPE, state: "active" };
      }))];
    },
    async boards(ids) {
      return Promise.all(ids.map(async (id) => projectBoard(await read(id))));
    },
    async references(boardId) {
      const { tree } = await read(baseBoardId(boardId));
      const rows = isLevelTwo(boardId) ? tree.filter((t) => t.level > 1) : tree;
      const named = isLevelTwo(boardId) ? rows : tree.filter((t) => t.level === 1);
      const people = new Set<string>();
      const byColumn = new Map<string, [string, string]>();
      const names = (column: string, gid: string): void => void byColumn.set(`${column}\u0000${gid}`, [column, gid]);
      for (const { task } of named) {
        for (const who of [task.assignee, ...(task.followers ?? [])]) if (who) people.add(who.gid);
        if (task.assignee) names("__assignee", task.assignee.gid);
        for (const field of task.custom_fields ?? []) {
          for (const who of field.people_value ?? []) {
            people.add(who.gid);
            names(field.gid, who.gid);
          }
        }
      }
      return { people: [...people].map((id): [string, string] => ["person", id]), tagIds: tagVocabulary(rows).labels.map(([id]) => id), byColumn: [...byColumn.values()] };
    },
    tagNames: async () => new Map<string, string>(),
    async users(ids) {
      const out: Record<string, ExtractedUser> = {};
      const workspaces = new Set((await Promise.all([...reads.values()])).flatMap((r) => (r.project.workspace ? [r.project.workspace.gid] : [])));
      for (const workspace of workspaces) {
        for (const m of await readMembers(client, workspace)) {
          if (m.user && ids.includes(m.user.gid)) out[m.user.gid] = { id: m.user.gid, name: m.user.name ?? null, email: m.user.email ?? null, enabled: m.is_active ?? null, isPending: false, isGuest: m.is_guest ?? null };
        }
      }
      const byWork = new Set<string>();
      for (const read of await Promise.all([...reads.values()])) {
        for (const [id, user] of Object.entries(namedByWork(read.tree))) {
          if (!ids.includes(id) || (out[id] && (!byWork.has(id) || out[id]!.name || !user.name))) continue;
          out[id] = user;
          byWork.add(id);
        }
      }
      return out;
    },
    teams: async () => ({}),
    async subtasks(boardId) {
      const project = await read(boardId);
      const { top, sub } = levelFields(project.tree);
      return { top, sub, count: project.tree.filter((t) => t.level > 1).length, depth: Math.max(1, ...project.tree.map((t) => t.level)), board: async () => (await subtaskBoard(client, project)).board };
    },
  };
}

function uniqueFieldNames(titles: readonly string[], reserved: readonly string[]): string[] {
  const taken = new Set(reserved.map(titleKey));
  return titles.map((title) => {
    let candidate = pyStrip(title) || "Untitled";
    if (taken.has(titleKey(candidate))) {
      let suffix = 2;
      while (taken.has(titleKey(`${candidate} (${suffix})`))) suffix++;
      candidate = `${candidate} (${suffix})`;
    }
    taken.add(titleKey(candidate));
    return candidate;
  });
}

function extraColumns(board: Pick<ExtractedBoard, "columns">, extras: ReadonlySet<string>): string[] {
  const wanted = ["__description"];
  if (extras.has("created")) {
    if (!board.columns.some((c) => c.type === "creation_log" && !Object.hasOwn(SYNTHETIC_COLUMNS, c.id))) wanted.push("__created_at");
    wanted.push("__created_by");
  }
  if (extras.has("link")) wanted.push("__url");
  return wanted;
}

export type PlanOptions = { isSubitemBoard?: boolean; extras?: ReadonlySet<string> };

export function planColumns(board: ExtractedBoard, options: PlanOptions = {}): ColumnPlan[] {
  const extras = options.extras ?? new Set<string>();
  const columns = board.columns.filter((c) => !Object.hasOwn(SYNTHETIC_COLUMNS, c.id));
  const extraIds = extraColumns(board, extras);
  const reserved = options.isSubitemBoard ? RESERVED_FIELD_NAMES : RESERVED_FIELD_NAMES.slice(0, 2);
  const extraField = (id: string): readonly [string, string] => EXTRA_FIELDS[id] ?? ["", ""];
  const allNames = uniqueFieldNames([...columns.map((c) => c.title), ...extraIds.map((id) => extraField(id)[0])], reserved);

  const plans = columns.map((column, at): ColumnPlan => {
    const plakyType = column.type === "dropdown" && singleSelect(column) ? "STATUS" : preferredType(column.type);
    let reason: string | null = null;
    if (plakyType === null) {
      reason = Object.hasOwn(UNMAPPABLE_REASON, column.type) ? (UNMAPPABLE_REASON[column.type] ?? null) : `Asana type '${column.type}' has nothing Plaky can store`;
    }
    const labels: string[] = [];
    const collisions: string[] = [];
    if (plakyType === "STATUS" || plakyType === "TAG") {
      const seen = new Set<string>();
      const normalizedSeen = new Map<string, string>();
      for (const label of asanaLabels(column)) {
        const normalized = spellingKey(label);
        const isNew = !seen.has(label);
        if (isNew) {
          labels.push(label);
          seen.add(label);
        }
        const first = normalizedSeen.get(normalized);
        if (isNew && first !== undefined && label !== first) collisions.push(`${pyRepr(first)} / ${pyRepr(label)}`);
        else normalizedSeen.set(normalized, label);
      }
    }
    return columnPlan({ id: column.id, title: column.title, type: column.type, fieldName: allNames[at] ?? "", plakyType, reason, labels, labelCollisions: collisions });
  });
  masterFields(plans);
  extraIds.forEach((id, at) => {
    const [title, type] = SYNTHETIC_COLUMNS[id] ?? ["", ""];
    plans.push(columnPlan({ id, title, type, fieldName: allNames[columns.length + at] ?? "", plakyType: extraField(id)[1] }));
  });
  return plans;
}

const oneStatusReason = (statusField: string): string => `Plaky holds one Status field per board: '${statusField}' is it, so this one is a Dropdown`;

function masterOf(pool: readonly ColumnPlan[], name: string): ColumnPlan | undefined {
  const named = pool.filter((p) => p.title.toLowerCase().includes(name));
  return named.length === 1 ? named[0] : pool[0];
}

function asMaster(plan: ColumnPlan, importAs?: ImportAs): ColumnPlan {
  const copy = { ...plan };
  delete copy.importAs;
  return importAs ? { ...copy, importAs } : copy;
}

const NEVER_DUE: ReadonlySet<string> = new Set(["__start", "__completed"]);

function masterFields(plans: ColumnPlan[], own = plans.length): void {
  const pool = (candidates: (p: ColumnPlan) => boolean): ColumnPlan[] => {
    const ownOnes = plans.slice(0, own).filter(candidates);
    return ownOnes.length ? ownOnes : plans.filter(candidates);
  };
  const choose = (candidates: (p: ColumnPlan) => boolean, name: string): ColumnPlan | undefined => masterOf(pool(candidates), name);
  const isDropdown = (p: ColumnPlan): boolean => p.plakyType === "STATUS" && p.type === "dropdown";
  const isStatus = (p: ColumnPlan): boolean => p.plakyType === "STATUS" && !isDropdown(p);
  const statuses = pool(isStatus);
  const status = masterOf(statuses.some((p) => p.type === "status") ? statuses.filter((p) => p.type === "status") : statuses, "status");
  const assignee = choose((p) => p.plakyType === "PERSON" && !Object.hasOwn(SYNTHETIC_COLUMNS, p.id), "assignee");
  const dueDate = choose((p) => p.plakyType === "DATE_TIME" && p.type === "date" && !NEVER_DUE.has(p.id), "due date");
  for (const [at, plan] of plans.entries()) {
    if (isStatus(plan)) plans[at] = plan === status ? asMaster({ ...plan, reason: null }) : asMaster({ ...plan, reason: oneStatusReason(status!.fieldName) }, "Dropdown");
    else plans[at] = asMaster(plan, isDropdown(plan) ? "Dropdown" : plan === assignee ? "Assignee" : plan === dueDate ? "Due Date" : undefined);
  }
}

function privacyStep(kind: string | undefined): string | null {
  if (kind === "private") return "Restrict the board in Plaky: in Asana it is private (only its members see it). Plaky's API cannot do this: in Plaky, make the board Private and add those members.";
  if (kind === "team") return "Restrict the board in Plaky: in Asana only its team sees it. Plaky's API cannot do this: in Plaky, make the board Private and add the team's people.";
  return null;
}

export function privacyFlag(kind: string | null | undefined): string | null {
  return kind === "private" ? "private in Asana" : kind === "team" ? "team only in Asana" : null;
}

function unitStep(field: string, format: NumberFormat): string {
  if (format.kind === "percent") return `In '${field}', set the unit to % (Asana showed it as a percentage; its values are written ×100, 25 for 25%).`;
  if (format.kind === "currency") return `In '${field}', set the unit to the currency ${format.code}, as Asana showed it.`;
  return `In '${field}', set the unit to "${format.label}" ${format.position === "prefix" ? "before" : "after"} the number, as Asana showed it.`;
}

function unitSteps(board: ExtractedBoard, plans: readonly ColumnPlan[]): string[] {
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  return plans.flatMap((plan) => {
    const format = plan.plakyType === "NUMBER" ? numberFormatOf({ settings: byId.get(plan.id)?.settings ?? null }) : null;
    return format ? [unitStep(plan.fieldName, format)] : [];
  });
}

function nestedUnitSteps(parentSteps: readonly string[], subSteps: readonly string[]): string[] {
  const fieldOf = (step: string): string | null => /^In '(.*)', set the unit to /.exec(step)?.[1] ?? null;
  return subSteps.flatMap((step) => {
    if (parentSteps.includes(step)) return [];
    const field = fieldOf(step);
    if (field !== null && parentSteps.some((s) => fieldOf(s) === field)) {
      return [`'${field}' holds the tasks' and the subtasks' values, which Asana showed with different units; Plaky shows one unit per field: check it by hand.`];
    }
    return [step];
  });
}

function finishByHand(board: ExtractedBoard, plans: readonly ColumnPlan[]): string[] {
  const out = [`${RENAME_STEP}"${board.name}".`];
  if (board.description) out.push(`Paste the board description: ${pyStrip(board.description)}`);
  const restrict = privacyStep(board.kind);
  if (restrict) out.push(restrict);
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  for (const plan of plans) {
    const settings = byId.get(plan.id)?.settings;
    if (!isDict(settings)) continue;
    const labels = settings["labels"];
    if ((plan.plakyType === "STATUS" || plan.plakyType === "TAG") && Array.isArray(labels)) {
      const entries = labels.filter(isDict);
      const done = entries.filter((e) => truthy(e["is_done"]) && truthy(e["label"])).map((e) => strOf(e["label"]));
      if (done.length) out.push(`Mark ${done.map((d) => pyRepr(d)).join(", ")} final in '${plan.fieldName}'.`);
    }
  }
  out.push(...unitSteps(board, plans));
  const views = board.views.filter(([, kind]) => kind && kind !== "table").map(([name, kind]) => `${name} (${kind})`);
  if (views.length) out.push(`Recreate the views: ${views.join(", ")}.`);
  return out;
}

async function discoverPeople(
  source: Pick<DiscoverSource, "users" | "teams">,
  references: ReadonlyMap<string, BoardReferences>,
  directory: UserDirectory,
): Promise<DiscoveredPerson[]> {
  const refs = new Map<string, { kind: string; id: string; boards: string[] }>();
  for (const [boardId, found] of references) {
    for (const [kind, id] of found.people) {
      const key = `${kind}\u0000${id}`;
      const ref = refs.get(key) ?? { kind, id, boards: [] };
      ref.boards.push(boardId);
      refs.set(key, ref);
    }
  }
  const all = [...refs.values()];
  const userIds = all.filter((r) => r.kind === "person").map((r) => r.id);
  const teamIds = all.filter((r) => r.kind === "team").map((r) => r.id);
  const users = await source.users(userIds);
  const teams = await source.teams(teamIds);
  const titles = placeholderTitles(users, userIds);
  const rowOf = <T>(rows: Readonly<Record<string, T>>, id: string): T | undefined => (Object.hasOwn(rows, id) ? rows[id] : undefined);

  return all.map(({ kind, id, boards }): DiscoveredPerson => {
    const on = [...new Set(boards)];
    if (kind === "person") {
      const row = rowOf(users, id);
      const assignable = directory.assignable(row?.email) !== null;
      return discoveredPerson({
        id,
        kind,
        name: pyStr(pyOr(row?.name, `Asana user ${id}`)),
        email: row?.email ?? null,
        state: asanaState(row),
        placeholder: assignable ? null : (titles.get(id) ?? null),
        boards: on,
      });
    }
    if (kind === "team") {
      const row = rowOf(teams, id);
      return discoveredPerson({
        id,
        kind,
        name: pyStr(pyOr(row?.name, `Asana team ${id}`)),
        members: sortedStrings((row?.users ?? []).filter((u) => isDict(u) && truthy(u.email)).map((u) => String(u.email).toLowerCase())),
        boards: on,
      });
    }
    return discoveredPerson({ id, kind, name: `Asana ${kind} ${id}`, boards: on });
  });
}

async function planWithReferences(source: DiscoverSource, board: ExtractedBoard, options: PlanOptions): Promise<{ board: ExtractedBoard; columns: ColumnPlan[]; found: BoardReferences }> {
  const columns = planColumns(board, options);
  const read = columns.filter((c) => isImportable(c) && (c.plakyType === "PERSON" || c.type === "tags")).map((c) => c.id);
  const found = await source.references(board.id, read);
  return { board, columns: withAssigned(columns, found), found };
}

function withAssigned(columns: readonly ColumnPlan[], found: BoardReferences): ColumnPlan[] {
  const byColumn = found.byColumn;
  if (!byColumn) return [...columns];
  return columns.map((c) => (c.plakyType === "PERSON" ? { ...c, assigned: [...new Set(byColumn.filter(([column]) => column === c.id).map(([, id]) => id))] } : c));
}

export type SubitemsMode = "auto" | "board" | "nested";

function mergeLabels(into: string[], labels: readonly string[]): string[] {
  const spellings = new Map<string, number>();
  const collisions: string[] = [];
  for (const label of into) spellings.set(spellingKey(label), (spellings.get(spellingKey(label)) ?? 0) + 1);
  for (const label of labels) {
    if (into.includes(label)) continue;
    if (spellings.get(spellingKey(label)) === 1) {
      collisions.push(`${pyRepr(into.find((l) => spellingKey(l) === spellingKey(label)))} / ${pyRepr(label)}`);
      continue;
    }
    into.push(label);
    spellings.set(spellingKey(label), (spellings.get(spellingKey(label)) ?? 0) + 1);
  }
  return collisions;
}

export function mergeNested(parent: DiscoveredBoard, sub: DiscoveredBoard): { parent: DiscoveredBoard; sub: DiscoveredBoard } {
  const own = parent.columns.map((c) => ({ ...c, labels: [...c.labels] }));
  const byName = new Map(own.filter(isImportable).map((c) => [titleKey(c.fieldName), c]));
  const taken = new Set([...RESERVED_FIELD_NAMES.slice(0, 2), ...own.map((c) => c.fieldName)].map(titleKey));
  const added: ColumnPlan[] = [];
  const columns = sub.columns.map((column): ColumnPlan => {
    if (!isImportable(column)) return { ...column };
    const match = byName.get(titleKey(column.fieldName));
    if (match && match.plakyType !== null && (column.plakyType === match.plakyType || compatibleTypes(column.type).includes(match.plakyType))) {
      const clashes = mergeLabels(match.labels as string[], column.labels);
      const collisions = [...new Set([...match.labelCollisions, ...column.labelCollisions, ...clashes])];
      if (collisions.length !== match.labelCollisions.length) (match as { labelCollisions: readonly string[] }).labelCollisions = collisions;
      if (match.assigned && column.assigned) (match as { assigned?: readonly string[] }).assigned = [...new Set([...match.assigned, ...column.assigned])];
      return asMaster({ ...column, fieldName: match.fieldName, plakyType: match.plakyType, labels: [...column.labels] }, match.importAs);
    }
    let candidate = pyStrip(column.fieldName) || "Untitled";
    if (taken.has(titleKey(candidate))) candidate = `${candidate} (subitems)`;
    let suffix = 2;
    const base = candidate;
    while (taken.has(titleKey(candidate))) candidate = `${base} (${suffix++})`;
    taken.add(titleKey(candidate));
    const renamed = { ...column, fieldName: candidate, labels: [...column.labels] };
    added.push(renamed);
    return renamed;
  });
  const seeded = [...own, ...added];
  masterFields(seeded, own.length);
  const planned = new Map(seeded.slice(own.length).map((c) => [c.id, c]));
  return {
    parent: { ...parent, columns: seeded.slice(0, own.length), nestedColumns: seeded.slice(own.length) },
    sub: { ...sub, columns: columns.map((c) => (planned.has(c.id) ? asMaster({ ...c, plakyType: planned.get(c.id)!.plakyType, reason: planned.get(c.id)!.reason }, planned.get(c.id)!.importAs) : c)), nested: true },
  };
}

export type DiscoverOptions = {
  batchSize?: number;
  levels?: boolean;
  subitems?: SubitemsMode;
  keepShape?: ReadonlyMap<string, "nested" | "board">;
  extras?: Iterable<string>;
  only?: Iterable<string>;
  listArchived?: boolean;
  now?: () => Date;
};

const nameOf = (entry: ListedBoard): string => (truthy(entry.name) ? String(entry.name) : entry.id);
const countOf = (entry: ListedBoard | undefined): number => Math.trunc(entry?.itemsCount || 0);

const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}+00:00`;

export async function discover(deps: { asana: DiscoverSource; directory: UserDirectory }, options: DiscoverOptions = {}): Promise<Manifest> {
  const { asana, directory } = deps;
  const batchSize = options.batchSize ?? 20;
  const extras = new Set(options.extras ?? []);
  const only = new Set(options.only ?? []);
  const plan: PlanOptions = { extras };

  const everything = await asana.listBoards();
  const archived = everything.filter((e) => e.state === "archived" && (!only.size || options.listArchived || only.has(e.id)));
  const listed = everything.filter((e) => (e.state === undefined ? "active" : e.state) === "active");
  const byId = new Map(listed.map((e) => [e.id, e]));

  let real = listed.filter((e) => e.type === BOARD_TYPE);
  if (only.size) real = real.filter((e) => only.has(e.id));
  const subitemIds = [...new Set(listed.filter((e) => e.type === SUBITEM_TYPE).map((e) => e.id))];

  const skipped: SkippedBoard[] = listed
    .filter((e) => e.type !== BOARD_TYPE && e.type !== SUBITEM_TYPE)
    .map((e) => ({
      id: e.id,
      name: nameOf(e),
      kind: pyStr(pyOr(e.type, "unknown")),
      reason: Object.hasOwn(SKIP_TYPES, pyStr(e.type)) ? (SKIP_TYPES[pyStr(e.type)] ?? "") : `Asana type '${pyStr(e.type)}'`,
    }));
  skipped.push(
    ...archived.map((e) => ({
      id: e.id,
      name: nameOf(e),
      kind: pyStr(pyOr(e.type, "unknown")),
      reason: "archived in Asana: restore it there, then run discover again to carry it",
    })),
  );

  const fetched = new Map<string, ExtractedBoard>();
  const ids = real.map((e) => e.id);
  for (let start = 0; start < ids.length; start += batchSize) {
    for (const loaded of await asana.boards(ids.slice(start, start + batchSize))) fetched.set(loaded.id, loaded);
  }

  const boards: DiscoveredBoard[] = [];
  const paired = new Map<string, string>();
  const references = new Map<string, BoardReferences>();
  const inUse = new Map<string, readonly string[]>();
  for (const entry of real) {
    const read = fetched.get(entry.id);
    if (read === undefined) {
      skipped.push({ id: entry.id, name: nameOf(entry), kind: BOARD_TYPE, reason: "listed by Asana but could not be read" });
      continue;
    }
    if (read.inUse) inUse.set(entry.id, read.inUse);
    const subitemId = read.subitemBoardIds.find((s) => subitemIds.includes(s)) ?? null;
    if (subitemId) paired.set(subitemId, entry.id);
    const { board, columns, found } = await planWithReferences(asana, read, plan);
    references.set(entry.id, found);
    boards.push(
      discoveredBoard({
        id: entry.id,
        name: board.name,
        itemsCount: countOf(entry),
        columns,
        subitemBoardId: subitemId,
        hierarchyType: board.hierarchyType,
        byHand: finishByHand(board, columns),
        ...(board.archived ? { archived: true } : {}),
      }),
    );
  }

  const pairedIds = subitemIds.filter((sid) => paired.has(sid));
  const fetchedSubitems = new Set<string>();
  const nested = options.subitems === "nested";
  for (let start = 0; start < pairedIds.length; start += batchSize) {
    for (const loaded of await asana.boards(pairedIds.slice(start, start + batchSize))) {
      fetchedSubitems.add(loaded.id);
      const { board, columns, found } = await planWithReferences(asana, loaded, { ...plan, isSubitemBoard: !nested });
      references.set(board.id, found);
      let sub = discoveredBoard({
        id: board.id,
        name: board.name,
        itemsCount: countOf(byId.get(board.id)),
        columns,
        parentBoardId: paired.get(board.id) ?? null,
        byHand: finishByHand(board, columns),
      });
      if (nested) {
        const at = boards.findIndex((b) => b.id === sub.parentBoardId);
        if (at >= 0) {
          const merged = mergeNested(boards[at]!, sub);
          const extra = nestedUnitSteps(merged.parent.byHand, unitSteps(board, merged.sub.columns));
          boards[at] = extra.length ? { ...merged.parent, byHand: [...merged.parent.byHand, ...extra] } : merged.parent;
          sub = merged.sub;
        }
      }
      boards.push(sub);
    }
  }
  if (options.levels) {
    for (const [at, b] of [...boards.entries()]) {
      if (b.hierarchyType !== "multi_level" || b.parentBoardId !== null) continue;
      const read = asana.subtasks ? await asana.subtasks(b.id) : null;
      const depth = read === null ? {} : { deepestLevel: read.depth };
      const own = await ownSubtaskBoard(read, b.id, options);
      if (own === null) {
        const foreign = read !== null && read.count > 0 && read.sub.some((field) => !b.columns.some((c) => c.id === field));
        const subBoard = foreign ? await read.board() : null;
        const planned = subBoard ? planColumns(subBoard, plan) : b.columns;
        const subFound = await asana.references(levelTwoId(b.id), planned.filter((c) => isImportable(c) && (c.plakyType === "PERSON" || c.type === "tags")).map((c) => c.id));
        references.set(levelTwoId(b.id), subFound);
        const columns = withAssigned(planned, subFound);
        const merged = mergeNested({ ...b, ...depth }, discoveredBoard({ id: levelTwoId(b.id), name: `${b.name} (subtasks)`, itemsCount: read?.count ?? 0, columns, parentBoardId: b.id }));
        const extra = subBoard ? nestedUnitSteps(merged.parent.byHand, unitSteps(subBoard, merged.sub.columns)) : [];
        boards[at] = extra.length ? { ...merged.parent, byHand: [...merged.parent.byHand, ...extra] } : merged.parent;
        boards.push(merged.sub);
        continue;
      }
      const { board, columns, found } = await planWithReferences(asana, own.board, { ...plan, isSubitemBoard: true });
      references.set(board.id, found);
      if (board.inUse) inUse.set(board.id, board.inUse);
      boards[at] = { ...b, ...depth, subitemBoardId: board.id };
      boards.push(discoveredBoard({ id: board.id, name: board.name, itemsCount: own.count, columns, parentBoardId: b.id, byHand: finishByHand(board, columns) }));
    }
  }
  for (const sid of pairedIds) {
    if (!fetchedSubitems.has(sid)) {
      skipped.push({ id: sid, name: nameOfId(byId, sid), kind: SUBITEM_TYPE, reason: "parent board is accessible, but Asana did not return the subitem board" });
    }
  }

  if (!only.size) {
    for (const sid of sortedStrings(subitemIds.filter((s) => !paired.has(s)))) {
      skipped.push({ id: sid, name: nameOfId(byId, sid), kind: SUBITEM_TYPE, reason: "a subitem board whose parent board is not being migrated" });
    }
  }

  const notes = (await asana.notes?.()) ?? [];
  return { boards: numberedRenames(onlyColumnsInUse(boards, inUse)), skipped, generatedAt: isoSeconds((options.now ?? (() => new Date()))()), people: await discoverPeople(asana, references, directory), ...(notes.length ? { notes } : {}) };
}

function numberedRenames(boards: DiscoveredBoard[]): DiscoveredBoard[] {
  const titles = boardTitles({ boards });
  return boards.map((b) => {
    const title = titles.get(b.id);
    const step = `${RENAME_STEP}"${title}".`;
    return title === undefined || b.byHand[0] === step || !b.byHand[0]?.startsWith(RENAME_STEP) ? b : { ...b, byHand: [step, ...b.byHand.slice(1)] };
  });
}

function onlyColumnsInUse(boards: readonly DiscoveredBoard[], inUse: ReadonlyMap<string, readonly string[]>): DiscoveredBoard[] {
  const optional = (c: Pick<ColumnPlan, "id">): boolean => OPTIONAL_COLUMNS.has(c.id);
  const layout = (b: DiscoveredBoard): string =>
    [...b.columns, ...b.nestedColumns].filter((c) => isImportable(c) && !optional(c)).map((c) => `${c.fieldName}\u0000${c.plakyType}\u0000${c.importAs ?? ""}`).sort().join("\u0001");
  const projects = boards.filter((b) => !b.nested && !isSubtaskBoard(b));
  const byLayout = new Map<string, Set<string>>();
  for (const b of projects) {
    const used = inUse.get(b.id);
    const union = byLayout.get(layout(b)) ?? new Set<string>();
    for (const id of used ?? OPTIONAL_COLUMNS) union.add(id);
    byLayout.set(layout(b), union);
  }
  const kept = (b: DiscoveredBoard): ReadonlySet<string> | undefined => (isSubtaskBoard(b) ? (inUse.has(b.id) ? new Set(inUse.get(b.id)) : undefined) : byLayout.get(layout(b)));
  return boards.map((b) => {
    const parent = b.nested ? boards.find((p) => p.id === b.parentBoardId) : undefined;
    const keep = kept(parent ?? b);
    if (!keep) return b;
    const only = (columns: readonly ColumnPlan[]): ColumnPlan[] => columns.filter((c) => !optional(c) || keep.has(c.id));
    return { ...b, columns: only(b.columns), nestedColumns: only(b.nestedColumns) };
  });
}

async function ownSubtaskBoard(read: SubtaskRead | null, boardId: string, options: DiscoverOptions): Promise<{ board: ExtractedBoard; count: number } | null> {
  const kept = options.keepShape?.get(boardId);
  const mode = kept ?? options.subitems;
  if (mode === undefined || mode === "nested" || read === null) return null;
  if (kept === undefined && (read.count === 0 || (mode === "auto" && read.sub.every((gid) => read.top.includes(gid))))) return null;
  return { board: await read.board(), count: read.count };
}


const nameOfId = (byId: ReadonlyMap<string, ListedBoard>, id: string): string => {
  const entry = byId.get(id);
  return entry && truthy(entry.name) ? String(entry.name) : id;
};

