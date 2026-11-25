export type SeedBoard = {
  id: string;
  name: string;
  title?: string;
  duplicateOf?: string | null;
  fileName: string | null;
  csv: string | null;
  checklist: readonly { field: string; typeLabel: string; reason: string | null }[];
  lossy?: readonly string[];
};

export const INSTRUCTIONS_FILE = "START HERE.txt";

export const IMPORT_STEPS: readonly string[] = [
  "Plaky: + → New Board → Create from file. Upload the file, then Proceed.",
  "Set the field types listed for that board.",
  "Finish import. Rename “New board” exactly as listed below.",
];

export const DUPLICATE_STEPS: readonly string[] = [
  "In the sidebar, open the imported board’s ⋮ menu → Duplicate.",
  "Enter the exact board name. Select Structure only → Duplicate board.",
];
export const DUPLICATE_FIRST = "Duplicate before importing items to avoid copying their groups.";

export const ONCE = "Import each file once.";
export const ANY_ORDER = "Any order.";
const STATUS_NOTE = "Use Status, not Tag or Dropdown.";
const ASSIGNEE_NOTE = "Use Assignee for My Tasks, not Person.";
const DUE_DATE_NOTE = "Use Due Date, not Date.";

function typeNote(label: string, rule: string | null): string | null {
  if (label === "Status") return STATUS_NOTE;
  if (label === "Assignee") return ASSIGNEE_NOTE;
  if (label === "Due Date") return DUE_DATE_NOTE;
  return (label === "Tag" || label === "Dropdown") && rule ? `${rule}.` : null;
}

const MASTER_FIELDS = new Set(["Assignee", "Status", "Due Date"]);
export const MASTER_NOTE = "one per board";
const SCROLL_NOTE = "scroll the menu";

export type TypeLine = {
  field: string;
  typeLabel: string | null;
  path: string;
  master: boolean;
  note: string | null;
};

export function typeLines(checklist: SeedBoard["checklist"]): TypeLine[] {
  return [
    { field: "Name", typeLabel: null, path: "leave as Item names (preselected)", master: false, note: null },
    ...checklist.map((c): TypeLine => {
      if (c.typeLabel === "Text") return { field: c.field, typeLabel: "Text", path: "leave as Text", master: false, note: null };
      const master = MASTER_FIELDS.has(c.typeLabel);
      return { field: c.field, typeLabel: c.typeLabel, path: `Create New Field → ${c.typeLabel}${c.typeLabel === "Link" ? ` (${SCROLL_NOTE})` : ""}`, master, note: typeNote(c.typeLabel, c.reason) };
    }),
  ];
}

export function instructionsText(boards: readonly SeedBoard[]): string {
  const withFile = boards.filter((b) => b.fileName && b.csv);
  const out = [
    "Set up these boards in Plaky",
    "",
    "Import these files to create boards.",
    "Fields and labels only; items import later.",
    "",
    "For each file:",
    ...IMPORT_STEPS.map((s, i) => `${i + 1}. ${s}`),
    "",
    ONCE,
    ANY_ORDER,
    "",
  ];
  withFile.forEach((b, i) => {
    out.push(`${i + 1}. ${b.name}`, `   File: ${b.fileName}`, `   Rename “New board” to: “${b.title ?? b.name}”`, "   Field types, top to bottom as the dialog lists them:");
    for (const l of typeLines(b.checklist)) {
      const notes = [l.master ? MASTER_NOTE : null, l.note].filter((n): n is string => n !== null);
      out.push(`     ${l.field} → ${l.path}${notes.length ? ` (${notes.join(". ")})` : ""}`);
    }
    out.push("");
  });
  const copies = boards.filter((b) => b.duplicateOf);
  if (copies.length) {
    out.push("Then, for the boards that share a layout:", ...DUPLICATE_STEPS.map((s, i) => `${i + 1}. ${s}`), "", DUPLICATE_FIRST, "");
    for (const b of copies) out.push(`- Duplicate “${b.duplicateOf}” as “${b.title ?? b.name}”`);
    out.push("");
  }
  return out.join("\r\n");
}
