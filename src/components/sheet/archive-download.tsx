"use client";

import { useIsMutating, useMutation } from "@tanstack/react-query";
import { Said } from "@/lib/explain";
import { buttonClass, Problem } from "./bits";

const REFUSAL = /^Archive not created:\s*/;

export function ArchiveDownload({ migrationId, disabled = false }: { migrationId: number; disabled?: boolean }) {
  const operating = useIsMutating({ predicate: (mutation) => (mutation.state.variables as { migrationId?: number } | undefined)?.migrationId === migrationId }) > 0;
  const build = useMutation({
    mutationFn: async ({ migrationId: id }: { migrationId: number }): Promise<void> => {
      const response = await fetch(`/api/migrations/${id}/archive`);
      if (!response.ok) throw new Said((await response.text()).replace(REFUSAL, "").trim() || "The archive could not be created.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `asana-archive-${id}.tar.gz`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  return <div className="flex flex-col gap-2 print:hidden">
    <div>
      <button type="button" disabled={disabled || operating} onClick={() => build.mutate({ migrationId })} className={buttonClass.primary}>{build.isPending ? "Preparing the archive…" : "Download task archive"}</button>
    </div>
    {build.isPending ? <p role="status" className="text-sm text-cake-muted">Reading every project from Asana. This can take several minutes; keep this page open.</p> : null}
    <Problem error={build.error} title="Could not create the archive" />
    <p className="text-sm">Open archive/index.html after extracting. Review missing files; external files remain links.</p>
  </div>;
}
