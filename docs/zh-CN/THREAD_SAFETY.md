# 线程安全

Yo 默认为安全代码（非 pragma 代码）提供**无数据竞争**保证。所有跨线程的可变共享操作都通过 `std/sync/` 中经过审计的同步原语进行。在无同步的情况下跨线程共享状态是编译错误。

## 保证

> 对于任何不使用 `pragma(Pragma.AllowUnsafe)` 编译且仅使用 `std/` 中原语的程序，所有跨线程的可变共享访问都由同步原语中介。该程序在 C11 内存模型下是无数据竞争的。

## Send 特质

`Send` 是一个标记特质，表示"可以安全地在线程间传输"。如果一个类型可以将其值移动到另一个线程，则该类型实现了 `Send`。

### 自动派生

`Send` 为结构体、枚举、联合体和元组自动派生：如果**所有**字段都是 `Send`，则复合类型也是 `Send`。

```rust
// 所有字段都是 Send → Point 是 Send
Point :: struct(x : i32, y : i32);

// 普通 ref(struct(...)) 不是 Send — 它使用非原子引用计数
MyObj :: ref(struct(data : Vec(i32)));
```

### 手动 Send 实现需要 Pragma

编写 `impl(MyType, Send())` 需要 `pragma(Pragma.AllowUnsafe)` 和解释该类型为何可以安全跨线程发送的 `// SAFETY:` 注释。这确保每个手动 Send 声明都是可审计的。

## 原子引用语义类型 vs 普通引用语义类型

|                | `ref(struct(...))`     | `atomic(ref(struct(...)))`          |
| -------------- | ---------------------- | ----------------------------------- |
| **引用计数**   | 非原子 RC（线程本地）  | 原子 RC（线程安全）                 |
| **跨线程共享** | 不允许（非 Send）      | 允许（所有字段都是 Send 时为 Send） |
| **循环回收**   | 是（STW GC）           | 否（纯原子 RC）                     |
| **示例**       | `ArrayList`, `HashMap` | `Arc(T)`, `Mutex(T)`, `Channel(T)`  |

## 安全代码中禁止原子字段修改

在安全代码中直接写入 `atomic(ref(struct(...)))` 的字段是**编译时错误**：

```rust
a := arc(i32(0));
a.* = i32(5);  // 错误：不能写入原子对象字段
```

要修改共享状态，请组合正确的原语：

| 想要...           | 使用                                                  |
| ----------------- | ----------------------------------------------------- |
| 共享原子计数器    | `Arc(AtomicI32)` → `counter.fetch_add(i32(1), ...)`   |
| 共享锁定可变数据  | `Arc(Mutex(T))` → `arc.with_lock((v) => { ... })`     |
| 共享多读/单写数据 | `Arc(RwLock(T))` → `arc.with_read` / `arc.with_write` |
| 共享不可变配置    | `Arc(T)`（构造后只读）                                |

Pragma 代码（带有 `pragma(Pragma.AllowUnsafe)` 的文件）绕过此规则——这就是 `std/sync/` 原语在获取锁后修改其内部状态的方式。

## 原子包装器和 MemoryOrder

`std/sync/atomic.yo` 提供基于 C11 `<stdatomic.h>` 的高级原子包装器：

| 类型                                                 | C 底层类型                                                         | 用途                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| `AtomicBool`                                         | `atomic_bool`                                                      | 布尔标志（closed、done、ready） |
| `AtomicI8` / `AtomicI16` / `AtomicI32` / `AtomicI64` | `atomic_schar` / `atomic_short` / `atomic_int` / `atomic_llong`    | 有符号整数计数器                |
| `AtomicU8` / `AtomicU16` / `AtomicU32` / `AtomicU64` | `atomic_uchar` / `atomic_ushort` / `atomic_uint` / `atomic_ullong` | 无符号整数计数器                |
| `AtomicUsize`                                        | `atomic_size_t`                                                    | 集合大小、索引                  |
| `AtomicIsize`                                        | `atomic_ptrdiff_t`                                                 | 有符号索引、偏移量              |

每个包装器提供 `load`、`store`、`swap` 和 `compare_exchange`。每个**整数**包装
器还提供完整的读-改-写族——`fetch_add`、`fetch_sub`、`fetch_and`、`fetch_or`、
`fetch_xor`、`fetch_min`、`fetch_max`——它们都返回操作**之前**的值，并在溢出时
回绕，与 C11 `atomic_fetch_*` 完全一致。`AtomicBool` 不提供这些方法：它不是整
数原子类型。

所有方法的接收者都是 `self : Self`，与 `std/sync` 中其他 `atomic(ref(...))` 类
型的约定一致；只有 `compare_exchange` 的 `expected` 是 `inout`，因为交换失败时
会把实际观测到的值写回它。每个操作都需要显式的 `MemoryOrder`：

```rust
{ AtomicBool, AtomicI32, AtomicU32, AtomicUsize, MemoryOrder } :: import("std/sync/atomic");

flag := AtomicBool(false);
flag.store(true, MemoryOrder.Release);
if(flag.load(MemoryOrder.Acquire), {
  println("flag is set!");
});

counter := AtomicI32(i32(0));
counter.fetch_add(i32(1), MemoryOrder.Relaxed);
println(`count = ${counter.load(MemoryOrder.Acquire)}`);

// 完整的读-改-写族，适用于每一种整数原子类型：
bits := AtomicU32(u32(0));
bits.fetch_or(u32(4), MemoryOrder.AcqRel);   // 置位
bits.fetch_and(u32(4294967291), MemoryOrder.AcqRel); // 清位
bits.fetch_xor(u32(1), MemoryOrder.AcqRel);  // 翻转

high_water := AtomicUsize(usize(0));
high_water.fetch_max(usize(512), MemoryOrder.AcqRel);
```

`MemoryOrder` 枚举值：`Relaxed`、`Consume`、`Acquire`、`Release`、`AcqRel`、`SeqCst`。

每个操作需要**显式**内存顺序——没有默认的 `SeqCst` 以避免意外的性能成本。

模块还导出 `fence(order)`，它下降为 C11 `atomic_thread_fence`。原子操作自身的
内存顺序只约束围绕**该对象**的访问，而屏障约束调用线程之前和之后的所有内存访
问——这正是让一个线程上的 `Relaxed` 存储与另一个线程上的 `Relaxed` 加载配对的
机制。

`AtomicI32` 的 `fetch_add`/`sub`/`and`/`or`/`xor` 直接下降为 C11 的
`atomic_fetch_*_explicit` 泛型宏——它是 `std/libc/stdatomic.yo` 唯一为其绑定这
些宏的原子类型，因为 `c_include` 绑定以 C 符号名为键，每个宏只能有一个 Yo 绑
定。其余类型，以及所有类型的 `fetch_min`/`fetch_max`（C11 根本没有原子
min/max），都在该类型的 `__yo_atomic_compare_exchange_*` 原语之上运行强
compare-exchange 循环。该循环是无锁的，产生相同的返回值和相同的回绕语义，只是
在竞争下会多一次重试。

## Mutex(T) — 闭包作用域锁定

`Mutex(T)` 将受保护的数据包装在锁内部。通过闭包进行访问：

```rust
{ Mutex } :: import("std/sync/mutex");

counter := Mutex(i32).new(i32(0));
counter.with_lock((v) => { v = (v + i32(1)); });
new_value := counter.with_lock((v) => (v + i32(1)));
```

闭包接收 `inout(v) : T` — 一个**二级引用**，不能逃逸闭包作用域。

解锁是自动的——私有解锁器对象在正常返回和 `unwind(...)` 时都调用 `_raw_unlock()`，保证结构化解锁配对。**可重入锁定会导致死锁。**

## 负向实现 — 选择退出 Send

可以通过 `!(Send)` 明确退出自动派生的 `Send`：

```rust
impl(MyHandle, !(Send()));   // MyHandle 不是 Send
```

标准库中用于：**`JoinHandle(T)`**（异步任务句柄）和 **`Io`**（异步运行时）。负向实现不需要 `pragma`。

## Iso(T) — 唯一所有权转移

`Iso(T)` 包装一个值用于跨线程的唯一、一次性转移。`extract()` 通过运行时 `rc == 1` 检查保证最多只有一个线程观察内部值。

```rust
data := Box(MyData).new(...);
iso := ^(data);
Thread.spawn((io) => {
  inner := iso.extract();  // rc != 1 或已提取时 panic
});
```

`Iso(T)` 无条件实现 Send — 不要求 `T <: Send`。`Iso(Arc(T))` 和 `Arc(Iso(T))` 在编译时被拒绝。

## 字段可见性 — `_` 前缀约定

名称以 `_` 开头的字段仅对定义类型的**文件和目录**私有。用户代码无法访问 `mutex._value` 或 `mutex._handle`。同一目录内的访问是被允许的。

## 信任边界

| 层次                         | 信任内容                       | 强制执行                            |
| ---------------------------- | ------------------------------ | ----------------------------------- |
| **用户代码**（无 pragma）    | 无                             | 所有跨线程共享通过 `std/sync/` 原语 |
| **`std/sync/`**（有 pragma） | 原语正确实现合约               | 手动 Send 需要 `// SAFETY:` 注释    |
| **代码生成运行时**           | 原子 RC 操作使用正确的内存顺序 | C11 原子操作                        |
| **`extern("c", ...)`**       | C 函数可重入安全               | 不在范围内                          |

## 参见

- `plans/THREAD_SAFETY.md` — 完整设计文档
- `docs/en-US/PARALLELISM.md` — Thread / ThreadPool / Channel API
- `docs/en-US/ISOLATED.md` — Iso(T) 设计细节
