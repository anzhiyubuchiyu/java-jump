import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commandHandlers,
  configurationValues,
  getLastOpenedEditor,
  openTextDocuments,
  registerVscodeStub,
  StubPosition,
  StubRange,
  StubUri
} from './vscodeStub';
import {
  createMapping,
  createTypeSnapshot,
  formatError,
  resetConfigValues,
  resetTestState,
  TestCase,
  writeJavaFile
} from './testHelpers';

registerVscodeStub();

const { JavaParser } = require('../utils/javaParser') as typeof import('../utils/javaParser');
const { XmlParser } = require('../utils/xmlParser') as typeof import('../utils/xmlParser');
const { PathMatcher } = require('../utils/pathMatcher') as typeof import('../utils/pathMatcher');
const { IndexCacheManager } = require('../cache/indexCache') as typeof import('../cache/indexCache');
const { UnifiedNavigator } = require('../navigators/unifiedNavigator') as typeof import('../navigators/unifiedNavigator');
const { createRegressionTests } = require('./regressionTests') as typeof import('./regressionTests');
const { createChangeDetectionTests } = require('./changeDetectionTests') as typeof import('./changeDetectionTests');

async function main(): Promise<void> {
  const tests: TestCase[] = [
    {
      name: '扩展清单仅在右键菜单提供XML双向跳转且不注册快捷键',
      run: () => {
        const manifestPath = path.resolve(__dirname, '../../package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          contributes: {
            keybindings?: unknown;
            menus: { 'editor/context': Array<{ command: string; when: string }> };
          };
        };
        assert.strictEqual(manifest.contributes.keybindings, undefined);
        const contextItems = manifest.contributes.menus['editor/context'];
        assert.deepStrictEqual(
          contextItems.map(item => item.command),
          ['javaNavigator.context.jumpToXml', 'javaNavigator.context.jumpToMapper']
        );
        assert.ok(contextItems.every(item => item.when.includes('config.javaNavigator.enableMyBatisNavigation')));
      }
    },
    {
      name: 'JavaParser.containsMethod 支持带 @Param 注解的方法声明',
      run: () => {
        const javaContent = `
          package com.example.mapper;

          public interface UserMapper {
              User selectByName(@Param("name") String name, @Param("status") Integer status);
          }
        `;

        assert.strictEqual(JavaParser.containsMethod(javaContent, 'selectByName'), true);
      }
    },
    {
      name: 'JavaParser 识别继承通用基类的Mapper接口',
      run: () => {
        const javaContent = `
          package com.example.mapper;

          public interface StudentMapper extends BaseMapper<Student> {
            Student selectById(Long id);
          }
        `;

        assert.strictEqual(JavaParser.isMyBatisMapper(javaContent, 'StudentMapper.java'), true);
      }
    },
    {
      name: 'XmlParser.parseXmlContent 支持多行 SQL 标签',
      run: () => {
        const xmlContent = `
          <mapper namespace="com.example.mapper.UserMapper">
            <select
              id="selectById"
              resultType="com.example.User">
              select * from user
            </select>
            <update
              flushCache="true"
              id="updateUser">
              update user set name = #{name}
            </update>
          </mapper>
        `;

        const xmlResult = XmlParser.getInstance().parseXmlContent(xmlContent, 'UserMapper.xml');
        assert.ok(xmlResult);
        assert.deepStrictEqual(
          xmlResult.sqlElements.map(element => [element.type, element.id]),
          [
            ['select', 'selectById'],
            ['update', 'updateUser']
          ]
        );
      }
    },
    {
      name: 'PathMatcher.calculateSimilarity 优先同模块实现类',
      run: () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-'));
        const servicePath = path.join(tempRoot, 'module-a', 'src', 'main', 'java', 'com', 'example', 'UserService.java');
        const sameModuleImplPath = path.join(tempRoot, 'module-a', 'src', 'main', 'java', 'com', 'example', 'impl', 'UserServiceImpl.java');
        const otherModuleImplPath = path.join(tempRoot, 'module-b', 'src', 'main', 'java', 'com', 'example', 'impl', 'UserServiceImpl.java');

        try {
          writeJavaFile(servicePath, `
            package com.example;

            public interface UserService {}
          `);
          writeJavaFile(sameModuleImplPath, `
            package com.example.impl;

            public class UserServiceImpl implements UserService {}
          `);
          writeJavaFile(otherModuleImplPath, `
            package com.example.impl;

            public class UserServiceImpl implements UserService {}
          `);

          const sameModuleScore = PathMatcher.calculateSimilarity(servicePath, sameModuleImplPath);
          const otherModuleScore = PathMatcher.calculateSimilarity(servicePath, otherModuleImplPath);

          assert.ok(sameModuleScore > otherModuleScore);
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'IndexCacheManager 在 cacheEnabled=false 时不返回缓存数据',
      run: () => {
        const cache = IndexCacheManager.getInstance();

        resetConfigValues();
        cache.clearAll();

        cache.setMapping({
          javaPath: 'UserMapper.java',
          xmlPath: 'UserMapper.xml',
          namespace: 'com.example.UserMapper',
          className: 'UserMapper',
          methods: new Map()
        });
        assert.ok(cache.getByJavaPath('UserMapper.java'));

        configurationValues.set('cacheEnabled', false);

        assert.strictEqual(cache.getByJavaPath('UserMapper.java'), undefined);
        assert.strictEqual(cache.getByXmlPath('UserMapper.xml'), undefined);

        resetConfigValues();
        cache.clearAll();
      }
    },
    {
      name: 'JavaParser 保留数组维度并将可变参数规范化为数组',
      run: () => {
        const scalar = JavaParser.normalizeParameterTypes('String value', [], []);
        const array = JavaParser.normalizeParameterTypes('String[] values', [], []);
        const varargs = JavaParser.normalizeParameterTypes('String... values', [], []);

        assert.deepStrictEqual(scalar, ['String']);
        assert.deepStrictEqual(array, ['String[]']);
        assert.deepStrictEqual(varargs, ['String[]']);
      }
    },
    {
      name: 'JavaParser 解析多行方法签名',
      run: () => {
        const snapshot = JavaParser.createTypeSnapshot(`
          package com.example;

          public interface UserService {
            User find(
              String name,
              Long id
            );
          }
        `, 'UserService.java');

        const method = snapshot.methods.find(item => item.name === 'find');
        assert.ok(method);
        assert.deepStrictEqual(method.parameterTypes, ['String', 'Long']);
      }
    },
    {
      name: 'JavaParser 将接口和父接口解析为FQN',
      run: () => {
        const implementation = JavaParser.createTypeSnapshot(`
          package com.example.impl;
          import com.example.api.UserService;

          public class UserServiceImpl implements UserService {}
        `, 'UserServiceImpl.java');
        const childInterface = JavaParser.createTypeSnapshot(`
          package com.example.api;

          public interface ChildService extends UserService {}
        `, 'ChildService.java');

        assert.deepStrictEqual(implementation.interfaces, ['com.example.api.UserService']);
        assert.deepStrictEqual(childInterface.interfaces, ['com.example.api.UserService']);
      }
    },
    {
      name: 'XmlParser 未闭合标签不会覆盖后续SQL范围',
      run: () => {
        const xmlContent = `
          <mapper namespace="com.example.UserMapper">
            <select id="first">
              select 1
            <select id="second">
              select 2
            </select>
          </mapper>
        `;
        const parser = XmlParser.getInstance();
        const result = parser.parseXmlContent(xmlContent, 'UserMapper.xml');
        assert.ok(result);
        const first = result.sqlElements.find(element => element.id === 'first');
        const second = result.sqlElements.find(element => element.id === 'second');
        assert.ok(first);
        assert.ok(second);
        assert.ok(first.endOffset <= second.startOffset);

        const secondOffset = xmlContent.indexOf('select 2');
        const document = {
          getText: () => xmlContent,
          offsetAt: () => secondOffset,
          uri: { fsPath: 'UserMapper.xml' }
        };
        assert.strictEqual(parser.extractCurrentSqlId(document as any, {} as any), 'second');
      }
    },
    {
      name: 'IndexCacheManager 更新XML路径时保持所有映射一致',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetConfigValues();
        cache.clearAll();
        cache.setMapping({
          javaPath: 'UserMapper.java',
          xmlPath: 'old/UserMapper.xml',
          namespace: 'com.example.UserMapper',
          className: 'UserMapper',
          methods: new Map()
        });

        cache.updateXmlPath('UserMapper.java', 'new/UserMapper.xml');

        assert.strictEqual(cache.getByJavaPath('UserMapper.java')?.xmlPath, 'new/UserMapper.xml');
        assert.strictEqual(cache.getByXmlPath('new/UserMapper.xml')?.xmlPath, 'new/UserMapper.xml');
        assert.strictEqual(cache.getByNamespace('com.example.UserMapper')?.xmlPath, 'new/UserMapper.xml');
        assert.strictEqual(cache.getByClassName('UserMapper')?.xmlPath, 'new/UserMapper.xml');
        assert.strictEqual(cache.getByXmlPath('old/UserMapper.xml'), undefined);
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 删除旧映射不会误删新映射的反向键',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetConfigValues();
        cache.clearAll();
        cache.setMapping({
          javaPath: 'module-a/UserMapper.java',
          xmlPath: 'module-a/UserMapper.xml',
          namespace: 'com.example.UserMapper',
          className: 'UserMapper',
          methods: new Map()
        });
        cache.setMapping({
          javaPath: 'module-b/UserMapper.java',
          xmlPath: 'module-b/UserMapper.xml',
          namespace: 'com.example.UserMapper',
          className: 'UserMapper',
          methods: new Map()
        });

        cache.removeMapping('module-a/UserMapper.java');

        assert.strictEqual(cache.getByNamespace('com.example.UserMapper')?.javaPath, 'module-b/UserMapper.java');
        assert.strictEqual(cache.getByClassName('UserMapper')?.javaPath, 'module-b/UserMapper.java');
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 失效重复FQN旧文件时保留新文件',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetConfigValues();
        cache.clearAll();
        cache.setTypeSnapshot(createTypeSnapshot('module-a/UserService.java'));
        cache.setTypeSnapshot(createTypeSnapshot('module-b/UserService.java'));

        cache.invalidateForFile('module-a/UserService.java');

        assert.strictEqual(cache.getTypeByFqn('com.example.UserService')?.filePath, 'module-b/UserService.java');
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 只允许最新generation发布',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const staleGeneration = cache.beginGeneration();
        const latestGeneration = cache.beginGeneration();

        assert.strictEqual(cache.publishGeneration(
          staleGeneration,
          [createTypeSnapshot('stale/UserService.java', { fqn: 'stale.UserService' })]
        ), false);
        assert.strictEqual(cache.getTypeByFqn('stale.UserService'), undefined);
        assert.strictEqual(cache.publishGeneration(
          latestGeneration,
          [createTypeSnapshot('latest/UserService.java', { fqn: 'latest.UserService' })]
        ), true);
        assert.strictEqual(cache.getCurrentGeneration(), latestGeneration);
        assert.strictEqual(cache.getTypeByFqn('latest.UserService')?.filePath, 'latest/UserService.java');
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager forceRescan 合并为最后一次排队扫描',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

        const first = cache.getOrCreateScanTask(async () => {
          events.push('first:start');
          await firstGate;
          events.push('first:end');
        });
        await Promise.resolve();
        const superseded = cache.getOrCreateScanTask(async () => {
          events.push('superseded');
        }, true);
        const latest = cache.getOrCreateScanTask(async () => {
          events.push('latest');
        }, true);

        assert.strictEqual(superseded, latest);
        assert.strictEqual(cache.isScanInProgress(), true);
        releaseFirst();
        await Promise.all([first, latest, cache.waitForScan()]);

        assert.deepStrictEqual(events, ['first:start', 'first:end', 'latest']);
        assert.strictEqual(cache.isScanInProgress(), false);
      }
    },
    {
      name: 'IndexCacheManager 单文件更新原子替换类型和Mapper四向索引',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const javaPath = 'src/NewMapper.java';
        const mapping = createMapping(javaPath, 'mapper/NewMapper.xml', 'com.example.NewMapper');

        cache.updateFile(javaPath, createTypeSnapshot(javaPath, {
          fqn: 'com.example.NewMapper',
          className: 'NewMapper',
          isMapper: true
        }), mapping);

        assert.strictEqual(cache.getTypeByPath(javaPath)?.fqn, 'com.example.NewMapper');
        assert.strictEqual(cache.getByJavaPath(javaPath)?.xmlPath, 'mapper/NewMapper.xml');
        assert.strictEqual(cache.getByXmlPath('mapper/NewMapper.xml')?.javaPath, javaPath);
        assert.strictEqual(cache.getByNamespace('com.example.NewMapper')?.javaPath, javaPath);
        assert.strictEqual(cache.getByClassName('NewMapper')?.javaPath, javaPath);

        cache.updateFile(javaPath);
        assert.strictEqual(cache.getTypeByPath(javaPath), undefined);
        assert.strictEqual(cache.getByJavaPath(javaPath), undefined);
        assert.strictEqual(cache.getByXmlPath('mapper/NewMapper.xml'), undefined);
        assert.strictEqual(cache.getByNamespace('com.example.NewMapper'), undefined);
        assert.strictEqual(cache.getByClassName('NewMapper'), undefined);
        cache.clearAll();
      }
    },
    {
      name: 'IndexCacheManager 使用FQN隔离同名接口并遍历父接口',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [
          createTypeSnapshot('a/Service.java', { fqn: 'a.Service', packageName: 'a' }),
          createTypeSnapshot('b/Service.java', { fqn: 'b.Service', packageName: 'b' }),
          createTypeSnapshot('a/ChildService.java', {
            fqn: 'a.ChildService', packageName: 'a', className: 'ChildService', interfaces: ['a.Service']
          }),
          createTypeSnapshot('a/ServiceImpl.java', {
            fqn: 'a.ServiceImpl', packageName: 'a', className: 'ServiceImpl', kind: 'class', interfaces: ['a.ChildService']
          }),
          createTypeSnapshot('b/ServiceImpl.java', {
            fqn: 'b.ServiceImpl', packageName: 'b', className: 'ServiceImpl', kind: 'class', interfaces: ['b.Service']
          })
        ]);

        assert.deepStrictEqual(
          cache.findConcreteImplementations('a.Service').map(item => item.fqn),
          ['a.ServiceImpl']
        );
        assert.deepStrictEqual(
          cache.findConcreteImplementations('b.Service').map(item => item.fqn),
          ['b.ServiceImpl']
        );
        cache.clearAll();
      }
    },
    {
      name: 'JavaParser 区分重载并擦除泛型参数',
      run: () => {
        const snapshot = JavaParser.createTypeSnapshot(`
          package com.example;
          import java.util.List;

          public interface SearchService {
            Result find(String key);
            Result find(@Nonnull final List<String> keys, long[] ids);
          }
        `, 'SearchService.java');
        const overloads = snapshot.methods.filter(method => method.name === 'find');

        assert.strictEqual(overloads.length, 2);
        assert.deepStrictEqual(overloads.map(method => method.parameterTypes), [
          ['String'],
          ['java.util.List', 'long[]']
        ]);
        assert.notStrictEqual(overloads[0].line, overloads[1].line);
      }
    },
    {
      name: 'JavaParser 对多个通配符导入不猜测FQN',
      run: () => {
        const snapshot = JavaParser.createTypeSnapshot(`
          package com.example;
          import alpha.api.*;
          import beta.api.*;
          public class ServiceImpl implements Service {}
        `, 'ServiceImpl.java');

        assert.deepStrictEqual(snapshot.interfaces, ['__unresolved__.Service']);
      }
    },
    {
      name: 'JavaParser 覆盖类型识别、声明工具和接口过滤',
      run: async () => {
        assert.deepStrictEqual(JavaParser.extractClassInfo('public interface Api {}'), {
          name: 'Api', isInterface: true, isAbstract: false
        });
        assert.deepStrictEqual(JavaParser.extractClassInfo('public abstract class Base {}'), {
          name: 'Base', isInterface: false, isAbstract: true
        });
        assert.deepStrictEqual(JavaParser.extractClassInfo('protected final class Value {}'), {
          name: 'Value', isInterface: false, isAbstract: false
        });
        assert.deepStrictEqual(JavaParser.extractClassInfo('record Value() {}'), {
          name: 'Value', isInterface: false, isAbstract: false
        });
        assert.deepStrictEqual(JavaParser.extractClassInfo('enum Status { ACTIVE }'), {
          name: 'Status', isInterface: false, isAbstract: false
        });
        assert.strictEqual(JavaParser.isJavaInterface('public interface Api {}'), true);
        assert.strictEqual(JavaParser.isJavaClass('final class Value {}'), true);
        assert.strictEqual(JavaParser.isJavaClass('enum Status { ACTIVE }'), true);
        assert.strictEqual(JavaParser.isAbstractClass('abstract class Base {}'), true);
        assert.strictEqual(JavaParser.isMyBatisMapper('class UserMapper {}'), false);
        assert.strictEqual(JavaParser.isMyBatisMapper('interface UserMapper {}'), true);
        assert.strictEqual(JavaParser.isMyBatisMapper('@Mapper interface UserRepository {}'), true);
        assert.strictEqual(JavaParser.extractClassName('enum Value {}'), 'Value');

        assert.deepStrictEqual(
          JavaParser.extractImplementedInterfaces('class Impl extends Base implements Api<String>, Other {}'),
          ['Api', 'Other', '__extends:Base']
        );
        assert.deepStrictEqual(
          JavaParser.extractImplementedInterfaces('interface Child extends Parent, Other<String> {}'),
          ['Parent', 'Other']
        );
        assert.strictEqual(JavaParser.extractSuperClass('interface Child extends Parent {}'), undefined);
        assert.strictEqual(JavaParser.extractSuperClass('class Child extends Base<String> {}'), 'Base');
        assert.strictEqual(JavaParser.isConstructor('Value', 'class Value {}'), true);
        assert.strictEqual(JavaParser.looksLikeMethodDeclaration('public String find('), true);
        assert.strictEqual(JavaParser.looksLikeMethodDeclaration('value = find('), false);
        assert.strictEqual(JavaParser.extractMethodName('public String find(String id)'), 'find');
        assert.strictEqual(JavaParser.extractMethodName('if (ready)'), null);
        assert.strictEqual(JavaParser.extractMethodParams('find(String id, long version)'), 'String id, long version');
        assert.strictEqual(JavaParser.checkOverrideAnnotation(['@Override', 'public void run() {'], 1), true);
        assert.deepStrictEqual(JavaParser.parseTypeList('Api<Map<A, B>>, Other'), ['Api', 'Other']);

        assert.deepStrictEqual(JavaParser.processBlockComments('before /* hidden */ after', false), {
          text: 'before  after', inBlockComment: false
        });
        assert.deepStrictEqual(JavaParser.processBlockComments('still hidden */ after', true), {
          text: ' after', inBlockComment: false
        });
        assert.deepStrictEqual(JavaParser.countBraces('if ("{") { call(); } // }'), { open: 1, close: 1 });
        assert.strictEqual(JavaParser.escapeRegex('a+b?'), 'a\\+b\\?');
        assert.strictEqual(JavaParser.containsImplementedMethod('public String find() { return ""; }', 'find'), true);

        const filtered = await JavaParser.extractImplementedInterfacesAsync(`
          import java.util.List;
          import com.example.CustomApi;
          class Impl implements List<String>, CustomApi, UnknownApi {}
        `, StubUri.file('Impl.java') as any);
        assert.deepStrictEqual(filtered, ['CustomApi']);
        assert.strictEqual(JavaParser.isSystemInterface('java.util.List'), true);
        assert.strictEqual(JavaParser.isSystemInterface('CustomApi'), false);
      }
    },
    {
      name: 'XmlParser 从未保存文本解析多行、自闭合并忽略注释和CDATA',
      run: () => {
        const content = `
          <!-- <mapper namespace="com.example.StaleMapper"> -->
          <mapper
            namespace="com.example.LiveMapper">
            <!-- <select id="commented">select 0</select> -->
            <![CDATA[ <delete id="cdata">delete</delete> ]]>
            <insert
              id="insertLive"
            />
            <select id="findLive">
              <![CDATA[ literal </select> text ]]>
              select 1
            </select>
          </mapper>
        `;
        const parser = XmlParser.getInstance();
        const result = parser.parseXmlContentFromText(content, 'LiveMapper.xml');
        assert.ok(result);
        assert.strictEqual(result.namespace, 'com.example.LiveMapper');
        assert.deepStrictEqual(result.sqlElements.map(element => element.id), ['insertLive', 'findLive']);
        assert.strictEqual(result.sqlElements[0].endOffset, content.indexOf('/>', content.indexOf('<insert')) + 2);
        assert.ok(result.sqlElements[1].endOffset > content.indexOf('select 1'));

        const offset = content.indexOf('id="insertLive"');
        const document = {
          getText: () => content,
          offsetAt: () => offset,
          uri: { fsPath: 'LiveMapper.xml' }
        };
        assert.strictEqual(parser.extractCurrentSqlId(document as any, new StubPosition(6, 10) as any), 'insertLive');
      }
    },
    {
      name: 'XmlParser 文件解析、查询和容错回退行为',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-xml-'));
        const xmlPath = path.join(tempRoot, 'UserMapper.xml');
        try {
          fs.writeFileSync(xmlPath, `
            <mapper namespace="com.example.UserMapper">
              <select id="find">select 1</select>
              <delete id="remove">delete from users</delete>
            </mapper>
          `, 'utf8');
          const parser = XmlParser.getInstance();
          const result = await parser.parseXmlMapper(xmlPath);
          assert.ok(result);
          assert.strictEqual(parser.findSqlElement(result, 'remove')?.type, 'delete');
          assert.strictEqual(parser.findSqlElement(result, 'missing'), undefined);
          assert.strictEqual(parser.isMyBatisMapperXml(fs.readFileSync(xmlPath, 'utf8')), true);
          assert.strictEqual(parser.isMyBatisMapperXml('<beans />'), false);
          assert.strictEqual(parser.parseXmlContent('<mapper></mapper>', xmlPath), null);
          openTextDocuments.push({
            uri: { fsPath: xmlPath },
            isDirty: true,
            getText: () => '<mapper namespace="com.example.LiveMapper"><select id="live" /></mapper>'
          });
          const liveResult = await parser.parseXmlMapper(xmlPath);
          assert.strictEqual(liveResult?.namespace, 'com.example.LiveMapper');
          assert.strictEqual(liveResult?.sqlElements[0]?.id, 'live');
          openTextDocuments.length = 0;
          const originalConsoleError = console.error;
          console.error = () => undefined;
          try {
            assert.strictEqual(await parser.parseXmlMapper(path.join(tempRoot, 'missing.xml')), null);
          } finally {
            console.error = originalConsoleError;
          }

          const content = fs.readFileSync(xmlPath, 'utf8');
          const document = {
            getText: () => content,
            offsetAt: () => content.length + 10,
            uri: { fsPath: xmlPath }
          };
          assert.strictEqual(parser.extractCurrentSqlId(document as any, new StubPosition(2, 10) as any), 'find');
          assert.strictEqual(parser.extractCurrentSqlId(document as any, new StubPosition(20, 0) as any), undefined);
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'IndexCacheManager 覆盖禁用、校验、继承和不可变快照分支',
      run: () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const parent = createTypeSnapshot('Base.java', {
          fqn: 'com.example.Base', className: 'Base', kind: 'class', isAbstract: true
        });
        const middle = createTypeSnapshot('Middle.java', {
          fqn: 'com.example.Middle', className: 'Middle', kind: 'class', isAbstract: true,
          superClass: 'com.example.Base'
        });
        const concrete = createTypeSnapshot('Concrete.java', {
          fqn: 'com.example.Concrete', className: 'Concrete', kind: 'class',
          superClass: 'com.example.Middle', interfaces: ['com.example.Api']
        });
        const api = createTypeSnapshot('Api.java', {
          fqn: 'com.example.Api', className: 'Api'
        });
        const generation = cache.beginGeneration();
        cache.publishGeneration(generation, [parent, middle, concrete, api]);
        parent.className = 'Mutated';
        concrete.interfaces.push('Mutated');

        assert.strictEqual(cache.getTypeByFqn('com.example.Base')?.className, 'Base');
        assert.deepStrictEqual(cache.findConcreteDescendants('com.example.Base').map(item => item.fqn), [
          'com.example.Concrete'
        ]);
        assert.deepStrictEqual(cache.getInterfaceImplementations('com.example.Api'), ['Concrete.java']);
        assert.deepStrictEqual(cache.getInterfaceFiles('Api'), ['Api.java']);
        assert.strictEqual(cache.getInterfaceFiles('Missing'), undefined);
        cache.setInterfaceImplementations('Api', ['ignored']);
        cache.setInterfaceFiles('Api', ['ignored']);
        assert.ok((cache.getDiagnostics() as { typeSnapshots: number }).typeSnapshots >= 4);

        assert.throws(() => cache.updateFile('Expected.java', createTypeSnapshot('Actual.java')), /路径与更新路径不一致/);
        assert.throws(() => cache.updateFile(
          'Expected.java', undefined, createMapping('Actual.java', 'Actual.xml', 'Actual')
        ), /Mapper路径与更新路径不一致/);

        configurationValues.set('cacheEnabled', false);
        const disabledGeneration = cache.beginGeneration();
        assert.strictEqual(cache.publishGeneration(disabledGeneration, [createTypeSnapshot('Disabled.java')]), false);
        cache.setTypeSnapshot(createTypeSnapshot('Disabled.java'));
        cache.setMapping(createMapping('Disabled.java', 'Disabled.xml', 'Disabled'));
        cache.updateXmlPath('Disabled.java', 'New.xml');
        cache.invalidateForFile('Concrete.java');
        assert.strictEqual(cache.getTypeByPath('Concrete.java'), undefined);

        resetTestState();
        cache.clearAll();
      }
    },
    {
      name: 'UnifiedNavigator 后备索引按重载签名定位实现方法',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-nav-'));
        const interfacePath = path.join(tempRoot, 'SearchService.java');
        const implementationPath = path.join(tempRoot, 'SearchServiceImpl.java');
        try {
          writeJavaFile(interfacePath, `
            package com.example;
            public interface SearchService {
              Result find(String key);
              Result find(Integer id);
            }
          `);
          writeJavaFile(implementationPath, `
            package com.example;
            public class SearchServiceImpl implements SearchService {
              public Result find(String key) { return null; }
              public Result find(Integer id) { return null; }
            }
          `);
          const interfaceSnapshot = JavaParser.createTypeSnapshot(fs.readFileSync(interfacePath, 'utf8'), interfacePath);
          const implementationSnapshot = JavaParser.createTypeSnapshot(fs.readFileSync(implementationPath, 'utf8'), implementationPath);
          const cache = IndexCacheManager.getInstance();
          resetTestState();
          cache.clearAll();
          const generation = cache.beginGeneration();
          cache.publishGeneration(generation, [interfaceSnapshot, implementationSnapshot]);
          const sourceMethod = interfaceSnapshot.methods.find(method =>
            method.name === 'find' && method.parameterTypes[0] === 'Integer'
          );
          const targetMethod = implementationSnapshot.methods.find(method =>
            method.name === 'find' && method.parameterTypes[0] === 'Integer'
          );
          assert.ok(sourceMethod);
          assert.ok(targetMethod);

          const result = await UnifiedNavigator.getInstance().jump({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: sourceMethod.line, column: sourceMethod.column },
            direction: 'to-impl',
            level: 'method',
            methodSignature: { name: 'find', parameterTypes: ['Integer'] }
          });

          assert.strictEqual(result, true);
          assert.strictEqual(getLastOpenedEditor().document.uri.fsPath, path.resolve(implementationPath));
          assert.strictEqual(getLastOpenedEditor().selection.start.line, targetMethod.line);
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          IndexCacheManager.getInstance().clearAll();
        }
      }
    },
    {
      name: 'UnifiedNavigator 保留LocationLink提供的精确位置',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-provider-'));
        const interfacePath = path.join(tempRoot, 'UserService.java');
        const implementationPath = path.join(tempRoot, 'UserServiceImpl.java');
        writeJavaFile(interfacePath, 'package com.example; public interface UserService {}');
        writeJavaFile(implementationPath, 'package com.example; public class UserServiceImpl implements UserService {}');
        const navigator = UnifiedNavigator.getInstance() as any;
        const originalLanguageService = navigator.javaLanguageService;
        try {
          resetTestState();
          navigator.javaLanguageService = { canUseJavaLanguageServer: () => true };
          commandHandlers.set('vscode.executeImplementationProvider', () => [{
            targetUri: StubUri.file(implementationPath),
            targetRange: new StubRange(new StubPosition(0, 0), new StubPosition(0, 10)),
            targetSelectionRange: new StubRange(new StubPosition(0, 42), new StubPosition(0, 57))
          }]);

          const result = await navigator.jump({
            uri: StubUri.file(interfacePath).toString(),
            position: { line: 0, column: 38 },
            direction: 'to-impl',
            level: 'type'
          });

          assert.strictEqual(result, true);
          assert.strictEqual(getLastOpenedEditor().document.uri.fsPath, path.resolve(implementationPath));
          assert.strictEqual(getLastOpenedEditor().selection.start.character, 42);
        } finally {
          navigator.javaLanguageService = originalLanguageService;
          commandHandlers.clear();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    ...createRegressionTests(),
    ...createChangeDetectionTests()
  ];

  let passedCount = 0;

  for (const testCase of tests) {
    try {
      await testCase.run();
      passedCount += 1;
      process.stdout.write(`PASS ${testCase.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${testCase.name}\n`);
      process.stderr.write(`${formatError(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`\n${passedCount}/${tests.length} tests passed\n`);
}

void main();
