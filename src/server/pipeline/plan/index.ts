import type { PipelinePlaky } from "../load/guarded";
import { type BoardSync, type PeopleMap } from "../config";
import type { BoardExtract } from "../extract";
import { type BoardPlan, failureText } from "./writes";
import { loadDirectory } from "./existing";
import { planBoard } from "./board";
import { writtenView, type WrittenView } from "../written";

export * from "./writes";
export * from "./compare";
export * from "./existing";
export * from "./groups";
export * from "./board";

export type ParentTitles = (asanaBoardId: string, only?: readonly string[]) => ReadonlyMap<string, string> | undefined | Promise<ReadonlyMap<string, string> | undefined>;
type PlanBoardsOptions = {
  allowDuplicateImport?: boolean; isDelta?: boolean; parentTitles?: ParentTitles; rich?: boolean;
  syncPoint?: (asanaBoardId: string) => string | null | undefined;
  written?: ReadonlyMap<number, WrittenView>;
};

export async function planBoards(
  read: (board: BoardSync) => Promise<BoardExtract>,
  plaky: PipelinePlaky,
  config: { boards: readonly BoardSync[]; people: PeopleMap },
  options: PlanBoardsOptions = {},
): Promise<{ plans: BoardPlan[]; failures: string[] }> {
  const directory = await loadDirectory(plaky);
  const plans: BoardPlan[] = [];
  const failures: string[] = [];
  const names = new Map<string, ReadonlyMap<string, string>>();
  for (const board of config.boards) {
    try {
      const extract = await read(board);
      if (!options.isDelta && !extract.isDelta) names.set(extract.board.id, new Map(extract.items.map((item) => [item.id, item.name])));
      const only = extract.isDelta ? [...new Set(extract.items.flatMap((item) => (item.parentId ? [item.parentId] : [])))] : undefined;
      const parentTitles = board.subitemsOf ? (names.get(board.subitemsOf) ?? (await options.parentTitles?.(board.subitemsOf, only))) : undefined;
      plans.push(
        await planBoard(extract, plaky, board, {
          directory,
          peopleMap: config.people,
          ...(options.allowDuplicateImport === undefined ? {} : { allowDuplicateImport: options.allowDuplicateImport }),
          ...(options.isDelta === undefined ? {} : { isDelta: options.isDelta }),
          ...(options.rich ? { rich: true } : {}),
          ...(parentTitles === undefined ? {} : { parentTitles }),
          syncPoint: options.syncPoint?.(board.asanaBoardId) ?? null,
          ...(options.written === undefined ? {} : { written: options.written.get(board.plakyBoardId) ?? writtenView(new Map()) }),
        }),
      );
    } catch (error) {
      failures.push(`${board.name}: ${failureText(error)}`);
    }
  }
  return { plans, failures };
}
