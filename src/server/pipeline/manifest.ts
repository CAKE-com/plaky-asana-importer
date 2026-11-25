import { baseBoardId, isLevelTwo } from "./names";
import { ITEM_TITLE_HEADER, ASANA_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "./names";

export const TESTED_MAX_COLUMNS = 80;
export const TESTED_MAX_LABELS = 60;
export const SEED_ROW_LIMIT = 3000;
export const FREE_PLAN_FIELDS = 6;

export type ImportAs = "Assignee" | "Due Date" | "Dropdown";

export type ColumnPlan = {
  id: string;
  title: string;
  type: string;
  fieldName: string;
  plakyType: string | null;
  reason: string | null;
  labels: readonly string[];
  labelCollisions: readonly string[];
  importAs?: ImportAs;
  assigned?: readonly string[];
};

export function columnPlan(init: Pick<ColumnPlan, "id" | "title" | "type" | "fieldName" | "plakyType"> & Partial<ColumnPlan>): ColumnPlan {
  return { reason: null, labels: [], labelCollisions: [], ...init };
}

export type DiscoveredBoard = {
  id: string;
  name: string;
  itemsCount: number;
  columns: readonly ColumnPlan[];
  subitemBoardId: string | null;
  parentBoardId: string | null;
  plakyBoardId: number | null;
  hierarchyType: string;
  deepestLevel?: number;
  byHand: readonly string[];
  nested: boolean;
  nestedColumns: readonly ColumnPlan[];
  archivedItems: number;
  deletedItems: number;
  archived?: boolean;
};

export function discoveredBoard(init: Pick<DiscoveredBoard, "id" | "name"> & Partial<DiscoveredBoard>): DiscoveredBoard {
  return { itemsCount: 0, columns: [], subitemBoardId: null, parentBoardId: null, plakyBoardId: null, hierarchyType: "classic", byHand: [], nested: false, nestedColumns: [], archivedItems: 0, deletedItems: 0, ...init };
}

export type DiscoveredPerson = {
  id: string;
  kind: string;
  name: string;
  email: string | null;
  state: string;
  placeholder: string | null;
  members: readonly string[];
  boards: readonly string[];
};

export function discoveredPerson(init: Pick<DiscoveredPerson, "id" | "kind" | "name"> & Partial<DiscoveredPerson>): DiscoveredPerson {
  return { email: null, state: "active", placeholder: null, members: [], boards: [], ...init };
}

export type SkippedBoard = { id: string; name: string; kind: string; reason: string };

export type Manifest = {
  boards: readonly DiscoveredBoard[];
  skipped: readonly SkippedBoard[];
  generatedAt: string;
  people: readonly DiscoveredPerson[];
  notes?: readonly string[];
};

export function manifest(init: Partial<Manifest> = {}): Manifest {
  return { boards: [], skipped: [], generatedAt: "", people: [], ...init };
}

export const isSubitemBoard = (board: Pick<DiscoveredBoard, "parentBoardId">): boolean => board.parentBoardId !== null;
export const isSubtaskBoard = (board: Pick<DiscoveredBoard, "id" | "nested">): boolean => isLevelTwo(board.id) && !board.nested;
export const isImportable = (column: Pick<ColumnPlan, "plakyType" | "type">): boolean => column.type !== "file" && column.plakyType !== null;
export const importable = (board: Pick<DiscoveredBoard, "columns">): ColumnPlan[] => board.columns.filter(isImportable);
export const dropped = (board: Pick<DiscoveredBoard, "columns">): ColumnPlan[] => board.columns.filter((c) => !isImportable(c));
export const seededColumns = (board: Pick<DiscoveredBoard, "columns" | "nestedColumns">): ColumnPlan[] => [...importable(board), ...(board.nestedColumns ?? []).filter(isImportable)];

type SeedShape = Pick<DiscoveredBoard, "parentBoardId" | "columns"> & Partial<Pick<DiscoveredBoard, "nested" | "nestedColumns">>;

export function seedHeaders(board: SeedShape): string[] {
  const headers = [ITEM_TITLE_HEADER, ASANA_ID_FIELD];
  if (isSubitemBoard(board) && !board.nested) headers.push(PARENT_TITLE_FIELD, PARENT_ID_FIELD);
  return [...headers, ...seededColumns({ columns: board.columns, nestedColumns: board.nestedColumns ?? [] }).map((c) => c.fieldName)];
}

export const fieldCount = (board: SeedShape): number => seedHeaders(board).length - 1;

function freePlanWarning(board: SeedShape): string | null {
  const fields = fieldCount(board);
  return fields > FREE_PLAN_FIELDS ? `${fields} fields: Plaky's Free plan allows ${FREE_PLAN_FIELDS} per board, so this board needs Plaky Pro or Enterprise.` : null;
}

export const seedRowsNeeded = (board: Pick<DiscoveredBoard, "columns" | "nestedColumns">): number => Math.max(1, ...seededColumns(board).map((c) => c.labels.length));

export function boardWarnings(board: DiscoveredBoard, options: { planLimit?: boolean } = {}): string[] {
  if (isLevelTwo(board.id) && board.nested) return [];
  const planLimit = options.planLimit ?? true;
  const out: string[] = [];
  if (board.hierarchyType === "multi_level" && (board.deepestLevel ?? 1) > 2) {
    out.push(
      board.subitemBoardId !== null && isLevelTwo(board.subitemBoardId)
        ? "Plaky nests one level of subitems, and these subtasks are on a board of their own: each names its level 1 task in Parent Item, and one below level 2 its true parent in Parent task."
        : "Plaky nests one level of subitems, so subtasks below level 2 sit under their level 1 task, each naming its true parent in Parent task.",
    );
  }
  const columns = fieldCount(board);
  const seeded = seededColumns(board);
  const freePlan = freePlanWarning(board);
  if (planLimit && freePlan) out.push(freePlan);
  if (columns > TESTED_MAX_COLUMNS) {
    out.push(`${columns} fields: past the ${TESTED_MAX_COLUMNS} verified on this plan. Plaky caps fields per board by subscription, so check the board after import.`);
  }
  for (const column of seeded) {
    if (column.labelCollisions.length) {
      out.push(
        `'${column.fieldName}' has labels that collapse under matching normalization (${column.labelCollisions.join(", ")}); ` +
          "all exact spellings are seeded, but matching uses the exact spelling; rename the Asana labels to distinct names before using aliases or normalized matching.",
      );
    }
    if (column.labels.length > SEED_ROW_LIMIT) {
      out.push(
        `'${column.fieldName}' has ${column.labels.length} values, over the CSV import's ${SEED_ROW_LIMIT.toLocaleString("en-US")}-row limit. ` +
          "Its vocabulary cannot be seeded in one upload; split the file or create the field by hand.",
      );
    } else if (column.labels.length > TESTED_MAX_LABELS) {
      out.push(`'${column.fieldName}' has ${column.labels.length} values, past the ${TESTED_MAX_LABELS} verified. Expected to work; confirm after import.`);
    }
  }
  return out;
}

export const totalItems = (m: Pick<Manifest, "boards">): number => m.boards.reduce((sum, b) => sum + b.itemsCount, 0);

export function manifestWarnings(m: Pick<Manifest, "boards">): string[] {
  const out = m.boards.flatMap((board) => boardWarnings(board, { planLimit: false }).map((warning) => `${board.name}: ${warning}`));
  const crowded = m.boards.filter((b) => !(isLevelTwo(b.id) && b.nested) && fieldCount(b) > FREE_PLAN_FIELDS);
  if (crowded.length) {
    const named = crowded.map((b) => `${b.name} (${fieldCount(b)})`).join(", ");
    out.push(
      `${crowded.length} board(s) have more fields than the ${FREE_PLAN_FIELDS} per board that Plaky's Free plan allows, so they need Plaky Pro or Enterprise: ${named}`,
    );
  }
  return out;
}

export function keepPairings(fresh: Manifest, previous: Pick<Manifest, "boards">): { manifest: Manifest; kept: number; unread: DiscoveredBoard[] } {
  const paired = previous.boards.filter((b) => b.plakyBoardId !== null);
  const known = new Map(paired.map((b) => [b.id, b.plakyBoardId]));
  if (!known.size) return { manifest: fresh, kept: 0, unread: [] };
  const read = new Set(fresh.boards.map((b) => b.id));
  const unread = paired.filter((b) => !read.has(b.id));
  const boards = fresh.boards.map((b) => (known.has(b.id) ? { ...b, plakyBoardId: known.get(b.id) ?? null } : b));
  return { manifest: { ...fresh, boards: [...boards, ...unread] }, kept: known.size, unread };
}

export function keptShapes(previous: Pick<Manifest, "boards"> | null): Map<string, "nested" | "board"> {
  const out = new Map<string, "nested" | "board">();
  const boards = previous?.boards ?? [];
  const paired = new Set(boards.filter((b) => b.plakyBoardId !== null).map((b) => baseBoardId(b.id)));
  for (const board of boards) if (isLevelTwo(board.id) && paired.has(baseBoardId(board.id))) out.set(baseBoardId(board.id), board.nested ? "nested" : "board");
  return out;
}
