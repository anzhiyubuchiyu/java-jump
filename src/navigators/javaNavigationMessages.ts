export type JavaJumpType =
  | 'interface-to-impl'
  | 'impl-to-interface'
  | 'interface-method-to-impl'
  | 'impl-method-to-interface';

export function getNoTargetMessage(type: JavaJumpType, targetName?: string): string {
  const name = targetName ? ` (${targetName})` : '';
  switch (type) {
    case 'interface-to-impl': return `未找到接口的实现类${name}`;
    case 'impl-to-interface': return '未找到实现的接口';
    case 'interface-method-to-impl': return `未找到方法的实现${name}`;
    case 'impl-method-to-interface': return `未找到方法的接口定义${name}`;
  }
}

export function getPickerTitle(type: JavaJumpType, targetName?: string): string {
  const name = targetName ? ` (${targetName})` : '';
  switch (type) {
    case 'interface-to-impl': return `选择实现类${name}`;
    case 'impl-to-interface': return '选择接口';
    case 'interface-method-to-impl': return `选择方法实现${name}`;
    case 'impl-method-to-interface': return `选择方法定义${name}`;
  }
}
