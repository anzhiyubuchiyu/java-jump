/**
 * 文件操作工具类
 * 统一处理文件打开、定位等操作
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';

/**
 * 打开文件并定位到指定位置
 */
export async function openFileAtPosition(
  filePath: string,
  position?: { line: number; column: number }
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);

  if (position) {
    const vscodePosition = new vscode.Position(position.line, position.column);
    editor.selection = new vscode.Selection(vscodePosition, vscodePosition);
    editor.revealRange(
      new vscode.Range(vscodePosition, vscodePosition),
      vscode.TextEditorRevealType.InCenter
    );
  }
}

/**
 * 读取文件内容
 */
export async function readFileContent(filePath: string): Promise<string | null> {
  try {
    const openDocument = vscode.workspace.textDocuments
      .find(document => document.uri.fsPath === filePath);
    if (openDocument) return openDocument.getText();
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 获取统一排除模式
 * 从配置读取排除目录，生成VS Code glob排除模式
 * 无静默上限
 */
export function getUnifiedExcludePattern(): string {
  const config = vscode.workspace.getConfiguration('javaNavigator');
  const excludeFolders = config.get<string[]>('excludeFolders', [
    'node_modules', '.git', '.svn', '.hg',
    'target', 'build', 'out', 'dist',
    '.idea', '.vscode', '.settings',
    'bin', 'obj', 'coverage', '.nyc_output',
    '.gradle', 'gradle', '.mvn',
    'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat'
  ]);
  if (excludeFolders.length === 0) return '';
  if (excludeFolders.length === 1) return `**/${excludeFolders[0]}/**`;
  return `{${excludeFolders.map(f => `**/${f}/**`).join(',')}}`;
}

/**
 * 检查是否应该忽略文件
 */
export function shouldIgnoreFile(filePath: string): boolean {
  const config = vscode.workspace.getConfiguration('javaNavigator');
  const excludeFolders = config.get<string[]>('excludeFolders', [
    'node_modules', '.git', '.svn', '.hg',
    'target', 'build', 'out', 'dist',
    '.idea', '.vscode', '.settings',
    'bin', 'obj', 'coverage', '.nyc_output',
    '.gradle', 'gradle', '.mvn',
    'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat'
  ]);

  return excludeFolders.some(folder => {
    const forwardSlash = `/${folder}/`;
    const backSlash = `\\${folder}\\`;
    return filePath.includes(forwardSlash) || filePath.includes(backSlash);
  });
}
