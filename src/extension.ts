/**
 * Java Jump - 扩展入口
 *
 * MyBatis Mapper XML 双向导航扩展入口。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';

import { IndexCacheManager } from './cache/indexCache';
import { JavaParser } from './utils/javaParser';
import { XmlParser } from './utils/xmlParser';
import { Logger } from './utils/logger';
import { PathMatcher } from './utils/pathMatcher';
import { buildJavaDiagnosticReport, buildXmlDiagnosticReport } from './utils/navigationDiagnostics';
import { UnifiedNavigator } from './navigators/unifiedNavigator';
import { MyBatisNavigator } from './navigators/myBatisNavigator';
import { MyBatisNavigationController } from './navigators/myBatisNavigationController';
import { UnifiedCodeLensProvider } from './providers/unifiedCodeLensProvider';
import { JavaNavigationRequest, JavaTypeSnapshot, MapperMapping, MethodMapping } from './types';
import { shouldIgnoreFile, getUnifiedExcludePattern } from './utils/fileUtils';
import { FixedWindowBatcher } from './utils/fixedWindowBatcher';
import { GitHeadWatcher } from './utils/gitHeadWatcher';
import { QuietPeriodTaskScheduler } from './utils/quietPeriodTaskScheduler';

// 全局实例
let logger: Logger;
let cache: IndexCacheManager;
let xmlParser: XmlParser;
let unifiedNavigator: UnifiedNavigator;
let myBatisNavigator: MyBatisNavigator;
let myBatisNavigationController: MyBatisNavigationController;
let codeLensProvider: UnifiedCodeLensProvider;

// 文件监听
let fileWatcher: vscode.FileSystemWatcher;

// 防抖定时器
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_DELAY = 300;

// 批量变更检测
const BATCH_CHANGE_WINDOW = 1000; // 1秒窗口
const BATCH_CHANGE_THRESHOLD = 5; // 窗口内超过5个文件变更视为批量操作
const INDEX_RESCAN_QUIET_PERIOD = 1000;
let fileChangeBatcher: FixedWindowBatcher | undefined;
let fullRescanScheduler: QuietPeriodTaskScheduler | undefined;
let gitHeadWatcher: GitHeadWatcher | undefined;

/**
 * 扩展激活
 * 初始化 Mapper 与 XML 导航服务。
 */
export async function activate(context: vscode.ExtensionContext) {
  logger = Logger.getInstance();
  logger.initializeFromConfig();
  logger.info('Java Jump 扩展已激活');

  context.subscriptions.push(logger.registerConfigListener());

  cache = IndexCacheManager.getInstance();
  fullRescanScheduler = new QuietPeriodTaskScheduler({
    quietPeriodMs: INDEX_RESCAN_QUIET_PERIOD,
    onFirstRequest: () => cache.clearAll(),
    onQuietPeriodElapsed: () => { void initializeProjectScan(true); }
  });
  context.subscriptions.push(fullRescanScheduler);
  xmlParser = XmlParser.getInstance();
  unifiedNavigator = UnifiedNavigator.getInstance();
  myBatisNavigator = MyBatisNavigator.getInstance();
  myBatisNavigationController = new MyBatisNavigationController();

  // 配置变化时触发索引刷新。缓存必须先初始化，避免激活期间的竞态。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('javaNavigator')) {
        logger.info('[Java Jump] 配置已变更，触发索引刷新');
        cancelPendingFullIndexRescan();
        cache.clearAll();
        void initializeProjectScan(true);
      }
    })
  );

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
  startGitHeadWatching(context);

  void initializeProjectScan();

  logger.info('Java Jump 初始化完成');
}

/**
 * 注册命令
 */
function registerCommands(context: vscode.ExtensionContext) {
  const commands = [
    // 接口/实现导航仅供 CodeLens 调用，不注册到右键菜单或快捷键。
    vscode.commands.registerCommand('javaNavigator.jumpToImplementation', async (
      arg1?: string | JavaNavigationRequest,
      typeName?: string,
      isAbstractOrMethod?: boolean | string
    ) => {
      if (typeof arg1 === 'object') {
        await unifiedNavigator.jump(arg1);
        return;
      }
      const type = isAbstractOrMethod === 'method'
        ? 'interface-method-to-impl'
        : 'interface-to-impl';
      await unifiedNavigator.jump(arg1 ?? '', type, typeName);
    }),

    vscode.commands.registerCommand('javaNavigator.jumpToInterface', async (
      arg1?: string | JavaNavigationRequest,
      methodName?: string
    ) => {
      if (typeof arg1 === 'object') {
        await unifiedNavigator.jump(arg1);
        return;
      }
      await unifiedNavigator.jump(arg1 ?? '', 'impl-method-to-interface', methodName);
    }),

    vscode.commands.registerCommand('javaNavigator.jumpToInterfaceFromClass', async (
      arg1?: string | JavaNavigationRequest
    ) => {
      if (typeof arg1 === 'object') {
        await unifiedNavigator.jump(arg1);
        return;
      }
      await unifiedNavigator.jump(arg1 ?? '', 'impl-to-interface');
    }),

    ...myBatisNavigationController.createCommandDisposables(),

    // 刷新索引
    vscode.commands.registerCommand('javaNavigator.refreshIndex', async () => {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在刷新索引...',
        cancellable: false
      }, async () => {
        cancelPendingFullIndexRescan();
        cache.clearAll();
        await initializeProjectScan(true);
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
      const filePath = editor?.document.uri.fsPath;
      if (!filePath || (!filePath.endsWith('.java') && !filePath.endsWith('.xml'))) {
        vscode.window.showInformationMessage('请在Java或XML文件中使用此命令');
        return;
      }

      const cacheDiagnostics = cache.getDiagnostics();
      const output = filePath.endsWith('.java')
        ? (() => {
            const snapshot = JavaParser.createTypeSnapshot(editor.document.getText(), filePath);
            return buildJavaDiagnosticReport({
              filePath,
              snapshot,
              mappings: cache.getByNamespaceCandidates(snapshot.fqn),
              xmlPaths: cache.getXmlPathsByNamespace(snapshot.fqn),
              cache: cacheDiagnostics
            });
          })()
        : (() => {
            const xmlInfo = xmlParser.parseXmlContentFromText(editor.document.getText(), filePath);
            if (!xmlInfo) return [{ label: 'XML', detail: '不是有效的MyBatis Mapper XML' }];
            const mappings = cache.getByXmlPathCandidates(filePath)
              .filter(mapping => mapping.namespace === xmlInfo.namespace);
            return buildXmlDiagnosticReport({
              filePath,
              namespace: xmlInfo.namespace,
              mappings: mappings.length > 0 ? mappings : cache.getByNamespaceCandidates(xmlInfo.namespace),
              cache: cacheDiagnostics
            });
          })();

      logger.info('========== 诊断信息 ==========');
      output.forEach(item => logger.info(`${item.label}: ${item.detail ?? ''}`));
      logger.info('==============================');

      vscode.window.showInformationMessage('诊断信息已输出到控制台');
    })
  ];

  context.subscriptions.push(...commands);
}

/**
 * 启动文件监听
 */
function startFileWatching(context: vscode.ExtensionContext) {
  fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{java,xml}');
  fileChangeBatcher?.dispose();
  fileChangeBatcher = new FixedWindowBatcher({
    windowMs: BATCH_CHANGE_WINDOW,
    threshold: BATCH_CHANGE_THRESHOLD
  });
  context.subscriptions.push(fileChangeBatcher);

  const handleFileChange = (uri: vscode.Uri, type: 'create' | 'change' | 'delete') => {
    if (shouldIgnoreFile(uri.fsPath)) return;

    logger.debug(`文件${type}: ${uri.fsPath}`);

    // Count a fixed window so continuous changes cannot accumulate indefinitely.
    const batchState = fileChangeBatcher?.record();
    const isBatch = batchState?.isBatch ?? false;

    if (batchState?.crossedThreshold) {
      logger.info('检测到批量文件变更，等待文件稳定后重建索引');
      requestFullIndexRescan();
    } else if (fullRescanScheduler?.isPending) {
      requestFullIndexRescan();
    }

    // 单文件防抖处理（批量变更时不逐个刷新，等重新扫描统一刷新）
    if (!isBatch && !fullRescanScheduler?.isPending) {
      const existingTimer = debounceTimers.get(uri.fsPath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        try {
          await cache.waitForScan();
          await updateIndexForFile(uri, type);
          codeLensProvider.refresh();
        } catch (error) {
          logger.warn(`更新文件索引失败: ${uri.fsPath}`, error);
        } finally {
          debounceTimers.delete(uri.fsPath);
        }
      }, DEBOUNCE_DELAY);

      debounceTimers.set(uri.fsPath, timer);
    }
  };

  fileWatcher.onDidCreate(uri => handleFileChange(uri, 'create'));
  fileWatcher.onDidChange(uri => handleFileChange(uri, 'change'));
  fileWatcher.onDidDelete(uri => handleFileChange(uri, 'delete'));

  context.subscriptions.push(fileWatcher);
}

function startGitHeadWatching(context: vscode.ExtensionContext): void {
  gitHeadWatcher?.dispose();
  gitHeadWatcher = new GitHeadWatcher({
    onDidChange: () => {
      logger.info('检测到 Git HEAD 变更，等待文件稳定后重建索引');
      requestFullIndexRescan();
    },
    onError: (message, error) => logger.debug(message, error)
  });
  context.subscriptions.push(gitHeadWatcher);
  void gitHeadWatcher.start();
}

function cancelDebouncedFileUpdates(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

function requestFullIndexRescan(): void {
  cancelDebouncedFileUpdates();
  fullRescanScheduler?.request();
}

function cancelPendingFullIndexRescan(): void {
  fullRescanScheduler?.dispose();
}

/**
 * 初始化项目扫描
 */
async function initializeProjectScan(forceRescan = false) {
  await cache.getOrCreateScanTask(async () => {
    try {
      const config = vscode.workspace.getConfiguration('javaNavigator');
      const cacheEnabled = config.get<boolean>('cacheEnabled', true);

      if (!cacheEnabled) {
        logger.info('索引缓存已禁用，跳过初始化预扫描');
        codeLensProvider?.refresh();
        return;
      }

      // 必须在任何异步文件发现之前领取generation，后续清空/增量更新才能使本次扫描失效。
      const generation = cache.beginGeneration();
      const excludePattern = getUnifiedExcludePattern();
      const [javaFiles, xmlFiles] = await Promise.all([
        vscode.workspace.findFiles('**/*.java', excludePattern),
        vscode.workspace.findFiles('**/*.xml', excludePattern)
      ]);

      logger.info(`找到 ${javaFiles.length} 个Java文件, ${xmlFiles.length} 个XML文件`);

      // 解析XML建立namespace映射
      const xmlNamespaceMap = new Map<string, string[]>();
      const BATCH = 30;
      for (let i = 0; i < xmlFiles.length; i += BATCH) {
        await Promise.all(xmlFiles.slice(i, i + BATCH).map(async (xmlFile) => {
          // 全量索引只发布磁盘状态；未保存文本仅参与当前导航请求。
          const content = await fs.readFile(xmlFile.fsPath, 'utf8');
          const xmlInfo = xmlParser.parseXmlContentFromText(content, xmlFile.fsPath);
          if (xmlInfo?.namespace) {
            const existing = xmlNamespaceMap.get(xmlInfo.namespace) || [];
            existing.push(xmlFile.fsPath);
            xmlNamespaceMap.set(xmlInfo.namespace, existing);
          }
        }));
      }

      logger.info(`解析了 ${xmlNamespaceMap.size} 个XML namespace`);

      // 扫描Java文件：建立类型快照和Mapper映射
      const typeSnapshots: JavaTypeSnapshot[] = [];
      const mappings: MapperMapping[] = [];
      for (let i = 0; i < javaFiles.length; i += BATCH) {
        await Promise.all(javaFiles.slice(i, i + BATCH).map(async (javaFile) => {
          try {
            const content = await fs.readFile(javaFile.fsPath, 'utf8');

            // 创建类型快照
            const snapshot = JavaParser.createTypeSnapshot(content, javaFile.fsPath);
            if (snapshot.className) {
              typeSnapshots.push(snapshot);
            }

            // namespace=FQN 是映射依据；命名/注解仅用于保留尚未创建XML的候选。
            const xmlPaths = xmlNamespaceMap.get(snapshot.fqn);
            if (xmlPaths?.length || snapshot.isMapper) {
              const bestXmlPath = xmlPaths?.length
                ? PathMatcher.selectUniqueBestMatch(javaFile.fsPath, xmlPaths)
                : undefined;
              mappings.push(createMapperMapping(snapshot, bestXmlPath));
            }
          } catch (error) {
            logger.warn(`处理Java文件失败: ${javaFile.fsPath}`, error);
          }
        }));
      }

      const published = cache.publishGeneration(generation, typeSnapshots, mappings, xmlNamespaceMap);
      if (published) {
        logger.info(`索引了 ${typeSnapshots.length} 个类型, ${mappings.length} 个Mapper接口`);
        codeLensProvider?.refresh();
      } else {
        logger.info(`放弃发布过期索引 generation=${generation}`);
      }
    } catch (error) {
      logger.error('项目扫描失败:', error);
    }
  }, forceRescan);
}

async function updateIndexForFile(uri: vscode.Uri, type: 'create' | 'change' | 'delete'): Promise<void> {
  const filePath = uri.fsPath;
  if (type === 'delete') {
    cache.invalidateForFile(filePath);
    return;
  }

  if (filePath.endsWith('.xml')) {
    const previousMappings = cache.getByXmlPathCandidates(filePath);
    const xmlInfo = await xmlParser.parseXmlMapper(filePath);
    if (!xmlInfo?.namespace) {
      cache.invalidateForFile(filePath);
      return;
    }

    if (previousMappings.some(mapping => mapping.namespace !== xmlInfo.namespace)) {
      cache.clearMappingsForXmlPath(filePath);
    }
    // XML路径与namespace独立于Java Mapper映射缓存维护。先发布它，后续候选查找可避免全仓XML重扫。
    cache.updateXmlNamespace(filePath, xmlInfo.namespace);
    const mappings = await myBatisNavigator.findJavaCandidatesByNamespace(xmlInfo.namespace, filePath);
    if (mappings.length > 0) {
      for (const mapping of mappings) {
      const xmlPaths = await myBatisNavigator.findXmlByNamespace(
        xmlInfo.namespace, mapping.javaPath, true
      );
      const bestXmlPath = PathMatcher.selectUniqueBestMatch(mapping.javaPath, xmlPaths);
      if (bestXmlPath) cache.updateXmlPath(mapping.javaPath, bestXmlPath);
      else cache.clearXmlPath(mapping.javaPath);
      }
    } else {
      // 无Java候选不等于不是有效Mapper XML；仅清旧绑定，保留其namespace供后续Java创建或CodeLens发现。
      cache.clearMappingsForXmlPath(filePath);
    }
    return;
  }

  const content = await fs.readFile(filePath, 'utf8');
  const snapshot = JavaParser.createTypeSnapshot(content, filePath);
  if (!snapshot.className) {
    cache.updateFile(filePath);
    return;
  }

  const xmlPaths = await myBatisNavigator.findXmlByNamespace(snapshot.fqn, filePath, true);
  const mapping = xmlPaths.length > 0 || snapshot.isMapper
    ? createMapperMapping(snapshot, PathMatcher.selectUniqueBestMatch(filePath, xmlPaths))
    : undefined;

  cache.updateFile(filePath, snapshot, mapping);
}

function createMapperMapping(snapshot: JavaTypeSnapshot, xmlPath?: string): MapperMapping {
  const methods = new Map<string, MethodMapping>(snapshot.methods.map(method => [method.name, {
    name: method.name,
    javaPosition: { line: method.line, column: method.column }
  }]));

  return {
    javaPath: snapshot.filePath,
    xmlPath,
    namespace: snapshot.fqn,
    className: snapshot.className,
    methods
  };
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
  fileChangeBatcher?.dispose();
  fileChangeBatcher = undefined;

  cancelPendingFullIndexRescan();
  fullRescanScheduler = undefined;

  cancelDebouncedFileUpdates();
  gitHeadWatcher?.dispose();
  gitHeadWatcher = undefined;

  cache.clearAll();
  logger.info('Java Jump 扩展已停用');
}
