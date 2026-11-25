import type { BoardSync } from "./config";
import { PreconditionError } from "../errors";
import { checkField } from "./link";
import { importable, type DiscoveredBoard } from "./manifest";
import { PLAKY_TYPE_LABEL, compatibleTypes } from "./transform/compat";
import { buildFieldMap, type PlakyField } from "./transform/mapping";

export type PairingChoice = { kind: "field"; key: string } | { kind: "skip" } | { kind: "auto" };
export type PairingColumn = {
  id: string; title: string; type: string;
  state: "paired" | "skipped" | "unpaired";
  field: { key: string; name: string; type: string } | null;
  labels: string[]; labelMap: Record<string, string>;
};
export type PairingBoard = {
  asanaBoardId: string; name: string; plakyBoardId: number;
  columns: PairingColumn[];
  fields: { key: string; name: string; type: string; typeLabel: string; labels: string[] }[];
};

const typeLabel = (type: string): string => PLAKY_TYPE_LABEL[type] ?? type;
const ownFields = (sync: BoardSync): Set<string> => new Set([sync.asanaIdField, sync.parentTitleField, sync.parentIdField].filter((k): k is string => Boolean(k)));

const pairable = (board: DiscoveredBoard) => importable(board);

export function pairingOf(board: DiscoveredBoard, sync: BoardSync, fields: readonly PlakyField[]): PairingBoard {
  const own = ownFields(sync);
  const skipped = new Set(sync.skipColumns);
  const columns = pairable(board);
  const planned = buildFieldMap(
    columns.map((c) => ({ id: c.id, title: c.title, type: c.type, settingsStr: "{}", settings: c.type === "dropdown" && c.plakyType === "STATUS" ? { limit_select: true, label_limit_count: 1 } : null })),
    fields, { overrides: sync.fieldMap, skipColumns: skipped, reservedFieldKeys: own },
  );
  const targetOf = new Map(planned.pairs.map((pair) => [pair.column.id, pair.target]));
  return {
    asanaBoardId: sync.asanaBoardId, name: board.name, plakyBoardId: sync.plakyBoardId,
    columns: columns.map((c) => {
      const target = skipped.has(c.id) ? undefined : targetOf.get(c.id);
      return {
        id: c.id, title: c.title, type: c.type,
        state: skipped.has(c.id) ? "skipped" : target ? "paired" : "unpaired",
        field: target ? { key: target.key, name: target.name, type: target.type } : null,
        labels: [...c.labels], labelMap: { ...(sync.labelMap[c.id] ?? {}) },
      };
    }),
    fields: fields.filter((f) => !own.has(f.key)).map((f) => ({ key: f.key, name: f.name, type: f.type, typeLabel: typeLabel(f.type), labels: [...f.labels].filter(Boolean) })),
  };
}

export function changePairing(
  board: DiscoveredBoard, sync: BoardSync, fields: readonly PlakyField[],
  columnId: string, choice: PairingChoice, labels?: Readonly<Record<string, string>>,
): BoardSync {
  const column = pairable(board).find((c) => c.id === columnId);
  if (!column) throw new PreconditionError(`Asana board ${board.id} has no column ${columnId} that a Plaky field can hold`);
  const fieldMap: Record<string, string> = { ...sync.fieldMap };
  const skip = new Set(sync.skipColumns);
  const labelMap: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(sync.labelMap).map(([k, v]) => [k, { ...v }]));
  const renames = labels ? Object.fromEntries(Object.entries(labels).filter(([from, to]) => to && to !== from)) : (labelMap[columnId] ?? {});

  if (choice.kind === "field") {
    const target = fields.find((f) => f.key === choice.key);
    if (!target) throw new PreconditionError(`the Plaky board has no field ${choice.key}`);
    if (ownFields(sync).has(target.key)) throw new PreconditionError(`'${target.name}' is this app's own field (it holds the Asana ID or the parent link): pick another`);
    const holder = Object.entries(fieldMap).find(([other, key]) => other !== columnId && key === target.key && !skip.has(other));
    if (holder) {
      const title = pairable(board).find((c) => c.id === holder[0])?.title ?? holder[0];
      throw new PreconditionError(`'${target.name}' already receives ${title}: pair that column elsewhere, or skip it, first`);
    }
    const fits = [...new Set([...compatibleTypes(column.type), ...(column.plakyType ? [column.plakyType] : [])])];
    if (!fits.includes(target.type)) {
      throw new PreconditionError(`${column.title} -> '${target.name}': a ${typeLabel(target.type)} field cannot hold Asana ${column.type} values; pick a ${fits.map(typeLabel).join(" or ")} field`);
    }
    const written = [...new Set(column.labels.map((l) => renames[l] ?? l))];
    const [problem] = checkField(column.title, column.type, null, target, written);
    if (problem) throw new PreconditionError(problem);
    fieldMap[columnId] = target.key;
    skip.delete(columnId);
  } else if (choice.kind === "skip") {
    delete fieldMap[columnId];
    skip.add(columnId);
  } else {
    delete fieldMap[columnId];
    skip.delete(columnId);
  }
  if (labels) {
    if (Object.keys(renames).length) labelMap[columnId] = renames;
    else delete labelMap[columnId];
  }
  return { ...sync, fieldMap, skipColumns: [...skip], labelMap };
}
