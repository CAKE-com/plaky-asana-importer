type ItemTarget = { state: "unsettled" } | { state: "created"; id: number };
export class ItemTargets {
  private readonly targets = new Map<string, ItemTarget>();
  remember(asanaId: string, id: number): void { this.targets.set(asanaId, { state: "created", id }); }
  unsettle(asanaId: string): void {
    if (!this.created(asanaId)) this.targets.set(asanaId, { state: "unsettled" });
  }
  created(asanaId: string): boolean { return this.targets.get(asanaId)?.state === "created"; }
  rowFor(asanaId: string, planned: number | null): number | null {
    const target = this.targets.get(asanaId);
    return !target ? planned : target.state === "created" ? target.id : null;
  }
}
