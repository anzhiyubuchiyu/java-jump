/**
 * 统一导航服务
 *
 * 融合 Java 接口实现跳转与 MyBatis Mapper XML 导航的统一入口
 * 统一处理所有跳转场景：
 * - a1: 接口类 → 实现类
 * - a2: 实现类 → 接口
 * - a3: 接口方法 → 实现方法
 * - a4: 实现方法 → 接口定义
 * - b1: Mapper类 → XML文件
 * - b2: XML文件 → Mapper类
 * - b3: Mapper方法 → SQL标签
 * - b4: SQL标签 → Mapper方法
 *
 * 核心设计原则：
 * 1. 统一的路径匹配算法（PathMatcher.calculateSimilarity）
 * 2. 统一的候选评分与选择逻辑
 * 3. 统一的错误处理和日志记录
 * 4. 内联选择逻辑（移除 SmartSelector 依赖）
 * 5. 支持 @Primary 注解优先选择
 *
 * 架构演进：
 * - 2026-03-06: 移除 SmartSelector 和 BaseNavigator 依赖，内联选择逻辑
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { XmlParser } from '../utils/xmlParser';
import { PathMatcher } from '../utils/pathMatcher';
import { Logger } from '../utils/logger';
import { MyBatisNavigator } from './myBatisNavigator';
import { InterfaceNavigator } from './interfaceNavigator';
import { openFileAtPosition, readFileContent, getExcludePattern } from '../utils/fileUtils';

/** 跳转类型 */
type JumpType =
  | 'interface-to-impl'
  | 'impl-to-interface'
  | 'interface-method-to-impl'
  | 'impl-method-to-interface'
  | 'mapper-to-xml'
  | 'xml-to-mapper'
  | 'mapper-method-to-sql'
  | 'sql-to-mapper-method';

/** 候选文件 */
interface Candidate {
  filePath: string;
  score: number;
  isAbstract?: boolean;
  hasMethod?: boolean;
  position?: { line: number; column: number };
}

export class UnifiedNavigator {
  private static instance: UnifiedNavigator;
  private cache: IndexCacheManager;
  private xmlParser: XmlParser;
  private logger: Logger;
  private myBatisNavigator: MyBatisNavigator;
  private interfaceNavigator: InterfaceNavigator;

  private readonly AUTO_SELECT_THRESHOLD = 20;
  private readonly MAX_CANDIDATES = 10;

  private constructor() {
    this.cache = IndexCacheManager.getInstance();
    this.xmlParser = XmlParser.getInstance();
    this.logger = Logger.getInstance();
    this.myBatisNavigator = MyBatisNavigator.getInstance();
    this.interfaceNavigator = InterfaceNavigator.getInstance();
  }

  static getInstance(): UnifiedNavigator {
    if (!UnifiedNavigator.instance) {
      UnifiedNavigator.instance = new UnifiedNavigator();
    }
    return UnifiedNavigator.instance;
  }

  /**
   * 统一跳转接口
   */
  async jump(
    sourcePath: string,
    type: JumpType,
    targetName?: string
  ): Promise<boolean> {
    this.logger.info(`[UnifiedNavigator] ${type}: ${sourcePath}${targetName ? ` -> ${targetName}` : ''}`);

    try {
      const candidates = await this.findCandidates(sourcePath, type, targetName);

      if (candidates.length === 0) {
        vscode.window.showInformationMessage(this.getNoTargetMessage(type, targetName));
        return false;
      }

      const scored = this.scoreCandidates(sourcePath, candidates);
      const selectedCandidate = await this.smartSelectCandidate(scored, type, targetName);

      if (!selectedCandidate) {
        return false;
      }

      // 优先使用候选对象中的位置信息
      const position = selectedCandidate.position ?? await this.calculatePosition(selectedCandidate.filePath, type, targetName);
      await openFileAtPosition(selectedCandidate.filePath, position);

      return true;

    } catch (error) {
      this.logger.error('[UnifiedNavigator] 跳转失败:', error);
      vscode.window.showErrorMessage('跳转失败');
      return false;
    }
  }

  /**
   * 查找候选文件
   */
  private async findCandidates(
    sourcePath: string,
    type: JumpType,
    targetName?: string
  ): Promise<Candidate[]> {
    switch (type) {
      case 'interface-to-impl':
        return this.findImplementations(sourcePath);
      case 'impl-to-interface':
        return this.findInterfaces(sourcePath);
      case 'interface-method-to-impl':
        return this.findMethodImplementations(sourcePath, targetName!);
      case 'impl-method-to-interface':
        return this.findMethodInterfaces(sourcePath, targetName!);
      case 'mapper-to-xml':
        return this.findXmlForMapper(sourcePath);
      case 'xml-to-mapper':
        return this.findMapperForXml(sourcePath);
      case 'mapper-method-to-sql':
        return this.findSqlForMethod(sourcePath, targetName!);
      case 'sql-to-mapper-method':
        return this.findMethodForSql(sourcePath, targetName!);
      default:
        return [];
    }
  }

  // === 接口相关查找 ===

  private async findImplementations(interfacePath: string): Promise<Candidate[]> {
    const content = await readFileContent(interfacePath);
    if (!content) return [];

    const interfaceName = JavaParser.extractClassName(content);
    if (!interfaceName) return [];

    const impls = await this.interfaceNavigator.findImplementations(interfaceName);
    const candidates: Candidate[] = [];

    for (const implPath of impls) {
      const implContent = await readFileContent(implPath);
      if (!implContent) continue;

      // 计算类声明位置
      const position = await this.calculateClassPosition(implPath);

      candidates.push({
        filePath: implPath,
        score: 0,
        isAbstract: JavaParser.isAbstractClass(implContent),
        position
      });
    }

    return candidates;
  }

  private async findInterfaces(classPath: string): Promise<Candidate[]> {
    const content = await readFileContent(classPath);
    if (!content) return [];

    // 使用异步版本提取接口，自动过滤系统接口
    const fileUri = vscode.Uri.file(classPath);
    const interfaces = await JavaParser.extractImplementedInterfacesAsync(content, fileUri);
    const candidates: Candidate[] = [];

    for (const intf of interfaces) {
      if (intf.startsWith('__extends:')) continue;

      const simpleName = intf.includes('.') ? intf.split('.').pop()! : intf;
      const files = await this.interfaceNavigator.findInterfaceFiles(simpleName);

      for (const file of files) {
        const fileContent = await readFileContent(file);
        if (!fileContent) continue;

        const packageName = JavaParser.extractPackageName(fileContent);
        const fullName = packageName ? `${packageName}.${simpleName}` : simpleName;
        if (fullName !== intf && simpleName !== intf) continue;

        // 计算类声明位置
        const position = await this.calculateClassPosition(file);

        candidates.push({
          filePath: file,
          score: 0,
          position
        });
      }
    }

    return candidates;
  }

  private async findMethodImplementations(
    interfacePath: string,
    methodName: string
  ): Promise<Candidate[]> {
    const impls = await this.findImplementations(interfacePath);
    const candidates: Candidate[] = [];

    for (const impl of impls) {
      const content = await readFileContent(impl.filePath);
      if (content && JavaParser.containsImplementedMethod(content, methodName)) {
        candidates.push({
          filePath: impl.filePath,
          score: 0,
          isAbstract: impl.isAbstract,
          hasMethod: true
        });
      }
    }

    return candidates;
  }

  private async findMethodInterfaces(
    classPath: string,
    methodName: string
  ): Promise<Candidate[]> {
    const interfaces = await this.findInterfaces(classPath);
    const candidates: Candidate[] = [];

    for (const intf of interfaces) {
      const content = await readFileContent(intf.filePath);
      if (content && JavaParser.containsMethod(content, methodName)) {
        candidates.push({
          filePath: intf.filePath,
          score: 0,
          hasMethod: true
        });
      }
    }

    return candidates;
  }

  // === Mapper相关查找 ===

  private async findXmlForMapper(mapperPath: string): Promise<Candidate[]> {
    const xmlPaths = await this.myBatisNavigator.findXmlForJava(mapperPath);
    return xmlPaths.map(filePath => ({ filePath, score: 0 }));
  }

  private async findMapperForXml(xmlPath: string): Promise<Candidate[]> {
    const mapping = await this.myBatisNavigator.findJavaForXml(xmlPath);
    return mapping ? [{ filePath: mapping.javaPath, score: 0 }] : [];
  }

  private async findSqlForMethod(
    mapperPath: string,
    methodName: string
  ): Promise<Candidate[]> {
    this.logger.debug(`[findSqlForMethod] 查找方法 ${methodName} 对应的SQL`);
    const xmlCandidates = await this.findXmlForMapper(mapperPath);
    const candidates: Candidate[] = [];

    for (const xml of xmlCandidates) {
      const xmlInfo = await this.xmlParser.parseXmlMapper(xml.filePath);
      const sqlElement = xmlInfo?.sqlElements.find(s => s.id === methodName);

      if (sqlElement) {
        this.logger.debug(`[findSqlForMethod] 找到SQL元素: ${methodName} at line ${sqlElement.line}`);
        candidates.push({
          filePath: xml.filePath,
          score: 0,
          hasMethod: true,
          position: { line: sqlElement.line, column: sqlElement.column }
        });
      }
    }

    return candidates;
  }

  private async findMethodForSql(
    xmlPath: string,
    sqlId: string
  ): Promise<Candidate[]> {
    this.logger.debug(`[findMethodForSql] 查找SQL ${sqlId} 对应的方法`);
    const mapperCandidates = await this.findMapperForXml(xmlPath);
    const candidates: Candidate[] = [];

    for (const mapper of mapperCandidates) {
      const content = await readFileContent(mapper.filePath);
      if (!content || !JavaParser.containsMethod(content, sqlId)) {
        continue;
      }

      // 解析Java文件获取方法位置
      const javaInfo = JavaParser.parseContent(content, mapper.filePath);
      const method = javaInfo.methods.find(m => m.name === sqlId);

      if (method) {
        this.logger.debug(`[findMethodForSql] 找到方法: ${sqlId} at line ${method.line}`);
      }

      candidates.push({
        filePath: mapper.filePath,
        score: 0,
        hasMethod: true,
        position: method ? { line: method.line, column: method.column } : undefined
      });
    }

    return candidates;
  }

  // === 候选评分与选择 ===

  private scoreCandidates(sourcePath: string, candidates: Candidate[]): Candidate[] {
    return candidates
      .map(c => ({
        ...c,
        score: PathMatcher.calculateSimilarity(sourcePath, c.filePath)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.MAX_CANDIDATES);
  }

  private async smartSelectCandidate(
    candidates: Candidate[],
    type: JumpType,
    targetName?: string
  ): Promise<Candidate | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const best = candidates[0];
    const second = candidates[1];

    // 实现→接口：直接跳转
    if (type === 'impl-to-interface' || type === 'impl-method-to-interface') {
      this.logger.debug(`[smartSelect] 实现→接口，直接选择: ${best.filePath}`);
      return best;
    }

    // 接口→实现：根据目录决定
    if (type === 'interface-to-impl' || type === 'interface-method-to-impl') {
      const normalizePath = (p: string) => p.toLowerCase().replace(/\\/g, '/');
      const bestDir = normalizePath(path.dirname(best.filePath));

      const sameDirCandidates = candidates.filter(c =>
        normalizePath(path.dirname(c.filePath)) === bestDir
      );

      if (sameDirCandidates.length > 1) {
        const primaryCandidate = await this.findPrimaryCandidate(sameDirCandidates);
        if (primaryCandidate) {
          this.logger.info(`[smartSelect] 找到@Primary注解的实现类: ${primaryCandidate.filePath}`);
          return primaryCandidate;
        }
        return this.showCandidatePicker(sameDirCandidates, type, targetName);
      }

      return best;
    }

    // Mapper↔XML：按分数差异决定
    if (best.score - second.score >= this.AUTO_SELECT_THRESHOLD) {
      return best;
    }

    const bestModule = PathMatcher.extractModuleName(best.filePath);
    const secondModule = PathMatcher.extractModuleName(second.filePath);

    if (bestModule === secondModule && bestModule !== '') {
      return this.showCandidatePicker(candidates, type, targetName);
    }

    return best;
  }

  private async findPrimaryCandidate(candidates: Candidate[]): Promise<Candidate | null> {
    for (const candidate of candidates) {
      const content = await readFileContent(candidate.filePath);
      if (content && /@Primary\b|@org\.springframework\.context\.annotation\.Primary\b/.test(content)) {
        return candidate;
      }
    }
    return null;
  }

  private async showCandidatePicker(
    candidates: Candidate[],
    type: JumpType,
    targetName?: string
  ): Promise<Candidate | null> {
    const items = candidates.map(c => ({
      label: path.basename(c.filePath),
      description: `匹配度: ${c.score}${c.isAbstract ? ' (抽象类)' : ''}`,
      detail: c.filePath,
      candidate: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: this.getPickerTitle(type, targetName)
    });

    return selected?.candidate || null;
  }

  // === 位置计算 ===

  /**
   * 计算类声明位置
   */
  private async calculateClassPosition(
    filePath: string
  ): Promise<{ line: number; column: number } | undefined> {
    const content = await readFileContent(filePath);
    if (!content) return undefined;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (filePath.endsWith('.xml')) {
        const mapperMatch = lines[i].match(/<mapper\b/);
        if (mapperMatch) {
          return { line: i, column: lines[i].indexOf('<') || 0 };
        }
      } else {
        const line = lines[i];
        // 跳过注释行和空行
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed === '') {
          continue;
        }
        // 匹配类/接口/枚举声明
        const match = line.match(/\b(class|interface|enum)\s+(\w+)/);
        if (match) {
          const classNameIndex = line.indexOf(match[2]);
          return { line: i, column: classNameIndex >= 0 ? classNameIndex : 0 };
        }
      }
    }
    return undefined;
  }

  private async calculatePosition(
    filePath: string,
    type: JumpType,
    targetName?: string
  ): Promise<{ line: number; column: number } | undefined> {
    // 优先从缓存获取方法位置（对于Mapper方法跳转）
    if (targetName) {
      const cachedPosition = this.getPositionFromCache(filePath, type, targetName);
      if (cachedPosition) {
        this.logger.debug(`[calculatePosition] 从缓存获取位置: ${filePath}:${targetName} -> line ${cachedPosition.line}`);
        return cachedPosition;
      }
    }

    // 类级别跳转
    if (!targetName) {
      return this.calculateClassPosition(filePath);
    }

    const content = await readFileContent(filePath);
    if (!content) return undefined;

    const lines = content.split('\n');

    // 方法级别 - XML SQL标签定位
    if (filePath.endsWith('.xml')) {
      return this.findSqlPosition(lines, targetName);
    }

    // 方法级别 - Java方法定位
    return this.findMethodPosition(lines, targetName);
  }

  /**
   * 从缓存获取方法位置
   */
  private getPositionFromCache(
    filePath: string,
    type: JumpType,
    targetName: string
  ): { line: number; column: number } | undefined {
    // Mapper方法 -> SQL 跳转
    if (type === 'mapper-method-to-sql') {
      const mapping = this.cache.getByJavaPath(filePath);
      if (mapping?.xmlPath) {
        const methodMapping = mapping.methods.get(targetName);
        if (methodMapping?.xmlPosition) {
          return methodMapping.xmlPosition;
        }
      }
    }

    // SQL -> Mapper方法 跳转
    if (type === 'sql-to-mapper-method') {
      const mapping = this.cache.getByXmlPath(filePath);
      if (mapping) {
        const methodMapping = mapping.methods.get(targetName);
        if (methodMapping?.javaPosition) {
          return methodMapping.javaPosition;
        }
      }
    }

    // 接口方法 -> 实现方法 跳转
    if (type === 'interface-method-to-impl') {
      // 尝试从Java解析器获取方法位置
      const content = this.cache.getByJavaPath(filePath);
      if (content?.methods.has(targetName)) {
        const method = content.methods.get(targetName);
        if (method?.javaPosition) {
          return method.javaPosition;
        }
      }
    }

    return undefined;
  }

  /**
   * 精确查找SQL标签位置
   * 支持多行属性和各种SQL标签格式
   */
  private findSqlPosition(
    lines: string[],
    sqlId: string
  ): { line: number; column: number } | undefined {
    const sqlTypes = ['select', 'insert', 'update', 'delete'];
    const escapedId = this.escapeRegex(sqlId);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检查是否是SQL标签开始行
      const tagMatch = line.match(/<(select|insert|update|delete)\b/i);
      if (!tagMatch) continue;

      const tagType = tagMatch[1].toLowerCase();
      if (!sqlTypes.includes(tagType)) continue;

      // 检查当前行是否包含id属性
      const idMatch = line.match(new RegExp(`id\\s*=\\s*["']${escapedId}["']`));
      if (idMatch) {
        // 精确定位到标签名的起始位置
        const tagStartIndex = line.indexOf('<');
        return { line: i, column: tagStartIndex >= 0 ? tagStartIndex : 0 };
      }

      // 检查多行情况：id属性在后续行
      // 如果当前行以 > 结尾或者是自闭合标签，说明是单行标签
      const trimmedLine = line.trim();
      if (trimmedLine.endsWith('>') || line.includes('/>')) {
        // 单行标签，已检查过id，不匹配则跳过
        continue;
      }

      // 多行标签，向后查找id属性（最多查10行）
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const nextLine = lines[j];
        const multiLineIdMatch = nextLine.match(new RegExp(`id\\s*=\\s*["']${escapedId}["']`));
        if (multiLineIdMatch) {
          // 找到匹配的id，返回标签开始行的位置
          const tagStartIndex = line.indexOf('<');
          return { line: i, column: tagStartIndex >= 0 ? tagStartIndex : 0 };
        }
        // 如果遇到标签结束符 >，停止查找
        if (nextLine.includes('>') && !nextLine.includes('=')) {
          break;
        }
      }
    }

    return undefined;
  }

  /**
   * 精确查找Java方法位置
   * 支持泛型、注解、多行方法声明
   */
  private findMethodPosition(
    lines: string[],
    methodName: string
  ): { line: number; column: number } | undefined {
    const escapedName = this.escapeRegex(methodName);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 快速预检：行中不包含方法名则跳过
      if (!line.includes(methodName)) continue;

      // 检查是否是方法声明
      // 匹配模式：方法名后跟左括号，前面是单词边界
      const methodPattern = new RegExp(`\\b${escapedName}\\s*\\(`);
      if (!methodPattern.test(line)) continue;

      // 排除方法调用（前面有 . 的情况，如 obj.method()）
      const callMatch = line.match(new RegExp(`\\.${escapedName}\\s*\\(`));
      if (callMatch) continue;

      // 排除注释行
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      // 获取方法名前面的内容
      const methodNameIndex = line.indexOf(methodName);
      const beforeMethod = line.substring(0, methodNameIndex).trim();

      // 排除赋值语句（如：String methodName = ...）
      if (beforeMethod.endsWith('=')) continue;

      // 排除变量声明中的初始化（如：Runnable r = methodName();）
      if (beforeMethod.match(/=\s*$/)) continue;

      // 检查是否是方法声明的特征：
      // 1. 前面有访问修饰符（public/private/protected）
      // 2. 前面有 static/final/abstract 等修饰符
      // 3. 前面有返回类型（以字母数字结尾）
      // 4. 前面是注解（以 @ 结尾）
      // 5. 前面是泛型（以 > 结尾）
      const isMethodDeclaration =
        beforeMethod.match(/\b(public|private|protected|static|final|abstract|synchronized|native|strictfp)\s*$/) ||
        beforeMethod.match(/[\w\]>]\s*$/) ||  // 返回类型或泛型
        beforeMethod.match(/@\w+\s*$/);        // 注解

      if (!isMethodDeclaration && beforeMethod.length > 0) {
        // 进一步检查：如果前面是 ( 或 , 可能是方法参数中的lambda
        if (beforeMethod.match(/[\(,]\s*$/)) {
          continue;
        }
      }

      // 精确定位到方法名的起始位置
      return { line: i, column: methodNameIndex };
    }

    return undefined;
  }

  /**
   * 转义正则特殊字符
   */
  private escapeRegex(str: string): string {
    return str.replace(new RegExp('[\\\\^$.*+?()[\\]{}|]', 'g'), '\\$&');
  }

  // === 辅助方法 ===

  private getNoTargetMessage(type: JumpType, targetName?: string): string {
    const name = targetName ? ` (${targetName})` : '';
    switch (type) {
      case 'interface-to-impl': return `未找到接口的实现类${name}`;
      case 'impl-to-interface': return '未找到实现的接口';
      case 'interface-method-to-impl': return `未找到方法的实现${name}`;
      case 'impl-method-to-interface': return `未找到方法的接口定义${name}`;
      case 'mapper-to-xml': return '未找到对应的XML文件';
      case 'xml-to-mapper': return '未找到对应的Mapper接口';
      case 'mapper-method-to-sql': return `未找到对应的SQL语句${name}`;
      case 'sql-to-mapper-method': return `未找到对应的方法${name}`;
      default: return '未找到目标';
    }
  }

  private getPickerTitle(type: JumpType, targetName?: string): string {
    const name = targetName ? ` (${targetName})` : '';
    switch (type) {
      case 'interface-to-impl': return `选择实现类${name}`;
      case 'impl-to-interface': return '选择接口';
      case 'interface-method-to-impl': return `选择方法实现${name}`;
      case 'impl-method-to-interface': return `选择方法定义${name}`;
      case 'mapper-to-xml': return '选择XML文件';
      case 'xml-to-mapper': return '选择Mapper接口';
      case 'mapper-method-to-sql': return `选择SQL位置${name}`;
      case 'sql-to-mapper-method': return `选择方法位置${name}`;
      default: return '选择目标';
    }
  }
}
