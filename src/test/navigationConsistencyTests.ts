import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { MyBatisNavigationController } from '../navigators/myBatisNavigationController';
import { UnifiedCodeLensProvider } from '../providers/unifiedCodeLensProvider';
import { JavaParser } from '../utils/javaParser';
import { resetTestState, TestCase, writeJavaFile } from './testHelpers';
import { commandHandlers, configurationValues, openTextDocuments, StubUri } from './vscodeStub';

export function createNavigationConsistencyTests(): TestCase[] {
  return [
    {
      name: 'JavaParser 忽略注释中的伪包名、类型和 Mapper 标记',
      run: () => {
        const source = `
          /**
           * package incorrect.example;
           * public interface CommentMapper {}
           * @Mapper
           */
          package example;
          public class BodyGateway {}
        `;

        const snapshot = JavaParser.createTypeSnapshot(source, 'BodyGateway.java');
        assert.strictEqual(snapshot.fqn, 'example.BodyGateway');
        assert.strictEqual(snapshot.kind, 'class');
        assert.strictEqual(snapshot.isMapper, false);
      }
    },
    {
      name: 'JavaParser 不将字符串和文本块中的注释标记当作源码',
      run: () => {
        const source = [
          'package example;',
          'public class LiteralGateway {',
          '  String endpoint = "https://host/path/*not-a-comment*/";',
          '  String json = "{\\"value\\":\\"//\\"}";',
          '  String text = """',
          '    // not a comment',
          '    class FakeType {}',
          '  """;',
          '  public void find() {',
          '    String braces = "}";',
          '  }',
          '}'
        ].join('\n');

        const snapshot = JavaParser.createTypeSnapshot(source, 'LiteralGateway.java');
        assert.strictEqual(snapshot.fqn, 'example.LiteralGateway');
        assert.deepStrictEqual(snapshot.methods.map(method => method.name), ['find']);
        assert.strictEqual(
          JavaParser.findMethodAtPosition(source, { line: 9, column: 12 })?.name,
          'find'
        );
      }
    },
    {
      name: 'MyBatis控制器接受普通Java类中的SQL对应方法',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-class-method-'));
        const javaPath = path.join(tempRoot, 'BodyGateway.java');
        const xmlPath = path.join(tempRoot, 'queries.xml');
        const javaContent = `
          package example;
          public class BodyGateway {
            public String find() { return "ok"; }
          }
        `;
        const xmlContent = '<mapper namespace="example.BodyGateway"><select id="find" /></mapper>';
        const controller = new MyBatisNavigationController() as any;
        const originalFind = controller.navigator.findJavaCandidatesByNamespace;
        try {
          resetTestState();
          writeJavaFile(javaPath, javaContent);
          openTextDocuments.push({
            uri: StubUri.file(xmlPath),
            isDirty: false,
            getText: () => xmlContent,
            offsetAt: () => xmlContent.indexOf('<select')
          });
          controller.navigator.findJavaCandidatesByNamespace = async () => [{
            javaPath,
            namespace: 'example.BodyGateway',
            className: 'BodyGateway',
            methods: new Map()
          }];

          const result = await controller.execute({
            uri: StubUri.file(xmlPath).toString(),
            position: { line: 0, column: 0 },
            direction: 'xml-to-java'
          });

          assert.strictEqual(result.kind, 'success');
        } finally {
          controller.navigator.findJavaCandidatesByNamespace = originalFind;
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'MyBatis右键在无语言服务时从Java方法体跳转到对应SQL',
      run: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-method-body-'));
        const javaPath = path.join(tempRoot, 'BodyGateway.java');
        const xmlPath = path.join(tempRoot, 'queries.xml');
        const javaContent = `
          package example;
          public class BodyGateway {
            public String find() {
              return "ok";
            }
          }
        `.trim();
        const xmlContent = `
          <mapper namespace="example.BodyGateway">
            <select id="find">select 1</select>
          </mapper>
        `.trim();
        const controller = new MyBatisNavigationController() as any;
        const originalFind = controller.navigator.findXmlByNamespace;
        try {
          resetTestState();
          writeJavaFile(javaPath, javaContent);
          openTextDocuments.push(
            {
              uri: StubUri.file(javaPath),
              isDirty: false,
              getText: () => javaContent
            },
            {
              uri: StubUri.file(xmlPath),
              isDirty: false,
              getText: () => xmlContent
            }
          );
          controller.navigator.findXmlByNamespace = async () => [xmlPath];
          commandHandlers.set('vscode.executeDocumentSymbolProvider', () => {
            throw new Error('language server unavailable');
          });

          const result = await controller.execute({
            uri: StubUri.file(javaPath).toString(),
            position: { line: 3, column: 14 },
            direction: 'java-to-xml'
          });

          assert.deepStrictEqual(result, {
            kind: 'success',
            targetPath: xmlPath,
            position: { line: 1, column: 12 }
          });
        } finally {
          controller.navigator.findXmlByNamespace = originalFind;
          resetTestState();
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
    {
      name: 'UnifiedCodeLensProvider 冷缓存普通Java类型仍动态发现精确XML',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        configurationValues.set('enableInterfaceNavigation', false);
        const javaPath = path.resolve('module-a/src/main/java/StudentGateway.java');
        const xmlPath = path.resolve('module-a/src/main/resources/queries.xml');
        openTextDocuments.push({
          uri: { fsPath: xmlPath },
          isDirty: false,
          getText: () => '<mapper namespace="example.StudentGateway" />'
        });
        const provider = new UnifiedCodeLensProvider() as any;
        const originalFind = provider.myBatisNavigator.findXmlByNamespace;
        let findCount = 0;
        try {
          provider.myBatisNavigator.findXmlByNamespace = async () => {
            findCount++;
            return [xmlPath];
          };
          const lenses = await provider.provideCodeLenses({
            uri: StubUri.file(javaPath),
            isDirty: false,
            getText: () => 'package example; public class StudentGateway {}'
          });

          assert.strictEqual(findCount, 1);
          assert.ok(lenses.some((lens: any) => lens.command?.command === 'javaNavigator.jumpToXml'));
        } finally {
          provider.myBatisNavigator.findXmlByNamespace = originalFind;
          cache.clearAll();
          resetTestState();
        }
      }
    }
  ];
}
