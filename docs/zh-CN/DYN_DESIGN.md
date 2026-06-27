# Dyn/dyn 动态分派实现

## 概述

`Dyn(Trait)` 通过类型擦除的动态分派实现运行时多态。

**重要说明**：`Dyn` 是一个**值类型**（包含数据指针和虚表的结构体）。其 `data` 字段**必须**指向一个 `ref(struct(...))` 类型（引用计数类型）。

```typescript
Id :: trait(id : (fn(inout(self) : Self) -> i32));

impl(i32, Id(id : ((self) -> { printf("i32: %d\n", self.*); return self.*; })));
impl(bool, Id(id : ((self) -> { printf("bool\n"); return cond(self.* => 1, true => 0); })));

use_id :: (fn(value : Dyn(Id)) -> unit) { x := value.id(); };

main :: (fn() -> unit) {
  // 值类型必须装箱
  use_id(dyn(box(42)));
  use_id(dyn(box(true)));

  // 引用语义类型可以直接使用
  point := Point(3, 4);
  use_id(dyn(point));
};
```

## 核心设计

### 1. Dyn 类型（值类型 — 胖指针）

`Dyn(Trait)` 是一个**值类型结构体**（无 ref_header）。它是一个包含数据和虚表的胖指针。

```c
typedef struct {
  void* data;                    // 必须指向引用语义类型（具有 ref_header）
  const TraitVtable* vtable;    // 静态虚表指针
} __yo_dyn_trait_id;
```

**要点：**

- `Dyn` 是**值类型** — 像结构体一样按值复制
- `data` **必须**指向引用语义类型（始终具有 ref_header）
- 复制 `Dyn` 时，对 `data` 指针执行 `___dup`
- 销毁 `Dyn` 时，对 `data` 指针执行 `___drop`
- `Dyn` 结构体本身不在堆上分配

### 2. 数据存储（引用语义类型约束）

`data` 字段**必须**指向引用语义类型（引用计数类型）。值类型必须用 `Box(T)` 包装。

```c
// 对于值类型 — 必须使用 Box(T)
Box_i32* boxed = /* box(42) */;  // Box(i32) 是引用语义类型
void* data = boxed;               // 存储 Box 指针

// 对于引用语义类型 — 直接使用
Point* point = /* Point(3, 4) */;  // Point 是引用语义类型
void* data = point;                // 存储 Point 指针
```

**Box 类型定义：**

```rust
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  ref(struct(
    (*) : V
  ))
;
box :: (fn(forall(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

**为什么有此约束？**

- 简化 `Dyn`：无需 ref_header
- 单层引用计数：只有 `data` 是引用计数的
- 统一处理：所有 `data` 指针具有相同的内存布局
- 类型安全：在编译时强制检查

### 3. 虚表结构（统一签名）

```c
typedef struct {
  int32_t (*return_i32)(void*);    // 所有返回类型必须是具体类型（不能是 Self）
  void (*print)(void*);            // unit 返回类型
} __yo_dyn_trait_TestDyn_vtable;
```

**包装函数：**

- **引用语义类型**：直接类型转换（无需包装函数）
- **装箱的值类型**：生成包装函数，在调用 impl 前先解包 `Box(T)`

## 对象安全约束（遵循 Rust）

**约束**：与 `Dyn()` 一起使用的 trait **不能**有以下类型的方法：

1. 按值接收 `Self` — 必须使用 `inout(self) : Self` 替代
2. 返回 `Self`
3. 返回包含 `Self` 的类型（如 `Option(Self)`、`Result(Self, E)` 等）

这遵循了 Rust 的"对象安全"规则（dyn 兼容性）。原因如下：

- 按值接收 `Self`：不同的具体类型具有不同的大小（i32 vs MyBox*），无法通过统一的 `void*` 参数传递
- 返回 `Self`：不同的具体类型产生不同的返回类型，使统一的虚表签名成为不可能

**可用于**动态分派的：

```typescript
TestDyn :: trait(
  return_i32 : (fn(inout(self) : Self) -> i32),  // 接收 inout(Self)，返回具体类型 — OK！
  print : (fn(inout(self) : Self) -> unit)        // 接收 inout(Self)，返回 unit — OK！
);
```

**不可用于**动态分派的（违反对象安全）：

```typescript
TestDyn :: trait(
  by_value : (fn(self : Self) -> unit),        // 按值接收 Self — 不满足对象安全！
  id : (fn(inout(self) : Self) -> Self)           // 返回 Self — 不满足对象安全！
);
```

该约束在**方法调用时**强制检查，而非在 trait 定义时。你可以定义包含非对象安全方法的 trait，但不能在 Dyn 值上调用这些方法。

## dyn(...) 的引用语义类型要求

**规则**：`dyn(value)` 要求 `value` 具有**引用语义类型**（指向引用计数数据的指针）。如果是值类型，则会自动进行 `box` 装箱。

**原因**：`Dyn` 中的 `data` 字段必须指向引用计数的内存。这确保了安全的内存管理，而无需为 `Dyn` 本身添加 ref_header。

**示例：**

```rust
// 值类型必须装箱
dyn(box(42));           // OK：box(42) 返回 Box(i32)，这是一个引用语义类型
dyn(box(true));         // OK：box(true) 返回 Box(bool)

// 引用语义类型可以直接使用
point := Point(3, 4);   // point : Point，Point 是引用语义类型
dyn(point);             // OK：point 是引用语义类型

// 直接传值会自动装箱
dyn(42);                // 42 自动变为 box(42)
dyn(true);              // true 自动变为 box(true)
```

### 4. 静态虚表和包装函数

**对于值类型（装箱后）：**

```c
// i32 的原始方法实现
int32_t fn_i32_id(int32_t* self) {
  return *self;
}

// 解包 Box(i32) 的包装函数
int32_t wrapper_Box_i32_id(void* self_ptr) {
  Box_i32* box = (Box_i32*)self_ptr;
  return fn_i32_id(&box->value);  // 提取值，调用原始方法
}

// dyn(box(i32)) 的静态虚表
static const __yo_dyn_trait_Id_vtable __yo_vtable_Box_i32_Id = {
  .id = wrapper_Box_i32_id  // 指向包装函数
};
```

**对于引用语义类型：**

```c
// Point 的原始方法实现
void fn_Point_print(Point* self) {
  printf("(%d, %d)", self->x, self->y);
}

// dyn(point) 的静态虚表 — 无需包装函数！
static const __yo_dyn_trait_Printer_vtable __yo_vtable_Point_Printer = {
  .print = (void(*)(void*))fn_Point_print  // 直接类型转换
};
```

## 构造：`dyn(value)`

构造 `Dyn` 时，值必须是引用语义类型。`Dyn` 结构体在栈上创建，并存储数据指针。

```c
// 对于 dyn(box(42))：
Box_i32* boxed = /* box(42) 的结果 */;  // 已经 RC = 1

__yo_dyn_trait_id result = {
  .data = boxed,
  .vtable = &__yo_vtable_Box_i32_Id
};
// 注意：此处不执行 dup，所有权从 box(42) 转移到 dyn
```

```c
// 对于 dyn(point)，其中 point : Point：
Point* point = /* Point(3, 4) */;  // 已经 RC = 1

__yo_dyn_trait_Printer result = {
  .data = point,
  .vtable = &__yo_vtable_Point_Printer
};
// 注意：此处不执行 dup，所有权从 point 转移到 dyn
```

**要点**：由于 `Dyn` 是值类型，它在栈上创建。`data` 指针的所有权被转移（构造时不执行 dup）。

## 方法分派

对 `Dyn` 的方法调用通过虚表进行。由于 `Dyn` 是值类型，`value` 是结构体本身。

```c
// value 的类型为 __yo_dyn_trait_TestDyn（结构体，非指针）
int32_t result = value.vtable->return_i32(value.data);
value.vtable->print(value.data);
```

## Dyn 的引用计数

由于 `Dyn` 是值类型，我们需要对 `data` 指针进行操作的 dup/drop 函数。

### Dup 函数

复制 `Dyn` 时，递增 `data` 指针的引用计数：

```c
__yo_dyn_trait_id __yo_dup_dyn_trait_Id(__yo_dyn_trait_id dyn) {
  if (dyn.data) {
    __yo_incr_rc(dyn.data);  // data 始终是引用语义类型
  }
  return dyn;  // 返回复制的结构体
}
```

### Drop 函数

销毁 `Dyn` 时，递减 `data` 指针的引用计数：

```c
void __yo_drop_dyn_trait_Id(__yo_dyn_trait_id dyn) {
  if (dyn.data) {
    __yo_decr_rc(dyn.data);  // data 始终是引用语义类型
  }
}
```

**要点：**

- 无需类型特定的 dup/drop — `data` 始终是引用语义类型指针
- `data` 引用语义类型的 dispose 函数负责清理（无论是 Box 还是普通引用语义类型）
- `Dyn` 本身从不在堆上分配，因此不需要 dispose 函数

## 设计总结

1. **`Dyn` 是值类型**：简单结构体 `{ void* data, vtable* }`，无 ref_header
2. **`data` 必须是引用语义类型**：确保数据始终是引用计数的
3. **值类型使用 `box()`**：`dyn(box(42))` 将值包装在 `Box(T)` 引用语义类型中
4. **引用语义类型直接使用**：`dyn(Point(3, 4))` 直接使用 Point 指针
5. **Box 的包装函数**：生成的包装函数在调用 impl 方法前先解包 `Box(T)`
6. **简单的引用计数**：只有 `data` 是引用计数的，`Dyn` 结构体按值复制
7. **Dup/Drop 函数**：标准函数，对 `data` 指针执行 dup/drop 操作
