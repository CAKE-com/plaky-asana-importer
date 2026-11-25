import { readinessState } from "@/lib/readiness-state";
import { tasksText } from "@/lib/counts";
import { seedRowsLeft } from "@/lib/receipt-short";
import { isLevelTwo } from "@/server/pipeline/names";

export type RunLike = { id: number; kind: string; status: string; counts: Record<string, number> | null; startedAt: number; finishedAt: number | null };
export type StatusInput = {
  active: boolean;
  elsewhere?: boolean;
  run: RunLike | null;
  since: string | null;
  waiting: { reset: number; resumeAt: number; armed?: boolean } | null;
  schedule: { at: number; everyHours: number | null } | null;
  boards: { name: string; applied: boolean; inStep?: boolean }[];
  deletions?: boolean;
};
export type ReceiptLike = { ok: boolean; matched: number; asana_items: number; boards: { asana_board_id: string; name: string; complete: boolean; missing: string[]; extra: string[]; differing: string[]; asana_items?: number; not_carried?: string[]; uncarried?: string[]; coverage?: { shortfall: number }[]; unidentified?: string[]; notes?: string[]; comments_or_files_short?: boolean; seed_rows?: number }[]; failures: string[]; unmatched_users?: string[] };
export type SummaryInput = { receipt: ReceiptLike | null; receiptRunId: number | null; receiptAt: number | null; run: RunLike | null; changes: { full: string[] } | null; undoneAfter?: boolean; quietSince?: boolean };
export type ProblemsInput = { items: { code: string }[] };
export type ReadinessInput = { key: string; board: string | null }[];

export type SheetInput = {
  linked: boolean;
  status: StatusInput | undefined;
  summary?: SummaryInput | undefined;
  problems?: ProblemsInput | undefined;
  readiness?: ReadinessInput | undefined;
  clock: (ms: number) => string;
};

export type ScheduleOffer = "controls" | "waiting-for-step" | "none";
export type ResultState = {
  headline: string;
  receiptCurrent: boolean;
  undoneAfter: boolean;
  allGone: boolean;
  offers: {
    moveAgain: boolean;
    sendAgain: boolean;
    checkNow: boolean;
    bringChanges: { enabled: boolean; note: string };
    schedule: ScheduleOffer;
  };
};
export type CloseDecision =
  | { state: "hidden"; note: string | null; shortfall: null }
  | { state: "plain"; note: null; shortfall: null }
  | { state: "acknowledged"; note: null; shortfall: string };

type Paused = { deletionsWait: boolean } & (
  | { armed: true; resumeAt: number }
  | { armed: false; resumeAt: null }
);
export type SheetState =
  | { view: "later" | "loading" | "ready"; moving: null; paused: null; result: null; close: Extract<CloseDecision, { state: "hidden" }> }
  | { view: "moving"; moving: { elsewhere: boolean }; paused: null; result: null; close: Extract<CloseDecision, { state: "hidden" }> }
  | { view: "paused"; moving: null; paused: Paused; result: null; close: Extract<CloseDecision, { state: "hidden" }> }
  | { view: "result"; moving: null; paused: null; result: ResultState | null; close: CloseDecision };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const receiptSubtasks = (receipt: ReceiptLike): number => receipt.boards.filter((b) => isLevelTwo(b.asana_board_id)).reduce((n, b) => n + (b.asana_items ?? 0), 0);
const STOPPED_KINDS = new Set(["interrupted", "rate_limited", "plaky_rate_limited"]);
const RATE_LIMITED_KINDS = new Set(["rate_limited", "plaky_rate_limited"]);

export function sheetState(input: SheetInput): SheetState {
  const s = input.status;
  const hidden = (note: string | null): Extract<CloseDecision, { state: "hidden" }> => ({ state: "hidden", note, shortfall: null });
  if (!input.linked) return { view: "later", moving: null, paused: null, result: null, close: hidden(null) };
  if (!s) return { view: "loading", moving: null, paused: null, result: null, close: hidden(null) };
  const elsewhere = s.elsewhere === true;
  if (s.active) {
    return { view: "moving", moving: { elsewhere }, paused: null, result: null, close: hidden(elsewhere ? "Close opens once the move started by the other copy of this app has ended." : "Close opens once the move has ended and been checked.") };
  }
  if (s.waiting) {
    const armed = s.waiting.armed ?? true;
    return {
      view: "paused", moving: null, paused: { ...(armed ? { armed: true, resumeAt: s.waiting.resumeAt } : { armed: false, resumeAt: null }), deletionsWait: s.deletions === true }, result: null,
      close: hidden(armed ? "Close opens once the move has continued and been checked." : "Close opens once the keys are back under Connect and the move has continued and been checked."),
    };
  }
  if (!s.run) return { view: "ready", moving: null, paused: null, result: null, close: hidden(null) };
  const run = s.run;
  const v = input.summary;
  if (!v) return { view: "result", moving: null, paused: null, result: null, close: hidden("Close opens once the check has been read.") };

  const receipt = v.receipt;
  const undoneAfter = v.undoneAfter === true;
  const receiptCurrent = v.receiptRunId !== null && (v.receiptRunId >= run.id || v.quietSince === true) && !undoneAfter;
  const goneIds = new Set((input.readiness ?? []).filter((i) => readinessState(i) === "gone").map((i) => i.board));
  const allGone = Boolean(receipt?.boards.length) && receipt!.boards.every((b) => goneIds.has(b.asana_board_id));
  const notMoved = (input.problems?.items ?? []).filter((p) => p.code !== "verify.done").length;
  const at = (ms: number | null): string => (ms ? ` at ${input.clock(ms)}` : "");

  const sendAgain = notMoved > 0 && !RATE_LIMITED_KINDS.has(run.status);
  const again = sendAgain ? "Retry import" : "Move again";

  let headline: string;
  const writes = run.counts?.writes;
  if (run.status === "interrupted" && run.counts?.keyRefused) headline = `Plaky refused the key or this board’s access${writes === undefined ? "" : `, after ${plural(writes, "write")}`}. Enter the key again under Connect, then ${again}.`;
  else if (run.status === "interrupted") headline = `${writes === undefined ? "Stopped before it finished" : `Stopped after ${plural(writes, "write")}`}. Moving again continues where it stopped.`;
  else if (run.status === "plaky_rate_limited") headline = "Stopped by Plaky’s rate limit. Moving again continues where it stopped.";
  else if (run.status === "rate_limited") headline = "Stopped by Asana’s rate limit, and nothing is set to restart it. Move again in a minute.";
  else if (undoneAfter) headline = `A board was undone after this was checked. ${again} to rebuild it, then Check now.`;
  else if (receipt && receiptCurrent) {
    const subtasks = receiptSubtasks(receipt);
    const counted = subtasks ? `${receipt.matched} of ${receipt.asana_items} (${tasksText(receipt.asana_items - subtasks, subtasks)})` : `${receipt.matched} of ${tasksText(receipt.asana_items, 0)}`;
    headline = `${counted} moved and checked against Asana${at(v.receiptAt)}${receipt.ok ? "." : "; the check found a shortfall, listed below."}`;
  }
  else if (s.since && run.status === "failed") headline = `Bringing over the changes ended with problems${at(run.finishedAt)}: see what was not moved below.`;
  else if (s.since && writes === 0 && run.status === "succeeded" && receipt) headline = `Nothing new to bring over${at(run.finishedAt)}.`;
  else if (s.since) headline = `Changes brought over${at(run.finishedAt)}.${receipt && v.receiptAt ? ` Last checked at ${input.clock(v.receiptAt)}; the changes since are not checked yet.` : ""}`;
  else headline = run.status === "failed" ? "The run ended before everything was checked." : "Moved.";

  const inStep = s.boards.length > 0 && s.boards.every((b) => b.inStep === true);
  const settled = inStep && receipt?.ok === true && !undoneAfter;
  const moveAgain = notMoved > 0 ? RATE_LIMITED_KINDS.has(run.status) : STOPPED_KINDS.has(run.status) || undoneAfter || !settled;
  const checkNow = run.status !== "interrupted" && run.status !== "plaky_rate_limited";
  const changes = v.changes;
  const bringChanges = {
    enabled: Boolean(changes) && !allGone,
    note: !changes
      ? `Complete an import first: ${moveAgain || sendAgain ? again : "start the import"}.`
      : changes.full.length ? `Reads in full: ${changes.full.join(", ")}.` : run.finishedAt ? `Last run finished at ${input.clock(run.finishedAt)}.` : "",
  };
  const schedule: ScheduleOffer = s.schedule ? (changes ? "controls" : "waiting-for-step") : changes ? "controls" : "none";

  const newest = v.run;
  let close: SheetState["close"];
  const shortfallBefore = receipt?.ok === false && newest != null && (v.receiptRunId === null || v.receiptRunId < newest.id);
  if (newest?.status === "succeeded" && !undoneAfter && shortfallBefore) close = hidden("The last check found a shortfall; the changes imported since are not checked: Check now.");
  else if (newest?.status === "succeeded" && !undoneAfter) close = { state: "plain", note: null, shortfall: null };
  else if (newest?.status === "failed" && receipt && v.receiptRunId !== null && v.receiptRunId >= newest.id && !undoneAfter) {
    const short = receipt.boards.filter((b) => !b.complete).map((b) => {
      const gaps = (b.coverage ?? []).filter((c) => c.shortfall > 0).length;
      const kinds = [
        b.missing.length && `${plural(b.missing.length, "task")} not moved`,
        b.extra.length && `${plural(b.extra.length, "row")} extra in Plaky`,
        b.differing.length && `${plural(b.differing.length, "value")} differ`,
        b.not_carried?.length && `${plural(b.not_carried.length, "value")} not carried`,
        b.uncarried?.length && `${plural(b.uncarried.length, "column")} not carried`,
        gaps && `${plural(gaps, "field")} not filled on every item`,
        b.unidentified?.length && `${plural(b.unidentified.length, "row")} with no Asana ID`,
        b.comments_or_files_short && "comments or files short",
        seedRowsLeft(b),
      ].filter(Boolean);
      return `${b.name}: ${kinds.length ? kinds.join(", ") : "short"}`;
    });
    const unmatched = receipt.unmatched_users?.length ?? 0;
    const people = unmatched ? [`${unmatched === 1 ? "1 person" : `${unmatched} people`} not assigned in Plaky`] : [];
    const lines = [...short, ...people, ...receipt.failures.map((f) => f.slice(0, 200))];
    close = { state: "acknowledged", note: null, shortfall: lines.length ? lines.join("; ") : "the check found a shortfall" };
  } else if (undoneAfter) close = hidden(`A board was undone after the last check: ${again}, then Check now.`);
  else if (STOPPED_KINDS.has(run.status) || newest?.status === "interrupted") close = hidden(`The move stopped before it finished: ${again}, and let it finish and check.`);
  else if (newest?.status === "failed") close = hidden("The newest run failed and no check has finished since: Check now.");
  else close = hidden("Close opens once a move has finished and been checked.");

  return {
    view: "result", moving: null, paused: null,
    result: { headline, receiptCurrent, undoneAfter, allGone, offers: { moveAgain, sendAgain, checkNow, bringChanges, schedule } },
    close,
  };
}
