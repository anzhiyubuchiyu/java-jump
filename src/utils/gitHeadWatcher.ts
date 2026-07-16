import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

interface GitHead {
  name?: string;
  commit?: string;
  type?: unknown;
}

interface GitRepositoryState {
  HEAD?: GitHead;
  onDidChange: vscode.Event<void>;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

interface GitApi {
  repositories: readonly GitRepository[];
  onDidOpenRepository?: vscode.Event<GitRepository>;
  onDidCloseRepository?: vscode.Event<GitRepository>;
  onDidChangeState?: vscode.Event<unknown>;
}

interface GitExtensionApi {
  getAPI(version: 1): GitApi;
}

const NESTED_GIT_METADATA_EXCLUDE = '**/{node_modules,target,build,out,dist}/**';
const MAX_NESTED_GIT_METADATA_FILES = 100;

export interface GitHeadWatcherOptions {
  onDidChange(): void;
  onError?(message: string, error: unknown): void;
}

/**
 * Watches Git HEAD through the built-in Git extension and a direct metadata fallback.
 */
export class GitHeadWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositoryDisposables = new Map<string, vscode.Disposable>();
  private readonly watchedGitApis = new Set<GitApi>();
  private readonly watchedGitDirs = new Set<string>();
  private disposed = false;

  constructor(private readonly options: GitHeadWatcherOptions) {}

  async start(): Promise<void> {
    await Promise.all([
      this.watchGitExtension(),
      this.watchWorkspaceHeadFiles()
    ]);
    if (this.disposed) return;

    this.disposables.push(vscode.extensions.onDidChange(() => {
      void this.watchGitExtension();
      void this.watchWorkspaceHeadFiles();
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const disposable of this.repositoryDisposables.values()) {
      disposable.dispose();
    }
    this.repositoryDisposables.clear();

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async watchGitExtension(): Promise<void> {
    const extension = vscode.extensions.getExtension<unknown>('vscode.git');
    if (!extension) return;

    try {
      const api = asGitExtensionApi(await extension.activate());
      if (!api || this.disposed) return;

      const gitApi = api.getAPI(1);
      this.watchGitApi(gitApi);
    } catch (error) {
      this.reportError('Unable to subscribe to the built-in Git extension', error);
    }
  }

  private watchGitApi(gitApi: GitApi): void {
    for (const repository of gitApi.repositories) {
      this.watchRepository(repository);
    }
    if (this.watchedGitApis.has(gitApi)) return;

    this.watchedGitApis.add(gitApi);
    if (gitApi.onDidOpenRepository) {
      this.disposables.push(gitApi.onDidOpenRepository(repository => this.watchRepository(repository)));
    }
    if (gitApi.onDidCloseRepository) {
      this.disposables.push(gitApi.onDidCloseRepository(repository => this.unwatchRepository(repository)));
    }
    if (gitApi.onDidChangeState) {
      this.disposables.push(gitApi.onDidChangeState(() => this.watchGitApi(gitApi)));
    }
  }

  private watchRepository(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    if (this.disposed || this.repositoryDisposables.has(key)) return;

    let previousHead = getHeadFingerprint(repository.state.HEAD);
    const disposable = repository.state.onDidChange(() => {
      const currentHead = getHeadFingerprint(repository.state.HEAD);
      if (currentHead === previousHead) return;

      previousHead = currentHead;
      this.notifyChange();
    });
    this.repositoryDisposables.set(key, disposable);
  }

  private unwatchRepository(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    const disposable = this.repositoryDisposables.get(key);
    if (!disposable) return;

    disposable.dispose();
    this.repositoryDisposables.delete(key);
  }

  private async watchWorkspaceHeadFiles(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const rootGitDirTasks = workspaceFolders.map(async folder => {
      if (folder.uri.scheme !== 'file') return;

      try {
        const gitDir = await resolveGitDir(folder.uri.fsPath);
        if (gitDir) this.watchGitDir(gitDir);
      } catch (error) {
        this.reportError(`Unable to watch Git HEAD for ${folder.uri.fsPath}`, error);
      }
    });
    await Promise.all(rootGitDirTasks);

    try {
      const [headUris, dotGitUris] = await Promise.all([
        vscode.workspace.findFiles(
          '**/.git/HEAD',
          NESTED_GIT_METADATA_EXCLUDE,
          MAX_NESTED_GIT_METADATA_FILES
        ),
        vscode.workspace.findFiles(
          '**/.git',
          NESTED_GIT_METADATA_EXCLUDE,
          MAX_NESTED_GIT_METADATA_FILES
        )
      ]);
      for (const headUri of headUris) {
        this.watchGitDir(path.dirname(headUri.fsPath));
      }
      await Promise.all(dotGitUris.map(async dotGitUri => {
        const gitDir = await resolveGitDirAtPath(path.dirname(dotGitUri.fsPath));
        if (gitDir) this.watchGitDir(gitDir);
      }));
    } catch (error) {
      this.reportError('Unable to discover nested Git repositories', error);
    }
  }

  private watchGitDir(gitDir: string): void {
    if (this.disposed) return;

    const gitDirKey = getPathKey(gitDir);
    if (this.watchedGitDirs.has(gitDirKey)) return;

    const pattern = new vscode.RelativePattern(vscode.Uri.file(gitDir), 'HEAD');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    watcher.onDidCreate(() => this.notifyChange());
    watcher.onDidChange(() => this.notifyChange());
    watcher.onDidDelete(() => this.notifyChange());
    this.watchedGitDirs.add(gitDirKey);
    this.disposables.push(watcher);
  }

  private notifyChange(): void {
    if (!this.disposed) {
      this.options.onDidChange();
    }
  }

  private reportError(message: string, error: unknown): void {
    if (!this.disposed) {
      this.options.onError?.(message, error);
    }
  }
}

export async function resolveGitDir(workspacePath: string): Promise<string | undefined> {
  let currentPath: string | undefined = path.resolve(workspacePath);

  while (currentPath) {
    const gitDir = await resolveGitDirAtPath(currentPath);
    if (gitDir) return gitDir;

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return undefined;
    currentPath = parentPath;
  }

  return undefined;
}

async function resolveGitDirAtPath(directoryPath: string): Promise<string | undefined> {
  const dotGitPath = path.join(directoryPath, '.git');

  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    if (!stat.isFile()) return undefined;

    const content = await fs.readFile(dotGitPath, 'utf8');
    const match = /^gitdir:\s*(.+?)\s*$/mi.exec(content);
    return match ? path.resolve(directoryPath, match[1]) : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function asGitExtensionApi(value: unknown): GitExtensionApi | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { getAPI?: unknown };
  return typeof candidate.getAPI === 'function' ? candidate as GitExtensionApi : undefined;
}

function getHeadFingerprint(head: GitHead | undefined): string | undefined {
  if (!head) return undefined;
  return JSON.stringify([head.type ?? '', head.name ?? '', head.commit ?? '']);
}

function getPathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}
