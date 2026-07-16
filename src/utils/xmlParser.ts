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
      const openDocument = vscode.workspace.textDocuments.find(document => document.uri.fsPath === filePath);
      if (openDocument) {
        return this.parseXmlContent(openDocument.getText(), filePath);
      }
      const content = await fs.readFile(filePath, 'utf-8');
      return this.parseXmlContent(content, filePath);
    } catch (error) {
      console.error(`[XmlParser] Failed to parse ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 从文本内容解析Mapper XML（支持未保存内容）
   */
  parseXmlContentFromText(content: string, filePath: string): XmlParseResult | null {
    return this.parseXmlContent(content, filePath);
  }

  /**
   * 解析XML内容
   */
  parseXmlContent(content: string, filePath: string): XmlParseResult | null {
    const namespace = this.findMapperNamespace(content);
    if (!namespace) return null;
    const sqlElements: SqlElement[] = [];

    // 使用容错标签扫描器
    const sqlTypes = new Set(['select', 'insert', 'update', 'delete']);
    let i = 0;

    while (i < content.length) {
      // 跳过注释 <!-- ... -->
      if (content.startsWith('<!--', i)) {
        const endIdx = content.indexOf('-->', i + 4);
        i = endIdx >= 0 ? endIdx + 3 : content.length;
        continue;
      }

      // 跳过CDATA <![CDATA[ ... ]]>
      if (content.startsWith('<![CDATA[', i)) {
        const endIdx = content.indexOf(']]>', i + 9);
        i = endIdx >= 0 ? endIdx + 3 : content.length;
        continue;
      }

      // 查找标签开始
      if (content[i] === '<' && i + 1 < content.length) {
        // 检查是否是SQL标签
        let matchedType: string | null = null;
        for (const type of sqlTypes) {
          if (content.substring(i + 1, i + 1 + type.length).toLowerCase() === type) {
            // 确保标签名后面是空白或>
            const afterTag = content[i + 1 + type.length];
            if (afterTag === undefined || /[\s>/]/.test(afterTag)) {
              matchedType = type;
              break;
            }
          }
        }

        if (matchedType) {
          const startOffset = i;
          const position = this.getLineColumn(content, startOffset);

          // 在标签内查找id属性（从当前<到下一个>）
          const tagEndIdx = this.findTagEndOffset(content, i);
          const searchFrom = tagEndIdx >= 0 ? tagEndIdx + 1 : i + 1;
          const nextSqlStart = this.findNextSqlTagOffset(content, searchFrom, sqlTypes);
          const tagContent = tagEndIdx >= 0
            ? content.substring(i, tagEndIdx + 1)
            : content.substring(i, nextSqlStart >= 0 ? nextSqlStart : content.length);

          const idMatch = tagContent.match(/id\s*=\s*["']([^"']+)["']/);
          if (idMatch) {
            // 查找结束标签。编辑中的未闭合标签只延伸到下一个SQL标签，
            // 避免它的范围吞掉后续已经完整的SQL元素。
            const endTagPattern = `</${matchedType}>`;
            let endOffset = nextSqlStart >= 0 ? nextSqlStart - 1 : content.length;

            const closeIdx = this.findClosingTagOffset(content, searchFrom, matchedType);
            if (tagEndIdx >= 0 && /\/>\s*$/.test(tagContent)) {
              endOffset = tagEndIdx + 1;
            } else if (closeIdx >= 0 && (nextSqlStart < 0 || closeIdx < nextSqlStart)) {
              endOffset = closeIdx + endTagPattern.length;
            }

            sqlElements.push({
              id: idMatch[1],
              type: matchedType as 'select' | 'insert' | 'update' | 'delete',
              line: position.line,
              column: position.column,
              startOffset,
              endOffset,
              position: { line: position.line, column: position.column }
            });
          }

          // 移动到标签结束之后
          if (tagEndIdx >= 0) {
            i = tagEndIdx + 1;
          } else if (nextSqlStart >= 0) {
            i = nextSqlStart;
          } else {
            i++;
          }
          continue;
        }
      }

      i++;
    }

    return {
      namespace,
      filePath,
      sqlElements
    };
  }

  /** 查找第一个有效 mapper 开始标签，忽略注释和CDATA中的伪标签。 */
  private findMapperNamespace(content: string): string | undefined {
    let offset = 0;
    while (offset < content.length) {
      if (content.startsWith('<!--', offset)) {
        const end = content.indexOf('-->', offset + 4);
        offset = end >= 0 ? end + 3 : content.length;
        continue;
      }
      if (content.startsWith('<![CDATA[', offset)) {
        const end = content.indexOf(']]>', offset + 9);
        offset = end >= 0 ? end + 3 : content.length;
        continue;
      }
      if (content[offset] === '<' && content.substring(offset + 1, offset + 7).toLowerCase() === 'mapper') {
        const afterName = content[offset + 7];
        if (afterName === undefined || /[\s>/]/.test(afterName)) {
          const tagEnd = this.findTagEndOffset(content, offset);
          const tagContent = content.substring(offset, tagEnd >= 0 ? tagEnd + 1 : content.length);
          return tagContent.match(/\bnamespace\s*=\s*["']([^"']+)["']/i)?.[1];
        }
      }
      offset++;
    }
    return undefined;
  }

  /** 查找不位于注释或CDATA中的结束标签。 */
  private findClosingTagOffset(content: string, startOffset: number, tagName: string): number {
    const closingTag = `</${tagName}>`;
    let offset = startOffset;
    while (offset < content.length) {
      if (content.startsWith('<!--', offset)) {
        const end = content.indexOf('-->', offset + 4);
        offset = end >= 0 ? end + 3 : content.length;
        continue;
      }
      if (content.startsWith('<![CDATA[', offset)) {
        const end = content.indexOf(']]>', offset + 9);
        offset = end >= 0 ? end + 3 : content.length;
        continue;
      }
      if (content.substring(offset, offset + closingTag.length).toLowerCase() === closingTag) {
        return offset;
      }
      offset++;
    }
    return -1;
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
   * 查找下一个不在注释或CDATA中的SQL开始标签。
   */
  private findNextSqlTagOffset(content: string, startOffset: number, sqlTypes: Set<string>): number {
    let offset = startOffset;

    while (offset < content.length) {
      if (content.startsWith('<!--', offset)) {
        const commentEnd = content.indexOf('-->', offset + 4);
        offset = commentEnd >= 0 ? commentEnd + 3 : content.length;
        continue;
      }

      if (content.startsWith('<![CDATA[', offset)) {
        const cdataEnd = content.indexOf(']]>', offset + 9);
        offset = cdataEnd >= 0 ? cdataEnd + 3 : content.length;
        continue;
      }

      if (content[offset] === '<') {
        for (const type of sqlTypes) {
          const candidate = content.substring(offset + 1, offset + 1 + type.length);
          const afterTag = content[offset + 1 + type.length];
          if (candidate.toLowerCase() === type && (afterTag === undefined || /[\s>/]/.test(afterTag))) {
            return offset;
          }
        }
      }

      offset++;
    }

    return -1;
  }

  /** 查找开始标签的结束符；编辑中的新标签起点会终止当前未闭合标签。 */
  private findTagEndOffset(content: string, startOffset: number): number {
    let quote: string | undefined;
    for (let offset = startOffset + 1; offset < content.length; offset++) {
      const character = content[offset];
      if (quote) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        return offset;
      } else if (character === '<') {
        return -1;
      }
    }
    return -1;
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
   * 从文档位置提取当前SQL ID（基于元素范围）
   */
  extractCurrentSqlId(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const content = document.getText();
    const offset = document.offsetAt(position);

    const result = this.parseXmlContent(content, document.uri.fsPath);
    if (!result) return undefined;

    // 找到包含当前偏移的SQL元素
    for (const el of result.sqlElements) {
      if (offset >= el.startOffset && offset <= el.endOffset) {
        return el.id;
      }
    }

    // 如果基于偏移没找到（可能偏移不准确），回退到行号匹配
    for (const el of result.sqlElements) {
      if (position.line >= el.line && position.line <= el.line + 20) {
        // 粗略匹配：确保行号在范围内
        const endLine = this.getLineColumn(content, el.endOffset).line;
        if (position.line <= endLine) {
          return el.id;
        }
      }
    }

    return undefined;
  }
}
