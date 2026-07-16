/** 统一处理语义优先、源码索引后备的 Java 与 MyBatis 导航。 */
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { JavaLanguageService } from '../utils/javaLanguageService';
import { Logger } from '../utils/logger';
import { InterfaceNavigator } from './interfaceNavigator';
import { JavaMethodResolver } from './javaMethodResolver';
import { getNoTargetMessage, getPickerTitle, JavaJumpType as JumpType } from './javaNavigationMessages';
import { resolveCurrentConcreteImplementations } from './javaTypeRelationResolver';
import { openFileAtPosition, readFileContent } from '../utils/fileUtils';
import { JavaNavigationRequest } from '../types';

interface Candidate {
  filePath: string;
  score: number;
  isAbstract?: boolean;
  hasMethod?: boolean;
  position?: { line: number; column: number };
  label?: string;
}

type ProviderLocation = vscode.Location | vscode.LocationLink | vscode.Uri;
export class UnifiedNavigator {
  private static instance: UnifiedNavigator;
  private cache: IndexCacheManager;
  private logger: Logger;
  private interfaceNavigator: InterfaceNavigator;
  private javaLanguageService: JavaLanguageService;

  private constructor() {
    this.cache = IndexCacheManager.getInstance();
    this.logger = Logger.getInstance();
    this.interfaceNavigator = InterfaceNavigator.getInstance();
    this.javaLanguageService = JavaLanguageService.getInstance();
  }

  static getInstance(): UnifiedNavigator {
    if (!UnifiedNavigator.instance) {
      UnifiedNavigator.instance = new UnifiedNavigator();
    }
    return UnifiedNavigator.instance;
  }

  async hasTarget(request: JavaNavigationRequest): Promise<boolean> {
    await this.cache.waitForScan();
    const sourcePath = vscode.Uri.parse(request.uri).fsPath;
    const jumpType = this.requestToJumpType(request);
    const methodName = request.level === 'method' ? request.methodSignature?.name : undefined;
    return (await this.findCandidates(sourcePath, jumpType, methodName, request)).length > 0;
  }

  async probeImplementationTargets(
    typeRequest: JavaNavigationRequest,
    methodRequests: JavaNavigationRequest[]
  ): Promise<{ hasTypeTarget: boolean; methodTargets: boolean[] }> {
    await this.cache.waitForScan();
    const sourcePath = vscode.Uri.parse(typeRequest.uri).fsPath;
    const typeCandidates = await this.findImplementations(sourcePath, typeRequest);
    const methodTargets = await Promise.all(methodRequests.map(async request => {
      const methodName = request.methodSignature?.name;
      if (!methodName) return false;
      return (await this.findMethodImplementations(
        sourcePath,
        methodName,
        request,
        typeCandidates
      )).length > 0;
    }));
    return { hasTypeTarget: typeCandidates.length > 0, methodTargets };
  }

  async probeInterfaceTargets(
    typeRequest: JavaNavigationRequest,
    methodRequests: JavaNavigationRequest[]
  ): Promise<{ hasTypeTarget: boolean; methodTargets: boolean[] }> {
    await this.cache.waitForScan();
    const sourcePath = vscode.Uri.parse(typeRequest.uri).fsPath;
    const typeCandidates = await this.findInterfaces(sourcePath, typeRequest);
    const methodTargets = await Promise.all(methodRequests.map(async request => {
      const methodName = request.methodSignature?.name;
      if (!methodName) return false;
      return (await this.findMethodInterfaces(
        sourcePath,
        methodName,
        request,
        typeCandidates
      )).length > 0;
    }));
    return { hasTypeTarget: typeCandidates.length > 0, methodTargets };
  }

  async jump(
    sourcePathOrRequest: string | JavaNavigationRequest,
    type?: JumpType,
    targetName?: string
  ): Promise<boolean> {
    let sourcePath: string;
    let jumpType: JumpType;
    let methodName: string | undefined;
    let request: JavaNavigationRequest | undefined;

    if (typeof sourcePathOrRequest === 'object') {
      request = sourcePathOrRequest;
      sourcePath = vscode.Uri.parse(request.uri).fsPath;
      jumpType = this.requestToJumpType(request);
      if (request.level === 'method' && request.methodSignature) {
        methodName = request.methodSignature.name;
      }
    } else {
      sourcePath = sourcePathOrRequest;
      jumpType = type ?? 'interface-to-impl';
      methodName = targetName;
    }

    this.logger.info(`[UnifiedNavigator] ${jumpType}: ${sourcePath}${methodName ? ` -> ${methodName}` : ''}`);

    try {
      await this.cache.waitForScan();

      const candidates = await this.findCandidates(sourcePath, jumpType, methodName, request);

      if (candidates.length === 0) {
        vscode.window.showInformationMessage(getNoTargetMessage(jumpType, methodName));
        return false;
      }

      const selectedCandidate = candidates.length === 1
        ? candidates[0]
        : await this.showCandidatePicker(candidates, jumpType, methodName);

      if (!selectedCandidate) return false;

      const position = selectedCandidate.position ?? await this.calculatePosition(selectedCandidate.filePath, methodName);
      await openFileAtPosition(selectedCandidate.filePath, position);

      return true;
    } catch (error) {
      this.logger.error('[UnifiedNavigator] 跳转失败:', error);
      const detail = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `${getPickerTitle(jumpType, methodName).replace('选择', '跳转')}失败: ${detail}`);
      return false;
    }
  }

  private requestToJumpType(request: JavaNavigationRequest): JumpType {
    if (request.direction === 'to-impl') {
      return request.level === 'method' ? 'interface-method-to-impl' : 'interface-to-impl';
    } else {
      return request.level === 'method' ? 'impl-method-to-interface' : 'impl-to-interface';
    }
  }

  private async findCandidates(
    sourcePath: string,
    type: JumpType,
    targetName?: string,
    request?: JavaNavigationRequest
  ): Promise<Candidate[]> {
    switch (type) {
      case 'interface-to-impl':
        return this.findImplementations(sourcePath, request);
      case 'impl-to-interface':
        return this.findInterfaces(sourcePath, request);
      case 'interface-method-to-impl':
        return targetName ? this.findMethodImplementations(sourcePath, targetName, request) : [];
      case 'impl-method-to-interface':
        return targetName ? this.findMethodInterfaces(sourcePath, targetName, request) : [];
      default:
        return [];
    }
  }

  private async findImplementations(
    interfacePath: string,
    request?: JavaNavigationRequest,
    fallbackCandidates?: Candidate[]
  ): Promise<Candidate[]> {
    const semanticCandidates = await this.findImplementationsSemantic(interfacePath, request);
    if (semanticCandidates.length > 0) {
      this.logger.info(`[findImplementations] 语义导航找到 ${semanticCandidates.length} 个实现`);
      return semanticCandidates;
    }

    this.logger.info('[findImplementations] 语义导航无结果，使用源码索引后备');
    return fallbackCandidates ?? this.findImplementationsFromIndex(interfacePath);
  }

  private async findImplementationsSemantic(
    interfacePath: string,
    request?: JavaNavigationRequest
  ): Promise<Candidate[]> {
    if (!this.javaLanguageService.canUseJavaLanguageServer()) return [];

    try {
      const uri = request
        ? vscode.Uri.parse(request.uri)
        : vscode.Uri.file(interfacePath);
      const position = request?.position ?? await this.calculateClassPosition(interfacePath);

      if (!position) return [];

      const locations = await vscode.commands.executeCommand<ProviderLocation[]>(
        'vscode.executeImplementationProvider',
        uri,
        new vscode.Position(position.line, position.column)
      );

      if (!locations || locations.length === 0) return [];

      const candidates: Candidate[] = [];
      for (const loc of locations) {
        const normalized = this.normalizeProviderLocation(loc);
        if (!normalized) continue;
        const { filePath, position } = normalized;
        const content = await readFileContent(filePath);
        const snapshot = content ? JavaParser.createTypeSnapshot(content, filePath) : undefined;
        const isAbstract = !snapshot || snapshot.kind === 'interface' || snapshot.isAbstract;

        candidates.push({
          filePath,
          score: 0,
          isAbstract,
          position,
          label: path.basename(filePath, '.java')
        });
      }

      return request?.level === 'method'
        ? this.deduplicateCandidates(candidates)
        : this.expandAbstractImplementations(candidates);
    } catch (error) {
      this.logger.debug('[findImplementationsSemantic] 语义导航失败:', error);
      return [];
    }
  }

  private async expandAbstractImplementations(candidates: Candidate[]): Promise<Candidate[]> {
    const result: Candidate[] = [];
    const queue = [...candidates];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) continue;
      const key = `${candidate.filePath}:${candidate.position?.line ?? -1}:${candidate.position?.column ?? -1}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (!candidate.isAbstract) {
        result.push(candidate);
        continue;
      }

      const snapshot = this.cache.getTypeByPath(candidate.filePath);
      const descendants = snapshot
        ? this.cache.findConcreteDescendants(snapshot.fqn)
        : [];
      for (const descendant of descendants) {
        queue.push({
          filePath: descendant.filePath,
          score: 0,
          isAbstract: false,
          position: await this.calculateClassPosition(descendant.filePath),
          label: descendant.className
        });
      }

      if (descendants.length > 0 || !this.javaLanguageService.canUseJavaLanguageServer()) continue;

      const position = candidate.position ?? await this.calculateClassPosition(candidate.filePath);
      if (!position) continue;
      try {
        const locations = await vscode.commands.executeCommand<ProviderLocation[]>(
          'vscode.executeImplementationProvider',
          vscode.Uri.file(candidate.filePath),
          new vscode.Position(position.line, position.column)
        ) ?? [];
        for (const location of locations) {
          const normalized = this.normalizeProviderLocation(location);
          if (!normalized) continue;
          const content = await readFileContent(normalized.filePath);
          const snapshot = content
            ? JavaParser.createTypeSnapshot(content, normalized.filePath)
            : undefined;
          queue.push({
            filePath: normalized.filePath,
            score: 0,
            isAbstract: !snapshot || snapshot.kind === 'interface' || snapshot.isAbstract,
            position: normalized.position,
            label: path.basename(normalized.filePath, '.java')
          });
        }
      } catch (error) {
        this.logger.debug('[expandAbstractImplementations] 展开抽象实现失败:', error);
      }
    }

    return this.deduplicateCandidates(result);
  }

  private async findImplementationsFromIndex(interfacePath: string): Promise<Candidate[]> {
    const content = await readFileContent(interfacePath);
    if (!content) return [];

    const interfaceName = JavaParser.extractClassName(content);
    if (!interfaceName) return [];

    const sourceSnapshot = JavaParser.createTypeSnapshot(content, interfacePath);
    const cachedSource = this.cache.getTypeByPath(interfacePath);
    const snapshot = cachedSource?.fqn === sourceSnapshot.fqn ? cachedSource : undefined;
    const indexedImpls = snapshot ? this.cache.findConcreteImplementations(snapshot.fqn) : [];
    const currentImpls = await resolveCurrentConcreteImplementations(
      indexedImpls,
      sourceSnapshot.fqn,
      this.cache
    );
    const currentCandidates: Candidate[] = [];
    for (const impl of currentImpls) {
      currentCandidates.push({
        filePath: impl.filePath,
        score: 0,
        isAbstract: false,
        position: await this.calculateClassPosition(impl.filePath),
        label: impl.className
      });
    }
    if (currentCandidates.length > 0) return currentCandidates;

    const implPaths = await this.interfaceNavigator.findImplementations(interfaceName);
    const candidates: Candidate[] = [];
    const sourceFqn = sourceSnapshot.fqn;
    const fallbackSnapshots: ReturnType<typeof JavaParser.createTypeSnapshot>[] = [];
    for (const implPath of implPaths) {
      const implContent = await readFileContent(implPath);
      if (implContent) fallbackSnapshots.push(JavaParser.createTypeSnapshot(implContent, implPath));
    }
    const byFqn = new Map(fallbackSnapshots.map(item => [item.fqn, item]));
    const bySimpleName = new Map(fallbackSnapshots.map(item => [item.className, item]));
    const implementsTarget = (item: typeof fallbackSnapshots[number], visited = new Set<string>()): boolean => {
      if (visited.has(item.fqn)) return false;
      visited.add(item.fqn);
      const declaresTarget = item.interfaces.some(interfaceFqn => interfaceFqn === sourceFqn);
      if (declaresTarget) return true;
      if (!item.superClass) return false;
      const parent = byFqn.get(item.superClass) ??
        bySimpleName.get(item.superClass.substring(item.superClass.lastIndexOf('.') + 1));
      return parent ? implementsTarget(parent, visited) : false;
    };

    for (const implSnapshot of fallbackSnapshots) {
      if (implSnapshot.isAbstract || !implementsTarget(implSnapshot)) continue;
      const position = await this.calculateClassPosition(implSnapshot.filePath);
      candidates.push({
        filePath: implSnapshot.filePath,
        score: 0,
        isAbstract: false,
        position,
        label: implSnapshot.className
      });
    }
    return candidates;
  }

  private async findInterfaces(
    classPath: string,
    request?: JavaNavigationRequest
  ): Promise<Candidate[]> {
    const semanticCandidates = await this.findInterfacesSemantic(classPath, request);
    if (semanticCandidates.length > 0) {
      this.logger.info(`[findInterfaces] 语义导航找到 ${semanticCandidates.length} 个接口`);
      return semanticCandidates;
    }

    this.logger.info('[findInterfaces] 语义导航无结果，使用源码索引后备');
    return this.findInterfacesFromIndex(classPath);
  }

  private async findInterfacesSemantic(
    classPath: string,
    request?: JavaNavigationRequest
  ): Promise<Candidate[]> {
    if (!this.javaLanguageService.canUseJavaLanguageServer()) return [];

    try {
      const uri = request
        ? vscode.Uri.parse(request.uri)
        : vscode.Uri.file(classPath);
      const position = request?.level === 'type'
        ? request.position
        : await this.calculateClassPosition(classPath);

      if (!position) return [];

      try {
        const prepared = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
          'vscode.prepareTypeHierarchy',
          uri,
          new vscode.Position(position.line, position.column)
        );

        if (prepared && prepared.length > 0) {
          const candidates: Candidate[] = [];
          const queue = [...prepared];
          const visited = new Set<string>();
          while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            const key = `${current.uri.toString()}:${current.selectionRange.start.line}:${current.selectionRange.start.character}`;
            if (visited.has(key)) continue;
            visited.add(key);

            const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
              'vscode.provideSupertypes',
              current
            ) ?? [];
            for (const item of supertypes) {
              queue.push(item);
              if (!item.uri.fsPath.endsWith('.java')) continue;
              const itemContent = await readFileContent(item.uri.fsPath);
              if (!itemContent || !JavaParser.isJavaInterface(itemContent)) continue;
              candidates.push({
                filePath: item.uri.fsPath,
                score: 0,
                position: {
                  line: item.selectionRange.start.line,
                  column: item.selectionRange.start.character
                },
                label: item.name
              });
            }
          }
          if (candidates.length > 0) return this.deduplicateCandidates(candidates);
        }
      } catch {
      }

      const typeInfo = await this.javaLanguageService.getTypeDetails(uri);
      if (typeInfo && typeInfo.interfaces.length > 0) {
        const candidates: Candidate[] = [];
        for (const ifaceName of typeInfo.interfaces) {
          const files = await this.interfaceNavigator.findInterfaceFiles(ifaceName);
          for (const file of files) {
            const pos = await this.calculateClassPosition(file);
            candidates.push({
              filePath: file,
              score: 0,
              position: pos,
              label: path.basename(file, '.java')
            });
          }
        }
        return candidates;
      }

      return [];
    } catch (error) {
      this.logger.debug('[findInterfacesSemantic] 语义导航失败:', error);
      return [];
    }
  }

  private async findInterfacesFromIndex(classPath: string): Promise<Candidate[]> {
    const content = await readFileContent(classPath);
    if (!content) return [];

    const candidates: Candidate[] = [];
    const indexedType = this.cache.getTypeByPath(classPath);

    if (indexedType) {
      const pendingInterfaces = [...indexedType.interfaces];
      const pendingSupertypes = indexedType.superClass ? [indexedType.superClass] : [];
      const visitedSupertypes = new Set<string>();

      while (pendingSupertypes.length > 0) {
        const parentFqn = pendingSupertypes.shift();
        if (!parentFqn || visitedSupertypes.has(parentFqn)) continue;
        visitedSupertypes.add(parentFqn);
        for (const parentType of this.cache.getTypeCandidatesByFqn(parentFqn)) {
          pendingInterfaces.push(...parentType.interfaces);
          if (parentType.superClass) pendingSupertypes.push(parentType.superClass);
        }
      }

      const visitedInterfaces = new Set<string>();
      while (pendingInterfaces.length > 0) {
        const interfaceFqn = pendingInterfaces.shift();
        if (!interfaceFqn || visitedInterfaces.has(interfaceFqn)) continue;
        visitedInterfaces.add(interfaceFqn);
        for (const intf of this.cache.getTypeCandidatesByFqn(interfaceFqn)) {
          if (intf.kind !== 'interface') continue;
          pendingInterfaces.push(...intf.interfaces);
          candidates.push({
            filePath: intf.filePath,
            score: 0,
            position: await this.calculateClassPosition(intf.filePath),
            label: intf.className
          });
        }
      }

      if (candidates.length > 0) {
        return this.deduplicateCandidates(candidates);
      }
    }

    const interfaces = JavaParser.createTypeSnapshot(content, classPath).interfaces;

    for (const intf of interfaces) {
      if (intf.startsWith('__extends:')) continue;

      const simpleName = intf.substring(intf.lastIndexOf('.') + 1);

      const indexedInterfaces = this.cache.getTypeCandidatesByFqn(intf)
        .filter(snapshot => snapshot.kind === 'interface');
      if (indexedInterfaces.length > 0) {
        for (const snapshot of indexedInterfaces) {
          const pos = await this.calculateClassPosition(snapshot.filePath);
          candidates.push({
            filePath: snapshot.filePath,
            score: 0,
            position: pos,
            label: snapshot.className
          });
        }
        continue;
      }

      const files = await this.interfaceNavigator.findInterfaceFiles(simpleName);
      for (const file of files) {
        const fileContent = await readFileContent(file);
        if (!fileContent) continue;

        const packageName = JavaParser.extractPackageName(fileContent);
        const fullName = packageName ? `${packageName}.${simpleName}` : simpleName;
        const hasResolvedFqn = intf.includes('.') && !intf.startsWith('__unresolved__.');
        if (hasResolvedFqn && fullName !== intf) continue;

        const pos = await this.calculateClassPosition(file);
        candidates.push({
          filePath: file,
          score: 0,
          position: pos,
          label: simpleName
        });
      }
    }

    return this.deduplicateCandidates(candidates);
  }

  private async findMethodImplementations(
    interfacePath: string,
    methodName: string,
    request?: JavaNavigationRequest,
    fallbackCandidates?: Candidate[]
  ): Promise<Candidate[]> {
    const impls = await this.findImplementations(interfacePath, request, fallbackCandidates);
    const candidates: Candidate[] = [];
    const parsedSignature = await JavaMethodResolver.getSignatureFromFile(
      interfacePath, methodName, request?.position
    );
    const signature = JavaMethodResolver.selectSignature(request?.methodSignature, parsedSignature);
    const queue = [...impls];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const impl = queue.shift();
      if (!impl || visited.has(impl.filePath)) continue;
      visited.add(impl.filePath);
      const content = await readFileContent(impl.filePath);
      const hasMethod = content && (signature
        ? JavaMethodResolver.contentHasSignature(content, impl.filePath, signature)
        : JavaParser.containsImplementedMethod(content, methodName));
      const isConcreteMethod = content && (signature
        ? JavaMethodResolver.contentHasConcreteSignature(content, impl.filePath, signature)
        : JavaParser.containsImplementedMethod(content, methodName));
      if (hasMethod && isConcreteMethod) {
        const methodPos = await JavaMethodResolver.findPosition(impl.filePath, methodName, signature);
        candidates.push({
          ...impl,
          hasMethod: true,
          position: methodPos ?? impl.position
        });
      } else if (impl.isAbstract) {
        const snapshot = this.cache.getTypeByPath(impl.filePath);
        const descendants = snapshot ? this.cache.findConcreteDescendants(snapshot.fqn) : [];
        for (const descendant of descendants) {
          queue.push({
            filePath: descendant.filePath,
            score: 0,
            isAbstract: false,
            position: await this.calculateClassPosition(descendant.filePath),
            label: descendant.className
          });
        }
        if (descendants.length === 0 && this.javaLanguageService.canUseJavaLanguageServer()) {
          const position = impl.position ?? await JavaMethodResolver.findPosition(
            impl.filePath, methodName, signature
          );
          if (!position) continue;
          const locations = await vscode.commands.executeCommand<ProviderLocation[]>(
            'vscode.executeImplementationProvider',
            vscode.Uri.file(impl.filePath),
            new vscode.Position(position.line, position.column)
          ) ?? [];
          for (const location of locations) {
            const normalized = this.normalizeProviderLocation(location);
            if (!normalized) continue;
            const descendantContent = await readFileContent(normalized.filePath);
            queue.push({
              filePath: normalized.filePath,
              score: 0,
              isAbstract: descendantContent ? JavaParser.isAbstractClass(descendantContent) : false,
              position: normalized.position,
              label: path.basename(normalized.filePath, '.java')
            });
          }
        }
      }
    }
    return candidates;
  }

  private async findMethodInterfaces(
    classPath: string,
    methodName: string,
    request?: JavaNavigationRequest,
    knownInterfaces?: Candidate[]
  ): Promise<Candidate[]> {
    const interfaces = knownInterfaces ?? await this.findInterfaces(classPath, request);
    const candidates: Candidate[] = [];
    const parsedSignature = await JavaMethodResolver.getSignatureFromFile(
      classPath,
      methodName,
      request?.position
    );
    const methodSignature = JavaMethodResolver.selectSignature(request?.methodSignature, parsedSignature);

    for (const intf of interfaces) {
      const content = await readFileContent(intf.filePath);
      if (!content) continue;

      const hasMatchingMethod = methodSignature
        ? JavaMethodResolver.contentHasSignature(content, intf.filePath, methodSignature)
        : JavaParser.containsMethod(content, methodName);

      if (hasMatchingMethod) {
        const methodPos = await JavaMethodResolver.findPosition(intf.filePath, methodName, methodSignature);
        candidates.push({
          ...intf,
          hasMethod: true,
          position: methodPos ?? intf.position
        });
      }
    }

    return candidates;
  }

  private async showCandidatePicker(
    candidates: Candidate[],
    type: JumpType,
    targetName?: string
  ): Promise<Candidate | null> {
    const items = candidates.map(c => ({
      label: c.label || path.basename(c.filePath),
      description: `匹配度: ${c.score}${c.isAbstract ? ' (抽象类)' : ''}`,
      detail: c.filePath,
      candidate: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: getPickerTitle(type, targetName)
    });

    return selected?.candidate || null;
  }

  private async calculateClassPosition(filePath: string): Promise<{ line: number; column: number } | undefined> {
    const content = await readFileContent(filePath);
    if (!content) return undefined;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed === '') continue;
      const match = line.match(/\b(class|interface|enum)\s+(\w+)/);
      if (match) {
        const classNameIndex = line.indexOf(match[2]);
        return { line: i, column: classNameIndex >= 0 ? classNameIndex : 0 };
      }
    }
    return undefined;
  }

  private async calculatePosition(
    filePath: string,
    targetName?: string
  ): Promise<{ line: number; column: number } | undefined> {
    if (!targetName) {
      return this.calculateClassPosition(filePath);
    }

    const content = await readFileContent(filePath);
    if (!content) return undefined;

    return JavaMethodResolver.findPosition(filePath, targetName);
  }

  private normalizeProviderLocation(location: ProviderLocation): {
    filePath: string;
    position: { line: number; column: number };
  } | undefined {
    if (location instanceof vscode.Location) {
      return {
        filePath: location.uri.fsPath,
        position: { line: location.range.start.line, column: location.range.start.character }
      };
    }
    if (location instanceof vscode.Uri) {
      return { filePath: location.fsPath, position: { line: 0, column: 0 } };
    }
    if ('targetUri' in location) {
      const range = location.targetSelectionRange ?? location.targetRange;
      return {
        filePath: location.targetUri.fsPath,
        position: {
          line: range.start.line,
          column: range.start.character
        }
      };
    }
    return undefined;
  }

  private deduplicateCandidates(candidates: Candidate[]): Candidate[] {
    const seen = new Set<string>();
    return candidates.filter(candidate => {
      const key = `${candidate.filePath}:${candidate.position?.line ?? -1}:${candidate.position?.column ?? -1}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

}
