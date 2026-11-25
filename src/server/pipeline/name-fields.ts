import { isHeader } from "@/lib/people-entry";
import type { PeopleMap } from "./config";
import type { BoardExtract, ColumnValue, ExtractedColumn } from "./extract";
import { columnPlan, type ColumnPlan, type DiscoveredBoard, type Manifest } from "./manifest";
import { RESERVED_FIELD_NAMES } from "./names";
import { personRefs, titleKey } from "./transform/mapping";
import { shownName } from "./transform/people";

export const nameColumnId = (columnId: string): string => `${columnId}_name`;

const NAME_REASON = "the names of people Plaky cannot assign, kept as text: their Person cell stays empty";

function withNames(board: DiscoveredBoard, kept: (id: string) => boolean, onBoard: readonly string[]): DiscoveredBoard {
  const strip = (columns: readonly ColumnPlan[]): ColumnPlan[] => columns.filter((c) => !columns.some((p) => p.plakyType === "PERSON" && nameColumnId(p.id) === c.id));
  const own = strip(board.columns);
  const nested = strip(board.nestedColumns);
  const taken = new Set([...RESERVED_FIELD_NAMES, ...own.map((c) => c.fieldName), ...nested.map((c) => c.fieldName)].map(titleKey));
  const unique = (name: string): string => {
    let candidate = name;
    for (let n = 2; taken.has(titleKey(candidate)); n++) candidate = `${name} (${n})`;
    taken.add(titleKey(candidate));
    return candidate;
  };
  const add = (columns: readonly ColumnPlan[]): ColumnPlan[] =>
    columns.flatMap((c) =>
      c.plakyType === "PERSON" && (c.assigned ?? onBoard).some(kept)
        ? [c, columnPlan({ id: nameColumnId(c.id), title: `${c.title} (name)`, type: "text", fieldName: unique(`${c.fieldName} (name)`), plakyType: "STRING", reason: NAME_REASON })]
        : [c],
    );
  return { ...board, columns: add(own), nestedColumns: add(nested) };
}

function nestedNames(sub: DiscoveredBoard, parent: DiscoveredBoard | undefined): DiscoveredBoard {
  const parentColumns = [...(parent?.columns ?? []), ...(parent?.nestedColumns ?? [])];
  const own = sub.columns.filter((c) => !sub.columns.some((p) => p.plakyType === "PERSON" && nameColumnId(p.id) === c.id));
  const columns = own.flatMap((c) => {
    if (c.plakyType !== "PERSON") return [c];
    const field = parentColumns.find((p) => p.plakyType === "PERSON" && p.fieldName === c.fieldName);
    const names = field ? parentColumns.find((p) => p.id === nameColumnId(field.id)) : undefined;
    return names ? [c, { ...names, id: nameColumnId(c.id), title: `${c.title} (name)` }] : [c];
  });
  return { ...sub, columns };
}

export function withNameFields(manifest: Manifest, people: PeopleMap): Manifest {
  const kept = (id: string): boolean => Object.hasOwn(people, id) && isHeader(people[id]);
  const onBoard = (boardId: string): string[] => manifest.people.filter((p) => p.kind === "person" && p.boards.includes(boardId)).map((p) => p.id);
  const boards = manifest.boards.map((b) => (b.nested ? b : withNames(b, kept, onBoard(b.id))));
  return { ...manifest, boards: boards.map((b) => (b.nested ? nestedNames(b, boards.find((p) => p.id === b.parentBoardId)) : b)) };
}

export function withNameValues(extract: BoardExtract, fieldMap: Readonly<Record<string, string>>, people: PeopleMap): BoardExtract {
  const named = extract.board.columns.filter((c) => c.type === "people" && Object.hasOwn(fieldMap, nameColumnId(c.id)));
  if (!named.length) return extract;
  const kept = (id: string): boolean => Object.hasOwn(people, id) && isHeader(people[id]);
  const nameOf = (id: string): string => shownName(Object.hasOwn(extract.users, id) ? extract.users[id]?.name : null, id);
  const columns: ExtractedColumn[] = extract.board.columns.flatMap((c) =>
    named.includes(c) ? [c, { id: nameColumnId(c.id), title: `${c.title} (name)`, type: "text", settingsStr: "{}", settings: null }] : [c],
  );
  const items = extract.items.map((item) => {
    const values: Record<string, ColumnValue> = { ...item.columnValues };
    for (const c of named) {
      const cell = item.columnValues[c.id];
      if (cell === undefined) continue;
      const ids = [...new Set(personRefs(cell).filter(([kind, id]) => kind === "person" && kept(id)).map(([, id]) => id))];
      values[nameColumnId(c.id)] = { id: nameColumnId(c.id), type: "text", text: ids.map(nameOf).join(", "), value: null };
    }
    return { ...item, columnValues: values };
  });
  return { ...extract, board: { ...extract.board, columns }, items };
}

export function namesWithoutField(extract: BoardExtract, fieldMap: Readonly<Record<string, string>>, people: PeopleMap): string[] {
  const kept = (id: string): boolean => Object.hasOwn(people, id) && isHeader(people[id]);
  return extract.board.columns.flatMap((c) => {
    if (c.type !== "people" || !Object.hasOwn(fieldMap, c.id) || Object.hasOwn(fieldMap, nameColumnId(c.id))) return [];
    const held = extract.items.filter((item) => item.columnValues[c.id] && personRefs(item.columnValues[c.id]!).some(([kind, id]) => kind === "person" && kept(id))).length;
    return held ? [`${c.title}: ${held} item(s) name someone whose name is kept as text, and the board has no field '${c.title} (name)' for it: add a Text field of that name in Plaky (the + at the right end of the header row), then check the boards again`] : [];
  });
}

