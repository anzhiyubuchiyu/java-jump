/**
 * Java文件解析器
 * 解析Java文件的类、方法、接口实现关系等
 */

import * as vscode from 'vscode';
import { JavaParseResult, JavaMethod, JavaTypeSnapshot } from '../types';
import { JavaLanguageService } from './javaLanguageService';
import { maskJavaCommentsAndLiterals } from './javaSourceMasker';

// Java关键字集合
const JAVA_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
  'return', 'throw', 'new', 'case', 'break', 'continue', 'assert',
  'super', 'this', 'instanceof'
]);

const JAVA_LANG_TYPES = new Set([
  'Boolean', 'Byte', 'Character', 'Class', 'Double', 'Enum', 'Exception',
  'Float', 'Integer', 'Iterable', 'Long', 'Number', 'Object', 'RuntimeException',
  'Short', 'String', 'StringBuilder', 'Throwable', 'Void'
]);

const PRIMITIVE_TYPES = new Set([
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void'
]);

export class JavaParser {
  /**
   * 解析Java文件内容
   */
  static parseContent(content: string, filePath?: string): JavaParseResult {
    // 解析包名
    const packageName = this.extractPackageName(content);

    // 解析类信息
    const classInfo = this.extractClassInfo(content);

    // 检查是否是MyBatis Mapper
    const isMapper = this.isMyBatisMapper(content, filePath);

    // 提取方法
    const methods = this.extractMethods(content);

    // 提取实现的接口
    const interfaces = this.extractImplementedInterfaces(content);

    // 提取父类
    const superClass = this.extractSuperClass(content);

    return {
      packageName,
      className: classInfo.name,
      isInterface: classInfo.isInterface,
      isAbstract: classInfo.isAbstract,
      isMapper,
      methods,
      interfaces,
      superClass
    };
  }

  /**
   * 提取包名
   */
  static extractPackageName(content: string): string {
    const source = this.maskComments(content);
    const match = source.match(/^\s*package\s+([^;]+);/m);
    return match ? match[1] : '';
  }

  /**
   * 提取类信息
   */
  static extractClassInfo(content: string): { name: string; isInterface: boolean; isAbstract: boolean } {
    const source = this.maskComments(content);
    // 匹配接口
    const interfaceMatch = source.match(/\b(?:public\s+)?interface\s+(\w+)/);
    if (interfaceMatch) {
      return { name: interfaceMatch[1], isInterface: true, isAbstract: false };
    }

    // 匹配抽象类
    const abstractMatch = source.match(/\b(?:public\s+)?abstract\s+class\s+(\w+)/);
    if (abstractMatch) {
      return { name: abstractMatch[1], isInterface: false, isAbstract: true };
    }

    // 匹配普通类
    const classMatch = source.match(/\b(?:public\s+|private\s+|protected\s+)?(?:final\s+)?class\s+(\w+)/);
    if (classMatch) {
      return { name: classMatch[1], isInterface: false, isAbstract: false };
    }

    const recordMatch = source.match(/\b(?:public\s+|private\s+|protected\s+)?(?:final\s+)?record\s+(\w+)/);
    if (recordMatch) {
      return { name: recordMatch[1], isInterface: false, isAbstract: false };
    }

    const enumMatch = source.match(/\b(?:public\s+|private\s+|protected\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      return { name: enumMatch[1], isInterface: false, isAbstract: false };
    }

    return { name: '', isInterface: false, isAbstract: false };
  }

  /**
   * 检查是否是Java接口
   */
  static isJavaInterface(content: string): boolean {
    return this.extractClassInfo(content).isInterface;
  }

  /**
   * 检查是否是Java类
   */
  static isJavaClass(content: string): boolean {
    const classInfo = this.extractClassInfo(content);
    return !!classInfo.name && !classInfo.isInterface;
  }

  /**
   * 检查是否是抽象类
   */
  static isAbstractClass(content: string): boolean {
    return this.extractClassInfo(content).isAbstract;
  }

  /**
   * 检查是否是MyBatis Mapper
   */
  static isMyBatisMapper(content: string, filePath?: string): boolean {
    const source = this.maskComments(content);
    // 必须是接口
    if (!this.extractClassInfo(source).isInterface) {
      return false;
    }

    // 检查MyBatis标记
    const hasMyBatisMarker =
      /@Mapper\b/.test(source) ||
      /import\s+org\.apache\.ibatis/.test(source) ||
      /import\s+org\.mybatis/.test(source);

    // 如果类名以Mapper结尾（最常见的命名约定）
    const isMapperByName = /\binterface\s+\w*Mapper\b/.test(source);

    // 如果文件路径包含mapper且类名以Mapper结尾
    const isMapperByPath = !!filePath &&
      /[Mm]apper/.test(filePath) &&
      /interface\s+\w*Mapper\b/.test(source);

    return hasMyBatisMarker || isMapperByName || isMapperByPath;
  }

  /**
   * 提取类名
   */
  static extractClassName(content: string): string | null {
    return this.extractClassInfo(content).name || null;
  }

  /**
   * 提取方法列表
   */
  static extractMethods(content: string): JavaMethod[] {
    const methods: JavaMethod[] = [];
    const lines = content.split('\n');
    const source = this.maskComments(content);
    let braceDepth = 0;
    let statementStart = 0;

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') {
        braceDepth++;
        statementStart = i + 1;
        continue;
      }
      if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        statementStart = i + 1;
        continue;
      }
      if (ch === ';') {
        statementStart = i + 1;
        continue;
      }
      if (ch !== '(' || braceDepth !== 1) continue;

      const nameMatch = source.slice(statementStart, i).match(/([A-Za-z_$][\w$]*)\s*$/);
      if (!nameMatch) continue;
      const methodName = nameMatch[1];
      const nameOffset = i - nameMatch[0].length + nameMatch[0].indexOf(methodName);
      if (source[nameOffset - 1] === '@' || JAVA_KEYWORDS.has(methodName) ||
          this.isConstructor(methodName, content)) continue;

      const declarationPrefix = source.slice(statementStart, nameOffset);
      if (!this.isMethodPrefix(declarationPrefix)) continue;

      const closeParen = this.findMatchingParen(source, i);
      if (closeParen < 0 || !this.hasMethodTerminator(source, closeParen + 1)) continue;

      const line = this.offsetToLine(source, nameOffset);
      const lineStart = source.lastIndexOf('\n', nameOffset - 1) + 1;
      methods.push({
        name: methodName,
        line,
        column: nameOffset - lineStart,
        hasOverride: this.checkOverrideAnnotation(lines, line),
        parameters: content.slice(i + 1, closeParen),
        parameterTypes: []
      });

      i = closeParen;
    }

    return methods;
  }

  /**
   * 查找给定位置所属的方法。没有语言服务时用于方法体内导航回退。
   */
  static findMethodAtPosition(
    content: string,
    position: { line: number; column: number }
  ): JavaMethod | undefined {
    const source = this.maskComments(content);
    const offset = this.positionToOffset(content, position);

    for (const method of this.extractMethods(content)) {
      const nameOffset = this.positionToOffset(content, {
        line: method.line,
        column: method.column
      });
      const openParen = source.indexOf('(', nameOffset + method.name.length);
      if (openParen < 0) continue;

      const closeParen = this.findMatchingParen(source, openParen);
      if (closeParen < 0) continue;

      const terminator = source.slice(closeParen + 1)
        .match(/^\s*(?:throws\s+[\w.$,<>?&\s]+)?\s*([;{])/);
      if (!terminator) continue;

      const terminatorOffset = closeParen + 1 + terminator[0].lastIndexOf(terminator[1]);
      if (terminator[1] === ';') {
        if (offset >= nameOffset && offset <= terminatorOffset) return method;
        continue;
      }

      const bodyEnd = this.findMatchingBrace(source, terminatorOffset);
      if (bodyEnd >= 0 && offset >= nameOffset && offset <= bodyEnd) return method;
    }

    return undefined;
  }

  /**
   * 提取导入声明
   * @returns { explicitImports: string[], wildcardImports: string[] }
   */
  static extractImports(content: string): { explicitImports: string[]; wildcardImports: string[] } {
    const explicitImports: string[] = [];
    const wildcardImports: string[] = [];
    const importRegex = /import\s+(static\s+)?([\w.$]+(?:\.\*)?);/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[2];
      if (importPath.endsWith('.*')) {
        wildcardImports.push(importPath.slice(0, -2)); // 去掉 .*
      } else {
        explicitImports.push(importPath);
      }
    }
    return { explicitImports, wildcardImports };
  }

  /**
   * 规范化方法参数类型
   * 将参数类型擦除泛型，并尝试通过导入解析简单名为FQN
   * @param paramText 原始参数文本 (如 "@Param(\"id\") Long id, String name")
   * @param explicitImports 显式导入列表
   * @param wildcardImports 通配符导入列表
   * @returns 规范化后的参数FQN数组
   */
  static normalizeParameterTypes(
    paramText: string,
    explicitImports: string[],
    wildcardImports: string[],
    packageName = ''
  ): string[] {
    if (!paramText || paramText.trim() === '') return [];

    const params = this.splitParameters(paramText);
    const result: string[] = [];

    for (const param of params) {
      let type = this.extractTypeFromParam(param.trim());
      if (!type) continue;

      type = this.eraseGenericArguments(type).replace(/\s+/g, '').trim();
      const dimensions = (type.match(/\[\]/g) ?? []).length + (type.endsWith('...') ? 1 : 0);
      const baseType = type.replace(/(?:\[\]|\.\.\.)+$/g, '');
      const resolved = this.resolveTypeName(
        baseType,
        packageName,
        explicitImports,
        wildcardImports,
        false
      );
      type = `${resolved}${'[]'.repeat(dimensions)}`;

      result.push(type);
    }

    return result;
  }

  /**
   * 分割参数列表，处理泛型嵌套
   */
  private static splitParameters(paramText: string): string[] {
    const params: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of paramText) {
      if (ch === '<') depth++;
      else if (ch === '>') depth--;
      else if (ch === ',' && depth === 0) {
        params.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) params.push(current);
    return params;
  }

  /**
   * 从单个参数声明中提取类型
   * 如 "@Param(\"id\") Long id" -> "Long"
   * 如 "String[] names" -> "String[]"
   */
  private static extractTypeFromParam(param: string): string | null {
    let cleaned = this.stripAnnotations(param).trim();
    cleaned = cleaned.replace(/\bfinal\s+/g, '').trim();
    const match = cleaned.match(/^([\s\S]+?)\s+([A-Za-z_$][\w$]*)(\s*\[\s*\])?$/);
    if (!match) return null;
    return `${match[1].trim()}${match[3] ? '[]' : ''}`;
  }

  /**
   * 通过导入解析简单名为FQN
   */
  private static resolveTypeName(
    typeName: string,
    packageName: string,
    explicitImports: string[],
    wildcardImports: string[],
    resolveJavaLang = true
  ): string {
    if (!typeName || PRIMITIVE_TYPES.has(typeName) || typeName.includes('.')) return typeName;
    for (const imp of explicitImports) {
      if (imp.endsWith(`.${typeName}`)) {
        return imp;
      }
    }
    if (JAVA_LANG_TYPES.has(typeName)) return resolveJavaLang ? `java.lang.${typeName}` : typeName;
    // 按需导入必须结合工作区中的实际类型才能消歧；解析阶段不猜测包名。
    if (wildcardImports.length > 0) return `__unresolved__.${typeName}`;
    return packageName ? `${packageName}.${typeName}` : typeName;
  }

  /**
   * 解析方法签名（填充parameterTypes）
   * 在获取到导入信息后调用
   */
  static resolveMethodSignatures(
    methods: JavaMethod[],
    content: string,
    explicitImports: string[],
    wildcardImports: string[]
  ): JavaMethod[] {
    return methods.map(m => {
      return {
        ...m,
        parameterTypes: this.normalizeParameterTypes(
          m.parameters,
          explicitImports,
          wildcardImports,
          this.extractPackageName(content)
        )
      };
    });
  }

  /**
   * 从文件内容创建不可变类型快照
   */
  static createTypeSnapshot(content: string, filePath: string): JavaTypeSnapshot {
    const parseResult = this.parseContent(content, filePath);
    const { explicitImports, wildcardImports } = this.extractImports(content);
    const fqn = parseResult.packageName
      ? `${parseResult.packageName}.${parseResult.className}`
      : parseResult.className;

    const kind = parseResult.isInterface ? 'interface' :
                 parseResult.isAbstract ? 'class' : 'class';

    const methods = this.resolveMethodSignatures(
      parseResult.methods, content, explicitImports, wildcardImports
    ).map(method => ({ ...method, rawParameterTypes: [...method.parameterTypes] }));

    const superClass = parseResult.superClass
      ? this.resolveTypeName(parseResult.superClass, parseResult.packageName, explicitImports, wildcardImports)
      : undefined;
    const interfaces = parseResult.interfaces
      .filter(i => !i.startsWith('__extends:'))
      .map(i => this.resolveTypeName(i, parseResult.packageName, explicitImports, wildcardImports));

    return {
      fqn,
      packageName: parseResult.packageName,
      className: parseResult.className,
      kind: kind as 'class' | 'interface',
      isAbstract: parseResult.isAbstract,
      isMapper: parseResult.isMapper,
      explicitImports,
      wildcardImports,
      superClass,
      rawSuperClass: superClass,
      interfaces,
      rawInterfaces: [...interfaces],
      methods,
      filePath
    };
  }

  /**
   * 提取实现的接口列表（同步版本，不过滤系统接口）
   * 用于只需要原始列表的场景
   */
  static extractImplementedInterfaces(content: string): string[] {
    const declaration = this.extractTypeDeclaration(content);
    if (!declaration) return [];

    if (declaration.kind === 'interface') {
      const extendsMatch = declaration.tail.match(/\bextends\s+([\s\S]+)$/);
      return extendsMatch ? this.parseTypeList(extendsMatch[1]) : [];
    }

    const result: string[] = [];
    const implementsMatch = declaration.tail.match(/\bimplements\s+([\s\S]+)$/);
    if (implementsMatch) result.push(...this.parseTypeList(implementsMatch[1]));

    const superClass = this.extractSuperClass(content);
    if (superClass && superClass !== 'Object') result.push(`__extends:${superClass}`);
    return result;
  }

  /**
   * 提取实现的接口列表（异步版本，过滤系统接口）
   * 使用Red Hat Java扩展获取全限定名进行判断
   * @param content 文件内容
   * @param fileUri 文件URI
   */
  static async extractImplementedInterfacesAsync(
    content: string,
    fileUri: vscode.Uri
  ): Promise<string[]> {
    const allInterfaces = this.extractImplementedInterfaces(content);
    const javaService = JavaLanguageService.getInstance();
    const filtered: string[] = [];

    for (const iface of allInterfaces) {
      // 跳过extends标记
      if (iface.startsWith('__extends:')) {
        filtered.push(iface);
        continue;
      }

      const isSystem = await javaService.isSystemInterfaceWithContext(iface, fileUri, content);
      if (!isSystem) {
        filtered.push(iface);
      }
    }

    return filtered;
  }

  /**
   * 检查是否是系统接口（同步版本，仅支持全限定名）
   * @param interfaceName 接口名称（全限定名）
   */
  static isSystemInterface(interfaceName: string): boolean {
    const javaService = JavaLanguageService.getInstance();
    return javaService.isSystemInterface(interfaceName);
  }

  /**
   * 提取父类
   */
  static extractSuperClass(content: string): string | undefined {
    const declaration = this.extractTypeDeclaration(content);
    if (!declaration || declaration.kind === 'interface') return undefined;
    const match = declaration.tail.match(/\bextends\s+([\w.$]+)(?:\s*<[^>]*>)?/);
    return match?.[1];
  }

  /**
   * 检查是否是构造方法
   */
  static isConstructor(methodName: string, content: string): boolean {
    return this.extractClassName(content) === methodName;
  }

  /**
   * 检查方法声明格式
   */
  static looksLikeMethodDeclaration(text: string): boolean {
    if (!text.includes('(')) return false;

    const parenIdx = text.indexOf('(');
    const before = text.substring(0, parenIdx).trim();

    // 赋值不是方法声明
    if (before.includes('=')) return false;

    const words = before.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) return false;

    const lastWord = words[words.length - 1];
    if (lastWord.includes('.')) return false;

    const firstWord = words[0];
    if (JAVA_KEYWORDS.has(firstWord)) return false;

    return true;
  }

  /**
   * 提取方法名
   */
  static extractMethodName(text: string): string | null {
    const match = text.match(/\b(\w+)\s*\(/);
    if (!match) return null;
    return JAVA_KEYWORDS.has(match[1]) ? null : match[1];
  }

  /**
   * 提取方法参数
   */
  static extractMethodParams(text: string): string {
    const match = text.match(/\(([^)]*)\)/);
    return match?.[1]?.trim() ?? '';
  }

  /**
   * 检查Override注解
   */
  static checkOverrideAnnotation(lines: string[], methodLine: number): boolean {
    for (let i = methodLine - 1; i >= Math.max(0, methodLine - 15); i--) {
      const text = lines[i].trim();
      if (text === '') continue;

      if (!text.startsWith('@') && !text.startsWith('//') &&
          !text.startsWith('*') && !text.startsWith('/*') &&
          (text.endsWith(';') || text.endsWith('{') || text.endsWith('}'))) {
        break;
      }

      if (text.startsWith('@') && text.includes('@Override')) {
        return true;
      }
    }
    return false;
  }

  /**
   * 解析类型列表
   */
  static parseTypeList(str: string): string[] {
    const types: string[] = [];
    let depth = 0, current = '';
    for (const ch of str) {
      if (ch === '<') { depth++; }
      else if (ch === '>') { depth--; }
      else if (ch === ',' && depth === 0) {
        const name = this.eraseGenericArguments(current).trim();
        if (name && /^[\w.$]+$/.test(name)) { types.push(name); }
        current = '';
        continue;
      }
      current += ch;
    }
    const last = this.eraseGenericArguments(current).trim();
    if (last && /^[\w.$]+$/.test(last)) { types.push(last); }
    return types;
  }

  private static extractTypeDeclaration(
    content: string
  ): { kind: 'class' | 'interface'; tail: string } | undefined {
    const source = this.maskComments(content);
    const match = /\b(class|interface|record|enum)\s+[A-Za-z_$][\w$]*(?:\s*<[^>{}]*>)?(?:\s*\([^{}]*\))?([\s\S]*?)\{/.exec(source);
    if (!match) return undefined;
    return { kind: match[1] === 'interface' ? 'interface' : 'class', tail: match[2].trim() };
  }

  private static eraseGenericArguments(typeName: string): string {
    let result = '';
    let depth = 0;
    for (const ch of typeName) {
      if (ch === '<') {
        depth++;
      } else if (ch === '>') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        result += ch;
      }
    }
    return result;
  }

  private static stripAnnotations(text: string): string {
    let result = '';
    for (let i = 0; i < text.length;) {
      if (text[i] !== '@') {
        result += text[i++];
        continue;
      }

      i++;
      while (i < text.length && /[\w.$]/.test(text[i])) i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '(') continue;
      const close = this.findMatchingParen(text, i);
      i = close >= 0 ? close + 1 : text.length;
    }
    return result;
  }

  private static maskComments(content: string): string {
    return maskJavaCommentsAndLiterals(content);
  }

  private static positionToOffset(
    content: string,
    position: { line: number; column: number }
  ): number {
    const lines = content.split('\n');
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    const prefixLength = lines.slice(0, line).reduce((total, value) => total + value.length + 1, 0);
    return prefixLength + Math.max(0, Math.min(position.column, lines[line].length));
  }

  private static findMatchingParen(content: string, openOffset: number): number {
    return this.findMatchingDelimiter(content, openOffset, '(', ')');
  }

  private static findMatchingBrace(content: string, openOffset: number): number {
    return this.findMatchingDelimiter(content, openOffset, '{', '}');
  }

  private static findMatchingDelimiter(
    content: string,
    openOffset: number,
    open: string,
    close: string
  ): number {
    let depth = 0;
    let quote = '';
    for (let i = openOffset; i < content.length; i++) {
      const ch = content[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === open) {
        depth++;
      } else if (ch === close && --depth === 0) {
        return i;
      }
    }
    return -1;
  }

  private static hasMethodTerminator(content: string, offset: number): boolean {
    const remainder = content.slice(offset);
    const match = remainder.match(/^\s*(?:throws\s+[\w.$,<>?&\s]+)?\s*([;{])/);
    return !!match;
  }

  private static isMethodPrefix(prefix: string): boolean {
    const withoutAnnotations = this.stripAnnotations(prefix).trim();
    if (!withoutAnnotations || withoutAnnotations.includes('=')) return false;
    const withoutModifiers = withoutAnnotations
      .replace(/\b(?:public|protected|private|abstract|static|default|final|synchronized|native|strictfp)\b/g, '')
      .replace(/^\s*<[^>]+>\s*/, '')
      .trim();
    return !!withoutModifiers && !JAVA_KEYWORDS.has(withoutModifiers.split(/\s+/)[0]);
  }

  private static offsetToLine(content: string, offset: number): number {
    let line = 0;
    for (let i = 0; i < offset; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  /**
   * 处理块注释
   */
  static processBlockComments(line: string, inBlockComment: boolean): { text: string; inBlockComment: boolean } {
    let result = '';
    let i = 0;
    let inComment = inBlockComment;

    while (i < line.length) {
      if (inComment) {
        const endIdx = line.indexOf('*/', i);
        if (endIdx >= 0) { i = endIdx + 2; inComment = false; }
        else { break; }
      } else {
        const startIdx = line.indexOf('/*', i);
        if (startIdx >= 0) {
          result += line.substring(i, startIdx);
          const endIdx = line.indexOf('*/', startIdx + 2);
          if (endIdx >= 0) { i = endIdx + 2; }
          else { inComment = true; break; }
        } else {
          result += line.substring(i);
          break;
        }
      }
    }
    return { text: result, inBlockComment: inComment };
  }

  /**
   * 计算大括号数量
   */
  static countBraces(line: string): { open: number; close: number } {
    const stripped = line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/\/\/.*$/, '');

    let open = 0, close = 0;
    for (const ch of stripped) {
      if (ch === '{') { open++; }
      else if (ch === '}') { close++; }
    }
    return { open, close };
  }

  /**
   * 转义正则特殊字符
   */
  static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 检查内容是否包含特定方法（接口方法）
   * 支持带注解的参数，如 @Param("empName")String empName
   */
  static containsMethod(content: string, methodName: string): boolean {
    const escaped = this.escapeRegex(methodName);
    // 使用平衡括号匹配，支持嵌套括号（用于注解如@Param("xxx")）
    const pattern = `\\b${escaped}\\s*\\((?:[^()]|\\((?:[^()]|\\([^)]*\\))*\\))*\\)\\s*(?:throws\\s+[\\w\\s,.<>]+)?\\s*;`;
    return new RegExp(pattern).test(content);
  }

  /**
   * 检查内容是否包含特定方法实现
   */
  static containsImplementedMethod(content: string, methodName: string): boolean {
    const escaped = this.escapeRegex(methodName);
    return new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w\\s,.<>]+)?\\s*\\{`).test(content) ||
           new RegExp(`(?:public|protected)\\s+[\\w<>\\[\\],.\\s]+\\s+${escaped}\\s*\\(`).test(content);
  }
}
