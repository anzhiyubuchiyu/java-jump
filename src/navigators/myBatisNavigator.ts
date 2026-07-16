/**
 * MyBatis导航器
 * 处理Mapper Java接口与XML文件之间的跳转 - 精简版
 * 核心逻辑已迁移至 UnifiedNavigator，此类仅保留XML查找相关的辅助方法
 */

import * as vscode from 'vscode';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { XmlParser } from '../utils/xmlParser';
import { Logger } from '../utils/logger';
import { PathMatcher } from '../utils/pathMatcher';
import { JavaTypeSnapshot, MapperMapping, MethodMapping } from '../types';
import { getUnifiedExcludePattern, readFileContent } from '../utils/fileUtils';

export class MyBatisNavigator {
  private static instance: MyBatisNavigator;
  private cache: IndexCacheManager;
  private xmlParser: XmlParser;
  private logger: Logger;

  private constructor() {
    this.cache = IndexCacheManager.getInstance();
    this.xmlParser = XmlParser.getInstance();
    this.logger = Logger.getInstance();
  }

  static getInstance(): MyBatisNavigator {
    if (!MyBatisNavigator.instance) {
      MyBatisNavigator.instance = new MyBatisNavigator();
    }
    return MyBatisNavigator.instance;
  }

  /**
   * 动态解析Java文件并创建映射
   */
  private async parseAndMapJavaFile(
    javaPath: string,
    expectedNamespace?: string,
    cacheResult = true
  ): Promise<MapperMapping | null> {
    const content = await readFileContent(javaPath);
    if (!content) return null;

    const javaInfo = JavaParser.parseContent(content, javaPath);
    if (!javaInfo.className) return null;
    const fullClassName = javaInfo.packageName
      ? `${javaInfo.packageName}.${javaInfo.className}`
      : javaInfo.className;
    if (expectedNamespace && fullClassName !== expectedNamespace) return null;

    const mapping = this.createJavaMapping(javaPath, javaInfo);

    const xmlPaths = await this.findXmlByNamespace(fullClassName, javaPath, true);
    const xmlPath = PathMatcher.selectUniqueBestMatch(javaPath, xmlPaths);
    if (xmlPath) {
      mapping.xmlPath = xmlPath;
      const xmlInfo = await this.parseXmlAtPath(xmlPath);
      if (xmlInfo) {
        for (const sql of xmlInfo.sqlElements) {
          const methodMapping = mapping.methods.get(sql.id);
          if (methodMapping) {
            methodMapping.xmlPosition = { line: sql.line, column: sql.column };
            methodMapping.sqlType = sql.type;
          }
        }
      }
    }

    const openDocument = vscode.workspace.textDocuments
      .find(document => document.uri.fsPath === javaPath);
    const dirtyXml = mapping.xmlPath
      ? vscode.workspace.textDocuments.some(document =>
          document.uri.fsPath === mapping.xmlPath && document.isDirty)
      : false;
    const isIndexCandidate = !!mapping.xmlPath || !!expectedNamespace || javaInfo.isMapper;
    if (cacheResult && isIndexCandidate && !openDocument?.isDirty && !dirtyXml) {
      this.cache.setMapping(mapping);
    }
    return mapping;
  }

  /**
   * 通过namespace查找XML文件
   */
  async findXmlByNamespace(
    namespace: string,
    javaPath?: string,
    skipCache = false
  ): Promise<string[]> {
    // 完整XML namespace索引已经覆盖磁盘文件，避免每次CodeLens/导航都全仓扫描。
    // 打开文档仍以编辑器文本为准，特别是脏文档可覆盖磁盘索引结果。
    if (this.cache.isXmlNamespaceIndexComplete()) {
      const indexedPaths = await this.findIndexedXmlPathsByNamespace(namespace);
      return this.sortPaths(javaPath, indexedPaths);
    }

    const directMapping = !skipCache && javaPath ? this.cache.getByJavaPath(javaPath) : undefined;
    const directPaths: string[] = [];
    if (directMapping?.namespace === namespace && directMapping.xmlPath) {
      const directXml = await this.parseXmlAtPath(directMapping.xmlPath);
      if (directXml?.namespace === namespace) directPaths.push(directMapping.xmlPath);
    }

    const openPaths = this.findOpenXmlPathsByNamespace(namespace);
    const initialPaths = [...new Set([...directPaths, ...openPaths])];

    const className = namespace.substring(namespace.lastIndexOf('.') + 1);
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return this.sortPaths(javaPath, initialPaths);

    const config = vscode.workspace.getConfiguration('javaNavigator');
    const configuredPatterns = config.get<unknown>('mapperPatterns', [
      { searchPaths: ['src/main/resources/mapper', 'src/main/resources/mappers', 'src/main/resources/xml'] }
    ]);

    const excludePattern = getUnifiedExcludePattern();
    const possiblePatterns: string[] = [];

    const mapperPatterns = Array.isArray(configuredPatterns) ? configuredPatterns : [];
    for (const pattern of mapperPatterns) {
      const searchPaths = pattern && typeof pattern === 'object' &&
        Array.isArray((pattern as { searchPaths?: unknown }).searchPaths)
        ? (pattern as { searchPaths: unknown[] }).searchPaths
        : [];
      for (const searchPath of searchPaths) {
        if (typeof searchPath !== 'string' || !searchPath) continue;
        possiblePatterns.push(`**/${searchPath}/**/${className}.xml`);
      }
    }

    possiblePatterns.push(
      `**/mapper/**/${className}.xml`,
      `**/mappers/**/${className}.xml`,
      `**/resources/**/${className}.xml`,
      `**/xml/**/${className}.xml`,
      `**/${className}.xml`
    );

    const matchedFiles: Array<{ path: string; matchedNamespace: boolean }> = initialPaths
      .map(filePath => ({ path: filePath, matchedNamespace: true }));
    const seenPaths = new Set(initialPaths);

    const scanPatterns = async (patterns: string[]): Promise<void> => {
      for (const folder of workspaceFolders) {
        for (const pattern of patterns) {
          try {
            const files = await vscode.workspace.findFiles(
              new vscode.RelativePattern(folder, pattern),
              excludePattern
            );

            for (const file of files) {
              if (seenPaths.has(file.fsPath)) continue;
              seenPaths.add(file.fsPath);

              const xmlInfo = await this.parseXmlAtPath(file.fsPath);
              const matchedNamespace = xmlInfo?.namespace === namespace;
              if (matchedNamespace) {
                matchedFiles.push({ path: file.fsPath, matchedNamespace });
              }
            }
          } catch (error) {
            this.logger.debug(`[findXmlByNamespace] Failed to search files:`, error);
          }
        }
      }
    };

    await scanPatterns(possiblePatterns);
    await scanPatterns(['**/*.xml']);

    const eligibleFiles = matchedFiles.map(file => file.path);
    return this.sortPaths(javaPath, eligibleFiles, path => matchedFiles.find(file => file.path === path)?.matchedNamespace ?? false);
  }

  /** 使用缓存候选，同时以打开文档文本覆盖对应磁盘索引。 */
  private async findIndexedXmlPathsByNamespace(namespace: string): Promise<string[]> {
    const paths = new Set(this.cache.getXmlPathsByNamespace(namespace));
    for (const openPath of this.findOpenXmlPathsByNamespace(namespace)) {
      paths.add(openPath);
    }

    const matchedPaths: string[] = [];
    for (const xmlPath of paths) {
      const xmlInfo = await this.parseXmlAtPath(xmlPath);
      if (xmlInfo?.namespace === namespace) {
        matchedPaths.push(xmlPath);
      }
    }
    return matchedPaths;
  }

  /**
   * 所有打开XML都参与当前请求，但绝不写入持久索引。
   * 这既补充新建未保存文档，也能使脏文档的namespace覆盖磁盘缓存。
   */
  private findOpenXmlPathsByNamespace(namespace: string): string[] {
    return vscode.workspace.textDocuments.flatMap(document => {
      if (!document.uri.fsPath.toLowerCase().endsWith('.xml')) return [];
      const xmlInfo = this.xmlParser.parseXmlContentFromText(document.getText(), document.uri.fsPath);
      return xmlInfo?.namespace === namespace ? [document.uri.fsPath] : [];
    });
  }

  async findJavaCandidatesByNamespace(
    namespace: string,
    xmlPath?: string,
    cacheResult = true
  ): Promise<MapperMapping[]> {
    const cached = this.cache.getByNamespaceCandidates(namespace);
    const openJavaDocuments = vscode.workspace.textDocuments
      .filter(document => document.uri.fsPath.endsWith('.java') && document.isDirty);
    const openPaths = new Set(openJavaDocuments.map(document => document.uri.fsPath));
    const liveMappings = openJavaDocuments.flatMap(document => {
      const javaInfo = JavaParser.parseContent(document.getText(), document.uri.fsPath);
      if (!javaInfo.className) return [];
      const fqn = javaInfo.packageName ? `${javaInfo.packageName}.${javaInfo.className}` : javaInfo.className;
      return fqn === namespace ? [this.createJavaMapping(document.uri.fsPath, javaInfo)] : [];
    });
    const currentCached = cached.filter(mapping => !openPaths.has(mapping.javaPath));
    const indexedTypeSnapshots = this.cache.getTypeCandidatesByFqn(namespace)
      .filter(snapshot => !openPaths.has(snapshot.filePath));
    const cachedByJavaPath = new Map(currentCached.map(mapping => [mapping.javaPath, mapping]));
    const indexedMappings = indexedTypeSnapshots.map(snapshot =>
      cachedByJavaPath.get(snapshot.filePath) ?? this.createJavaMappingFromSnapshot(snapshot)
    );
    const currentMappings = this.mergeMappings(currentCached, indexedMappings, liveMappings);

    // 全量类型索引已精确覆盖该 namespace 时无需再次扫描工作区；
    // 仅有旧 Mapper 映射而没有类型快照时，继续动态扫描以补齐其他模块候选。
    if (indexedMappings.length > 0) return this.sortMappings(xmlPath, currentMappings);

    const simpleClassName = namespace.substring(namespace.lastIndexOf('.') + 1);

    const searchPatterns = [`**/${simpleClassName}.java`];
    const excludePattern = getUnifiedExcludePattern();

    const candidates: MapperMapping[] = [...currentMappings];
    const seenPaths = new Set([...openPaths, ...currentMappings.map(mapping => mapping.javaPath)]);

    const scanPatterns = async (patterns: string[]): Promise<void> => {
      for (const pattern of patterns) {
        const files = await vscode.workspace.findFiles(pattern, excludePattern);

        for (const file of files) {
          if (seenPaths.has(file.fsPath)) continue;
          seenPaths.add(file.fsPath);
          const content = await readFileContent(file.fsPath);
          if (!content) continue;

          const mapping = await this.parseAndMapJavaFile(file.fsPath, namespace, cacheResult);
          if (mapping) candidates.push(mapping);
        }
      }
    };

    await scanPatterns(searchPatterns);
    await scanPatterns(['**/*.java']);

    return this.sortMappings(xmlPath, candidates);
  }

  async findJavaForXmlCandidates(
    xmlPath: string,
    liveContent?: string,
    isDirty = false
  ): Promise<MapperMapping[]> {
    this.logger.debug(`[MyBatisNavigator] 查找Java: ${xmlPath}`);

    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.fsPath === xmlPath);
    const currentContent = liveContent ?? openDocument?.getText();
    const currentDocumentIsDirty = isDirty || !!openDocument?.isDirty;
    const xmlInfo = currentContent !== undefined
      ? this.xmlParser.parseXmlContentFromText(currentContent, xmlPath)
      : await this.xmlParser.parseXmlMapper(xmlPath);
    if (!xmlInfo?.namespace) return [];

    const candidates = await this.findJavaCandidatesByNamespace(
      xmlInfo.namespace,
      xmlPath,
      !currentDocumentIsDirty
    );
    if (candidates.length === 1 && !currentDocumentIsDirty) {
      this.cache.updateXmlPath(candidates[0].javaPath, xmlPath);
    }
    return candidates;
  }

  private sortMappings(referencePath: string | undefined, mappings: MapperMapping[]): MapperMapping[] {
    const byJavaPath = new Map(mappings.map(mapping => [mapping.javaPath, mapping]));
    return [...byJavaPath.values()].sort((left, right) => {
      if (!referencePath) return left.javaPath.localeCompare(right.javaPath);
      const comparison = PathMatcher.compareMatchRanks(
        PathMatcher.createMatchRank(referencePath, left.javaPath),
        PathMatcher.createMatchRank(referencePath, right.javaPath)
      );
      return comparison || left.javaPath.localeCompare(right.javaPath);
    });
  }

  private sortPaths(
    referencePath: string | undefined,
    paths: string[],
    namespaceExact: (path: string) => boolean = () => true
  ): string[] {
    const uniquePaths = [...new Set(paths)];
    return uniquePaths.sort((left, right) => {
      if (!referencePath) return left.localeCompare(right);
      const comparison = PathMatcher.compareMatchRanks(
        PathMatcher.createMatchRank(referencePath, left, namespaceExact(left)),
        PathMatcher.createMatchRank(referencePath, right, namespaceExact(right))
      );
      return comparison || left.localeCompare(right);
    });
  }

  private async parseXmlAtPath(filePath: string) {
    const openDocument = vscode.workspace.textDocuments
      .find(document => document.uri.fsPath === filePath);
    return openDocument
      ? this.xmlParser.parseXmlContentFromText(openDocument.getText(), filePath)
      : this.xmlParser.parseXmlMapper(filePath);
  }

  private createJavaMapping(
    javaPath: string,
    javaInfo: ReturnType<typeof JavaParser.parseContent>
  ): MapperMapping {
    const namespace = javaInfo.packageName
      ? `${javaInfo.packageName}.${javaInfo.className}`
      : javaInfo.className;
    const methods = new Map<string, MethodMapping>(javaInfo.methods.map(method => [method.name, {
      name: method.name,
      javaPosition: { line: method.line, column: method.column }
    }]));
    return { javaPath, namespace, className: javaInfo.className, methods };
  }

  private createJavaMappingFromSnapshot(snapshot: JavaTypeSnapshot): MapperMapping {
    const methods = new Map<string, MethodMapping>(snapshot.methods.map(method => [method.name, {
      name: method.name,
      javaPosition: { line: method.line, column: method.column }
    }]));
    return {
      javaPath: snapshot.filePath,
      namespace: snapshot.fqn,
      className: snapshot.className,
      methods
    };
  }

  private mergeMappings(...groups: MapperMapping[][]): MapperMapping[] {
    const byJavaPath = new Map<string, MapperMapping>();
    for (const group of groups) {
      for (const mapping of group) {
        byJavaPath.set(mapping.javaPath, mapping);
      }
    }
    return [...byJavaPath.values()];
  }
}
