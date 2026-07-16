import { JavaTypeSnapshot } from '../types';

export interface TypeGraph {
  /** 父接口 FQN -> 子类型文件路径。路径是重复 FQN 的稳定身份。 */
  interfaceChildren: Map<string, string[]>;
  /** 父类 FQN -> 子类型文件路径。路径是重复 FQN 的稳定身份。 */
  superChildren: Map<string, string[]>;
}

export function buildTypeGraph(types: Iterable<JavaTypeSnapshot>): TypeGraph {
  const interfaceChildren = new Map<string, string[]>();
  const superChildren = new Map<string, string[]>();
  const append = (index: Map<string, string[]>, parent: string | undefined, childPath: string) => {
    if (!parent) return;
    const children = index.get(parent) ?? [];
    if (!children.includes(childPath)) {
      index.set(parent, [...children, childPath]);
    }
  };

  for (const type of types) {
    for (const interfaceFqn of type.interfaces) append(interfaceChildren, interfaceFqn, type.filePath);
    append(superChildren, type.superClass, type.filePath);
  }
  return { interfaceChildren, superChildren };
}

export function findConcreteImplementations(
  graph: TypeGraph,
  typesByPath: Map<string, JavaTypeSnapshot>,
  interfaceFqn: string
): JavaTypeSnapshot[] {
  const result: JavaTypeSnapshot[] = [];
  const visited = new Set<string>();
  const queue = [interfaceFqn];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const parent = queue[queueIndex++];
    if (!parent || visited.has(parent)) continue;
    visited.add(parent);
    const children = [
      ...(graph.interfaceChildren.get(parent) ?? []),
      ...(graph.superChildren.get(parent) ?? [])
    ];
    for (const childPath of children) {
      const child = typesByPath.get(childPath);
      if (!child) continue;
      if (child.kind !== 'interface' && !child.isAbstract) result.push(child);
      queue.push(child.fqn);
    }
  }
  return deduplicate(result);
}

export function findConcreteDescendants(
  graph: TypeGraph,
  typesByPath: Map<string, JavaTypeSnapshot>,
  classFqn: string
): JavaTypeSnapshot[] {
  const result: JavaTypeSnapshot[] = [];
  const visited = new Set<string>();
  const queue = [classFqn];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const parent = queue[queueIndex++];
    if (!parent || visited.has(parent)) continue;
    visited.add(parent);
    for (const childPath of graph.superChildren.get(parent) ?? []) {
      const child = typesByPath.get(childPath);
      if (!child) continue;
      if (!child.isAbstract) result.push(child);
      queue.push(child.fqn);
    }
  }
  return deduplicate(result);
}

function deduplicate(types: JavaTypeSnapshot[]): JavaTypeSnapshot[] {
  return [...new Map(types.map(type => [type.filePath, type])).values()];
}
