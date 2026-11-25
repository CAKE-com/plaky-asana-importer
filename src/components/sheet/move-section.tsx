"use client";

import { readinessState } from "@/lib/readiness-state";
import { checklistText, isLabelColorInstruction } from "@/lib/checklist-copy";

import { ScheduleChanges } from "./schedule-changes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { tasksText } from "@/lib/counts";
import { commentFileShortfall, seedRowsLeft } from "@/lib/receipt-short";
import { emptyPlanRow, emptyReceiptRow } from "@/lib/empty-rows";
import { useTRPC } from "@/lib/trpc";
import { fullReadMinutes } from "@/lib/asana-budget";
import type { ManifestSummary, PlanSummary, ReceiptView } from "@/lib/reports";
import { AUTHORSHIP_NOTE, inactiveLine, isNothingOutside, outsideTheMove, receiptDownload, type OutsideTheMove } from "@/lib/outside";
import { sheetState, type SheetState, type StatusInput } from "@/lib/sheet-state";
import { Block, Cell, clock, Explain, Go, Grid, Mark, Note, Plain, plural, Problem, Progress, Quiet, Row, Section, Status, statusRefetchMs } from "./bits";
import { useSave } from "./use-save";
import { readAgainOn, runKey } from "./queries";
import { PeopleChoices } from "./boards-section";

const LONG_READ_MINUTES = 5;

export const heldSentence = (held: { until: number } | null): string =>
  held ? `Moving before ${clock(held.until)} reuses this read.` : "This read is no longer kept, so moving reads Asana again.";

export function MoveSection({ migrationId, linked, items, subtasks = 0, manifest = null, plan = null }: {
  migrationId: number; linked: boolean; items: number; subtasks?: number;
  manifest?: ManifestSummary | null; plan?: PlanSummary | null;
}) {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data), refetchOnWindowFocus: true, staleTime: 5_000 });
  const s = status.data;
  const state = sheetState({ linked, status: s, clock });
  if (state.view === "later") return <Section n={3} title="Move and review" state="later" summary="Link boards in step 2 to continue." />;
  if (state.view === "loading" || !s) return <Section n={3} title="Move and review" state="open"><Problem error={status.error} title="Could not read the run" />{status.isPending ? <Note>Reading…</Note> : null}</Section>;
  const { view } = state;
  return (
    <Section n={3} title="Move and review" state="open">
      <Problem error={status.error} title="Could not refresh the run, so this shows what was last read" />
      <ViewFocus view={view}>
        {view === "moving" ? <Moving migrationId={migrationId} status={s} elsewhere={state.moving.elsewhere} onStopped={() => status.refetch()} />
          : view === "paused" ? <Paused migrationId={migrationId} paused={state.paused} onCancelled={() => status.refetch()} />
            : view === "result" ? <Result migrationId={migrationId} status={s} outside={outsideTheMove(manifest, plan)} onStarted={() => status.refetch()} />
              : <Ready key={manifest?.generatedAt ?? ""} migrationId={migrationId} items={items} subtasks={subtasks} manifest={manifest} onStarted={() => status.refetch()} />}
      </ViewFocus>
    </Section>
  );
}

function ViewFocus({ view, children }: { view: string; children: React.ReactNode }) {
  const shown = useRef(view);
  const box = useCallback((el: HTMLDivElement | null) => {
    if (!el || shown.current === view) return;
    shown.current = view;
    el.focus();
  }, [view]);
  return <div ref={box} tabIndex={-1} className="flex flex-col gap-5 outline-none" data-testid="move-view">{children}</div>;
}

function Ready({ migrationId, items, subtasks, manifest, onStarted }: { migrationId: number; items: number; subtasks: number; manifest: ManifestSummary | null; onStarted: () => unknown }) {
  const trpc = useTRPC();
  const latest = useQuery({ ...trpc.plan.latest.queryOptions({ migrationId }), staleTime: 5_000 });
  const queryClient = useQueryClient();
  const plan = useMutation(trpc.plan.run.mutationOptions({ onSettled: () => void queryClient.invalidateQueries(trpc.plan.latest.queryFilter({ migrationId })) }));
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: onStarted }));
  const stored = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const paid = stored.data?.migration.options.paidAsana === true;
  const setPace = useMutation(trpc.plan.setOptions.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries(trpc.connection.get.queryFilter({ migrationId })) }));
  const readMinutes = fullReadMinutes(items, paid);
  const longRead = readMinutes > LONG_READ_MINUTES;
  const [peopleChanged, setPeopleChanged] = useState(false);
  const onPeopleChanged = useCallback(() => setPeopleChanged(true), []);
  const { mutate: runPlan } = plan;
  const summary = plan.data ?? latest.data?.summary ?? null;
  const held = plan.data ? plan.data.held : (latest.data?.held ?? null);
  if (!summary) {
    return (
      <>
        <p role="status" className="text-sm text-cake-muted">{plan.isPending || latest.isPending ? "Reading projects and boards…" : longRead ? "Review the plan or start the import." : "No plan yet."}</p>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={paid} disabled={setPace.isPending || plan.isPending}
            onChange={(e) => setPace.mutate({ migrationId, paidAsana: e.target.checked })}
          />
          <span>Asana uses a paid plan</span>
        </label>
        <Note>Tick it only if your Asana plan is paid: Asana is then read faster. If you are not sure, leave it empty.</Note>
        <Problem error={setPace.error} title="Could not save that" />
        <Problem error={[plan.error, latest.error]} title="Could not plan" />
        {!plan.isPending && !latest.isPending ? <div><Plain onClick={() => runPlan({ migrationId })}>Plan {plan.error || latest.data?.latestRun ? "again" : "now"}</Plain></div> : null}
        <div className="flex flex-wrap items-center gap-5 pt-2">
          <Go onClick={() => start.mutate({ migrationId, mode: "full" })} disabled={start.isPending || plan.isPending}>{start.isPending ? "Starting…" : `Move ${tasksText(items - subtasks, subtasks)}`}</Go>
        </div>
        <Problem error={start.error} title="Could not start" />
      </>
    );
  }
  const total = summary.boards.reduce((n, b) => ({ creates: n.creates + b.creates, updates: n.updates + b.updates }), { creates: 0, updates: 0 });
  const writes = (c: number, u: number): string => [c ? `create ${c}` : "", u ? `update ${u}` : ""].filter(Boolean).join(", ") || "No changes";
  return (
    <>
      <Grid head={["Board", "Changes"]} testId="plan">
        {summary.boards.filter((b) => !emptyPlanRow(b)).map((b) => <Row key={b.asanaBoardId}><Cell>{b.name}</Cell><Cell>{writes(b.creates, b.updates)}</Cell></Row>)}
        <Row><Cell><strong>Total</strong></Cell><Cell><strong>{writes(total.creates, total.updates)}</strong></Cell></Row>
      </Grid>
      {summary.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={f} /></div></div>)}
      <Note>
        Read from Asana at {clock(summary.at)}. {heldSentence(held)}{" "}
        
        <Quiet onClick={() => runPlan({ migrationId })} disabled={plan.isPending}>{plan.isPending ? "Planning…" : "Plan again"}</Quiet>
      </Note>
      <Problem error={[plan.error, latest.error]} title="Could not refresh the plan" />
      <Outside outside={outsideTheMove(manifest, summary)} />
      <PeopleChoices migrationId={migrationId} linked onChanged={onPeopleChanged} />
      {peopleChanged ? <Note>Assignment changed. Refresh the preview with Plan again.</Note> : null}
      <div className="flex flex-wrap items-center gap-5 pt-2">
        <Go onClick={() => start.mutate({ migrationId, mode: "full" })} disabled={start.isPending || plan.isPending}>{start.isPending ? "Starting…" : `Move ${tasksText(items - subtasks, subtasks)}`}</Go>
      </div>
      <Problem error={start.error} title="Could not start" />
    </>
  );
}

type RunStatus = { progress: { done: number; planned: number; at: number; from: { done: number; at: number } } | null; since: string | null; limited?: number | null | undefined; boards: { name: string; applied: boolean }[] };

function Moving({ migrationId, status, elsewhere, onStopped }: { migrationId: number; status: RunStatus; elsewhere: boolean; onStopped: () => unknown }) {
  const trpc = useTRPC();
  const stop = useMutation(trpc.run.stop.mutationOptions({ onSuccess: onStopped }));
  const done = status.progress?.done ?? 0;
  const planned = status.progress?.planned ?? 0;
  const tenth = planned ? Math.floor((done / planned) * 10) * 10 : 0;
  return (
    <>
      <span role="status" className="sr-only">{planned ? `Moving: ${tenth} % complete.` : "Moving: reading both sides."}</span>
      <p className="text-lg" data-testid="moving">
        {planned ? <><span className="tabular-nums">{done}</span> of {plural(planned, "change")} done.</> : "Reading both sides…"}
        {status.since ? <span className="text-cake-muted"> Changes since {clock(Date.parse(status.since))}.</span> : null}
      </p>
      <Progress done={done} planned={planned} />
      {status.limited ? <Note testId="asana-limited">Waiting at Asana’s per-minute limit until {clock(status.limited)}. The move continues by itself.</Note> : null}
      {elsewhere ? (
        <Note testId="elsewhere">Running in another app instance. Stop it there.</Note>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <Plain onClick={() => stop.mutate({ migrationId })} disabled={stop.isPending || stop.isSuccess}>{stop.isPending || stop.isSuccess ? "Stopping…" : "Stop safely"}</Plain>
          <Note>Keep the computer awake and the app running.</Note>
        </div>
      )}
      <Problem error={stop.error} title="Could not stop" />
    </>
  );
}

function Paused({ migrationId, paused, onCancelled }: { migrationId: number; paused: NonNullable<SheetState["paused"]>; onCancelled: () => unknown }) {
  const trpc = useTRPC();
  const cancel = useMutation(trpc.run.cancelResume.mutationOptions({ onSuccess: onCancelled }));
  return (
    <>
      <p role="status" className="text-lg" data-testid="paused">Paused: Asana rate limit.</p>
      {paused.armed && paused.resumeAt !== null ? (
        <p>
          Resumes at <strong>{clock(paused.resumeAt)}</strong>. Keep the app running.
        </p>
      ) : (
        <p data-testid="paused-keys">
          Enter keys under Connect to resume.
        </p>
      )}
      {paused.deletionsWait ? <Note testId="deletions-wait">Deletions wait for a manual import.</Note> : null}
      <div><Plain onClick={() => cancel.mutate({ migrationId })} disabled={cancel.isPending}>Cancel automatic resume</Plain></div>
      <Problem error={cancel.error} title="Could not cancel" />
    </>
  );
}

const COMMENT_CHANGES_NOTE = "Includes edited comments. Never clears or replaces what people changed in Plaky.";

function Result({ migrationId, status, outside, onStarted }: { migrationId: number; status: StatusInput; outside: OutsideTheMove; onStarted: () => unknown }) {
  const trpc = useTRPC();
  const schedule = status.schedule;
  const queryClient = useQueryClient();
  const run = runKey(status);
  const summary = useQuery(readAgainOn(trpc.verify.summary.queryOptions({ migrationId }), run, queryClient));
  const problems = useQuery(readAgainOn(trpc.run.problems.queryOptions({ migrationId }), run, queryClient));
  const readinessOptions = readAgainOn(trpc.provision.readiness.queryOptions({ migrationId }), run, queryClient);
  const readiness = useQuery({ ...readinessOptions, staleTime: 60_000 });
  const readinessKey = readinessOptions.queryKey;
  const tick = useMutation(trpc.provision.tick.mutationOptions({
    onMutate: async (ticked) => {
      await queryClient.cancelQueries({ queryKey: readinessKey });
      const before = queryClient.getQueryData(readinessKey);
      queryClient.setQueryData(readinessKey, (list) => list?.map((i) => (i.key === ticked.key ? { ...i, done: ticked.done } : i)));
      return { before };
    },
    onError: (_error, _ticked, was) => { if (was?.before) queryClient.setQueryData(readinessKey, was.before); },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: readinessKey }),
  }));
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: onStarted }));
  const verify = useMutation(trpc.verify.run.mutationOptions({ onSuccess: async () => { await Promise.all([summary.refetch(), readiness.refetch()]); } }));
  const download = useSave();
  const [printError, setPrintError] = useState<Error | null>(null);
  const v = summary.data;
  if (!v) return <><Note>{summary.isPending ? "Reading the check…" : "The check could not be read."}</Note><Problem error={summary.error} title="Could not read the check" /></>;
  const checkedSince = v.receiptRunId !== null && problems.data?.runId != null && v.receiptRunId > problems.data.runId;
  const byHand = checkedSince ? [] : problems.data?.byHand ?? [];
  const receipt = v.receipt;
  const state = sheetState({ linked: true, status, summary: v, problems: problems.data, readiness: readiness.data, clock }).result!;
  const { offers } = state;
  const goneBoards = (readiness.data ?? []).filter((i) => readinessState(i) === "gone");
  const goneIds = new Set(goneBoards.map((i) => i.board));
  const left = (readiness.data ?? []).filter((i) => (i.kind === "manual" || !i.done) && readinessState(i) !== "status-types" && readinessState(i) !== "gone" && !isLabelColorInstruction(i.text));
  const byBoard = new Map<string | null, typeof left>();
  for (const item of left) byBoard.set(item.board, [...(byBoard.get(item.board) ?? []), item]);
  const names = new Map(receipt?.boards.map((b) => [b.asana_board_id, b.name]) ?? []);
  const again = (): void => start.mutate({ migrationId, mode: "full" });
  const notMoved = (problems.data?.items ?? []).filter((p) => p.code !== "verify.done");
  const moveAgain = <Go onClick={again} disabled={start.isPending}>{start.isPending ? "Starting…" : "Move again"}</Go>;

  return (
    <>
      <p role="status" className="text-lg" data-testid="result">{state.headline}</p>
      <Problem error={summary.error} title="Could not refresh results" />
      {receipt && !state.receiptCurrent && v.receiptAt ? <Note>As checked at {clock(v.receiptAt)}, {state.undoneAfter ? "before a board was undone" : "after an earlier run"}:</Note> : null}
      {receipt ? (
        <Grid head={["Board", "In Asana", "In Plaky", ""]} align={["left", "right", "right", "left"]} testId="result-boards">
          {receipt.boards.filter((b) => !emptyReceiptRow(b)).map((b) => (
            <Row key={b.asana_board_id}>
              <Cell>{b.name}</Cell><Cell right>{b.asana_items}</Cell><Cell right>{b.plaky_items ?? b.matched}</Cell>
              <Cell>
                {goneIds.has(b.asana_board_id) ? <Status kind="flag"><strong>Gone from Plaky since this check</strong></Status>
                  : b.complete ? <Status kind="done">Match</Status>
                  : <Status kind="flag"><strong>{b.missing.length ? `${b.missing.length} not moved` : b.extra.length ? `${b.extra.length} extra in Plaky` : b.differing.length ? `${b.differing.length} differ` : b.unidentified?.length ? `${b.unidentified.length} without Asana ID` : "Review differences"}</strong></Status>}
              </Cell>
            </Row>
          ))}
        </Grid>
      ) : null}
      {offers.checkNow ? (
        <div className="flex flex-wrap items-center gap-5 print:hidden"><Plain onClick={() => verify.mutate({ migrationId })} disabled={verify.isPending}>{verify.isPending ? "Checking every board…" : "Check now"}</Plain></div>
      ) : null}
      <Problem error={verify.error} title="Could not check" />
      {receipt ? <Differences receipt={receipt} /> : null}
      <Outside outside={outside} />

      {byHand.length ? (
        <Block title="Manual changes" testId="by-hand">
          <Note>Apply these changes in Plaky, then Check now.</Note>
          <ul className="flex flex-col gap-1">
            {byHand.map((p) => <li key={p.id}>{p.board ? <strong>{p.board}: </strong> : null}{p.message}</li>)}
          </ul>
        </Block>
      ) : null}

      {notMoved.length ? (
        <Block title={notMoved.length === 1 ? "1 import issue" : `${notMoved.length}${problems.data?.truncated ? "+" : ""} import issues`} testId="not-moved">
          <ul className="flex flex-col gap-3">
            {notMoved.map((p) => (
              <li key={p.id} className="flex flex-col gap-1">
                <span className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{p.board ? <strong>{p.board}: </strong> : null}<Explain text={p.message} /></span></span>
                <span className="ml-6 flex flex-wrap gap-4 text-[15px] print:hidden">
                  {p.asanaItemUrl ? <a href={p.asanaItemUrl} target="_blank" rel="noreferrer">Open in Asana</a> : null}
                  {p.boardUrl ? <a href={p.boardUrl} target="_blank" rel="noreferrer">Open the board in Plaky</a> : null}
                </span>
              </li>
            ))}
          </ul>
          {offers.sendAgain ? (
            <div className="flex flex-wrap items-center gap-5 print:hidden">
              <Go onClick={again} disabled={start.isPending}>{start.isPending ? "Starting…" : "Retry import"}</Go>
            </div>
          ) : offers.moveAgain ? <div className="flex flex-wrap items-center gap-5 print:hidden">{moveAgain}</div> : null}
        </Block>
      ) : offers.moveAgain ? (
        <div className="flex flex-wrap items-center gap-5 print:hidden" data-testid="move-again">{moveAgain}</div>
      ) : null}
      <Problem error={problems.error} title="Could not read what was not moved" />
      <Problem error={start.error} title="Could not start" />

      <Block title="Import recent changes" className="print:hidden">
        <p>Before switching: import changes, then Check now. {COMMENT_CHANGES_NOTE}</p>
        <div className="flex flex-wrap items-center gap-5">
          <Plain onClick={() => start.mutate({ migrationId, mode: "changes" })} disabled={start.isPending || !offers.bringChanges.enabled}>Import changes</Plain>
          <Note>{offers.bringChanges.note}</Note>
        </div>
        {offers.schedule === "waiting-for-step" ? <Note testId="schedule-waiting">Schedule paused until an import completes.</Note> : null}
        {offers.schedule !== "none" ? <ScheduleChanges migrationId={migrationId} schedule={schedule} onChange={onStarted} /> : null}
      </Block>

      {goneBoards.length ? (
        <Block title={goneBoards.length === 1 ? "A board is gone from Plaky" : `${goneBoards.length} boards are gone from Plaky`} testId="gone-boards">
          <ul className="flex flex-col gap-1">{goneBoards.map((i) => <li key={i.key} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{i.board !== null && names.get(i.board) ? <strong>{names.get(i.board)}: </strong> : null}<Explain text={i.text} /></span></li>)}</ul>
          <Note>Select “Set up a deleted board again” in step 2.</Note>
        </Block>
      ) : null}
      {left.length ? (
        <Block title="Manual setup" testId="left-for-you">
          <Note>Complete these steps in Plaky, then check again.</Note>
          {[...byBoard].map(([board, list]) => (
            <div key={board ?? "workspace"} className="flex flex-col">
              <h4 className="pt-1 text-[15px] font-semibold">{board === null ? "The workspace" : (names.get(board) ?? board)}</h4>
              <ul className="flex flex-col">
                {list.map((item) => (
                  <li key={item.key} className="flex min-h-10 items-center gap-2.5">
                    {item.kind === "manual" ? (
                      <label className="flex items-center gap-2.5">
                        <input type="checkbox" className="size-[18px] flex-none accent-cake-brand-500" checked={item.done} disabled={tick.isPending} onChange={(e) => tick.mutate({ migrationId, key: item.key, done: e.target.checked })} />
                        <span className={item.done ? "text-cake-muted line-through" : undefined}><Explain text={checklistText(item.text)} /></span>
                      </label>
                    ) : <Status kind={readinessState(item) === "gone" || readinessState(item) === "unread" ? "flag" : "now"}><span><Explain text={checklistText(item.text)} /></span></Status>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Block>
      ) : readiness.isSuccess ? <Note>Manual setup complete.</Note> : null}
      <Problem error={readiness.error} title="Could not read what is left to do in Plaky" />
      <Problem error={tick.error} title="Could not save that tick" />

      <Block title="Report" className="print:hidden">
        <div className="flex flex-wrap items-center gap-5">
          <Plain onClick={() => { try { setPrintError(null); window.print(); } catch (e) { setPrintError(e instanceof Error ? e : new Error(String(e))); } }}>Print or save as PDF</Plain>
          {receipt ? <Quiet disabled={summary.dataUpdatedAt === 0} onClick={() => download.save(`receipt-${migrationId}.json`, () => `${JSON.stringify(receiptDownload(receipt, outside), null, 2)}\n`)}>Download the receipt (JSON)</Quiet> : null}
        </div>
        <Problem error={printError} title="Could not open printing" />
        <Problem error={download.error} title="Could not save the receipt" />
      </Block>
      <PrintedAt />
    </>
  );
}

function printClock(drawnAt: number) {
  let at = drawnAt;
  return {
    subscribe(changed: () => void): () => void {
      const onPrint = (): void => { at = Date.now(); flushSync(changed); };
      window.addEventListener("beforeprint", onPrint);
      return () => window.removeEventListener("beforeprint", onPrint);
    },
    get: (): number => at,
  };
}

function PrintedAt() {
  const [print] = useState(() => printClock(Date.now()));
  const at = useSyncExternalStore(print.subscribe, print.get, print.get);
  return <Note testId="printed" className="hidden border-t border-cake-line pt-4 print:block">Printed {clock(at, at, true)}. Nothing in Asana was changed.</Note>;
}

function Outside({ outside }: { outside: OutsideTheMove }) {
  if (isNothingOutside(outside)) return null;
  return (
    <Block title="Import limits" testId="outside">
      {outside.boards.length ? (
        <div><h4 className="text-[15px] font-semibold">Not imported</h4>
          <ul className="ml-5 list-disc">{outside.boards.map((b, i) => <li key={`${i}:${b.name}`}><strong>{b.name}</strong>: {b.reason}</li>)}</ul></div>
      ) : null}
      {outside.columns.length ? (
        <div><h4 className="text-[15px] font-semibold">Fields not imported</h4>
          <ul className="ml-5 list-disc">{outside.columns.map((c, i) => <li key={`${i}:${c.board}:${c.column}`}><strong>{c.board}</strong>: {c.column}: {c.reason}</li>)}</ul></div>
      ) : null}
      {outside.byChoice.length ? (
        <div><h4 className="text-[15px] font-semibold">Left out by choice</h4>
          <ul className="ml-5 list-disc" data-testid="by-choice">{outside.byChoice.map((c, i) => <li key={`${i}:${c.board}:${c.column}`}><strong>{c.board}</strong>: {c.column} (More tools → Column pairing)</li>)}</ul></div>
      ) : null}
      {outside.archivedGroups.length ? (
        <div><h4 className="text-[15px] font-semibold">Archived groups in Asana</h4>
          <Note>Asana’s API lists no items in an archived group, so they are not carried.</Note>
          <ul className="ml-5 list-disc">{outside.archivedGroups.map((g, i) => <li key={`${i}:${g.board}:${g.group}`}><strong>{g.board}</strong>: {g.group}</li>)}</ul></div>
      ) : null}
      {outside.inactiveItems.length ? (
        <div><h4 className="text-[15px] font-semibold">Archived and deleted items</h4>
          <ul className="ml-5 list-disc" data-testid="inactive-items">{outside.inactiveItems.map((i) => <li key={i.board}>{inactiveLine(i)}</li>)}</ul></div>
      ) : null}
      {outside.asText.length ? (
        <div><h4 className="text-[15px] font-semibold">Imported as text or static values</h4>
          <ul className="ml-5 list-disc" data-testid="as-text">{outside.asText.map((c, i) => <li key={`${i}:${c.board}:${c.text}`}><strong>{c.board}</strong>: {c.text}</li>)}</ul></div>
      ) : null}
      {outside.authorship ? (
        <div data-testid="authorship"><h4 className="text-[15px] font-semibold">Authors and dates</h4><p>{AUTHORSHIP_NOTE}</p></div>
      ) : null}
      {outside.warnings.length ? (
        <div><h4 className="text-[15px] font-semibold">To check</h4>
          <ul className="flex flex-col gap-1">{outside.warnings.map((w, i) => <li key={`${i}:${w}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="now" /></span><span><Explain text={w} /></span></li>)}</ul></div>
      ) : null}
    </Block>
  );
}

function Differences({ receipt }: { receipt: ReceiptView }) {
  const lines = receipt.boards.flatMap((b) => [
    ...(b.unidentified ?? []).map((text) => ({ board: b.name, kind: "no Asana ID", text })),
    ...b.differing.map((d) => ({ board: b.name, kind: "differs", text: d })),
    ...b.not_carried.map((d) => ({ board: b.name, kind: "value not carried", text: d })),
    ...b.uncarried.map((d) => ({ board: b.name, kind: "column not carried", text: d })),
    ...commentFileShortfall(b).map((text) => ({ board: b.name, kind: "comments or files", text })),
    ...(seedRowsLeft(b) ? [{ board: b.name, kind: "seed rows", text: seedRowsLeft(b)! }] : []),
    ...(b.coverage ?? []).filter((c) => c.shortfall > 0).map((c) => ({ board: b.name, kind: "field not filled", text: `'${c.name}' is filled on ${c.plaky_filled} of ${c.asana_filled} items` })),
  ]);
  const extra = receipt.boards.flatMap((b) => b.extra.map((text) => ({ board: b.name, text })));
  if (!lines.length && !extra.length && !receipt.failures.length && !receipt.unmatched_users.length) return null;
  return (
    <>
      {receipt.failures.length ? (
        <Block title={receipt.failures.length === 1 ? "1 board could not be checked" : `${receipt.failures.length} boards could not be checked`} testId="check-failures">
          <ul className="flex flex-col gap-1">{receipt.failures.map((f, i) => <li key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span><Explain text={`could not verify ${f}`} /></span></li>)}</ul>
        </Block>
      ) : null}
      {receipt.unmatched_users.length ? (
        <Block title={receipt.unmatched_users.length === 1 ? "1 person's assignments were not carried" : `${receipt.unmatched_users.length} people's assignments were not carried`} testId="unmatched-users">
          <ul className="flex flex-col gap-1">{receipt.unmatched_users.map((u, i) => <li key={`${i}:${u}`}>{u}</li>)}</ul>
        </Block>
      ) : null}
      {extra.length ? (
        <Block title={extra.length === 1 ? "1 item is in Plaky but not in Asana" : `${extra.length} items are in Plaky but not in Asana`} testId="extra">
          <Note>Source task deleted, archived or moved. Review before deleting.</Note>
          <ul className="flex flex-col gap-1">{extra.map((l, i) => <li key={`${i}:${l.text}`}><strong>{l.board}: </strong>{l.text}</li>)}</ul>
        </Block>
      ) : null}
      {lines.length ? <ValueDifferences lines={lines} /> : null}
    </>
  );
}

function ValueDifferences({ lines }: { lines: { board: string; kind: string; text: string }[] }) {
  return (
    <Block title={lines.length === 1 ? "1 value is not as in Asana" : `${lines.length} values are not as in Asana`} testId="differences">
      <ul className="flex flex-col gap-1">
        {lines.map((l, i) => <li key={`${i}:${l.text}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span><strong>{l.board}</strong> ({l.kind}): <Explain text={l.text} /></span></li>)}
      </ul>
    </Block>
  );
}
