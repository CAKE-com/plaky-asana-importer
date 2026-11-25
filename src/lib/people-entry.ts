export type PeopleEntry = Readonly<Record<string, unknown>>;
export type PeopleChoice = "user" | "unassigned" | "header" | "team" | "other";
export type PeopleTarget = number | "unassigned" | "header" | "team";

export type ParsedEntry = {
  choice: PeopleChoice;
  byHand: PeopleEntry | null;
  userId: number | null;
  skipped: boolean;
  header: boolean;
  standIn: unknown;
};

export const isByHand = (entry: PeopleEntry | null | undefined): boolean => entry != null && !Object.hasOwn(entry, "stand_in");

export const isSkipped = (entry: PeopleEntry | null | undefined): boolean => entry != null && entry.skip === true;

export const isHeader = (entry: PeopleEntry | null | undefined): boolean => entry != null && entry.header === true && !isSkipped(entry);

export function parse(entry: PeopleEntry | null | undefined): ParsedEntry {
  const byHand = isByHand(entry) ? entry! : null;
  const skipped = isSkipped(byHand);
  const header = isHeader(byHand);
  const userId = !skipped && !header && byHand && Object.hasOwn(byHand, "user_id") ? Number(byHand.user_id) : null;
  return {
    choice: skipped ? "unassigned" : header ? "header" : userId !== null ? "user" : byHand ? "other" : "team",
    byHand, userId, skipped, header,
    standIn: entry?.stand_in ?? null,
  };
}

export function label(choice: PeopleChoice, o: { placeholder?: string | null; mustExist?: boolean; other?: string | null } = {}): string {
  switch (choice) {
    case "unassigned": return "Leave their tasks unassigned";
    case "header": return "Unassigned, with their name kept as text";
    case "team": return o.mustExist ? `A stand-in team (make “${o.placeholder ?? "their stand-in team"}” in Plaky first)` : "A stand-in team with their name";
    case "other": return `As set in the config: ${o.other ?? ""}`;
    case "user": return "A Plaky user";
  }
}
