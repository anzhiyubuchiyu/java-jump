import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexCacheManager } from '../cache/indexCache';
import { MyBatisNavigator } from '../navigators/myBatisNavigator';
import { createMapping, resetTestState, TestCase, writeJavaFile } from './testHelpers';
import { openTextDocuments } from './vscodeStub';

export function createMyBatisNavigatorModuleTests(): TestCase[] {
  return [
    {
      name: 'MyBatisNavigator 按XML路径返回同模块Mapper候选',
      run: async () => {
        const cache = IndexCacheManager.getInstance();
        resetTestState();
        cache.clearAll();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-modules-'));
        const javaA = path.join(tempRoot, 'module-a/src/main/java/UserMapper.java');
        const xmlA = path.join(tempRoot, 'module-a/src/main/resources/mapper/UserMapper.xml');
        const javaB = path.join(tempRoot, 'module-b/src/main/java/UserMapper.java');
        const xmlB = path.join(tempRoot, 'module-b/src/main/resources/mapper/UserMapper.xml');
        const xmlContent = '<mapper namespace="example.UserMapper"><select id="find" /></mapper>';
        try {
          writeJavaFile(xmlA, xmlContent);
          writeJavaFile(xmlB, xmlContent);
          cache.setMapping(createMapping(javaA, xmlA, 'example.UserMapper'));
          cache.setMapping(createMapping(javaB, xmlB, 'example.UserMapper'));
          const navigator = MyBatisNavigator.getInstance();
          assert.deepStrictEqual(
            await navigator.findXmlByNamespace('example.UserMapper', javaA),
            [xmlA]
          );
          assert.strictEqual(
            (await navigator.findJavaCandidatesByNamespace('example.UserMapper', xmlB))[0].javaPath,
            javaB
          );
          openTextDocuments.push({
            uri: { fsPath: xmlB },
            isDirty: false,
            getText: () => xmlContent
          });
          assert.deepStrictEqual(
            (await navigator.findJavaForXmlCandidates(xmlB)).map(mapping => mapping.javaPath),
            [javaB, javaA]
          );
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          cache.clearAll();
          openTextDocuments.length = 0;
        }
      }
    }
  ];
}
