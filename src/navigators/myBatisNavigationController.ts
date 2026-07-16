import * as path from 'path';
import * as vscode from 'vscode';
import { IndexCacheManager } from '../cache/indexCache';
import {
  MyBatisNavigationDirection,
  MyBatisNavigationRequest,
  MyBatisNavigationResult
} from '../types';
import { openFileAtPosition, readFileContent } from '../utils/fileUtils';
import { JavaParser } from '../utils/javaParser';
import { Logger } from '../utils/logger';
import { PathMatcher } from '../utils/pathMatcher';
import { XmlParser } from '../utils/xmlParser';
import { JavaMethodResolver } from './javaMethodResolver';
import { MyBatisNavigator } from './myBatisNavigator';

interface NavigationCandidate {
  filePath: string;
  label: string;
  position?: { line: number; column: number };
}

interface CandidateResolution {
  request: MyBatisNavigationRequest;
  identifier: string;
  candidates: NavigationCandidate[];
}

type ResolutionResult =
  | { kind: 'candidates'; value: CandidateResolution }
  | Extract<MyBatisNavigationResult, { kind: 'invalid-source' | 'not-found' | 'failed' }>;

export const MYBATIS_CONTEXT_COMMANDS = {
  javaToXml: 'javaNavigator.context.jumpToXml',
  xmlToJava: 'javaNavigator.context.jumpToMapper'
} as const;

export class MyBatisNavigationController {
  private readonly cache = IndexCacheManager.getInstance();
  private readonly logger = Logger.getInstance();
  private readonly navigator = MyBatisNavigator.getInstance();
  private readonly xmlParser = XmlParser.getInstance();

  createCommandDisposables(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('javaNavigator.jumpToXml', async (
        source?: MyBatisNavigationRequest | string | vscode.Uri,
        legacyMethodName?: string
      ) => this.executePublicCommand('java-to-xml', source, legacyMethodName)),
      vscode.commands.registerCommand('javaNavigator.jumpToMapper', async (
        source?: MyBatisNavigationRequest | string | vscode.Uri,
        legacySqlId?: string
      ) => this.executePublicCommand('xml-to-java', source, legacySqlId)),
      vscode.commands.registerCommand(MYBATIS_CONTEXT_COMMANDS.javaToXml, async () =>
        this.executeFromActiveEditor('java-to-xml')),
      vscode.commands.registerCommand(MYBATIS_CONTEXT_COMMANDS.xmlToJava, async () =>
        this.executeFromActiveEditor('xml-to-java'))
    ];
  }

  async execute(request: MyBatisNavigationRequest): Promise<MyBatisNavigationResult> {
    try {
      const resolution = await this.resolveCandidates(request);
      if (resolution.kind !== 'candidates') return resolution;

      const candidates = resolution.value.candidates;
      const sourcePath = vscode.Uri.parse(request.uri).fsPath;
      const uniqueBestPath = PathMatcher.selectUniqueBestMatch(
        sourcePath,
        candidates.map(candidate => candidate.filePath)
      );
      const selected = candidates.length === 1
        ? candidates[0]
        : candidates.find(candidate => candidate.filePath === uniqueBestPath) ??
          await this.pickCandidate(candidates, request.direction);
      if (!selected) return { kind: 'cancelled' };

      await openFileAtPosition(selected.filePath, selected.position);
      return { kind: 'success', targetPath: selected.filePath, position: selected.position };
    } catch (error) {
      return this.failedResult(request, error);
    }
  }

  private async executePublicCommand(
    direction: MyBatisNavigationDirection,
    source?: MyBatisNavigationRequest | string | vscode.Uri,
    legacyTargetId?: string
  ): Promise<MyBatisNavigationResult | undefined> {
    if (!this.isEnabled()) return undefined;
    try {
      const request = isMyBatisNavigationRequest(source)
        ? source
        : await this.createLegacyRequest(direction, source, legacyTargetId);
      if (!request) return undefined;
      return this.executeAndPresent(request);
    } catch (error) {
      const request = this.createFailureRequest(direction, source);
      const result = this.failedResult(request, error);
      vscode.window.showErrorMessage(result.message);
      return result;
    }
  }

  private async executeFromActiveEditor(
    direction: MyBatisNavigationDirection
  ): Promise<MyBatisNavigationResult | undefined> {
    if (!this.isEnabled()) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('请先打开要导航的 Java 或 XML 文件');
      return undefined;
    }

    const expectedLanguage = direction === 'java-to-xml' ? 'java' : 'xml';
    if (editor.document.languageId !== expectedLanguage) {
      vscode.window.showInformationMessage(`请在 ${expectedLanguage.toUpperCase()} 文件中使用此命令`);
      return undefined;
    }

    return this.executeAndPresent(createMyBatisNavigationRequest(
      editor.document,
      editor.selection.active,
      direction
    ));
  }

  private async createLegacyRequest(
    direction: MyBatisNavigationDirection,
    source?: string | vscode.Uri,
    targetId?: string
  ): Promise<MyBatisNavigationRequest | undefined> {
    if (!source) {
      return this.createRequestFromActiveEditor(direction);
    }

    const uri = typeof source === 'string' ? parseLegacyUri(source) : source;
    if (!(uri instanceof vscode.Uri)) {
      return this.createRequestFromActiveEditor(direction);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const position = targetId
      ? this.findLegacyTargetPosition(document, direction, targetId)
      : new vscode.Position(0, 0);
    return createMyBatisNavigationRequest(document, position, direction);
  }

  private createRequestFromActiveEditor(
    direction: MyBatisNavigationDirection
  ): MyBatisNavigationRequest | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor
      ? createMyBatisNavigationRequest(editor.document, editor.selection.active, direction)
      : undefined;
  }

  private findLegacyTargetPosition(
    document: vscode.TextDocument,
    direction: MyBatisNavigationDirection,
    targetId: string
  ): vscode.Position {
    if (direction === 'xml-to-java') {
      const xml = this.xmlParser.parseXmlContentFromText(document.getText(), document.uri.fsPath);
      const sql = xml?.sqlElements.find(element => element.id === targetId);
      return sql ? new vscode.Position(sql.line, sql.column) : new vscode.Position(0, 0);
    }

    const method = JavaParser.createTypeSnapshot(document.getText(), document.uri.fsPath)
      .methods.find(candidate => candidate.name === targetId);
    return method ? new vscode.Position(method.line, method.column) : new vscode.Position(0, 0);
  }

  private async executeAndPresent(request: MyBatisNavigationRequest): Promise<MyBatisNavigationResult> {
    const result = await this.execute(request);
    if (result.kind === 'invalid-source' || result.kind === 'not-found') {
      vscode.window.showInformationMessage(result.message);
    } else if (result.kind === 'failed') {
      vscode.window.showErrorMessage(result.message);
    }
    return result;
  }

  private async resolveCandidates(request: MyBatisNavigationRequest): Promise<ResolutionResult> {
    try {
      await this.cache.waitForScan();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(request.uri));
      return request.direction === 'xml-to-java'
        ? this.resolveJavaCandidates(document, request)
        : this.resolveXmlCandidates(document, request);
    } catch (error) {
      return this.failedResult(request, error);
    }
  }

  private async resolveJavaCandidates(
    document: vscode.TextDocument,
    request: MyBatisNavigationRequest
  ): Promise<ResolutionResult> {
    const xmlInfo = this.xmlParser.parseXmlContentFromText(document.getText(), document.uri.fsPath);
    if (!xmlInfo?.namespace) {
      return { kind: 'invalid-source', message: '当前 XML 不是有效的 MyBatis Mapper（缺少 mapper namespace）' };
    }

    const mappings = await this.navigator.findJavaCandidatesByNamespace(
      xmlInfo.namespace,
      document.uri.fsPath,
      !document.isDirty
    );
    const sqlId = this.findSqlIdAtPosition(document, request.position, xmlInfo.sqlElements);
    const candidates: NavigationCandidate[] = [];
    const unreadablePaths: string[] = [];
    for (const mapping of mappings) {
      const content = await readFileContent(mapping.javaPath);
      if (!content) {
        unreadablePaths.push(mapping.javaPath);
        continue;
      }
      const snapshot = JavaParser.createTypeSnapshot(content, mapping.javaPath);
      if (snapshot.fqn !== xmlInfo.namespace) continue;
      if (sqlId && !snapshot.methods.some(method => method.name === sqlId)) continue;
      candidates.push({
        filePath: mapping.javaPath,
        label: path.basename(mapping.javaPath),
        position: sqlId
          ? await JavaMethodResolver.findPosition(mapping.javaPath, sqlId)
          : this.findTypePosition(content, mapping.className)
      });
    }
    if (mappings.length > 0 && unreadablePaths.length === mappings.length) {
      throw new Error(`无法读取 Java 候选文件: ${unreadablePaths.join(', ')}`);
    }

    return candidates.length > 0
      ? { kind: 'candidates', value: { request, identifier: xmlInfo.namespace, candidates } }
      : this.notFoundResult(request, xmlInfo.namespace, sqlId);
  }

  private async resolveXmlCandidates(
    document: vscode.TextDocument,
    request: MyBatisNavigationRequest
  ): Promise<ResolutionResult> {
    const snapshot = JavaParser.createTypeSnapshot(document.getText(), document.uri.fsPath);
    if (!snapshot.fqn || !snapshot.className) {
      return { kind: 'invalid-source', message: '当前 Java 文件没有可导航的顶级类型声明' };
    }

    const xmlPaths = await this.navigator.findXmlByNamespace(
      snapshot.fqn,
      document.uri.fsPath,
      false
    );
    const methodName = await this.findJavaMethodAtPosition(document, request.position);
    const candidates: NavigationCandidate[] = [];
    for (const xmlPath of xmlPaths) {
      const xmlDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(xmlPath));
      const xmlInfo = this.xmlParser.parseXmlContentFromText(xmlDocument.getText(), xmlPath);
      if (!xmlInfo || xmlInfo.namespace !== snapshot.fqn) continue;
      const sql = methodName ? xmlInfo.sqlElements.find(element => element.id === methodName) : undefined;
      if (methodName && !sql) continue;
      candidates.push({
        filePath: xmlPath,
        label: path.basename(xmlPath),
        position: sql ? { line: sql.line, column: sql.column } : { line: 0, column: 0 }
      });
    }

    return candidates.length > 0
      ? { kind: 'candidates', value: { request, identifier: snapshot.fqn, candidates } }
      : this.notFoundResult(request, snapshot.fqn, methodName);
  }

  private findSqlIdAtPosition(
    document: vscode.TextDocument,
    position: { line: number; column: number },
    elements: Array<{ id: string; startOffset: number; endOffset: number }>
  ): string | undefined {
    const offset = document.offsetAt(new vscode.Position(position.line, position.column));
    return elements.find(element => offset >= element.startOffset && offset <= element.endOffset)?.id;
  }

  private async findJavaMethodAtPosition(
    document: vscode.TextDocument,
    position: { line: number; column: number }
  ): Promise<string | undefined> {
    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
    } catch (error) {
      this.logger.debug('[MyBatisNavigation] DocumentSymbol provider不可用，使用源码方法范围回退', error);
    }
    const semanticMethod = findMethodInSymbols(
      symbols,
      new vscode.Position(position.line, position.column)
    );
    if (semanticMethod) return semanticMethod;
    return JavaParser.findMethodAtPosition(document.getText(), position)?.name;
  }

  private findTypePosition(content: string, className: string): { line: number; column: number } {
    const offset = content.search(new RegExp(`\\b(?:class|interface|record|enum)\\s+${JavaParser.escapeRegex(className)}\\b`));
    if (offset < 0) return { line: 0, column: 0 };
    const nameOffset = content.indexOf(className, offset);
    const prefix = content.slice(0, nameOffset);
    const lines = prefix.split('\n');
    return { line: lines.length - 1, column: lines[lines.length - 1].length };
  }

  private async pickCandidate(
    candidates: NavigationCandidate[],
    direction: MyBatisNavigationDirection
  ): Promise<NavigationCandidate | undefined> {
    const items = candidates.map(candidate => ({
      label: candidate.label,
      description: candidate.filePath,
      candidate
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: direction === 'xml-to-java' ? '选择 Java 类型' : '选择 XML 文件'
    });
    return selected?.candidate;
  }

  private notFoundResult(
    request: MyBatisNavigationRequest,
    identifier: string,
    memberName?: string
  ): Extract<MyBatisNavigationResult, { kind: 'not-found' }> {
    const searchScope = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const member = memberName ? `，成员 "${memberName}"` : '';
    const target = request.direction === 'xml-to-java'
      ? `Java FQN "${identifier}"${member}`
      : `XML namespace "${identifier}"${member}`;
    const scope = searchScope.length > 0 ? searchScope.join(', ') : '当前未打开工作区';
    return {
      kind: 'not-found',
      identifier,
      searchScope,
      message: `未找到精确匹配的 ${target}；搜索范围：${scope}`
    };
  }

  private failedResult(
    request: MyBatisNavigationRequest,
    error: unknown
  ): Extract<MyBatisNavigationResult, { kind: 'failed' }> {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `[MyBatisNavigation] ${request.direction} 失败: ${request.uri} @ ${request.position.line}:${request.position.column}`,
      error
    );
    return { kind: 'failed', message: `导航失败：${detail}` };
  }

  private createFailureRequest(
    direction: MyBatisNavigationDirection,
    source?: MyBatisNavigationRequest | string | vscode.Uri
  ): MyBatisNavigationRequest {
    const uri = isMyBatisNavigationRequest(source)
      ? source.uri
      : typeof source === 'string'
        ? parseLegacyUri(source).toString()
        : source instanceof vscode.Uri
          ? source.toString()
          : '';
    return { uri, direction, position: { line: 0, column: 0 } };
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('javaNavigator')
      .get<boolean>('enableMyBatisNavigation', true);
  }
}

export function createMyBatisNavigationRequest(
  document: vscode.TextDocument,
  position: vscode.Position,
  direction: MyBatisNavigationDirection
): MyBatisNavigationRequest {
  return {
    uri: document.uri.toString(),
    position: { line: position.line, column: position.character },
    direction
  };
}

export function isMyBatisNavigationRequest(value: unknown): value is MyBatisNavigationRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MyBatisNavigationRequest>;
  return typeof candidate.uri === 'string' &&
    (candidate.direction === 'java-to-xml' || candidate.direction === 'xml-to-java') &&
    typeof candidate.position?.line === 'number' &&
    typeof candidate.position?.column === 'number';
}

function parseLegacyUri(source: string): vscode.Uri {
  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(source)
    ? vscode.Uri.parse(source)
    : vscode.Uri.file(source);
}

function findMethodInSymbols(
  symbols: vscode.DocumentSymbol[] | undefined,
  position: vscode.Position
): string | undefined {
  for (const symbol of symbols ?? []) {
    if (symbol.kind === vscode.SymbolKind.Method && symbol.range.contains(position)) {
      return symbol.name.split('(')[0];
    }
    const child = findMethodInSymbols(symbol.children, position);
    if (child) return child;
  }
  return undefined;
}
