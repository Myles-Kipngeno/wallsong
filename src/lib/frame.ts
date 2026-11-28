type FrameListener = (now: number, dt: number) => void;

interface Subscription {
  callback: FrameListener;
  intervalMs: number;
  lastRun: number;
}

class FrameScheduler {
  private subs = new Set<Subscription>();
  private rafId: number | null = null;
  private lastNow: number = performance.now();
  private paused: boolean = false;

  private tick = (now: number) => {
    if (this.paused) {
      this.rafId = null;
      return;
    }
    const dt = Math.min(100, now - this.lastNow);
    this.lastNow = now;

    for (const sub of this.subs) {
      if (sub.intervalMs <= 0 || now - sub.lastRun >= sub.intervalMs) {
        sub.lastRun = now;
        try {
          sub.callback(now, dt);
        } catch (err) {
          console.error("Frame callback error:", err);
        }
      }
    }

    if (this.subs.size > 0 && !this.paused) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = null;
    }
  };

  private ensureRunning() {
    if (this.rafId === null && this.subs.size > 0 && !this.paused) {
      this.lastNow = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  public subscribe(callback: FrameListener, fps = 0): () => void {
    const sub: Subscription = {
      callback,
      intervalMs: fps > 0 ? 1000 / fps : 0,
      lastRun: 0,
    };
    this.subs.add(sub);
    this.ensureRunning();

    return () => {
      this.subs.delete(sub);
      if (this.subs.size === 0 && this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    };
  }

  public setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    } else if (!paused) {
      this.ensureRunning();
    }
  }

  public isPaused(): boolean {
    return this.paused;
  }
}

export const frameScheduler = new FrameScheduler();

/** Subscribe to the central window animation frame scheduler. Optional fps caps rate (e.g. 30, 15). */
export function subscribeFrame(callback: FrameListener, fps = 0): () => void {
  return frameScheduler.subscribe(callback, fps);
}

/** Pauses or resumes the entire animation frame loop (e.g. when the window is covered). */
export function setFramePaused(paused: boolean) {
  frameScheduler.setPaused(paused);
}
