import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { MyBatisNavigator } from '../navigators/myBatisNavigator';
import {
  MYBATIS_CONTEXT_COMMANDS,
  MyBatisNavigationController
} from '../navigators/myBatisNavigationController';
import { UnifiedCodeLensProvider } from '../providers/unifiedCodeLensProvider';
import { JavaParser } from '../utils/javaParser';
import { PathMatcher } from '../utils/pathMatcher';
import { readFileContent } from '../utils/fileUtils';
import { buildJavaDiagnosticReport, buildXmlDiagnosticReport } from '../utils/navigationDiagnostics';
import { createCodeLensExistenceTests } from './codeLensExistenceTests';
import { createMyBatisNavigatorModuleTests } from './myBatisNavigatorModuleTests';
import { createNavigationConsistencyTests } from './navigationConsistencyTests';
import { createXmlNamespaceIndexTests } from './xmlNamespaceIndexTests';
import { createMapping, createTypeSnapshot, resetTestState, TestCase, writeJavaFile } from './testHelpers';
import { createUnifiedNavigatorRegressionTests } from './unifiedNavigatorRegressionTests';
import {
  commandHandlers,
  configurationValues,
  openTextDocuments,
  setActiveTextEditor,
  setFindFilesHandler,
  StubPosition,
  StubRange,
  StubUri
} from './vscodeStub';

export function createRegressionTests(): TestCase[] {
  return [
    {
      name: 'MyBatis右键与CodeLens统一为相同导航请求',
      run: async () => {
        resetTestState();
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        const document = {
          uri: StubUri.file(xmlPath),
          languageId: 'xml',
          getText: () => '<mapper namespace="example.StudentGateway" />'
        };
        setActiveTextEditor({
          document,
          selection: { active: new StubPosition(0, 5) }
        });
        const controller = new MyBatisNavigationController() as any;
        const requests: any[] = [];
        controller.executeAndPresent = async (request: any) => {
          requests.push(request);
          return { kind: 'cancelled' };
        };
        const disposables = controller.createCommandDisposables();
        try {
          await commandHandlers.get(MYBATIS_CONTEXT_COMMANDS.xmlToJava)?.({ unexpected: true });
          const codeLensRequest = {
            uri: document.uri.toString(),
            position: { line: 0, column: 5 },
            direction: 'xml-to-java'
          };
          await commandHandlers.get('javaNavigator.jumpToMapper')?.(codeLensRequest);
          await commandHandlers.get('javaNavigator.jumpToMapper')?.();
          await commandHandlers.get('javaNavigator.jumpToMapper')?.(xmlPath);
          await commandHandlers.get('javaNavigator.jumpToMapper')?.(document.uri.toString());
          await commandHandlers.get('javaNavigator.jumpToMapper')?.(StubUri.file(xmlPath));
          const legacyRequest = {
            uri: document.uri.toString(),
            position: { line: 0, column: 0 },
            direction: 'xml-to-java'
          };
          assert.deepStrictEqual(requests, [
            codeLensRequest,
            codeLensRequest,
            codeLensRequest,
            legacyRequest,
            legacyRequest,
            legacyRequest
          ]);
        } finally {
          disposables.forEach((disposable: { dispose(): void }) => disposable.dispose());
          resetTestState();
        }
      }
    },
    {
      name: 'MyBatis统一导航区分无效来源、未找到与读取失败',
      run: async () => {
        resetTestState();
        const controller = new MyBatisNavigationController() as any;
        const navigator = controller.navigator as any;
        const originalFind = navigator.findJavaCandidatesByNamespace;
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        const document = {
          uri: StubUri.file(xmlPath),
          languageId: 'xml',
          isDirty: false,
          getText: () => '<beans />',
          offsetAt: () => 0
        };
        openTextDocuments.push(document);
        const request = {
          uri: document.uri.toString(),
          position: { line: 0, column: 0 },
          direction: 'xml-to-java'
        };
        try {
          assert.strictEqual((await controller.execute(request)).kind, 'invalid-source');
          document.getText = () => '<mapper namespace="example.StudentGateway" />';
          navigator.findJavaCandidatesByNamespace = async () => [];
          assert.strictEqual((await controller.execute(request)).kind, 'not-found');
          navigator.findJavaCandidatesByNamespace = async () => [{
            javaPath: path.resolve('missing/StudentGateway.java'),
            namespace: 'example.StudentGateway',
            className: 'StudentGateway',
            methods: new Map()
          }];
          assert.strictEqual((await controller.execute(request)).kind, 'failed');
        } finally {
          navigator.findJavaCandidatesByNamespace = originalFind;
          resetTestState();
        }
      }
    },
    {
      name: 'JavaParser 将record作为具体类索引并解析其接口',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const api = JavaParser.createTypeSnapshot('package example; public interface Api {}', 'Api.java');
        const impl = JavaParser.createTypeSnapshot(
          'package example; public record ApiRecord<T>(@Deprecated T id) implements Api {}',
          'ApiRecord.java'
        );
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [api, impl]);
        assert.strictEqual(impl.kind, 'class');
        assert.strictEqual(impl.isAbstract, false);
        assert.strictEqual(JavaParser.isJavaClass('package example; public record ApiRecord(String id) {}'), true);
        assert.deepStrictEqual(cache.findConcreteImplementations('example.Api').map(item => item.fqn), [
          'example.ApiRecord'
        ]);
        cache.clearAll();
      }
    },
    {
      name: '导航诊断报告展示候选、并列状态与路径评分',
      run: () => {
        const mappings = [
          createMapping('module-a/src/main/java/UserMapper.java', 'module-a/src/main/resources/mapper/UserMapper.xml', 'example.UserMapper'),
          createMapping('module-b/src/main/java/UserMapper.java', 'module-b/src/main/resources/mapper/UserMapper.xml', 'example.UserMapper')
        ];
        const javaReport = buildJavaDiagnosticReport({
          filePath: mappings[0].javaPath,
          snapshot: JavaParser.createTypeSnapshot('package example; public interface UserMapper {}', mappings[0].javaPath),
          mappings,
          cache: { typeSnapshots: 2 }
        });
        assert.ok(javaReport.some(item => item.label === 'XML候选' && item.detail?.includes('选中')));
        const indexedXmlPath = mappings[0].xmlPath ?? '';
        assert.ok(indexedXmlPath);
        const namespaceOnlyReport = buildJavaDiagnosticReport({
          filePath: mappings[0].javaPath,
          snapshot: JavaParser.createTypeSnapshot(
            'package example; public interface UserMapper {}',
            mappings[0].javaPath
          ),
          mappings: [],
          xmlPaths: [indexedXmlPath],
          cache: { xmlNamespaceIndexComplete: true }
        });
        assert.ok(namespaceOnlyReport.some(item =>
          item.label === 'XML候选' && item.detail?.includes(indexedXmlPath)
        ));
        const xmlReport = buildXmlDiagnosticReport({
          filePath: 'module-a/src/main/resources/mapper/UserMapper.xml',
          namespace: 'example.UserMapper',
          mappings,
          cache: { typeSnapshots: 2 }
        });
        assert.ok(xmlReport.some(item => item.detail?.includes('module-a')));
        const tiedReport = buildJavaDiagnosticReport({
          filePath: 'repo/module/src/main/java/com/Api.java',
          snapshot: JavaParser.createTypeSnapshot('package example; public interface Api {}', 'Api.java'),
          mappings: [
            createMapping('repo/module/src/main/java/com/Api.java', 'repo/module/src/main/resources/left/Api.xml', 'example.Api'),
            createMapping('repo/module/src/main/java/com/Api.java', 'repo/module/src/main/resources/right/Api.xml', 'example.Api')
          ],
          cache: {}
        });
        assert.ok(tiedReport.some(item => item.detail?.includes('并列候选: 2')));
        const unboundReport = buildJavaDiagnosticReport({
          filePath: 'repo/module/src/main/java/com/Api.java',
          snapshot: JavaParser.createTypeSnapshot('package example; public interface Api {}', 'Api.java'),
          mappings: [
            { ...createMapping('repo/module/src/main/java/com/Api.java', 'unused.xml', 'example.Api'), xmlPath: undefined },
            createMapping('repo/module/src/main/java/com/Api.java', 'repo/module/src/main/resources/mapper/Api.xml', 'example.Api')
          ],
          cache: {}
        });
        assert.ok(unboundReport[2].detail?.includes('Api.xml | 选中'));
        assert.ok(unboundReport[3].detail?.includes('未绑定XML | 未绑定'));
      }
    },
    {
      name: 'IndexCacheManager 缓存索引回退结果并在类型变更后失效',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        cache.setInterfaceImplementations('example.Api', ['FallbackImpl.java']);
        cache.setInterfaceFiles('example.Api', ['Api.java']);
        assert.deepStrictEqual(cache.getInterfaceImplementations('example.Api'), ['FallbackImpl.java']);
        assert.deepStrictEqual(cache.getInterfaceFiles('example.Api'), ['Api.java']);
        cache.setTypeSnapshot(createTypeSnapshot('Other.java', { fqn: 'example.Other', className: 'Other' }));
        assert.strictEqual(cache.getInterfaceImplementations('example.Api'), undefined);
        assert.strictEqual(cache.getInterfaceFiles('example.Api'), undefined);
        cache.clearAll();
      }
    },
    {
      name: 'UnifiedCodeLensProvider 为XML Mapper和SQL生成CodeLens',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const xmlPath = path.resolve('module-a/src/main/resources/mapper/UserMapper.xml');
        const javaPath = path.resolve('module-a/src/main/java/UserMapper.java');
        cache.setMapping(createMapping(
          javaPath,
          xmlPath,
          'example.UserMapper'
        ));
        openTextDocuments.push({
          uri: { fsPath: javaPath },
          isDirty: false,
          getText: () => 'package example; public interface UserMapper { void find(); }'
        });
        const document = {
          uri: StubUri.file(xmlPath),
          getText: () => '<mapper namespace="example.UserMapper"><select id="find" /><select id="missing" /></mapper>'
        };
        const provider = new UnifiedCodeLensProvider();
        const lenses = await provider.provideCodeLenses(document as any);
        assert.deepStrictEqual(lenses.map(lens => lens.command?.command), [
          'javaNavigator.jumpToMapper',
          'javaNavigator.jumpToMapper'
        ]);
        assert.deepStrictEqual(lenses.map(lens => lens.command?.arguments?.[0]?.direction), [
          'xml-to-java',
          'xml-to-java'
        ]);
        configurationValues.set('enableCodeLens', false);
        assert.deepStrictEqual(await provider.provideCodeLenses(document as any), []);
        cache.clearAll();
        resetTestState();
      }
    },
    {
      name: 'MyBatisNavigator 按精确namespace接受任意Java类型',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-exact-namespace-'));
        const javaPath = path.join(tempRoot, 'StudentGateway.java');
        try {
          writeJavaFile(javaPath, `
            package example.data;
            public interface StudentGateway extends SharedRepository<Student> {}
          `);
          const navigator = MyBatisNavigator.getInstance() as any;
          const mapping = await navigator.parseAndMapJavaFile(
            javaPath,
            'example.data.StudentGateway',
            false
          );
          assert.ok(mapping);
          assert.strictEqual(mapping.namespace, 'example.data.StudentGateway');
          assert.strictEqual(IndexCacheManager.getInstance().getByJavaPath(javaPath), undefined);
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          IndexCacheManager.getInstance().clearAll();
        }
      }
    },
    {
      name: 'MyBatisNavigator 类名命中后仍补扫任意文件名的精确FQN候选',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-java-scan-'));
        const conventionalPath = path.join(tempRoot, 'module-a', 'StudentGateway.java');
        const arbitraryPath = path.join(tempRoot, 'module-b', 'RepositoryTypes.java');
        try {
          writeJavaFile(conventionalPath, 'package example.data; interface StudentGateway {}');
          writeJavaFile(arbitraryPath, 'package example.data; interface StudentGateway {}');
          resetTestState();
          setFindFilesHandler(async (pattern: string) => {
            if (pattern === '**/StudentGateway.java') return [StubUri.file(conventionalPath)];
            if (pattern === '**/*.java') {
              return [StubUri.file(conventionalPath), StubUri.file(arbitraryPath)];
            }
            return [];
          });
          IndexCacheManager.getInstance().clearAll();

          const candidates = await MyBatisNavigator.getInstance()
            .findJavaCandidatesByNamespace('example.data.StudentGateway');

          assert.deepStrictEqual(
            candidates.map(candidate => candidate.javaPath).sort(),
            [arbitraryPath, conventionalPath].sort()
          );
        } finally {
          IndexCacheManager.getInstance().clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'MyBatisNavigator 缓存关闭时脏Java不遮蔽其他精确FQN候选',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-dirty-scan-'));
        const dirtyPath = path.join(tempRoot, 'module-a', 'StudentGateway.java');
        const otherPath = path.join(tempRoot, 'module-b', 'RepositoryTypes.java');
        const liveContent = 'package example.data; interface StudentGateway { void live(); }';
        try {
          writeJavaFile(dirtyPath, 'package old.data; interface StudentGateway {}');
          writeJavaFile(otherPath, 'package example.data; interface StudentGateway {}');
          resetTestState();
          configurationValues.set('cacheEnabled', false);
          openTextDocuments.push({
            uri: { fsPath: dirtyPath },
            isDirty: true,
            getText: () => liveContent
          });
          setFindFilesHandler(async (pattern: string) =>
            pattern === '**/*.java' ? [StubUri.file(dirtyPath), StubUri.file(otherPath)] : []
          );
          IndexCacheManager.getInstance().clearAll();

          const candidates = await MyBatisNavigator.getInstance()
            .findJavaCandidatesByNamespace('example.data.StudentGateway');

          assert.deepStrictEqual(
            candidates.map(candidate => candidate.javaPath).sort(),
            [dirtyPath, otherPath].sort()
          );
        } finally {
          IndexCacheManager.getInstance().clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'MyBatisNavigator 使用脏Java快照覆盖旧namespace缓存',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const oldPath = path.resolve('module-a/src/main/java/OldGateway.java');
        const newPath = path.resolve('module-a/src/main/java/NewGateway.java');
        const namespace = 'example.StudentGateway';
        cache.setMapping(createMapping(oldPath, path.resolve('queries.xml'), namespace));
        openTextDocuments.push(
          {
            uri: { fsPath: oldPath },
            isDirty: true,
            getText: () => 'package changed; public interface OldGateway {}'
          },
          {
            uri: { fsPath: newPath },
            isDirty: true,
            getText: () => 'package example; public interface StudentGateway {}'
          }
        );
        const candidates = await MyBatisNavigator.getInstance()
          .findJavaCandidatesByNamespace(namespace, path.resolve('queries.xml'), false);
        assert.deepStrictEqual(candidates.map(candidate => candidate.javaPath), [newPath]);
        cache.clearAll();
        resetTestState();
      }
    },
    {
      name: 'MyBatisNavigator 合并重复FQN类型候选且脏Java覆盖旧快照',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-fqn-candidates-'));
        const namespace = 'example.data.SharedRepository';
        const javaA = path.join(tempRoot, 'module-a/src/main/java/SharedRepository.java');
        const javaB = path.join(tempRoot, 'module-b/src/main/java/RepositoryTypes.java');
        const xmlPath = path.join(tempRoot, 'module-b/src/main/resources/mapper/SharedRepository.xml');
        try {
          resetTestState();
          cache.clearAll();
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            createTypeSnapshot(javaA, {
              fqn: namespace,
              packageName: 'example.data',
              className: 'SharedRepository',
              isMapper: true
            }),
            createTypeSnapshot(javaB, {
              fqn: namespace,
              packageName: 'example.data',
              className: 'SharedRepository',
              kind: 'class'
            })
          ], [{ ...createMapping(javaA, xmlPath, namespace), xmlPath: undefined }]);
          fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
          fs.writeFileSync(xmlPath, `<mapper namespace="${namespace}"><select id="find" /></mapper>`, 'utf8');

          const snapshots = cache.getTypeCandidatesByFqn(namespace);
          assert.deepStrictEqual(snapshots.map(snapshot => snapshot.filePath).sort(), [javaA, javaB].sort());
          snapshots[0].className = 'Mutated';
          assert.strictEqual(cache.getTypeCandidatesByFqn(namespace)[0].className, 'SharedRepository');

          assert.deepStrictEqual(
            (await MyBatisNavigator.getInstance().findJavaCandidatesByNamespace(namespace, xmlPath))
              .map(candidate => candidate.javaPath),
            [javaB, javaA]
          );

          openTextDocuments.push({
            uri: { fsPath: javaB },
            isDirty: true,
            getText: () => 'package changed; public class RepositoryTypes {}'
          });
          assert.deepStrictEqual(
            (await MyBatisNavigator.getInstance().findJavaCandidatesByNamespace(namespace, xmlPath))
              .map(candidate => candidate.javaPath),
            [javaA]
          );
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          cache.clearAll();
          resetTestState();
        }
      }
    },
    {
      name: 'MyBatisNavigator 不把脏XML的旧直连路径视为精确候选',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const javaPath = path.resolve('module-a/src/main/java/StudentGateway.java');
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        cache.setMapping(createMapping(javaPath, xmlPath, 'example.StudentGateway'));
        openTextDocuments.push({
          uri: { fsPath: xmlPath },
          isDirty: true,
          getText: () => '<mapper namespace="changed.OtherGateway" />'
        });
        assert.deepStrictEqual(
          await MyBatisNavigator.getInstance().findXmlByNamespace(
            'example.StudentGateway', javaPath, false
          ),
          []
        );
        cache.clearAll();
        resetTestState();
      }
    },
    ...createCodeLensExistenceTests(),
    ...createNavigationConsistencyTests(),
    ...createXmlNamespaceIndexTests(),
    {
      name: 'UnifiedCodeLensProvider 缓存关闭时每个文档只搜索一次XML候选',
      run: async () => {
        resetTestState();
        configurationValues.set('cacheEnabled', false);
        const provider = new UnifiedCodeLensProvider() as any;
        const navigator = provider.myBatisNavigator as any;
        const parser = provider.xmlParser as any;
        const originalFind = navigator.findXmlByNamespace;
        const originalParse = parser.parseXmlMapper;
        let searchCount = 0;
        navigator.findXmlByNamespace = async () => {
          searchCount++;
          return [path.resolve('queries.xml')];
        };
        parser.parseXmlMapper = async () => ({
          namespace: 'example.StudentGateway',
          filePath: path.resolve('queries.xml'),
          sqlElements: [
            { id: 'first', line: 1, column: 1 },
            { id: 'second', line: 2, column: 1 }
          ]
        });
        const document = {
          uri: StubUri.file(path.resolve('StudentGateway.java')),
          isDirty: false,
          getText: () => 'package example; public interface StudentGateway { void first(); void second(); }'
        };
        try {
          const lenses = await provider.provideCodeLenses(document);
          assert.strictEqual(searchCount, 1);
          assert.ok(lenses.some((lens: any) => lens.command?.arguments?.[0]?.direction === 'java-to-xml'));
        } finally {
          navigator.findXmlByNamespace = originalFind;
          parser.parseXmlMapper = originalParse;
          resetTestState();
        }
      }
    },
    {
      name: 'readFileContent 优先返回打开文档的未保存文本',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-dirty-text-'));
        const javaPath = path.join(tempRoot, 'StudentGateway.java');
        try {
          writeJavaFile(javaPath, 'package disk; public interface StudentGateway {}');
          openTextDocuments.push({
            uri: { fsPath: javaPath },
            isDirty: true,
            getText: () => 'package memory; public interface StudentGateway {}'
          });
          assert.strictEqual(
            await readFileContent(javaPath),
            'package memory; public interface StudentGateway {}'
          );
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          openTextDocuments.length = 0;
        }
      }
    },
    {
      name: 'UnifiedCodeLensProvider 仅为有实现的Java接口生成CodeLens',
      run: async () => {
        const interfacePath = path.resolve('module-a/src/main/java/Api.java');
        const document = {
          uri: StubUri.file(interfacePath),
          getText: () => 'package example; public interface Api { void run(); }'
        };
        resetTestState();
        commandHandlers.set('vscode.executeDocumentSymbolProvider', () => [{
          kind: 10,
          range: new StubRange(0, 0, 0, 50),
          selectionRange: new StubRange(0, 33, 0, 36),
          children: [{
            kind: 5,
            name: 'run()',
            range: new StubRange(0, 39, 0, 44),
            selectionRange: new StubRange(0, 39, 0, 42),
            children: []
          }]
        }]);
        const provider = new UnifiedCodeLensProvider() as any;
        let probeCount = 0;
        provider.unifiedNavigator = {
          probeImplementationTargets: async (_typeRequest: any, methodRequests: any[]) => {
            probeCount++;
            return { hasTypeTarget: false, methodTargets: methodRequests.map(() => false) };
          }
        };
        assert.deepStrictEqual(await provider.provideCodeLenses(document as any), []);
        assert.strictEqual(probeCount, 1);

        provider.unifiedNavigator = {
          probeImplementationTargets: async (_typeRequest: any, methodRequests: any[]) => {
            probeCount++;
            return { hasTypeTarget: true, methodTargets: methodRequests.map(() => true) };
          }
        };
        const lenses = await provider.provideCodeLenses(document as any);
        assert.strictEqual(probeCount, 2);
        assert.deepStrictEqual(lenses.map((lens: any) => lens.command?.command), [
          'javaNavigator.jumpToImplementation',
          'javaNavigator.jumpToImplementation'
        ]);
        commandHandlers.clear();
      }
    },
    ...createMyBatisNavigatorModuleTests(),
    {
      name: 'PathMatcher 按字典序优先同模块和标准源目录',
      run: () => {
        const referencePath = 'repo/module-a/src/main/java/com/example/UserMapper.java';
        const sameModulePath = 'repo/module-a/src/main/resources/com/example/mapper/UserMapper.xml';
        const closerForeignPath = 'repo/module-b/src/main/resources/mapper/UserMapper.xml';
        const sameModuleRank = PathMatcher.createMatchRank(referencePath, sameModulePath);
        assert.strictEqual(sameModuleRank.sameModule, true);
        assert.strictEqual(sameModuleRank.commonPathDepth, 2);
        assert.strictEqual(PathMatcher.createMatchRank(referencePath, closerForeignPath).sameModule, false);
        assert.strictEqual(
          PathMatcher.selectBestMatch(referencePath, [closerForeignPath, sameModulePath]),
          sameModulePath
        );
        assert.ok(PathMatcher.compareMatchRanks(
          PathMatcher.createMatchRank(referencePath, closerForeignPath, true),
          PathMatcher.createMatchRank(referencePath, sameModulePath, false)
        ) < 0);
        assert.strictEqual(PathMatcher.selectUniqueBestMatch(referencePath, [
          'repo/module-a/src/main/resources/left/UserMapper.xml',
          'repo/module-a/src/main/resources/right/UserMapper.xml'
        ]), undefined);
      }
    },
    {
      name: 'IndexCacheManager 为同一namespace保留全部Mapper候选',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        cache.setMapping(createMapping(
          'module-a/src/main/java/UserMapper.java',
          'module-a/src/main/resources/mapper/UserMapper.xml',
          'com.example.UserMapper'
        ));
        cache.setMapping(createMapping(
          'module-b/src/main/java/UserMapper.java',
          'module-b/src/main/resources/mapper/UserMapper.xml',
          'com.example.UserMapper'
        ));
        assert.deepStrictEqual(
          cache.getByNamespaceCandidates('com.example.UserMapper').map(mapping => mapping.javaPath).sort(),
          ['module-a/src/main/java/UserMapper.java', 'module-b/src/main/java/UserMapper.java']
        );
        assert.strictEqual(cache.getByNamespace('com.example.UserMapper'), undefined);
        assert.strictEqual(cache.getByClassName('UserMapper'), undefined);
        assert.strictEqual(cache.getByClassNameCandidates('UserMapper').length, 2);
        cache.removeMapping('module-a/src/main/java/UserMapper.java');
        assert.strictEqual(
          cache.getByNamespace('com.example.UserMapper')?.javaPath,
          'module-b/src/main/java/UserMapper.java'
        );
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 为同一XML保留全部Mapper候选',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        cache.setMapping(createMapping('module-a/UserMapper.java', 'shared/UserMapper.xml', 'a.UserMapper'));
        cache.setMapping(createMapping('module-b/UserMapper.java', 'shared/UserMapper.xml', 'b.UserMapper'));
        assert.strictEqual(cache.getByXmlPath('shared/UserMapper.xml'), undefined);
        assert.deepStrictEqual(
          cache.getByXmlPathCandidates('shared/UserMapper.xml').map(mapping => mapping.javaPath).sort(),
          ['module-a/UserMapper.java', 'module-b/UserMapper.java']
        );
        cache.removeMapping('module-b/UserMapper.java');
        assert.strictEqual(cache.getByXmlPath('shared/UserMapper.xml')?.javaPath, 'module-a/UserMapper.java');
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 对Mapper派生更新不重解析类型图',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        cache.setTypeSnapshot(createTypeSnapshot('Api.java', { fqn: 'example.Api', className: 'Api' }));
        cache.setMapping(createMapping('Mapper.java', 'Mapper.xml', 'example.Mapper'));
        const diagnostics = cache.getDiagnostics() as {
          lastPublishKind: string;
          lastResolvedTypeCount: number;
          lastPublishDurationMs: number;
        };
        assert.strictEqual(diagnostics.lastPublishKind, 'mapping');
        assert.strictEqual(diagnostics.lastResolvedTypeCount, 0);
        assert.ok(diagnostics.lastPublishDurationMs >= 0);
        cache.invalidateForFile('Mapper.xml');
        assert.strictEqual(
          (cache.getDiagnostics() as { lastResolvedTypeCount: number }).lastResolvedTypeCount,
          0
        );
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 拒绝过期generation时不污染发布指标',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const generation = cache.beginGeneration();
        function* staleBuild(): IterableIterator<ReturnType<typeof createTypeSnapshot>> {
          yield createTypeSnapshot('Api.java', { fqn: 'example.Api', className: 'Api' });
          cache.beginGeneration();
        }
        assert.strictEqual(cache.publishGeneration(generation, staleBuild()), false);
        const diagnostics = cache.getDiagnostics() as {
          lastPublishKind: string;
          lastResolvedTypeCount: number;
        };
        assert.strictEqual(diagnostics.lastPublishKind, 'full');
        assert.strictEqual(diagnostics.lastResolvedTypeCount, 0);
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 扫描期间派生映射更新不抢占generation',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const generation = cache.beginGeneration();
        cache.setMapping(createMapping('DynamicMapper.java', 'DynamicMapper.xml', 'DynamicMapper'));

        assert.strictEqual(cache.publishGeneration(generation, [createTypeSnapshot('Indexed.java')]), true);
        assert.ok(cache.getTypeByPath('Indexed.java'));
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 使用完整索引解析通配符并优先同包类型',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const localService = JavaParser.createTypeSnapshot(
          'package p; public interface Service {}',
          'p/Service.java'
        );
        const importedService = JavaParser.createTypeSnapshot(
          'package q; public interface Service {}',
          'q/Service.java'
        );
        const implementation = JavaParser.createTypeSnapshot(
          'package p; import q.*; public class Impl implements Service {}',
          'p/Impl.java'
        );
        const explicitImplementation = JavaParser.createTypeSnapshot(
          'package p; import q.*; public class ExplicitImpl implements q.Service {}',
          'p/ExplicitImpl.java'
        );
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [
          localService, importedService, implementation, explicitImplementation
        ]);

        assert.deepStrictEqual(cache.getTypeByPath('p/Impl.java')?.interfaces, ['p.Service']);
        assert.deepStrictEqual(cache.findConcreteImplementations('p.Service').map(item => item.fqn), ['p.Impl']);
        assert.deepStrictEqual(cache.getTypeByPath('p/ExplicitImpl.java')?.interfaces, ['q.Service']);
        assert.deepStrictEqual(cache.findConcreteImplementations('q.Service').map(item => item.fqn), [
          'p.ExplicitImpl'
        ]);

        cache.invalidateForFile('p/Service.java');
        assert.deepStrictEqual(cache.getTypeByPath('p/Impl.java')?.interfaces, ['q.Service']);
        assert.deepStrictEqual(cache.findConcreteImplementations('q.Service').map(item => item.fqn), [
          'p.Impl',
          'p.ExplicitImpl'
        ]);
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 返回接口的全部具体后代',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [
          createTypeSnapshot('I.java', { fqn: 'example.I', className: 'I' }),
          createTypeSnapshot('B.java', {
            fqn: 'example.B', className: 'B', kind: 'class', interfaces: ['example.I']
          }),
          createTypeSnapshot('C.java', {
            fqn: 'example.C', className: 'C', kind: 'class', superClass: 'example.B'
          })
        ]);

        assert.deepStrictEqual(cache.findConcreteImplementations('example.I').map(item => item.fqn), [
          'example.B',
          'example.C'
        ]);
        assert.deepStrictEqual(cache.findConcreteDescendants('example.B').map(item => item.fqn), ['example.C']);
        cache.clearAll();
      }
    },
    ...createUnifiedNavigatorRegressionTests()
  ];
}
