import { checklistText, isLabelColorInstruction } from "@/lib/checklist-copy";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ColumnPlan, dropped, importable, isSubitemBoard, manifestWarnings, boardWarnings, seedHeaders, seedRowsNeeded, seededColumns, totalItems, type DiscoveredBoard, type Manifest } from "./manifest";
import { ITEM_TITLE_HEADER, ASANA_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD, isLevelTwo, seedMarker } from "./names";
import { groupProjects } from "@/lib/scope-report";
import { parse } from "@/lib/people-entry";
import type { PeopleMap } from "./config";
import { importLabel } from "./transform/compat";
import { spellingKey } from "./transform/mapping";
import { isAlnum, pyStr, pyStrip } from "./transform/pystr";

const SEED_TITLE_PREFIX = "__A2P_SEED__";

export function seedRows(board: DiscoveredBoard): string[][] {
  const headers = seedHeaders(board);
  const byName = new Map(seededColumns(board).map((c) => [c.fieldName, c]));
  const marker = seedMarker(board.id);
  return Array.from({ length: seedRowsNeeded(board) }, (_, index) =>
    headers.map((header) => {
      if (header === ITEM_TITLE_HEADER) return `${SEED_TITLE_PREFIX} ${index + 1}`;
      if (header === ASANA_ID_FIELD) return marker;
      return byName.get(header)?.labels[index] ?? "";
    }),
  );
}

function csvField(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const seedCsv = (board: DiscoveredBoard): string => [seedHeaders(board), ...seedRows(board)].map((row) => `${row.map(csvField).join(",")}\r\n`).join("");

export function slug(name: string, boardId: string): string {
  const kept = [...pyStrip(name)].map((c) => (isAlnum(c) || c === "-" || c === "_" ? c : "-")).join("");
  let stem = kept.replace(/^-+|-+$/g, "").toLowerCase() || "board";
  while (stem.includes("--")) stem = stem.replaceAll("--", "-");
  return `${stem}-${boardId.replaceAll(":", "-")}`;
}

export type SeedFiles = ReadonlyMap<string, string>;

export function buildGuide(manifest: Manifest, files: SeedFiles, people?: PeopleMap): string {
  const real = manifest.boards.filter((b) => !isSubitemBoard(b));
  const subs = new Map(manifest.boards.filter(isSubitemBoard).map((b) => [b.parentBoardId, b] as const));

  const out: string[] = [
    "# Create these boards in Plaky",
    "",
    `${manifest.boards.length} board(s), for ${totalItems(manifest)} Asana item(s).`,
    "",
    "Plaky's API cannot create a board, a field, a status label or a tag value,",
    "so each board is created once by importing the seed CSV next to this file.",
    "The CSV carries no real data — only the field names, their types, and the",
    "status/tag values that have to exist before any item can be written.",
    "",
    "For each board below:",
    "",
    "1. In the Plaky space, **+ → New Board → Create from file**.",
    "2. Upload the named CSV. Leave the delimiter on Comma and *My file has",
    "   headers* on; `Name` is the item name column.",
    "3. **Proceed**, then set each column's type using the table for that board.",
    "   A column starts as Text; change it with **Create New Field ▸ <type>**.",
    "   Leave *Destination group* on **New group** — groups are created later",
    "   through the API, which has no 20-group limit.",
    "4. **Finish import.**",
    "5. Rename the board exactly as its *Finish by hand* list says: every",
    '   imported board is called "New board" and Plaky has no API to rename it.',
    "",
    "A board with no file is a duplicate: on the board it names, **⋮ → Duplicate**,",
    "pick **Structure only**, and give the copy exactly the name it lists. A",
    "duplicate has no seed rows, so the app finds it by that name alone.",
    "",
    "Then come back to the app: **Check now** finds the boards, and **Link boards**",
    "pairs them and deletes the seed rows.",
    "",
    "Set up board automations only after Move has finished: every item it",
    "creates fires an *Item created* trigger and would spend the automation quota.",
    "",
  ];

  const built = manifest.boards.filter((b) => b.plakyBoardId !== null);
  for (const board of real) {
    const pair = subs.get(board.id);
    if (board.plakyBoardId === null) out.push(...boardSection(board, files, { subitem: pair }, manifest));
    if (pair && pair.plakyBoardId === null) out.push(...boardSection(pair, files, { parent: board }, manifest));
  }

  if (built.length) {
    out.push("## Already built", "", "Nothing to do for these — do not import them again.", "");
    out.push(...built.map((b) => `- **${b.name}** (\`${b.id}\`) -> Plaky board \`${b.plakyBoardId}\``));
    out.push("");
  }

  out.push(...peopleSection(manifest, people));

  if (manifest.skipped.length) {
    out.push("## Not migrated", "");
    out.push(...manifest.skipped.map((s) => `- **${s.name}** (\`${s.id}\`) — ${s.reason}`));
    out.push("");
  }

  const warnings = manifestWarnings(manifest);
  if (warnings.length) out.push("## Check these", "", ...warnings.map((w) => `- ${w}`), "");

  return out.join("\n");
}

function peopleSection(manifest: Pick<Manifest, "people">, people?: PeopleMap): string[] {
  const choice = (id: string) => parse(people && Object.hasOwn(people, id) ? people[id] : null).choice;
  const standIns = manifest.people.filter((p) => p.kind === "person" && p.placeholder && (people === undefined || choice(p.id) === "team"));
  const asText = people === undefined ? [] : manifest.people.filter((p) => p.kind === "person" && p.placeholder && choice(p.id) === "header");
  const teams = manifest.people.filter((p) => p.kind === "team");
  const direct = manifest.people.filter((p) => p.kind === "person" && !p.placeholder);
  if (!(standIns.length || asText.length || teams.length || direct.length)) return [];
  const out = ["## People and teams", ""];
  if (asText.length) {
    out.push(
      `${asText.length} person(s) Plaky cannot assign keep their name as text, in the Text field beside`,
      "each people field that names them (`<field> (name)`, in the seed already): nothing to set up.",
      "",
    );
  }
  if (direct.length) {
    out.push(
      `${direct.length} assigned person(s) have a Plaky account with the same email and`,
      "are assigned as themselves. Plaky notifies them as their assignments arrive.",
      "",
    );
  }
  if (standIns.length) {
    out.push(
      "### Create these empty teams",
      "",
      "Each stands in for someone Plaky cannot assign yet, so their items still show",
      "who they belong to, and nobody is notified. That covers anyone deactivated or",
      "never joined in Asana, and anyone Plaky cannot assign: no account, a deactivated",
      "account, or a viewer. Someone invited to Plaky can be assigned before accepting.",
      "Once one of them can be assigned, the next apply moves their items from the team",
      "to them.",
      "",
      "For each one: workspace menu (**⋮** next to the workspace name) → **Teams** →",
      "**⊕**, rename the new team to exactly the title below, then **remove yourself**.",
      "Plaky adds whoever creates a team, and link waits until every team below",
      "exists and is empty.",
      "",
    );
    out.push(...standIns.map((p) => `- \`${p.placeholder}\``));
    out.push("");
  }
  if (teams.length) {
    out.push("### Recreate these Asana teams", "", "Same name, same people. link waits until each exists:", "");
    out.push(...teams.map((t) => `- **${t.name}**: ${t.members.length ? t.members.join(", ") : "no members listed"}`));
    out.push("");
  }
  return out;
}

const OPT_IN_EXTRAS: readonly (readonly [id: string, label: string])[] = [
  ["__created_by", "who created each item and when"],
  ["__url", "a link back to each Asana item"],
];

function boardSection(board: DiscoveredBoard, files: SeedFiles, links: { subitem?: DiscoveredBoard | undefined; parent?: DiscoveredBoard }, manifest: Pick<Manifest, "boards">): string[] {
  const { subitem, parent } = links;
  const kind = (b: DiscoveredBoard): string => (isLevelTwo(b.id) ? "subtasks" : "subitems");
  let heading = `## ${board.name}`;
  if (parent !== undefined) heading += ` — ${kind(board)} of ${parent.name}`;
  const out = [heading, ""];

  if (parent !== undefined && board.nested) {
    heading = `## ${board.name} — nested under ${parent.name}`;
    out[0] = heading;
    out.push(
      `- Asana board: \`${board.id}\``,
      `- ${board.itemsCount} item(s) to migrate, nested under their items on *${parent.name}*`,
      "",
      `No file to import: these nest under their parent items on *${parent.name}*'s board,`,
      "whose seed carries their columns beside its own (the rows marked",
      "*on the subitem board* in that table). Nothing to do here.",
      "",
    );
    return out;
  }
  if (parent !== undefined) {
    out.push(
      `Asana keeps these as ${kind(board)} of *${parent.name}*. A Plaky subitem has`,
      "exactly the parent board's fields, and these have columns of their own,",
      "so they import as ordinary items on a board of their own.",
      "`Parent Item` and `Parent Asana ID` carry the link.",
      "",
    );
  } else if (subitem !== undefined && subitem.nested) {
    out.push(`Its subitems nest under their items on this board: the columns marked *on the subitem board* come from *${subitem.name}*.`, "");
  } else if (subitem !== undefined) {
    out.push(`Its ${kind(subitem)} become a separate board — see *${subitem.name}* below.`, "");
  }

  const titles = boardTitles(manifest);
  const file = files.get(board.id);
  const source = duplicateSources(manifest).get(board.id);
  out.push(
    `- Asana board: \`${board.id}\``,
    file !== undefined
      ? `- file: \`${file}\``
      : source !== undefined
        ? `- no file: duplicate *${titles.get(source) ?? source}*'s board (structure only) and name the copy exactly *${titles.get(board.id) ?? board.name}*`
        : `- no file`,
    `- ${board.itemsCount} item(s) to migrate`,
    "",
    "| CSV column | Plaky type to pick | Notes |",
    "| --- | --- | --- |",
    `| \`${ITEM_TITLE_HEADER}\` | *Item names* (preselected) | the Asana item name |`,
    `| \`${ASANA_ID_FIELD}\` | Text | how a re-run updates instead of duplicating |`,
  );
  if (isSubitemBoard(board) && !board.nested) {
    out.push(`| \`${PARENT_TITLE_FIELD}\` | Text | the Asana parent's name |`, `| \`${PARENT_ID_FIELD}\` | Text | the Asana parent's id |`);
  }
  const ownCount = importable(board).length;
  seededColumns(board).forEach((column, at) => {
    let note = `from *${column.title}* (${column.type})${at >= ownCount ? " on the subitem board" : ""}`;
    if (column.labels.length) note += `; creates ${column.labels.length} value(s): ${column.labels.map((l) => `"${l.replaceAll("|", "\\|")}"`).join(", ")}`;
    if (column.reason) note += `; ${column.reason}`;
    out.push(`| \`${column.fieldName}\` | ${importLabel(column.plakyType, column.importAs)} | ${note} |`);
  });
  out.push("");

  out.push("Not carried:", "");
  out.push(...dropped(board).map((c) => `- **${c.title}** (${c.type}) — ${pyStr(c.reason)}`));
  const carried = new Set(importable(board).map((c) => c.id));
  const missing = OPT_IN_EXTRAS.filter(([id]) => !carried.has(id)).map(([, label]) => label);
  if (missing.length) out.push(`- ${missing.join(" and ")}: tick the options in Boards, then read the boards again to add them`, "  as fields.");
  out.push("- Asana's *last updated* time, which means nothing once Asana is retired.", "");

  for (const warning of boardWarnings(seedOf(board, manifest))) out.push(`> **Check:** ${warning}`, "");
  const manual = board.byHand.filter((step, at) => !isLabelColorInstruction(step) && !(file === undefined && at === 0 && step.startsWith(RENAME_STEP)));
  if (manual.length) {
    out.push("Finish by hand in Plaky (its API cannot):", "");
    out.push(...manual.map((step) => `- ${checklistText(step)}`));
    out.push("");
  }
  return out;
}

export const RENAME_STEP = 'Rename the imported "New board" to ';

export type Blueprint = {
  seedFiles: Map<string, string>;
  files: Record<string, string>;
};

export const GUIDE_FILE = "BUILD.md";

export function boardTitles(manifest: Pick<Manifest, "boards">): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const board of manifest.boards) {
    if (board.nested) continue;
    const name = board.name.trim();
    let [title, n] = [name, 2];
    while (taken.has(title)) [title, n] = [`${name} (${n})`, n + 1];
    taken.add(title);
    out.set(board.id, title);
  }
  return out;
}

export function duplicateSources(manifest: Pick<Manifest, "boards">): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of groupProjects(manifest)) for (const project of group.projects.slice(1)) out.set(project.id, group.projects[0]!.id);
  return out;
}

export function seedOf(board: DiscoveredBoard, manifest: Pick<Manifest, "boards">): DiscoveredBoard {
  const members = groupProjects(manifest).find((g) => g.projects[0]?.id === board.id)?.projects ?? [];
  const others = manifest.boards.filter((b) => b.id !== board.id && members.some((m) => m.id === b.id));
  const union = (column: ColumnPlan): ColumnPlan => {
    const labels = [...column.labels];
    const spellings = new Set(labels.map(spellingKey));
    for (const other of others) {
      for (const label of seededColumns(other).find((c) => c.fieldName === column.fieldName)?.labels ?? []) {
        if (spellings.has(spellingKey(label))) continue;
        spellings.add(spellingKey(label));
        labels.push(label);
      }
    }
    return { ...column, labels };
  };
  return { ...board, columns: board.columns.map(union), nestedColumns: board.nestedColumns.map(union) };
}

export function writeBlueprint(manifest: Manifest, people?: PeopleMap): Blueprint {
  const copies = duplicateSources(manifest);
  const todo = manifest.boards.filter((b) => b.plakyBoardId === null && !b.nested && !copies.has(b.id));
  const seedFiles = new Map(todo.map((b) => [b.id, `${slug(b.name, b.id)}.seed.csv`] as const));
  const files: Record<string, string> = {};
  for (const board of todo) files[seedFiles.get(board.id) ?? ""] = seedCsv(seedOf(board, manifest));
  files[GUIDE_FILE] = buildGuide(manifest, seedFiles, people);
  return { seedFiles, files };
}

export async function writeBlueprintFiles(blueprint: Pick<Blueprint, "files">, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(blueprint.files)) await writeFile(join(directory, name), text, "utf8");
}
