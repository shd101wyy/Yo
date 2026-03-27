# Arc(T) — 原子引用计数共享所有权

Arc(T) 是一个编译器内置类型，用于实现基于**原子引用计数**的**共享所有权**。与 `Iso(T)`（独占所有权）不同，多个 `Arc(T)` 值可以指向同一份数据。Arc 是 **Send 安全**的，支持跨线程数据共享。

## 使用方法

### 创建 Arc

```rust
// 使用 arc() 辅助函数
a := arc(i32(42));

// 直接使用类型构造器
a := Arc(i32)(i32(42));
```

### 解引用

通过 `.(*)` 访问内部值，返回一个**借用**引用：

```rust
a := arc(i32(42));
val := a.(*);       // val : i32 = 42
```

对于 object 类型，方法调用通过 `.(*)` 进行委托：

```rust
Counter :: object(count : i32);
impl(Counter,
  get_count : ((fn(self : Self) -> i32) self.count)
);

c := arc(Counter(i32(10)));
c.(*).get_count()    // 返回 10
```

### 共享（复制语义）

将一个 Arc 赋值给另一个变量会使引用计数递增：

```rust
a := arc(i32(42));
b := a;              // 引用计数: 1 → 2
c := b;              // 引用计数: 2 → 3
// 三者共享同一份底层数据
assert(a.(*) == b.(*));
```

### 跨线程共享

Arc 实现了 `Send`，因此可以在线程/工作线程闭包中被捕获：

```rust
{ Thread } :: import "std/thread";
{ Channel } :: import "std/sync/channel";

// 跨线程共享 channel
ch := arc(Channel(i32).new(usize(10)));

producer := Thread.spawn(() => {
  ch.(*).send(i32(42));
});

val := ch.(*).recv().unwrap();
producer.join();
```

## 与 Iso(T) 的对比

| 特性     | `Arc(T)`                 | `Iso(T)`               |
| -------- | ------------------------ | ---------------------- |
| 所有权   | 共享（多个引用）         | 独占（单一所有者）     |
| 引用计数 | 原子（`_Atomic`）        | 原子（`_Atomic`）      |
| 复制行为 | 递增引用计数             | 提取（移动）值         |
| 可变性   | 通过 `.(*)` 只读（借用） | 通过 `.(^)` 完全所有权 |
| Send     | 是（始终）               | 是（始终）             |
| 使用场景 | 跨线程共享读取           | 跨线程所有权转移       |

## 实现细节

- **C 表示**：`struct { __yo_ref_header_t header; T value; }` — 分配在堆上的指针类型。
- **引用计数操作**：使用 `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`（原子递增/递减）。
- **释放**：当引用计数降为 0 时，先调用内部值的 `___drop`（如果有的话），然后释放 Arc 的内存分配。
- **闭包捕获**：在闭包中捕获时，Arc 指针会被**复制**（引用计数递增）。闭包和外部作用域各自持有独立的引用。
