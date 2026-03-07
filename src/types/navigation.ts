/**
 * 统一导航类型定义
 *
 * 定义 Java Navigator Plus 插件中所有导航相关的类型
 *
 * 跳转场景分类：
 * - A 模块：接口与实现类导航 (Interface ↔ Implementation)
 *   - a1: 接口类 → 实现类
 *   - a2: 实现类 → 接口
 *   - a3: 接口方法 → 实现方法
 *   - a4: 实现方法 → 接口定义
 *
 * - B 模块：Mapper 与 XML 导航 (Mapper ↔ XML)
 *   - b1: Mapper 接口 → XML 文件
 *   - b2: XML 文件 → Mapper 接口
 *   - b3: Mapper 方法 → SQL 标签
 *   - b4: SQL 标签 → Mapper 方法
 *
 * 使用说明：
 * - NavigationType: 用于标识跳转场景类型（a1-a4, b1-b4）
 * - NavigationDirection: 用于标识具体的跳转方向
 * - NavigationCandidate: 候选目标文件信息，包含匹配分数
 * - NavigationResult: 导航操作结果
 * - NavigationContext: 导航上下文，包含源位置、目标类型等信息
 */

import * as vscode from 'vscode';

/** 跳转类型 */
export type NavigationType = 'a1' | 'a2' | 'b1' | 'b2';

/** 导航方向 */
export type NavigationDirection = 
  | 'interface-to-impl'      // a: 接口→实现
  | 'impl-to-interface'      // a: 实现→接口
  | 'mapper-to-xml'          // b: Mapper→XML
  | 'xml-to-mapper';         // b: Mapper→XML

/** 候选文件信息 */
export interface NavigationCandidate {
  filePath: string;
  name: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** 导航结果 */
export interface NavigationResult {
  success: boolean;
  targetPath?: string;
  targetPosition?: vscode.Position;
  error?: string;
}

/** 跳转上下文 */
export interface NavigationContext {
  sourcePath: string;
  sourcePosition?: vscode.Position;
  type: NavigationType;
  direction: NavigationDirection;
  targetName?: string;  // 方法名或SQL ID
}


