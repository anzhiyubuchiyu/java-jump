/**
 * XML解析器
 * 解析MyBatis Mapper XML文件
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { XmlParseResult, SqlElement } from '../types';

export class XmlParser {
  private static instance: XmlParser;

  private constructor() {}

  static getInstance(): XmlParser {
    if (!XmlParser.instance) {
      XmlParser.instance = new XmlParser();
    }
    return XmlParser.instance;
  }

  /**
   * 解析Mapper XML文件
   */
  async parseXmlMapper(filePath: string): Promise<XmlParseResult | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return this.parseXmlContent(content, filePath);
    } catch (error) {
      console.error(`[XmlParser] Failed to parse ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 解析XML内容
   */
  parseXmlContent(content: string, filePath: string): XmlParseResult | null {
    // 提取namespace
    const namespaceMatch = content.match(/<mapper[^>]*namespace\s*=\s*["']([^"']+)["']/);
    if (!namespaceMatch) {
      return null;
    }

    const namespace = namespaceMatch[1];
    const sqlElements: SqlElement[] = [];

    // 提取SQL元素 - 支持多行标签
    const sqlTypes: Array<'select' | 'insert' | 'update' | 'delete'> = ['select', 'insert', 'update', 'delete'];

    for (const type of sqlTypes) {
      // 使用更灵活的正则，支持多行标签
      // 匹配 <select 开头，然后是任意字符（包括换行），直到找到 id="xxx" 或 id='xxx'
      const regex = new RegExp(`<${type}\\b([^>]|[>](?![\\s\\S]*?id\\s*=))*?(id\\s*=\\s*["']([^"']+)["'])`, 'gi');
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const id = match[3]; // 第3个捕获组是id值
        const position = this.getLineColumn(content, match.index);

        sqlElements.push({
          id,
          type,
          line: position.line,
          column: position.column
        });
      }
    }

    // 如果上面的正则没有匹配到，尝试另一种方式：逐行查找
    if (sqlElements.length === 0) {
      this.parseSqlElementsLineByLine(content, sqlTypes, sqlElements);
    }

    return {
      namespace,
      filePath,
      sqlElements
    };
  }

  /**
   * 逐行解析SQL元素（处理多行标签的情况）
   */
  private parseSqlElementsLineByLine(
    content: string,
    sqlTypes: string[],
    sqlElements: SqlElement[]
  ): void {
    const lines = content.split('\n');
    let currentTag: { type: string; startLine: number; startCol: number } | null = null;
    let inTag = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检查是否是SQL标签开始
      if (!inTag) {
        const tagMatch = line.match(/<(select|insert|update|delete)\b/i);
        if (tagMatch) {
          const tagType = tagMatch[1].toLowerCase();
          if (sqlTypes.includes(tagType)) {
            currentTag = {
              type: tagType,
              startLine: i,
              startCol: line.indexOf('<')
            };
            inTag = true;
          }
        }
      }

      // 如果在标签内，查找id属性
      if (inTag && currentTag) {
        const idMatch = line.match(/id\s*=\s*["']([^"']+)["']/);
        if (idMatch) {
          sqlElements.push({
            id: idMatch[1],
            type: currentTag.type as 'select' | 'insert' | 'update' | 'delete',
            line: currentTag.startLine,
            column: currentTag.startCol
          });
          inTag = false;
          currentTag = null;
        }

        // 检查标签是否结束（遇到 > 且不在属性值中）
        const tagEndMatch = line.match(/>/);
        if (tagEndMatch && !line.includes('=')) {
          inTag = false;
          currentTag = null;
        }
      }
    }
  }

  /**
   * 从位置获取行列号
   */
  private getLineColumn(content: string, index: number): { line: number; column: number } {
    const lines = content.substring(0, index).split('\n');
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1].length
    };
  }

  /**
   * 查找SQL元素位置
   */
  findSqlElement(xmlResult: XmlParseResult, sqlId: string): SqlElement | undefined {
    return xmlResult.sqlElements.find(el => el.id === sqlId);
  }

  /**
   * 检查是否是MyBatis Mapper XML
   */
  isMyBatisMapperXml(content: string): boolean {
    return /<mapper[^>]*namespace\s*=\s*["']/.test(content);
  }

  /**
   * 从文档位置提取当前SQL ID
   */
  extractCurrentSqlId(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const sqlIdRegex = /<(select|insert|update|delete)\s+[^>]*id\s*=\s*["']([^"']+)["']/;
    
    // 向上查找最多10行
    for (let i = position.line; i >= Math.max(0, position.line - 10); i--) {
      const line = document.lineAt(i).text;
      const match = sqlIdRegex.exec(line);
      if (match) {
        return match[2];
      }
    }

    return undefined;
  }
}
