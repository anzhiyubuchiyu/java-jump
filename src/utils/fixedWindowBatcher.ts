export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export interface FixedWindowBatcherOptions {
  windowMs: number;
  threshold: number;
  onWindowClosed?(changeCount: number): void;
  scheduler?: TimerScheduler;
}

export interface BatchChangeState {
  changeCount: number;
  isBatch: boolean;
  crossedThreshold: boolean;
}

const defaultScheduler: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle)
};

/**
 * Counts events in a fixed window. A new event never extends an active window.
 */
export class FixedWindowBatcher {
  private changeCount = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly scheduler: TimerScheduler;

  constructor(private readonly options: FixedWindowBatcherOptions) {
    if (options.windowMs <= 0) {
      throw new Error('windowMs must be greater than zero');
    }
    if (options.threshold <= 0) {
      throw new Error('threshold must be greater than zero');
    }
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  record(): BatchChangeState {
    this.changeCount += 1;
    const isBatch = this.changeCount >= this.options.threshold;

    if (!this.timer) {
      this.timer = this.scheduler.setTimeout(() => this.closeWindow(), this.options.windowMs);
    }

    return {
      changeCount: this.changeCount,
      isBatch,
      crossedThreshold: this.changeCount === this.options.threshold
    };
  }

  dispose(): void {
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.changeCount = 0;
  }

  private closeWindow(): void {
    const changeCount = this.changeCount;
    this.changeCount = 0;
    this.timer = undefined;
    this.options.onWindowClosed?.(changeCount);
  }
}
