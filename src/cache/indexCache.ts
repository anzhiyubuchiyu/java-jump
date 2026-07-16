/**
 * 索引协调器
 * 管理Java类型快照和Mapper映射的不可变索引
 *
 * 核心设计：
 * 1. Generation机制防止Git切换期间旧扫描覆盖新索引
 * 2. 不可变快照，更新时创建新对象
 * 3. 共享扫描任务避免重复全仓扫描
 * 4. FQN为键，避免不同包同名接口混淆
 */

import * as vscode from 'vscode';
import { JavaTypeSnapshot, MapperMapping } from '../types';
import { buildTypeGraph, findConcreteDescendants, findConcreteImplementations } from './typeGraph';
import {
  cloneJavaTypeSnapshot,
  cloneMapperMapping
} from './indexSnapshot';
import type { IndexBuildInput, IndexSnapshot, QueuedScan } from './indexSnapshot';
import {
  cloneXmlNamespaceIndex,
  createXmlNamespaceIndex,
  getXmlPathsByNamespace,
  hasXmlPathsByNamespace,
  removeXmlNamespacePath,
  updateXmlNamespace
} from './xmlNamespaceIndex';

export type { IndexBuildInput } from './indexSnapshot';

export class IndexCacheManager {
  private static instance: IndexCacheManager;

  /** 当前发布的索引快照 */
  private current: IndexSnapshot;
  /** 下一个generation号 */
  private nextGeneration = 1;
  /** 最近一次已开始的generation；只有它可以发布 */
  private latestBegunGeneration = 0;
  /** 共享扫描任务 */
  private sharedScanPromise: Promise<void> | null = null;
  /** 当前扫描后待执行的最新强制重扫 */
  private queuedScan: QueuedScan | null = null;
  private lastPublishDurationMs = 0;
  private lastResolvedTypeCount = 0;
  private lastPublishKind: 'full' | 'incremental' | 'mapping' = 'full';

  private constructor() {
    this.current = this.createEmptySnapshot(0);
  }

  static getInstance(): IndexCacheManager {
    if (!IndexCacheManager.instance) {
      IndexCacheManager.instance = new IndexCacheManager();
    }
    return IndexCacheManager.instance;
  }

  private isCacheEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('javaNavigator');
    return config.get<boolean>('cacheEnabled', true);
  }

  // ========== Generation管理 ==========

  /**
   * 开始新一代扫描
   * 返回generation号，扫描完成后调用commitGeneration发布
   */
  beginGeneration(): number {
    const generation = this.nextGeneration++;
    this.latestBegunGeneration = generation;
    return generation;
  }

  /**
   * 发布新一代索引
   * 仅当generation是最新的才生效，防止旧扫描覆盖新索引
   */
  commitGeneration(generation: number, build: IndexBuildInput): boolean {
    if (!this.isCacheEnabled() || generation !== this.latestBegunGeneration) {
      return false;
    }

    const startedAt = Date.now();
    const snapshot = this.createEmptySnapshot(generation);
    for (const typeSnapshot of build.typeSnapshots) {
      this.applyTypeSnapshot(snapshot, typeSnapshot);
    }
    const resolvedTypeCount = this.resolveTypeReferences(snapshot);
    snapshot.typeGraph = buildTypeGraph(snapshot.pathToType.values());
    for (const mapping of build.mappings ?? []) {
      this.applyMapping(snapshot, mapping);
    }
    snapshot.xmlNamespaces = createXmlNamespaceIndex(build.xmlNamespaces);

    // 构建期间可能同步触发新的generation，发布前再次确认所有权。
    if (generation !== this.latestBegunGeneration) {
      return false;
    }
    this.current = snapshot;
    this.lastResolvedTypeCount = resolvedTypeCount;
    this.lastPublishDurationMs = Date.now() - startedAt;
    this.lastPublishKind = 'full';
    return true;
  }

  /**
   * 全量发布的便捷接口。构建只遍历一次输入，不会为每个文件克隆完整Map。
   */
  publishGeneration(
    generation: number,
    typeSnapshots: Iterable<JavaTypeSnapshot>,
    mappings: Iterable<MapperMapping> = [],
    xmlNamespaces?: Iterable<readonly [string, Iterable<string>]>
  ): boolean {
    return this.commitGeneration(generation, {
      typeSnapshots,
      mappings,
      ...(xmlNamespaces === undefined ? {} : { xmlNamespaces })
    });
  }

  /**
   * 获取当前generation号
   */
  getCurrentGeneration(): number {
    return this.current.generation;
  }

  // ========== 共享扫描任务 ==========

  /**
   * 获取或创建共享扫描任务
   * 多个导航请求在索引未完成时等待同一个扫描Promise
   */
  getOrCreateScanTask(scanFn: () => Promise<void>, forceRescan = false): Promise<void> {
    if (!this.sharedScanPromise) {
      return this.startScanTask(scanFn);
    }

    if (!forceRescan) {
      return this.queuedScan?.promise ?? this.sharedScanPromise;
    }

    if (this.queuedScan) {
      this.queuedScan = { ...this.queuedScan, scanFn };
      return this.queuedScan.promise;
    }

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((onFulfilled, onRejected) => {
      resolve = onFulfilled;
      reject = onRejected;
    });
    this.queuedScan = { scanFn, promise, resolve, reject };
    return promise;
  }

  /**
   * 是否有扫描任务正在执行
   */
  isScanInProgress(): boolean {
    return this.sharedScanPromise !== null;
  }

  /**
   * 等待扫描完成
   */
  async waitForScan(): Promise<void> {
    while (this.sharedScanPromise) {
      await (this.queuedScan?.promise ?? this.sharedScanPromise);
    }
  }

  // ========== Java类型快照 ==========

  /**
   * 设置类型快照（增量更新）
   */
  setTypeSnapshot(snapshot: JavaTypeSnapshot): void {
    if (!this.isCacheEnabled()) return;

    const newSnapshot = this.cloneSnapshot();
    this.applyTypeSnapshot(newSnapshot, snapshot);
    this.publishIncrementalSnapshot(newSnapshot, true, true);
  }

  /**
   * 原子替换单个Java文件的类型及Mapper数据。undefined表示删除对应数据。
   */
  updateFile(
    javaPath: string,
    typeSnapshot?: JavaTypeSnapshot,
    mapping?: MapperMapping
  ): void {
    if (!this.isCacheEnabled()) return;
    if (typeSnapshot && typeSnapshot.filePath !== javaPath) {
      throw new Error(`类型快照路径与更新路径不一致: ${typeSnapshot.filePath}`);
    }
    if (mapping && mapping.javaPath !== javaPath) {
      throw new Error(`Mapper路径与更新路径不一致: ${mapping.javaPath}`);
    }

    const newSnapshot = this.cloneSnapshot();
    const replacedType = newSnapshot.pathToType.has(javaPath);
    this.removeTypeByPath(newSnapshot, javaPath);
    this.removeMappingByJavaPath(newSnapshot, javaPath);
    if (typeSnapshot) {
      this.applyTypeSnapshot(newSnapshot, typeSnapshot);
    }
    if (mapping) {
      this.applyMapping(newSnapshot, mapping);
    }
    this.publishIncrementalSnapshot(newSnapshot, true, replacedType || !!typeSnapshot);
  }

  /**
   * 通过FQN获取类型快照
   */
  getTypeByFqn(fqn: string): JavaTypeSnapshot | undefined {
    if (!this.isCacheEnabled()) return undefined;
    return this.current.fqnToType.get(fqn);
  }

  /**
   * 通过FQN获取全部类型候选。
   * 返回深复制快照，调用方不能修改已发布的索引。
   */
  getTypeCandidatesByFqn(fqn: string): JavaTypeSnapshot[] {
    if (!this.isCacheEnabled()) return [];
    return (this.current.fqnToTypes.get(fqn) ?? [])
      .map(snapshot => cloneJavaTypeSnapshot(snapshot));
  }

  /**
   * 通过文件路径获取类型快照
   */
  getTypeByPath(filePath: string): JavaTypeSnapshot | undefined {
    if (!this.isCacheEnabled()) return undefined;
    return this.current.pathToType.get(filePath);
  }

  /**
   * 通过接口FQN查找所有具体实现类（递归，沿子类型图展开抽象类）
   */
  findConcreteImplementations(interfaceFqn: string): JavaTypeSnapshot[] {
    return findConcreteImplementations(this.current.typeGraph, this.current.pathToType, interfaceFqn);
  }

  /**
   * 通过父类FQN查找所有具体子类（递归展开抽象类）
   */
  findConcreteDescendants(classFqn: string): JavaTypeSnapshot[] {
    return findConcreteDescendants(this.current.typeGraph, this.current.pathToType, classFqn);
  }

  // ========== Mapper映射缓存 ==========

  setMapping(mapping: MapperMapping): void {
    if (!this.isCacheEnabled()) return;

    const newSnapshot = this.cloneSnapshot();
    this.applyMapping(newSnapshot, mapping);
    this.publishIncrementalSnapshot(newSnapshot, false);
  }

  getByJavaPath(javaPath: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) return undefined;
    return this.current.javaToMapping.get(javaPath);
  }

  getByXmlPath(xmlPath: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) return undefined;
    const candidates = this.current.xmlToMappings.get(xmlPath) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  getByXmlPathCandidates(xmlPath: string): MapperMapping[] {
    if (!this.isCacheEnabled()) return [];
    return (this.current.xmlToMappings.get(xmlPath) ?? []).map(mapping => cloneMapperMapping(mapping));
  }

  getByNamespace(namespace: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) return undefined;
    const candidates = this.current.namespaceToMappings.get(namespace) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  getByNamespaceCandidates(namespace: string): MapperMapping[] {
    if (!this.isCacheEnabled()) return [];
    return (this.current.namespaceToMappings.get(namespace) ?? []).map(mapping => cloneMapperMapping(mapping));
  }

  getByClassName(className: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) return undefined;
    const candidates = this.current.classNameToMappings.get(className) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  getByClassNameCandidates(className: string): MapperMapping[] {
    if (!this.isCacheEnabled()) return [];
    return (this.current.classNameToMappings.get(className) ?? []).map(mapping => cloneMapperMapping(mapping));
  }

  /** 全量XML namespace索引是否可用于替代动态工作区扫描。 */
  isXmlNamespaceIndexComplete(): boolean {
    return this.isCacheEnabled() && this.current.xmlNamespaces.complete;
  }

  /** 返回namespace对应的全部XML路径，调用方不能修改已发布快照。 */
  getXmlPathsByNamespace(namespace: string): string[] {
    if (!this.isCacheEnabled()) return [];
    return getXmlPathsByNamespace(this.current.xmlNamespaces, namespace);
  }

  /** namespace是否在完整XML索引中存在至少一个候选。 */
  hasIndexedXmlPaths(namespace: string): boolean {
    return this.isXmlNamespaceIndexComplete() &&
      hasXmlPathsByNamespace(this.current.xmlNamespaces, namespace);
  }

  /**
   * 增量维护单个XML路径的namespace。namespace为undefined时移除该路径。
   * 文件状态变更必须使正在执行的全量扫描失效，避免旧扫描覆盖新路径。
   */
  updateXmlNamespace(xmlPath: string, namespace?: string): void {
    if (!this.isCacheEnabled()) return;

    const snapshot = this.cloneSnapshot();
    snapshot.xmlNamespaces = updateXmlNamespace(snapshot.xmlNamespaces, xmlPath, namespace);
    this.publishIncrementalSnapshot(snapshot, true);
  }

  /** 仅解除XML与Java Mapper映射，不影响独立维护的namespace索引。 */
  clearMappingsForXmlPath(xmlPath: string): void {
    if (!this.isCacheEnabled()) return;

    const snapshot = this.cloneSnapshot();
    this.clearMappingsAtXmlPath(snapshot, xmlPath);
    this.publishIncrementalSnapshot(snapshot, false);
  }

  removeMapping(javaPath: string): void {
    const mapping = this.current.javaToMapping.get(javaPath);
    if (!mapping) return;

    const newSnapshot = this.cloneSnapshot();
    newSnapshot.javaToMapping.delete(javaPath);
    this.removeMappingReverseKeys(newSnapshot, mapping);
    this.publishIncrementalSnapshot(newSnapshot, false);
  }

  updateXmlPath(javaPath: string, xmlPath: string): void {
    if (!this.isCacheEnabled()) return;

    const oldMapping = this.current.javaToMapping.get(javaPath);
    if (!oldMapping) return;

    const newMapping = cloneMapperMapping({
      ...oldMapping,
      xmlPath
    });

    const newSnapshot = this.cloneSnapshot();

    this.removeXmlPathMapping(newSnapshot, oldMapping.xmlPath, oldMapping);
    newSnapshot.javaToMapping.set(javaPath, newMapping);
    this.addXmlPathMapping(newSnapshot, newMapping);
    this.replaceNamespaceMapping(newSnapshot, oldMapping.namespace, oldMapping, newMapping);
    this.replaceClassNameMapping(newSnapshot, oldMapping.className, oldMapping, newMapping);
    this.publishIncrementalSnapshot(newSnapshot, false);
  }

  clearXmlPath(javaPath: string): void {
    if (!this.isCacheEnabled()) return;
    const oldMapping = this.current.javaToMapping.get(javaPath);
    if (!oldMapping?.xmlPath) return;

    const newMapping = cloneMapperMapping({ ...oldMapping, xmlPath: undefined });
    const newSnapshot = this.cloneSnapshot();
    this.removeXmlPathMapping(newSnapshot, oldMapping.xmlPath, oldMapping);
    newSnapshot.javaToMapping.set(javaPath, newMapping);
    this.replaceNamespaceMapping(newSnapshot, oldMapping.namespace, oldMapping, newMapping);
    this.replaceClassNameMapping(newSnapshot, oldMapping.className, oldMapping, newMapping);
    this.publishIncrementalSnapshot(newSnapshot, false);
  }

  // ========== 向后兼容的接口缓存方法 ==========
  // 类型索引未覆盖时保留回退扫描结果；任何类型变更都会使其失效。

  setInterfaceImplementations(interfaceName: string, implementations: string[]): void {
    if (!this.isCacheEnabled()) return;
    const snapshot = this.cloneSnapshot();
    snapshot.interfaceImplementationFallbacks.set(interfaceName, [...implementations]);
    this.publishIncrementalSnapshot(snapshot, false);
  }

  getInterfaceImplementations(interfaceName: string): string[] | undefined {
    // 从类型快照派生实现列表
    const impls = this.findConcreteImplementations(interfaceName);
    return impls.length > 0
      ? impls.map(i => i.filePath)
      : this.current.interfaceImplementationFallbacks.get(interfaceName);
  }

  setInterfaceFiles(interfaceName: string, files: string[]): void {
    if (!this.isCacheEnabled()) return;
    const snapshot = this.cloneSnapshot();
    snapshot.interfaceFileFallbacks.set(interfaceName, [...files]);
    this.publishIncrementalSnapshot(snapshot, false);
  }

  getInterfaceFiles(interfaceName: string): string[] | undefined {
    const exactFiles = (this.current.fqnToTypes.get(interfaceName) ?? [])
      .filter(type => type.kind === 'interface')
      .map(type => type.filePath);
    if (exactFiles.length > 0) return exactFiles;

    const simpleName = interfaceName.substring(interfaceName.lastIndexOf('.') + 1);
    const files: string[] = [];
    for (const type of this.current.pathToType.values()) {
      if (type.kind === 'interface' && type.className === simpleName) {
        files.push(type.filePath);
      }
    }
    return files.length > 0 ? files : this.current.interfaceFileFallbacks.get(interfaceName);
  }

  // ========== 缓存失效 ==========

  invalidateForFile(filePath: string): void {
    if (!this.isCacheEnabled()) return;

    const newSnapshot = this.cloneSnapshot();

    // 移除类型快照
    const typeSnapshot = newSnapshot.pathToType.get(filePath);
    if (typeSnapshot) {
      this.removeTypeByPath(newSnapshot, filePath);
    }

    // 移除Mapper映射
    if (filePath.endsWith('.java')) {
      const mapping = newSnapshot.javaToMapping.get(filePath);
      if (mapping) {
        newSnapshot.javaToMapping.delete(filePath);
        this.removeMappingReverseKeys(newSnapshot, mapping);
      }
    } else if (filePath.endsWith('.xml')) {
      newSnapshot.xmlNamespaces = removeXmlNamespacePath(newSnapshot.xmlNamespaces, filePath);
      this.clearMappingsAtXmlPath(newSnapshot, filePath);
    }

    this.publishIncrementalSnapshot(newSnapshot, true, !!typeSnapshot);
  }

  clearAll(): void {
    const generation = this.beginGeneration();
    this.current = this.createEmptySnapshot(generation);
    this.lastPublishDurationMs = 0;
    this.lastResolvedTypeCount = 0;
    this.lastPublishKind = 'full';
  }

  // ========== 诊断 ==========

  getDiagnostics(): object {
    return {
      cacheEnabled: this.isCacheEnabled(),
      generation: this.current.generation,
      latestBegunGeneration: this.latestBegunGeneration,
      typeSnapshots: this.current.fqnToType.size,
      typeSnapshotCandidates: Array.from(this.current.fqnToTypes.values())
        .reduce((count, candidates) => count + candidates.length, 0),
      pathToType: this.current.pathToType.size,
      javaToMapping: this.current.javaToMapping.size,
      xmlToMappings: this.current.xmlToMappings.size,
      xmlMappingCandidates: Array.from(this.current.xmlToMappings.values())
        .reduce((count, candidates) => count + candidates.length, 0),
      namespaceToMappings: this.current.namespaceToMappings.size,
      namespaceMappingCandidates: Array.from(this.current.namespaceToMappings.values())
        .reduce((count, candidates) => count + candidates.length, 0),
      xmlNamespaceIndexComplete: this.current.xmlNamespaces.complete,
      xmlNamespaceCount: this.current.xmlNamespaces.namespaceToPaths.size,
      xmlNamespacePathCount: Array.from(this.current.xmlNamespaces.namespaceToPaths.values())
        .reduce((count, paths) => count + paths.length, 0),
      classNameToMappings: this.current.classNameToMappings.size,
      classNameMappingCandidates: Array.from(this.current.classNameToMappings.values())
        .reduce((count, candidates) => count + candidates.length, 0),
      scanInProgress: this.isScanInProgress()
      ,lastPublishDurationMs: this.lastPublishDurationMs
      ,lastResolvedTypeCount: this.lastResolvedTypeCount
      ,lastPublishKind: this.lastPublishKind
    };
  }

  // ========== 内部工具方法 ==========

  private createEmptySnapshot(generation: number): IndexSnapshot {
    return {
      generation,
      fqnToType: new Map(),
      fqnToTypes: new Map(),
      pathToType: new Map(),
      javaToMapping: new Map(),
      xmlToMappings: new Map(),
      namespaceToMappings: new Map(),
      classNameToMappings: new Map(),
      xmlNamespaces: createXmlNamespaceIndex(),
      interfaceImplementationFallbacks: new Map(),
      interfaceFileFallbacks: new Map(),
      typeGraph: buildTypeGraph([])
    };
  }

  /**
   * 浅克隆当前快照（Map的新引用，但元素共享）
   * 不可变更新模式：修改前克隆，修改后替换
   */
  private cloneSnapshot(): IndexSnapshot {
    return {
      generation: this.current.generation,
      fqnToType: new Map(this.current.fqnToType),
      fqnToTypes: new Map(
        Array.from(this.current.fqnToTypes, ([fqn, snapshots]) => [fqn, [...snapshots]])
      ),
      pathToType: new Map(this.current.pathToType),
      javaToMapping: new Map(this.current.javaToMapping),
      xmlToMappings: new Map(
        Array.from(this.current.xmlToMappings, ([xmlPath, mappings]) => [xmlPath, [...mappings]])
      ),
      namespaceToMappings: new Map(
        Array.from(this.current.namespaceToMappings, ([namespace, mappings]) => [namespace, [...mappings]])
      ),
      classNameToMappings: new Map(
        Array.from(this.current.classNameToMappings, ([className, mappings]) => [className, [...mappings]])
      ),
      xmlNamespaces: cloneXmlNamespaceIndex(this.current.xmlNamespaces),
      interfaceImplementationFallbacks: new Map(
        Array.from(this.current.interfaceImplementationFallbacks, ([interfaceName, implementations]) => [
          interfaceName,
          [...implementations]
        ])
      ),
      interfaceFileFallbacks: new Map(
        Array.from(this.current.interfaceFileFallbacks, ([interfaceName, files]) => [interfaceName, [...files]])
      ),
      typeGraph: this.current.typeGraph
    };
  }

  private startScanTask(scanFn: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(scanFn);
    this.sharedScanPromise = task;
    task.then(
      () => this.finishScanTask(task),
      () => this.finishScanTask(task)
    );
    return task;
  }

  private finishScanTask(completedTask: Promise<void>): void {
    if (this.sharedScanPromise !== completedTask) return;

    const queued = this.queuedScan;
    this.queuedScan = null;
    if (!queued) {
      this.sharedScanPromise = null;
      return;
    }

    const nextTask = this.startScanTask(queued.scanFn);
    nextTask.then(queued.resolve, queued.reject);
  }

  /** 发布增量变更；只有真实文件变化才使已开始的全量扫描失效。 */
  private publishIncrementalSnapshot(
    snapshot: IndexSnapshot,
    invalidateRunningScan: boolean,
    resolveTypes = false
  ): void {
    const startedAt = Date.now();
    const resolvedTypeCount = resolveTypes ? this.resolveTypeReferences(snapshot) : 0;
    if (resolveTypes) {
      snapshot.typeGraph = buildTypeGraph(snapshot.pathToType.values());
      snapshot.interfaceImplementationFallbacks.clear();
      snapshot.interfaceFileFallbacks.clear();
    }
    const generation = invalidateRunningScan ? this.beginGeneration() : this.current.generation;
    this.current = { ...snapshot, generation };
    this.lastResolvedTypeCount = resolvedTypeCount;
    this.lastPublishDurationMs = Date.now() - startedAt;
    this.lastPublishKind = resolveTypes ? 'incremental' : 'mapping';
  }

  /** 使用完整类型集合解析按需导入，无法唯一确定时保留 unresolved 标记。 */
  private resolveTypeReferences(index: IndexSnapshot): number {
    const availableFqns = new Set(index.fqnToType.keys());
    const currentTypes = [...index.pathToType.values()];
    for (const currentType of currentTypes) {
      const resolveReference = (reference: string): string => {
        const arraySuffix = reference.endsWith('[]') ? '[]'.repeat((reference.match(/\[\]/g) ?? []).length) : '';
        const baseReference = arraySuffix ? reference.slice(0, -arraySuffix.length) : reference;
        const simpleName = baseReference.substring(baseReference.lastIndexOf('.') + 1);
        if (!baseReference.startsWith('__unresolved__.')) return reference;

        const explicitImport = currentType.explicitImports.find(item => item.endsWith(`.${simpleName}`));
        if (explicitImport) return `${explicitImport}${arraySuffix}`;

        const samePackage = currentType.packageName
          ? `${currentType.packageName}.${simpleName}`
          : simpleName;
        if (availableFqns.has(samePackage)) return `${samePackage}${arraySuffix}`;

        const candidates = currentType.wildcardImports
          .map(importPath => `${importPath}.${simpleName}`)
          .filter(candidate => availableFqns.has(candidate));
        const uniqueCandidates = [...new Set(candidates)];
        return uniqueCandidates.length === 1
          ? `${uniqueCandidates[0]}${arraySuffix}`
          : `__unresolved__.${simpleName}${arraySuffix}`;
      };

      const resolvedType = cloneJavaTypeSnapshot({
        ...currentType,
        superClass: currentType.rawSuperClass
          ? resolveReference(currentType.rawSuperClass)
          : currentType.superClass,
        interfaces: (currentType.rawInterfaces ?? currentType.interfaces).map(resolveReference),
        methods: currentType.methods.map(method => ({
          ...method,
          parameterTypes: (method.rawParameterTypes ?? method.parameterTypes).map(resolveReference)
        }))
      });
      const candidates = index.fqnToTypes.get(resolvedType.fqn) ?? [];
      index.fqnToTypes.set(
        resolvedType.fqn,
        candidates.map(candidate => candidate.filePath === resolvedType.filePath ? resolvedType : candidate)
      );
      index.pathToType.set(resolvedType.filePath, resolvedType);
      if (index.fqnToType.get(resolvedType.fqn)?.filePath === resolvedType.filePath) {
        index.fqnToType.set(resolvedType.fqn, resolvedType);
      }
    }
    return currentTypes.length;
  }

  private applyTypeSnapshot(index: IndexSnapshot, input: JavaTypeSnapshot): void {
    const snapshot = cloneJavaTypeSnapshot(input);
    const oldByPath = index.pathToType.get(snapshot.filePath);
    if (oldByPath) {
      this.removeTypeByPath(index, snapshot.filePath);
    }

    const candidates = index.fqnToTypes.get(snapshot.fqn) ?? [];
    index.fqnToTypes.set(
      snapshot.fqn,
      [...candidates.filter(candidate => candidate.filePath !== snapshot.filePath), snapshot]
    );
    index.fqnToType.set(snapshot.fqn, snapshot);
    index.pathToType.set(snapshot.filePath, snapshot);
  }

  private removeTypeByPath(index: IndexSnapshot, filePath: string): void {
    const snapshot = index.pathToType.get(filePath);
    if (!snapshot) return;
    const candidates = index.fqnToTypes.get(snapshot.fqn) ?? [];
    const remaining = candidates.filter(candidate => candidate.filePath !== filePath);
    if (remaining.length === 0) {
      index.fqnToTypes.delete(snapshot.fqn);
    } else {
      index.fqnToTypes.set(snapshot.fqn, remaining);
    }

    if (index.fqnToType.get(snapshot.fqn)?.filePath === filePath) {
      if (remaining.length === 0) {
        index.fqnToType.delete(snapshot.fqn);
      } else {
        index.fqnToType.set(snapshot.fqn, remaining[remaining.length - 1]);
      }
    }
    index.pathToType.delete(filePath);
  }

  private applyMapping(index: IndexSnapshot, input: MapperMapping): void {
    const mapping = cloneMapperMapping(input);
    const oldMapping = index.javaToMapping.get(mapping.javaPath);
    if (oldMapping) {
      this.removeMappingReverseKeys(index, oldMapping);
    }

    index.javaToMapping.set(mapping.javaPath, mapping);
    this.addXmlPathMapping(index, mapping);
    this.addNamespaceMapping(index, mapping);
    this.addClassNameMapping(index, mapping);
  }

  private removeMappingByJavaPath(index: IndexSnapshot, javaPath: string): void {
    const mapping = index.javaToMapping.get(javaPath);
    if (!mapping) return;
    index.javaToMapping.delete(javaPath);
    this.removeMappingReverseKeys(index, mapping);
  }

  private removeMappingReverseKeys(index: IndexSnapshot, mapping: MapperMapping): void {
    this.removeXmlPathMapping(index, mapping.xmlPath, mapping);
    this.removeNamespaceMapping(index, mapping.namespace, mapping);
    this.removeClassNameMapping(index, mapping.className, mapping);
  }

  private clearMappingsAtXmlPath(index: IndexSnapshot, xmlPath: string): void {
    const mappings = index.xmlToMappings.get(xmlPath) ?? [];
    for (const mapping of mappings) {
      const newMapping = cloneMapperMapping({ ...mapping, xmlPath: undefined });
      index.javaToMapping.set(mapping.javaPath, newMapping);
      this.replaceNamespaceMapping(index, mapping.namespace, mapping, newMapping);
      this.replaceClassNameMapping(index, mapping.className, mapping, newMapping);
    }
    index.xmlToMappings.delete(xmlPath);
  }

  private addXmlPathMapping(index: IndexSnapshot, mapping: MapperMapping): void {
    if (!mapping.xmlPath) return;
    const candidates = index.xmlToMappings.get(mapping.xmlPath) ?? [];
    index.xmlToMappings.set(
      mapping.xmlPath,
      [...candidates.filter(candidate => candidate.javaPath !== mapping.javaPath), mapping]
    );
  }

  private removeXmlPathMapping(index: IndexSnapshot, xmlPath: string | undefined, owner: MapperMapping): void {
    if (!xmlPath) return;
    const candidates = index.xmlToMappings.get(xmlPath);
    if (!candidates) return;
    const remaining = candidates.filter(candidate => candidate.javaPath !== owner.javaPath);
    if (remaining.length === 0) index.xmlToMappings.delete(xmlPath);
    else index.xmlToMappings.set(xmlPath, remaining);
  }

  private addNamespaceMapping(index: IndexSnapshot, mapping: MapperMapping): void {
    const candidates = index.namespaceToMappings.get(mapping.namespace) ?? [];
    index.namespaceToMappings.set(
      mapping.namespace,
      [...candidates.filter(candidate => candidate.javaPath !== mapping.javaPath), mapping]
    );
  }

  private removeNamespaceMapping(index: IndexSnapshot, namespace: string, owner: MapperMapping): void {
    const candidates = index.namespaceToMappings.get(namespace);
    if (!candidates) return;
    const remaining = candidates.filter(candidate => candidate.javaPath !== owner.javaPath);
    if (remaining.length === 0) index.namespaceToMappings.delete(namespace);
    else index.namespaceToMappings.set(namespace, remaining);
  }

  private replaceNamespaceMapping(
    index: IndexSnapshot,
    namespace: string,
    oldOwner: MapperMapping,
    newOwner: MapperMapping
  ): void {
    const candidates = index.namespaceToMappings.get(namespace) ?? [];
    index.namespaceToMappings.set(namespace, candidates.map(candidate =>
      candidate.javaPath === oldOwner.javaPath ? newOwner : candidate
    ));
  }

  private addClassNameMapping(index: IndexSnapshot, mapping: MapperMapping): void {
    const candidates = index.classNameToMappings.get(mapping.className) ?? [];
    index.classNameToMappings.set(
      mapping.className,
      [...candidates.filter(candidate => candidate.javaPath !== mapping.javaPath), mapping]
    );
  }

  private removeClassNameMapping(index: IndexSnapshot, className: string, owner: MapperMapping): void {
    const candidates = index.classNameToMappings.get(className);
    if (!candidates) return;
    const remaining = candidates.filter(candidate => candidate.javaPath !== owner.javaPath);
    if (remaining.length === 0) index.classNameToMappings.delete(className);
    else index.classNameToMappings.set(className, remaining);
  }

  private replaceClassNameMapping(
    index: IndexSnapshot,
    className: string,
    oldOwner: MapperMapping,
    newOwner: MapperMapping
  ): void {
    const candidates = index.classNameToMappings.get(className) ?? [];
    index.classNameToMappings.set(className, candidates.map(candidate =>
      candidate.javaPath === oldOwner.javaPath ? newOwner : candidate
    ));
  }

}
