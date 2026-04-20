/**
 * MyBatis导航器
 * 处理Mapper Java接口与XML文件之间的跳转 - 精简版
 * 核心逻辑已迁移至 UnifiedNavigator，此类仅保留XML查找相关的辅助方法
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { XmlParser } from '../utils/xmlParser';
import { Logger } from '../utils/logger';
import { PathMatcher } from '../utils/pathMatcher';
import { MapperMapping, MethodMapping } from '../types';
import { getExcludePattern, readFileContent } from '../utils/fileUtils';

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
   * 从Java查找XML（纯查找，无UI操作）
   */
  async findXmlForJava(javaPath: string): Promise<string[]> {
    this.logger.debug(`[MyBatisNavigator] 查找XML: ${javaPath}`);

    let mapping = this.cache.getByJavaPath(javaPath);

    if (!mapping) {
      this.logger.info(`[MyBatisNavigator] No mapping found for ${javaPath}, trying dynamic parse...`);
      mapping = await this.parseAndMapJavaFile(javaPath) ?? undefined;
    }

    if (!mapping) {
      return [];
    }

    if (mapping.xmlPath) {
      return [mapping.xmlPath];
    }

    this.logger.info(`[MyBatisNavigator] No XML path, searching by namespace: ${mapping.namespace}`);
    return this.findXmlByNamespace(mapping.namespace, javaPath);
  }

  /**
   * 动态解析Java文件并创建映射
   */
  private async parseAndMapJavaFile(javaPath: string): Promise<MapperMapping | null> {
    const content = await readFileContent(javaPath);
    if (!content || !JavaParser.isMyBatisMapper(content, javaPath)) {
      return null;
    }

    const javaInfo = JavaParser.parseContent(content, javaPath);
    const fullClassName = javaInfo.packageName
      ? `${javaInfo.packageName}.${javaInfo.className}`
      : javaInfo.className;

    const methodsMap = new Map<string, MethodMapping>();
    for (const method of javaInfo.methods) {
      methodsMap.set(method.name, {
        name: method.name,
        javaPosition: { line: method.line, column: method.column }
      });
    }

    const mapping: MapperMapping = {
      javaPath,
      namespace: fullClassName,
      className: javaInfo.className,
      methods: methodsMap
    };

    const xmlPaths = await this.findXmlByNamespace(fullClassName, javaPath);
    if (xmlPaths.length > 0) {
      mapping.xmlPath = xmlPaths[0];
      const xmlInfo = await this.xmlParser.parseXmlMapper(xmlPaths[0]);
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

    this.cache.setMapping(mapping);
    return mapping;
  }

  /**
   * 通过namespace查找XML文件
   */
  async findXmlByNamespace(namespace: string, javaPath?: string): Promise<string[]> {
    const existingMapping = this.cache.getByNamespace(namespace);
    if (existingMapping?.xmlPath) {
      return [existingMapping.xmlPath];
    }

    const className = namespace.substring(namespace.lastIndexOf('.') + 1);
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];

    const config = vscode.workspace.getConfiguration('javaNavigator');
    const mapperPatterns = config.get<Array<{ searchPaths: string[] }>>('mapperPatterns', [
      { searchPaths: ['src/main/resources/mapper', 'src/main/resources/mappers', 'src/main/resources/xml'] }
    ]);

    const excludePattern = getExcludePattern();
    const possiblePatterns: string[] = [];

    for (const pattern of mapperPatterns) {
      for (const searchPath of pattern.searchPaths) {
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

    const matchedFiles: Array<{ path: string; matchedNamespace: boolean; similarityScore: number }> = [];
    const seenPaths = new Set<string>();

    for (const folder of workspaceFolders) {
      for (const pattern of possiblePatterns) {
        try {
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, pattern),
            excludePattern,
            10
          );

          for (const file of files) {
            if (seenPaths.has(file.fsPath)) continue;
            seenPaths.add(file.fsPath);

            const xmlInfo = await this.xmlParser.parseXmlMapper(file.fsPath);
            const matchedNamespace = xmlInfo?.namespace === namespace;
            const isFuzzyMatch = !xmlInfo?.namespace || xmlInfo.namespace === className;

            if (matchedNamespace || isFuzzyMatch) {
              const similarityScore = javaPath
                ? PathMatcher.calculateSimilarity(javaPath, file.fsPath)
                : 0;

              matchedFiles.push({ path: file.fsPath, matchedNamespace, similarityScore });
            }
          }
        } catch (error) {
          this.logger.debug(`[findXmlByNamespace] Failed to search files:`, error);
        }
      }
    }

    matchedFiles.sort((a, b) => {
      if (a.matchedNamespace !== b.matchedNamespace) {
        return a.matchedNamespace ? -1 : 1;
      }
      if (b.similarityScore !== a.similarityScore) {
        return b.similarityScore - a.similarityScore;
      }
      return a.path.localeCompare(b.path);
    });

    return matchedFiles.map(f => f.path);
  }

  /**
   * 通过namespace查找Java文件
   */
  async findJavaByNamespace(namespace: string, xmlPath?: string): Promise<MapperMapping | null> {
    const mapping = this.cache.getByClassName(namespace);
    if (mapping) return mapping;

    const simpleClassName = namespace.substring(namespace.lastIndexOf('.') + 1);
    const searchPatterns = [`**/${simpleClassName}.java`, `**/*${simpleClassName}*.java`];
    const excludePattern = getExcludePattern();

    const candidates: Array<{ filePath: string; similarityScore: number }> = [];

    for (const pattern of searchPatterns) {
      const files = await vscode.workspace.findFiles(pattern, excludePattern, 10);

      for (const file of files) {
        const content = await readFileContent(file.fsPath);
        if (!content) continue;

        const packageMatch = content.match(/package\s+([^;]+);/);
        const actualPackage = packageMatch ? packageMatch[1] : '';
        const fullClassName = actualPackage
          ? `${actualPackage}.${simpleClassName}`
          : simpleClassName;

        if (fullClassName === namespace) {
          const similarityScore = xmlPath
            ? PathMatcher.calculateSimilarity(xmlPath, file.fsPath)
            : 0;
          candidates.push({ filePath: file.fsPath, similarityScore });
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.similarityScore - a.similarityScore);
      return this.parseAndMapJavaFile(candidates[0].filePath);
    }

    return null;
  }

  /**
   * 从XML查找Java（纯查找，无UI操作）
   */
  async findJavaForXml(xmlPath: string): Promise<MapperMapping | null> {
    this.logger.debug(`[MyBatisNavigator] 查找Java: ${xmlPath}`);

    let mapping = this.cache.getByXmlPath(xmlPath);

    if (!mapping) {
      const xmlInfo = await this.xmlParser.parseXmlMapper(xmlPath);
      if (!xmlInfo?.namespace) {
        return null;
      }

      mapping = this.cache.getByNamespace(xmlInfo.namespace);

      if (!mapping) {
        mapping = await this.findJavaByNamespace(xmlInfo.namespace, xmlPath) ?? undefined;
        if (mapping) {
          this.cache.updateXmlPath(mapping.javaPath, xmlPath);
        }
      }
    }

    return mapping || null;
  }

  /**
   * 获取XML文件的显示路径
   */
  getXmlDisplayPath(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    const fileName = parts[parts.length - 1];

    const srcIndex = parts.findIndex(p => p === 'src');
    if (srcIndex > 0) {
      const moduleName = parts[srcIndex - 1];
      const relativePath = parts.slice(srcIndex - 1).join('/');
      return `${moduleName} › ${relativePath}`;
    }

    if (parts.length >= 3) {
      return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${fileName}`;
    }

    return fileName;
  }
}
