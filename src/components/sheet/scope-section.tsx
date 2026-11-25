"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksText } from "@/lib/counts";
import { useTRPC } from "@/lib/trpc";
import { Block, Note, Problem } from "./bits";

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;


export function ScopeReportBlock({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const report = useQuery(trpc.discovery.scope.queryOptions({ migrationId }));
  if (report.error) return <Problem error={report.error} title="Could not work out the scope" />;
  const r = report.data;
  if (!r) return null;
  return (
    <Block title="Review your selection" testId="scope-report">
      <p>{plural(r.projects, "project")} · {tasksText(r.tasks, r.subtasks)} · {plural(r.customFields, "custom field")} · {plural(r.people.total, "person", "people")}</p>
      {r.groups.length < r.projects ? <Note>Import {plural(r.groups.length, "layout")}; duplicate for the other boards.</Note> : null}
      <ul className="ml-5 list-disc text-[15px]" data-testid="scope-notes">
        {r.notes.map((note) => <li key={note}>{note}</li>)}
        {r.people.unmatched ? <li>{plural(r.people.unmatched, "unmatched person", "unmatched people")}. Choose assignments below.</li> : null}
        {r.mayBeNotified ? <li>{plural(r.mayBeNotified, "person", "people")} will be notified of assignments.</li> : null}
        {r.archived.length ? <li>Archived in Asana: {r.archived.join(", ")}.</li> : null}
        {r.restricted.length ? <li>Set these boards to private in Plaky: {r.restricted.join(", ")}.</li> : null}
        {r.subtaskBoards.length ? <li data-testid="scope-subtasks">Separate subitem boards: {r.subtaskBoards.map((b) => `${b.parent} (${plural(b.tasks, "subtask")})`).join(", ")}.</li> : null}
        <li>Not imported: goals, portfolios, rules, forms, time tracking, likes or activity history.</li>
      </ul>
    </Block>
  );
}
