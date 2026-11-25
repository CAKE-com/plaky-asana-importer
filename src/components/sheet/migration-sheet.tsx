"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";
import { setUpCounts } from "@/lib/counts";
import { sheetState } from "@/lib/sheet-state";
import { clock, Note, Plain, Problem, Sheet, useMigrationId } from "./bits";
import { BoardsSection } from "./boards-section";
import { ConnectClosed } from "./connect-section";
import { CloseSection } from "./close-section";
import { MoveSection } from "./move-section";
import { readAgainOn, runKey } from "./queries";

export const TOOLS: [slug: string, label: string][] = [
  ["runs", "Run history"], ["run", "Live log and undo one board"], ["verify", "Check again, exports"], ["plan", "Plan details and options"], ["link", "Column pairing"],
  ["erase", "Erase this migration’s data"],
];

export function MigrationSheet({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), staleTime: 5_000 });
  const manifest = useQuery({ ...trpc.discovery.manifest.queryOptions({ migrationId }), staleTime: 5_000 });
  const busy = Boolean(status.data?.active || status.data?.waiting);
  const latest = useQuery({ ...trpc.plan.latest.queryOptions({ migrationId }), staleTime: 5_000 });
  const readAt = manifest.dataUpdatedAt;
  const [seen, setSeen] = useState({ busy, readAt, reads: 0 });
  if (seen.busy !== busy || seen.readAt !== readAt) {
    const again = (seen.busy && !busy) || (seen.readAt !== readAt && seen.readAt !== 0);
    setSeen({ busy, readAt, reads: seen.reads + (again ? 1 : 0) });
  }
  const queryClient = useQueryClient();
  const runNow = runKey(status.data);
  const linked = (status.data?.boards.length ?? 0) > 0;
  const { tasks, subtasks } = setUpCounts(manifest.data?.manifest?.boards ?? [], linked);
  const items = tasks + subtasks;
  const summary = useQuery({ ...readAgainOn(trpc.verify.summary.queryOptions({ migrationId }), runNow, queryClient), enabled: linked && status.data?.run !== null && !busy, staleTime: 5_000 });
  const { close } = sheetState({ linked, status: status.data, summary: summary.data, clock });
  const connection = useQuery({ ...trpc.connection.get.queryOptions({ migrationId }), staleTime: 60_000 });
  const availableKeys = useQuery({ ...trpc.connection.env.queryOptions(), staleTime: 60_000 });
  const reconnect = connection.data && availableKeys.data && ((!connection.data.keysHeld.asana && !availableKeys.data.asanaToken) || (!connection.data.keysHeld.plaky && !availableKeys.data.plakyKey));
  if ((status.error?.data as { code?: string } | null | undefined)?.code === "NOT_FOUND" && /^There is no migration \d+/.test(status.error?.message ?? "")) notFound();
  return (
    <Sheet
      title={connection.data?.migration.name}
      step={reconnect ? 1 : close.state !== "hidden" ? 4 : linked ? 3 : 2}
      help={
        <>
          <details className="help-card"><summary>Connection activity</summary><div><AsanaCalls migrationId={migrationId} busy={busy} reads={seen.reads} /></div></details>
          <details className="help-card">
            <summary>More tools</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {TOOLS.map(([slug, label]) => <li key={slug}><Link prefetch={false} href={`/migrations/${migrationId}/${slug}`}>{label}</Link></li>)}
              <li><Link prefetch={false} href="/">All migrations</Link></li>
            </ul>
          </details>
        </>
      }
    >
      <ConnectClosed migrationId={migrationId} />
      <Problem error={status.error} title="Could not read this migration" />
      <Problem error={manifest.error} title="Could not read the boards" />
      {status.data === undefined ? (
        status.isError ? <div className="py-4"><Plain onClick={() => void status.refetch()} disabled={status.isFetching}>{status.isFetching ? "Reading…" : "Try again"}</Plain></div> : <Note className="py-8">Reading…</Note>
      ) : (
        <>
          <BoardsSection migrationId={migrationId} linked={linked} onLinked={() => { void status.refetch(); void manifest.refetch(); void queryClient.invalidateQueries(trpc.provision.readiness.queryFilter({ migrationId })); }} />
          <MoveSection migrationId={migrationId} linked={linked} items={items} subtasks={subtasks}
            manifest={manifest.data?.manifest ?? null} plan={latest.data?.summary ?? null} />
          {close.state !== "hidden" ? <CloseSection migrationId={migrationId} name={connection.data?.migration.name ?? null} newestRunId={summary.data?.run?.id ?? null} shortfall={close.shortfall} />
            : close.note && status.data.run ? <Note className="print:hidden" testId="close-note">{close.note}</Note> : null}
        </>
      )}
    </Sheet>
  );
}

function AsanaCalls({ migrationId, busy, reads }: { migrationId: number; busy: boolean; reads: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = trpc.plan.latest.queryOptions({ migrationId });
  const latest = useQuery({ ...(reads === 0 ? options : readAgainOn(options, reads, queryClient)), refetchInterval: busy ? 30_000 : false, refetchOnWindowFocus: true, staleTime: 5_000 });
  return <span data-testid="asana-calls">{latest.data ? `Asana calls today: ${latest.data.asanaCallsToday.toLocaleString("en")}.` : latest.error ? "Today’s Asana calls could not be read." : ""}</span>;
}
