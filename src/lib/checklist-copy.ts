export function isLabelColorInstruction(text: string): boolean {
  return /^\s*(?:[-*]\s+)?'.+' label colou?rs:/i.test(text);
}

export function checklistText(text: string): string {
  return text.replace(/^(\s*(?:[-*]\s+)?)Mark (.+) final in '(.+)'\.$/gm,
    (_, prefix: string, labels: string, field: string) => `${prefix}In '${field}' field settings, select Completed for ${labels}.`);
}

const tableCells = (row: string): string[] => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));

export function plainGuide(markdown: string): string {
  return markdown.split(/\r?\n/)
    .filter((line) => !/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
    .map((line) => (/^\s*\|.*\|\s*$/.test(line) ? tableCells(line).join(" · ") : line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "")))
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(\S(?:[^*]*?\S)?)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}
