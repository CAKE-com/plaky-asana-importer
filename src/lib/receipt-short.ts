type Board = { notes?: string[]; comments_or_files_short?: boolean; seed_rows?: number };

export function commentFileShortfall(b: Board): string[] {
  if (!b.comments_or_files_short) return [];
  const said = (b.notes ?? []).filter((n) => /^(comments|files): .*hold fewer/.test(n));
  return said.length ? said : ["comments or files are short in Plaky"];
}

export function seedRowsLeft(b: Board): string | null {
  const n = b.seed_rows ?? 0;
  return n > 0 ? `${n === 1 ? "1 example row from the import is" : `${n} example rows from the import are`} still in Plaky` : null;
}
