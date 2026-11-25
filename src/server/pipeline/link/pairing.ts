import { type BoardSync, type SyncConfig } from "../config";
import { SYNTHETIC_COLUMNS } from "../extract";
import { dropped, importable, isSubitemBoard, type DiscoveredBoard, type Manifest } from "../manifest";
import { ASANA_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "../names";
import { PLAKY_TYPE_LABEL, compatibleTypes, importLabel } from "../transform/compat";
import { fieldsTitled, labelIndex, spellingKey, type PlakyField } from "../transform/mapping";
import { strOf } from "../transform/pyvalue";
import { type SeededBoard, type BoardLink, type LinkResult } from "./types";

const typeLabel = (plakyType: string | null): string => PLAKY_TYPE_LABEL[plakyType ?? ""] ?? (plakyType || "?");
const aField = (label: string): string => `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} field`;

function fix(target: PlakyField, wanted: string): string {
  return `In Plaky: on the '${target.name}' header open the ⌄ menu -> Change field type -> ${wanted} -> Convert.`;
}

export function checkField(
  title: string,
  asanaType: string,
  expected: string | null,
  target: PlakyField,
  labels: readonly string[],
  wanted = typeLabel(expected),
): [problem: string | null, warning: string | null] {
  let warning: string | null = null;
  if (expected && target.type !== expected) {
    if (!compatibleTypes(asanaType).includes(target.type)) {
      return [
        `${title} -> '${target.name}': expected ${expected}, got ${target.type}; Asana ${asanaType} values cannot be stored there. ${fix(target, wanted)}`,
        null,
      ];
    }
    warning = `${title} -> '${target.name}' is ${typeLabel(target.type)}, not ${wanted}: carried, but as ${typeLabel(target.type)}. ${fix(target, wanted)}`;
  }
  if ((target.type === "STATUS" || target.type === "TAG") && labels.length) {
    const index = labelIndex(target);
    const missing = labels.filter((label) => !target.labels.includes(label) && !index.has(spellingKey(label)));
    if (missing.length) {
      const how = target.type === "TAG" ? `on a seed row click the '${target.name}' cell, type the label and press Enter` : "field header ⌄ -> Field settings";
      return [`${title} -> '${target.name}' has no label(s) ${strOf(missing)}, and Plaky's API cannot create one. Add each in Plaky (${how}).`, warning];
    }
  }
  return [null, warning];
}

export function matchFields(board: DiscoveredBoard, seeded: SeededBoard, previous: BoardSync | null = null): BoardLink {
  const byKey = new Map(seeded.fields.map((f) => [f.key, f]));
  const sameBoard = previous === null || previous.plakyBoardId === seeded.plakyBoardId;
  const keyHere = <T>(recorded: T): T | undefined => (sameBoard ? recorded : undefined);
  const remembered = new Map<string, unknown>(sameBoard ? Object.entries(previous?.fieldMap ?? {}) : []);

  const keyFor = (name: string, rememberedKey?: unknown): string | null => {
    if (typeof rememberedKey === "string" && rememberedKey && byKey.has(rememberedKey)) return rememberedKey;
    const candidates = fieldsTitled(name, seeded.fields);
    return candidates.length === 1 ? candidates[0]!.key : null;
  };

  const skippedBefore = new Set<unknown>(previous?.skipColumns ?? []);
  const importableColumns = importable(board);
  const keptOut = importableColumns.filter((c) => skippedBefore.has(c.id) && !Object.hasOwn(SYNTHETIC_COLUMNS, c.id)).map((c) => c.id);
  const fieldMap: Record<string, string> = {};
  const unmatched: string[] = [];
  const warnings: string[] = [];
  for (const column of importableColumns) {
    if (keptOut.includes(column.id)) continue;
    const key = keyFor(column.fieldName, remembered.get(column.id));
    if (key === null) {
      unmatched.push(
        `${column.title} -> no Plaky field named '${column.fieldName}' and none recorded from a previous link. In Plaky, add ` +
          `${aField(importLabel(column.plakyType, column.importAs))} named '${column.fieldName}' to the board: the + at the right end of its header row.`,
      );
      continue;
    }
    fieldMap[column.id] = key;
    const renames = previous?.labelMap[column.id] ?? {};
    const labels = column.labels.map((l) => (Object.hasOwn(renames, l) ? String(renames[l]) : l));
    const [problem, warning] = checkField(column.title, column.type, column.plakyType, byKey.get(key)!, [...new Set(labels)], importLabel(column.plakyType, column.importAs));
    if (problem) unmatched.push(problem);
    if (warning) warnings.push(warning);
  }

  const asanaIdKey = keyFor(ASANA_ID_FIELD, keyHere(previous?.asanaIdField));
  const flat = isSubitemBoard(board) && !board.nested;
  const parentTitleKey = flat ? keyFor(PARENT_TITLE_FIELD, keyHere(previous?.parentTitleField)) : null;
  const parentIdKey = flat ? keyFor(PARENT_ID_FIELD, keyHere(previous?.parentIdField)) : null;
  for (const [name, key] of [[ASANA_ID_FIELD, asanaIdKey], [PARENT_TITLE_FIELD, parentTitleKey], [PARENT_ID_FIELD, parentIdKey]] as const) {
    const target = key === null ? undefined : byKey.get(key);
    if (target !== undefined && target.type !== "STRING") unmatched.push(`${name} -> expected STRING, got ${target.type}. ${fix(target, typeLabel("STRING"))}`);
  }
  if (flat) {
    if (parentTitleKey === null) unmatched.push(`${PARENT_TITLE_FIELD} -> no Plaky field named '${PARENT_TITLE_FIELD}' for the flat subitem parent link`);
    if (parentIdKey === null) unmatched.push(`${PARENT_ID_FIELD} -> no Plaky field named '${PARENT_ID_FIELD}' for the flat subitem parent link`);
  }

  const rememberedGroup = keyHere(previous?.seedGroupId);
  const importableIds = new Set(importableColumns.map((c) => c.id));
  return {
    asanaBoardId: board.id,
    name: board.name,
    plakyBoardId: seeded.plakyBoardId,
    fieldMap,
    unmatched,
    warnings,
    skipColumns: [
      ...dropped(board).map((c) => c.id),
      ...Object.keys(SYNTHETIC_COLUMNS).filter((id) => !importableIds.has(id)),
      ...keptOut,
    ],
    seedItemIds: board.nested ? [] : [...seeded.seedItemIds],
    subitemsOf: board.parentBoardId,
    nested: board.nested,
    asanaIdKey,
    parentTitleKey,
    parentIdKey,
    seedGroupId: seeded.seedGroupId || (typeof rememberedGroup === "number" && Number.isInteger(rememberedGroup) ? rememberedGroup : null),
  };
}

export function pairBoards(manifest: Manifest, seeded: ReadonlyMap<string, SeededBoard>, previous: SyncConfig | null = null): LinkResult {
  const byBoard = new Map((previous?.boards ?? []).map((entry) => [entry.asanaBoardId, entry]));
  const result: LinkResult = { links: [], missing: [] };
  for (const board of manifest.boards) {
    const match = seeded.get(board.id) ?? (board.nested && board.parentBoardId !== null ? seeded.get(board.parentBoardId) : undefined);
    if (match === undefined) result.missing.push([board.id, board.name]);
    else result.links.push(matchFields(board, match, byBoard.get(board.id) ?? null));
  }
  return result;
}
