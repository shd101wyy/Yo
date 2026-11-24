# 测试

编写与运行测试：`test(...)`、断言、预期的编译错误、测试文件以及测试 `Drop`。
`yo test --help` 列出测试运行器的参数。

## 概述

Yo 内置了通过 `test` 关键字使用的测试框架。

## 基本测试语法

```yo
test("Test description", {
  // 测试代码
  x := (1 + 1);
  assert(x == 2, "x 应该为 2");
});

// Io 通过 `io` 自动注入到所有测试体中
test("With effects", {
  io.await(sleep(u64(1000)), io);
});
```

## 运行测试

可以使用 Yo CLI 运行测试：

```bash
# 运行文件中的所有测试
$ yo test path/to/file.test.yo

# 按模式运行特定测试
$ yo test path/to/file.test.yo --test-name-pattern "Test addition"

# 首次失败时停止
$ yo test path/to/file.test.yo --bail

# 详细输出
$ yo test path/to/file.test.yo -v

# 只列出路径 + 模式选中的测试，不编译任何东西
$ yo test ./tests --list

# 每行一个 JSON 对象：每个测试一条 "test" 事件（file、name、status、
# duration_ms；失败时附 message 与捕获的输出），最后一条 "summary" 事件
$ yo test ./tests --json
```

## 断言

### 运行时断言

```yo
{ assert } :: import("std/assert");

test("Runtime assertions", {
  x := 42;

  // 基本断言
  assert(x == 42);

  // 带消息的断言
  assert(x > 0, "x should be positive");

  // 复杂断言
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
});
```

### 编译时断言

使用 `comptime_assert` 进行编译时验证：

```yo
test("Compile-time assertions", {
  // 这些在编译期间检查
  comptime_assert((2 + 2) == 4);
  comptime_assert(Array(i32, 5).fill(0).len() == 5);
  comptime_assert(f32(3.14) > f32(3.0));

  // 类型级断言
  T :: i32;
  comptime_assert(Type.to_string(T) == "i32");
});
```

## 测试预期错误

验证某些代码会产生编译时错误：

```yo
test("Expected compile errors", {
  // 预期错误但不指定具体消息
  comptime_expect_error({
    x :: (1 / 0); // 除以零
  });

  // 预期错误并指定具体消息
  comptime_expect_error({
    arr : Array(i32, _);
    arr = [1, 2, 3];
  }, "Array type with inferred length '_' is not allowed in type annotations");

  // 测试某些模式是无效的
  comptime_expect_error({
    closure1 := (x => (x + 1));
    closure2 := (x => (x + 1));
    // 每个闭包都有唯一类型
    (c : type_of(closure1)) = closure2; // 错误！
  }, "no two closures have the same type");
});
```

## 测试组织

在同一文件中组织相关测试：

```yo
// arithmetic.test.yo
test("Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
});

test("Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
});

test("Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
});

test("Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
});
```

## 测试 Drop

测试清理和释放：

```yo
{ println } :: import("std/fmt");
{ assert } :: import("std/assert");

MyBox :: struct(value : i32);
impl(
  MyBox,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`Disposing MyBox with value: ${self.value}`);
    })
  )
);

test("Object disposal", {
  // MyBox 在作用域结束时自动释放
  mut(b) := MyBox(value : 42);
  assert(b.value == 42);
  b.value = 100;
  assert(b.value == 100);
  // 此处自动运行 drop；手动调用它是 E0915
});
```

## 测试文件

Yo 测试文件通常使用 `.test.yo` 扩展名：

- `basic.test.yo` — 基本语言特性
- `array.test.yo` — 数组操作
- `closure.test.yo` — 闭包功能
- `async-await.test.yo` — 异步/等待特性
- `collections/*.test.yo` — 集合类型

完整的测试示例请参阅 `tests/` 目录。
