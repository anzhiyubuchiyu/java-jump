import * as vscode from 'vscode';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaTypeSnapshot } from '../types';
import { JavaParser } from '../utils/javaParser';

export async function resolveCurrentConcreteImplementations(
  indexedCandidates: JavaTypeSnapshot[],
  targetFqn: string,
  cache: IndexCacheManager
): Promise<JavaTypeSnapshot[]> {
  const dirtySnapshots = vscode.workspace.textDocuments
    .filter(document => document.isDirty && document.uri.fsPath.endsWith('.java'))
    .map(document => JavaParser.createTypeSnapshot(document.getText(), document.uri.fsPath))
    .filter(snapshot => !!snapshot.className);
  const byPath = new Map(indexedCandidates.map(snapshot => [snapshot.filePath, snapshot]));
  dirtySnapshots.forEach(snapshot => byPath.set(snapshot.filePath, snapshot));
  const dirtyByPath = new Map(dirtySnapshots.map(snapshot => [snapshot.filePath, snapshot]));
  const dirtyByFqn = createUniqueFqnMap(dirtySnapshots);
  const results: JavaTypeSnapshot[] = [];

  for (const candidate of byPath.values()) {
    const current = dirtyByPath.get(candidate.filePath) ?? candidate;
    if (current.fqn === targetFqn) continue;
    if (current.kind === 'interface' || current.isAbstract) continue;
    if (await referencesTarget(
      current,
      targetFqn,
      cache,
      dirtyByPath,
      dirtyByFqn,
      new Set()
    )) {
      results.push(current);
    }
  }
  return results;
}

async function referencesTarget(
  snapshot: JavaTypeSnapshot,
  targetFqn: string,
  cache: IndexCacheManager,
  dirtyByPath: Map<string, JavaTypeSnapshot>,
  dirtyByFqn: Map<string, JavaTypeSnapshot>,
  visited: Set<string>
): Promise<boolean> {
  if (snapshot.fqn === targetFqn) return true;
  if (visited.has(snapshot.fqn)) return false;
  const nextVisited = new Set(visited).add(snapshot.fqn);
  const references = [...snapshot.interfaces, snapshot.superClass].filter(
    (reference): reference is string => !!reference
  );

  for (const reference of references) {
    const resolvedFqn = resolveReference(snapshot, reference, cache);
    if (resolvedFqn === targetFqn) return true;
    const indexedParent = cache.getTypeByFqn(resolvedFqn);
    const parent = indexedParent
      ? dirtyByPath.get(indexedParent.filePath) ?? indexedParent
      : dirtyByFqn.get(resolvedFqn);
    if (parent && await referencesTarget(
      parent,
      targetFqn,
      cache,
      dirtyByPath,
      dirtyByFqn,
      nextVisited
    )) {
      return true;
    }
  }
  return false;
}

function createUniqueFqnMap(snapshots: JavaTypeSnapshot[]): Map<string, JavaTypeSnapshot> {
  const grouped = new Map<string, JavaTypeSnapshot[]>();
  for (const snapshot of snapshots) {
    grouped.set(snapshot.fqn, [...(grouped.get(snapshot.fqn) ?? []), snapshot]);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([fqn, candidates]) => [fqn, candidates[0]])
  );
}

function resolveReference(
  owner: JavaTypeSnapshot,
  reference: string,
  cache: IndexCacheManager
): string {
  if (!reference.startsWith('__unresolved__.')) return reference;
  const simpleName = reference.substring(reference.lastIndexOf('.') + 1);
  const explicitImport = owner.explicitImports.find(item => item.endsWith(`.${simpleName}`));
  if (explicitImport) return explicitImport;
  const samePackage = owner.packageName ? `${owner.packageName}.${simpleName}` : simpleName;
  if (cache.getTypeByFqn(samePackage)) return samePackage;
  const wildcardCandidates = owner.wildcardImports
    .map(packageName => `${packageName}.${simpleName}`)
    .filter(candidate => cache.getTypeByFqn(candidate));
  return wildcardCandidates.length === 1 ? wildcardCandidates[0] : reference;
}
