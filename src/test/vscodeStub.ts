import * as fs from 'fs';
import * as path from 'path';

export const configurationValues = new Map<string, unknown>();
export const commandHandlers = new Map<string, (...args: any[]) => unknown>();
export const openTextDocuments: any[] = [];

let lastOpenedEditor: any;
let quickPickIndex = 0;
let findFilesHandler: ((include: any, exclude?: any) => any[] | Promise<any[]>) | undefined;
let workspaceFolders: any[] | undefined;
const extensionStubs = new Map<string, unknown>();
const fileSystemWatchers: StubFileSystemWatcher[] = [];

export class StubPosition {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class StubRange {
  public readonly start: StubPosition;
  public readonly end: StubPosition;

  constructor(start: StubPosition | number, end: StubPosition | number, endLine?: number, endCharacter?: number) {
    this.start = typeof start === 'number' ? new StubPosition(start, end as number) : start;
    this.end = typeof start === 'number'
      ? new StubPosition(endLine ?? start, endCharacter ?? end as number)
      : end as StubPosition;
  }
}

export class StubRelativePattern {
  constructor(public readonly base: unknown, public readonly pattern: string) {}
}

class StubSelection extends StubRange {}

export class StubUri {
  readonly scheme = 'file';

  private constructor(public readonly fsPath: string) {}

  static file(filePath: string): StubUri {
    return new StubUri(path.resolve(filePath));
  }

  static parse(value: string): StubUri {
    if (!value.startsWith('file:')) return new StubUri(value);
    const pathname = decodeURIComponent(new URL(value).pathname);
    const filePath = process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.substring(1)
      : pathname;
    return new StubUri(path.normalize(filePath));
  }

  toString(): string {
    return `file:///${this.fsPath.replace(/\\/g, '/')}`;
  }
}

class StubLocation {
  constructor(public readonly uri: StubUri, public readonly range: StubRange) {}
}

export class StubEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();

  readonly event = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.clear();
  }

  clear(): void {
    this.listeners.clear();
  }
}

const extensionsDidChange = new StubEventEmitter<void>();

class StubCodeLens {
  constructor(public readonly range: StubRange, public readonly command?: any) {}
}

export class StubFileSystemWatcher {
  private readonly createListeners = new Set<(uri: StubUri) => unknown>();
  private readonly changeListeners = new Set<(uri: StubUri) => unknown>();
  private readonly deleteListeners = new Set<(uri: StubUri) => unknown>();
  private disposed = false;

  constructor(
    public readonly pattern: unknown,
    public readonly ignoreCreateEvents = false,
    public readonly ignoreChangeEvents = false,
    public readonly ignoreDeleteEvents = false
  ) {}

  onDidCreate(listener: (uri: StubUri) => unknown) {
    return this.addListener(this.createListeners, listener);
  }

  onDidChange(listener: (uri: StubUri) => unknown) {
    return this.addListener(this.changeListeners, listener);
  }

  onDidDelete(listener: (uri: StubUri) => unknown) {
    return this.addListener(this.deleteListeners, listener);
  }

  fireCreate(uri: StubUri): void {
    this.fire(this.createListeners, uri);
  }

  fireChange(uri: StubUri): void {
    this.fire(this.changeListeners, uri);
  }

  fireDelete(uri: StubUri): void {
    this.fire(this.deleteListeners, uri);
  }

  dispose(): void {
    this.disposed = true;
    this.createListeners.clear();
    this.changeListeners.clear();
    this.deleteListeners.clear();
  }

  private addListener(
    listeners: Set<(uri: StubUri) => unknown>,
    listener: (uri: StubUri) => unknown
  ) {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }

  private fire(listeners: Set<(uri: StubUri) => unknown>, uri: StubUri): void {
    if (this.disposed) return;
    for (const listener of [...listeners]) {
      listener(uri);
    }
  }
}

export function registerVscodeStub(): void {
  const moduleApi = require('module') as {
    _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleApi._load;

  moduleApi._load = (request: string, parent: NodeModule | undefined, isMain: boolean): unknown => {
    if (request === 'vscode') {
      return createVscodeStub();
    }

    return originalLoad(request, parent, isMain);
  };
}

export function getLastOpenedEditor(): any {
  return lastOpenedEditor;
}

export function setActiveTextEditor(editor: any): void {
  lastOpenedEditor = editor;
}

export function setFindFilesHandler(
  handler?: (include: any, exclude?: any) => any[] | Promise<any[]>
): void {
  findFilesHandler = handler;
}

export function setWorkspaceFolders(folders?: any[]): void {
  workspaceFolders = folders;
}

export function setExtension(id: string, extension: unknown): void {
  if (extension === undefined) {
    extensionStubs.delete(id);
    return;
  }
  extensionStubs.set(id, extension);
}

export function getFileSystemWatchers(): readonly StubFileSystemWatcher[] {
  return fileSystemWatchers;
}

export function fireExtensionsChanged(): void {
  extensionsDidChange.fire(undefined);
}

export function resetVscodeStubState(): void {
  configurationValues.clear();
  commandHandlers.clear();
  lastOpenedEditor = undefined;
  quickPickIndex = 0;
  findFilesHandler = undefined;
  workspaceFolders = undefined;
  extensionStubs.clear();
  extensionsDidChange.clear();
  for (const watcher of fileSystemWatchers) {
    watcher.dispose();
  }
  fileSystemWatchers.length = 0;
  openTextDocuments.length = 0;
}

function createVscodeStub(): any {
  return {
    Uri: StubUri,
    Position: StubPosition,
    Range: StubRange,
    RelativePattern: StubRelativePattern,
    CodeLens: StubCodeLens,
    EventEmitter: StubEventEmitter,
    Selection: StubSelection,
    Location: StubLocation,
    TextEditorRevealType: { InCenter: 0 },
    SymbolKind: { Class: 4, Interface: 10, Method: 5 },
    commands: {
      executeCommand: async (command: string, ...args: any[]) => commandHandlers.get(command)?.(...args),
      registerCommand: (command: string, handler: (...args: any[]) => unknown) => {
        commandHandlers.set(command, handler);
        return { dispose: () => commandHandlers.delete(command) };
      }
    },
    extensions: {
      getExtension: (id: string) => extensionStubs.get(id),
      all: [],
      onDidChange: extensionsDidChange.event
    },
    workspace: {
      textDocuments: openTextDocuments,
      get workspaceFolders() { return workspaceFolders; },
      getConfiguration: () => ({
        get: <T>(section: string, defaultValue?: T): T | undefined => {
          if (configurationValues.has(section)) {
            return configurationValues.get(section) as T;
          }

          return defaultValue;
        },
        has: () => false,
        inspect: () => undefined,
        update: async (section: string, value: unknown) => {
          configurationValues.set(section, value);
        }
      }),
      onDidChangeConfiguration: () => ({
        dispose: () => undefined
      }),
      getWorkspaceFolder: () => undefined,
      findFiles: async (include: any, exclude?: any) => findFilesHandler?.(include, exclude) ?? [],
      createFileSystemWatcher: (
        pattern: unknown,
        ignoreCreateEvents = false,
        ignoreChangeEvents = false,
        ignoreDeleteEvents = false
      ) => {
        const watcher = new StubFileSystemWatcher(
          pattern,
          ignoreCreateEvents,
          ignoreChangeEvents,
          ignoreDeleteEvents
        );
        fileSystemWatchers.push(watcher);
        return watcher;
      },
      openTextDocument: async (uri: StubUri) =>
        openTextDocuments.find(document => document.uri.fsPath === uri.fsPath) ?? { uri },
      fs: {
        stat: async (uri: StubUri) => fs.promises.stat(uri.fsPath)
      }
    },
    window: {
      get activeTextEditor() { return lastOpenedEditor; },
      createOutputChannel: () => ({
        append: () => undefined,
        appendLine: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        hide: () => undefined,
        show: () => undefined,
        dispose: () => undefined,
        name: 'Java Jump Test'
      }),
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async (items: any[]) => items[quickPickIndex],
      showTextDocument: async (document: { uri: StubUri }) => {
        lastOpenedEditor = {
          document,
          selection: undefined,
          revealRange: () => undefined
        };
        return lastOpenedEditor;
      }
    }
  };
}
