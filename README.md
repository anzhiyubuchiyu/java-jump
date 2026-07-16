# Java Jump

[中文](#中文说明) | [English](#english-description)

---

# English Description

A unified VS Code extension for Java interface/implementation navigation and exact MyBatis XML namespace navigation.

## Features

### 1. Java Interface Navigation

- **Interface → Implementation**: Click "Jump to Implementation" on interface classes or methods to quickly find all implementations
- **Implementation → Interface**: Click "Jump to Interface" on implementation methods to navigate to interface definitions
- **Multiple Implementations Selection**: Provides a selection list when multiple implementations exist

### 2. MyBatis XML Namespace Navigation

- **Java → XML**: Navigate from any top-level Java type to XML whose `namespace` exactly equals its FQN
- **XML → Java**: Navigate from Mapper XML to Java types with an exactly matching FQN
- **Method-level Navigation**: Navigate between a Java method and SQL only when the XML `id` exists on both sides
- **Exact Matching**: `@Mapper`, a `Mapper` suffix, inheritance relationships, source directory, and XML filename are not requirements
- **Multi-module Ranking**: When several exact candidates exist, candidates in the same module are ranked first

### 3. CodeLens Integration

Jump buttons displayed directly in the code editor:
- Regular interfaces: Show "Jump to Implementation"
- Java types with an exact XML namespace match: Show "Jump to XML"
- Implementation classes: Show "Jump to Interface"
- A navigation CodeLens is shown only when its target exists

### 4. Context Menu

The editor context menu provides Java ↔ XML navigation only. The extension does not register keyboard shortcuts for these commands.

## Configuration

Configure in `settings.json`:

```json
{
  "javaNavigator.enableCodeLens": true,
  "javaNavigator.enableInterfaceNavigation": true,
  "javaNavigator.enableMyBatisNavigation": true,
  "javaNavigator.excludeFolders": ["node_modules", ".git", "target", "build", "out", "dist"],
  "javaNavigator.mapperPatterns": [
    { "searchPaths": ["src/main/resources/mapper", "src/main/resources/mappers"] }
  ]
}
```

`javaNavigator.mapperPatterns` only provides early XML search hints. The final navigation decision always uses exact `namespace === Java FQN` matching.

## Usage Examples

### Example 1: Jump from Interface to Implementation

```java
// UserService.java - Click "Jump to Implementation"
public interface UserService {
    User getUserById(Long id);  // Jumps to UserServiceImpl.getUserById()
}
```

### Example 2: Jump from Java to XML

```java
// UserGateway.java - Click "Jump to XML"
public class UserGateway {
    User selectById(Long id) { return null; }  // Jumps to XML <select id="selectById">
}
```

```xml
<!-- The XML filename is arbitrary. namespace must exactly match the Java FQN. -->
<mapper namespace="com.example.UserGateway">
  <select id="selectById">select * from users where id = #{id}</select>
</mapper>
```

### Example 3: Multi-module Projects

When multiple modules contain exact namespace matches, the extension ranks candidates from the same module as the current Java file first.

## Installation

### Install from VSIX

1. Download the `.vsix` file
2. Press `Ctrl+Shift+P` in VS Code, type "install from vsix"
3. Select the downloaded file

### Install from Marketplace

Search for "Java Jump" in the VS Code Extensions marketplace and install.

## Requirements

- VS Code 1.74.0 or higher
- Java projects (Maven/Gradle supported)

## Technical Implementation

- Built on VS Code Extension API
- Developed with TypeScript
- Combines features from two open-source extensions:
  - Java Interface Implementation Jumper
  - vscode-mybatis-helper

---

# 中文说明

融合 Java 接口实现跳转和 MyBatis XML 精确命名空间导航的 VS Code 插件。

## 功能特性

### 1. Java接口与实现类导航

- **接口 → 实现类**: 在接口类或方法上点击「跳转到实现」，快速找到所有实现类
- **实现类 → 接口**: 在实现类的方法上点击「跳转到接口」，跳转到接口定义
- **多实现类选择**: 当有多个实现类时，提供选择列表

### 2. MyBatis XML命名空间导航

- **Java → XML**: 从任意顶级 Java 类型跳转到 `namespace` 与其 FQN 精确相等的 XML
- **XML → Java**: 从 Mapper XML 跳转到 FQN 精确匹配的 Java 类型
- **方法级跳转**: 仅当 Java 方法和 XML `id` 同时存在时，才显示并执行 SQL 级跳转
- **精确匹配**: 不要求 `@Mapper`、`Mapper` 后缀、继承关系、固定源码目录或特定 XML 文件名
- **多模块排序**: 存在多个精确候选时，优先排序同模块目标

### 3. CodeLens集成

在代码编辑器中直接显示跳转按钮：
- 普通接口：显示「跳转到实现」
- 存在精确 XML 命名空间匹配的 Java 类型：显示「跳转到XML」
- 实现类：显示「跳转到接口」
- 仅在目标真实存在时显示对应 CodeLens

### 4. 右键菜单

编辑器右键菜单只保留 Java ↔ XML 导航；扩展不注册这些命令的快捷键。

## 配置选项

在 `settings.json` 中配置：

```json
{
  "javaNavigator.enableCodeLens": true,
  "javaNavigator.enableInterfaceNavigation": true,
  "javaNavigator.enableMyBatisNavigation": true,
  "javaNavigator.excludeFolders": ["node_modules", ".git", "target", "build", "out", "dist"],
  "javaNavigator.mapperPatterns": [
    { "searchPaths": ["src/main/resources/mapper", "src/main/resources/mappers"] }
  ]
}
```

`javaNavigator.mapperPatterns` 仅提供 XML 的优先搜索路径提示；最终导航始终按 `namespace === Java FQN` 精确匹配决定。

## 使用示例

### 场景1: 从接口跳转到实现

```java
// UserService.java - 点击「跳转到实现」
public interface UserService {
    User getUserById(Long id);  // 跳转到 UserServiceImpl.getUserById()
}
```

### 场景2: 从Java跳转到XML

```java
// UserGateway.java - 点击「跳转到XML」
public class UserGateway {
    User selectById(Long id) { return null; }  // 跳转到 XML <select id="selectById">
}
```

```xml
<!-- XML 文件名任意，namespace 必须与 Java FQN 精确相等。 -->
<mapper namespace="com.example.UserGateway">
  <select id="selectById">select * from users where id = #{id}</select>
</mapper>
```

### 场景3: 多模块项目

当多个模块存在精确命名空间候选时，插件会优先排序与当前 Java 文件同模块的目标。

## 安装

### 从VSIX安装

1. 下载 `.vsix` 文件
2. 在VS Code中按 `Ctrl+Shift+P`，输入 "install from vsix"
3. 选择下载的文件

### 从Marketplace安装

在 VS Code 扩展商店搜索 "Java Jump" 并安装。

## 要求

- VS Code 1.74.0 或更高版本
- Java 项目（支持Maven/Gradle）

## 技术实现

- 基于 VS Code Extension API
- 使用 TypeScript 开发
- 融合两个开源插件的功能：
  - Java Interface Implementation Jumper
  - vscode-mybatis-helper

## License

MIT License
