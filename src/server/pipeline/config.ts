export const TEAM_KEY = "team:";
export const FIELD_KEY = /^[a-z_]+-\d+$/;

export type PeopleForm = "user_id" | "email" | "team_id" | "team" | "skip" | "header" | "stand_in";
export type PeopleEntry = Partial<Record<PeopleForm, string | number | boolean>>;
export type PeopleMap = Record<string, PeopleEntry>;

export type BoardSync = {
  name: string;
  asanaBoardId: string;
  plakySpaceId: number;
  plakyBoardId: number;
  fieldMap: Record<string, string>;
  skipColumns: string[];
  labelMap: Record<string, Record<string, string>>;
  asanaIdField: string | null;
  subitemsOf: string | null;
  nested: boolean;
  parentTitleField: string | null;
  parentIdField: string | null;
  syncGroups: boolean;
  syncSubscribers: boolean;
  syncComments: boolean;
  syncFiles: boolean;
  seedGroupId: number | null;
  applied: boolean;
};

export type SyncConfig = { boards: BoardSync[]; people: PeopleMap };

export function checkConfig(boards: readonly BoardSync[], path = "config"): void {
  const seenSources = new Map<string, number>();
  boards.forEach((board, index) => {
    const previous = seenSources.get(board.asanaBoardId);
    if (previous === undefined) seenSources.set(board.asanaBoardId, index);
    else throw new Error(`${path}: boards[${index}].asana_board_id duplicates boards[${previous}] (${board.asanaBoardId})`);
  });
  const bySource = new Map(boards.map((b) => [b.asanaBoardId, b]));
  for (const board of boards) {
    const chain = new Set<string>();
    let cursor: BoardSync | undefined = board;
    while (cursor?.subitemsOf) {
      if (chain.has(cursor.asanaBoardId)) throw new Error(`${path}: subitems_of relationship for '${board.name}' contains a cycle`);
      chain.add(cursor.asanaBoardId);
      cursor = bySource.get(cursor.subitemsOf);
    }
  }
  for (const board of boards) {
    if (board.subitemsOf && !bySource.has(board.subitemsOf)) throw new Error(`${path}: '${board.name}' refers to missing parent Asana board '${board.subitemsOf}'`);
    if (board.nested) {
      const parent = bySource.get(board.subitemsOf ?? "");
      if (parent && (parent.plakySpaceId !== board.plakySpaceId || parent.plakyBoardId !== board.plakyBoardId)) {
        throw new Error(`${path}: '${board.name}' is nested but names Plaky space/board ${board.plakySpaceId}/${board.plakyBoardId}, not its parent's Plaky board ${parent.plakySpaceId}/${parent.plakyBoardId}`);
      }
    }
  }
  const seenTargets = new Map<string, BoardSync>();
  for (const board of boards) {
    const target = `${board.plakySpaceId}/${board.plakyBoardId}`;
    const first = seenTargets.get(target);
    if (!first) seenTargets.set(target, board);
    else if (!((board.nested && board.subitemsOf === first.asanaBoardId) || (first.nested && first.subitemsOf === board.asanaBoardId))) {
      throw new Error(`${path}: '${first.name}' and '${board.name}' both name Plaky space/board ${target}; each Asana board, and each subitem board, needs a Plaky board of its own`);
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export function boardsWritingDifferently(prev: SyncConfig, next: SyncConfig): string[] {
  const writes = (b: BoardSync): string => canonical({ ...b, name: null, seedGroupId: null, applied: null });
  if (canonical(prev.people) !== canonical(next.people)) return next.boards.map((b) => b.asanaBoardId);
  const before = new Map(prev.boards.map((b) => [b.asanaBoardId, writes(b)]));
  return next.boards.filter((b) => before.get(b.asanaBoardId) !== writes(b)).map((b) => b.asanaBoardId);
}
