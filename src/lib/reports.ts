import { z } from "zod";

const planBoardSummary = z.object({
  name: z.string(), asanaBoardId: z.string(), creates: z.number(), updates: z.number(), unchanged: z.number(), drifted: z.number(), orphans: z.number(),
  groupWrites: z.number(), comments: z.number(), files: z.number(), uncarried: z.array(z.string()), notCarriedValues: z.number(),
  archivedGroups: z.array(z.string()).optional(),
  skippedByChoice: z.array(z.string()).optional(),
});
export const planSummary = z.object({
  at: z.number(),
  boards: z.array(planBoardSummary),
  plannedWrites: z.number(),
  estimateMinutes: z.number(),
  failures: z.array(z.string()),
  asanaCalls: z.number().optional(),
});
export type PlanSummary = z.infer<typeof planSummary>;

export const planDetails = z.object({ boards: z.array(z.object({ name: z.string(), creates: z.array(z.string()), updates: z.array(z.string()), notCarried: z.array(z.string()) })) });

const receiptBoard = z.object({
  name: z.string(), asana_board_id: z.string(), plaky_board_id: z.number(), asana_items: z.number(), plaky_items: z.number(), matched: z.number(),
  missing: z.array(z.string()), extra: z.array(z.string()), unidentified: z.array(z.string()), seed_rows: z.number(),
  coverage: z.array(z.object({ name: z.string(), asana_filled: z.number(), plaky_filled: z.number(), shortfall: z.number() })),
  dropped: z.array(z.string()), notes: z.array(z.string()), differing: z.array(z.string()), not_carried: z.array(z.string()),
  comments_or_files_short: z.boolean(), uncarried: z.array(z.string()), complete: z.boolean(),
});
export const receiptSchema = z.object({
  ok: z.boolean(), asana_items: z.number(), matched: z.number(), boards: z.array(receiptBoard), failures: z.array(z.string()), unmatched_users: z.array(z.string()),
});
export type ReceiptView = z.infer<typeof receiptSchema>;

export const estimateMinutes = (writes: number): number => Math.ceil(writes / 190);

export const manifestSummary = z.object({
  generatedAt: z.string(),
  boards: z.array(z.object({
    id: z.string(), name: z.string(), items: z.number(), subitemsOf: z.string().nullable(), nested: z.boolean(), plakyBoardId: z.number().nullable(), fields: z.number(),
    carried: z.number(), notCarried: z.array(z.object({ title: z.string(), type: z.string(), reason: z.string() })), warnings: z.array(z.string()), byHand: z.array(z.string()),
    archivedItems: z.number().default(0), deletedItems: z.number().default(0),
    asText: z.array(z.string()).default([]),
  })),
  skipped: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
  people: z.number(),
});
export type ManifestSummary = z.infer<typeof manifestSummary>;
