/** XML namespace -> 路径索引的不可变快照。 */
export interface XmlNamespaceIndex {
  complete: boolean;
  pathToNamespace: Map<string, string>;
  namespaceToPaths: Map<string, string[]>;
}

export function createXmlNamespaceIndex(
  namespaces?: Iterable<readonly [string, Iterable<string>]>
): XmlNamespaceIndex {
  const index: XmlNamespaceIndex = {
    complete: namespaces !== undefined,
    pathToNamespace: new Map(),
    namespaceToPaths: new Map()
  };
  for (const [namespace, paths] of namespaces ?? []) {
    for (const path of paths) {
      const previousNamespace = index.pathToNamespace.get(path);
      if (previousNamespace && previousNamespace !== namespace) {
        const previousPaths = index.namespaceToPaths.get(previousNamespace) ?? [];
        const remaining = previousPaths.filter(candidate => candidate !== path);
        if (remaining.length === 0) index.namespaceToPaths.delete(previousNamespace);
        else index.namespaceToPaths.set(previousNamespace, remaining);
      }
      index.pathToNamespace.set(path, namespace);
      const namespacePaths = index.namespaceToPaths.get(namespace) ?? [];
      if (!namespacePaths.includes(path)) {
        index.namespaceToPaths.set(namespace, [...namespacePaths, path]);
      }
    }
  }
  return index;
}

export function cloneXmlNamespaceIndex(index: XmlNamespaceIndex): XmlNamespaceIndex {
  return {
    complete: index.complete,
    pathToNamespace: new Map(index.pathToNamespace),
    namespaceToPaths: new Map(
      Array.from(index.namespaceToPaths, ([namespace, paths]) => [namespace, [...paths]])
    )
  };
}

export function updateXmlNamespace(
  index: XmlNamespaceIndex,
  path: string,
  namespace?: string
): XmlNamespaceIndex {
  const next = removeXmlNamespacePath(index, path);
  if (!namespace) return next;

  next.pathToNamespace.set(path, namespace);
  const paths = next.namespaceToPaths.get(namespace) ?? [];
  next.namespaceToPaths.set(namespace, [...paths, path]);
  return next;
}

export function removeXmlNamespacePath(index: XmlNamespaceIndex, path: string): XmlNamespaceIndex {
  const next = cloneXmlNamespaceIndex(index);
  const namespace = next.pathToNamespace.get(path);
  if (!namespace) return next;

  next.pathToNamespace.delete(path);
  const paths = next.namespaceToPaths.get(namespace) ?? [];
  const remaining = paths.filter(candidate => candidate !== path);
  if (remaining.length === 0) next.namespaceToPaths.delete(namespace);
  else next.namespaceToPaths.set(namespace, remaining);
  return next;
}

export function getXmlPathsByNamespace(index: XmlNamespaceIndex, namespace: string): string[] {
  return [...(index.namespaceToPaths.get(namespace) ?? [])];
}

export function hasXmlPathsByNamespace(index: XmlNamespaceIndex, namespace: string): boolean {
  return (index.namespaceToPaths.get(namespace)?.length ?? 0) > 0;
}
