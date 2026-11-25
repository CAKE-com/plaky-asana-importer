const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

export const tasksText = (tasks: number, subtasks: number | undefined): string => (subtasks ? `${plural(tasks, "task")} and ${plural(subtasks, "subtask")}` : plural(tasks, "task"));

export type CountedBoard = { id: string; items: number; subitemsOf: string | null; plakyBoardId: number | null; nested: boolean };

export function setUpCounts(boards: readonly CountedBoard[], linked: boolean): { tasks: number; subtasks: number } {
  const paired = (id: string | null): boolean => boards.some((b) => b.id === id && b.plakyBoardId !== null);
  const moving = linked ? boards.filter((b) => b.plakyBoardId !== null || (b.nested && paired(b.subitemsOf))) : boards;
  const count = (subtasks: boolean): number => moving.filter((b) => (b.subitemsOf !== null) === subtasks).reduce((n, b) => n + b.items, 0);
  return { tasks: count(false), subtasks: count(true) };
}
