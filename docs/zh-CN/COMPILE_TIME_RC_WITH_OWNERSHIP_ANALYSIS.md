# 生成的 C 中的引用计数

> **状态（2026-11-17）。** 本页现在是 Yo 所生成的引用计数的简短指南。它早先的形态
> “编译期引用计数与所有权及生命周期分析”记录的是唯一所有权落地之前的编译器所有权
> 模型 —— 每次赋值都插入 `___dup`、参数默认借用、`sink()` 转移所有权 —— 这些章节
> 已作为历史删除。语言层面的规则见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md)，
> 设计见 [`plans/VALUES_BY_DEFAULT.md`](../../plans/VALUES_BY_DEFAULT.md)。

Yo 用非原子引用计数统计 `Rc(T)` 单元，用原子引用计数统计 `Arc(T)` 单元，并在编译期删除它能证明不必要的引用计数操作。

非原子 RC 在 Yo 中是安全的，因为被计数的对象是**线程局部**的，除非类型显式标记为 `Send`，否则不会跨线程共享（参见 [PARALLELISM.md](./PARALLELISM.md)）。

## 生成的 C

每个被计数的单元都以一个头部开始（`__yo_ref_header_t`，别名 `__yo_rc_prefix_t`）：
偏移 0 处的一个 `uint32_t` 计数（其最高位是显式分配器标记，因此计数读取会先做掩码），
随后是类型 id，再是一个 16 位字：普通对象的内部借用标记，或 `Rc`/`Arc` 单元上的
`Weak` 计数（[WEAK.md](./WEAK.md)）。操作本身是少量 `static inline` 辅助函数，
发射进每个文件：

- `__yo_incr_rc` / `__yo_decr_rc` —— 非原子计数操作；
- `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` —— 原子计数单元（`Arc`、原子引用
  对象）使用的同一对操作；
- `__yo_dyn_retain` / `__yo_dyn_release` / `__yo_dyn_clone` —— `Dyn` 载荷经由其
  vtable 的计数；
- `__yo_rc_weak_retain` / `__yo_rc_weak_release` / `__yo_rc_weak_upgrade` ——
  `Weak`/`ArcWeak` 句柄；
- `__yo_borrow_acquire` / `__yo_borrow_release` / `__yo_borrow_assert_unborrowed`
  （外加 `_atomic` 三件套）—— 独占法则（Law of Exclusivity）的运行时兜底：指向
  容器存储内部的内部引用会递增容器的借用标记，可能重新分配或释放该存储的操作在
  标记未归零时 panic。`Rc`/`Arc` 单元从不携带借用标记；它的那个字是弱计数。

编译器还为每个类型派生 `___dup` / `___drop` / `___dispose` 辅助函数 —— dup 逐个
克隆携带 RC 的字段，drop 逐个释放，dispose 运行载荷的 `Drop` 并释放。在分块发射
（`--emit-chunks`）下每个翻译单元各有一份 `static` 副本：它们是 RC 的热路径。

## 读取计数：`ref_count(x)`

内建 `ref_count(x)` 返回 `x` 所持单元的当前引用计数，类型为 `usize`。对值类型
（普通 `struct`、整数）它恒为 `1`，编译期可知。原子计数的句柄（`Arc(T)`）用原子
加载读取。`Box` 没有计数：`ref_count(b)` 是编译错误（“唯一拥有、不带计数的单元”）。

该计数反映编译器的 dup/drop 优化，被优化器取消的副本不会体现在其中；它用于唯一性
检查（写时复制）和测试，而不是程序逻辑。

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "两个句柄，一个单元");
```

`Rc.new(v)` 分配单元并取得 `v` 的所有权；第二个句柄写作 `Rc.clone(h)`；`Arc(T)`
以同样方式统计其句柄，只是改为原子操作，用于跨线程共享。

## `___dup` 从哪里来

在唯一所有权下，dup 在为携带 RC 的数据创建**第二个所有者**时递增计数：`Rc.clone(h)`；
以及值被存入字段、数组元素或 enum 载荷而其绑定还继续存活（下文的借用实参保护是
又一种）。在最后一次使用处被移动的值不产生计数流量：存入的 dup 与绑定的作用域末尾
drop 正是下文优化器抵消的那一对。普通数据（整数、由整数组成的 struct）的复制完全没有
计数；`Box` 按移动传递，从不计数。

作用域退出时仍然 drop 它拥有的东西：对拥有所有权的绑定，drop 递减计数；计数归零时
运行载荷的 `Drop` 并释放单元。

## dup/drop 配对优化器

`_optimize_dup_drop_pairs`（`src/evaluator/exprs/begin.yo`）会把局部变量唯一的一次
运行时 dup 与它的作用域末尾 drop 相抵消 —— 一次**移动（move）**：dup 消失，同时
变量被标记为已消耗（consumed），因此任何路径都不再对它执行 drop。这只有在 **dup 在
所有能到达作用域末尾的路径上都无条件执行**时才是健全的，因此优化器：

- 对 `cond`/`match` 进行**分支感知**的 dup 收集：只在部分 fallthrough 分支中出现的
  dup 会把变量标记进 `vars_with_partial_branch_dups`，配对被保留 —— 被执行的分支上
  有 dup，所有路径上都有作用域末尾的 drop；
- 每个分支都有 dup 时按分支各计一次，运行时 dup 计数大于 1 同样保留配对；
- 沿 `ExprInfo.macro_expansion` 递归，而不是宏调用的原始参数 —— `if(...)` 在 AST
  中保留宏调用头，只有记录下来的 `cond` 展开才暴露分支结构。沿原始参数递归会把
  分支内的 dup 当作无条件 dup 并错误地取消它 —— 在所有跳过该分支的路径上各泄漏
  一个引用（`issues/fixed/where-constraints-arraylist-96b-leak.md`，2026-08-06 修复）；
- 绝不跨 `while` 循环体优化（循环体内的 dup 执行 N 次，作用域末尾的 drop 只执行一次）；
- 跳过 `io.async` 捕获（状态机同时需要 dup 和 drop）。

## 借用实参的别名保护

传给借用（`&T`）参数的、位于 `Rc`/`Arc` 载荷内部的位置，可能在调用期间被被调用方
经由另一个句柄释放其所在容器而悬空。该缺口已被封闭（2026-08，两阶段的 Lobster 风格
借用推断；复现程序、分阶段设计与落地记录见
`issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md`）：

- **阶段 0** —— 传给**借用**参数的 RC 类型字段**投影（projection）**为该调用获得一个
  调用方持有的 `+1`；经由只读句柄到达的位置则在句柄上共享：被调用方运行期间单元保持
  存活，即使某个闭包实参释放了最后一个其他句柄。普通局部变量保持 `+0`（调用方的绑定
  使其存活），拥有的临时值、`&mut` 参数、extern/内建被调用方（其中不运行 Yo 代码）
  也一样。
- **阶段 1** —— 按被调用函数计算**变更摘要（mutation summary）**
  （`src/evaluator/effects/mutation-summary.yo`），回答“这次调用是否可能（递归地）
  修改 RC 容器存储？”；占绝大多数的只读被调用函数因此恢复 `+0` 借用。仅有阶段 0 时
  自举编译耗时增加 23%，阶段 1 不仅将其全部收回，还更进一步（`check ./std`：
  45.3 秒 → 55.2 秒 → 38.5 秒），因此该缺口的封闭没有带来运行时开销。

满足以下任一条件的被调用函数即视为**可能变更（may-mutate）**：（递归地）对
RC 类型的位置赋值；执行**显式的 RC 递减**（`___drop`、`__yo_decr_rc` 等——
它们都可能释放借用所依赖的、由容器持有的那个引用）；调用属于运行时/分配器
家族的 extern、libc 的 `free`/`realloc`，或接受回调的 extern；通过 io 内建
让出事件循环；是控制函数（control function）；或调用了编译器无法解析的目标。
这是一个 MAY 分析：任何无法识别的情况都按“会变更”处理。编译器**自动生成**的
drop 不构成风险——它们只针对拥有其值的变量，而借用按定义是非拥有的。

## 循环

已退役的 TypeScript 编译器能识别链表遍历循环并移除其全部 RC 操作。这项优化从未
移植到自举编译器（见 `src/evaluator/exprs/begin.yo` 中配对优化器旁的注释）；
`issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md` 记录了它的修改保护所
修复的 use-after-free。在唯一所有权下，由语言本身取代它：一个局部借用重新指向
它已借用的节点内部，即可遍历链表（`plans/VALUES_BY_DEFAULT.md`，决定 25）。遍历
`Box` 节点时没有任何计数操作；遍历 `Rc` 节点时，每一步都会固定（pin）进入的单元，
即一次增加和一次减少。
