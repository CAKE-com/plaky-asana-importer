import type { ManifestSummary, PlanSummary, ReceiptView } from "./reports";

export type OutsideTheMove = {
  boards: { name: string; reason: string }[];
  columns: { board: string; column: string; reason: string }[];
  warnings: string[];
  archivedGroups: { board: string; group: string }[];
  inactiveItems: { board: string; archived: number; deleted: number }[];
  asText: { board: string; text: string }[];
  byChoice: { board: string; column: string }[];
  authorship: boolean;
};

export const AUTHORSHIP_NOTE = "Records use the importing account and time. Original authors and dates remain in comment text or optional item fields.";

export const AUTOMATIONS_NOTE = "Rules and dashboards are not imported.";
export const PROJECT_PAGES_NOTE = "Briefs, status updates, views and time tracking are not imported. Save these separately.";
export const DELETED_NOTE = "Deleted tasks are excluded unless restored. Archived projects use an Archived group.";

const CARRIED_OTHERWISE = new Set(["name", "subtasks", "file"]);

const SKIPPED_BY_CONFIG = ": skipped by config";
export function skippedByChoice(skipped: readonly string[], notCarried: ReadonlySet<string>): string[] {
  return skipped.filter((s) => s.endsWith(SKIPPED_BY_CONFIG)).map((s) => s.slice(0, -SKIPPED_BY_CONFIG.length)).filter((s) => !notCarried.has(/\(([^()]*)\)$/.exec(s)?.[1] ?? ""));
}

export function outsideTheMove(manifest: ManifestSummary | null | undefined, plan: PlanSummary | null | undefined): OutsideTheMove {
  return {
    boards: (manifest?.skipped ?? []).map((s) => ({ name: s.name, reason: s.reason })),
    columns: (manifest?.boards ?? []).flatMap((b) => b.notCarried.filter((c) => !CARRIED_OTHERWISE.has(c.type)).map((c) => ({ board: b.name, column: `${c.title} (${c.type})`, reason: c.reason }))),
    warnings: manifest ? [...manifest.warnings, AUTOMATIONS_NOTE, PROJECT_PAGES_NOTE, DELETED_NOTE] : [],
    archivedGroups: (plan?.boards ?? []).flatMap((b) => (b.archivedGroups ?? []).map((group) => ({ board: b.name, group }))),
    inactiveItems: (manifest?.boards ?? []).map((b) => ({ board: b.name, archived: b.archivedItems, deleted: b.deletedItems })).filter((i) => i.archived || i.deleted),
    asText: (manifest?.boards ?? []).flatMap((b) => (b.asText ?? []).map((text) => ({ board: b.name, text }))),
    byChoice: (plan?.boards ?? []).flatMap((b) => (b.skippedByChoice ?? []).filter((column) => !column.includes("(__")).map((column) => ({ board: b.name, column }))),
    authorship: Boolean(manifest),
  };
}

export const isNothingOutside = (o: OutsideTheMove): boolean => !o.boards.length && !o.columns.length && !o.warnings.length && !o.archivedGroups.length && !o.inactiveItems.length && !o.asText.length && !o.byChoice.length && !o.authorship;

export const inactiveLine = (i: OutsideTheMove["inactiveItems"][number]): string =>
  `${i.board}: ${[i.archived ? `${i.archived} archived` : "", i.deleted ? `${i.deleted} deleted` : ""].filter(Boolean).join(" and ")} item(s) in Asana are not carried: Asana's API no longer answers for a deleted task, and Plaky has no archive. Restore a task in Asana to carry it.`;

export function outsideLines(o: OutsideTheMove): string[] {
  return [
    ...o.boards.map((b) => `${b.name}: ${b.reason}`),
    ...o.columns.map((c) => `${c.board}: column ${c.column}: ${c.reason}`),
    ...o.archivedGroups.map((g) => `${g.board}: group ${g.group} is archived in Asana; its items are not carried`),
    ...o.inactiveItems.map(inactiveLine),
    ...o.asText.map((c) => `${c.board}: column ${c.text}`),
    ...o.byChoice.map((c) => `${c.board}: column ${c.column} is not carried, by choice (More tools → Column pairing)`),
    ...o.warnings,
    ...(o.authorship ? [AUTHORSHIP_NOTE] : []),
  ];
}

export function receiptDownload(receipt: ReceiptView, o: OutsideTheMove): ReceiptView & { outside_the_move: Record<string, unknown> } {
  return { ...receipt, outside_the_move: { skipped_boards: o.boards, columns_not_carried: o.columns, archived_groups: o.archivedGroups, inactive_items: o.inactiveItems, carried_as_text: o.asText, skipped_by_choice: o.byChoice, warnings: o.warnings, ...(o.authorship ? { authorship: AUTHORSHIP_NOTE } : {}) } };
}
