import * as assert from 'assert';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { UnifiedCodeLensProvider } from '../providers/unifiedCodeLensProvider';
import { JavaParser } from '../utils/javaParser';
import { createMapping, resetTestState, TestCase } from './testHelpers';
import { configurationValues, openTextDocuments, StubUri } from './vscodeStub';

export function createCodeLensExistenceTests(): TestCase[] {
  return [
    {
      name: 'UnifiedCodeLensProvider 脏XML失配后不信任旧映射',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        configurationValues.set('enableInterfaceNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/StudentGateway.java');
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        cache.setMapping(createMapping(javaPath, xmlPath, 'example.StudentGateway'));
        openTextDocuments.push({
          uri: { fsPath: xmlPath },
          isDirty: true,
          getText: () => '<mapper namespace="example.OtherGateway" />'
        });
        const document = {
          uri: StubUri.file(javaPath),
          isDirty: false,
          getText: () => 'package example; public interface StudentGateway {}'
        };

        const lenses = await new UnifiedCodeLensProvider().provideCodeLenses(document as any);

        assert.deepStrictEqual(
          lenses.filter(lens => lens.command?.command === 'javaNavigator.jumpToXml'),
          []
        );
        cache.clearAll();
        resetTestState();
      }
    },
    {
      name: 'UnifiedCodeLensProvider 脏XML新增精确匹配后显示CodeLens',
      run: async () => {
        resetTestState();
        configurationValues.set('enableInterfaceNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/StudentGateway.java');
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        openTextDocuments.push({
          uri: { fsPath: xmlPath },
          isDirty: true,
          getText: () => '<mapper namespace="example.StudentGateway" />'
        });
        const document = {
          uri: StubUri.file(javaPath),
          isDirty: false,
          getText: () => 'package example; public interface StudentGateway {}'
        };
        const provider = new UnifiedCodeLensProvider() as any;
        const originalFind = provider.myBatisNavigator.findXmlByNamespace;
        let findCount = 0;
        try {
          provider.myBatisNavigator.findXmlByNamespace = async () => {
            findCount++;
            return [xmlPath];
          };
          const lenses = await provider.provideCodeLenses(document);
          assert.strictEqual(findCount, 1);
          assert.ok(lenses.some((lens: any) =>
            lens.command?.command === 'javaNavigator.jumpToXml'
          ));
        } finally {
          provider.myBatisNavigator.findXmlByNamespace = originalFind;
          resetTestState();
        }
      }
    },
    {
      name: 'UnifiedCodeLensProvider Mapper无精确XML时不显示CodeLens',
      run: async () => {
        resetTestState();
        configurationValues.set('cacheEnabled', false);
        configurationValues.set('enableInterfaceNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/MissingMapper.java');
        const document = {
          uri: StubUri.file(javaPath),
          isDirty: false,
          getText: () => 'package example; @Mapper public interface MissingMapper {}'
        };

        const lenses = await new UnifiedCodeLensProvider().provideCodeLenses(document as any);

        assert.deepStrictEqual(
          lenses.filter(lens => lens.command?.command === 'javaNavigator.jumpToXml'),
          []
        );
        resetTestState();
      }
    },
    {
      name: 'UnifiedCodeLensProvider 无关脏XML不触发工作区扫描',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        configurationValues.set('enableInterfaceNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/StudentGateway.java');
        const javaContent = 'package example; public interface StudentGateway {}';
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [JavaParser.createTypeSnapshot(javaContent, javaPath)], [], []);
        openTextDocuments.push({
          uri: { fsPath: path.resolve('module-a/src/main/resources/unrelated.xml') },
          isDirty: true,
          getText: () => '<mapper namespace="other.UnrelatedMapper" />'
        });
        const provider = new UnifiedCodeLensProvider() as any;
        const originalFind = provider.myBatisNavigator.findXmlByNamespace;
        let findCount = 0;
        try {
          provider.myBatisNavigator.findXmlByNamespace = async () => {
            findCount++;
            return [];
          };
          await provider.provideCodeLenses({
            uri: StubUri.file(javaPath),
            isDirty: false,
            getText: () => javaContent
          });
          assert.strictEqual(findCount, 0);
        } finally {
          provider.myBatisNavigator.findXmlByNamespace = originalFind;
          cache.clearAll();
          resetTestState();
        }
      }
    },
    {
      name: 'UnifiedCodeLensProvider 不为缺失接口显示反向CodeLens',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        configurationValues.set('enableMyBatisNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/MissingServiceImpl.java');
        const javaContent = [
          'package example;',
          'public class MissingServiceImpl implements example.MissingService {',
          '  public void api() {}',
          '}'
        ].join('\n');
        const document = {
          uri: StubUri.file(javaPath),
          isDirty: false,
          getText: () => javaContent
        };
        openTextDocuments.push(document);

        const lenses = await new UnifiedCodeLensProvider().provideCodeLenses(document as any);
        assert.deepStrictEqual(
          lenses.filter(lens =>
            lens.command?.command === 'javaNavigator.jumpToInterfaceFromClass' ||
            lens.command?.command === 'javaNavigator.jumpToInterface'
          ),
          []
        );

        cache.clearAll();
        resetTestState();
      }
    },
    {
      name: 'UnifiedCodeLensProvider 仅为存在且匹配的接口显示反向CodeLens',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        configurationValues.set('enableMyBatisNavigation', false);
        const interfacePath = path.resolve('module-a/src/main/java/Service.java');
        const implementationPath = path.resolve('module-a/src/main/java/ServiceImpl.java');
        const interfaceContent = 'package example; public interface Service { void api(); }';
        const implementationContent = [
          'package example;',
          'public class ServiceImpl implements example.Service {',
          '  public void api() {}',
          '  public void helper() {}',
          '}'
        ].join('\n');
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [
          JavaParser.createTypeSnapshot(interfaceContent, interfacePath),
          JavaParser.createTypeSnapshot(implementationContent, implementationPath)
        ]);
        const document = {
          uri: StubUri.file(implementationPath),
          isDirty: false,
          getText: () => implementationContent
        };
        openTextDocuments.push(
          { uri: StubUri.file(interfacePath), isDirty: false, getText: () => interfaceContent },
          document
        );

        const lenses = await new UnifiedCodeLensProvider().provideCodeLenses(document as any);
        assert.ok(lenses.some(lens =>
          lens.command?.command === 'javaNavigator.jumpToInterfaceFromClass'
        ));
        const methodLenses = lenses.filter(lens =>
          lens.command?.command === 'javaNavigator.jumpToInterface'
        );
        assert.strictEqual(methodLenses.length, 1);
        assert.strictEqual(methodLenses[0].range.start.line, 2);

        cache.clearAll();
        resetTestState();
      }
    }
  ];
}
