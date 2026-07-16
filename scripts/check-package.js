const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const vsceEntry = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const output = execFileSync(process.execPath, [vsceEntry, 'ls'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8'
});
const files = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

for (const required of ['package.json', 'out/extension.js', 'out/navigators/javaMethodResolver.js']) {
  assert.ok(files.includes(required), `VSIX 缺少运行时文件: ${required}`);
}

for (const file of files) {
  assert.ok(!file.startsWith('src/'), `VSIX 不应包含源码: ${file}`);
  assert.ok(!file.startsWith('out/test/'), `VSIX 不应包含测试: ${file}`);
  assert.ok(!file.startsWith('test-fixtures/'), `VSIX 不应包含夹具: ${file}`);
  assert.ok(!file.startsWith('scripts/'), `VSIX 不应包含构建脚本: ${file}`);
  assert.ok(!file.endsWith('.map'), `VSIX 不应包含 source map: ${file}`);
}

process.stdout.write(`VSIX 文件清单通过，共 ${files.length} 个文件\n`);
