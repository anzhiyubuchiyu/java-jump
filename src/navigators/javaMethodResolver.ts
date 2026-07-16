import { JavaNavigationRequest } from '../types';
import { JavaParser } from '../utils/javaParser';
import { readFileContent } from '../utils/fileUtils';

export type MethodSignature = NonNullable<JavaNavigationRequest['methodSignature']>;

export class JavaMethodResolver {
  static async getSignatureFromFile(
    filePath: string,
    methodName: string,
    sourcePosition?: { line: number; column: number }
  ): Promise<MethodSignature | undefined> {
    const content = await readFileContent(filePath);
    if (!content) return undefined;

    const methods = JavaParser.createTypeSnapshot(content, filePath).methods
      .filter(method => method.name === methodName);
    if (methods.length === 0) return undefined;

    const method = sourcePosition
      ? methods.reduce((closest, current) =>
          Math.abs(current.line - sourcePosition.line) < Math.abs(closest.line - sourcePosition.line)
            ? current
            : closest
        )
      : methods[0];
    return { name: method.name, parameterTypes: method.parameterTypes };
  }

  static contentHasSignature(content: string, filePath: string, signature: MethodSignature): boolean {
    return JavaParser.createTypeSnapshot(content, filePath).methods.some(method =>
      this.signaturesMatch(method, signature)
    );
  }

  static contentHasConcreteSignature(content: string, filePath: string, signature: MethodSignature): boolean {
    const lines = content.split('\n');
    return JavaParser.createTypeSnapshot(content, filePath).methods.some(method => {
      if (!this.signaturesMatch(method, signature)) return false;
      const lineOffset = lines.slice(0, method.line).reduce((sum, line) => sum + line.length + 1, 0);
      const nameOffset = lineOffset + method.column;
      const openParen = content.indexOf('(', nameOffset + method.name.length);
      if (openParen < 0) return false;

      let depth = 0;
      for (let offset = openParen; offset < content.length; offset++) {
        if (content[offset] === '(') depth++;
        if (content[offset] !== ')') continue;
        depth--;
        if (depth !== 0) continue;
        const terminator = content.slice(offset + 1).match(/^\s*(?:throws\s+[\w\s,.<>?]+)?\s*([;{])/);
        return terminator?.[1] === '{';
      }
      return false;
    });
  }

  static signaturesMatch(
    method: { name: string; parameterTypes: string[] },
    signature: MethodSignature
  ): boolean {
    return method.name === signature.name &&
      method.parameterTypes.length === signature.parameterTypes.length &&
      method.parameterTypes.every((type, index) =>
        this.typeNamesMatch(type, signature.parameterTypes[index])
      );
  }

  static selectSignature(
    requested: MethodSignature | undefined,
    parsed: MethodSignature | undefined
  ): MethodSignature | undefined {
    if (!requested) return parsed;
    if (requested.parameterTypes.length === 0 && (parsed?.parameterTypes.length ?? 0) > 0) {
      return parsed;
    }
    if (!parsed || requested.parameterTypes.length !== parsed.parameterTypes.length) return requested;

    return {
      name: requested.name,
      parameterTypes: requested.parameterTypes.map((type, index) => {
        const requestedBase = type.replace(/(?:\[\])+$/, '');
        const parsedType = parsed.parameterTypes[index];
        const parsedBase = parsedType.replace(/(?:\[\])+$/, '');
        return !requestedBase.includes('.') && parsedBase.includes('.') ? parsedType : type;
      })
    };
  }

  static async findPosition(
    filePath: string,
    methodName: string,
    signature?: MethodSignature
  ): Promise<{ line: number; column: number } | undefined> {
    const content = await readFileContent(filePath);
    if (!content) return undefined;

    const method = JavaParser.createTypeSnapshot(content, filePath).methods.find(candidate =>
      signature ? this.signaturesMatch(candidate, signature) : candidate.name === methodName
    );
    return method ? { line: method.line, column: method.column } : undefined;
  }

  private static typeNamesMatch(type1: string, type2: string): boolean {
    const normalize = (type: string) => type.replace(/\.\.\.$/, '[]').replace(/\s+/g, '');
    const normalized1 = normalize(type1);
    const normalized2 = normalize(type2);
    if (normalized1 === normalized2) return true;

    const array1 = normalized1.match(/(?:\[\])+$/)?.[0] ?? '';
    const array2 = normalized2.match(/(?:\[\])+$/)?.[0] ?? '';
    if (array1 !== array2) return false;

    const base1 = normalized1.slice(0, normalized1.length - array1.length);
    const base2 = normalized2.slice(0, normalized2.length - array2.length);
    if (base1.includes('.') && base2.includes('.')) return false;
    return base1.substring(base1.lastIndexOf('.') + 1) === base2.substring(base2.lastIndexOf('.') + 1);
  }
}
