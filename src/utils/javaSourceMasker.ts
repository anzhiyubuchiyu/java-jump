/**
 * 用空格掩码 Java 注释和字面量，同时保留原始长度与换行位置。
 * 结构解析器可据此安全扫描大括号和关键字。
 */
export function maskJavaCommentsAndLiterals(content: string): string {
  let result = '';
  let state: 'normal' | 'line-comment' | 'block-comment' | 'string' | 'char' | 'text-block' = 'normal';

  const appendMasked = (value: string): void => {
    result += value.replace(/[^\r\n]/g, ' ');
  };

  for (let index = 0; index < content.length;) {
    const current = content[index];
    const nextTwo = content.slice(index, index + 2);
    const nextThree = content.slice(index, index + 3);

    if (state === 'normal') {
      if (nextTwo === '//') {
        appendMasked(nextTwo);
        index += 2;
        state = 'line-comment';
        continue;
      }
      if (nextTwo === '/*') {
        appendMasked(nextTwo);
        index += 2;
        state = 'block-comment';
        continue;
      }
      if (nextThree === '"""') {
        appendMasked(nextThree);
        index += 3;
        state = 'text-block';
        continue;
      }
      if (current === '"') {
        appendMasked(current);
        index++;
        state = 'string';
        continue;
      }
      if (current === "'") {
        appendMasked(current);
        index++;
        state = 'char';
        continue;
      }
      result += current;
      index++;
      continue;
    }

    if (state === 'line-comment') {
      appendMasked(current);
      index++;
      if (current === '\r' || current === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      if (nextTwo === '*/') {
        appendMasked(nextTwo);
        index += 2;
        state = 'normal';
        continue;
      }
      appendMasked(current);
      index++;
      continue;
    }

    if (state === 'text-block') {
      if (nextThree === '"""') {
        appendMasked(nextThree);
        index += 3;
        state = 'normal';
        continue;
      }
      if (current === '\\' && index + 1 < content.length) {
        appendMasked(content.slice(index, index + 2));
        index += 2;
        continue;
      }
      appendMasked(current);
      index++;
      continue;
    }

    if (current === '\\' && index + 1 < content.length) {
      appendMasked(content.slice(index, index + 2));
      index += 2;
      continue;
    }

    appendMasked(current);
    index++;
    if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
      state = 'normal';
    }
  }

  return result;
}
