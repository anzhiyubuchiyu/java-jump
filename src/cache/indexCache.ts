/**
 * 索引缓存管理器
 * 管理Java文件和XML文件的映射关系索引
 */

import * as vscode from 'vscode';
import { LRUCache } from './lruCache';
import { MapperMapping, MethodMapping } from '../types';

export class IndexCacheManager {
  private static instance: IndexCacheManager;
  
  // 各种索引缓存
  private javaToMapping = new LRUCache<string, MapperMapping>(500);
  private xmlToMapping = new LRUCache<string, MapperMapping>(500);
  private namespaceToMapping = new LRUCache<string, MapperMapping>(500);
  private classNameToMapping = new LRUCache<string, MapperMapping>(500);
  
  // 接口实现关系缓存
  private interfaceImplCache = new LRUCache<string, string[]>(500);
  private interfaceFilesCache = new LRUCache<string, string[]>(500);

  private constructor() {}

  static getInstance(): IndexCacheManager {
    if (!IndexCacheManager.instance) {
      IndexCacheManager.instance = new IndexCacheManager();
    }
    return IndexCacheManager.instance;
  }

  private isCacheEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('javaNavigator');
    return config.get<boolean>('cacheEnabled', true);
  }

  // ========== Mapper映射缓存 ==========

  setMapping(mapping: MapperMapping): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    this.javaToMapping.set(mapping.javaPath, mapping);
    if (mapping.xmlPath) {
      this.xmlToMapping.set(mapping.xmlPath, mapping);
    }
    this.namespaceToMapping.set(mapping.namespace, mapping);
    this.classNameToMapping.set(mapping.className, mapping);
  }

  getByJavaPath(javaPath: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.javaToMapping.get(javaPath);
  }

  getByXmlPath(xmlPath: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.xmlToMapping.get(xmlPath);
  }

  getByNamespace(namespace: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.namespaceToMapping.get(namespace);
  }

  getByClassName(className: string): MapperMapping | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.classNameToMapping.get(className);
  }

  removeMapping(javaPath: string): void {
    const mapping = this.javaToMapping.get(javaPath);
    if (mapping) {
      this.javaToMapping.delete(javaPath);
      if (mapping.xmlPath) {
        this.xmlToMapping.delete(mapping.xmlPath);
      }
      this.namespaceToMapping.delete(mapping.namespace);
      this.classNameToMapping.delete(mapping.className);
    }
  }

  updateXmlPath(javaPath: string, xmlPath: string): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    const mapping = this.javaToMapping.get(javaPath);
    if (mapping) {
      mapping.xmlPath = xmlPath;
      this.xmlToMapping.set(xmlPath, mapping);
    }
  }

  // ========== 接口实现缓存 ==========

  setInterfaceImplementations(interfaceName: string, implementations: string[]): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    this.interfaceImplCache.set(interfaceName, implementations);
  }

  getInterfaceImplementations(interfaceName: string): string[] | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.interfaceImplCache.get(interfaceName);
  }

  // ========== 接口文件缓存 ==========

  setInterfaceFiles(interfaceName: string, files: string[]): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    this.interfaceFilesCache.set(interfaceName, files);
  }

  getInterfaceFiles(interfaceName: string): string[] | undefined {
    if (!this.isCacheEnabled()) {
      return undefined;
    }

    return this.interfaceFilesCache.get(interfaceName);
  }

  // ========== 缓存失效 ==========

  invalidateForFile(filePath: string): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    const baseName = filePath.split(/[\\/]/).pop()?.replace('.java', '');
    if (baseName) {
      this.interfaceImplCache.deleteWhere(k => k === baseName || k.startsWith('abstractImpl:'));
      this.interfaceFilesCache.deleteWhere(() => true);
    }

    // 移除Mapper映射
    if (filePath.endsWith('.java')) {
      this.removeMapping(filePath);
    } else if (filePath.endsWith('.xml')) {
      const mapping = this.xmlToMapping.get(filePath);
      if (mapping) {
        this.removeMapping(mapping.javaPath);
      }
    }
  }

  clearAll(): void {
    this.javaToMapping.clear();
    this.xmlToMapping.clear();
    this.namespaceToMapping.clear();
    this.classNameToMapping.clear();
    this.interfaceImplCache.clear();
    this.interfaceFilesCache.clear();
  }

  getDiagnostics(): object {
    return {
      cacheEnabled: this.isCacheEnabled(),
      javaToMapping: this.javaToMapping.size,
      xmlToMapping: this.xmlToMapping.size,
      namespaceToMapping: this.namespaceToMapping.size,
      classNameToMapping: this.classNameToMapping.size,
      interfaceImplCache: this.interfaceImplCache.size,
      interfaceFilesCache: this.interfaceFilesCache.size
    };
  }
}
