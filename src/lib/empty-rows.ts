import { isLevelTwo } from "@/server/pipeline/names";

type PlanRow = { asanaBoardId: string; creates: number; updates: number; unchanged: number; drifted?: number; orphans?: number; groupWrites?: number; comments?: number; files?: number };
type ReceiptRow = { asana_board_id: string; asana_items: number; plaky_items?: number };

export const emptyPlanRow = (b: PlanRow): boolean =>
  isLevelTwo(b.asanaBoardId) && [b.creates, b.updates, b.unchanged, b.drifted ?? 0, b.orphans ?? 0, b.groupWrites ?? 0, b.comments ?? 0, b.files ?? 0].every((n) => n === 0);

export const emptyReceiptRow = (b: ReceiptRow): boolean => isLevelTwo(b.asana_board_id) && b.asana_items === 0 && (b.plaky_items ?? 0) === 0;
