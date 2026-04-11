# 语言服务器协议 (LSP) 支持

Yo 内置了一个 LSP 服务器，为 `.yo` 文件提供丰富的编辑器支持。该服务器使用 TypeScript 实现，复用 Yo 求值器以获取精确的类型信息。

## 架构

```
VS Code 扩展（轻量客户端）
  ↕ stdio JSON-RPC
LSP 服务器（src/lsp/）
  ↕ 直接函数调用
Yo 求值器（src/evaluator/）
```

VS Code 扩展是一个轻量的 `LanguageClient` 包装（约 80 行代码）。所有智能逻辑都在 LSP 服务器中，它直接调用求值器进行类型解析、补全和诊断。

## 功能

### 1. 悬停信息

将鼠标悬停在任何标识符上，可以看到其类型、值（如果是编译时已知的）和文档注释。

- **变量**：显示类型和值
- **函数**：显示完整的签名，包括参数名和类型
- **结构体字段**：显示字段类型和文档注释
- **impl 方法标签**：显示方法签名和文档注释
- **类型级访问**：`Point.origin` 显示方法的类型

### 2. 自动补全

#### 点号补全（`expr.`）

在表达式后输入 `.` 可以看到可用的成员：

- **结构体字段**：所有字段及其类型和文档注释
- **枚举变体**：变体名称及字段类型（如 `Some(T)`、`None`）
- **模块成员**：导出的函数和类型及其文档注释
- **impl 方法**：来自 `impl` 块的方法（直接和泛型）
- **数组/切片**：`.len` 属性
- **类型级别**：`Point.` 显示静态方法和构造函数
- **指针自动解引用**：`ptr.field` 自动解引用

#### 枚举变体点号前缀（`.Variant`）

在有类型标注的上下文中，输入 `.` 可以看到枚举变体：

```rust
(x : Option(i32)) = .  // 显示：.Some, .None
match(color,
  .  // 显示：.Red, .Green, .Blue
)
```

#### 标识符补全

输入任何前缀可以看到作用域内匹配的变量、函数和关键字。

### 3. 跳转到定义

`Ctrl+Click` 或 `F12` 点击任何标识符跳转到其定义位置。

### 4. 文档符号

`Ctrl+Shift+O` 查看当前文件中所有顶层声明。

### 5. 查找引用

`Shift+F12` 查找当前文件中某个符号的所有引用。

### 6. 重命名符号

`F2` 重命名一个符号及其所有引用。

### 7. 签名帮助

在函数名后输入 `(` 可以在输入参数时看到参数提示。

### 8. 折叠范围

支持函数体、结构体定义、impl 块和其他多行结构的代码折叠。

### 9. 内联提示

对于类型推断的变量声明，显示内联类型提示。

### 10. 诊断

输入时实时报告错误，由 Yo 求值器驱动。

## 设置

### VS Code

1. 从 VS Code 市场安装 Yo 扩展（或从源码构建）
2. 打开 `.yo` 文件时 LSP 服务器会自动启动
3. 无需额外配置

### 从源码构建

```bash
# 构建 LSP 服务器
bun run build

# 构建 VS Code 扩展
cd vscode-extension
bun install
bun package
```

LSP 服务器会被打包到 `out/cjs/yo-lsp.cjs` 中，并包含在 VS Code 扩展包内。

### 其他编辑器

LSP 服务器通过 stdio JSON-RPC 通信，可以与任何支持语言服务器协议的编辑器配合使用。启动服务器：

```bash
node out/cjs/yo-lsp.cjs --stdio
```

## 实现细节

### 模块缓存

LSP 维护一个"最后成功模块"缓存。当用户正在输入时（如 `p2.`），不完整的表达式可能导致求值错误。服务器会回退到最后一次成功的求值结果来提供补全。

### Trait 字段快照

当模块被重新求值时，`deleteModule` 会修改共享的类型对象（清除 impl 添加的 trait 字段）。LSP 在删除前快照所有 trait 字段数组，并为缓存的模块恢复它们，确保方法补全保持可用。

### 泛型 Impl 解析

泛型 `impl` 块中的方法（如 `impl(forall(T), Option(T), ...)`）通过全局 `genericImplRegistry` 解析。LSP 枚举这些来为 `ArrayList`、`Option`、`Result` 和 `HashMap` 等类型提供补全。

### 文档注释传播

文档注释（`///`）在词法分析时提取，通过 `docCommentLookup` 与声明关联，并通过以下方式传播：

- 结构体字段求值 → `TypeField.docComment`
- 模块字段求值 → `ModuleField.docComment`
- Impl 字段求值 → `TraitField.docComment`
- `attachTraitToReceiverType()` → 将文档注释复制到接收者类型

## 测试

```bash
# 运行 LSP 测试
bun test src/tests/lsp.test.ts --timeout 60000
```

测试套件覆盖：

- 结构体字段补全
- 枚举变体补全
- 模块成员补全（含文档注释）
- 数组 `.len` 补全
- Impl 方法补全
- 类型级补全（静态方法）
- 关键字补全
- 变量、类型和函数悬停
- Impl 字段标签悬停
