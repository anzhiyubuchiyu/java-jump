/**
 * 统一CodeLens提供器
 * 融合接口跳转和MyBatis跳转的CodeLens显示
 *
 * 核心变更：
 * - CodeLens传递JavaNavigationRequest（URI、精确位置、方向、级别、方法签名）
 * - SQL CodeLens仅在实际存在匹配id时显示
 * - XML CodeLens使用document.getText()支持未保存内容
 */

import * as vscode from 'vscode';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { XmlParser } from '../utils/xmlParser';
import { JavaLanguageService } from '../utils/javaLanguageService';
import { Logger } from '../utils/logger';
import { MyBatisNavigator } from '../navigators/myBatisNavigator';
import { UnifiedNavigator } from '../navigators/unifiedNavigator';
import { JavaNavigationRequest, MyBatisNavigationRequest } from '../types';
import { readFileContent } from '../utils/fileUtils';

export class UnifiedCodeLensProvider implements vscode.CodeLensProvider {
  private cache: IndexCacheManager;
  private xmlParser: XmlParser;
  private logger: Logger;
  private myBatisNavigator: MyBatisNavigator;
  private javaLanguageService: JavaLanguageService;
  private unifiedNavigator: UnifiedNavigator;

  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor() {
    this.cache = IndexCacheManager.getInstance();
    this.xmlParser = XmlParser.getInstance();
    this.logger = Logger.getInstance();
    this.myBatisNavigator = MyBatisNavigator.getInstance();
    this.javaLanguageService = JavaLanguageService.getInstance();
    this.unifiedNavigator = UnifiedNavigator.getInstance();
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const filePath = document.uri.fsPath;
    const isJava = filePath.toLowerCase().endsWith('.java');
    const isXml = filePath.toLowerCase().endsWith('.xml');

    if (!isJava && !isXml) return [];

    const config = vscode.workspace.getConfiguration('javaNavigator');
    const enableCodeLens = config.get<boolean>('enableCodeLens', true);
    if (!enableCodeLens) return [];

    try {
      if (isJava) {
        return await this.provideJavaCodeLenses(document);
      } else {
        return await this.provideXmlCodeLenses(document);
      }
    } catch (error) {
      this.logger.error('[UnifiedCodeLensProvider] Error providing CodeLenses:', error);
      return [];
    }
  }

  private async provideJavaCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const filePath = document.uri.fsPath;
    const content = document.getText();
    const codeLenses: vscode.CodeLens[] = [];

    const javaInfo = JavaParser.parseContent(content, filePath);
    if (!javaInfo.className) return [];

    const config = vscode.workspace.getConfiguration('javaNavigator');
    const enableInterfaceNav = config.get<boolean>('enableInterfaceNavigation', true);
    const enableMyBatisNav = config.get<boolean>('enableMyBatisNavigation', true);
    const cacheEnabled = config.get<boolean>('cacheEnabled', true);
    await this.cache.waitForScan();
    const fqn = javaInfo.packageName ? `${javaInfo.packageName}.${javaInfo.className}` : javaInfo.className;
    const hasMatchingDirtyXml = vscode.workspace.textDocuments.some(document => {
      if (!document.isDirty || !document.uri.fsPath.endsWith('.xml')) return false;
      const xmlInfo = this.xmlParser.parseXmlContentFromText(
        document.getText(),
        document.uri.fsPath
      );
      return xmlInfo?.namespace === fqn;
    });
    const isIndexedJavaType = !!this.cache.getTypeByPath(filePath);
    const cachedMapping = enableMyBatisNav ? this.cache.getByJavaPath(filePath) : undefined;
    const mapping = cachedMapping?.namespace === fqn ? cachedMapping : undefined;
    const xmlNamespaceIndexComplete = this.cache.isXmlNamespaceIndexComplete();
    const hasIndexedXml = this.cache.hasIndexedXmlPaths(fqn);
    const shouldResolveXml = enableMyBatisNav &&
      (javaInfo.isMapper || !!mapping || !cacheEnabled || !isIndexedJavaType ||
        document.isDirty || hasMatchingDirtyXml || !xmlNamespaceIndexComplete || hasIndexedXml);
    const liveXmlPaths = shouldResolveXml
      ? await this.myBatisNavigator.findXmlByNamespace(fqn, filePath, true)
      : [];
    const isMapperTarget = liveXmlPaths.length > 0;
    const sqlIds = new Set<string>();
    for (const xmlPath of liveXmlPaths) {
      const xmlContent = await readFileContent(xmlPath);
      const xmlInfo = xmlContent
        ? this.xmlParser.parseXmlContentFromText(xmlContent, xmlPath)
        : undefined;
      if (xmlInfo?.namespace !== fqn) continue;
      xmlInfo.sqlElements.forEach(element => sqlIds.add(element.id));
    }

    const symbols = await this.getDocumentSymbols(document);
    const classSymbol = symbols.find(s =>
      s.kind === vscode.SymbolKind.Interface ||
      s.kind === vscode.SymbolKind.Class
    );
    const classPosition = classSymbol
      ? (classSymbol.selectionRange || classSymbol.range).start
      : this.findTypePosition(content, javaInfo.className);
    const methods = symbols.length > 0
      ? this.extractMethodsFromSymbols(symbols, document)
      : JavaParser.createTypeSnapshot(content, filePath).methods.map(method => ({
          ...method,
          isDefault: false
        }));
    const typeImplementationRequest: JavaNavigationRequest | undefined =
      enableInterfaceNav && classPosition && (javaInfo.isInterface || javaInfo.isAbstract)
        ? {
            uri: document.uri.toString(),
            position: { line: classPosition.line, column: classPosition.character },
            direction: 'to-impl',
            level: 'type'
          }
        : undefined;
    const implementationMethodEntries = javaInfo.isInterface
      ? methods.filter(method => !method.isDefault).map(method => ({
          method,
          request: {
            uri: document.uri.toString(),
            position: { line: method.line, column: method.column },
            direction: 'to-impl' as const,
            level: 'method' as const,
            methodSignature: {
              name: method.name.split('(')[0],
              parameterTypes: method.parameterTypes
            }
          }
        }))
      : [];
    const implementationTargets = typeImplementationRequest
      ? await this.unifiedNavigator.probeImplementationTargets(
          typeImplementationRequest,
          implementationMethodEntries.map(entry => entry.request)
        )
      : { hasTypeTarget: false, methodTargets: [] };

    // 获取用户自定义接口列表（过滤系统接口）
    let userInterfaces: string[] = [];
    if (enableInterfaceNav && !javaInfo.isInterface && !javaInfo.isAbstract) {
      const realInterfaces = javaInfo.interfaces.filter(i => !i.startsWith('__extends:'));
      userInterfaces = await this.filterSystemInterfaces(realInterfaces, document);
    }
    const typeInterfaceRequest: JavaNavigationRequest | undefined =
      enableInterfaceNav && classPosition && !javaInfo.isInterface && !javaInfo.isAbstract && userInterfaces.length > 0
        ? {
            uri: document.uri.toString(),
            position: { line: classPosition.line, column: classPosition.character },
            direction: 'to-interface',
            level: 'type'
          }
        : undefined;
    const interfaceMethodEntries = enableInterfaceNav && !javaInfo.isInterface && userInterfaces.length > 0
      ? methods.map(method => ({
          method,
          request: {
            uri: document.uri.toString(),
            position: { line: method.line, column: method.column },
            direction: 'to-interface' as const,
            level: 'method' as const,
            methodSignature: {
              name: method.name.split('(')[0],
              parameterTypes: method.parameterTypes
            }
          }
        }))
      : [];
    const interfaceTargets = typeInterfaceRequest
      ? await this.unifiedNavigator.probeInterfaceTargets(
          typeInterfaceRequest,
          interfaceMethodEntries.map(entry => entry.request)
        )
      : {
          hasTypeTarget: false,
          methodTargets: await Promise.all(interfaceMethodEntries.map(entry =>
            this.unifiedNavigator.hasTarget(entry.request)
          ))
        };

    // 类级别的CodeLens
    if (classPosition) {
      const classLine = classPosition.line;
      const classColumn = classPosition.character;

      // 接口/抽象类：跳转到实现
      if (typeImplementationRequest && implementationTargets.hasTypeTarget) {
        const title = javaInfo.isInterface
          ? `$(symbol-interface) 跳转到实现`
          : `$(symbol-class) 跳转到实现`;
        codeLenses.push(this.createCodeLens(
          classLine,
          title,
          'javaNavigator.jumpToImplementation',
          [typeImplementationRequest]
        ));
      }

      // MyBatis Mapper：跳转到XML
      if (enableMyBatisNav && isMapperTarget) {
        const request: MyBatisNavigationRequest = {
          uri: document.uri.toString(),
          position: { line: classLine, column: classColumn },
          direction: 'java-to-xml'
        };

        codeLenses.push(this.createCodeLens(
          classLine,
          `$(file-code) 跳转到XML`,
          'javaNavigator.jumpToXml',
          [request]
        ));
      }

      // 实现类：跳转到接口
      if (typeInterfaceRequest && interfaceTargets.hasTypeTarget) {
        codeLenses.push(this.createCodeLens(
          classLine,
          `$(symbol-interface) 跳转到接口`,
          'javaNavigator.jumpToInterfaceFromClass',
          [typeInterfaceRequest]
        ));
      }
    }

    // 方法级别的CodeLens
    if (enableInterfaceNav || enableMyBatisNav) {
      let implementationMethodIndex = 0;
      let interfaceMethodIndex = 0;
      for (const method of methods) {
        const methodName = method.name.split('(')[0];

        // 接口方法：跳转到实现
        if (enableInterfaceNav && javaInfo.isInterface && !method.isDefault) {
          const entry = implementationMethodEntries[implementationMethodIndex++];
          if (entry && implementationTargets.methodTargets[implementationMethodIndex - 1]) {
            codeLenses.push(this.createCodeLens(
              method.line,
              `$(arrow-right) 跳转到实现`,
              'javaNavigator.jumpToImplementation',
              [entry.request]
            ));
          }
        }

        // 实现类方法：跳转到接口
        if (enableInterfaceNav && !javaInfo.isInterface && userInterfaces.length > 0) {
          const entry = interfaceMethodEntries[interfaceMethodIndex++];
          if (entry && interfaceTargets.methodTargets[interfaceMethodIndex - 1]) {
            codeLenses.push(this.createCodeLens(
              method.line,
              `$(arrow-left) 跳转到接口`,
              'javaNavigator.jumpToInterface',
              [entry.request]
            ));
          }
        }

        // Mapper方法：跳转到SQL（仅在实际存在时显示）
        if (enableMyBatisNav && isMapperTarget) {
          if (sqlIds.has(methodName)) {
            const request: MyBatisNavigationRequest = {
              uri: document.uri.toString(),
              position: { line: method.line, column: method.column },
              direction: 'java-to-xml'
            };
            codeLenses.push(this.createCodeLens(
              method.line,
              `$(database) 跳转到SQL`,
              'javaNavigator.jumpToXml',
              [request]
            ));
          }
        }
      }
    }

    return codeLenses;
  }

  private async provideXmlCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const filePath = document.uri.fsPath;
    const codeLenses: vscode.CodeLens[] = [];

    const config = vscode.workspace.getConfiguration('javaNavigator');
    const enableMyBatisNav = config.get<boolean>('enableMyBatisNavigation', true);
    if (!enableMyBatisNav) return [];

    // 使用document.getText()支持未保存内容
    const content = document.getText();
    const xmlInfo = this.xmlParser.parseXmlContentFromText(content, filePath);
    if (!xmlInfo) return [];

    const mappings = await this.myBatisNavigator.findJavaForXmlCandidates(
      filePath,
      content,
      !!document.isDirty
    );
    const validMappings = [];
    const javaMethodNames = new Set<string>();
    for (const mapping of mappings) {
      const javaContent = await readFileContent(mapping.javaPath);
      if (!javaContent) continue;
      const snapshot = JavaParser.createTypeSnapshot(javaContent, mapping.javaPath);
      if (snapshot.fqn !== xmlInfo.namespace) continue;
      validMappings.push(mapping);
      snapshot.methods.forEach(method => javaMethodNames.add(method.name));
    }

    const mapperMatch = content.match(/<mapper/);
    if (mapperMatch && validMappings.length > 0) {
      const lines = content.substring(0, mapperMatch.index).split('\n');
      const mapperLine = lines.length - 1;

      codeLenses.push(this.createCodeLens(
        mapperLine,
        `$(symbol-class) 跳转到Mapper`,
        'javaNavigator.jumpToMapper',
        [{
          uri: document.uri.toString(),
          position: { line: mapperLine, column: 0 },
          direction: 'xml-to-java'
        } satisfies MyBatisNavigationRequest]
      ));
    }

    for (const sql of xmlInfo.sqlElements) {
      if (javaMethodNames.has(sql.id)) {
        codeLenses.push(this.createCodeLens(
          sql.line,
          `$(arrow-left) 跳转到方法`,
          'javaNavigator.jumpToMapper',
          [{
            uri: document.uri.toString(),
            position: { line: sql.line, column: sql.column },
            direction: 'xml-to-java'
          } satisfies MyBatisNavigationRequest]
        ));
      }
    }

    return codeLenses;
  }

  private createCodeLens(
    line: number,
    title: string,
    command: string,
    args: any[]
  ): vscode.CodeLens {
    const range = new vscode.Range(line, 0, line, 0);
    return new vscode.CodeLens(range, {
      title,
      command,
      arguments: args
    });
  }

  private async getDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
      return symbols || [];
    } catch (error) {
      this.logger.error('[UnifiedCodeLensProvider] Failed to get document symbols:', error);
      return [];
    }
  }

  private findTypePosition(content: string, className: string): vscode.Position | undefined {
    const declaration = new RegExp(
      `\\b(?:class|interface|record|enum)\\s+${JavaParser.escapeRegex(className)}\\b`
    ).exec(content);
    if (!declaration) return undefined;
    const nameOffset = content.indexOf(className, declaration.index);
    const prefix = content.slice(0, nameOffset);
    const lines = prefix.split('\n');
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
  }

  private extractMethodsFromSymbols(
    symbols: vscode.DocumentSymbol[],
    document: vscode.TextDocument
  ): Array<{ name: string; line: number; column: number; isDefault: boolean; parameters: string; parameterTypes: string[] }> {
    const methods: Array<{ name: string; line: number; column: number; isDefault: boolean; parameters: string; parameterTypes: string[] }> = [];
    const content = document.getText();
    const { explicitImports, wildcardImports } = JavaParser.extractImports(content);

    const visit = (items: vscode.DocumentSymbol[]): void => {
      for (const symbol of items) {
        if (symbol.kind === vscode.SymbolKind.Method) {
          const position = symbol.selectionRange || symbol.range;
          const methodName = symbol.name.split('(')[0];
          const paramText = this.extractMethodParamsFromSymbol(symbol, document, methodName);
          const parameterTypes = JavaParser.normalizeParameterTypes(paramText, explicitImports, wildcardImports);

          methods.push({
            name: symbol.name,
            line: position.start.line,
            column: position.start.character,
            isDefault: symbol.name.includes('default'),
            parameters: paramText || this.extractParamsFromDetail(symbol.detail),
            parameterTypes
          });
        }

        if (symbol.children) visit(symbol.children);
      }
    };

    visit(symbols);

    return methods;
  }

  private extractMethodParamsFromSymbol(
    symbol: vscode.DocumentSymbol,
    document: vscode.TextDocument,
    methodName: string
  ): string {
    const declaration = document.getText(symbol.range);
    const methodPattern = new RegExp(`\\b${JavaParser.escapeRegex(methodName)}\\s*\\(`);
    const methodMatch = methodPattern.exec(declaration);
    if (!methodMatch) return '';

    const openParen = declaration.indexOf('(', methodMatch.index);
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;

    for (let index = openParen; index < declaration.length; index++) {
      const character = declaration[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }

      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '(') {
        depth++;
      } else if (character === ')') {
        depth--;
        if (depth === 0) return declaration.substring(openParen + 1, index).trim();
      }
    }

    return '';
  }

  private extractParamsFromDetail(detail?: string): string {
    if (!detail) return '';
    const match = detail.match(/\(([^)]*)\)/);
    return match ? match[1] : '';
  }

  /**
   * 过滤系统/框架内置接口
   */
  private async filterSystemInterfaces(
    interfaces: string[],
    document: vscode.TextDocument
  ): Promise<string[]> {
    const content = document.getText();
    const filtered: string[] = [];

    for (const name of interfaces) {
      const isSystem = await this.javaLanguageService.isSystemInterfaceWithContext(
        name,
        document.uri,
        content
      );
      if (!isSystem) {
        filtered.push(name);
      }
    }

    return filtered;
  }

}
