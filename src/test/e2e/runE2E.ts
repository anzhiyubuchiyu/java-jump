import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index');
  const fixturePath = path.resolve(extensionDevelopmentPath, 'test-fixtures/e2e-workspace');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'java-jump-e2e-workspace-'));

  try {
    fs.cpSync(fixturePath, workspacePath, { recursive: true });
    initializeGitFixture(workspacePath);
    await runTests({
      version: '1.96.4',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes'
      ]
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

function initializeGitFixture(workspacePath: string): void {
  runGit(workspacePath, ['init']);
  runGit(workspacePath, ['config', 'user.email', 'java-jump-e2e@example.invalid']);
  runGit(workspacePath, ['config', 'user.name', 'Java Jump E2E']);
  runGit(workspacePath, ['add', '.']);
  runGit(workspacePath, ['commit', '-m', 'main fixture']);
  runGit(workspacePath, ['branch', '-M', 'main']);
  runGit(workspacePath, ['checkout', '-b', 'index-refresh-feature']);

  const mapperDirectory = path.join(workspacePath, 'src/main/resources/mapper');
  fs.renameSync(
    path.join(mapperDirectory, 'UserMapper.xml'),
    path.join(mapperDirectory, 'UserMapperFeature.xml')
  );
  runGit(workspacePath, ['add', '-A']);
  runGit(workspacePath, ['commit', '-m', 'move mapper xml']);
  runGit(workspacePath, ['checkout', 'main']);
}

function runGit(workspacePath: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: workspacePath,
    stdio: 'pipe'
  });
}

void main().catch(error => {
  console.error('Extension Host E2E failed:', error);
  process.exitCode = 1;
});
