/**
 * 类型定义文件
 */

/** Mapper映射 */
export interface MapperMapping {
  javaPath: string;
  xmlPath?: string;
  namespace: string;
  className: string;
  methods: Map<string, MethodMapping>;
}

/** 方法映射 */
export interface MethodMapping {
  name: string;
  javaPosition: { line: number; column: number };
  xmlPosition?: { line: number; column: number };
  sqlType?: 'select' | 'insert' | 'update' | 'delete';
}

/** XML解析结果 */
export interface XmlParseResult {
  namespace: string;
  filePath: string;
  sqlElements: SqlElement[];
}

/** SQL元素 */
export interface SqlElement {
  id: string;
  type: 'select' | 'insert' | 'update' | 'delete';
  line: number;
  column: number;
  /** SQL标签起始字符偏移 (如 `<select`) */
  startOffset: number;
  /** 闭合标签结束字符偏移 (如 `</select>`) */
  endOffset: number;
  /** 位置信息 (与line/column相同，保留两者以向后兼容) */
  position: { line: number; column: number };
}

/** Java解析结果 */
export interface JavaParseResult {
  packageName: string;
  className: string;
  isInterface: boolean;
  isAbstract: boolean;
  isMapper: boolean;
  methods: JavaMethod[];
  interfaces: string[];
  superClass?: string;
}

/** Java方法 */
export interface JavaMethod {
  name: string;
  line: number;
  column: number;
  hasOverride: boolean;
  parameters: string;
  /** 擦除泛型后的参数FQN类型列表，与方法名共同构成签名键 */
  parameterTypes: string[];
  /** 索引消歧前的参数类型，保留按需导入来源。 */
  rawParameterTypes?: string[];
}

/** Java导航请求 - CodeLens传递给导航命令的参数 */
export interface JavaNavigationRequest {
  /** 源文件URI字符串 */
  uri: string;
  /** 精确的起始行列 */
  position: { line: number; column: number };
  /** 导航方向: 'to-impl' | 'to-interface' */
  direction: 'to-impl' | 'to-interface';
  /** 导航级别: 'type' | 'method' */
  level: 'type' | 'method';
  /** 方法签名 (method level时): 方法名 + 擦除泛型后的参数FQN列表 */
  methodSignature?: {
    name: string;
    parameterTypes: string[];
  };
}

/** Mapper XML 导航方向。 */
export type MyBatisNavigationDirection = 'java-to-xml' | 'xml-to-java';

/** 右键、CodeLens 与命令面板共用的 Mapper XML 导航请求。 */
export interface MyBatisNavigationRequest {
  uri: string;
  position: { line: number; column: number };
  direction: MyBatisNavigationDirection;
}

export type MyBatisNavigationResult =
  | { kind: 'success'; targetPath: string; position?: { line: number; column: number } }
  | { kind: 'cancelled' }
  | { kind: 'invalid-source'; message: string }
  | { kind: 'not-found'; message: string; identifier: string; searchScope: string[] }
  | { kind: 'failed'; message: string };

/** Java类型不可变快照 - 索引中使用 */
export interface JavaTypeSnapshot {
  /** 全限定名 */
  fqn: string;
  /** 包名 */
  packageName: string;
  /** 简单类名 */
  className: string;
  /** 类型种类 */
  kind: 'class' | 'interface' | 'enum' | 'annotation';
  /** 是否抽象 */
  isAbstract: boolean;
  /** 是否Mapper */
  isMapper: boolean;
  /** 显式导入列表 */
  explicitImports: string[];
  /** 通配符导入列表 (如 com.example.*) */
  wildcardImports: string[];
  /** 父类FQN (可为简单名若无法解析) */
  superClass: string | undefined;
  /** 索引消歧前的父类引用。 */
  rawSuperClass?: string;
  /** 实现的接口FQN列表 (可为简单名) */
  interfaces: string[];
  /** 索引消歧前的接口引用。 */
  rawInterfaces?: string[];
  /** 方法列表 (含规范化签名) */
  methods: JavaMethod[];
  /** 文件路径 */
  filePath: string;
}
