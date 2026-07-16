/**
 * 接口实现导航器
 * 处理Java接口与实现类之间的跳转 - 精简版
 * 核心逻辑已迁移至 UnifiedNavigator，此类仅保留缓存相关的辅助方法
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { IndexCacheManager } from '../cache/indexCache';
import { JavaParser } from '../utils/javaParser';
import { Logger } from '../utils/logger';
import { getUnifiedExcludePattern } from '../utils/fileUtils';

export class InterfaceNavigator {
  private static instance: InterfaceNavigator;
  private cache: IndexCacheManager;
  private logger: Logger;

  private constructor() {
    this.cache = IndexCacheManager.getInstance();
    this.logger = Logger.getInstance();
  }

  static getInstance(): InterfaceNavigator {
    if (!InterfaceNavigator.instance) {
      InterfaceNavigator.instance = new InterfaceNavigator();
    }
    return InterfaceNavigator.instance;
  }

  /**
   * 查找接口的实现类
   * 供 UnifiedNavigator 使用
   */
  async findImplementations(interfaceName: string): Promise<string[]> {
    const cached = this.cache.getInterfaceImplementations(interfaceName);
    if (cached) return cached;

    const simpleInterfaceName = interfaceName.substring(interfaceName.lastIndexOf('.') + 1);

    const files = await vscode.workspace.findFiles('**/*.java', getUnifiedExcludePattern());
    const implementations: string[] = [];
    const implSet = new Set<string>();
    const abstractParents = new Set<string>();

    // 第一遍：找直接实现
    const BATCH = 30;

    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
        try {
          const content = await fs.readFile(file.fsPath, 'utf-8');

          if (!JavaParser.isJavaClass(content)) return;
          if (!content.includes(interfaceName) && !content.includes(simpleInterfaceName)) return;

          const impls = JavaParser.extractImplementedInterfaces(content);
          const implementsInterface = impls.some(iface =>
            iface === interfaceName ||
            iface === simpleInterfaceName ||
            iface.endsWith('.' + interfaceName) ||
            iface.endsWith('.' + simpleInterfaceName)
          );

          if (implementsInterface) {
            if (!implSet.has(file.fsPath)) {
              implSet.add(file.fsPath);
              implementations.push(file.fsPath);
            }
            if (JavaParser.isAbstractClass(content)) {
              const name = JavaParser.extractClassName(content);
              if (name) abstractParents.add(name);
            }
          }
        } catch (error) {
          this.logger.debug(`读取文件失败: ${file.fsPath}`, error);
        }
      }));
    }

    // 第二遍：找继承抽象实现类的类
    if (abstractParents.size > 0) {
      for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
          if (implSet.has(file.fsPath)) return;
          try {
            const content = await fs.readFile(file.fsPath, 'utf-8');
            for (const parent of abstractParents) {
              if (content.includes(parent) &&
                new RegExp(`\\bextends\\s+${JavaParser.escapeRegex(parent)}\\b`).test(content)) {
                implSet.add(file.fsPath);
                implementations.push(file.fsPath);
                break;
              }
            }
          } catch (error) {
            this.logger.debug(`读取文件失败: ${file.fsPath}`, error);
          }
        }));
      }
    }

    this.cache.setInterfaceImplementations(interfaceName, implementations);
    this.logger.info(`[InterfaceNavigator] 共找到 ${implementations.length} 个实现类`);
    return implementations;
  }

  /**
   * 查找接口文件
   */
  async findInterfaceFiles(interfaceName: string): Promise<string[]> {
    const cached = this.cache.getInterfaceFiles(interfaceName);
    if (cached) return cached;

    const results: string[] = [];
    const files = await vscode.workspace.findFiles(`**/${interfaceName}.java`, getUnifiedExcludePattern());

    for (const file of files) {
      try {
        const content = await fs.readFile(file.fsPath, 'utf-8');
        if (JavaParser.isJavaInterface(content) &&
          new RegExp(`\\binterface\\s+${JavaParser.escapeRegex(interfaceName)}\\b`).test(content)) {
          results.push(file.fsPath);
        }
      } catch { }
    }

    this.cache.setInterfaceFiles(interfaceName, results);
    return results;
  }
}
