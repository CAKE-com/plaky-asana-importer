"use client";

import { ArchiveDownload } from "./archive-download";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { closeConfirmation, namedConfirmation } from "@/lib/confirmation-state";
import { rememberClosed } from "@/lib/closed-notice";
import { useTRPC } from "@/lib/trpc";
import { Section, Block, Danger, fieldClass, Note, Problem } from "./bits";

export function CloseSection({ migrationId, name, newestRunId, shortfall = null }: { migrationId: number; name: string | null; newestRunId: number | null; shortfall?: string | null }) {
  const trpc = useTRPC();
  const [saved, setSaved] = useState(false);
  const [acknowledged, acknowledge] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const seen = shortfall !== null && acknowledged === shortfall;
  const close = useMutation(trpc.connection.close.mutationOptions({ onSuccess: (r) => { rememberClosed(r.keysDropped); window.location.replace("/"); } }));
  return (
    <div className="print:hidden"><Section n={4} title="Finish" state="open"><Block testId="close" className="border-0 pt-0">
      <ArchiveDownload migrationId={migrationId} disabled={close.isPending} />
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[15px]">
        <li>Revoke the Asana token at app.asana.com/0/my-apps.</li>
        <li>Remove the migration user from Plaky after the final import.</li>
      </ol>
      {shortfall !== null ? (
        <label className="flex items-start gap-2.5" data-testid="close-shortfall">
          <input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={seen} onChange={(e) => acknowledge(e.target.checked ? shortfall : null)} />
          <span>I accept these unresolved issues: {shortfall}</span>
        </label>
      ) : null}
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>The task archive, report and receipt are saved</span>
      </label>
      <Note id="close-warning">Permanently deletes this migration’s local data, and its keys unless another migration uses them. Boards remain. Future imports need a new migration.</Note>
      <label className="flex max-w-[520px] flex-col gap-1.5">
        <span>Type the migration’s name{name === null ? "" : <>, <strong>{name}</strong>,</>} to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} />
      </label>
      <div>
        <Danger aria-describedby="close-warning" onClick={() => close.mutate({ migrationId, confirm: typed, newestRunId })}
          disabled={closeConfirmation(saved, shortfall, acknowledged, close.isPending || close.isSuccess) !== "ready" || namedConfirmation(name, typed, close.isPending || close.isSuccess) !== "ready"}>
          {close.isPending ? "Closing…" : "Close this migration"}
        </Danger>
      </div>
      <Problem error={close.error} title="Could not close this migration" />
    </Block></Section></div>
  );
}
