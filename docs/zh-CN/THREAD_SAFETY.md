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

在安全代码中，通过 `atomic(ref(struct(...)))` 写入是**编译时错误** —— 字段与索引赋值，以及任何进入它的、其被调用者可能通过该参数写入的 `inout` 路径（`inout` 参数，或 `self` 为 `inout(self)` 的方法）：

```rust
a := arc(i32(0));
a.* = i32(5);          // 错误：不能写入原子对象字段
c := arc(Counter(n : i32(0)));
c.*.bump();            // 错误：不能在原子对象 'c' 上调用 inout(self) 方法
bump_by_ten(c.*);      // 错误：不能传递以原子对象 'c' 为根的 inout 参数
```

局部副本是值，所以 `k := c.*; k.bump()` 没问题（它修改的是副本）；`Mutex.with_lock` 的 `inout(v)` 是参数，所以闭包体可以通过 `v` 写入；只读的 `inout(self)` 方法 —— `ToString` 的 `${c.*.n}`、`Sender.clone` —— 也没问题，因为编译器依据被调用者的函数体做决定（`plans/reference/PARALLELISM_RULES.md` D3），而不只看参数模式。

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
bits.fetch_or(u32(4), MemoryOrder.AcqRel); // 置位
bits.fetch_and(u32(4294967291), MemoryOrder.AcqRel); // 清位
bits.fetch_xor(u32(1), MemoryOrder.AcqRel); // 翻转
high_water := AtomicUsize(usize(0));
high_water.fetch_max(usize(512), MemoryOrder.AcqRel);
```

`MemoryOrder` 枚举值：`Relaxed`、`Acquire`、`Release`、`AcqRel`、`SeqCst`。

没有 `Consume`。C11 有这个顺序，但所有生产编译器都会把它提升为 `Acquire`，
因此这个名字承诺的屏障比任何目标实际生成的都更弱；Rust 出于同样的原因也
省略了它。请使用 `Acquire`。

操作无法合法采用的顺序——load 上的 `Release`、store 上的 `Acquire`、两者上的
`AcqRel`——会 panic，而不是被静默重新解释。

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

`std/sync` 中的每把锁都记录持有者，因此误用在每个平台上都是带有 API 名称的 **panic**，而不是操作系统原语的未定义行为：持有线程再次加锁、其他线程解锁、未持有 `m` 时调用 `Cond.wait_with(m)`、以及 `Once` 初始化器重入自己的 `Once`，都会触发陷阱（`plans/reference/PARALLELISM_RULES.md` 规则 D5）。`try_with_lock` 对持有者在 Windows 上也返回 `.None`（底层 `CRITICAL_SECTION` 本会递归进入）。

`Mutex(T)` 将受保护的数据包装在锁内部。通过闭包进行访问：

```rust
{ Mutex } :: import("std/sync/mutex");

counter := Mutex(i32).new(i32(0));
counter.with_lock(v => {
  v = (v + i32(1));
});
new_value := counter.with_lock(v => (v + i32(1)));
```

闭包接收 `inout(v) : T` — 一个**二级引用**，不能逃逸闭包作用域。

解锁是自动的——私有解锁器对象在正常返回和 `unwind(...)` 时都调用 `_raw_unlock()`，保证结构化解锁配对。**可重入锁定会导致死锁。**

## 模块级全局变量

模块级运行期绑定（在任何函数之外的 `name := init` 或 `(name : T) = init`）是一个被所有线程共享的静态变量。在安全代码中：

- 在另一个线程上运行的闭包（`Thread.spawn` 的闭包体、线程池任务、`spawn_blocking` 回调 —— 任何绑定到 `Impl(Fn(...), Send)` 的闭包）不能直接或经由它调用的任何函数触及类型不是 `Send` 的全局变量。非原子引用计数的全局变量（`ArrayList`、`String`、任何 `ref(struct)`）对主线程仍然合法，但通过这样的句柄读取字段会更新引用计数，所以其他线程不能碰它；
- 在任何地方被**写入**的 `Send` 值类型全局变量（标量或内部不含引用的结构体）—— 被赋值、以它为根做字段或索引写入、或交给被调用者会通过其写入的 `inout` 参数 —— 是可变静态变量，在另一个线程上运行的闭包不能触及它。只在一个线程上读写时，它是普通的全局变量；被所有线程读取但从不写入时，它是共享常量。错误报在编译器第二个看到的那个位置上，并指出另一个位置。

```rust
LIMIT :: i32(5);                              // 常量：任何线程都可读
hits := AtomicI32(i32(0));                    // 原子对象：共享状态，可以
(thread_local(scratch) : i32) = i32(0);       // 每线程可变状态：可以
g := ArrayList(i32).new();                    // 只在主线程上可用
fill :: (fn() -> unit)({ g.push(i32(1)); });
Thread(unit).spawn(io => { fill(); });        // 错误：闭包调用了触及 g 的 fill
(counter : i32) = i32(0);
bump :: (fn() -> unit)({ counter = (counter + i32(1)); });   // 单独来看没问题……
Thread(i32).spawn(io => counter);             // 错误：……但另一个线程读取了 counter
```

## 负向实现 — 选择退出 Send

可以通过 `!(Send)` 明确退出自动派生的 `Send`：

```rust
impl(MyHandle, !Send()); // MyHandle 不是 Send
```

标准库中用于：**`JoinHandle(T)`**（异步任务句柄）和 **`Io`**（异步运行时）。负向实现不需要 `pragma`。

## Iso(T) — 唯一所有权转移

`Iso(T)` 包装一个**非** `Send` 的值，一次性地转移给另一个线程：`T` 可以是普通的 `ref(struct)` 对象图，而 `Iso(T)` 本身是 `Send`，不要求 `T <: Send`。依据是唯一性 —— 在使用的那一刻，最多只有一个线程持有内部值。

```rust
data := box(MyData(...));
match(
  ^data,                        // '^' 构造 Iso；`data` 不唯一时为 .None
  .Some(iso) => Thread(unit).spawn(io => {
    inner := iso.extract();     // 返回 T；第二次 extract 会 panic
    // ... 只在本线程使用 inner ...
  }),
  .None => ()
);
```

**实际强制的内容**（`plans/reference/PARALLELISM_RULES.md` D2）。`^v` 是安全代码中唯一的构造方式（原始的 `Iso(T)(v)` 需要 pragma）。它在编译期检查 `v` 拥有它的值、没有其他别名、不能形成引用环，并在运行期遍历值的整张对象图：从它可达的每个非原子对象的引用计数都必须恰好为 1，否则 `^v` 返回 `.None` —— 内部有别名的值（`Wrap(items : shared)`）会被拒绝，而不是被移走。值内部的原子对象按设计就是共享的，遍历在此停止。`T` 必须是非原子的引用对象（`Iso(i32)` 是编译错误）。`extract()` 的原子一次性标志保证值只被交出一次。详见 `docs/zh-CN/ISOLATED.md`。

- `Iso(Arc(T))`、`Iso(<原子对象>)` 和 `Iso(Iso(T))` 在编译时被拒绝 —— 冗余（直接发送该值）
- `Arc(Iso(T))` 在编译时被拒绝 —— 矛盾（Arc 共享，Iso 唯一）

## 字段可见性 — `_` 前缀约定

名称以 `_` 开头的字段仅对定义类型的**文件和目录**私有。用户代码无法访问 `mutex._value` 或 `mutex._handle`。同一目录内的访问是被允许的。

## 信任边界

| 层次                         | 信任内容                       | 强制执行                            |
| ---------------------------- | ------------------------------ | ----------------------------------- |
| **用户代码**（无 pragma）    | 无                             | 所有跨线程共享通过 `std/sync/` 原语；原子对象写入被拒绝（字段与索引赋值、`inout` 参数、`inout(self)` 接收者） |
| **`std/sync/`**（有 pragma） | 原语正确实现合约               | 手动 Send 需要 `// SAFETY:` 注释    |
| **代码生成运行时**           | 原子 RC 操作使用正确的内存顺序 | C11 原子操作                        |
| **`extern("c", ...)`**       | C 函数可重入安全               | 不在范围内                          |

## 已知缺口（2026-09-25 审计）

本页开头的保证是合约；并行性可靠性审计（`plans/PARALLELISM_SOUNDNESS.md`）在当前编译器上测得以下违反，每一项都由该文档中命名的阶段关闭。在某一条被删除之前，安全代码**能够**写出它描述的数据竞争。

- **闭包类型满足 `where(T <: Send)`** 而不看其捕获，因此带有非 Send 捕获的 `arc(f)` 和 `Channel(typeof(f))` 能通过 `yo check`（今天是 C 编译器碰巧拒绝了程序）（`issues/a-capturing-closure-type-satisfies-a-send-bound-so-arc-and-channel-accept-it-at-check.md`）。
- **被派生的闭包可以通过它调用的闭包值**（捕获的辅助闭包、闭包参数）**或 `dyn` 方法触及非 Send 的模块级全局变量**：全局可达性检查只跟随编译期能解析到函数体的调用（`issues/d1-reach-walk-does-not-follow-closure-values-or-dyn-calls.md`）。

## 参见

- `plans/archive/THREAD_SAFETY.md` — 完整设计文档
- `docs/en-US/PARALLELISM.md` — Thread / ThreadPool / Channel API
- `plans/reference/PARALLELISM_RULES.md` — 编译器强制或正在落实的规则（D1–D8）
- `plans/PARALLELISM_SOUNDNESS.md` — 2026-09-25 的审计及其修复计划
- `docs/zh-CN/ISOLATED.md` — Iso(T) 设计细节
