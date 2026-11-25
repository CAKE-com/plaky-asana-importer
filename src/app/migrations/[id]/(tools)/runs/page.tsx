import { Suspense } from "react";
import { RunHistory } from "@/components/sheet/tools";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <RunHistory params={params} />
    </Suspense>
  );
}
