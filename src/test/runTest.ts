import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const configurationValues = new Map<string, unknown>();

function registerVscodeStub(): void {
  const moduleApi = require('module') as {
    _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleApi._load;

  moduleApi._load = (request: string, parent: NodeModule | undefined, isMain: boolean): unknown => {
    if (request === 'vscode') {
      return createVscodeStub();
    }

    return originalLoad(request, parent, isMain);
  };
}

function createVscodeStub(): any {
  return {
    commands: {
      executeCommand: async () => undefined
    },
    extensions: {
      getExtension: () => undefined,
      all: [],
      onDidChange: () => ({
        dispose: () => undefined
      })
    },
    workspace: {
      getConfiguration: () => ({
        get: <T>(section: string, defaultValue?: T): T | undefined => {
          if (configurationValues.has(section)) {
            return configurationValues.get(section) as T;
          }

          return defaultValue;
        },
        has: () => false,
        inspect: () => undefined,
        update: async (section: string, value: unknown) => {
          configurationValues.set(section, value);
        }
      }),
      onDidChangeConfiguration: () => ({
        dispose: () => undefined
      }),
      getWorkspaceFolder: () => undefined
    },
    window: {
      createOutputChannel: () => ({
        append: () => undefined,
        appendLine: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        hide: () => undefined,
        show: () => undefined,
        dispose: () => undefined,
        name: 'Java Jump Test'
      })
    }
  };
}

registerVscodeStub();

const { JavaParser } = require('../utils/javaParser') as typeof import('../utils/javaParser');
const { XmlParser } = require('../utils/xmlParser') as typeof import('../utils/xmlParser');
const { PathMatcher } = require('../utils/pathMatcher') as typeof import('../utils/pathMatcher');
const { IndexCacheManager } = require('../cache/indexCache') as typeof import('../cache/indexCache');

async function main(): Promise<void> {
  const tests: TestCase[] = [
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
    }
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

function writeJavaFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.trim(), 'utf8');
}

function resetConfigValues(): void {
  configurationValues.clear();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

void main();
