# 线程安全

Yo 默认为安全代码（非 pragma 代码）提供**无数据竞争**保证。所有跨线程的可变共享操作都通过 `std/sync/` 中经过审计的同步原语进行。在无同步的情况下跨线程共享状态是编译错误。

## 保证

> 对于任何不使用 `pragma(Pragma.AllowUnsafe)` 编译且仅使用 `std/` 中原语的程序，所有跨线程的可变共享访问都由同步原语中介。该程序在 C11 内存模型下是无数据竞争的。

## Send 与 Sync 特质

与 Rust 一样，两个标记特质回答两个不同的问题：

- **`Send`**：该类型的值可以被**移动**到另一个线程。通道的载荷和被派生的闭包都以这种方式跨线程。
- **`Sync`**：该类型的值的多个副本可以被多个线程同时**读取**。`Arc` 的载荷、原子对象和模块级全局变量都以这种方式共享。

### 自动派生

两者都为结构体、枚举、联合体、元组和数组自动派生：

| 该类型的值                                                    | `Send`                      | `Sync`                      |
| ------------------------------------------------------------- | --------------------------- | --------------------------- |
| 基本类型（`i32`、`bool`、`f64`、`str` 等）                    | 是                          | 是                          |
| 结构体、枚举、联合体、元组或数组                              | 当且仅当每个字段都是 `Send` | 当且仅当每个字段都是 `Sync` |
| 非原子单元（`Rc(T)`、任何 `ref(struct(...))`）                   | 否                          | 否                          |
| 原子对象（`Arc(T)`、`atomic(ref(struct(...)))`）              | 当且仅当每个字段都是 `Sync` | 当且仅当每个字段都是 `Sync` |
| 裸指针 `*(T)`                                                 | 否                          | 否                          |
| `Dyn(Trait)`                                                  | 仅当写成 `Dyn(Trait, Send)` | 仅当写成 `Dyn(Trait, Sync)` |
| 闭包                                                          | 见下文                      | 见下文                      |

```yo
// 所有字段都是 Send 和 Sync → Point 也是
Point :: struct(x : i32, y : i32);

// 非原子单元两者都不是 —— 它的计数不是原子的
MyObj :: ref(struct(data : Vec(i32)));

// 裸指针两者都不是：没有任何东西说明谁拥有被指向的值
Raw :: struct(p : ?*u8);
```

原子对象的所有副本共享同一个载荷，所以只有当该载荷是 `Sync` 时它才是 `Send`。`Mutex(T)` 是一个例外，恰好印证了这条规则：它一次只把 `T` 交给一个线程，所以只要 `T` 是 `Send`，它就是 `Sync`。

标准库类型遵循同样的划分。在线程之间共享载荷的类型要求 `Sync`：`Arc(T)` 和 `RwLock(T)`（并发的读守卫）要求 `T <: (Send, Sync)`。一次只把载荷交给一个线程的类型只要求 `Send`：`Mutex(T)` 和 `Channel(T)` 要求 `T <: Send`。因此，一个是 `Send` 但用 `impl(T, !(Sync()))` 退出 `Sync` 的类型可以放进 `Mutex` 或通过 `Channel` 传递，但不能放进 `Arc`。

`String` 和各集合类型目前还不是 `Send`：它们的缓冲区现在是一个共享的、非原子计数的单元，留在发送线程上的副本会在计数上产生竞争。一旦它们的缓冲区变为唯一所有（`plans/VALUES_BY_DEFAULT.md` V2b），移动一个值就是交出它唯一的所有者，`Channel(String)` 无需修改编译器即可工作。在那之前，`String` 或集合不能跨线程：通过 `Arc` 共享同时满足 `Send` 和 `Sync` 的数据，在接收线程上用 `Send` 的部分重建该值，或将其序列化。`Rc` 对象图只属于它所在的线程（Rust 的规则）；`Rc.try_unwrap` 从唯一持有的 `Rc` 中取出值，该值是 `Send` 时就可以移动。过去覆盖这种情况的一次性隔离移交已在 v0.2.68 中移除（`plans/backlog/MACRO_AND_ISO_REMOVAL.md`）。

### 手动 Send 与 Sync 实现需要 Pragma

编写 `impl(MyType, Send())` 或 `impl(MyType, Sync())` 需要 `pragma(Pragma.AllowUnsafe)` 和解释该类型为何可以安全地跨线程移动或共享的 `// SAFETY:` 注释。持有裸指针的类型就是这样选择加入的（std 的 `Channel`、`Waker`），这也让每个这样的声明都可审计。

## 原子引用语义类型 vs 普通引用语义类型

|                | `ref(struct(...))`     | `atomic(ref(struct(...)))`          |
| -------------- | ---------------------- | ----------------------------------- |
| **引用计数**   | 非原子 RC（线程本地）  | 原子 RC（线程安全）                 |
| **跨线程共享** | 不允许（非 Send）      | 允许（所有字段都是 Sync 时为 Send 和 Sync） |
| **循环回收**   | 是（STW GC）           | 否（纯原子 RC）                     |
| **示例**       | `ArrayList`, `HashMap` | `Arc(T)`, `Mutex(T)`, `Channel(T)`  |

## 安全代码中禁止原子字段修改

在安全代码中，通过 `atomic(ref(struct(...)))` 写入是**编译时错误** —— 字段与索引赋值，以及任何进入它的、其被调用者可能通过该参数写入的 `&mut` 路径（传给 `&mut T` 参数的实参，或接收者为 `self : &mut Self` 的方法）：

```yo
a := arc(i32(0));
a.* = i32(5); // 错误：不能写入原子对象字段
c := arc(Counter(n : i32(0)));
c.*.bump(); // 错误：不能在原子对象 'c' 上调用 &mut self 方法
bump_by_ten(c.*); // 错误：不能传递以原子对象 'c' 为根的 &mut 参数
```

局部副本是值，所以 `k := c.*; k.bump()` 没问题（它修改的是副本）；`Mutex.with_lock` 的 `v : &mut T` 是参数，所以闭包体可以通过 `v` 写入；只读的 `&mut self` 方法 —— `ToString` 的 `${c.*.n}`、`Sender.clone` —— 也没问题，因为编译器依据被调用者的函数体做决定（`plans/reference/PARALLELISM_RULES.md` D3），而不只看参数模式。

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
型的约定一致；只有 `compare_exchange` 的 `expected` 是 `&mut`，因为交换失败时
会把实际观测到的值写回它。每个操作都需要显式的 `MemoryOrder`：

```yo
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

```yo
{ Mutex } :: import("std/sync/mutex");

counter := Mutex(i32).new(i32(0));
counter.with_lock(v => {
  v = (v + i32(1));
});
new_value := counter.with_lock(v => (v + i32(1)));
```

闭包接收 `v : &mut T` — 一个**二级引用**，不能逃逸闭包作用域。

解锁是自动的——私有解锁器对象在正常返回和 `unwind(...)` 时都调用 `_raw_unlock()`，保证结构化解锁配对。**可重入锁定会导致死锁。**

在单个线程上，对应的闭包作用域类型是 `RefCell(T)`（`std/sync/refcell`）：`with` 和 `with_mut` 在运行时检查独占性，冲突时 panic 而不是阻塞。`RefCell` 在 `T` 是 `Send` 时是 `Send`，但永远不是 `Sync`，因此 `Arc(RefCell(T))` 会被拒绝：跨线程请使用 `Arc(Mutex(T))`。

## 模块级全局变量

模块级运行期绑定（在任何函数之外的 `name := init` 或 `(name : T) = init`）是一个被所有线程共享的静态变量。它是不可变的（Rust 的 `static`），除非它的名字被包在 `mut(...)` 里（`mut(name) := init`、`(mut(name) : T) = init`，在 `thread_local(...)` 里同样可用），这使它成为 Rust 的 `static mut`。写入不可变的全局变量是 E0917；把 `mut(...)` 全局变量或它下面的位置借给调用是 E0916（先把它读到局部变量里）。详见[错误参考](ERROR_DIAGNOSTICS.md)。在安全代码中：

- 在另一个线程上运行的闭包（`Thread.spawn` 的闭包体、线程池任务、`spawn_blocking` 回调 —— 任何绑定到 `Impl(FnOnce(...), Send)`、`Impl(Fn(...), Send)` 或 `Impl(Fn(...), Sync)` 的闭包）不能直接或经由它调用的任何函数触及类型不是 `Sync` 的全局变量。全局变量被所有线程共享，所以问题在于共享。非原子引用计数的全局变量（`ArrayList`、`String`、任何 `ref(struct)`）对主线程仍然合法，但通过这样的句柄读取字段会更新引用计数，所以其他线程不能碰它；
- 在任何地方被**写入**的 `Sync` 值类型全局变量（标量或内部不含引用的结构体）—— 被赋值、以它为根做字段或索引写入、或交给被调用者会通过其写入的 `&mut` 参数 —— 是可变静态变量，在另一个线程上运行的闭包不能触及它。只在一个线程上读写时，它是普通的全局变量；被所有线程读取但从不写入时，它是共享常量。错误报在编译器第二个看到的那个位置上，并指出另一个位置。

```yo
LIMIT :: i32(5); // 常量：任何线程都可读
hits := AtomicI32(i32(0)); // 原子对象：共享状态，可以
(thread_local(mut(scratch)) : i32) = i32(0); // 每线程可变状态：可以
g := ArrayList(i32).new(); // 只在主线程上可用
fill :: (fn() -> unit)({
  g.push(i32(1));
});
Thread(unit).spawn(io => {
  fill();
}); // 错误：闭包调用了触及 g 的 fill
(mut(counter) : i32) = i32(0);
bump :: (fn() -> unit)({
  counter = (counter + i32(1));
}); // 单独来看没问题……
Thread(i32).spawn(io => counter); // 错误：……但另一个线程读取了 counter
```

## 跨线程的函数与闭包

一个函数值是 `Send` 的，当且仅当**它捕获的状态**是 `Send` 的，并且**它的代码触及的东西**符合上面的全局变量规则；当它捕获的状态是 `Sync` 且代码符合同样的规则时，它是 `Sync` 的。**借用**其捕获的闭包（传给借用参数的字面量，其捕获留在调用者的栈帧中）永远不是 `Send`。函数类型本身回答不了这个问题：同一签名的两个函数共享同一个类型，而一个什么都不捕获的闭包照样会运行代码。所以编译器在能看到值的地方判断这个值：

- **派生与任务闭包体**：直接写进 `Send` 位置的闭包字面量（`Thread.spawn` 的闭包体、线程池任务、`spawn_blocking` 回调）在书写处检查。
- **传入的函数值**：传给 `Impl(Fn(...), Send)` 参数的具名函数或闭包在调用处判断。
- **泛型约束**：绑定到 `where(T <: Send)` 或 `where(T <: Sync)` 参数的函数同样判断：`arc(f)`（两者都判断）、`Channel(type_of(f))`、泛型的 `g(f)`。
- **被捕获的函数**：被另一个线程的闭包捕获的闭包，按被捕获的值判断。
- **`Sync` 位置**：`Impl(Fn(...), Sync)` 参数对 `Sync` 做同样的检查：捕获了 `Rc` 的闭包不是 `Sync`，代码触及非 `Sync` 全局变量的闭包也不是。

编译器看不到值的裸 `fn(...)` 类型**不是 `Send`**：结构体字段、集合元素、`Channel(fn() -> unit)` 的载荷，以及被另一个线程的闭包捕获的普通局部变量 `f := count`，都属于这种情况。承载这一承诺的函数类型是 `Impl(Fn(...), Send)`，应写成 `(f : Impl(Fn(Io) -> unit, Send)) = count`。一个值只在被转换成它的地方检查一次（参数、返回值、带类型声明的绑定）。

```yo
g := ArrayList(i32).new(); // 只在主线程上可用
hits := AtomicI32(i32(0));
fill :: (fn(io : Io) -> unit)({
  g.push(i32(1));
});
count :: (fn(io : Io) -> unit)({
  hits.fetch_add(i32(1), MemoryOrder.AcqRel);
  ();
});
Thread(unit).spawn(count); // 可以：count 只触及原子对象
Thread(unit).spawn(fill); // 错误：fill 的代码触及 g
(k : Impl(Fn() -> unit)) = (
  () => {
    g.push(i32(2));
  }
);
a := arc(k); // 错误：k 的代码触及 g
Holder :: struct(f : (fn(io : Io) -> unit));
h := Holder(f : count);
Thread(unit).spawn((io : Io) => {
  (h.f)(io);
}); // 错误：Holder 有一个裸 fn 字段
```

## 负向实现 — 选择退出 Send 与 Sync

可以通过 `!(Send)` / `!(Sync)` 明确退出自动派生的 `Send` 或 `Sync`：

```yo
impl(MyHandle, !Send()); // MyHandle 不是 Send
impl(MyHandle, !Sync()); // 也不是 Sync
```

标准库中用于：**`JoinHandle(T)`**（异步任务句柄）和 **`Io`**（异步运行时），两者都声明了 `!(Send())` 和 `!(Sync())`。负向实现不需要 `pragma`。

## 字段可见性 — `_` 前缀约定

名称以 `_` 开头的字段仅对定义类型的**文件和目录**私有。用户代码无法访问 `mutex._value` 或 `mutex._handle`。同一目录内的访问是被允许的。

## 信任边界

| 层次                         | 信任内容                       | 强制执行                            |
| ---------------------------- | ------------------------------ | ----------------------------------- |
| **用户代码**（无 pragma）    | 无                             | 所有跨线程共享通过 `std/sync/` 原语；手动 Send 与 Sync 实现被拒绝；原子对象写入被拒绝（字段与索引赋值、`&mut` 参数、`&mut self` 接收者）；跨线程的函数值按其捕获与其代码触及的东西判断（D4、D9），裸 `fn` 字段或载荷不是 Send |
| **`std/sync/`**（有 pragma） | 原语正确实现合约               | 手动 Send 与 Sync 需要 `// SAFETY:` 注释；持有裸指针的原子对象以此选择加入 |
| **代码生成运行时**           | 原子 RC 操作使用正确的内存顺序 | C11 原子操作                        |
| **`extern("c", ...)`**       | C 函数可重入安全               | 不在范围内                          |

## 尚未覆盖的内容

- **死锁预防**：与 Rust 相同，锁的顺序由使用者负责。
- **`AtomicPtr(T)`**：用于无锁数据结构的泛型原子指针，暂缓。安全代码不能构造或解引用裸指针，这个原语只有带 pragma 的代码才能用；等 `std/` 中出现具体的使用者时再加入。
- **`Sender(T)` / `Receiver(T)` 拆分**：目前 `Channel(T)` 在同一个句柄上同时暴露发送端和接收端，Rust 式的拆分是之后的易用性改进。
- **TSan 覆盖线程语料，而不是所有程序**：Linux/Clang 的 CI 作业（必需的状态检查）在 `--sanitize thread` 下运行 `tests/sync`，并通过 `scripts/tsan-thread-corpus.sh` 运行线程语料：`tests/thread*.test.yo`、`arc`、`atomic_object`、`send_sync`、`cross_thread_wake`、`spawn_blocking`、`parallelism_soundness`、`encoding/html`、`unsafe_cast_rc_borrow`。每个文件至少要派生一个线程（一个线程都不派生的文件报告为 HOLLOW）。一个双向棘轮（`scripts/bootstrap/tsan-known-failing.tsv`）在未列出的文件报告竞争、或已列出的文件不再报告竞争时让作业失败。编译期规则由 `tests/thread_safety.test.yo` 和 `tests/parallelism_soundness.test.yo` 固定，后者为每条规则各带一个拒绝用例和一个过度拒绝的金丝雀用例。

## 已知缺口

目前没有已知缺口。2026-09-25 的并行性可靠性审计测得上述保证有十一处被违反，已全部关闭（`plans/archive/PARALLELISM_SOUNDNESS.md`）；收尾时发现的函数值途径也已由规则 D9 关闭。之后发现的违反会记录在 `issues/` 下，并在修复之前列在这里。

## 参见

- `plans/archive/THREAD_SAFETY.md` — 完整设计文档
- `docs/en-US/PARALLELISM.md` — Thread / ThreadPool / Channel API
- `plans/reference/PARALLELISM_RULES.md` — 编译器强制执行的规则（D1–D9）
- `plans/archive/PARALLELISM_SOUNDNESS.md` — 2026-09-25 的审计及其修复计划（已关闭）
