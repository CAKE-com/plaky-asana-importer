import { Suspense } from "react";
import { PlanOptions } from "@/components/sheet/tools";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <PlanOptions params={params} />
    </Suspense>
  );
}
