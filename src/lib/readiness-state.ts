export type ReadinessState = "gone" | "unread" | "status-types" | "checklist";
export function readinessState(item: { key: string }): ReadinessState {
  if (item.key.endsWith(":gone")) return "gone";
  if (item.key.endsWith(":unread")) return "unread";
  if (item.key.endsWith(":status-types")) return "status-types";
  return "checklist";
}
