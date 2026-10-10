# Dyn/dyn 动态分派实现

## 概述

`Dyn(Trait)` 通过类型擦除的动态分派实现运行时多态。

**重要说明**：`Dyn` 是一个**值类型**（包含数据指针和虚表的结构体）。其 `data` 字段**必须**指向一个 `ref(struct(...))` 类型（引用计数类型）。

```typescript
Id :: trait(id : (fn(self : &mut Self) -> i32));

impl(i32, Id(id : ((self) -> { printf("i32: %d\n", self.*); return self.*; })));
impl(bool, Id(id : ((self) -> { printf("bool\n"); return cond(self.* => 1, true => 0); })));

use_id :: (fn(value : Dyn(Id)) -> unit) { x := value.id(); };

main :: (fn() -> unit) {
  // 值类型必须装箱
  use_id(dyn(rc(42)));
  use_id(dyn(rc(true)));

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
- 复制 `Dyn` 时 retain `data` 指针，销毁时 release 它。两者都经由虚表的 `__yo_retain` / `__yo_release` 槽位（位于 `__yo_type_id` 之后），由具体的载荷类型填写：原子引用对象（`Arc`、`atomic` 结构体）使用原子引用计数操作，其余使用普通操作
- `Dyn` 结构体本身不在堆上分配

### 2. 数据存储（引用语义类型约束）

`data` 字段**必须**指向引用语义类型（引用计数类型）。值类型必须用 `Rc(T)` 包装。

```c
// 对于值类型 — 必须使用 Rc(T)
Box_i32* boxed = /* rc(42) */;  // Rc(i32) 是引用语义类型
void* data = boxed;               // 存储 Box 指针

// 对于引用语义类型 — 直接使用
Point* point = /* Point(3, 4) */;  // Point 是引用语义类型
void* data = point;                // 存储 Point 指针
```

**Rc 类型定义：**

```yo
Rc :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(
    struct(
      (*) : V
    )
  )
);
rc :: (fn(generic(V : Type), sink(value) : V) -> Rc(V))(Rc(V)(value));
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
- **装箱的值类型**：生成包装函数，在调用 impl 前先解包 `Rc(T)`

## 对象安全约束（遵循 Rust）

一个方法满足以下条件时，可以通过 `Dyn(Trait)` 接收者调用：

1. 第一个参数是 `self`（`self : Self`、`self : &mut Self` 或 `self : *(Self)`，因为 vtable 包装函数会为接收者拆箱）；
2. `Self` 不出现在签名的其他位置：既不是其他参数，也不是结果，也不在其中出现（`Option(Self)`、`Result(Self, E)`）；
3. 不带 `generic(...)` 参数。

原因如下：

- `Dyn` 擦除了具体类型，因此 `Self` 参数或结果在调用处没有唯一的 C 类型：同一个 `Dyn` 背后的两个具体类型大小和表示都不同。
- 泛型方法是一族函数（每个实例化一个），而一个 vtable 槽位只能放一个。

只有这些方法拥有 vtable 槽位。trait 仍可以声明其他方法，也可以构造它的 `Dyn` 并使用可调用的方法；通过 `Dyn` 调用其他方法会在调用处报错 E0614（`yo explain E0614`）：

```yo
Sp :: trait(speak : (fn(self : Self) -> i32), me : (fn(self : Self) -> Self));
(d : Dyn(Sp)) = dyn(Cat(n : i32(3)));
d.speak(); // OK：`Self` 只作为接收者
d.me(); // error[E0614]: Method "me" of trait Sp cannot be called through a Dyn receiver (dyn(Sp)): it returns Self, which the Dyn erases.
```

基于 trait 约束的一揽子固有方法（`impl(generic(E), where(E <: Named), E, shout : ...)`）同样接受 `Dyn(Named)` 接收者。它不是 trait 成员，没有 vtable 槽位：这个调用是对该方法（针对 `Dyn` 特化）的普通调用，而方法内部的 `self.name()` 通过 vtable 分派。

直接写在 `Dyn` 类型上的固有 impl 会为这个 `Dyn` 添加方法，就像 Rust 的 `impl dyn Error`：
`std/error.yo` 的 `impl(AnyError, is : ...)` 让 `err.is(NotFound)` 可以用在 `AnyError` 上。

通过泛型 impl 实现的 trait（`T <: ToString` 时 `ArrayList(T)` 的 `ToString`）可以放进 `Dyn`：`dyn(xs)` 会针对具体类型特化泛型 impl 的方法。

**没有隐式的向上转换。** `Dyn(Sp, Ot)` 不会流入 `Dyn(Sp)` 形参或绑定：两者的 vtable 布局不同，因此这种转换改变了表示方式，需要用 `upcast`（见下文）显式写出。trait 列表是一个集合：`Dyn(Sp, Ot)` 和 `Dyn(Ot, Sp)` 是同一个类型。

**同一个 `Dyn` 中的两个 trait 不能有同名方法**（E0616）。`Dyn` 按名字调用方法，因此当 `A` 和 `B` 都声明了可调用的 `get` 时，`Dyn(A, B)` 会在写出该类型的地方被拒绝：`d.get()` 无法说明它指的是哪个 trait 的方法。

## dyn(...) 的引用语义类型要求

**规则**：`dyn(value)` 要求 `value` 具有**引用语义类型**（指向引用计数数据的指针）。如果是值类型，则会自动包装成 `rc(value)`。

**原因**：`Dyn` 中的 `data` 字段必须指向引用计数的内存。这确保了安全的内存管理，而无需为 `Dyn` 本身添加 ref_header。

**示例：**

```yo
// 值类型必须装箱
dyn(rc(42)); // OK：rc(42) 返回 Rc(i32)，这是一个引用语义类型
dyn(rc(true)); // OK：rc(true) 返回 Rc(bool)
// 引用语义类型可以直接使用
point := Point(x : 3, y : 4); // point : Point，Point 是引用语义类型
dyn(point); // OK：point 是引用语义类型
// 直接传值会自动装箱
dyn(42); // 42 自动变为 rc(42)
dyn(true); // true 自动变为 rc(true)
```

**`Send` Dyn 的载荷是原子的。** `Dyn(Trait, Send)` 的每个副本都可能位于另一个线程，并在那里 retain 和 release 同一个 `data` 对象，因此其引用计数必须是原子的。对于 `Send` 目标，`dyn(v)` 用 `arc` 而不是 `rc` 装箱值类型。非原子的引用载荷是错误：

```yo
(d : Dyn(Fn() -> unit, Send)) = dyn(k); // OK：k 用 arc 装箱
(e : Dyn(Fn() -> unit, Send)) = dyn(rc(k)); // 错误：其载荷必须是原子引用计数的
```

### 4. 静态虚表和包装函数

**对于值类型（装箱后）：**

```c
// i32 的原始方法实现
int32_t fn_i32_id(int32_t* self) {
  return *self;
}

// 解包 Rc(i32) 的包装函数
int32_t wrapper_Box_i32_id(void* self_ptr) {
  Box_i32* box = (Box_i32*)self_ptr;
  return fn_i32_id(&box->value);  // 提取值，调用原始方法
}

// dyn(rc(i32)) 的静态虚表
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
// 对于 dyn(rc(42))：
Box_i32* boxed = /* rc(42) 的结果 */;  // 已经 RC = 1

__yo_dyn_trait_id result = {
  .data = boxed,
  .vtable = &__yo_vtable_Box_i32_Id
};
// 注意：此处不执行 dup，所有权从 rc(42) 转移到 dyn
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

```yo
downcast(dyn_value, T) -> Option(T)
```

这是从 `Dyn` 安全恢复具体类型的唯一途径，`std/error.yo` 里 `AnyError` 的 `err.is(T)`
就是用它实现的。两个参数的形式是固定的：第一个必须是 `Dyn` 类型，第二个必须是一个
**类型**（在编译期求值，所以 `T` 永远不是运行时值）。

```yo
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

**值类型会从单元里取出来。** `dyn(42)` 会自动装箱（见
[dyn(...) 的引用语义类型要求](#dyn-的引用语义类型要求)），所以 `dyn.data` 指向的是
一个 `Rc` 单元而不是值本身。downcast 到值类型或 newtype 目标时，会从那个单元里把值
读出来并 dup——把 `data` 直接转成值结构体连合法的 C 都算不上。

**永远不可能成功的 downcast 是编译期的 `.None`。** 编译器知道程序中每一个
`dyn(...)` 的创建点。如果没有任何地方把 `T` 包进这个 `Dyn`，二进制里就没有任何虚表
携带 `T` 的类型 id，比较永远不可能成立，于是整个表达式被降级为常量 `.None`，而不是
一个永远为假的检查。

**没有非检查式的强制转换。** `downcast` 始终返回 `Option(T)`；如果你想在不匹配时
panic，那就是 `downcast(v, T).unwrap()`，写在调用点上因此是可见的。`type_id` 是另一个
内建，它接受一个**类型**而不是值——不能用来在运行时判断 `Dyn`。

## 向上转换：`upcast(value, Dyn(...))`

`upcast` 把同一个载荷放到 trait 更少的 `Dyn` 后面：

```yo
(both : Dyn(Speak, Run)) = dyn(Dog());
(s : Dyn(Speak)) = upcast(both, Dyn(Speak)); // Dyn(Speak)
(e : AnyError) = dyn(ParseError.Bad);
(t : Dyn(ToString)) = upcast(e, Dyn(ToString)); // AnyError 是 Dyn(Error, ToString)
```

它在编译期检查，因此返回 `Dyn` 而不是 `Option`：目标要求的每个 trait 都必须是源携带的（包括展开后的父 trait），目标排除的每个 trait（`!Send`）都必须是源也排除的。从 `Dyn(Speak)` 做 `upcast(one, Dyn(Speak, Run))` 会报 E0602。对已经是 `Dyn` 的值调用 `dyn(d)` 是一个错误，并会提示使用 `upcast`：载荷的类型已被擦除，没有东西可以用来构造新的 vtable。

**实现方式。** 具体类型在 upcast 处已被擦除，但在构造源值的 `dyn(...)` 处并没有，而且编译器能看到整个程序。对源 `Dyn(Src)` 的每个 `upcast(_, Dyn(Tgt))`，每个 `Dyn(Src)` vtable 都多带一个指针 `__yo_up_<Tgt>`，指向同一具体类型的 `Dyn(Tgt)` vtable（由编译器为它生成）。于是 upcast 只是一次读取加一次 retain：

```c
(Tgt){ .data = __yo_dyn_retain(d.data, d.vtable), .vtable = d.vtable->__yo_up_Tgt }
```

Rust 也是这样实现 `dyn Sub -> dyn Super` 的。载荷是共享的而不是复制的：结果是一个拥有所有权的 `Dyn`，它通过源 vtable 的 RC 槽位 retain 载荷，对它做 `downcast` 能找回原来的具体类型。不含 `upcast` 的程序生成的代码与以前完全相同。

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
- `data` 引用语义类型的 dispose 函数负责清理（无论是 `Rc` 单元还是普通引用语义类型）
- `Dyn` 本身从不在堆上分配，因此不需要 dispose 函数

## 设计总结

1. **`Dyn` 是值类型**：简单结构体 `{ void* data, vtable* }`，无 ref_header
2. **`data` 必须是引用语义类型**：确保数据始终是引用计数的
3. **值类型使用 `rc()`**：`dyn(rc(42))` 将值包装在 `Rc(T)` 引用语义类型中
4. **引用语义类型直接使用**：`dyn(Point(3, 4))` 直接使用 Point 指针
5. **Rc 的包装函数**：生成的包装函数在调用 impl 方法前先解包 `Rc(T)`
6. **简单的引用计数**：只有 `data` 是引用计数的，`Dyn` 结构体按值复制
7. **Dup/Drop 函数**：标准函数，对 `data` 指针执行 dup/drop 操作
