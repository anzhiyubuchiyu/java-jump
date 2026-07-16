import { TimerScheduler } from './fixedWindowBatcher';

export interface QuietPeriodTaskSchedulerOptions {
  quietPeriodMs: number;
  onFirstRequest(): void;
  onQuietPeriodElapsed(): void;
  scheduler?: TimerScheduler;
}

const defaultScheduler: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle)
};

/**
 * Runs a task once after no request has arrived for the configured quiet period.
 */
export class QuietPeriodTaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private pending = false;
  private readonly scheduler: TimerScheduler;

  constructor(private readonly options: QuietPeriodTaskSchedulerOptions) {
    if (options.quietPeriodMs <= 0) {
      throw new Error('quietPeriodMs must be greater than zero');
    }
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get isPending(): boolean {
    return this.pending;
  }

  request(): void {
    if (!this.pending) {
      this.pending = true;
      this.options.onFirstRequest();
    }

    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
    }
    this.timer = this.scheduler.setTimeout(() => this.runTask(), this.options.quietPeriodMs);
  }

  dispose(): void {
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = false;
  }

  private runTask(): void {
    this.timer = undefined;
    this.pending = false;
    this.options.onQuietPeriodElapsed();
  }
}
