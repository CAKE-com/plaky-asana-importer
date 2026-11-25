import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {
  ATTACHMENT_FIELDS,
  AsanaHttpError,
  FIELD_FIELDS,
  SETTING_FIELDS,
  STORY_FIELDS,
  TASK_FIELDS,
  attachmentSchema,
  customFieldSettingSchema,
  customFieldValueSchema,
  isAsanaHidden,
  sectionSchema,
  storySchema,
  taskSchema,
  workspaceMembershipSchema,
  type AsanaAttachment,
  type AsanaClient,
  type AsanaCustomFieldSetting,
  type AsanaCustomFieldValue,
  type AsanaProject,
  type AsanaSection,
  type AsanaTask,
  type AsanaWorkspaceMembership,
} from "../clients/asana";
import { baseBoardId, isLevelTwo, levelTwoId } from "./names";
import { sanitizeHtml, toHtml } from "./transform/richtext";

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
import { spellingKey } from "./transform/mapping";

type Dict = Record<string, unknown>;

export type ExtractedColumn = { id: string; title: string; type: string; settingsStr: string; settings: Dict | null };
export type ExtractedGroup = { id: string; title: string; color: string; position: string; archived: boolean };
export type ExtractedBoard = {
  id: string;
  name: string;
  columns: ExtractedColumn[];
  subitemBoardIds: string[];
  hierarchyType: string;
  tags: [id: string, name: string][];
  groups: ExtractedGroup[];
  description: string | null;
  views: [string, string][];
  kind?: string;
  inUse?: string[];
  archived?: boolean;
};
export type ColumnValue = Dict & { id: string; type: string; text?: string | null; value?: unknown };
export type ExtractedItem = {
  id: string;
  name: string;
  groupTitle: string | null;
  groupId: string | null;
  parentId: string | null;
  state: string;
  subscriberIds: string[];
  columnValues: Record<string, ColumnValue>;
};
export type ExtractedUpdate = {
  id: string;
  itemId: string;
  text: string;
  createdAt: string;
  author: string;
  editedAt: string | null;
  parentId: string | null;
  assets: [string, string][];
  body?: string;
  pinned?: boolean;
  editHash?: string;
};
export type AssetMeta = { id: string; name: string | null; size: number | null };
export type ExtractedUser = { id: string; name: string | null; email: string | null; enabled: boolean | null; isPending: boolean | null; isGuest: boolean | null };
export type ExtractedTeam = { id: string; name: string | null; users: { id: string; email: string | null }[] };

export type BoardExtract = {
  board: ExtractedBoard;
  items: ExtractedItem[];
  updates: ExtractedUpdate[];
  assets: Record<string, AssetMeta>;
  users: Record<string, ExtractedUser>;
  teams: Record<string, ExtractedTeam>;
  people: { users: string[]; teams: string[] };
  isDelta?: boolean;
  detailsUnread?: string[];
  readShort?: string;
  mergedTags?: string[];
};

export const SYNTHETIC_COLUMNS: Record<string, [title: string, type: string]> = {
  __url: ["Asana URL", "link"],
  __description: ["Asana description", "long_text"],
  __created_at: ["Asana created at", "creation_log"],
  __created_by: ["Asana created by", "text"],
  __updated_at: ["Asana last modified", "last_updated"],
};

const STATUS_LABELS = ["To do", "Done", "Pending", "Approved", "Changes requested", "Rejected"] as const;
const TYPE_LABELS = ["Task", "Milestone", "Approval"] as const;
const APPROVAL_LABEL: Readonly<Record<string, string>> = { pending: "Pending", approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected" };
const TYPE_LABEL: Readonly<Record<string, string>> = { default_task: "Task", milestone: "Milestone", approval: "Approval" };
const typeLabel = (task: Pick<AsanaTask, "resource_subtype" | "custom_type">): string => (task.resource_subtype === "custom" ? task.custom_type?.name?.trim() || "Custom" : TYPE_LABEL[task.resource_subtype ?? ""] ?? "Task");

const UNTITLED_SECTION = "Untitled section";

export const DETAIL_COLUMNS: ReadonlySet<string> = new Set(["__links", "__files"]);

export const OPTIONAL_COLUMNS: ReadonlySet<string> = new Set(["__start", "__completed", "__tags", "__blocked_by", "__blocking", "__also_in", "__parent_task", "__custom_status"]);

function columnsInUse(projectGid: string, rows: readonly TreeTask[]): string[] {
  const used = new Set<string>();
  for (const { task, level } of rows) {
    if (task.start_at || task.start_on) used.add("__start");
    if (task.completed_at) used.add("__completed");
    if (task.tags?.length) used.add("__tags");
    if (task.dependencies?.length) used.add("__blocked_by");
    if (task.dependents?.length) used.add("__blocking");
    if ((task.memberships ?? []).some((m) => m.project && m.project.gid !== projectGid && m.project.name)) used.add("__also_in");
    if (level > 2) used.add("__parent_task");
    if (task.custom_type_status_option?.name) used.add("__custom_status");
  }
  return [...OPTIONAL_COLUMNS].filter((id) => used.has(id));
}

export type TreeTask = { task: AsanaTask; level: number; rootId: string };
const READS_AT_ONCE = 16;

export async function eachAtOnce<T>(rows: readonly T[], work: (row: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < rows.length) {
      const row = rows[next++]!;
      await work(row).catch((error: unknown) => {
        failed = true;
        throw error;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, rows.length) }, worker));
}

export type ProjectRead = {
  project: AsanaProject; sections: AsanaSection[]; settings: AsanaCustomFieldSetting[]; tree: TreeTask[];
  foreign?: AsanaCustomFieldValue[];
  customFieldsHidden?: boolean;
};

export const CUSTOM_FIELDS_HIDDEN_NOTE = "Asana's free plan hides custom fields, so none will be carried. A paid Asana plan or a trial shows them.";
export const customFieldsHiddenIn = (names: readonly string[]): string =>
  `Asana's free plan hides the custom fields of ${names.map((n) => `'${n}'`).join(", ")}, so theirs will not be carried. A paid Asana plan or a trial shows them.`;

async function readSettings(client: AsanaClient, gid: string): Promise<{ settings: AsanaCustomFieldSetting[]; hidden: boolean }> {
  try {
    return { settings: await client.list(`/projects/${gid}/custom_field_settings`, customFieldSettingSchema, { opt_fields: SETTING_FIELDS }), hidden: false };
  } catch (error) {
    if (error instanceof AsanaHttpError && error.status === 402) return { settings: [], hidden: true };
    throw error;
  }
}

const holdsFieldValue = (field: Pick<AsanaCustomFieldValue, "display_value">): boolean => Boolean(field.display_value?.trim());

type WholeRead = Pick<ProjectRead, "project" | "sections" | "settings" | "tree"> & { hidden: boolean };

export type ListTrees = Map<string, Promise<WholeRead>>;

export async function readProject(client: AsanaClient, gid: string, selected: readonly string[] = [], lists: ListTrees = new Map()): Promise<ProjectRead> {
  const whole = (id: string): Promise<WholeRead> => {
    let found = lists.get(id);
    if (!found) {
      lists.set(id, (found = readWhole(client, id)));
      found.catch(() => lists.delete(id));
    }
    return found;
  };
  const { project, sections, settings, hidden, tree: read } = gid.startsWith("mytasks:") ? await whole(gid) : await readWhole(client, gid);
  const tree = read.map((row) => ({ ...row }));
  if (gid.startsWith("mytasks:")) {
    const earlier = selected.filter((id) => id.startsWith("mytasks:") && id < gid).sort();
    const covered = new Set<string>();
    for (const id of earlier) for (const row of (await whole(id)).tree) covered.add(row.task.gid);
    for (let i = tree.length - 1; i >= 0; i--) if (covered.has(tree[i]!.task.gid)) tree.splice(i, 1);
    const ids = new Set(tree.map(({ task }) => task.gid));
    for (const row of tree) if (!ids.has(row.rootId)) { row.level = 1; row.rootId = row.task.gid; }
  }
  const listed = new Set(settings.map((s) => s.custom_field.gid));
  const held = new Map<string, AsanaCustomFieldValue>();
  for (const { task, level } of tree) {
    if (level !== 1) continue;
    for (const field of task.custom_fields ?? []) if (!listed.has(field.gid) && !held.has(field.gid) && holdsFieldValue(field)) held.set(field.gid, field);
  }
  const defined = await readFieldDefinitions(client, [...held.keys()]);
  const foreign = [...held].map(([gid, field]) => defined.get(gid) ?? definedBySeen(field, tree));
  return { project, sections, settings, tree, ...(foreign.length ? { foreign } : {}), ...(hidden ? { customFieldsHidden: true } : {}) };
}

async function readWhole(client: AsanaClient, gid: string): Promise<WholeRead> {
  const project = await client.sourceProject(gid);
  const sections = gid.startsWith("mytasks:") ? [] : await client.list(`/projects/${gid}/sections`, sectionSchema, { opt_fields: "name" });
  const { settings, hidden } = gid.startsWith("mytasks:") ? { settings: [], hidden: false } : await readSettings(client, gid);
  const top = await client.sourceTasks(gid);
  const seen = new Set(top.map((t) => t.gid));
  const tree: TreeTask[] = [];
  const children = new Map<string, AsanaTask[]>();
  await eachAtOnce(top.filter((t) => t.num_subtasks), async (task) => {
    children.set(task.gid, await client.list(`/tasks/${task.gid}/subtasks`, taskSchema, { opt_fields: TASK_FIELDS }));
  });
  const descend = async (task: AsanaTask, level: number, rootId: string): Promise<void> => {
    tree.push({ task, level, rootId });
    if (!task.num_subtasks) return;
    for (const sub of children.get(task.gid) ?? await client.list(`/tasks/${task.gid}/subtasks`, taskSchema, { opt_fields: TASK_FIELDS })) {
      if (seen.has(sub.gid)) continue;
      seen.add(sub.gid);
      await descend(sub, level + 1, rootId);
    }
  };
  for (const task of top) await descend(task, 1, task.gid);
  return { project, sections, settings, hidden, tree };
}

export async function boardItemIds(client: AsanaClient, boardId: string, selected: readonly string[] = [], lists: ListTrees = new Map()): Promise<Set<string>> {
  const project = baseBoardId(boardId);
  if (project.startsWith("mytasks:")) {
    const read = await readProject(client, project, selected, lists);
    return new Set(read.tree.filter((row) => isLevelTwo(boardId) ? row.level > 1 : row.level === 1).map((row) => row.task.gid));
  }
  if (!isLevelTwo(boardId)) return new Set((await client.itemTitles(project)).keys());
  const top = await client.list(`/projects/${project}/tasks`, taskSchema, { opt_fields: "num_subtasks" });
  const seen = new Set(top.map((t) => t.gid));
  const out = new Set<string>();
  const walk = async (parent: string): Promise<void> => {
    for (const sub of await client.list(`/tasks/${parent}/subtasks`, taskSchema, { opt_fields: "num_subtasks" })) {
      if (seen.has(sub.gid)) continue;
      seen.add(sub.gid);
      out.add(sub.gid);
      if (sub.num_subtasks) await walk(sub.gid);
    }
  };
  for (const task of top) if (task.num_subtasks) await walk(task.gid);
  return out;
}

export const readMembers = (client: AsanaClient, workspaceGid: string): Promise<AsanaWorkspaceMembership[]> =>
  client.list(`/workspaces/${workspaceGid}/workspace_memberships`, workspaceMembershipSchema, { opt_fields: "user.name,user.email,is_active,is_guest,is_admin" });

const person = (gid: string) => ({ id: gid, kind: "person" });
const people = (gids: readonly string[]) => ({ personsAndTeams: gids.map(person) });
const column = (id: string, title: string, type: string, settings: Dict | null = null): ExtractedColumn => ({ id, title, type, settingsStr: "{}", settings });
const labelsOf = (pairs: readonly (readonly [string, string])[], key: "label" | "name") => ({ labels: pairs.map(([id, title]) => ({ id, [key]: title })) });
const ONE_VALUE = { limit_select: true, label_limit_count: 1 } as const;
const oneOption = (field: Pick<AsanaCustomFieldValue, "resource_subtype" | "type" | "representation_type">): boolean => (field.representation_type ?? field.resource_subtype ?? field.type) === "enum";

export function fieldColumnType(field: Pick<AsanaCustomFieldValue, "resource_subtype" | "type" | "id_prefix" | "representation_type"> & Partial<Pick<AsanaCustomFieldValue, "format">>): "text" | "numbers" | "dropdown" | "date" | "people" | "time_tracking" {
  if (field.format === "duration") return "time_tracking";
  const subtype = field.representation_type === "custom_id" ? "text" : field.representation_type === "formula" ? "number" : (field.representation_type ?? field.resource_subtype ?? field.type ?? "");
  if (field.id_prefix) return "text";
  if (subtype === "number") return "numbers";
  if (subtype === "enum" || subtype === "multi_enum") return "dropdown";
  if (subtype === "date") return "date";
  if (subtype === "people") return "people";
  return "text";
}

export type NumberFormat = { kind: "percent" } | { kind: "currency"; code: string } | { kind: "custom"; label: string; position: "prefix" | "suffix" };
function numberFormat(field: Pick<AsanaCustomFieldValue, "format"> & Partial<Pick<AsanaCustomFieldValue, "currency_code" | "custom_label" | "custom_label_position" | "display_value">>): NumberFormat | null {
  if (field.format === "percentage" || field.format === "percent") return { kind: "percent" };
  if (!field.format && /%\s*$/.test(field.display_value ?? "")) return { kind: "percent" };
  if (field.format === "currency" && field.currency_code) return { kind: "currency", code: field.currency_code };
  if (field.format === "custom" && field.custom_label) return { kind: "custom", label: field.custom_label, position: field.custom_label_position === "prefix" ? "prefix" : "suffix" };
  return null;
}
export const numberFormatOf = (column: Pick<ExtractedColumn, "settings">): NumberFormat | null => (column.settings?.["format"] as NumberFormat | undefined) ?? null;

export function tagVocabulary(tree: readonly TreeTask[]): { labels: [string, string][]; canonical: Map<string, string>; merged: string[] } {
  const bySpelling = new Map<string, [string, string]>();
  const canonical = new Map<string, string>();
  const merged: string[] = [];
  for (const { task } of tree) {
    for (const tag of task.tags ?? []) {
      if (canonical.has(tag.gid) || !tag.name) continue;
      const key = spellingKey(tag.name);
      const first = bySpelling.get(key);
      if (first) {
        canonical.set(tag.gid, first[0]);
        merged.push(`${first[1]} / ${tag.name}`);
      } else {
        bySpelling.set(key, [tag.gid, tag.name]);
        canonical.set(tag.gid, tag.gid);
      }
    }
  }
  return { labels: [...bySpelling.values()], canonical, merged };
}

export function projectBoard(read: ProjectRead): ExtractedBoard {
  const { project, sections, settings, tree } = read;
  const { labels: tags } = tagVocabulary(tree);
  const held = new Set(tree.flatMap(({ task }) => task.memberships?.filter((m) => m.project?.gid === project.gid).map((m) => m.section?.gid) ?? []));
  const chosen = new Set(tree.flatMap(({ task }) => (task.custom_fields ?? []).flatMap((f) => [f.enum_value?.gid, ...(f.multi_enum_values ?? []).map((v) => v.gid)])));
  const listed = new Set(tree.flatMap(({ task }) => (task.custom_fields ?? []).map((f) => f.gid)));
  const unlistedTimer = new Set(tree.length ? settings.map((s) => s.custom_field).filter((f) => fieldColumnType(f) === "date" && !listed.has(f.gid)).map((f) => f.gid) : []);
  const custom = [...settings.map((s) => s.custom_field), ...(read.foreign ?? [])].map((field) => {
    const type = unlistedTimer.has(field.gid) ? "time_tracking" : fieldColumnType(field);
    const options = (field.enum_options ?? []).flatMap((o) => (o.name && (o.enabled !== false || chosen.has(o.gid)) ? [[o.gid, o.name] as const] : []));
    const format = type === "numbers" ? numberFormat(field) : null;
    return column(field.gid, field.name ?? field.gid, type, type === "dropdown" ? { ...labelsOf(options, "name"), ...(oneOption(field) ? ONE_VALUE : {}) } : format ? { format } : null);
  });
  const columns = [
    column("__status", "Status", "status", labelsOf(STATUS_LABELS.map((l) => [l, l]), "label")),
    column("__type", "Type", "dropdown", { ...labelsOf([...new Set<string>([...TYPE_LABELS, ...tree.map(({ task }) => typeLabel(task))])].map((l) => [l, l]), "name"), ...ONE_VALUE }),
    column("__assignee", "Assignee", "people"),
    column("__start", "Start date", "date"),
    column("__due", "Due date", "date"),
    column("__completed", "Completed at", "date"),
    column("__tags", "Tags", "tags", labelsOf(tags, "label")),
    ...custom,
    column("__blocked_by", "Blocked by", "text"),
    column("__blocking", "Blocking", "text"),
    column("__also_in", "Also in", "text"),
    column("__parent_task", "Parent task", "text"),
    ...(!tree.some(({ task }) => task.custom_type_status_option?.name) ? [] : [column("__custom_status", "Asana task status", "dropdown", { ...labelsOf([...new Set(tree.flatMap(({ task }) => task.custom_type_status_option?.name ? [task.custom_type_status_option.name] : []))].map((name) => [name, name]), "name"), ...ONE_VALUE })]),
    column("__links", "Links", "long_text"),
    column("__files", "Attachments", "file"),
    ...Object.entries(SYNTHETIC_COLUMNS).map(([id, [title, type]]) => column(id, title, type)),
  ];
  return {
    id: project.gid,
    name: (project.name ?? project.gid).trim(),
    columns,
    subitemBoardIds: [],
    hierarchyType: "multi_level",
    tags,
    groups: project.archived ? [{ id: "__archived", title: "Archived", color: "", position: "1", archived: false }] : sections
      .filter((s) => s.name !== UNTITLED_SECTION || held.has(s.gid))
      .map((s, at) => ({ id: s.gid, title: s.name ?? "", color: "", position: String(at + 1), archived: false })),
    description: project.notes?.trim() || null,
    views: [],
    inUse: columnsInUse(project.gid, tree),
    ...(project.privacy_setting === "private" ? { kind: "private" } : project.privacy_setting === "private_to_team" ? { kind: "team" } : {}),
    ...(project.archived ? { archived: true } : {}),
  };
}

export function levelFields(tree: readonly TreeTask[]): { top: string[]; sub: string[] } {
  const top = new Set<string>();
  const sub = new Set<string>();
  for (const { task, level } of tree) for (const field of task.custom_fields ?? []) (level === 1 ? top : sub).add(field.gid);
  return { top: [...top], sub: [...sub] };
}

export function definedBySeen(field: AsanaCustomFieldValue, tree: readonly TreeTask[]): AsanaCustomFieldValue {
  const kind = field.representation_type ?? field.resource_subtype ?? field.type;
  if (field.enum_options?.length || (kind !== "enum" && kind !== "multi_enum")) return field;
  const options = new Map<string, NonNullable<AsanaCustomFieldValue["enum_options"]>[number]>();
  for (const { task } of tree) {
    for (const held of task.custom_fields ?? []) {
      if (held.gid !== field.gid) continue;
      for (const option of [held.enum_value, ...(held.multi_enum_values ?? [])]) if (option && (!options.has(option.gid) || (!options.get(option.gid)!.name && option.name))) options.set(option.gid, option);
    }
  }
  return options.size ? { ...field, enum_options: [...options.values()] } : field;
}

async function readFieldDefinitions(client: AsanaClient, gids: readonly string[]): Promise<Map<string, AsanaCustomFieldValue>> {
  const out = new Map<string, AsanaCustomFieldValue>();
  for (const gid of gids) {
    try {
      out.set(gid, await client.get(`/custom_fields/${gid}`, customFieldValueSchema, { opt_fields: FIELD_FIELDS }));
    } catch (error) {
      if (!(error instanceof AsanaHttpError && (error.status === 404 || error.status === 403 || error.status === 402))) throw error;
    }
  }
  return out;
}

export async function subtaskBoard(client: AsanaClient, read: ProjectRead): Promise<{ board: ExtractedBoard; fieldIds: Set<string> }> {
  const own = new Map([...read.settings.map((s) => s.custom_field), ...(read.foreign ?? [])].map((field) => [field.gid, field]));
  const listed = new Map<string, AsanaCustomFieldValue>();
  for (const { task, level } of read.tree) if (level > 1) for (const field of task.custom_fields ?? []) if (!listed.has(field.gid)) listed.set(field.gid, field);
  const foreign = [...listed.keys()].filter((gid) => !own.has(gid));
  const defined = await readFieldDefinitions(client, foreign);
  const fields = [...[...own].filter(([gid]) => listed.has(gid)).map(([, field]) => field), ...foreign.map((gid) => defined.get(gid) ?? definedBySeen(listed.get(gid)!, read.tree.filter(({ level }) => level > 1)))];
  const board = projectBoard({ ...read, foreign: [], settings: fields.map((field) => ({ gid: field.gid, custom_field: field })) });
  const inUse = columnsInUse(read.project.gid, read.tree.filter(({ level }) => level > 1));
  return { board: { ...board, id: levelTwoId(read.project.gid), name: `${board.name} (subtasks)`, groups: read.project.archived ? board.groups : [], inUse }, fieldIds: new Set(listed.keys()) };
}

const text = (id: string, type: string, value: string | null | undefined): ColumnValue => ({ id, type, text: value ?? "", value: null });

function linked(id: string, tasks: readonly { gid: string; name?: string | null | undefined }[], taskName: (gid: string) => string | null): ColumnValue {
  const names = tasks.map((t) => t.name?.trim() || taskName(t.gid));
  const cell = text(id, "text", names.map((name, at) => name ?? `Asana task ${tasks[at]!.gid}`).join(", "));
  return names.includes(null) ? { ...cell, partial: true } : cell;
}

const BLOCK_TAGS = new Set(["ul", "ol", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "p"]);
const tagOf = (token: string): { name: string; closing: boolean } | null => {
  const found = /^<(\/?)([a-z0-9]+)/.exec(token);
  return found ? { name: found[2]!, closing: found[1] === "/" } : null;
};
const EMPTY_FORMATTING = /<(strong|em|u|s|code|a)\b[^>]*><\/\1>/g;
const BLANK = "\u0000blank";
const LINE_BLOCKS = new Set(["li", "p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

export function asanaHtml(html: string | null | undefined): string {
  const inner = (html ?? "").replace(/^\s*<body>/, "").replace(/<\/body>\s*$/, "");
  const tokens = sanitizeHtml(inner).split(/(<[^>]*>)/);
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  let shows = false;
  let afterBreak = false;
  const endLine = (byNewline: boolean): void => {
    if (shows) {
      let closed = `${line}${[...open].reverse().map((t) => `</${tagOf(t)!.name}>`).join("")}`;
      const tags = (closed.match(/<[a-z]/g) ?? []).length;
      for (let pass = 0, before = ""; pass <= tags && before !== closed; pass++) [before, closed] = [closed, closed.replace(EMPTY_FORMATTING, "")];
      out.push(`<p>${closed.trim()}</p>`);
    } else if (byNewline && afterBreak) out.push(BLANK);
    line = open.join("");
    shows = false;
    afterBreak = byNewline;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const tag = i % 2 ? tagOf(token) : null;
    if (!tag) {
      token.split("\n").forEach((piece, n) => {
        if (n) endLine(true);
        if (piece.trim()) shows = true;
        line += piece;
      });
    } else if (BLOCK_TAGS.has(tag.name) && !tag.closing) {
      endLine(false);
      let block = token;
      const blocks = [tag.name];
      for (let depth = 1; depth > 0 && ++i < tokens.length;) {
        const next = i % 2 ? tagOf(tokens[i]!) : null;
        if (next && BLOCK_TAGS.has(next.name)) depth += next.closing ? -1 : 1;
        if (next && (BLOCK_TAGS.has(next.name) || next.name === "li")) {
          if (!next.closing) blocks.push(next.name);
          else blocks.splice(blocks.lastIndexOf(next.name), 1);
        }
        const breaks = !next && tokens[i]!.trim() !== "" && !blocks.includes("pre") && LINE_BLOCKS.has(blocks.at(-1) ?? "");
        block += breaks ? tokens[i]!.replace(/\n/g, "<br>") : tokens[i]!;
      }
      out.push(block);
      afterBreak = false;
    } else if (tag.name === "br" || BLOCK_TAGS.has(tag.name)) line += tag.name === "br" ? token : "";
    else if (tag.closing) {
      const at = open.map((t) => tagOf(t)!.name).lastIndexOf(tag.name);
      if (at >= 0) open.splice(at, 1);
      line += token;
    } else {
      open.push(token);
      line += token;
    }
  }
  endLine(false);
  while (out[0] === BLANK) out.shift();
  while (out.at(-1) === BLANK) out.pop();
  return out.map((p) => (p === BLANK ? "<p></p>" : p)).join("\n");
}

export function richOr(html: string | null | undefined, plain: string | null | undefined): string {
  try {
    return asanaHtml(html);
  } catch {
    return toHtml(plain ?? "");
  }
}

function statusOf(task: AsanaTask): string {
  if (task.resource_subtype === "approval") return APPROVAL_LABEL[task.approval_status ?? ""] ?? "Pending";
  return task.completed ? "Done" : "To do";
}

function customValue(field: AsanaCustomFieldValue, percentFields: ReadonlySet<string>): ColumnValue {
  const type = fieldColumnType(field);
  if (type === "numbers") {
    const held = typeof field.number_value === "number" && Number.isFinite(field.number_value) ? field.number_value : null;
    if (held === null) return { id: field.gid, type, text: "", value: null };
    if (!percentFields.has(field.gid)) return { id: field.gid, type, text: String(held), value: held };
    const scaled = new Decimal(held).times(100);
    return Number.isFinite(scaled.toNumber()) ? { id: field.gid, type, text: String(scaled.toNumber()), value: scaled.toNumber() } : { id: field.gid, type, text: scaled.toString(), value: null };
  }
  if (type === "dropdown") {
    const chosen = field.multi_enum_values ?? (field.enum_value ? [field.enum_value] : []);
    return { id: field.gid, type, text: chosen.map((o) => o.name).join(", "), value: { ids: chosen.map((o) => o.gid) } };
  }
  if (type === "date") return text(field.gid, type, field.date_value?.date_time ?? field.date_value?.date);
  if (type === "people") {
    const who = field.people_value ?? [];
    return { id: field.gid, type, text: who.map((u) => u.name).join(", "), value: people(who.map((u) => u.gid)) };
  }
  if (field.reference_value) return text(field.gid, type, field.reference_value.map((r) => r.name).join(", "));
  return text(field.gid, type, field.text_value ?? field.display_value);
}


export type ItemContext = {
  projectGid: string;
  fieldIds: ReadonlySet<string>;
  percentFields: ReadonlySet<string>;
  canonicalTags: ReadonlyMap<string, string>;
  parentName: string | null;
  taskName: (gid: string) => string | null;
};

function taskItem(entry: TreeTask, context: ItemContext): ExtractedItem {
  const { task, level, rootId } = entry;
  const { projectGid, fieldIds, percentFields, canonicalTags, parentName } = context;
  const membership = task.memberships?.find((m) => m.project?.gid === projectGid);
  const tagIds = [...new Set((task.tags ?? []).flatMap((t) => canonicalTags.get(t.gid) ?? []))];
  const assignee = task.assignee?.gid;
  const also = (task.memberships ?? []).filter((m) => m.project && m.project.gid !== projectGid).map((m) => m.project?.name ?? "").filter(Boolean).sort();
  const values: ColumnValue[] = [
    { id: "__status", type: "status", text: statusOf(task), value: { index: statusOf(task) } },
    { id: "__type", type: "dropdown", text: typeLabel(task), value: { ids: [typeLabel(task)] } },
    { id: "__assignee", type: "people", text: task.assignee?.name ?? "", value: people(assignee ? [assignee] : []) },
    text("__start", "date", task.start_at ?? task.start_on),
    text("__due", "date", task.due_at ?? task.due_on),
    text("__completed", "date", task.completed_at),
    { id: "__tags", type: "tags", text: [...new Set((task.tags ?? []).flatMap((t) => (t.name ? [t.name] : [])))].join(", "), value: { tag_ids: tagIds } },
    ...(task.custom_fields ?? []).filter((f) => fieldIds.has(f.gid)).map((f) => customValue(f, percentFields)),
    linked("__blocked_by", task.dependencies ?? [], context.taskName),
    linked("__blocking", task.dependents ?? [], context.taskName),
    text("__also_in", "text", also.join(", ")),
    text("__parent_task", "text", level > 2 ? parentName : ""),
    ...(task.custom_type_status_option?.name ? [{ id: "__custom_status", type: "dropdown", text: task.custom_type_status_option?.name ?? "", value: { ids: task.custom_type_status_option?.name ? [task.custom_type_status_option.name] : [] } }] : []),
    text("__url", "link", task.permalink_url),
    { ...text("__description", "long_text", task.notes), html: richOr(task.html_notes, task.notes) },
    text("__created_at", "creation_log", task.created_at),
    text("__created_by", "text", task.created_by?.name),
    text("__updated_at", "last_updated", task.modified_at),
  ];
  return {
    id: task.gid,
    name: task.name ?? "",
    groupTitle: level === 1 ? (membership?.section?.name ?? null) : null,
    groupId: level === 1 ? (membership?.section?.gid ?? null) : null,
    parentId: level === 1 ? null : rootId,
    state: "active",
    subscriberIds: (task.followers ?? []).map((f) => f.gid),
    columnValues: Object.fromEntries(values.map((v) => [v.id, v])),
  };
}

export type ExtractOptions = {
  since?: string | null;
  subSince?: string | null;
  subtaskBoard?: boolean;
  lists?: ListTrees;
  selected: readonly string[];
  subtasksCarried?: ReadonlySet<string>;
  alsoRead?: ReadonlySet<string>;
  hiddenEdits?: number;
  members: readonly AsanaWorkspaceMembership[];
};

const byGid = (a: string, b: string): number => /^\d+$/.test(a) && /^\d+$/.test(b) ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : a.localeCompare(b);

export function homeProject(projects: readonly string[], selected: readonly string[]): string | null {
  const wanted = new Set(selected);
  return [...projects].filter((p) => wanted.has(p)).sort(byGid)[0] ?? null;
}

function users(entries: readonly TreeTask[], members: readonly AsanaWorkspaceMembership[]): Record<string, ExtractedUser> {
  const out: Record<string, ExtractedUser> = {};
  for (const m of members) {
    if (!m.user) continue;
    out[m.user.gid] = { id: m.user.gid, name: m.user.name ?? null, email: m.user.email ?? null, enabled: m.is_active ?? null, isPending: false, isGuest: m.is_guest ?? null };
  }
  for (const [id, user] of Object.entries(namedByWork(entries))) out[id] ??= user;
  return out;
}

export function namedByWork(entries: readonly TreeTask[]): Record<string, ExtractedUser> {
  const out: Record<string, ExtractedUser> = {};
  const seen = (u: { gid: string; name?: string | null | undefined; email?: string | null | undefined } | null | undefined): void => {
    if (!u) return;
    const known = out[u.gid];
    if (known && (known.name || !u.name)) return;
    out[u.gid] = { id: u.gid, name: u.name ?? known?.name ?? null, email: (u.email as string | null | undefined) ?? known?.email ?? null, enabled: false, isPending: false, isGuest: null };
  };
  for (const { task } of entries) {
    seen(task.assignee);
    for (const f of task.followers ?? []) seen(f);
    for (const c of task.custom_fields ?? []) for (const u of c.people_value ?? []) seen(u);
  }
  return out;
}

function everyone(items: readonly ExtractedItem[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    for (const cv of Object.values(item.columnValues)) if (cv.type === "people" && cv.value && typeof cv.value === "object") for (const p of (cv.value as { personsAndTeams: { id: string }[] }).personsAndTeams) out.add(p.id);
    for (const id of item.subscriberIds) out.add(id);
  }
  return [...out];
}

export const editHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

export const storedByAsana = (a: Pick<AsanaAttachment, "resource_subtype" | "host">): boolean => [a.resource_subtype, a.host].every((v) => v === null || v === undefined || v === "asana");

async function reach(client: AsanaClient, task: AsanaTask, known: Map<string, string[]>, local: ReadonlyMap<string, AsanaTask> = new Map(), climbing: ReadonlySet<string> = new Set()): Promise<string[]> {
  const own = (task.memberships ?? []).flatMap((m) => (m.project ? [m.project.gid] : []));
  const parent = task.parent?.gid;
  if (!parent || climbing.has(parent)) return own;
  let above = known.get(parent);
  if (!above) {
    try {
      const read = local.get(parent) ?? await client.get(`/tasks/${parent}`, taskSchema, { opt_fields: "memberships.project.name,parent.name" });
      above = await reach(client, read, known, local, new Set([...climbing, task.gid, parent]));
    } catch (error) {
      if (!isAsanaHidden(error)) throw error;
      above = [];
    }
    known.set(parent, above);
  }
  return [...new Set([...own, ...above])];
}

export async function extractProject(client: AsanaClient, gid: string, options: ExtractOptions): Promise<{ top: BoardExtract; second: BoardExtract }> {
  const read = await readProject(client, gid, options.selected, options.lists);
  const board = projectBoard(read);
  const { canonical, merged } = tagVocabulary(read.tree);
  const fieldIds = new Set([...read.settings.map((s) => s.custom_field.gid), ...(read.foreign ?? []).map((field) => field.gid)]);
  const foreign = levelFields(read.tree).sub.some((field) => !fieldIds.has(field));
  const own = options.subtaskBoard || foreign ? await subtaskBoard(client, read) : null;
  const subFieldIds = own?.fieldIds ?? fieldIds;
  const nameOf = new Map(read.tree.map(({ task }) => [task.gid, task.name ?? ""]));
  const linked = [...new Set(read.tree.flatMap(({ task }) => [...(task.dependencies ?? []), ...(task.dependents ?? [])].map((d) => d.gid)))];
  const outside = await client.itemNames(linked.filter((id) => !nameOf.has(id)));
  const taskName = (id: string): string | null => (nameOf.get(id) ?? outside.get(id))?.trim() || null;
  const since = options.since ? Date.parse(options.since) : null;
  const subSince = options.subSince === undefined ? since : options.subSince ? Date.parse(options.subSince) : null;
  const known = new Map<string, string[]>();

  const assets: Record<string, AssetMeta> = {};
  const detailsUnread: string[] = [];
  const items: { item: ExtractedItem; level: number }[] = [];
  const toRead: { task: AsanaTask; item: ExtractedItem; updates: ExtractedUpdate[] }[] = [];

  const taskByGid = new Map(read.tree.map((t) => [t.task.gid, t.task]));
  const percentFields = new Set([...board.columns, ...(own?.board.columns ?? [])].filter((c) => numberFormatOf(c)?.kind === "percent").map((c) => c.id));
  for (const entry of read.tree) {
    const { task, level } = entry;
    const item = taskItem(entry, { projectGid: gid, fieldIds: level === 1 ? fieldIds : subFieldIds, percentFields, canonicalTags: canonical, parentName: task.parent ? (nameOf.get(task.parent.gid) ?? task.parent.name ?? null) : null, taskName });
    if (read.project.archived) { item.groupTitle = "Archived"; item.groupId = "__archived"; }
    items.push({ item, level });
    const carries = (p: string): boolean => options.subtasksCarried?.has(p) ?? true;
    const direct = new Set((task.memberships ?? []).flatMap((m) => (m.project ? [m.project.gid] : [])));
    const rows = (await reach(client, task, known, taskByGid)).filter((p) => direct.has(p) || carries(p));
    const home = homeProject([...(level === 1 || carries(gid) ? [gid] : []), ...rows], options.selected) ?? gid;
    if (home !== gid) continue;
    const from = level === 1 ? since : subSince;
    const changed = from === null || Date.parse(task.modified_at ?? "") >= from || options.alsoRead?.has(task.gid) === true;
    if (!changed) {
      detailsUnread.push(task.gid);
      continue;
    }
    toRead.push({ task, item, updates: [] });
  }

  const refused: string[] = [];
  const hiddenOr = async <T>(read: () => Promise<T>, task: AsanaTask): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (!isAsanaHidden(error)) throw error;
      refused.push(task.gid);
      return null;
    }
  };
  await eachAtOnce(toRead, async ({ task, item, updates }) => {
    const stories = await hiddenOr(() => client.list(`/tasks/${task.gid}/stories`, storySchema, { opt_fields: STORY_FIELDS }), task);
    const attachments = stories && await hiddenOr(() => client.list(`/tasks/${task.gid}/attachments`, attachmentSchema, { opt_fields: ATTACHMENT_FIELDS }), task);
    if (!stories || !attachments) return;
    const envelopes = new Map(stories.flatMap((s) => (s.comment_gid ? [[s.comment_gid, s.gid] as const] : [])));
    for (const story of stories) {
      if (story.resource_subtype !== "comment_added") continue;
      const parentId = story.anchor_gid && story.anchor_gid !== task.gid ? (envelopes.get(story.anchor_gid) ?? null) : null;
      updates.push({
        id: story.gid,
        itemId: task.gid,
        text: story.text ?? "",
        createdAt: story.created_at ?? "",
        author: story.created_by?.name?.trim() || "unknown",
        editedAt: null,
        parentId,
        assets: [],
        ...(story.html_text ? { body: richOr(story.html_text, story.text) } : {}),
        ...(story.is_pinned ? { pinned: true } : {}),
        ...(story.is_edited ? { editHash: editHash(story.text ?? "") } : {}),
      });
    }
    const files = attachments.filter(storedByAsana);
    const links = attachments.filter((a) => !storedByAsana(a));
    for (const file of files) assets[file.gid] = { id: file.gid, name: file.name ?? null, size: file.size ?? null };
    item.columnValues["__files"] = { id: "__files", type: "file", text: files.map((f) => f.name).join(", "), value: { files: files.map((f) => ({ assetId: f.gid, name: f.name, fileType: "ASSET" })) } };
    item.columnValues["__links"] = { ...text("__links", "long_text", links.map((l) => `${l.name}: ${l.view_url ?? ""}`).join("\n")), html: sanitizeHtml(links.map((l) => `<p><a href="${escapeHtml(l.view_url ?? "")}">${escapeHtml(l.name ?? "")}</a></p>`).join("\n")) };
  });
  const updates = toRead.flatMap((read) => (refused.includes(read.task.gid) ? [] : read.updates));
  detailsUnread.push(...refused);
  const short = [
    ...(refused.length ? [`Asana refused the comments or attachments of ${refused.length} task(s) to this token (${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ", …" : ""})`] : []),
    ...(options.hiddenEdits ? [`Asana refused ${options.hiddenEdits} edited comment(s) to this token, so their tasks are unknown`] : []),
  ];
  const readShort = short.length ? `${short.join("; ")}: what Plaky holds for them stays, and the board is read in full next time.` : null;

  const every = users(read.tree, options.members);
  const pick = (wanted: (level: number) => boolean, entryBoard: ExtractedBoard): BoardExtract => {
    const chosen = items.filter(({ level }) => wanted(level)).map(({ item }) => item);
    const ids = new Set(chosen.map((i) => i.id));
    return {
      board: entryBoard,
      items: chosen,
      updates: updates.filter((u) => ids.has(u.itemId)),
      assets,
      users: every,
      teams: {},
      people: { users: everyone(chosen), teams: [] },
      ...(detailsUnread.length ? { detailsUnread: detailsUnread.filter((id) => ids.has(id)) } : {}),
      ...(readShort ? { readShort } : {}),
      ...(merged.length ? { mergedTags: merged } : {}),
    };
  };
  return {
    top: pick((level) => level === 1, board),
    second: pick((level) => level > 1, own?.board ?? { ...board, id: levelTwoId(gid), name: `${board.name} (subtasks)` }),
  };
}
