import type { JavaTypeSnapshot, MapperMapping, MethodMapping } from '../types';
import type { TypeGraph } from './typeGraph';
import type { XmlNamespaceIndex } from './xmlNamespaceIndex';

/** 索引快照 - 某一代号的完整索引状态。 */
export interface IndexSnapshot {
  generation: number;
  fqnToType: Map<string, JavaTypeSnapshot>;
  fqnToTypes: Map<string, JavaTypeSnapshot[]>;
  pathToType: Map<string, JavaTypeSnapshot>;
  javaToMapping: Map<string, MapperMapping>;
  xmlToMappings: Map<string, MapperMapping[]>;
  namespaceToMappings: Map<string, MapperMapping[]>;
  classNameToMappings: Map<string, MapperMapping[]>;
  xmlNamespaces: XmlNamespaceIndex;
  interfaceImplementationFallbacks: Map<string, string[]>;
  interfaceFileFallbacks: Map<string, string[]>;
  typeGraph: TypeGraph;
}

/** 全量扫描结果。调用方可并行收集，完成后一次原子发布。 */
export interface IndexBuildInput {
  typeSnapshots: Iterable<JavaTypeSnapshot>;
  mappings?: Iterable<MapperMapping>;
  /**
   * 全量扫描得到的 namespace -> XML paths。传入空集合也表示扫描完整但没有Mapper XML；
   * 省略该字段则保留向后兼容的“不完整，动态扫描回退”语义。
   */
  xmlNamespaces?: Iterable<readonly [string, Iterable<string>]>;
}

export interface QueuedScan {
  scanFn: () => Promise<void>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export function cloneJavaTypeSnapshot(snapshot: JavaTypeSnapshot): JavaTypeSnapshot {
  return {
    ...snapshot,
    explicitImports: [...snapshot.explicitImports],
    wildcardImports: [...snapshot.wildcardImports],
    interfaces: [...snapshot.interfaces],
    rawInterfaces: snapshot.rawInterfaces ? [...snapshot.rawInterfaces] : undefined,
    methods: snapshot.methods.map(method => ({
      ...method,
      parameterTypes: [...method.parameterTypes],
      rawParameterTypes: method.rawParameterTypes ? [...method.rawParameterTypes] : undefined
    }))
  };
}

export function cloneMapperMapping(mapping: MapperMapping): MapperMapping {
  const methods = new Map<string, MethodMapping>();
  for (const [name, method] of mapping.methods) {
    methods.set(name, {
      ...method,
      javaPosition: { ...method.javaPosition },
      xmlPosition: method.xmlPosition && { ...method.xmlPosition }
    });
  }
  return { ...mapping, methods };
}
