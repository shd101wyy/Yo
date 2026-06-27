# 隔离类型（Isolated Type）

`Iso(T)` 是一个使用**原子引用计数**实现的线程安全包装类型。

## 核心特性

- **原子引用计数**：`Iso(T)` 使用原子引用计数，而非普通的非原子引用计数
- **线程安全共享**：可以安全地跨线程复制和传递
- **无移动语义**：行为与普通引用语义类型一致（可以存储、模式匹配等）
- **构造时隔离**：`Iso(T)(v)` 要求 `v` 是唯一所有者（无别名引用）
- **自动实现 `Send`**：可安全地跨线程发送

## 设计理念

我们没有引入移动语义，而是在构造时确保隔离性，并使用原子引用计数来保证线程安全：

1. **构造检查**：`Iso(T)(v)` 要求 `v` 没有别名引用（通过 `isOwningTheSameRcValueAs` 检查）
2. **原子操作**：一旦包装完成，所有引用计数操作均使用原子指令
3. **常规语义**：构造完成后，`Iso(T)` 可以自由复制和共享

## Isolation trait

`Isolation` trait 提供了检查类型是否可以隔离的函数。

```rust
Isolation :: trait(
  can_isolate : (fn(self : Self) -> bool)
);
```

用户应为自定义类型实现该 trait，以指示该类型是否支持隔离。
例如：

```rust
Data :: ref(struct(v : i32));
Point :: ref(struct(x : Data, y : Data));

impl(Data, Isolation(
  can_isolate : ((self) -> rc(self) == 1)
));

impl(Point, Isolation(
  can_isolate : ((self) ->
    (rc(self) == 1) &&
    (self.x.can_isolate()) &&
    (self.y.can_isolate())
  )
));
```

未来我们将支持 `derive` 关键字，以自动生成用户定义类型的 `Isolation` 实现。

## 构造约束

`Iso(T)(v)` 构造函数要求：

1. **唯一所有权**：`v` 不能有任何别名引用

   - 检查：`v.isOwningTheRcValue == true`
   - 检查：`v.isOwningTheSameRcValueAs == undefined`
   - 检查：没有其他变量的 `isOwningTheSameRcValueAs == v.id`

2. **递归隔离**（对于引用类型）：
   - 如果 `T` 包含嵌套引用语义类型，这些值也必须是唯一所有的
   - 通过 `v.can_isolate()` 方法检查（参见上文 Isolation trait）

```rust
// ❌ 拒绝：x 有别名 y
x := box(1);
y := x;                    // y.isOwningTheSameRcValueAs = x
iso := Iso(Box(i32))(x);   // 编译错误：x 有别名引用

// ✅ 通过：x 是唯一所有者
x := box(1);               // x 拥有所有权，无别名
iso := Iso(Box(i32))(x);   // OK：使用原子引用计数构造 Iso

// ✅ 构造后可自由复制
iso2 := iso;               // 原子 dup — 安全！
```

## `extract` 方法

内建函数 `__yo_iso_extract` 从 `Iso(T)` 中提取内部值，返回 `Option(T)`。

```rust
iso := Iso(Box(i32))(box(42));
val_opt := __yo_iso_extract(iso);    // val_opt : Option(Box(i32))

match(val_opt,
  .Some(val) => {
    // 提取成功
    // val 现在使用非原子引用计数，请保持在当前线程中使用！
    printf("Got value: %d\n", val.(*));
  },
  .None => {
    // 对于有状态提取语义，提取可能返回 None
    printf("No value\n");
  }
);
```

**实现细节：** `__yo_iso_extract(iso)` 返回类型为 `Option(T)` 的包装值：

- 返回 `.Some(inner_value)`，包含内部值
- 对于有状态提取语义（尚未实现），可能返回 `.None`

**重要提示：** 提取后，内部的 `T` 使用非原子引用计数。该值应留在执行提取的线程中，以避免对其非原子引用计数器产生数据竞争。

**注意：** 目前提取操作不会消耗 `Iso(T)` 参数，以确保引用计数的 drop 逻辑正常工作。因此可能进行多次提取（返回相同的值），但此行为在未来的实现中可能会更改，以强制单次提取语义。

## `^` 宏

为方便使用，可以使用 `^` 宏来隔离值，并自动推断类型：

### 基本用法

```rust
x := Data(12);
iso_opt := ^(x);  // 返回 Option(Iso(Data))

match(iso_opt,
  .Some(iso) => {
    // 隔离成功
    spawn(() => { /* 使用 iso */ });
  },
  .None => {
    // 隔离失败（存在别名或 rc > 1）
  }
);
```

## 原子引用计数实现

`Iso(T)` 对所有引用计数操作使用原子操作：

```c
// 普通引用语义类型：非原子引用计数
typedef struct {
  size_t ref_count;        // 非原子计数器
  void (*dispose_fn)(void*);
  T value;
} Object_T;

// 隔离引用语义类型：原子引用计数
typedef struct {
  _Atomic size_t ref_count;  // 原子计数器（线程安全）
  void (*dispose_fn)(void*);
  T value;                   // 内部值（非原子引用计数！）
} Iso_T;

// 构造函数：创建时 ref_count = 1
Iso_T* __yo_create_iso_T(T inner_value) {
  Iso_T* iso = (Iso_T*)__yo_alloc(sizeof(Iso_T));
  atomic_init(&iso->ref_count, 1);
  iso->dispose_fn = NULL;  // 不需要 dispose 函数
  iso->value = inner_value;
  return iso;
}

// Dup 使用原子递增
void __yo_incr_rc_atomic(Iso_T* iso) {
  atomic_fetch_add(&iso->ref_count, 1);  // 线程安全的递增
}

// Drop 使用原子递减
void __yo_decr_rc_atomic(Iso_T* iso) {
  size_t old_count = atomic_fetch_sub(&iso->ref_count, 1);
  if (old_count == 1) {
    // 最后一个引用，释放内存
    if (iso->dispose_fn) {
      iso->dispose_fn(iso);  // 必要时清理内部值
    }
    __yo_free(iso);
  }
}

// Extract：返回包含内部值的 Option(T)
Option_T __yo_iso_extract_T(Iso_T* iso) {
  // 当前返回 Some(value)
  // 未来：可添加原子 extracted 标志以实现单次提取语义
  return Option_Some_T(iso->value);
}
```

## 示例：线程安全用法

```rust
// 创建隔离字符串
s := String("Hello");
iso := Iso(String)(s);    // s 没有别名，OK

// 可自由复制（原子引用计数）
iso2 := iso;              // 原子 dup

// 安全地发送到其他线程
spawn(() => {
  iso3 := iso2;           // 跨线程原子 dup — 安全！
  msg_opt := __yo_iso_extract(iso3);  // 提取 String
  match(msg_opt,
    .Some(msg) => printf("%s\n", msg),
    .None => printf("No value\n")
  );
});

// 仍可使用原始值（原子引用计数保证安全）
msg2_opt := __yo_iso_extract(iso);
match(msg2_opt,
  .Some(msg2) => printf("%s\n", msg2),
  .None => printf("No value\n")
);
```

````

## 示例：无效的隔离操作

```rust
// ❌ 无法隔离：存在别名
x := box(42);
y := x;                    // y.isOwningTheSameRcValueAs = x
iso := Iso(Box(i32))(x);   // 编译错误：无法隔离 x，y 也持有所有权

// ✅ 修复：不要创建别名
x := box(42);              // x 是唯一所有者
iso := Iso(Box(i32))(x);   // OK

// ✅ 另一种修复方式：先 drop 别名
x := box(42);
y := x;
drop(y);                   // 显式 drop y
iso := Iso(Box(i32))(x);   // 如果编译器能证明 y 已失效，则 OK
````
