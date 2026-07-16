import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { MyBatisNavigator } from '../navigators/myBatisNavigator';
import { UnifiedCodeLensProvider } from '../providers/unifiedCodeLensProvider';
import { JavaParser } from '../utils/javaParser';
import { createMapping, resetTestState, TestCase, writeJavaFile } from './testHelpers';
import {
  configurationValues,
  openTextDocuments,
  setFindFilesHandler,
  setWorkspaceFolders,
  StubUri
} from './vscodeStub';

export function createXmlNamespaceIndexTests(): TestCase[] {
  return [
    {
      name: 'IndexCacheManager 发布并增量维护完整XML namespace索引',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        const namespace = 'example.StudentGateway';
        const xmlA = path.resolve('module-a/src/main/resources/mapper/StudentGateway.xml');
        const xmlB = path.resolve('module-b/src/main/resources/mapper/StudentGateway.xml');
        const javaB = path.resolve('module-b/src/main/java/example/StudentGateway.java');
        const renamedNamespace = 'example.ArchivedGateway';

        resetTestState();
        cache.clearAll();
        const generation = cache.beginGeneration();
        assert.strictEqual(cache.publishGeneration(generation, [], [], new Map([
          [namespace, [xmlA, xmlB]]
        ])), true);
        assert.strictEqual(cache.isXmlNamespaceIndexComplete(), true);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(namespace).sort(), [xmlA, xmlB].sort());

        cache.setMapping(createMapping(javaB, xmlB, namespace));
        cache.clearMappingsForXmlPath(xmlB);
        assert.deepStrictEqual(cache.getByXmlPathCandidates(xmlB), []);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(namespace).sort(), [xmlA, xmlB].sort());

        cache.updateXmlNamespace(xmlB, renamedNamespace);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(namespace), [xmlA]);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(renamedNamespace), [xmlB]);
        assert.strictEqual(cache.isXmlNamespaceIndexComplete(), true);

        cache.invalidateForFile(xmlA);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(namespace), []);
        assert.deepStrictEqual(cache.getXmlPathsByNamespace(renamedNamespace), [xmlB]);
        cache.clearAll();
      }
    },
    {
      name: 'MyBatisNavigator 完整XML索引避免重扫并以脏文档覆盖',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-xml-index-'));
        const namespace = 'example.StudentGateway';
        const otherNamespace = 'example.OtherGateway';
        const xmlA = path.join(tempRoot, 'module-a/StudentGateway.xml');
        const xmlB = path.join(tempRoot, 'module-b/StudentGateway.xml');
        const dirtyXml = path.join(tempRoot, 'module-c/StudentGateway.xml');
        const liveXml = path.join(tempRoot, 'module-d/StudentGateway.xml');
        let findFilesCount = 0;

        try {
          resetTestState();
          cache.clearAll();
          writeJavaFile(xmlA, `<mapper namespace="${namespace}" />`);
          writeJavaFile(xmlB, `<mapper namespace="${namespace}" />`);
          writeJavaFile(dirtyXml, `<mapper namespace="${namespace}" />`);
          writeJavaFile(liveXml, `<mapper namespace="${otherNamespace}" />`);
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [], [], new Map([
            [namespace, [xmlA, xmlB, dirtyXml]],
            [otherNamespace, [liveXml]]
          ]));
          setFindFilesHandler(async () => {
            findFilesCount++;
            return [];
          });
          openTextDocuments.push(
            {
              uri: StubUri.file(dirtyXml),
              isDirty: true,
              getText: () => `<mapper namespace="${otherNamespace}" />`
            },
            {
              uri: StubUri.file(liveXml),
              isDirty: true,
              getText: () => `<mapper namespace="${namespace}" />`
            }
          );

          const paths = await MyBatisNavigator.getInstance().findXmlByNamespace(namespace, xmlA);
          assert.deepStrictEqual(paths.sort(), [xmlA, xmlB, liveXml].sort());
          assert.strictEqual(findFilesCount, 0);
          assert.deepStrictEqual(
            cache.getXmlPathsByNamespace(namespace).sort(),
            [xmlA, xmlB, dirtyXml].sort()
          );
        } finally {
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'MyBatisNavigator 容忍旧版 mapperPatterns 配置',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-legacy-pattern-'));
        let scanCount = 0;
        try {
          resetTestState();
          cache.clearAll();
          configurationValues.set('mapperPatterns', [{ javaSuffix: 'Mapper' }]);
          setWorkspaceFolders([{ uri: StubUri.file(tempRoot) }]);
          setFindFilesHandler(() => {
            scanCount++;
            return [];
          });

          assert.deepStrictEqual(
            await MyBatisNavigator.getInstance().findXmlByNamespace('example.LegacyGateway'),
            []
          );
          assert.ok(scanCount > 0);
        } finally {
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedCodeLensProvider 为后创建XML的普通Java类显示真实SQL导航',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-late-xml-'));
        const javaPath = path.join(tempRoot, 'src/main/java/example/StudentGateway.java');
        const xmlPath = path.join(tempRoot, 'src/main/resources/mapper/StudentGateway.xml');
        const javaContent = [
          'package example;',
          'public class StudentGateway {',
          '  public String find() { return "ok"; }',
          '}'
        ].join('\n');
        const xmlContent = [
          '<mapper namespace="example.StudentGateway">',
          '  <select id="find">select 1</select>',
          '</mapper>'
        ].join('\n');

        try {
          resetTestState();
          cache.clearAll();
          configurationValues.set('enableInterfaceNavigation', false);
          writeJavaFile(javaPath, javaContent);
          writeJavaFile(xmlPath, xmlContent);
          const generation = cache.beginGeneration();
          cache.publishGeneration(
            generation,
            [JavaParser.createTypeSnapshot(javaContent, javaPath)],
            [],
            []
          );

          // 模拟文件监听在全量索引完成后接收到XML创建事件。
          cache.updateXmlNamespace(xmlPath, 'example.StudentGateway');
          const lenses = await new UnifiedCodeLensProvider().provideCodeLenses({
            uri: StubUri.file(javaPath),
            isDirty: false,
            getText: () => javaContent
          } as any);

          assert.deepStrictEqual(
            lenses.filter(lens => lens.command?.command === 'javaNavigator.jumpToXml')
              .map(lens => lens.command?.title),
            ['$(file-code) 跳转到XML', '$(database) 跳转到SQL']
          );
        } finally {
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'MyBatisNavigator 在先创建XML后索引Java时保留精确候选',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-xml-before-java-'));
        const javaPath = path.join(tempRoot, 'src/main/java/example/StudentGateway.java');
        const xmlPath = path.join(tempRoot, 'src/main/resources/mapper/StudentGateway.xml');
        const javaContent = 'package example; public class StudentGateway {}';
        const xmlContent = '<mapper namespace="example.StudentGateway" />';

        try {
          resetTestState();
          cache.clearAll();
          writeJavaFile(xmlPath, xmlContent);
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [], [], new Map([
            ['example.StudentGateway', [xmlPath]]
          ]));

          const snapshot = JavaParser.createTypeSnapshot(javaContent, javaPath);
          assert.deepStrictEqual(
            await MyBatisNavigator.getInstance().findXmlByNamespace(snapshot.fqn, javaPath, true),
            [xmlPath]
          );
          cache.updateFile(javaPath, snapshot);
          assert.strictEqual(cache.getTypeByPath(javaPath)?.fqn, snapshot.fqn);
          assert.deepStrictEqual(cache.getXmlPathsByNamespace(snapshot.fqn), [xmlPath]);
        } finally {
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    }
  ];
}
