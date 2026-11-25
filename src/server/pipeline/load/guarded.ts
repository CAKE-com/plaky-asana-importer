import { NotSentError, RateLimitedError, isNotSent, isPlakyGroupAlreadyDeleted, isPlakyNotFound, type PlakyClient, type PlakyGroup, type PlakyItem } from "../../clients/plaky";
import { asId } from "../transform/mapping";
import { FRESH_WRITE_MS, HELD_TRIES, textOf } from "./results";

type RowWriteMethod = "deleteItem" | "updateItemFields" | "updateItemField" | "moveItemToGroup" | "overrideSubscriptions" | "updateItemComment" | "updateItemGroup" | "deleteItemGroup" | "archiveItemGroup";

export type PipelinePlaky = Omit<PlakyClient, RowWriteMethod | "scoped" | "timed"> & {
  scoped(o: Parameters<PlakyClient["scoped"]>[0]): PipelinePlaky;
};

type RowAt = { space: number | string; board: number | string; row: number };

type GroupAt = { space: number | string; board: number | string; group: number };

type GroupBody = Parameters<PlakyClient["updateItemGroup"]>[3];

export type GroupDone = { done: "sent" } | { done: "left" } | { done: "gone" };

export type GroupDeleted = GroupDone | { done: "holds" } | { done: "slow" };

type Send = (request: () => Promise<unknown>) => Promise<unknown>;

type DeleteJudge = (fresh: PlakyItem, nested: readonly PlakyItem[]) => Promise<readonly string[]>;

export type Deleted = { done: "deleted"; fresh: PlakyItem } | { done: "kept"; why: readonly string[]; slow: boolean } | { done: "gone"; error: unknown };

const SLOW_CHECKS = "its checks took longer than 5 s three times, so it was not deleted";

type RowWrite = { move: number } | { fields: Record<string, unknown> } | { addSubscribers: readonly number[]; unlisted: () => void };

type RowRequest = { move: number } | { fields: Record<string, unknown> } | { userIds: number[]; teamIds: number[] };

export type RowStep = { write: (fresh: PlakyItem | null) => RowWrite | null; sent?: () => Promise<void> | void };

const direct: Send = (request) => request();

const full = (plaky: PipelinePlaky): PlakyClient => plaky as PlakyClient;

function heldAgain(error: unknown, tries: number): void {
  if (!isNotSent(error, "held")) throw error;
  if (tries >= HELD_TRIES) throw new RateLimitedError(textOf(error));
}

function windowFrom(client: PlakyClient, since: number, tries: number): number | null {
  const left = FRESH_WRITE_MS - (client.now() - since);
  if (left > 0) return since + FRESH_WRITE_MS;
  heldAgain(new NotSentError("held", `not sent: its judging reads took ${Math.round((FRESH_WRITE_MS - left) / 1000)} s, past the read it was judged on`), tries);
  return null;
}

async function rowGone(client: PlakyClient, at: RowAt): Promise<boolean> {
  try {
    await client.getItem(at.space, at.board, at.row);
    return false;
  } catch (error) {
    if (isPlakyNotFound(error)) return true;
    throw error;
  }
}

export async function deleteRow(plaky: PipelinePlaky, at: RowAt, judge: DeleteJudge, send: Send = direct): Promise<Deleted> {
  const client = full(plaky);
  let slow = 0;
  let held = 0;
  for (;;) {
    let fresh: PlakyItem;
    let since: number;
    try {
      ({ value: fresh, sentAt: since } = await client.timed((c) => c.getItem(at.space, at.board, at.row)));
    } catch (error) {
      if (isPlakyNotFound(error)) return { done: "gone", error };
      throw error;
    }
    let nested: PlakyItem[];
    let why: readonly string[];
    try {
      nested = await client.collect((page) => client.listSubitems(at.space, at.board, at.row, { page, pageSize: 1000 }));
      why = await judge(fresh, nested);
    } catch (error) {
      if (isPlakyNotFound(error) && (await rowGone(client, at))) return { done: "gone", error };
      throw error;
    }
    if (why.length) return { done: "kept", why, slow: false };
    const deadline = since + FRESH_WRITE_MS;
    if (client.now() >= deadline) {
      if (++slow >= HELD_TRIES) return { done: "kept", why: [SLOW_CHECKS], slow: true };
      continue;
    }
    try {
      await send(() => client.deleteItem(at.space, at.board, at.row, { subitemsBehaviour: nested.length ? "INCLUDE" : "EXCLUDE", deadline }));
      return { done: "deleted", fresh };
    } catch (error) {
      if (isPlakyNotFound(error)) return { done: "gone", error };
      heldAgain(error, ++held);
    }
  }
}

export async function writeRow(plaky: PipelinePlaky, at: RowAt, steps: readonly RowStep[], o: { judged: boolean; send?: Send }): Promise<void> {
  const client = full(plaky);
  const send = o.send ?? direct;
  let since = client.now();
  const readRow = async (): Promise<PlakyItem> => {
    const row = await client.timed((c) => c.getItem(at.space, at.board, at.row));
    since = row.sentAt;
    return row.value;
  };
  const read = async (): Promise<PlakyItem | null> => {
    if (!o.judged) return null;
    return readRow();
  };
  const request = (target: PlakyClient, write: RowRequest): Promise<unknown> =>
    "move" in write ? target.moveItemToGroup(at.space, at.board, at.row, write.move)
    : "fields" in write ? target.updateItemFields(at.space, at.board, at.row, write.fields)
    : target.overrideSubscriptions(at.space, at.board, at.row, { userIds: write.userIds, teamIds: write.teamIds });
  const followers = async (fresh: PlakyItem | null, asked: Extract<RowWrite, { addSubscribers: unknown }>): Promise<RowRequest | null> => {
    const row = fresh ?? (await readRow());
    if (!Array.isArray(row.subscribedUsers) || !Array.isArray(row.subscribedTeams)) {
      asked.unlisted();
      return null;
    }
    const users = row.subscribedUsers;
    const userIds = [...new Set([...users, ...asked.addSubscribers])];
    return userIds.length === new Set(users).size ? null : { userIds, teamIds: [...row.subscribedTeams] };
  };
  let fresh = await read();
  let stale = false;
  for (const step of steps) {
    for (let tries = 1; ; tries++) {
      if (stale || tries > 1) fresh = await read();
      stale = false;
      const asked = step.write(fresh);
      const adds = asked !== null && "addSubscribers" in asked;
      const write = asked === null ? null : "addSubscribers" in asked ? await followers(fresh, asked) : asked;
      if (write === null) break;
      const deadline = o.judged || adds ? windowFrom(client, since, tries) : undefined;
      if (deadline === null) continue;
      try {
        await send(() => request(deadline === undefined ? client : client.scoped({ deadline }), write));
      } catch (error) {
        heldAgain(error, tries);
        continue;
      }
      stale = true;
      await step.sent?.();
      break;
    }
  }
}

export async function writeComment(
  plaky: PipelinePlaky, at: RowAt & { comment: number }, text: string, expected: string, send: Send = direct,
): Promise<boolean> {
  const client = full(plaky);
  for (let tries = 1; ; tries++) {
    const listed = await client.timed((c) => c.listItemComments(at.space, at.board, at.row));
    const now = listed.value.flatMap((c) => [c, ...(c.replies ?? [])]).find((c) => c.id === at.comment);
    if (now === undefined || String(now.content ?? "") !== expected) return false;
    const deadline = windowFrom(client, listed.sentAt, tries);
    if (deadline === null) continue;
    try {
      await send(() => client.scoped({ deadline }).updateItemComment(at.space, at.board, at.row, at.comment, text));
      return true;
    } catch (error) {
      heldAgain(error, tries);
    }
  }
}

async function onGroup(
  plaky: PipelinePlaky, at: GroupAt, request: (fresh: PlakyGroup | null) => ((target: PlakyClient) => Promise<unknown>) | null, o: { judged: boolean; send?: Send | undefined },
): Promise<GroupDone> {
  const client = full(plaky);
  const send = o.send ?? direct;
  for (let tries = 1; ; tries++) {
    let fresh: PlakyGroup | null = null;
    let deadline: number | null | undefined;
    if (o.judged) {
      const read = await client.timed(async (c) => (await c.allItemGroups(at.space, at.board)).find((g) => Number(g.id) === at.group));
      if (read.value === undefined) return { done: "gone" };
      fresh = read.value;
      deadline = windowFrom(client, read.sentAt, tries);
    }
    const go = request(fresh);
    if (go === null) return { done: "left" };
    if (deadline === null) continue;
    try {
      await send(() => go(deadline === undefined ? client : client.scoped({ deadline })));
      return { done: "sent" };
    } catch (error) {
      if (isPlakyNotFound(error)) return { done: "gone" };
      heldAgain(error, tries);
    }
  }
}

export function writeGroup(
  plaky: PipelinePlaky, at: GroupAt, body: (fresh: PlakyGroup | null) => GroupBody | null, o: { judged: boolean; send?: Send },
): Promise<GroupDone> {
  return onGroup(plaky, at, (fresh) => {
    const b = body(fresh);
    return b === null ? null : (target) => target.updateItemGroup(at.space, at.board, at.group, b);
  }, o);
}

export async function deleteGroup(plaky: PipelinePlaky, at: GroupAt, keep: (fresh: PlakyGroup) => boolean, send: Send = direct): Promise<GroupDeleted> {
  const client = full(plaky);
  let slow = 0;
  let held = 0;
  for (;;) {
    const read = await client.timed(async (c) => ({ groups: await c.allItemGroups(at.space, at.board), rows: await c.allItems(at.space, at.board, "INCLUDE") }));
    const fresh = read.value.groups.find((g) => Number(g.id) === at.group);
    if (fresh === undefined) return { done: "gone" };
    if (keep(fresh)) return { done: "left" };
    const listed = new Map(read.value.rows.map((row) => [Number(row.id), row]));
    const groupOf = (row: PlakyItem): number | null => {
      const own = asId(row.group);
      if (own !== null) return own;
      const parent = asId(row.parent);
      const above = parent === null ? undefined : listed.get(parent);
      return above === undefined ? null : asId(above.group);
    };
    if (read.value.rows.some((row) => [null, at.group].includes(groupOf(row)))) return { done: "holds" };
    const deadline = read.sentAt + FRESH_WRITE_MS;
    if (client.now() >= deadline) {
      if (++slow >= HELD_TRIES) return { done: "slow" };
      continue;
    }
    try {
      await send(() => client.scoped({ deadline }).deleteItemGroup(at.space, at.board, at.group));
      return { done: "sent" };
    } catch (error) {
      if (isPlakyNotFound(error) || isPlakyGroupAlreadyDeleted(error)) return { done: "gone" };
      heldAgain(error, ++held);
    }
  }
}
