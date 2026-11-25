import { UNREADABLE_BOARD } from "../../clients/asana";
import { isPlakyNotFound } from "../../clients/plaky";
import type { PipelinePlaky } from "../load/guarded";
import { type Manifest } from "../manifest";
import { SEED_GROUP_TITLE } from "../plan";
import { boardTitles } from "../provision";
import { cmpCodePoints } from "../transform/pyvalue";
import { LinkError, type MaybePromise, type SeededBoard } from "./types";
import { scanSpace, type Unmarked, readBoard } from "./scan";


async function adoptDuplicates(
  plaky: PipelinePlaky, manifest: Manifest, space: number, found: Map<string, SeededBoard>, unmarked: ReadonlyMap<number, Unmarked>,
  recorded: ReadonlyMap<number, string>, byTitle: Set<string> | undefined,
): Promise<void> {
  const titles = boardTitles(manifest);
  const taken = new Set([...recorded.keys(), ...[...found.values()].map((f) => f.plakyBoardId)]);
  for (const board of manifest.boards) {
    if (board.nested || board.plakyBoardId !== null || found.has(board.id)) continue;
    const title = titles.get(board.id);
    const named = [...unmarked].filter(([id, u]) => u.rows === 0 && u.title.trim() === title && !taken.has(id));
    if (named.length !== 1) continue;
    const [plakyBoardId] = named[0]!;
    const groups = await plaky.allItemGroups(space, plakyBoardId);
    const seedGroup = groups.length === 1 && groups[0]!.title === SEED_GROUP_TITLE ? groups[0]!.id : null;
    found.set(board.id, { ...(await readBoard(plaky, space, plakyBoardId, board.id)), seedGroupId: seedGroup });
    taken.add(plakyBoardId);
    byTitle?.add(board.id);
  }
}

export type AsanaLookups = {
  itemIds?: (boardId: string) => MaybePromise<Iterable<string>>;
  itemBoards?: (ids: readonly string[]) => MaybePromise<ReadonlyMap<string, string>>;
};

export type ResolveOptions = AsanaLookups & {
  sweepSeeds?: boolean;
  preview?: boolean;
  gone?: Map<string, number>;
  unmarked?: Map<number, Unmarked>;
  byTitle?: Set<string>;
  homes?: Map<string, number[]>;
  knownHomes?: ReadonlyMap<string, readonly number[]>;
};

export type Stranded = { plakyBoardId: number; count: number; total: number; owner: string };

export async function resolveTargets(plaky: PipelinePlaky, manifest: Manifest, space: number, options: ResolveOptions = {}): Promise<Map<string, SeededBoard>> {
  const recorded = new Map<number, string>();
  const unrecorded: string[] = [];
  const own = manifest.boards.filter((b) => !b.nested);
  for (const b of own) {
    if (b.plakyBoardId === null) unrecorded.push(b.id);
    else recorded.set(b.plakyBoardId, b.id);
  }
  const { found, held, unmarked } = await scanSpace(plaky, space, new Set(own.map((b) => b.id)), {
    skipRows: options.preview || (unrecorded.length === 0 && !options.sweepSeeds) ? new Set(recorded.keys()) : new Set(),
  });
  for (const [id, u] of unmarked) options.unmarked?.set(id, u);
  const { homes, stranded } = options.itemIds === undefined && options.knownHomes
    ? { homes: new Map([...options.knownHomes].flatMap(([id, where]) => { const still = where.filter((plakyId) => held.has(plakyId)); return still.length ? [[id, still] as const] : []; })), stranded: new Map<string, Stranded[]>() }
    : await boardsHolding(held, unrecorded, options, { recorded });
  if (options.itemIds !== undefined && options.homes) {
    options.homes.clear();
    for (const [id, where] of homes) options.homes.set(id, [...where]);
  }
  for (const board of own) {
    if (board.plakyBoardId === null) {
      const strays = homes.has(board.id) ? [] : (stranded.get(board.id) ?? []);
      const stray = strays[0];
      if (stray !== undefined) {
        const whose = stray.owner === UNREADABLE_BOARD
          ? "most of whose rows are Asana tasks this token cannot read: the items were moved in Asana since, or the token lost access to them"
          : `which belongs to Asana board ${stray.owner} now: the items were moved in Asana since`;
        throw new LinkError(
          `'${board.name}' has ${stray.count} of its ${stray.total} items on Plaky board ${stray.plakyBoardId}, ` +
            `${whose}. Imported again, those ${stray.count} ` +
            `would be in Plaky twice. If board ${stray.plakyBoardId} is where '${board.name}' was migrated, bring back the pairing ` +
            "that run recorded (its sync config) and run link again; if not, delete " +
            `those rows from board ${stray.plakyBoardId} in Plaky and run link again.`,
        );
      }
      const seed = found.get(board.id);
      const where = (homes.get(board.id) ?? []).filter((id) => seed === undefined || id !== seed.plakyBoardId);
      if (seed !== undefined && where.length) {
        throw new LinkError(
          `'${board.name}' is already in Plaky on board ${where[0]}: most of its items are this board's items in Asana. ` +
            `The seed imported onto board ${seed.plakyBoardId} would migrate it a second time. Delete board ` +
            `${seed.plakyBoardId} in Plaky and run link again: it then updates board ${where[0]}.`,
        );
      }
      if (where.length > 1) {
        throw new LinkError(
          `'${board.name}' is in Plaky on ${where.length} boards (${where.join(", ")}), each holding its items. Keep one, delete ` +
            "the others in Plaky, and run link again.",
        );
      }
      if (where.length) found.set(board.id, await readBoard(plaky, space, where[0]!, board.id));
      continue;
    }
    const match = found.get(board.id);
    if (match !== undefined && match.plakyBoardId === board.plakyBoardId) continue;
    const recordedBoard = await readBoard(plaky, space, board.plakyBoardId, board.id).catch((error: unknown) => {
      if (isPlakyNotFound(error)) return null;
      throw error;
    });
    if (recordedBoard === null) {
      options.gone?.set(board.id, board.plakyBoardId);
      continue;
    }
    if (match === undefined) {
      found.set(board.id, recordedBoard);
    } else if (match.plakyBoardId !== board.plakyBoardId) {
      throw new LinkError(
        `'${board.name}' is already linked to Plaky board ${board.plakyBoardId}, but a new seed was imported onto board ` +
          `${match.plakyBoardId}. Delete the duplicate board and run link again.`,
      );
    }
  }
  await adoptDuplicates(plaky, manifest, space, found, unmarked, recorded, options.byTitle);
  for (const board of manifest.boards) {
    if (!board.nested) continue;
    const parent = board.parentBoardId === null ? undefined : found.get(board.parentBoardId);
    if (parent !== undefined) found.set(board.id, { ...parent, asanaBoardId: board.id, seedItemIds: [] });
    else if (board.plakyBoardId !== null && board.parentBoardId !== null && options.gone?.has(board.parentBoardId)) options.gone.set(board.id, board.plakyBoardId);
  }
  return found;
}

export async function boardsHolding(
  held: ReadonlyMap<number, ReadonlySet<string>>,
  boardIds: readonly string[],
  lookups: AsanaLookups,
  options: { recorded?: ReadonlyMap<number, string> } = {},
): Promise<{ homes: Map<string, number[]>; stranded: Map<string, Stranded[]> }> {
  const homes = new Map<string, number[]>();
  const stranded = new Map<string, Stranded[]>();
  const { itemIds, itemBoards } = lookups;
  if (itemIds === undefined || ![...held.values()].some((ids) => ids.size > 0)) return { homes, stranded };
  const mine = new Map<string, Set<string>>();
  for (const boardId of boardIds) mine.set(boardId, new Set(await itemIds(boardId)));
  const known = new Map<string, string>();
  for (const [boardId, items] of mine) for (const item of items) known.set(item, boardId);
  for (const [plakyId, ids] of [...held].sort((a, b) => a[0] - b[0])) {
    const shared = new Map([...mine].map(([boardId, items]) => [boardId, [...ids].filter((id) => items.has(id)).length]));
    if (![...shared.values()].some(Boolean)) continue;
    const owner = options.recorded?.get(plakyId);
    const counts = new Map<string, number>();
    const bump = (board: string): void => void counts.set(board, (counts.get(board) ?? 0) + 1);
    if (owner === undefined) {
      const unknown = [...ids].filter((id) => !known.has(id));
      if (unknown.length && itemBoards === undefined) throw new TypeError("boardsHolding needs itemBoards to weigh the other ids");
      for (const id of ids) {
        const board = known.get(id);
        if (board !== undefined) bump(board);
      }
      if (unknown.length && itemBoards !== undefined) for (const board of (await itemBoards(unknown)).values()) bump(board);
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    for (const [boardId, count] of shared) {
      if (!count) continue;
      const own = mine.get(boardId)!;
      if (owner === undefined && count * 2 > total) {
        homes.set(boardId, [...(homes.get(boardId) ?? []), plakyId]);
      } else if (count * 2 > own.size) {
        const others = [...counts.keys()].filter((b) => b !== boardId);
        const best = others.reduce<string | undefined>(
          (top, b) => (top === undefined || counts.get(b)! > counts.get(top)! || (counts.get(b) === counts.get(top) && cmpCodePoints(b, top) > 0) ? b : top),
          undefined,
        );
        const holder = owner ?? best;
        if (holder === undefined) continue;
        const theirs = holder === boardId || holder === UNREADABLE_BOARD ? new Set<string>() : (mine.get(holder) ?? new Set(await itemIds(holder)));
        const strays = [...ids].filter((id) => own.has(id) && !theirs.has(id)).length;
        if (strays * 2 > own.size) stranded.set(boardId, [...(stranded.get(boardId) ?? []), { plakyBoardId: plakyId, count: strays, total: own.size, owner: holder }]);
      }
    }
  }
  const claims = new Map<number, string[]>();
  for (const [boardId, ids] of homes) for (const id of ids) claims.set(id, [...(claims.get(id) ?? []), boardId]);
  for (const [plakyId, boards] of claims) {
    const alone = boards.filter((b) => homes.get(b)!.length === 1);
    if (boards.length < 2 || alone.length !== 1) continue;
    for (const b of boards) if (b !== alone[0]) homes.set(b, homes.get(b)!.filter((id) => id !== plakyId));
  }
  return { homes, stranded };
}
