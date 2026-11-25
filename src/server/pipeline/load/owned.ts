import type { PlakyComment } from "../../clients/plaky";
import type { PipelinePlaky } from "./guarded";
import { markerOf } from "../transform/comments";
import { blankIn } from "../plan/compare";

type Ids = number | string;

export type LinkCells = { asanaIdKey: string | null; parentFields: readonly { key: string; name: string }[]; hash: (key: string, value: unknown) => string | null };
export type LinkSeen = { asanaId: string } & ({ read: Readonly<Record<string, unknown>> } | { record: (key: string) => string | undefined });

export function linkCellsMoved(fields: readonly { key: string; value?: unknown }[] | null | undefined, seen: LinkSeen, cells: LinkCells): string[] {
  const now = new Map((fields ?? []).map((f) => [f.key, f.value ?? null]));
  const hashed = (key: string, value: unknown): string | null => (blankIn(value, undefined) ? null : cells.hash(key, value));
  const was = (key: string): string | null => ("read" in seen ? hashed(key, seen.read[key] ?? null) : (seen.record(key) ?? null));
  const why: string[] = [];
  const carried = cells.asanaIdKey ? String(now.get(cells.asanaIdKey) ?? "").trim() : seen.asanaId;
  if (carried !== seen.asanaId) why.push(`it carries Asana ID ${carried || "(none)"} now, not ${seen.asanaId}`);
  const moved = cells.parentFields.filter((f) => hashed(f.key, now.get(f.key) ?? null) !== was(f.key)).map((f) => `'${f.name}'`);
  if (moved.length) why.push(`${moved.join(", ")} changed in Plaky since ${"read" in seen ? "the plan read" : "the app wrote"} ${moved.length === 1 ? "it" : "them"}`);
  return why;
}

const everyComment = (comments: readonly PlakyComment[]): PlakyComment[] => comments.flatMap((c) => [c, ...everyComment(c.replies ?? [])]);

export async function madeInPlaky(
  plaky: PipelinePlaky, space: Ids, board: Ids,
  row: { id: number; commentCount?: number | null | undefined; fileCount?: number | null | undefined },
  ourFile: (plakyFileId: number) => boolean,
  ourComment: (asanaId: string, content: string) => boolean = () => true,
): Promise<string[]> {
  const why: string[] = [];
  if (row.commentCount !== 0) {
    let made = 0;
    let changed = 0;
    for (const c of everyComment(await plaky.listItemComments(space, board, row.id))) {
      if (c.deleted) continue;
      const content = String(c.content ?? "");
      const marker = markerOf(content);
      if (marker === null) made++;
      else if (!ourComment(marker[1], content)) changed++;
    }
    if (made) why.push(`${made} comment(s) made in Plaky`);
    if (changed) why.push(`${changed} comment(s) changed in Plaky`);
  }
  if (row.fileCount !== 0) {
    const files = await plaky.listItemFiles(space, board, row.id);
    const uploaded = files.filter((f) => !ourFile(Number(f.id))).length;
    const described = files.filter((f) => ourFile(Number(f.id)) && String(f.description ?? "").trim() !== "").length;
    if (uploaded) why.push(`${uploaded} file(s) uploaded in Plaky`);
    if (described) why.push(`${described} file(s) changed in Plaky`);
  }
  return why;
}
