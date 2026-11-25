import { PAGE_CAP, PlakyDecodeError } from "../../clients/plaky";
import type { PipelinePlaky } from "../load/guarded";
import { type Manifest } from "../manifest";
import { ASANA_ID_FIELD, isSeedMarker, markerBoardId } from "../names";
import { MAX_PLAKY_PAGE_SIZE } from "../plan";
import { asId, normalizeTitle, plakyFieldsFromBoard, titleKey } from "../transform/mapping";
import { sortedStrings } from "../transform/pyvalue";
import { LinkError, type SeededBoard } from "./types";

const seedRowGroup = (data: { group?: unknown }): number | null => asId(data.group);

export async function scanSpace(
  plaky: PipelinePlaky,
  space: number,
  wanted: ReadonlySet<string> | null = null,
  options: { skipRows?: ReadonlySet<number> } = {},
): Promise<{ found: Map<string, SeededBoard>; held: Map<number, Set<string>>; unmarked: Map<number, Unmarked> }> {
  const skipRows = options.skipRows ?? new Set<number>();
  const found = new Map<string, SeededBoard>();
  const held = new Map<number, Set<string>>();
  const unmarked = new Map<number, Unmarked>();
  for (const board of await plaky.collect((page) => plaky.listBoards(space, { page }))) {
    const boardId = board.id;
    const fields = plakyFieldsFromBoard(board);
    const idFields = fields.filter((f) => normalizeTitle(f.name) === normalizeTitle(ASANA_ID_FIELD));
    if (idFields.length > 1) {
      throw new LinkError(
        `Plaky board ${boardId} has multiple fields named '${ASANA_ID_FIELD}' after normalization. Rename or remove the duplicate before linking.`,
      );
    }
    const idKey = idFields[0]?.key;
    if (idKey === undefined || skipRows.has(boardId)) continue;

    const markers = new Set<string>();
    const looseMarkers = new Set<string>();
    let seedTitled = 0;
    const seeds: number[] = [];
    const seedGroups = new Set<number | null>();
    const asanaIds = held.get(boardId) ?? new Set<string>();
    held.set(boardId, asanaIds);
    for (let page = 1; ; page++) {
      if (page > PAGE_CAP) throw new PlakyDecodeError(`paging exceeded ${PAGE_CAP} pages`);
      const got = await plaky.listItems(space, boardId, { page, pageSize: MAX_PLAKY_PAGE_SIZE, subitemsBehaviour: "EXCLUDE" });
      for (const item of got.data) {
        const value = (item.fields ?? []).find((f) => f.key === idKey)?.value;
        if (isSeedMarker(value)) {
          markers.add(markerBoardId(String(value)));
          seeds.push(item.id);
          seedGroups.add(seedRowGroup(item));
        } else if (typeof value === "string" && value.trim()) {
          const loose = /^seed:((?:mytasks:)?\d+(?::level2)?)$/.exec(value.toLowerCase().replace(/\s+/g, ""));
          if (loose) looseMarkers.add(loose[1]!);
          else asanaIds.add(value.trim());
        }
        if (String(item.title ?? "").startsWith(SEED_TITLE_PREFIX)) seedTitled++;
      }
      if (!got.hasMore) break;
    }
    if (markers.size === 0) unmarked.set(boardId, { title: String(board.title ?? ""), seedTitled, looseMarkers: [...looseMarkers], rows: asanaIds.size });
    if (wanted !== null && ![...markers].some((m) => wanted.has(m))) continue;
    if (markers.size === 0) continue;

    if (markers.size > 1) {
      throw new LinkError(
        `Plaky board ${boardId} carries seed rows for ${markers.size} Asana boards (${sortedStrings(markers).join(", ")}). ` +
          "Each Asana board needs a Plaky board of its own, and a subitem board especially: its columns are not the parent board's. " +
          "Delete this board, import one CSV per board, and run link again.",
      );
    }
    const marker = [...markers][0]!;
    const earlier = found.get(marker);
    if (earlier !== undefined) {
      throw new LinkError(
        `Asana board ${marker} is seeded onto two Plaky boards (${earlier.plakyBoardId} and ${boardId}). Delete the wrong one and run link again.`,
      );
    }
    found.set(marker, {
      plakyBoardId: boardId,
      asanaBoardId: marker,
      fields,
      seedItemIds: seeds,
      seedGroupId: seedGroups.size === 1 ? [...seedGroups][0]! : null,
    });
  }
  return { found, held, unmarked };
}

export const SEED_TITLE_PREFIX = "__A2P_SEED__";

export type Unmarked = { title: string; seedTitled: number; looseMarkers: string[]; rows: number };

export function boardHints(manifest: Manifest, missing: readonly string[], unmarked: ReadonlyMap<number, Unmarked>, recorded: ReadonlySet<number>): { id: string; name: string; plakyBoardId: number; text: string }[] {
  const out: { id: string; name: string; plakyBoardId: number; text: string }[] = [];
  for (const id of missing) {
    const board = manifest.boards.find((b) => b.id === id);
    if (!board) continue;
    for (const [plakyBoardId, u] of unmarked) {
      if (recorded.has(plakyBoardId)) continue;
      if (u.looseMarkers.includes(id)) {
        out.push({ id, name: board.name, plakyBoardId, text: `Plaky board ${plakyBoardId} carries this board's seed marker in another spelling: set its Asana ID cell to exactly "seed:${id}", and do not import the file again` });
      } else if (u.seedTitled > 0 && u.looseMarkers.length === 0 && u.rows === 0 && titleKey(u.title) !== titleKey(board.name)) {
        out.push({ id, name: board.name, plakyBoardId, text: `Plaky board ${plakyBoardId} ("${u.title}") looks like a seed import whose Asana ID cell was edited or cleared: if it is this board's, set the cell of its "${SEED_TITLE_PREFIX} 1" row to "seed:${id}" instead of importing again` });
      } else if (u.rows > 0 && titleKey(u.title) === titleKey(board.name)) {
        out.push({ id, name: board.name, plakyBoardId, text: `Plaky board ${plakyBoardId} ("${u.title}") already holds ${u.rows} migrated row(s): this board may have been moved before. Do not import its file again; "Link existing boards" checks with Asana which board's items they are` });
      }
    }
  }
  return out;
}

export async function readBoard(plaky: PipelinePlaky, space: number, boardId: number, asanaBoardId: string): Promise<SeededBoard> {
  const board = await plaky.getBoard(space, boardId);
  return { plakyBoardId: boardId, asanaBoardId, fields: plakyFieldsFromBoard(board), seedItemIds: [], seedGroupId: null };
}
