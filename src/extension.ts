/**
 * Java Jump - 扩展入口
 *
 * 融合功能：
 * 1. Java接口实现跳转
 * 2. MyBatis Mapper XML导航
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';

import { IndexCacheManager } from './cache/indexCache';
import { JavaParser } from './utils/javaParser';
import { XmlParser } from './utils/xmlParser';
import { Logger } from './utils/logger';
import { PathMatcher } from './utils/pathMatcher';
import { UnifiedNavigator } from './navigators/unifiedNavigator';
import { UnifiedCodeLensProvider } from './providers/unifiedCodeLensProvider';
import { shouldIgnoreFile } from './utils/fileUtils';

// 全局实例
let logger: Logger;
let cache: IndexCacheManager;
let xmlParser: XmlParser;
let unifiedNavigator: UnifiedNavigator;
let codeLensProvider: UnifiedCodeLensProvider;

// 文件监听
let fileWatcher: vscode.FileSystemWatcher;
let cacheCleanupInterval: ReturnType<typeof setInterval>;

// 防抖定时器
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_DELAY = 300;

/**
 * 扩展激活
 * 依据 Red Hat Java 扩展的可用性决定是否启用完整功能
 */
export async function activate(context: vscode.ExtensionContext) {
  logger = Logger.getInstance();
  logger.initializeFromConfig();
  logger.info('Java Jump 扩展已激活');

  context.subscriptions.push(logger.registerConfigListener());

  // 检查 Red Hat Java 扩展是否可用
  const redHatJavaExtension = vscode.extensions.getExtension('redhat.java');
  const isRedHatJavaAvailable = !!redHatJavaExtension;

  if (!isRedHatJavaAvailable) {
    logger.info('[Java Jump] Red Hat Java 扩展未安装，功能将受限');
    vscode.window.showInformationMessage(
      'Java Jump: 建议安装 Red Hat Java 扩展以获得完整的 Java 导航功能',
      '安装 Red Hat Java'
    ).then(selection => {
      if (selection === '安装 Red Hat Java') {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('vscode:extension/redhat.java'));
      }
    });
  } else {
    // 等待 Red Hat Java 扩展激活
    if (!redHatJavaExtension.isActive) {
      logger.info('[Java Jump] 等待 Red Hat Java 扩展激活...');
      try {
        await redHatJavaExtension.activate();
        logger.info('[Java Jump] Red Hat Java 扩展已激活');
      } catch (error) {
        logger.warn('[Java Jump] Red Hat Java 扩展激活失败:', error);
      }
    } else {
      logger.info('[Java Jump] Red Hat Java 扩展已处于激活状态');
    }
  }

  cache = IndexCacheManager.getInstance();
  xmlParser = XmlParser.getInstance();
  unifiedNavigator = UnifiedNavigator.getInstance();

  codeLensProvider = new UnifiedCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: '**/*.java' },
      codeLensProvider
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: '**/*.xml' },
      codeLensProvider
    )
  );

  registerCommands(context);
  startFileWatching(context);

  cacheCleanupInterval = setInterval(() => {
    cache.clearAll();
    logger.info('缓存已清理');
  }, 30 * 60 * 1000);

  initializeProjectScan();

  logger.info('Java Jump 初始化完成');
}

/**
 * 注册命令
 */
function registerCommands(context: vscode.ExtensionContext) {
  const commands = [
    // 跳转到实现
    vscode.commands.registerCommand('javaNavigator.jumpToImplementation', async (
      filePath: string,
      typeName: string,
      isAbstractOrMethod?: boolean | string
    ) => {
      const type = isAbstractOrMethod === 'method'
        ? 'interface-method-to-impl'
        : 'interface-to-impl';
      await unifiedNavigator.jump(filePath, type, typeName);
    }),

    // 跳转到接口（方法级别）
    vscode.commands.registerCommand('javaNavigator.jumpToInterface', async (
      filePath: string,
      methodName: string
    ) => {
      await unifiedNavigator.jump(filePath, 'impl-method-to-interface', methodName);
    }),

    // 跳转到接口（类级别）
    vscode.commands.registerCommand('javaNavigator.jumpToInterfaceFromClass', async (
      filePath: string
    ) => {
      await unifiedNavigator.jump(filePath, 'impl-to-interface');
    }),

    // 跳转到XML
    vscode.commands.registerCommand('javaNavigator.jumpToXml', async (
      filePath?: string,
      methodName?: string
    ) => {
      // 如果通过CodeLens传递了methodName，直接使用
      if (filePath && methodName) {
        await unifiedNavigator.jump(filePath, 'mapper-method-to-sql', methodName);
        return;
      }

      const { targetPath, targetMethod } = await resolveTargetFromEditor(filePath, 'java', async (doc, pos) => {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', doc.uri
        );
        return findMethodNameAtPosition(symbols, pos);
      });

      if (!targetPath) return;

      const type = targetMethod ? 'mapper-method-to-sql' : 'mapper-to-xml';
      await unifiedNavigator.jump(targetPath, type, targetMethod);
    }),

    // 跳转到Mapper
    vscode.commands.registerCommand('javaNavigator.jumpToMapper', async (
      filePath?: string,
      sqlId?: string
    ) => {
      // 如果通过CodeLens传递了sqlId，直接使用
      if (filePath && sqlId) {
        await unifiedNavigator.jump(filePath, 'sql-to-mapper-method', sqlId);
        return;
      }

      const { targetPath, targetMethod } = await resolveTargetFromEditor(filePath, 'xml', async (doc, pos) => {
        return xmlParser.extractCurrentSqlId(doc, pos);
      });

      if (!targetPath) return;

      const type = targetMethod ? 'sql-to-mapper-method' : 'xml-to-mapper';
      await unifiedNavigator.jump(targetPath, type, targetMethod);
    }),

    // 刷新索引
    vscode.commands.registerCommand('javaNavigator.refreshIndex', async () => {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在刷新索引...',
        cancellable: false
      }, async () => {
        cache.clearAll();
        await initializeProjectScan();
      });
      vscode.window.showInformationMessage('索引已刷新');
    }),

    // 显示导航图谱
    vscode.commands.registerCommand('javaNavigator.showNavigationGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('请先打开一个文件');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      if (filePath.endsWith('.java')) {
        await showJavaNavigationGraph(filePath);
      } else if (filePath.endsWith('.xml')) {
        await showXmlNavigationGraph(filePath);
      }
    }),

    // 诊断
    vscode.commands.registerCommand('javaNavigator.diagnose', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor?.document.uri.fsPath.endsWith('.java')) {
        vscode.window.showInformationMessage('请在Java文件中使用此命令');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const content = await fs.readFile(filePath, 'utf8');
      const javaInfo = JavaParser.parseContent(content, filePath);

      // 使用局部导入获取文件名
      const path = await import('path');
      const output = [
        `文件: ${path.basename(filePath)}`,
        `类名: ${javaInfo.className}`,
        `包名: ${javaInfo.packageName}`,
        `是接口: ${javaInfo.isInterface}`,
        `是抽象类: ${javaInfo.isAbstract}`,
        `是Mapper: ${javaInfo.isMapper}`,
        `实现的接口: [${javaInfo.interfaces.join(', ')}]`,
        `父类: ${javaInfo.superClass || '无'}`,
        `方法数: ${javaInfo.methods.length}`
      ];

      logger.info('========== 诊断信息 ==========');
      output.forEach(line => logger.info(line));
      logger.info('==============================');

      vscode.window.showInformationMessage('诊断信息已输出到控制台');
    })
  ];

  context.subscriptions.push(...commands);
}

/**
 * 从编辑器解析目标路径和方法名
 */
async function resolveTargetFromEditor(
  filePath: string | undefined,
  languageId: string,
  extractMethodName: (doc: vscode.TextDocument, pos: vscode.Position) => Promise<string | undefined>
): Promise<{ targetPath: string | undefined; targetMethod: string | undefined }> {
  if (filePath) {
    return { targetPath: filePath, targetMethod: undefined };
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== languageId) {
    vscode.window.showInformationMessage(`请在${languageId.toUpperCase()}文件中使用此命令`);
    return { targetPath: undefined, targetMethod: undefined };
  }

  const targetPath = editor.document.uri.fsPath;
  const targetMethod = await extractMethodName(editor.document, editor.selection.active);

  return { targetPath, targetMethod };
}

/**
 * 在符号树中查找位置所在的方法名
 */
function findMethodNameAtPosition(
  symbols: vscode.DocumentSymbol[] | undefined,
  position: vscode.Position
): string | undefined {
  if (!symbols) return undefined;

  for (const symbol of symbols) {
    if (symbol.kind === vscode.SymbolKind.Method && symbol.range.contains(position)) {
      return symbol.name.split('(')[0];
    }
    if (symbol.children) {
      const found = findMethodNameAtPosition(symbol.children, position);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 启动文件监听
 */
function startFileWatching(context: vscode.ExtensionContext) {
  fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{java,xml}');

  const handleFileChange = (uri: vscode.Uri, type: 'create' | 'change' | 'delete') => {
    if (shouldIgnoreFile(uri.fsPath)) return;

    logger.debug(`文件${type}: ${uri.fsPath}`);

    const existingTimer = debounceTimers.get(uri.fsPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      cache.invalidateForFile(uri.fsPath);
      codeLensProvider.refresh();
      debounceTimers.delete(uri.fsPath);
    }, DEBOUNCE_DELAY);

    debounceTimers.set(uri.fsPath, timer);
  };

  fileWatcher.onDidCreate(uri => handleFileChange(uri, 'create'));
  fileWatcher.onDidChange(uri => handleFileChange(uri, 'change'));
  fileWatcher.onDidDelete(uri => handleFileChange(uri, 'delete'));

  context.subscriptions.push(fileWatcher);
}

/**
 * 初始化项目扫描
 */
async function initializeProjectScan() {
  try {
    const config = vscode.workspace.getConfiguration('javaNavigator');
    const cacheEnabled = config.get<boolean>('cacheEnabled', true);

    if (!cacheEnabled) {
      logger.info('索引缓存已禁用，跳过初始化预扫描');
      codeLensProvider?.refresh();
      return;
    }

    const excludePattern = '**/{node_modules,.git,target,build,out,dist}/**';
    const [javaFiles, xmlFiles] = await Promise.all([
      vscode.workspace.findFiles('**/*.java', excludePattern, 500),
      vscode.workspace.findFiles('**/*.xml', excludePattern, 500)
    ]);

    logger.info(`找到 ${javaFiles.length} 个Java文件, ${xmlFiles.length} 个XML文件`);

    // 解析XML建立namespace映射
    const xmlNamespaceMap = new Map<string, string[]>();
    for (const xmlFile of xmlFiles) {
      const xmlInfo = await xmlParser.parseXmlMapper(xmlFile.fsPath);
      if (xmlInfo?.namespace) {
        const existing = xmlNamespaceMap.get(xmlInfo.namespace) || [];
        existing.push(xmlFile.fsPath);
        xmlNamespaceMap.set(xmlInfo.namespace, existing);
      }
    }

    logger.info(`解析了 ${xmlNamespaceMap.size} 个XML namespace`);

    // 扫描Mapper接口
    let mapperCount = 0;
    for (const javaFile of javaFiles.slice(0, 200)) {
      try {
        const content = await fs.readFile(javaFile.fsPath, 'utf8');
        if (!JavaParser.isMyBatisMapper(content, javaFile.fsPath)) continue;

        const javaInfo = JavaParser.parseContent(content, javaFile.fsPath);
        if (!javaInfo.isMapper) continue;

        mapperCount++;
        const fullClassName = javaInfo.packageName
          ? `${javaInfo.packageName}.${javaInfo.className}`
          : javaInfo.className;

        const xmlPaths = xmlNamespaceMap.get(fullClassName);
        if (xmlPaths?.length) {
          const bestXmlPath = PathMatcher.selectBestMatch(javaFile.fsPath, xmlPaths) || xmlPaths[0];

          cache.setMapping({
            javaPath: javaFile.fsPath,
            xmlPath: bestXmlPath,
            namespace: fullClassName,
            className: javaInfo.className,
            methods: new Map(javaInfo.methods.map(m => [m.name, {
              name: m.name,
              javaPosition: { line: m.line, column: m.column }
            }]))
          });
        }
      } catch (error) {
        logger.warn(`处理Java文件失败: ${javaFile.fsPath}`, error);
      }
    }

    logger.info(`找到 ${mapperCount} 个Mapper接口，已建立映射`);
    codeLensProvider?.refresh();
  } catch (error) {
    logger.error('项目扫描失败:', error);
  }
}

/**
 * 显示Java文件的导航图谱
 */
async function showJavaNavigationGraph(filePath: string) {
  const path = await import('path');
  const content = await fs.readFile(filePath, 'utf8');
  const javaInfo = JavaParser.parseContent(content, filePath);
  const items: vscode.QuickPickItem[] = [];

  if (javaInfo.isInterface) {
    items.push({ label: '$(symbol-interface) 接口', description: javaInfo.className });
  } else if (javaInfo.interfaces.length > 0) {
    items.push({ label: '$(symbol-class) 实现类', description: javaInfo.className });
    for (const intf of javaInfo.interfaces.filter(i => !i.startsWith('__extends:'))) {
      items.push({ label: `  $(symbol-interface) ${intf}`, description: '' });
    }
  }

  if (javaInfo.isMapper) {
    items.push({ label: '', description: '' });
    items.push({ label: '$(file-code) MyBatis Mapper', description: javaInfo.className });
    const mapping = cache.getByJavaPath(filePath);
    if (mapping?.xmlPath) {
      items.push({ label: `  $(file-code) ${path.basename(mapping.xmlPath)}`, description: mapping.xmlPath });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${javaInfo.className} - 导航图谱`
  });

  if (selected?.description?.endsWith('.java') || selected?.description?.endsWith('.xml')) {
    const doc = await vscode.workspace.openTextDocument(selected.description);
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * 显示XML文件的导航图谱
 */
async function showXmlNavigationGraph(filePath: string) {
  const path = await import('path');
  const xmlInfo = await xmlParser.parseXmlMapper(filePath);
  if (!xmlInfo) {
    vscode.window.showInformationMessage('不是有效的MyBatis Mapper XML文件');
    return;
  }

  const items: vscode.QuickPickItem[] = [
    { label: '$(file-code) XML文件', description: path.basename(filePath) },
    { label: `$(symbol-namespace) namespace`, description: xmlInfo.namespace }
  ];

  const mapping = cache.getByXmlPath(filePath);
  if (mapping) {
    items.push({ label: `$(symbol-class) ${path.basename(mapping.javaPath)}`, description: mapping.javaPath });
  }

  if (xmlInfo.sqlElements.length > 0) {
    items.push({ label: '', description: '' });
    items.push({ label: `$(list-unordered) SQL语句 (${xmlInfo.sqlElements.length})`, description: '' });
    for (const sql of xmlInfo.sqlElements.slice(0, 10)) {
      items.push({ label: `  $(database) ${sql.id}`, description: `<${sql.type}>` });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${xmlInfo.namespace} - 导航图谱`
  });

  if (selected?.description?.endsWith('.java')) {
    const doc = await vscode.workspace.openTextDocument(selected.description);
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * 扩展停用
 */
export function deactivate() {
  if (cacheCleanupInterval) {
    clearInterval(cacheCleanupInterval);
  }

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  cache.clearAll();
  logger.info('Java Jump 扩展已停用');
}
