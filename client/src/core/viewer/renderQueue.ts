/**
 * Small priority scheduler for page renders. At most `concurrency` jobs run at once; pending jobs
 * are picked by a *dynamic* priority (re-evaluated every time a slot frees up) so the pages
 * currently on screen always render first, even while the user scrolls.
 */

export interface RenderJobContext {
  readonly cancelled: boolean;
  /** Register an abort hook (e.g. pdf.js RenderTask.cancel). */
  onCancel(fn: () => void): void;
}

interface Job {
  key: string;
  priority: () => number;
  run: (ctx: RenderJobContext) => Promise<void>;
  cancelled: boolean;
  cancelHooks: (() => void)[];
}

class RenderQueue {
  private pending = new Map<string, Job>();
  private running = new Map<string, Job>();
  private scheduled = false;

  constructor(private concurrency = 2) {}

  /** Schedule (or replace) the job with this key. */
  schedule(key: string, priority: () => number, run: (ctx: RenderJobContext) => Promise<void>): void {
    this.cancel(key);
    this.pending.set(key, { key, priority, run, cancelled: false, cancelHooks: [] });
    this.pump();
  }

  isQueued(key: string): boolean {
    return this.pending.has(key) || this.running.has(key);
  }

  cancel(key: string): void {
    this.pending.delete(key);
    const r = this.running.get(key);
    if (r) {
      r.cancelled = true;
      this.running.delete(key);
      for (const h of r.cancelHooks) {
        try {
          h();
        } catch {
          /* ignore */
        }
      }
      this.pump();
    }
  }

  /** Re-evaluate priorities (e.g. after scrolling). */
  poke(): void {
    this.pump();
  }

  private pump() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      while (this.running.size < this.concurrency && this.pending.size > 0) {
        let best: Job | null = null;
        let bestP = Infinity;
        for (const j of this.pending.values()) {
          let p: number;
          try {
            p = j.priority();
          } catch {
            p = 1e12;
          }
          if (p < bestP || best === null) {
            bestP = p;
            best = j;
          }
        }
        if (!best) break;
        this.pending.delete(best.key);
        this.start(best);
      }
    });
  }

  private start(job: Job) {
    this.running.set(job.key, job);
    const ctx: RenderJobContext = {
      get cancelled() {
        return job.cancelled;
      },
      onCancel(fn) {
        if (job.cancelled) fn();
        else job.cancelHooks.push(fn);
      },
    };
    let p: Promise<void>;
    try {
      p = job.run(ctx);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((e) => {
      if (!job.cancelled && !isCancellation(e)) console.error('[viewer] render failed', e);
    }).finally(() => {
      if (this.running.get(job.key) === job) this.running.delete(job.key);
      this.pump();
    });
  }
}

export function isCancellation(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

/** Shared queue for all page canvases. */
export const renderQueue = new RenderQueue(2);
