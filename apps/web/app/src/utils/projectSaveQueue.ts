export type SaveState = "saving" | "saved" | "error";

/** Serializes writes for each project and keeps the latest unsaved snapshot. */
export class ProjectSaveQueue<T extends { id: string }> {
  private pending = new Map<string, T>();
  private running = new Map<string, Promise<void>>();
  private stopped = false;
  private write: (project: T) => Promise<unknown>;
  private onState: (id: string, state: SaveState, error?: unknown) => void;

  constructor(write: (project: T) => Promise<unknown>, onState: (id: string, state: SaveState, error?: unknown) => void) {
    this.write = write;
    this.onState = onState;
  }

  enqueue(project: T): void {
    if (this.stopped) return;
    this.pending.set(project.id, project);
    this.onState(project.id, "saving");
    this.retry(project.id);
  }

  recover(project: T): void {
    this.pending.set(project.id, project);
    this.onState(project.id, "error", new Error("Recovered unsaved changes. Retry saving to sync them."));
  }

  retry(id: string): void {
    if (this.stopped || this.running.has(id) || !this.pending.has(id)) return;
    this.onState(id, "saving");
    const run = async () => {
      while (!this.stopped && this.pending.has(id)) {
        const snapshot = this.pending.get(id)!;
        try {
          await this.write(snapshot);
          if (this.stopped) return;
          // A response to an older write must never clear a newer edit.
          if (this.pending.get(id) === snapshot) {
            this.pending.delete(id);
            this.onState(id, "saved");
          }
        } catch (error) {
          if (!this.stopped) this.onState(id, "error", error);
          return;
        }
      }
    };
    const task = run().finally(() => this.running.delete(id));
    this.running.set(id, task);
  }

  getPending(): T[] {
    return [...this.pending.values()];
  }

  async wait(id: string): Promise<void> {
    await this.running.get(id);
    if (this.pending.has(id)) throw new Error("Save this project's pending changes before deleting it.");
  }

  stop(): void {
    this.stopped = true;
  }
}
