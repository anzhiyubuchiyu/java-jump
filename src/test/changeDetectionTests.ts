import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FixedWindowBatcher, TimerScheduler } from '../utils/fixedWindowBatcher';
import { GitHeadWatcher, resolveGitDir } from '../utils/gitHeadWatcher';
import { QuietPeriodTaskScheduler } from '../utils/quietPeriodTaskScheduler';
import { TestCase } from './testHelpers';
import {
  fireExtensionsChanged,
  getFileSystemWatchers,
  resetVscodeStubState,
  setExtension,
  setFindFilesHandler,
  setWorkspaceFolders,
  StubEventEmitter,
  StubRelativePattern,
  StubUri
} from './vscodeStub';

type ScheduledCallback = {
  callback: () => void;
  active: boolean;
};

class FakeTimerScheduler implements TimerScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, ScheduledCallback>();

  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    void delayMs;
    const id = this.nextId++;
    this.callbacks.set(id, { callback, active: true });
    return id as unknown as NodeJS.Timeout;
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    const id = handle as unknown as number;
    const scheduled = this.callbacks.get(id);
    if (scheduled) scheduled.active = false;
  }

  runNext(): void {
    const next = Array.from(this.callbacks.entries()).find(([, scheduled]) => scheduled.active);
    assert.ok(next, 'expected a scheduled callback');
    const [id, scheduled] = next;
    this.callbacks.delete(id);
    scheduled.callback();
  }

  get activeCount(): number {
    return Array.from(this.callbacks.values()).filter(scheduled => scheduled.active).length;
  }
}

export function createChangeDetectionTests(): TestCase[] {
  return [
    {
      name: 'FixedWindowBatcher 使用固定窗口且不会因连续事件延长窗口',
      run: () => {
        const scheduler = new FakeTimerScheduler();
        const windows: number[] = [];
        const batcher = new FixedWindowBatcher({
          windowMs: 1000,
          threshold: 5,
          scheduler,
          onWindowClosed: changeCount => windows.push(changeCount)
        });

        assert.deepStrictEqual(batcher.record(), {
          changeCount: 1,
          isBatch: false,
          crossedThreshold: false
        });
        batcher.record();
        batcher.record();
        batcher.record();
        assert.strictEqual(scheduler.activeCount, 1);
        scheduler.runNext();

        batcher.record();
        batcher.record();
        batcher.record();
        batcher.record();
        assert.strictEqual(scheduler.activeCount, 1);
        scheduler.runNext();

        assert.deepStrictEqual(windows, [4, 4]);
        batcher.dispose();
      }
    },
    {
      name: 'FixedWindowBatcher 仅在同一窗口达到阈值时标记批量变更',
      run: () => {
        const scheduler = new FakeTimerScheduler();
        const windows: number[] = [];
        const batcher = new FixedWindowBatcher({
          windowMs: 1000,
          threshold: 3,
          scheduler,
          onWindowClosed: changeCount => windows.push(changeCount)
        });

        assert.strictEqual(batcher.record().crossedThreshold, false);
        assert.strictEqual(batcher.record().crossedThreshold, false);
        const thresholdState = batcher.record();
        assert.deepStrictEqual(thresholdState, {
          changeCount: 3,
          isBatch: true,
          crossedThreshold: true
        });
        assert.strictEqual(batcher.record().crossedThreshold, false);
        scheduler.runNext();
        assert.deepStrictEqual(windows, [4]);

        batcher.record();
        batcher.dispose();
        assert.strictEqual(scheduler.activeCount, 0);
      }
    },
    {
      name: 'QuietPeriodTaskScheduler 在持续事件后只运行一次任务',
      run: () => {
        const scheduler = new FakeTimerScheduler();
        let invalidationCount = 0;
        let runCount = 0;
        const taskScheduler = new QuietPeriodTaskScheduler({
          quietPeriodMs: 1000,
          scheduler,
          onFirstRequest: () => { invalidationCount += 1; },
          onQuietPeriodElapsed: () => { runCount += 1; }
        });

        taskScheduler.request();
        taskScheduler.request();
        taskScheduler.request();
        assert.strictEqual(invalidationCount, 1);
        assert.strictEqual(scheduler.activeCount, 1);
        scheduler.runNext();
        assert.strictEqual(runCount, 1);
        assert.strictEqual(taskScheduler.isPending, false);

        taskScheduler.request();
        assert.strictEqual(invalidationCount, 2);
        taskScheduler.dispose();
        assert.strictEqual(scheduler.activeCount, 0);
      }
    },
    {
      name: 'resolveGitDir 支持仓库子目录和 linked worktree',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-git-dir-'));
        const repositoryRoot = path.join(tempRoot, 'repository');
        const nestedWorkspace = path.join(repositoryRoot, 'packages', 'app');
        const worktreeRoot = path.join(tempRoot, 'worktree');
        const worktreeGitDir = path.join(tempRoot, 'metadata', 'worktrees', 'feature');

        try {
          fs.mkdirSync(path.join(repositoryRoot, '.git'), { recursive: true });
          fs.mkdirSync(nestedWorkspace, { recursive: true });
          fs.mkdirSync(worktreeRoot, { recursive: true });
          fs.mkdirSync(worktreeGitDir, { recursive: true });
          fs.writeFileSync(
            path.join(worktreeRoot, '.git'),
            `gitdir: ${path.relative(worktreeRoot, worktreeGitDir)}\n`,
            'utf8'
          );

          assert.strictEqual(await resolveGitDir(nestedWorkspace), path.resolve(repositoryRoot, '.git'));
          assert.strictEqual(await resolveGitDir(worktreeRoot), path.resolve(worktreeGitDir));
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'GitHeadWatcher 仅在内置Git API的HEAD变化时触发刷新',
      run: async () => {
        resetVscodeStubState();
        const stateEvents = new StubEventEmitter<void>();
        const repository = {
          rootUri: StubUri.file(path.join(os.tmpdir(), 'git-api-repository')),
          state: {
            HEAD: { name: 'main', commit: 'first', type: 0 },
            onDidChange: stateEvents.event
          }
        };
        const gitApi = { repositories: [repository] };
        setExtension('vscode.git', {
          activate: async () => ({ getAPI: () => gitApi })
        });

        let refreshCount = 0;
        const watcher = new GitHeadWatcher({ onDidChange: () => { refreshCount += 1; } });
        await watcher.start();

        stateEvents.fire(undefined);
        assert.strictEqual(refreshCount, 0);
        repository.state.HEAD = { name: 'feature', commit: 'second', type: 0 };
        stateEvents.fire(undefined);
        assert.strictEqual(refreshCount, 1);

        watcher.dispose();
        repository.state.HEAD = { name: 'main', commit: 'third', type: 0 };
        stateEvents.fire(undefined);
        assert.strictEqual(refreshCount, 1);
      }
    },
    {
      name: 'GitHeadWatcher 在内置Git扩展后启用时重新订阅',
      run: async () => {
        resetVscodeStubState();
        const stateEvents = new StubEventEmitter<void>();
        const repository = {
          rootUri: StubUri.file(path.join(os.tmpdir(), 'git-api-late-repository')),
          state: {
            HEAD: { name: 'main', commit: 'first', type: 0 },
            onDidChange: stateEvents.event
          }
        };
        const gitApi = { repositories: [repository] };
        let refreshCount = 0;
        const watcher = new GitHeadWatcher({ onDidChange: () => { refreshCount += 1; } });
        try {
          await watcher.start();
          setExtension('vscode.git', {
            activate: async () => ({ getAPI: () => gitApi })
          });
          fireExtensionsChanged();
          await waitForAsyncWork();

          repository.state.HEAD = { name: 'feature', commit: 'second', type: 0 };
          stateEvents.fire(undefined);
          assert.strictEqual(refreshCount, 1);
        } finally {
          watcher.dispose();
        }
      }
    },
    {
      name: 'GitHeadWatcher 在Git扩展不可用时监听解析后的HEAD文件',
      run: async () => {
        resetVscodeStubState();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-git-head-'));
        const gitDir = path.join(tempRoot, '.git');
        const headPath = path.join(gitDir, 'HEAD');
        const nestedGitDir = path.join(tempRoot, 'modules', 'nested', '.git');
        const nestedHeadPath = path.join(nestedGitDir, 'HEAD');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.mkdirSync(nestedGitDir, { recursive: true });
        fs.writeFileSync(headPath, 'ref: refs/heads/main\n', 'utf8');
        fs.writeFileSync(nestedHeadPath, 'ref: refs/heads/main\n', 'utf8');
        setWorkspaceFolders([{ uri: StubUri.file(tempRoot) }]);
        setFindFilesHandler(include => include === '**/.git/HEAD'
          ? [StubUri.file(nestedHeadPath)]
          : []
        );

        let refreshCount = 0;
        const watcher = new GitHeadWatcher({ onDidChange: () => { refreshCount += 1; } });
        try {
          await watcher.start();
          const headWatcher = getFileSystemWatchers().find(candidate =>
            ((candidate.pattern as StubRelativePattern).base as StubUri).fsPath === path.resolve(gitDir)
          );
          const nestedHeadWatcher = getFileSystemWatchers().find(candidate =>
            ((candidate.pattern as StubRelativePattern).base as StubUri).fsPath === path.resolve(nestedGitDir)
          );
          assert.ok(headWatcher, 'expected a direct HEAD watcher');
          assert.ok(nestedHeadWatcher, 'expected a nested repository HEAD watcher');
          assert.ok(headWatcher.pattern instanceof StubRelativePattern);
          assert.strictEqual((headWatcher.pattern as StubRelativePattern).pattern, 'HEAD');
          assert.strictEqual(
            ((headWatcher.pattern as StubRelativePattern).base as StubUri).fsPath,
            path.resolve(gitDir)
          );

          headWatcher.fireCreate(StubUri.file(headPath));
          headWatcher.fireChange(StubUri.file(headPath));
          headWatcher.fireDelete(StubUri.file(headPath));
          nestedHeadWatcher.fireChange(StubUri.file(nestedHeadPath));
          assert.strictEqual(refreshCount, 4);

          watcher.dispose();
          headWatcher.fireChange(StubUri.file(headPath));
          nestedHeadWatcher.fireChange(StubUri.file(nestedHeadPath));
          assert.strictEqual(refreshCount, 4);
        } finally {
          watcher.dispose();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    }
  ];
}

async function waitForAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}
