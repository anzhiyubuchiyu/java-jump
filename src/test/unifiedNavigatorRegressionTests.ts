import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaMethodResolver } from '../navigators/javaMethodResolver';
import { UnifiedNavigator } from '../navigators/unifiedNavigator';
import { JavaParser } from '../utils/javaParser';
import { resetTestState, TestCase, writeJavaFile } from './testHelpers';
import {
  commandHandlers,
  configurationValues,
  getLastOpenedEditor,
  openTextDocuments,
  StubPosition,
  StubRange,
  StubUri
} from './vscodeStub';

export function createUnifiedNavigatorRegressionTests(): TestCase[] {
  return [
    {
      name: 'UnifiedNavigator 保留抽象类中的具体方法实现',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-abstract-method-'));
        const interfacePath = path.join(tempRoot, 'Service.java');
        const basePath = path.join(tempRoot, 'Base.java');
        writeJavaFile(interfacePath, 'package example; public interface Service { void run(); }');
        writeJavaFile(basePath, 'package example; public abstract class Base implements Service { public void run() {} }');
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        try {
          resetTestState();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => true };
          commandHandlers.set('vscode.executeImplementationProvider', () => [{
            targetUri: StubUri.file(basePath),
            targetRange: new StubRange(new StubPosition(0, 0), new StubPosition(0, 90)),
            targetSelectionRange: new StubRange(new StubPosition(0, 82), new StubPosition(0, 85))
          }]);

          assert.strictEqual(await navigator.hasTarget({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 49 },
            direction: 'to-impl',
            level: 'method',
            methodSignature: { name: 'run', parameterTypes: [] }
          }), true);

          const result = await navigator.jump({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 49 },
            direction: 'to-impl',
            level: 'method',
            methodSignature: { name: 'run', parameterTypes: [] }
          });

          assert.strictEqual(result, true);
          assert.strictEqual(getLastOpenedEditor().document.uri.fsPath, path.resolve(basePath));
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          commandHandlers.clear();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedNavigator 批量探测多方法时只执行一次后备扫描',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-probe-'));
        const interfacePath = path.join(tempRoot, 'Service.java');
        const implPath = path.join(tempRoot, 'ServiceImpl.java');
        writeJavaFile(
          interfacePath,
          'package example; public interface Service { void run(); void stop(); }'
        );
        writeJavaFile(
          implPath,
          'package example; public class ServiceImpl implements Service { public void run() {} }'
        );
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        const originalFindImplementations = navigator.interfaceNavigator.findImplementations;
        let scanCount = 0;
        try {
          resetTestState();
          configurationValues.set('cacheEnabled', false);
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => false };
          navigator.interfaceNavigator.findImplementations = async () => {
            scanCount++;
            return [implPath];
          };
          const baseRequest = {
            uri: StubUri.file(interfacePath).toString(),
            direction: 'to-impl' as const
          };
          const result = await navigator.probeImplementationTargets(
            { ...baseRequest, position: { line: 0, column: 34 }, level: 'type' },
            [
              {
                ...baseRequest,
                position: { line: 0, column: 49 },
                level: 'method',
                methodSignature: { name: 'run', parameterTypes: [] }
              },
              {
                ...baseRequest,
                position: { line: 0, column: 61 },
                level: 'method',
                methodSignature: { name: 'stop', parameterTypes: [] }
              }
            ]
          );

          assert.deepStrictEqual(result, { hasTypeTarget: true, methodTargets: [true, false] });
          assert.strictEqual(scanCount, 1);
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          navigator.interfaceNavigator.findImplementations = originalFindImplementations;
          IndexCacheManager.getInstance().clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedNavigator 脏实现移除继承关系后不再作为目标',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-dirty-impl-'));
        const interfacePath = path.join(tempRoot, 'Service.java');
        const implPath = path.join(tempRoot, 'ServiceImpl.java');
        const interfaceContent = 'package example; public interface Service { void run(); }';
        const implContent =
          'package example; public class ServiceImpl implements Service { public void run() {} }';
        writeJavaFile(interfacePath, interfaceContent);
        writeJavaFile(implPath, implContent);
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        const cache = IndexCacheManager.getInstance();
        try {
          resetTestState();
          cache.clearAll();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => false };
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            JavaParser.createTypeSnapshot(interfaceContent, interfacePath),
            JavaParser.createTypeSnapshot(implContent, implPath)
          ]);
          openTextDocuments.push({
            uri: { fsPath: implPath },
            isDirty: true,
            getText: () =>
              'package example; public class ServiceImpl { public void run() {} }'
          });
          const baseRequest = {
            uri: StubUri.file(interfacePath).toString(),
            direction: 'to-impl' as const
          };
          const result = await navigator.probeImplementationTargets(
            { ...baseRequest, position: { line: 0, column: 34 }, level: 'type' },
            [{
              ...baseRequest,
              position: { line: 0, column: 49 },
              level: 'method',
              methodSignature: { name: 'run', parameterTypes: [] }
            }]
          );

          assert.deepStrictEqual(result, { hasTypeTarget: false, methodTargets: [false] });
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedNavigator 重复FQN脏具体类不视为接口实现',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-duplicate-fqn-'));
        const interfacePath = path.join(tempRoot, 'module-a', 'Service.java');
        const duplicatePath = path.join(tempRoot, 'module-b', 'Service.java');
        const interfaceContent = 'package example; public interface Service { void run(); }';
        writeJavaFile(interfacePath, interfaceContent);
        writeJavaFile(
          duplicatePath,
          'package example; public class Service { public void run() {} }'
        );
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        const cache = IndexCacheManager.getInstance();
        try {
          resetTestState();
          cache.clearAll();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => false };
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            JavaParser.createTypeSnapshot(interfaceContent, interfacePath)
          ]);
          openTextDocuments.push({
            uri: { fsPath: duplicatePath },
            isDirty: true,
            getText: () => 'package example; public class Service { public void run() {} }'
          });
          const result = await navigator.probeImplementationTargets({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 34 },
            direction: 'to-impl',
            level: 'type'
          }, []);

          assert.deepStrictEqual(result, { hasTypeTarget: false, methodTargets: [] });
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedNavigator 后备扫描不混淆不同包的同名接口',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-same-name-'));
        const interfacePath = path.join(tempRoot, 'a', 'Service.java');
        const wrongImplPath = path.join(tempRoot, 'b', 'ServiceImpl.java');
        writeJavaFile(interfacePath, 'package a; public interface Service {}');
        writeJavaFile(wrongImplPath, 'package b; public class ServiceImpl implements Service {}');
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        const originalFindImplementations = navigator.interfaceNavigator.findImplementations;
        try {
          resetTestState();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => false };
          navigator.interfaceNavigator.findImplementations = async () => [wrongImplPath];
          const cache = IndexCacheManager.getInstance();
          cache.clearAll();
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            JavaParser.createTypeSnapshot(fs.readFileSync(interfacePath, 'utf8'), interfacePath)
          ]);

          const result = await navigator.jump({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 28 },
            direction: 'to-impl',
            level: 'type'
          });
          assert.strictEqual(result, false);
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          navigator.interfaceNavigator.findImplementations = originalFindImplementations;
          IndexCacheManager.getInstance().clearAll();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedNavigator 跳过抽象方法声明并定位具体后代',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-abstract-declaration-'));
        const interfacePath = path.join(tempRoot, 'Service.java');
        const basePath = path.join(tempRoot, 'Base.java');
        const childPath = path.join(tempRoot, 'Child.java');
        writeJavaFile(interfacePath, 'package example; public interface Service { void run(); }');
        writeJavaFile(basePath, 'package example; public abstract class Base implements Service { public abstract void run(); }');
        writeJavaFile(childPath, 'package example; public class Child extends Base { public void run() {} }');
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        try {
          resetTestState();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => true };
          commandHandlers.set('vscode.executeImplementationProvider', () => [{
            targetUri: StubUri.file(basePath),
            targetRange: new StubRange(new StubPosition(0, 0), new StubPosition(0, 95)),
            targetSelectionRange: new StubRange(new StubPosition(0, 87), new StubPosition(0, 90))
          }]);
          const cache = IndexCacheManager.getInstance();
          cache.clearAll();
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            JavaParser.createTypeSnapshot(fs.readFileSync(basePath, 'utf8'), basePath),
            JavaParser.createTypeSnapshot(fs.readFileSync(childPath, 'utf8'), childPath)
          ]);
          assert.deepStrictEqual(cache.findConcreteDescendants('example.Base').map(item => item.fqn), [
            'example.Child'
          ]);
          assert.strictEqual(JavaMethodResolver.contentHasConcreteSignature(
            fs.readFileSync(childPath, 'utf8'),
            childPath,
            { name: 'run', parameterTypes: [] }
          ), true);

          const request = {
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 49 },
            direction: 'to-impl' as const,
            level: 'method' as const,
            methodSignature: { name: 'run', parameterTypes: [] }
          };
          const semantic = await navigator.findImplementationsSemantic(interfacePath, request);
          assert.strictEqual(semantic[0]?.isAbstract, true);
          assert.strictEqual(JavaMethodResolver.contentHasConcreteSignature(
            fs.readFileSync(basePath, 'utf8'),
            basePath,
            { name: 'run', parameterTypes: [] }
          ), false);
          const found = await navigator.findMethodImplementations(interfacePath, 'run', request);
          assert.deepStrictEqual(found.map((item: { filePath: string }) => item.filePath), [childPath]);

          const result = await navigator.jump(request);

          assert.strictEqual(result, true);
          assert.strictEqual(getLastOpenedEditor().document.uri.fsPath, path.resolve(childPath));

          cache.clearAll();
          configurationValues.set('cacheEnabled', false);
          commandHandlers.set('vscode.executeImplementationProvider', (uri: StubUri) => [{
            targetUri: uri.fsPath === path.resolve(interfacePath) ? StubUri.file(basePath) : StubUri.file(childPath),
            targetRange: new StubRange(new StubPosition(0, 0), new StubPosition(0, 95)),
            targetSelectionRange: new StubRange(new StubPosition(0, 65), new StubPosition(0, 68))
          }]);
          assert.strictEqual(await navigator.jump(request), true);
          assert.strictEqual(getLastOpenedEditor().document.uri.fsPath, path.resolve(childPath));
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          commandHandlers.clear();
          IndexCacheManager.getInstance().clearAll();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: '重复FQN的多模块类型图保留全部实现与接口候选',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-duplicate-type-graph-'));
        const interfaceA = path.join(tempRoot, 'module-a', 'src', 'Api.java');
        const baseA = path.join(tempRoot, 'module-a', 'src', 'Base.java');
        const implementationA = path.join(tempRoot, 'module-a', 'src', 'ApiImpl.java');
        const interfaceB = path.join(tempRoot, 'module-b', 'src', 'Api.java');
        const baseB = path.join(tempRoot, 'module-b', 'src', 'Base.java');
        const implementationB = path.join(tempRoot, 'module-b', 'src', 'ApiImpl.java');
        const interfaceContent = 'package example; public interface Api {}';
        const baseContent = 'package example; public abstract class Base implements Api {}';
        const implementationContent = 'package example; public class ApiImpl extends Base {}';
        const cache = IndexCacheManager.getInstance();
        try {
          resetTestState();
          cache.clearAll();
          [interfaceA, interfaceB].forEach(filePath => writeJavaFile(filePath, interfaceContent));
          [baseA, baseB].forEach(filePath => writeJavaFile(filePath, baseContent));
          [implementationA, implementationB].forEach(filePath => writeJavaFile(filePath, implementationContent));
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [
            JavaParser.createTypeSnapshot(interfaceContent, interfaceA),
            JavaParser.createTypeSnapshot(baseContent, baseA),
            JavaParser.createTypeSnapshot(implementationContent, implementationA),
            JavaParser.createTypeSnapshot(interfaceContent, interfaceB),
            JavaParser.createTypeSnapshot(baseContent, baseB),
            JavaParser.createTypeSnapshot(implementationContent, implementationB)
          ]);

          assert.deepStrictEqual(
            cache.findConcreteImplementations('example.Api').map(item => item.filePath).sort(),
            [implementationA, implementationB].sort()
          );
          assert.deepStrictEqual(
            cache.findConcreteDescendants('example.Base').map(item => item.filePath).sort(),
            [implementationA, implementationB].sort()
          );
          assert.deepStrictEqual(
            cache.getInterfaceFiles('example.Api')?.sort(),
            [interfaceA, interfaceB].sort()
          );

          const navigator = UnifiedNavigator.getInstance() as any;
          const interfaces = await navigator.findInterfacesFromIndex(implementationA);
          assert.deepStrictEqual(
            interfaces.map((item: { filePath: string }) => item.filePath).sort(),
            [interfaceA, interfaceB].sort()
          );
        } finally {
          cache.clearAll();
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    }
  ];
}
