# Arc(T) — 基于原子引用计数的共享所有权

`Arc(T)` 用于通过原子引用计数共享单个值的所有权。它**不再是编译器内置类型**。
在当前设计里，`Arc` 在 `std/prelude.yo` 中被定义为一个薄包装的
`atomic(ref(struct(...)))`，因此 `Arc` 与 `arc(...)` 会通过 prelude 自动可用。
`Arc(T)` 本身要求 `T <: Send`，这样就不会把非线程安全的值伪装成可跨线程共享的包装。

## 当前定义

```rust
Arc :: (fn(comptime(V) : Type, where(V <: Send)) -> comptime(Type))
  atomic(ref(struct(
    (*) : V
  )))
;

arc :: (fn(generic(V : Type), own(value) : V, where(V <: Send)) -> Arc(V))
  Arc(V)(value)
;
```

## 什么时候使用 `Arc`

- 当你想在**线程或闭包之间共享一个现有值**时，使用 `Arc(T)`。
- 当你要定义**自己的共享类型**时，使用 `atomic(ref(struct(...)))`。
- 当你想要**转移**而不是共享所有权时，使用 `Iso(T)`。
- `Arc(T)` 只接受实现了 `Send` 的子类型；普通 `ref(struct(...))` 并不满足这个条件。

许多标准库类型已经不再需要额外的 `Arc(...)` 包装。例如 `std/sync`
原语和 `std/imm` 集合本身就基于 `atomic(ref(struct(...)))` 实现，可以直接跨线程共享。

如果你需要共享可变状态，应该先把这份状态定义成 `atomic(ref(struct(...)))`，
然后直接共享它；只有在你确实需要“包裹一个单独值”时，再使用 `Arc(...)`。

## 基本用法

### 创建 Arc

```rust
value := arc(i32(42));
same := Arc(i32)(i32(42));
```

### 解引用

通过 `.(*)` 访问内部值，它返回借用访问：

```rust
value := arc(i32(42));
copied := value.(*);
assert((copied == i32(42)), "inner value is 42");
```

### 复制

复制 `Arc` 会递增引用计数，并继续共享同一份底层值：

```rust
a := arc(i32(42));
b := a;
c := b;

assert((a.(*) == b.(*)), "same shared value");
assert((b.(*) == c.(*)), "same shared value");
```

### 跨线程共享

```rust
{ Thread } :: import "std/thread";

shared := arc(i32(42));

t := Thread.spawn((io) => {
  assert((shared.(*) == i32(42)), "thread sees shared value");
});

t.join();
assert((shared.(*) == i32(42)), "main still sees shared value");
```

## `Arc`、`atomic(ref(struct(...)))` 与 `Iso` 的区别

| 需求                            | 推荐工具                   |
| ------------------------------- | -------------------------- |
| 共享一个现有值                  | `Arc(T)`                   |
| 定义可复用的共享引用计数类型    | `atomic(ref(struct(...)))` |
| 在线程/作用域之间转移唯一所有权 | `Iso(T)`                   |

## 语义

- **原子引用计数**：`Arc` 使用原子递增/递减操作。
- **共享所有权**：复制 `Arc` 不会复制底层分配，只会共享它。
- **借用解引用**：`.(*)` 提供对内部值的借用访问。
- **销毁行为**：最后一个引用被释放时，会先 drop 内部值，再释放分配。
- **闭包捕获**：闭包捕获 `Arc` 时会复制这份共享引用。

## 相关文档

- `docs/zh-CN/PARALLELISM.md` —— 线程与线程池模型
- `docs/zh-CN/ISOLATED.md` —— `Iso(T)` 的唯一所有权
- `docs/zh-CN/IMMUTABLE_COLLECTIONS.md` —— 基于 `atomic(ref(struct(...)))` 的持久化集合
