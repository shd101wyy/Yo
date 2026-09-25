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
  point := Point(x: 3, y: 4);
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
Box :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(
    struct(
      (*) : V
    )
  )
);
box :: (fn(generic(V : Type), value : V) -> Box(V))(
  Box(V)(value)
);
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

一个方法满足以下条件时，可以通过 `Dyn(Trait)` 接收者调用：

1. 第一个参数是 `self`（`self : Self`、`inout(self) : Self` 或 `self : *(Self)`，因为 vtable 包装函数会为接收者拆箱）；
2. `Self` 不出现在签名的其他位置：既不是其他参数，也不是结果，也不在其中出现（`Option(Self)`、`Result(Self, E)`）；
3. 不带 `generic(...)` 参数。

原因如下：

- `Dyn` 擦除了具体类型，因此 `Self` 参数或结果在调用处没有唯一的 C 类型：同一个 `Dyn` 背后的两个具体类型大小和表示都不同。
- 泛型方法是一族函数（每个实例化一个），而一个 vtable 槽位只能放一个。

只有这些方法拥有 vtable 槽位。trait 仍可以声明其他方法，也可以构造它的 `Dyn` 并使用可调用的方法；通过 `Dyn` 调用其他方法会在调用处报错 E0614（`yo explain E0614`）：

```rust
Sp :: trait(speak : (fn(self : Self) -> i32), me : (fn(self : Self) -> Self));
(d : Dyn(Sp)) = dyn(Cat(n : i32(3)));
d.speak();   // OK：`Self` 只作为接收者
d.me();      // error[E0614]: Method "me" of trait Sp cannot be called through a Dyn receiver (dyn(Sp)): it returns Self, which the Dyn erases.
```

基于 trait 约束的一揽子固有方法（`impl(generic(E), where(E <: Named), E, shout : ...)`）同样接受 `Dyn(Named)` 接收者。它不是 trait 成员，没有 vtable 槽位：这个调用是对该方法（针对 `Dyn` 特化）的普通调用，而方法内部的 `self.name()` 通过 vtable 分派。

直接写在 `Dyn` 类型上的固有 impl 会为这个 `Dyn` 添加方法，就像 Rust 的 `impl dyn Error`：
`std/error.yo` 的 `impl(AnyError, is : ...)` 让 `err.is(NotFound)` 可以用在 `AnyError` 上。

通过泛型 impl 实现的 trait（`T <: ToString` 时 `ArrayList(T)` 的 `ToString`）可以放进 `Dyn`：`dyn(xs)` 会针对具体类型特化泛型 impl 的方法。

**不支持向上转换。** `Dyn(Sp, Ot)` 不会被转换为 `Dyn(Sp)`：两者的 vtable 布局不同，而构造较小 vtable 所需的具体类型已被擦除。请对具体值调用 `dyn(...)`，并带上目标所需的 trait。该决定记录在 `plans/TYPE_SYSTEM_SOUNDNESS.md`（Phase 2.7）中。

## dyn(...) 的引用语义类型要求

**规则**：`dyn(value)` 要求 `value` 具有**引用语义类型**（指向引用计数数据的指针）。如果是值类型，则会自动进行 `box` 装箱。

**原因**：`Dyn` 中的 `data` 字段必须指向引用计数的内存。这确保了安全的内存管理，而无需为 `Dyn` 本身添加 ref_header。

**示例：**

```rust
// 值类型必须装箱
dyn(box(42)); // OK：box(42) 返回 Box(i32)，这是一个引用语义类型
dyn(box(true)); // OK：box(true) 返回 Box(bool)
// 引用语义类型可以直接使用
point := Point(x : 3, y : 4); // point : Point，Point 是引用语义类型
dyn(point); // OK：point 是引用语义类型
// 直接传值会自动装箱
dyn(42); // 42 自动变为 box(42)
dyn(true); // true 自动变为 box(true)
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

## 运行时类型检查：`downcast(value, T)`

`Dyn` 擦除了具体类型，而 `downcast` 是把它取回来的方式：

```rust
downcast(dyn_value, T) -> Option(T)
```

这是从 `Dyn` 安全恢复具体类型的唯一途径，`std/error.yo` 里 `AnyError` 的 `err.is(T)`
就是用它实现的。两个参数的形式是固定的：第一个必须是 `Dyn` 类型，第二个必须是一个
**类型**（在编译期求值，所以 `T` 永远不是运行时值）。

```rust
Animal :: trait(speak : (fn(self : Self) -> unit));
// ... impl(Cat, Animal(...)); impl(Dog, Animal(...));
animal := dyn(Cat.new());

match(
  downcast(animal, Cat),
  .Some(cat) => cat.purr(),
  // 具体的 Cat，已计数且被拥有
  .None => println(`not a cat`)
);

// 只做判断、不使用值：
if(downcast(animal, Dog).is_some(), {
  println(`a dog`);
});
```

**检查是怎么做的。** 每个 `Dyn` 虚表都带一个 `__yo_type_id` 字段，每个具体类型都有
一个静态变量，其**地址**就是它的规范类型 id。检查就是一次指针比较——
`value.vtable->__yo_type_id == (uintptr_t)&__yo_typeid_Cat`——一次加载加一次比较，
没有字符串比较，也没有 RTTI 表。

**结果是被拥有的。** `Dyn` 只持有引用计数数据，所以成功的 downcast 会增加引用计数并
返回一个被拥有的引用：`Dyn` 保留自己那一份，两者各自独立释放。

**值类型会从盒子里取出来。** `dyn(42)` 会自动装箱（见
[dyn(...) 的引用语义类型要求](#dyn-的引用语义类型要求)），所以 `dyn.data` 指向的是
一个 `Box` 结构而不是值本身。downcast 到值类型或 newtype 目标时，会从那个盒子里把值
读出来并 dup——把 `data` 直接转成值结构体连合法的 C 都算不上。

**永远不可能成功的 downcast 是编译期的 `.None`。** 编译器知道程序中每一个
`dyn(...)` 的创建点。如果没有任何地方把 `T` 包进这个 `Dyn`，二进制里就没有任何虚表
携带 `T` 的类型 id，比较永远不可能成立，于是整个表达式被降级为常量 `.None`，而不是
一个永远为假的检查。

**没有非检查式的强制转换。** `downcast` 始终返回 `Option(T)`；如果你想在不匹配时
panic，那就是 `downcast(v, T).unwrap()`，写在调用点上因此是可见的。`typeid` 是另一个
内建，它接受一个**类型**而不是值——不能用来在运行时判断 `Dyn`。

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
