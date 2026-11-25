export type BoardsMode = "overview" | "choosing" | "repairing";
export type BoardsEvent = "choose" | "read" | "repair" | "back" | "linked";
export function boardsTransition(_mode: BoardsMode, event: BoardsEvent): BoardsMode {
  switch (event) {
    case "choose": return "choosing";
    case "repair": return "repairing";
    case "read": case "back": case "linked": return "overview";
  }
}

export type LinkReadiness = "unread" | "missing" | "blocked" | "confirmation" | "status-types" | "ready";
export function linkReadiness(preview: {
  missing: readonly unknown[]; links: readonly { ready: boolean }[]; blocking: readonly unknown[]; needsConfirm: boolean;
} | undefined, statusTypes: number, keepTags: boolean): LinkReadiness {
  if (!preview) return "unread";
  if (preview.missing.length || !preview.links.length) return "missing";
  if (preview.blocking.length || preview.links.some((link) => !link.ready)) return "blocked";
  if (preview.needsConfirm) return "confirmation";
  if (!keepTags && statusTypes) return "status-types";
  return "ready";
}

export const AWAKE_MS = 5 * 60_000;
const FOCUS_SCAN_GAP_MS = 5_000;
const FAST_SCANS = 20;

const scanPace = (timedScans: number): "fast" | "slow" => (timedScans >= FAST_SCANS ? "slow" : "fast");

export const focusScanDue = (now: number, hidden: boolean, lastSentAt: number): boolean => !hidden && now - lastSentAt >= FOCUS_SCAN_GAP_MS;

export const downloadScanDue = (now: number, lastSentAt: number, watchMs: number): boolean => now - lastSentAt >= watchMs;

export class SetupWatcher {
  private awakeUntil = 0;
  private linking = false;
  private timed = 0;
  private readonly heard = new Set<() => void>();
  get isLinking(): boolean { return this.linking; }
  get pace(): "fast" | "slow" { return scanPace(this.timed); }
  readonly subscribe = (changed: () => void): (() => void) => {
    this.heard.add(changed);
    return () => { this.heard.delete(changed); };
  };
  timedScanSent(): void {
    const before = this.pace;
    this.timed += 1;
    if (this.pace !== before) for (const changed of this.heard) changed();
  }
  wake(now: number): void { this.awakeUntil = now + AWAKE_MS; }
  watching(now: number, hidden: boolean): boolean { return !hidden || now < this.awakeUntil; }
  link(): boolean {
    if (this.linking) return false;
    this.linking = true;
    return true;
  }
  linked(): void { this.linking = false; }
}
