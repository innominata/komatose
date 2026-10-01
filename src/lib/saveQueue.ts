/** Independent per-record queues with durable drafts. Overlapping revision conflicts stay for review. */
export type Draft = {
  patch: Record<string, unknown>;
  revision: number;
  error?: string;
  conflict?: unknown;
};

export class SaveQueue {
  drafts = new Map<string, Draft>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  constructor(
    private key: string,
    private send: (id: string, draft: Draft) => Promise<{ revision: number }>,
    private changed: () => void = () => {},
  ) {}
  restore() {
    try {
      for (const [id, draft] of JSON.parse(
        localStorage.getItem(this.key) || "[]",
      ))
        this.drafts.set(id, draft);
    } catch {
      /* A malformed local cache must not stop editing. */
    }
    this.changed();
    for (const [id, draft] of this.drafts) {
      if (draft.error && !draft.conflict) this.retry(id);
    }
  }
  private persist() {
    try {
      localStorage.setItem(this.key, JSON.stringify([...this.drafts]));
    } catch {
      /* beforeunload still guards unsaved drafts */
    }
    this.changed();
  }
  queue(id: string, patch: Record<string, unknown>, revision: number, delay = 400) {
    const old = this.drafts.get(id);
    this.drafts.set(id, {
      ...old,
      patch: { ...old?.patch, ...patch },
      revision: old?.revision ?? revision,
    });
    this.persist();
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => void this.flush(id), delay),
    );
  }
  async flush(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const active = this.running.get(id);
    if (active) {
      await active;
      if (!this.drafts.get(id)?.error) return this.flush(id);
      return;
    }
    const draft = this.drafts.get(id);
    if (!draft || draft.error) return;
    const task = (async () => {
      try {
        const result = await this.send(id, draft);
        const next = this.drafts.get(id);
        if (next === draft) this.drafts.delete(id);
        else if (next)
          this.drafts.set(id, { ...next, revision: result.revision });
      } catch (e) {
        const next = this.drafts.get(id) ?? draft;
        const conflict = (e as { current?: unknown }).current;
        this.drafts.set(id, {
          ...next,
          error: e instanceof Error ? e.message : "Save failed",
          conflict,
        });
      } finally {
        this.persist();
      }
    })();
    this.running.set(id, task);
    await task;
    this.running.delete(id);
    if (this.drafts.has(id) && !this.drafts.get(id)?.error)
      await this.flush(id);
  }
  async flushAll() {
    await Promise.all([...this.drafts.keys()].map((id) => this.flush(id)));
    return this.drafts.size === 0;
  }
  retry(id: string, revision?: number) {
    const d = this.drafts.get(id);
    if (!d) return;
    if (d.conflict && revision === undefined) return;
    this.drafts.set(id, { patch: d.patch, revision: revision ?? d.revision });
    this.persist();
    void this.flush(id);
  }
  discard(id: string) {
    this.drafts.delete(id);
    clearTimeout(this.timers.get(id));
    this.persist();
  }
  beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.drafts.size) {
      event.preventDefault();
      event.returnValue = "";
      void this.flushAll();
    }
  };
}
