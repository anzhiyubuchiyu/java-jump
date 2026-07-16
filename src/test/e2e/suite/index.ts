import { execFileSync } from 'child_process';
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { IndexCacheManager } from '../../../cache/indexCache';

const EXTENSION_ID = 'anzhiyubuchiyu.java-jump';

export async function run(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'E2E工作区未打开');

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `未找到开发扩展 ${EXTENSION_ID}`);
  await extension.activate();
  await vscode.commands.executeCommand('javaNavigator.refreshIndex');

  const mapperPath = path.join(workspaceRoot, 'src/main/java/com/example/mapper/UserMapper.java');
  const xmlPath = path.join(workspaceRoot, 'src/main/resources/mapper/UserMapper.xml');
  const featureXmlPath = path.join(workspaceRoot, 'src/main/resources/mapper/UserMapperFeature.xml');
  const interfacePath = path.join(workspaceRoot, 'src/main/java/com/example/service/UserService.java');
  const implementationPath = path.join(workspaceRoot, 'src/main/java/com/example/service/UserServiceImpl.java');
  const moduleBMapperPath = path.join(workspaceRoot, 'module-b/src/main/java/com/example/mapper/UserMapper.java');
  const moduleBXmlPath = path.join(workspaceRoot, 'module-b/src/main/resources/mapper/UserMapper.xml');
  const gatewayPath = path.join(workspaceRoot, 'src/main/java/com/example/data/StudentGateway.java');
  const queriesPath = path.join(workspaceRoot, 'src/main/resources/sql/queries.xml');
  const missingMapperPath = path.join(
    workspaceRoot,
    'src/main/java/com/example/missing/MissingMapper.java'
  );

  const mapperDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(mapperPath));
  const mapperEditor = await vscode.window.showTextDocument(mapperDocument);
  mapperEditor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('javaNavigator.context.jumpToXml', { unexpected: 'context' });
  assertActiveDocument(xmlPath, 'Java右键命令应跳转到XML');

  const xmlDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(xmlPath));
  const xmlEditor = await vscode.window.showTextDocument(xmlDocument);
  xmlEditor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('javaNavigator.context.jumpToMapper', { unexpected: 'context' });
  assertActiveDocument(mapperPath, 'XML右键命令应跳转到Mapper');

  await vscode.window.showTextDocument(xmlDocument);
  const mapperCodeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    xmlDocument.uri
  ) ?? [];
  const mapperCodeLens = mapperCodeLenses.find(lens =>
    lens.command?.arguments?.[0]?.direction === 'xml-to-java'
  );
  assert.ok(mapperCodeLens?.command, 'XML应生成统一请求格式的Mapper CodeLens');
  await vscode.commands.executeCommand(
    mapperCodeLens.command.command,
    ...(mapperCodeLens.command.arguments ?? [])
  );
  assertActiveDocument(mapperPath, 'XML CodeLens应与右键跳转到同一Mapper');

  await vscode.commands.executeCommand('javaNavigator.jumpToMapper', vscode.Uri.file(xmlPath));
  assertActiveDocument(mapperPath, 'XML命令应接受Uri参数并跳转到Mapper');

  const queriesDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(queriesPath));
  const queriesEditor = await vscode.window.showTextDocument(queriesDocument);
  queriesEditor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('javaNavigator.context.jumpToMapper', { unexpected: 'context' });
  assertActiveDocument(gatewayPath, '右键应仅凭精确namespace定位任意Java类型');

  await vscode.window.showTextDocument(queriesDocument);
  const gatewayCodeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    queriesDocument.uri
  ) ?? [];
  const gatewayCodeLens = gatewayCodeLenses.find(lens =>
    lens.command?.arguments?.[0]?.direction === 'xml-to-java'
  );
  assert.ok(gatewayCodeLens?.command, '通用namespace映射应生成CodeLens');
  await vscode.commands.executeCommand(
    gatewayCodeLens.command.command,
    ...(gatewayCodeLens.command.arguments ?? [])
  );
  assertActiveDocument(gatewayPath, '通用映射的CodeLens与右键应到达同一Java类型');

  await vscode.commands.executeCommand('javaNavigator.jumpToXml', {
    uri: vscode.Uri.file(gatewayPath).toString(),
    position: { line: 3, column: 12 },
    direction: 'java-to-xml'
  });
  assertActiveDocument(queriesPath, '方法导航应检查同namespace的所有XML而非仅绑定路径');

  const navigationConfig = vscode.workspace.getConfiguration('javaNavigator');
  await navigationConfig.update('cacheEnabled', false, vscode.ConfigurationTarget.Workspace);
  const gatewayDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(gatewayPath));
  const uncachedCodeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    gatewayDocument.uri
  ) ?? [];
  assert.ok(uncachedCodeLenses.some(lens =>
    lens.command?.arguments?.[0]?.direction === 'java-to-xml'
  ), '缓存关闭时精确FQN映射仍应生成Java CodeLens');
  await navigationConfig.update('cacheEnabled', true, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('javaNavigator.refreshIndex');

  const missingMapperDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(missingMapperPath)
  );
  const missingCodeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    missingMapperDocument.uri
  ) ?? [];
  assert.ok(!missingCodeLenses.some(lens =>
    lens.command?.command === 'javaNavigator.jumpToImplementation' ||
    lens.command?.command === 'javaNavigator.jumpToXml'
  ), '无实现且无精确XML的接口不应显示实现或XML CodeLens');

  await vscode.commands.executeCommand('javaNavigator.jumpToXml', moduleBMapperPath);
  assertActiveDocument(moduleBXmlPath, '重复namespace的Mapper应跳转到同模块XML');

  await vscode.commands.executeCommand('javaNavigator.jumpToMapper', moduleBXmlPath);
  assertActiveDocument(moduleBMapperPath, '重复namespace的XML应跳转到同模块Mapper');

  await vscode.commands.executeCommand('javaNavigator.jumpToImplementation', {
    uri: vscode.Uri.file(interfacePath).toString(),
    position: { line: 2, column: 17 },
    direction: 'to-impl',
    level: 'type'
  });
  assertActiveDocument(implementationPath, '接口应通过源码索引后备跳转到实现');
  assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 2);

  await vscode.commands.executeCommand('javaNavigator.jumpToImplementation', {
    uri: vscode.Uri.file(interfacePath).toString(),
    position: { line: 3, column: 11 },
    direction: 'to-impl',
    level: 'method',
    methodSignature: { name: 'find', parameterTypes: ['Long'] }
  });
  assertActiveDocument(implementationPath, '接口方法应跳转到对应实现方法');
  assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 4);

  const dirtyXmlEditor = await vscode.window.showTextDocument(xmlDocument);
  const mapperClose = xmlDocument.getText().lastIndexOf('</mapper>');
  assert.ok(mapperClose >= 0, 'E2E XML缺少mapper结束标签');
  const liveSql = '    <select id="findLive" resultType="java.lang.String">select 1</select>\n';
  await dirtyXmlEditor.edit(builder => builder.insert(xmlDocument.positionAt(mapperClose), liveSql));

  const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    xmlDocument.uri
  ) ?? [];
  const liveLine = xmlDocument.positionAt(xmlDocument.getText().indexOf('findLive')).line;
  assert.ok(codeLenses.some(lens =>
    lens.command?.arguments?.[0]?.direction === 'xml-to-java' &&
    lens.command.arguments[0].position.line === liveLine
  ), '未保存SQL应生成统一请求格式的CodeLens');

  await vscode.commands.executeCommand('javaNavigator.jumpToXml', mapperPath, 'findLive');
  assertActiveDocument(xmlPath, 'Mapper方法应使用未保存XML定位SQL');
  assert.ok(vscode.window.activeTextEditor?.document.isDirty, 'E2E应保持XML为未保存状态');
  await vscode.commands.executeCommand('workbench.action.files.revert');

  execFileSync('git', ['checkout', 'index-refresh-feature'], {
    cwd: workspaceRoot,
    stdio: 'pipe'
  });
  await waitForIndexMapping(mapperPath, featureXmlPath);
}

function assertActiveDocument(expectedPath: string, message: string): void {
  const actualPath = vscode.window.activeTextEditor?.document.uri.fsPath;
  assert.ok(actualPath, `${message}: 没有活动编辑器`);
  assert.strictEqual(normalizePath(actualPath), normalizePath(expectedPath), message);
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

async function waitForIndexMapping(javaPath: string, expectedXmlPath: string): Promise<void> {
  const timeoutAt = Date.now() + 10000;
  while (Date.now() < timeoutAt) {
    const mapping = IndexCacheManager.getInstance().getByJavaPath(javaPath);
    if (mapping?.xmlPath && normalizePath(mapping.xmlPath) === normalizePath(expectedXmlPath)) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }

  const actualPath = IndexCacheManager.getInstance().getByJavaPath(javaPath)?.xmlPath;
  assert.fail(`切换Git分支后索引未更新: ${actualPath ?? '无XML映射'}`);
}
