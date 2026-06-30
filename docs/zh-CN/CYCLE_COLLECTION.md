# 循环引用回收

Yo 使用**非原子引用计数**结合**线程局部循环回收**来回收循环引用结构。循环回收器采用 **QuickJS 的试验性删除算法**，比 [Nim 的 ORC 着色方案](https://nim-works.github.io/nimskull/gc.html)更为简单，同时性能相当。该实现针对 Yo 的**隔离 spawn 模型**进行了适配——每个线程完全隔离，不共享内存。

## 为什么需要循环回收？

引用计数无法回收循环引用：

```rust
// 创建循环引用
node_a := ref(struct(value: 1, next: .None));
node_b := ref(struct(value: 2, next: .Some(node_a)));
node_a.next = .Some(node_b);  // 产生循环：A → B → A

// 释放外部引用
node_a = .None;  // A 的 RC：2 → 1（B 仍持有引用）
node_b = .None;  // B 的 RC：2 → 1（A 仍持有引用）

// 内存泄漏！两个对象的 RC 都是 1，但已不可达
```

## 受 QuickJS 启发的算法

QuickJS 使用**试验性删除**方法，与非原子引用计数完美配合。这比 [Nim 的 ORC 着色算法](https://nim-works.github.io/nimskull/gc.html)（使用黑/灰/白标记）更简单，但在更低的复杂度下实现了类似的 O(N) 性能。

### 阶段 1：标记潜在垃圾

1. **识别候选对象**：RC > 0 但可能处于循环中的对象
2. **试验性删除**：临时递减候选对象可达的所有对象的 RC
3. **检查存活性**：如果试验性删除后 RC 降为 0，该对象即为垃圾

### 阶段 2：清扫

1. **恢复存活对象**：对仍从根可达的对象恢复 RC
2. **回收垃圾**：释放 RC 仍为 0 的对象

### 核心思路

该方法适用于非原子 RC，因为：

- 在回收期间，只有拥有线程会访问这些对象
- 回收期间不存在并发修改（线程局部或全局暂停）
- 简单的递增/递减操作，无需原子操作

## Yo 的循环回收器设计

### 线程局部回收

每个线程拥有自己的循环回收器，完全隔离。由于 Yo 采用**隔离 spawn 模型**（线程之间不共享内存），因此不需要全局暂停（stop-the-world）。

```c
// 每线程 GC 状态
typedef struct __yo_thread_gc_state_t {
  __yo_ref_header_t* tracked_objects;  // 可能存在循环的对象的双向链表
  size_t tracked_count;              // 被跟踪的对象数量
  __YO_THREAD_TYPE thread_id;          // 所属线程
  size_t alloc_count;                // 上次 GC 以来的分配次数
  struct __yo_thread_gc_state_t* next; // 用于全局线程列表（仅清理用途）
  struct __yo_thread_gc_state_t* prev;
} __yo_thread_gc_state_t;

static _Thread_local __yo_thread_gc_state_t* __yo_current_thread_gc;
```

### 何时回收：自适应对象数量阈值

Yo 使用**自适应的被跟踪对象数量阈值**来触发循环回收：

1. **初始阈值**：256 个对象
2. **触发条件**：当 `tracked_count >= threshold` 时运行循环回收
3. **自适应调整**：每次回收后，`threshold = max(256, 2 × 剩余对象数)`

这种方法与 QuickJS 类似，在多个方面取得了平衡：

- **可预测**：基于对象数量而非内存大小进行回收
- **高效**：对象少时避免频繁回收
- **自适应**：为拥有大量长生命周期循环对象的程序提升阈值
- **简单**：无需跟踪每个对象的大小

**行为示例：**

```
初始状态：threshold = 256
创建 256 个对象后 → GC 运行，10 个存活 → threshold = max(256, 20) = 256
再创建 256 个对象后 → GC 运行，200 个存活 → threshold = max(256, 400) = 400
再创建 400 个对象后 → GC 运行，300 个存活 → threshold = max(256, 600) = 600
```

**为什么选择对象数量而非内存阈值：**

- 线程局部对象的大小通常相近（没有巨大差异）
- 跟踪对象数量比跟踪字节数更廉价
- 循环回收的开销与对象数量成正比，而非字节数
- 与线程局部隔离模型契合良好

**显式回收**也可以通过 `gc.collect()` 触发：

```rust
import std/gc;

// 强制执行循环回收
gc.collect();

// 查询被跟踪的对象数量
count := gc.tracked_count();
```

**何时跟踪：**
仅跟踪可能形成循环引用的对象：

- 具有引用类型字段的对象
- 捕获了引用计数值的闭包
- Dyn trait 对象

**跳过跟踪：**

- 值类型（没有 Rc 字段的 struct）
- 基本类型
- 没有内部引用的对象

### 算法实现

#### 阶段 1：试验性删除

```c
void __yo_gc_mark_phase(__yo_gc_state_t* gc) {
    // 1. 将所有被跟踪的对象标记为候选
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        obj->gc_mark = GC_CANDIDATE;
    }

    // 2. 试验性删除：递减候选对象可达的所有对象的 RC
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        if (obj->gc_mark == GC_CANDIDATE) {
            __yo_gc_trial_delete(obj);  // 递归递减 RC
        }
    }

    // 3. 标记存活者：试验性删除后 RC > 0 的对象
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        if (obj->ref_count > 0) {
            obj->gc_mark = GC_LIVE;
        } else {
            obj->gc_mark = GC_GARBAGE;
        }
    }
}

void __yo_gc_trial_delete(__yo_object* obj) {
    if (obj->gc_mark != GC_CANDIDATE) return;

    obj->gc_mark = GC_TRIAL_DELETED;

    // 遍历字段并对引用的对象执行试验性删除
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, __yo_gc_trial_delete_visitor);
    }
}

void __yo_gc_trial_delete_visitor(__yo_object* referenced) {
    referenced->ref_count--;  // 非原子递减
    if (referenced->ref_count > 0 && referenced->gc_mark == GC_CANDIDATE) {
        __yo_gc_trial_delete(referenced);
    }
}
```

#### 阶段 2：恢复与清扫

```c
void __yo_gc_sweep_phase(__yo_gc_state_t* gc) {
    size_t write_index = 0;

    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];

        if (obj->gc_mark == GC_LIVE) {
            // 恢复存活对象的 RC
            __yo_gc_restore_rc(obj);
            gc->tracked_objects[write_index++] = obj;
        } else if (obj->gc_mark == GC_GARBAGE) {
            // 释放垃圾对象
            __yo_free_object(obj);
            gc->objects_collected++;
        }
    }

    gc->tracked_count = write_index;
}

void __yo_gc_restore_rc(__yo_object* obj) {
    if (obj->gc_mark != GC_LIVE) return;

    obj->gc_mark = GC_RESTORED;

    // 恢复所引用对象的 RC
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, __yo_gc_restore_visitor);
    }
}

void __yo_gc_restore_visitor(__yo_object* referenced) {
    referenced->ref_count++;  // 非原子递增
    if (referenced->gc_mark == GC_LIVE) {
        __yo_gc_restore_rc(referenced);
    }
}
```

### 隔离 Spawn 模型

Yo 采用**完全线程隔离**——spawn 的任务运行在独立线程上，**不共享内存**。通信完全通过类型化的消息传递进行（参见 `PARALLELISM.md`）。

**为什么这简化了 GC：**

1. 每个线程拥有自己的堆——没有跨线程引用
2. 每个线程拥有自己的循环回收器——无需协调
3. 无需跟踪哪些对象可能被"窃取"——对象不会在线程间移动
4. 只有值类型可以在线程间传递（复制，而非共享）

```rust
// 父线程
x := 42;
node := Node(1, .None);  // 可能形成循环引用的类型，留在当前线程

// spawn 隔离任务——运行在不同线程上
task := Task(i32, unit).spawn((parent) -> async {
  // ❌ 无法在此访问 node——完全隔离！
  // ✅ 只能接收值类型的副本
  value := await parent.recv();
});

await task.send(x);  // 发送 x 的副本（值类型）
// 无法发送 node——引用类型留在其所属线程
```

**可以在线程间传递的类型（仅限值类型）：**

| 类型                                                  | 可发送？ | 原因               |
| ----------------------------------------------------- | -------- | ------------------ |
| 基本类型（`i32`、`bool` 等）                          | ✅ 是    | 值类型，按副本传递 |
| 值 struct（`struct(...)`）                            | ✅ 是    | 值类型，按副本传递 |
| 值类型的元组                                          | ✅ 是    | 值类型，按副本传递 |
| 载荷为值类型的枚举                                    | ✅ 是    | 值类型，按副本传递 |
| 引用语义类型（`ref(struct(...))` / `ref(enum(...))`） | ❌ 否    | 引用计数，线程局部 |
| 闭包                                                  | ❌ 否    | 可能捕获引用       |
| `*T`（指针）                                          | ❌ 否    | 跨线程不安全       |

**关键设计决策：** 引用语义类型（`ref(struct(...))` / `ref(enum(...))`）**永远不会**跨越线程边界。这意味着：

- 每个线程的 GC 只跟踪在该线程上创建的对象
- 无需跨线程 GC 协调
- 无需原子引用计数
- 简单、可预测的垃圾回收

**常见模式：**

```rust
// ✅ 使用值类型进行消息传递
task := Task(Message, Response).spawn((parent) -> async {
  msg := await parent.recv();  // 接收 Message 的副本
  await parent.send(Response(ok: true));
});

// ✅ 每个线程拥有自己的复杂数据
main :: (fn() -> unit) {
  // 主线程拥有复杂数据结构
  tree := ComplexTree();  // 有循环引用，留在主线程

  async {
    // spawn 工作线程执行 CPU 密集型计算
    task := Task(Array(i32), i32).spawn((parent) -> async {
      data := await parent.recv();
      result := expensive_computation(data);
      await parent.send(result);
    });

    await task.send([1, 2, 3, 4, 5]);  // 发送值数组
    result := await task.recv();       // 接收值结果
    tree.update(result);               // 更新本地数据
  };
};
```

**GC 回收过程：**

```c
void __yo_gc_collect_thread_local() {
    // 无需同步——仅线程局部
    __yo_gc_state_t* gc = &__yo_gc_state;

    // 对当前线程的被跟踪对象执行试验性删除
    __yo_gc_mark_phase(gc);
    __yo_gc_sweep_phase(gc);

    // 其他线程继续并行运行
}
```

**隔离 spawn 对 GC 的好处：**

- ✅ 无全局暂停（每个线程独立回收）
- ✅ 可预测的每线程暂停时间（O(该线程的对象数)）
- ✅ 完美的扩展性（线程间互不干扰）
- ✅ 无需跨线程协调
- ✅ 非原子引用计数（零同步开销）
- ✅ 实现简单（无需可窃取性分析）

## 性能特征

### 线程局部回收

**优势：**

- ✅ 热路径使用非原子 RC（零同步开销）
- ✅ 无全局暂停（每个线程独立回收）
- ✅ 可预测的每线程暂停时间（O(该线程的对象数)）
- ✅ 完美的扩展性（N 个线程 = N 个独立回收器）
- ✅ 完全线程隔离（无跨线程 GC 问题）
- ✅ 适用于实时场景（无全局同步）
- ✅ 实现简单（无需可窃取性跟踪）

**权衡：**

- ⚠️ 引用类型无法在线程间共享（需使用消息传递）
- ⚠️ 大型数据在线程间传递时需要复制

**为什么优于 Go 的 GC：**

- Yo 的暂停：每线程 0.5-5ms（仅该线程的循环引用）
- Go 的暂停：全局 10-100ms+（所有线程暂停）
- Yo 无全局同步（真正的并行）

### 暂停时间分析

```
每线程跟踪的对象数：N/threads
每线程暂停时间：O(N/threads)（标记 + 清扫）
典型值：现代 CPU 上 1K-10K 对象约 0.5-5ms
扩展性：每对象约 0.1-1μs（含遍历）
全局影响：零（其他线程继续运行）
```

**优化策略：**

1. **保守跟踪**：仅跟踪具有引用类型字段的对象
2. **分代**：区分新生代和老年代对象，更频繁地回收新生代
3. **阈值调优**：根据分配速率调整每线程的回收频率

## API

```rust
// 运行时循环回收控制
gc_collect :: (fn() -> unit);  // 立即触发回收
gc_set_threshold :: (fn(threshold: usize) -> unit);  // 设置回收频率
gc_get_stats :: (fn() -> GCStats);  // 获取回收统计信息

GCStats :: struct(
  collections: usize,
  objects_collected: usize,
  objects_tracked: usize,
  last_pause_ns: u64,
);
```

## 编译器支持

### 自动跟踪

编译器为可能形成循环引用的类型自动生成跟踪代码：

```rust
// 用户代码
Node :: ref(struct(value: i32, next: Option(Node)));

// 生成的跟踪代码
node := Node(42, .None);  // 调用 __yo_gc_track(node)
```

### 遍历函数生成

每个可形成循环的对象在其头部携带一个 `traverse_fn`。回收器在试验性删除和恢复两个阶段都会调用它，
并传入一个 `visit` 回调，该回调必须作用于**对象直接持有的每一个受管引用**。漏掉某条边只会导致泄漏
（保守，安全）；而访问了错误的指针则是 use-after-free，因此生成的遍历逻辑被设计为精确无误。

编译器以**组合式**方式生成这段遍历逻辑：它内联地穿透值结构——嵌套的值结构体、值枚举（包括
`Option`）、元组以及内联数组——并在每个受管句柄处停下来访问它：

```c
// 为 Node :: ref(struct(value : i32, next : Option(Node))) 自动派生
void Node_traverse(void* obj, void (*visit)(void*)) {
    Node* node = (Node*)obj;
    // `Option(Node)` 采用可空指针优化：非空时访问裸指针。
    if (node->next != NULL) {
        visit(node->next);  // 直接持有的受管 Node
    }
}
```

这种逐字段下降正是**自动派生的 `Trace` 行为**（参见 [`Trace` Trait](#trace-trait)）。它对每个结构体和
枚举都有效，因为它们的子节点都位于编译器可见的命名字段中。但它对 `ArrayList`、`HashMap` 这类容器
**无效**——这些容器的元素位于裸指针背后的堆缓冲区中，字段遍历无法跟进。这类类型需提供一个手写的
`Trace` 实现，其 `traverse_fn` 会委托给该实现。

### 对象注册

编译器生成将对象注册到线程局部 GC 的代码：

```c
// 为对象分配生成的代码
Node* node = __yo_alloc_object(sizeof(Node));
node->value = 42;
node->next = OPTION_NONE;

// 注册到线程局部 GC（无需同步）
__yo_gc_track(&__yo_gc_state, (__yo_object*)node);

// 递增线程局部分配计数器
__yo_gc_state.alloc_count++;
if (__yo_gc_state.alloc_count >= __YO_GC_THRESHOLD) {
    __yo_gc_collect_thread_local();  // 仅回收当前线程
    __yo_gc_state.alloc_count = 0;
}
```

由于 spawn 的任务完全隔离（不共享内存），无需跟踪"可窃取性"——每个线程只需独立管理自己的对象即可。

## `Trace` Trait

循环回收建立在一个约定之上：回收器必须能够枚举出每个对象所持有的受管引用。这个约定就是 `Trace`
trait，定义于 `std/prelude.yo`：

```rust
Trace :: trait(
  id := "Trace",
  trace : (fn(self : Self, tracer : GcTracer) -> unit),
  where(Self <: Rc)
);
```

`trace` 实现每条出边调用一次 `tracer.visit(...)`。编译器会把每个类型的 `trace` 转换为存放在其对象头部
的 `traverse_fn`。

### 结构体、枚举与值类型自动派生

你几乎从不需要手写 `Trace` 实现。对于子节点位于编译器可见命名字段中的每个引用类型，编译器都会
**自动派生**一个：

- `ref(struct(...))`——访问每个受管字段；对值类型字段内联下降。
- `ref(enum(...))`——根据标签分支，访问当前变体的受管字段。
- `Option`、元组、嵌套的值结构体/枚举以及内联数组——作为其所属字段的一部分被内联遍历。

因此，一个 `Option(Node)` 字段、一个 `(Node, i32)` 元组字段，或一个持有 `Node` 的值结构体，全都开箱
即用——无需注解，无需实现。

### 缓冲区支撑的容器需手写实现

唯一需要手写 `Trace` 实现的，是那些将元素存放在堆缓冲区、并通过裸指针访问的容器（`ArrayList`、
`HashMap` 等）。自动派生的字段遍历会在裸缓冲区指针处停下，永远到不了元素，因此容器必须自行遍历每个
元素槽位。`ArrayList`（位于 `std/collections/array_list.yo`）：

```rust
impl(forall(T : Type), ArrayList(T),
  Trace(
    trace : (fn(self : Self, tracer : GcTracer) -> unit)({
      match(
        self._ptr,
        .Some(base) => {
          (i : usize) = usize(0);
          while(i < self._length, {
            tracer.visit(base &+ i);  // 传入元素的槽位指针
            i = (i + usize(1));
          });
        },
        .None => ()
      );
    })
  )
);
```

### `GcTracer` 与槽位指针规则

`GcTracer` 是一个不透明句柄，承载回收器的边注册回调：

```rust
GcTracer :: newtype(_callback : *(u8));

// （位于 `impl(GcTracer, ...)` 中）
visit : (fn(forall(T : Type), self : Self, slot : *(T)) -> unit)
```

`visit` 接收一个**指向子节点所在位置的指针**（结构体字段或缓冲区槽位），而非按值传入子节点。这是关键的
正确性规则：`visit` 读取 `*slot` 时**不触碰其引用计数**，若它是受管句柄则注册该边，否则内联地穿透值结构
递归。若按值传入元素，则会先 dup 再在 `trace` 返回时 drop——这会在一次回收过程中释放掉一个仍存活、
引用计数为 1 的元素（use-after-free）。传入槽位指针可使遍历对引用计数保持中性，与自动派生的
`visit(&obj->field)` 形式一致。

为新容器实现 `Trace` 时，规则很简单：

1. 对**每一个**元素槽位调用 `tracer.visit(slot)`——漏掉只会泄漏，不会崩溃。
2. 始终传入**指向槽位的指针**，绝不按值传入元素。
3. 你无需自己递归进入元素——`visit` 会组合式地处理槽位中持有的任何内容（受管句柄、值结构体、嵌套
   `Option` 等）。

## 与其他方案的对比

| 方案                             | 暂停时间     | 跨线程           | 复杂度 | 性能           |
| -------------------------------- | ------------ | ---------------- | ------ | -------------- |
| **QuickJS 试验性删除**           | O(N)         | 否（单线程）     | 低     | 良好           |
| **Nim ORC（着色）**              | O(N/threads) | 否（线程亲和性） | 中高   | 优秀           |
| **Python（循环检测器）**         | O(N)         | 是（GIL 串行化） | 中     | GIL 下良好     |
| **Swift（弱引用）**              | O(1)         | 是               | 低     | 优秀           |
| **Java（跟踪式 GC）**            | O(heap)      | 是               | 高     | 不稳定         |
| **Go（标记-清扫）**              | O(heap)      | 是               | 高     | 10-100ms STW   |
| **Yo（QuickJS 风格试验性删除）** | O(N/threads) | 否（隔离）       | 低     | 每线程 0.5-5ms |

## 性能：自适应 Bacon-Rajan（增量 + 全堆兜底）

> **状态：已实现。** 上文的试删回收器现在是*彻底*路径（显式 `Gc.collect()`）；自动触发
> 改用带自适应频率的增量 Bacon-Rajan 回收器。GC 默认开启时，自举编译类工作负载
> （`check ./std`）约 5.7s（≈ 禁用 GC，且快于 TS 宿主的 17s），不再停滞。

### 试验性删除回收器何时成为瓶颈

`__yo_gc_collect` 在其所有阶段（标记候选 → 试删遍历 → 分类 → 扫描恢复 → 释放）都会
遍历整个 `tracked_objects` 链表——即每次回收都是 **O(所有被跟踪对象)**，并在
`tracked_count` 达到自适应阈值（256，按 2× 存活数增长）时触发。当回收能回收堆中相当
一部分时这没问题，但当**大多数被跟踪对象都存活且环极少**时会严重退化：每次回收都
重新扫描整个存活图，却几乎回收不到东西。

编译器是最坏情况——编译一个大型程序会构建数百万个存活的、由引用计数管理的
AST / 类型 / 值 / 环境节点，而环极少。对自举编译的性能采样显示进程**停滞在约 8.7%
CPU**，热点集中在 `__yo_gc_trial_delete_visitor` / `traverse` / `__yo_gc_collect`。
禁用回收器后同一次运行达到 **100% CPU**（无 GC 停滞），证实瓶颈是回收器而非求值器。

### 临时方案：`YO_GC_THRESHOLD`

在 `__yo_init_thread_gc` 中一次性读取环境变量（与 `YO_MAIN_STACK_MB` 一致），允许某次
运行抬高或禁用自动回收：

- **未设置** —— 默认自适应 256 回收器（不变）。
- **`N`** —— 将存活阈值与自适应下限设为 `N`。
- **`0`** —— 禁用自动回收（阈值 = `SIZE_MAX`）。适用于短生命周期、分配密集的运行
  （如编译器），其环（若有）在进程退出时由操作系统回收。

### 峰值内存旋钮：`YO_GC_FULL_PCT`

全堆回收器在**回收后存活计数**的某个倍数处重新装填触发阈值——默认 `200`（2× 存活），
从而把两次全堆扫描之间的被跟踪集合界定在存活工作集的约 2 倍。在内存受限的机器上，
存活集很大的工作负载（例如自举编译器在求值它自己的模块时）其 2× 存活峰值可能超过物理
内存，导致换页抖动或被 OOM 杀死。在同一 `__yo_init_thread_gc` 处再做一次性环境变量读取
即可调节该因子：

- **未设置** —— 默认 `200`（2× 存活），不变。
- **`N`（> 100）** —— 在存活计数的 `N`% 处重新装填全堆扫描。较低的值（如 `130`、`115`）
  以更频繁的——且单次仍约 `O(堆)` 的——全堆扫描为代价，压低峰值内存。≤ 100 的值会被忽略
  （因子 ≤ 1 无法向前推进；触发阈值始终至少前进一个对象）。

这是以吞吐换取更低的内存上限；它无法缩小**存活**集本身，因此存活工作集本身就超过可用内存
的工作负载，仍然需要更大的机器或更小的存活占用。

### 修复：自适应 Bacon-Rajan 可能根集（自动）+ 全堆（显式）

自动触发改用 **Bacon-Rajan 同步环回收**（`__yo_gc_collect_incremental`）。关键观察：
只有引用计数被**递减到非零值**的对象才可能是垃圾*环*的根（"可能根"）。因此增量回收器
不扫描每个被跟踪对象，而只处理**可能根缓冲区**及其可达子图：

1. **在 `__yo_decr_rc` 中缓冲候选。** 当 `--ref_count` 后仍 `> 0` 时，将该对象加入
   `possible_roots` 链表（侵入式双向链表，使释放时的移除为 O(1)，缓冲区中不会残留
   悬垂指针），并染为*紫色*。无环垃圾（RC → 0）仍像现在一样即时释放。
2. **触发**条件改为 `possible_roots` 长度（而非 `tracked_count`）。
3. **回收**只在根集上进行，使用经典颜色（紫=已缓冲候选，灰=试删，白=垃圾，黑=存活）：
   - 对每个紫色根 **MarkGray**，沿其可达子图试递减内部引用。
   - 对每个根 **Scan**：RC > 0 的灰色对象存活 → **ScanBlack**（恢复计数）；否则为白
     （环垃圾）。
   - **CollectWhite** 释放白色子图（先 dispose 后 free，分两遍，确保成员遍历不会触及
     已释放的同伴），随后清空缓冲区。

每次增量回收为 **O(可能根 + 其可达子图)** 而非 O(所有被跟踪对象)。由于环回收仍需遍历该
可达子图——在稠密、绝大多数存活的堆（编译器）上约为 O(堆)——触发阈值是**自适应**的：
回收无所获的一次会将阈值 ×4（封顶），使稠密且环极少的工作负载不再抖动；有收获的一次
则重置到下限。

**移动构成的环。** 仅通过将值*移动*进自身字段构成的环（`a.child = .Some(a)`，codegen
省略了 incr+decr）不会产生"可能根"事件，增量回收器看不到它。**显式 `Gc.collect()`**
路径（`__yo_gc_collect`）仍是全堆试删扫描，可回收这类环，也可按需运行。因此该设计是混合
式：热（自动）路径用廉价的增量回收，显式路径用彻底的全堆回收。

这使回收器默认开启且无需环境变量覆盖（`YO_GC_THRESHOLD` 开关保留作下限/禁用）。这是一项
关乎正确性的改动（涉及释放路径），已在 AddressSanitizer 下针对环回收测试
（`tests/cycle_collector.test.yo`、`tests/codegen-bootstrap/*_self_cycle.yo`、
`ref_enum_cycle.yo`，16/16，外加 `arc` / `closure_capture_rc_leak` /
`continue_rc_cleanup` / `ref_enum` 套件）验证。

## 总结

Yo 的循环回收设计：

1. ✅ **非原子 RC**——热路径零同步开销
2. ✅ **线程局部循环回收**——无全局暂停
3. ✅ **QuickJS 试验性删除**——简单、经过验证的算法（比 [Nim 的着色方案](https://nim-works.github.io/nimskull/gc.html)更简单）
4. ✅ **隔离 spawn 模型**——每个线程拥有自己的堆，不共享内存
5. ✅ **短暂的每线程暂停**——典型值为每线程 0.5-5ms（仅该线程的循环引用）
6. ✅ **实现简单**——无跨线程协调或可窃取性跟踪
7. ✅ **适用于实时场景**——可预测的延迟，无全局同步

核心洞察：

- **引用计数立即释放大多数对象**——GC 仅处理循环引用
- **线程局部回收完美扩展**——N 个线程 = N 个独立回收器
- **完全隔离消除复杂性**——无需跟踪对象是否可在线程间移动
- **无全局暂停**——每个线程独立回收，其他线程继续运行
- **值类型消息传递**——安全的跨线程通信，无需共享引用

这一设计提供了**出色的性能**（优于 Go 的 10-100ms STW 暂停）和**可预测的延迟**，适用于实时应用，且实现复杂度低于工作窃取方案。
