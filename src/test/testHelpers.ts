import * as fs from 'fs';
import * as path from 'path';
import type { JavaTypeSnapshot, MapperMapping } from '../types';
import { configurationValues, resetVscodeStubState } from './vscodeStub';

export type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

export function writeJavaFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.trim(), 'utf8');
}

export function resetConfigValues(): void {
  configurationValues.clear();
}

export function resetTestState(): void {
  resetVscodeStubState();
}

export function createTypeSnapshot(
  filePath: string,
  overrides: Partial<JavaTypeSnapshot> = {}
): JavaTypeSnapshot {
  const defaults: JavaTypeSnapshot = {
    fqn: 'com.example.UserService',
    packageName: 'com.example',
    className: 'UserService',
    kind: 'interface',
    isAbstract: false,
    isMapper: false,
    explicitImports: [],
    wildcardImports: [],
    superClass: undefined,
    interfaces: [],
    methods: [],
    filePath
  };
  return { ...defaults, ...overrides, filePath };
}

export function createMapping(
  javaPath: string,
  xmlPath: string,
  namespace: string
): MapperMapping {
  return {
    javaPath,
    xmlPath,
    namespace,
    className: namespace.substring(namespace.lastIndexOf('.') + 1),
    methods: new Map([
      ['find', {
        name: 'find',
        javaPosition: { line: 1, column: 2 },
        xmlPosition: { line: 3, column: 4 },
        sqlType: 'select'
      }]
    ])
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}
