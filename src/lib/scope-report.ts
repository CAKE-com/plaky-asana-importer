import { isSubtaskBoard, seededColumns, type DiscoveredBoard, type Manifest } from "@/server/pipeline/manifest";

const PLAKY_WRITES_PER_MINUTE = 190;
const WRITES_PER_TASK = 1.6;
const READS_PER_TASK = 2;
const FREE_PACE = 140;
const IMPORT_MINUTES = 8;
const DUPLICATE_MINUTES = 1;
const CLICKS_PER_DUPLICATE = 4;
const CLICKS_PER_IMPORT = 4;

const ONE_CALL = { projects: 5, tasks: 2_000 };
const OVERNIGHT_TASKS = 20_000;

export type ProjectGroup = { key: string; projects: { id: string; name: string }[]; fields: number };

export type ScopeReport = {
  projects: number;
  tasks: number;
  subtasks: number;
  customFields: number;
  groups: ProjectGroup[];
  archived: string[];
  restricted: string[];
  people: { total: number; matched: number; unmatched: number };
  handSteps: number;
  minutes: { setup: number; read: number; move: number };
  shape: "one call" | "two calls" | "two calls and overnight";
  mayBeNotified: number;
  subtaskBoards: { name: string; parent: string; tasks: number }[];
  notes: string[];
};

export function groupProjects(manifest: Pick<Manifest, "boards">): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const board of manifest.boards) {
    if (board.nested || isSubtaskBoard(board)) continue;
    const fields = seededColumns(board).map((c) => `${c.fieldName}\u0000${c.plakyType}\u0000${c.importAs ?? ""}`).sort();
    const key = fields.join("\u0001");
    const group = groups.get(key) ?? { key, projects: [], fields: fields.length };
    group.projects.push({ id: board.id, name: board.name });
    groups.set(key, group);
  }
  return [...groups.values()];
}

const typed = (board: DiscoveredBoard | undefined): number => (board ? seededColumns(board).filter((c) => c.plakyType !== "STRING").length : 0);
const typedColumns = (manifest: Pick<Manifest, "boards">, group: ProjectGroup): number => typed(manifest.boards.find((b) => b.id === group.projects[0]?.id));

export function scopeReport(manifest: Manifest, pace: number = FREE_PACE): ScopeReport {
  const projects = manifest.boards.filter((b) => !b.nested && !isSubtaskBoard(b));
  const subtaskBoards = manifest.boards.filter(isSubtaskBoard);
  const tasks = projects.reduce((n, b) => n + b.itemsCount, 0);
  const subtasks = manifest.boards.filter((b) => b.parentBoardId !== null).reduce((n, b) => n + b.itemsCount, 0);
  const groups = groupProjects(manifest);
  const customFields = new Set([...projects, ...subtaskBoards].flatMap((b) => b.columns.filter((c) => !c.id.startsWith("__")).map((c) => c.title))).size;
  const people = manifest.people.filter((p) => p.kind === "person");
  const matched = people.filter((p) => p.placeholder === null).length;
  const duplicates = projects.length - groups.length;
  return {
    projects: projects.length,
    tasks,
    subtasks,
    customFields,
    groups,
    archived: projects.filter((b) => b.archived).map((b) => b.name),
    restricted: projects.filter((b) => b.byHand.some((step) => step.startsWith("Restrict the board"))).map((b) => b.name),
    people: { total: people.length, matched, unmatched: people.length - matched },
    handSteps: groups.reduce((n, g) => n + CLICKS_PER_IMPORT + typedColumns(manifest, g), 0) + subtaskBoards.reduce((n, b) => n + CLICKS_PER_IMPORT + typed(b), 0) + duplicates * CLICKS_PER_DUPLICATE,
    minutes: {
      setup: Math.ceil((groups.length + subtaskBoards.length) * IMPORT_MINUTES + duplicates * DUPLICATE_MINUTES),
      read: Math.ceil((tasks * READS_PER_TASK + projects.length * 4) / pace),
      move: Math.ceil((tasks * WRITES_PER_TASK) / PLAKY_WRITES_PER_MINUTE),
    },
    shape: tasks > OVERNIGHT_TASKS ? "two calls and overnight" : projects.length <= ONE_CALL.projects && tasks <= ONE_CALL.tasks ? "one call" : "two calls",
    mayBeNotified: matched,
    subtaskBoards: subtaskBoards.map((b) => ({ name: b.name, parent: manifest.boards.find((p) => p.id === b.parentBoardId)?.name ?? b.parentBoardId ?? "", tasks: b.itemsCount })),
    notes: [...(manifest.notes ?? [])],
  };
}
