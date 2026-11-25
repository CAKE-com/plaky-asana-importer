import type { ExtractedUpdate } from "../extract";
import { fromIsoFormat, utcStamp } from "./isotime";
import { asciiDigits, isDecimalStr, pySplit, pyStrip } from "./pystr";
import { cmpCodePoints } from "./pyvalue";
import { sanitizeHtml, toHtml, toLines } from "./richtext";

export const MAX_COMMENTS_PER_ITEM = 2000;

const MARKER = /^\[asana (comment|reply) (\p{Nd}+)\]/u;

export type AsanaUpdate = ExtractedUpdate;

function updateKind(update: AsanaUpdate): "update" | "reply" {
  return update.parentId ? "reply" : "update";
}

export type PlannedComment = {
  kind: "update" | "reply";
  asanaId: string;
  text: string;
  replyTo: string | null;
};

export function commentHeader(comment: PlannedComment): string {
  return headerOf(comment.text);
}

export function stamp(value: string | null | undefined, seconds = false): string | null {
  if (!value) return null;
  const parsed = fromIsoFormat(value.replaceAll("Z", "+00:00"));
  if (!parsed) return value;
  const utc = utcStamp(parsed);
  return `${utc.slice(0, 10)} ${utc.slice(11, seconds ? 19 : 16)}`;
}

export function render(update: AsanaUpdate, filesCarried = false, rich = false): string {
  const created = stamp(update.createdAt);
  let header = `[asana ${updateKind(update) === "update" ? "comment" : "reply"} ${update.id}] ${update.author || "unknown"}`;
  if (created) header += `, ${created} UTC`;
  const edited = stamp(update.editedAt, true);
  if (edited && edited !== stamp(update.createdAt, true)) header += ` (edited ${edited} UTC)`;
  if (update.pinned) header += " (pinned)";
  if (update.editHash) header += ` (edited ${update.editHash})`;
  const lines = [header, "", pyStrip(update.text) || "(no text)"];
  const attachments = update.assets.length && !filesCarried ? `Attachments not carried: ${update.assets.map(([, name]) => name).join(", ")}` : null;
  if (attachments) lines.push("", attachments);
  const body = rich && update.body ? sanitizeHtml(update.body) : "";
  if (!body.replace(/<[^>]*>/g, "").replace(/\ufeff/g, "").trim()) return toHtml(lines.join("\n"));
  return [toHtml(header), "<p></p>", body, ...(attachments ? ["<p></p>", toHtml(attachments)] : [])].join("\n");
}

export function headerOf(content: string): string {
  const first = toLines(content || "").find((line) => pyStrip(line)) ?? "";
  return pySplit(first).join(" ");
}

export function markerOf(content: string): ["update" | "reply", string] | null {
  const match = MARKER.exec(headerOf(content));
  return match ? [match[1] === "comment" ? "update" : "reply", match[2]!] : null;
}

function byAge(a: AsanaUpdate, b: AsanaUpdate): number {
  const created = cmpCodePoints(a.createdAt || "", b.createdAt || "");
  if (created) return created;
  const [x, y] = [a, b].map((u) => (isDecimalStr(u.id) ? BigInt(asciiDigits(u.id)) : 0n)) as [bigint, bigint];
  return x < y ? -1 : x > y ? 1 : 0;
}

export function threads(updates: readonly AsanaUpdate[]): { top: AsanaUpdate[]; replies: Map<string, AsanaUpdate[]> } {
  const byId = new Map(updates.map((u) => [u.id, u]));
  const rootOf = (update: AsanaUpdate): AsanaUpdate => {
    const seen = new Set<string>([update.id]);
    let at = update;
    for (let up = at.parentId ? byId.get(at.parentId) : undefined; up; up = at.parentId ? byId.get(at.parentId) : undefined) {
      if (seen.has(up.id)) return update;
      seen.add(up.id);
      at = up;
    }
    return at;
  };
  const top: AsanaUpdate[] = [];
  const replies = new Map<string, AsanaUpdate[]>();
  for (const update of updates) {
    const root = rootOf(update);
    if (root === update) top.push(update);
    else replies.set(root.id, [...(replies.get(root.id) ?? []), update]);
  }
  return { top: top.sort(byAge), replies };
}

export const rethreaded = (update: AsanaUpdate, updates: readonly AsanaUpdate[]): boolean => {
  if (!update.parentId) return false;
  const parent = updates.find((u) => u.id === update.parentId);
  return parent === undefined || Boolean(parent.parentId);
};

export function planItemComments(updates: readonly AsanaUpdate[], filesCarried = false, rich = false): PlannedComment[] {
  const { top, replies } = threads(updates);
  const planned: PlannedComment[] = [];
  for (const update of top) {
    planned.push({ kind: "update", asanaId: update.id, text: render(update, filesCarried, rich), replyTo: null });
    for (const reply of [...(replies.get(update.id) ?? [])].sort(byAge)) {
      planned.push({ kind: "reply", asanaId: reply.id, text: render(reply, filesCarried, rich), replyTo: update.id });
    }
  }
  return planned;
}
