const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const workspace = path.resolve(__dirname, '..');
const { name, version } = require(path.join(workspace, 'package.json'));
const artifact = path.join(workspace, `${name}-${version}.vsix`);
assert.ok(fs.existsSync(artifact), `未找到VSIX产物: ${artifact}`);

const archiveFiles = execFileSync('tar', ['-tf', artifact], { cwd: workspace, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
for (const required of ['extension/package.json', 'extension/out/extension.js']) {
  assert.ok(archiveFiles.includes(required), `VSIX缺少运行时文件: ${required}`);
}
for (const file of archiveFiles) {
  assert.ok(!file.startsWith('extension/src/'), `VSIX不应包含源码: ${file}`);
  assert.ok(!file.startsWith('extension/out/test/'), `VSIX不应包含测试: ${file}`);
  assert.ok(!file.startsWith('extension/test-fixtures/'), `VSIX不应包含夹具: ${file}`);
  assert.ok(!file.startsWith('extension/scripts/'), `VSIX不应包含构建脚本: ${file}`);
  assert.ok(!file.endsWith('.map'), `VSIX不应包含source map: ${file}`);
}

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const outRoot = path.join(workspace, 'out');
const runtimeFiles = [];
const collectRuntimeFiles = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test') collectRuntimeFiles(entryPath);
    } else if (entry.name.endsWith('.js')) {
      runtimeFiles.push(entryPath);
    }
  }
};
collectRuntimeFiles(outRoot);
for (const sourceFile of runtimeFiles) {
  const relativePath = path.relative(outRoot, sourceFile).split(path.sep).join('/');
  const archived = execFileSync('tar', ['-xOf', artifact, `extension/out/${relativePath}`], { cwd: workspace });
  assert.strictEqual(hash(fs.readFileSync(sourceFile)), hash(archived), `VSIX运行时文件不一致: ${relativePath}`);
}

process.stdout.write(`VSIX产物校验通过: ${path.basename(artifact)}，${runtimeFiles.length} 个运行时文件一致\n`);
