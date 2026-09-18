# 形式化验证

Yo 拥有 Dafny/SPARK 传统的编译期验证器：带契约注解的函数（以及在
verify 模式下**未注解**的函数）会被符号执行，其证明义务由固定版本的
[Z3](https://github.com/Z3Prover/z3) SMT 求解器判定。证明会替代运行期
检查；被驳倒则是带着具体反例的编译错误。设计记录：
[`plans/backlog/FORMAL_VERIFICATION.md`](../../plans/backlog/FORMAL_VERIFICATION.md)。

```bash
# 验证一个文件（或目录）—— 任何失败都以非零退出码结束
yo verify ./src/my_spec.yo

# 查看单个函数的完整明细（按 fn@路径:行号 子串匹配）
yo verify ./src/my_spec.yo --explain abs

# JSON 报告
yo verify ./src/my_spec.yo --format json
```

## 契约

契约是函数签名里的内建调用。返回值通过 `-> (name : T)` 的标签命名
—— 没有 `result` 这种魔法标识符。

```rust
abs_i32 :: (fn(x : i32, ensures(r >= i32(0))) -> (r : i32))(
  if(x < i32(0), i32(0) - x, x)
);

safe_div :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(r == (x / y))) -> (r : i32))(
  x / y
);
```

验证是**模块化**的（Dafny 模型）：

| 位置 | `requires(P)` | `ensures(E)` |
| --- | --- | --- |
| 函数自己的文件 | 入口处**假设**成立 | 每条退出路径都要**证明** |
| 任意调用点 | 在调用方路径条件下**证明** | 调用后**假设**成立 |

调用方从不展开被调方的函数体 —— 只读签名。`runtime` 模式文件里的
函数在验证调用点仍然提供可用的契约；只是它自己的函数体不被验证。

### Trait 契约（可变性 + 继承）

trait 方法可以在签名里携带契约，`impl` 方法也可以为同一方法声明
自己的契约。二者在 impl 注册时相互校验：

| 义务 | 方向 | 原因 |
| --- | --- | --- |
| `trait.requires ⇒ impl.requires` | 逆变（可放宽） | 分发调用方只证明 trait 的前置条件，因此 impl 只能放宽、不能收紧 |
| `impl.ensures ⇒ trait.ensures` | 协变（可加强） | trait 的承诺是下限，因此 impl 只能加强、不能削弱 |

```rust
ClampBound :: trait(
  get : (
    fn(self : Self, i : i32, requires(i >= i32(0)), ensures(result >= i)) -> (result : i32)
  )
);

// 可证明：requires 放宽为 i >= -1，ensures 加强为 result == i。
get_impl :: (
  fn(self : i32, i : i32, requires(i >= i32(-1)), ensures(result == i)) -> (result : i32)
)(i);

impl(
  i32,
  ClampBound(
    get : get_impl
  )
);
```

**不**声明任何契约的 impl 方法会**继承** trait 方法的契约 —— 它们像
自己声明的一样注册到方法值上，因此该方法自己的验证任务要用函数体
证明它们（依赖继承来的 `requires` 的证明在没有继承时必然失败）。
可变性义务注册为一个合成的 `impl-variance@module:row:label` 验证
任务 —— 每个蕴涵一条断言，在 impl 的参数上证明、返回标签作为额外
的符号值 —— 走普通流水线。impl 的谓词必须使用 trait 的参数与标签
拼写；不一致会在义务处以未绑定名字报错。收紧前置条件的 impl 会被
以分发的反例驳倒（上例的孪生版本在 `i = 0` 处驳倒）。

### 泛型函数

**泛型**函数的契约在其调用点结算 —— 仍是 Dafny 模块化模型：泛型
函数体不被遍历（它按特化重新求值），但每个单态化调用点会针对调用
方路径条件**证明**泛型的 `requires`，并把它的 `ensures` 作为新结果
项**假设**下来。两处机制支撑这一点：特化会把契约表再键到特化函数
id 上；调用点会以**具体**实参类型求值签名谓词（在泛型自己的定义
处，谓词无法求值 —— 作用在类型变量上的运算符没有编译期实现 ——
正是调用点求值给了验证器带类型的谓词节点）。

```rust
pick :: (
  fn(generic(T : Type), flag : bool, a : T, b : T, ensures((result == a) || (result == b))) -> (result : T)
)(if(flag, a, b));

// 调用方自己的后条件只有通过假设的泛型 ensures 才可证明 ——
// 验证器从不展开 pick 的函数体。
caller :: (fn(ensures((r == i32(1)) || (r == i32(2)))) -> (r : i32))(
  pick(true, i32(1), i32(2))
);
```

违反泛型 `requires` 的调用方（给 `requires(flag)` 的被调方传
`flag = false`）会在调用点被以反例驳倒。

### 互递归

当互递归函数组的每个成员都带 `decreases(M)`，且组内每一次调用都证明
被调方的测度在实参上严格小于调用方当前测度时，递归终止 —— 共享一个
良基域，无需字典序元组。函数组由验证器从任务集的调用图自动推导，因此
没有递减的边（原样传递 `n`）会被驳倒：

```rust
is_even :: (fn(n : i32, requires(n >= i32(0)), decreases(n)) -> (r : bool))(
  if(n == i32(0), true, is_odd(n - i32(1)))
);
is_odd :: (fn(n : i32, requires(n >= i32(0)), decreases(n)) -> (r : bool))(
  if(n == i32(0), false, is_even(n - i32(1)))
);
```

### 精化类型 —— `refine(T, p)`

`refine(T, p)` 注解"满足谓词 `p` 的 `T`"。注解求值为 `T` —— 已擦除、
零运行期开销；值绑定、分发和 lowering 都与普通类型完全一致 —— 而精化
条件附着在函数签名上。谓词是单参数的 `ghost_fn` 值；验证器以模块化
方式消解它 —— 被调方在入口**假设**每个精化参数的精化条件，而每个调用
点为实参**证明** `refine#N` 义务：

```rust
non_zero :: ghost_fn((fn(x : i32) -> bool)(x != i32(0)));

// 无需手写 `requires`：除零义务由假设的 `denom` 精化条件直接证得。
safe_div :: (fn(num : i32, denom : refine(i32, non_zero)) -> (r : i32))(num / denom);

// 调用方在自己的 requires 下证明 `refine#1`（x != 0）。
caller :: (fn(x : i32, requires(x != i32(0))) -> (r : i32))(safe_div(i32(7), x));
```

无法证明谓词的调用方会被以反例驳倒（`d = 0`），而被调方仍保持已验证
状态 —— 一个坏的调用方不会污染被调方。不带谓词的 `refine(T)` 是无义务
的裸别名。精化条件既可内联写在参数注解中，也可通过具名别名使用 ——
`NonZeroI32 :: refine(i32, non_zero)` 然后写 `d : NonZeroI32`（别名
绑定的就是精化类型本身）。

**std/spec 各族现在都是真正的精化类型。** `NonZero(T)`、
`Bounded(T, lo, hi)`、`Positive(T)`、`Even(T)`……通过在别名体内书写
谓词 ghost 来附着具体谓词 —— 别名的 comptime 参数（`T`、`lo`、`hi`）
在 ghost 创建时就在作用域内，因此每次 `NonZero(i32)` 求值都会创建一个
完全具体的谓词：

```rust
NonZero :: (fn(comptime(T) : Type) -> comptime(Type))(refine(T, ghost_fn((fn(x : T) -> bool)(x != T(0)))));
```

组合 —— `refine(refine(T, p), q)` —— 表现为合取：验证器对链上每一条
谓词进行假设/证明（类型本身保持嵌套可区分）。值经运行期闸门构造 ——
`check_non_zero(x)` / `check_bounded(x, lo, hi)` 返回
`Option(Refined)` —— 或经可信强转 `unchecked_non_zero(x)` /
`unchecked(p, x)`（配合 `pragma(Pragma.AllowUnsafe)`）。返回 comptime
的函数要求所有参数均为 comptime，因此通用包装器的谓词参数写作
`comptime(p)`；而 comptime 谓词永远无法在运行期被*调用* —— 这正是各
族闸门将谓词内联书写、而非以运行期值接收 ghost 的原因。

## 模式

| 模式 | 选择方式 | 行为 |
| --- | --- | --- |
| `runtime`（默认） | 无 pragma | 契约降级为运行期 `assert(...)` —— 现状行为 |
| `verify` | `pragma(Pragma.Verify);` | 证明义务替代断言；被驳倒/无法证明 ⇒ 编译错误 |
| `verify+` | `pragma(Pragma.VerifyOrAssert);` | 尽力证明；预算耗尽时回退到运行期断言 |
| `ignore` | `pragma(Pragma.NoContracts);` | 契约完全擦除 |

`yo verify <路径>` 把目标集合默认置为 `verify` 模式；
`--verify-mode runtime|verify|verify+` 可覆盖，而文件自身的 pragma
存在时以 pragma 为准。模式效果只作用于被验证的文件 —— 被导入的文件
（标准库、`std/`）保持原有运行期行为不变。

## 法则（law）：写在代码之外的断言

契约写在它约束的函数里，这意味着代码的作者同时拥有它的规约。**法则（law）**
是另一半：关于代码的断言，写在实现碰不到的文件里。

```rust
pragma(Pragma.Verify);

{ abs_value } :: import("./math.yo");

// 法则：在契约限定的定义域内，绝对值加倍后仍非负。
abs_doubles_nonneg :: law(
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((abs_value(x) + abs_value(x)) >= i64(0))
  ) -> unit
);
```

参数是一个带契约子句、**没有函数体**的函数**类型**。它的 `ensures` 是义务；
它的 `requires` 在入口处被假定，并正是它在每个调用点讨还被调用者自己的
`requires`。法则求值为 `unit`，因此 `name :: law(...)` 绑定 unit，代码生成不产出
任何东西。

**法则只从被调用者的契约出发证明，绝不打开其函数体。** 这既是要点，也是约束：
如果 `abs_value` 只承诺 `ensures(r >= 0)`，上面的法则无法证明 —— 两个只知道非负
的值相加可能溢出。让断言可证的，是被调用者 `ensures` 中的上界。法则以这种方式
失败时，通常是在告诉你：契约比你以为的更弱。

以下每一条都是编译错误，而不是悄悄通过：

| 被拒绝的写法 | 原因 |
| --- | --- |
| 返回类型不是 `unit` | 法则没有值；断言应写在 `ensures(...)` 里 |
| 没有 `ensures(...)` | 什么都不断言的法则会报告一次空洞的通过 |
| `assumed()` | 它会让断言不经证明就通过 |
| `decreases(...)` | 法则没有可度量的递归 |
| 用别名而非就地写出的 `fn(...)` 类型 | 无法扫描其子句，隐藏的 `assumed()` 会被忽略 |

法则以自己的 `law@<文件>:<行>:<列>` 标识报告，因此同一行上的两条法则不会混淆：

```
  ok       law@spec/math_laws.yo:8:21 [verify] — 3 obligation(s) proved
  refuted  law@spec/math_laws.yo:16:19 [verify]
    law@spec/math_laws.yo:16:19/ensures#0: REFUTED  counter-example: x = #x0000000000000000
```

### 约定：由人类拥有的 `spec/` 目录

编译器并不知道什么是「法则文件」—— 这是一条约定，而这正是该特性的意义所在：

1. 把法则放在 `spec/`，由决定软件必须做什么的人来写。实现不得修改它们。
2. 用 `yo verify ./spec --strict` 作为门禁，使得运行不会因为某个契约被
   `assumed()` 掉而通过。
3. 如果你的托管平台支持，把 `spec/` 加入 CODEOWNERS。

在运行时模式（没有 verify pragma）下，法则是被接受的空标记，因此规约文本永远
不会破坏普通构建。注意由此带来的后果：法则的谓词只在验证下做名字解析，所以
引用了不存在的东西的法则由 `yo verify` 发现，而不是 `yo check`。

## 严格模式：不会悄悄变绿的门禁

普通的 `yo verify` 在函数报告 `assumed`（契约已声明，函数体从未被走查）
或 `outside-subset`（它没有承诺任何东西，走查也进不去）时仍然通过。对于
渐进式采用验证，这是对的；但作为门禁就错了：改代码的智能体可以加上
`assumed()`、删掉 `ensures`，或者把函数体推出子集，而运行依旧全绿，没有
任何信号。

`--strict` 把这些结果变成失败：

```bash
yo verify ./spec --strict          # 等价于 --deny assumed,outside-subset,unproven
yo verify ./spec --deny assumed    # 也可以自己指定
```

结果名的取值为 `ok`、`assumed`、`outside-subset`、`unproven`、`refuted`、
`solver-error`、`subset-error`；`--deny` 中出现未知名称会报用法错误并列出
全部取值。被拒绝的结果在**所有**模式下都算失败，因此 `--strict` 下的
`unproven` 即使在 `verify+` 中也会失败，而不会退回运行时断言。

每次运行都会以一行汇总结尾 —— 七种结果的计数（包含 0，便于 grep）、其中
有多少 `ok` 是**空洞的**（完全没有讨还任何义务）、求解器查询数、命中缓存
的数量，以及墙上时间：

```
verify: 2 ok, 1 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous) — 1 queries, 0 cached, 46 ms
```

`--format json` 在 `summary` 对象中给出同样的数字，另外还有 `strict` 和
`denied` 列表。

## 自动义务（AoRTE）

在 verify 模式下，验证器会对每个函数证明**契约没有要求**的东西：

- 每个 `/` 与 `%`：除数非零；
- 每个 `<<`/`>>`：移位量不超过操作数位宽。

索引边界检查将随切片进入子集而加入。这样在完全未注解的代码上也能
抓住经典的越界/除零类错误：

```rust
// 没有任何契约 —— 依然是编译期错误：y = 0 时除以零。
divide_bugged :: (fn(x : i32, y : i32) -> (r : i32))(x / y);
```

```
refuted  fn@src/math.yo:8 [verify]
    fn@src/math.yo:8/divisor-nonzero: REFUTED  counter-example: y = #x00000000
```

## 可验证子集（当前状态）

验证定义在一个随阶段增长的 Yo 子集上；使用了子集外构造的函数会得到
精确的 `cannot verify: <构造>` 错误（在 `verify+` 下则回退到运行期
断言）。

| 构造 | 状态 |
| --- | --- |
| 整数/布尔算术、比较、逻辑运算、`cond`/`if` | ✅ 已支持 |
| 绑定（`:=`、`=`）、begin 块、对带契约/可折叠被调方的调用 | ✅ 已支持 |
| `assert(P)` 位点、`panic` 路径、`old(...)`（双态：函数入口快照；函数体内局部名被拦截——无入口值） | ✅ 已支持 |
| 值枚举上的 `match`（测试器、投影、构造） | ✅ 已支持（V3） |
| 结构体 / 元组 / 引用枚举 | 🚧 进行中 |
| 带 `invariant(...)` 的 `while`（havoc 规则） | ✅ 已支持（V4） |
| `decreases(M)` —— 循环语句变体 + 递归度量 | ✅ 已支持（V4） |
| `cond` 分支内赋值（phi 合并）；`continue` 作为循环体最后一条语句 | ✅ 已支持（V4.1） |
| `break`（退出路径析取）；任意位置的 `continue`（在位点处证明）；`while(runtime(true), ...)` | ✅ 已支持（V4.2） |
| `for` 循环（需要迭代器/集合模型） | 后续阶段 |
| 契约中的 `forall`/`exists`/`==>`（仅限幽灵上下文；SMT 量词，MBQI 实例化） | ✅ 已支持（V5） |
| `inout` 参数 —— 可重赋值的双态绑定（`old(v)` 读入口快照） | ✅ 已支持（V5） |
| `std/spec` 幽灵集合 —— Seq（`seq_unit`/`seq_append`/`seq_len`/`seq_nth`，SMT `Seq`）、Multiset（`ms_single`/`ms_add`/`ms_count`，元素→计数 `Array`）、Set（`set_single`/`set_add`/`set_contains`，成员 `Array`）、`str_bytes`（字符串内容即 `Seq(u8)`） | ✅ 已支持（V5） |
| 定长 `Array(T, N)` 值 —— `a(i)` 读取（`select`）、`a(i) = v` 下标写（经 `store` 的 SSA 重绑定）、`index-in-bounds` AoRTE 义务，以及 `ms_of(a)`（数组元素折叠为幽灵 Multiset —— `permutation` 规格的原料） | ✅ 已支持（V5 任务 6） |
| Ghost 代码（`ghost`/`ghost_fn` 擦除） | ✅ 已支持（V5 任务 3） |
| Trait 方法契约 —— 无契约 impl 方法的**继承** + **可变性**义务（`trait.requires ⇒ impl.requires` 逆变、`impl.ensures ⇒ trait.ensures` 协变，合成为 `impl-variance@…` 任务） | ✅ 已支持（V6 任务 1） |
| 带契约的**泛型**函数在调用点 —— 每个单态化调用点结算 `requires` 并假设 `ensures`（泛型函数体本身仍不遍历） | ✅ 已支持（V6 任务 2） |
| 互递归 —— 函数组每个成员都带 `decreases(M)`；组内调用证明被调方测度在实参上递减（函数组由调用图推导） | ✅ 已支持（V6 任务 4） |
| 泛型函数体的抽象验证（未解释类型排序、trait 约束公理）、`Refine` | V6 |
| `object`/堆、字符串内容、浮点、效应、`unsafe`、FFI | 子集之外 |

整数按**与生成的 C11 完全一致的确宽位向量**建模（`-fwrapv` 二补码
语义）—— 证明是关于实际运行程序的证明。溢出是定义好的语义，不是
一项义务。

值枚举按 **SMT 数据类型**建模：每个查询用一个
`declare-datatypes` 块声明义务涉及的全部枚举，构造器与访问器都
混淆为模块限定名（它们共享数据类型的整个 SMT 命名空间）。
`match` 降级为嵌套在 `(is-<构造器> ...)` 测试器上的 `ite`；
模式绑定成为访问器投影；`.Variant(args...)` 构造成为构造器
应用。

`while` 降级为 **havoc-不变式规则**：入口处证明不变式；在
havoc 状态（每个被赋值名都换成全新无约束常量）上假设
`不变式 ∧ 条件` 并符号执行循环体；在结果状态上重新证明不变
式；退出路径假设 `不变式 ∧ ¬条件`。`decreases(M)` 语句额外
在 havoc 状态上证明度量非负、跨迭代严格递减；签名中的
`decreases(M)` 子句在每个递归自调用处做同样的事 —— 这正是递归
可验证的根基。退出状态是**全新一代 havoc 常量** ——
零迭代的循环保持入口状态，循环体的输出无法表示它，因此退出
事实是无约束常量上的 `不变式 ∧ ¬条件`。`break` 增加自己的
退出析取支：一个新布尔量为 break 位点的状态快照（含完整路径
条件）做选择，循环之后的代码在析取下证明。任意位置的
`continue` 在该语句处就地证明不变式（和度量步）。
`runtime(e)` 是恒等标记 —— `while(runtime(true),
{ invariant(...); ...; if(done, { break; }) })` 是"循环直到
完成"的可验证写法。
`forall((k : T), P)`/`exists((k : T), P)` 降级为带注解
绑定器的 SMT 量词（这些小目标由 z3 的基于模型的实例化求解；
显式 `:pattern` 触发器推迟到有基准需要时），`a ==> b` 是布尔
蕴含。三者都**仅限幽灵上下文** —— 只允许出现在契约子句、
`ghost(...)` 绑定和 `ghost_fn` 体内，其他位置是编译错误（它们
没有运行期语义）。`inout` 参数是子集中唯一可重赋值的绑定：
函数体内的 `=` 重绑定当前值，而 `old(v)` 始终读入口快照。
定长 `Array(T, N)` 值按 **BV64 下标的 SMT 数组**建模：`a(i)`
读取 `select(a, i)`（下标零扩展到 64 位），下标写 `a(i) = v`
把名字**重绑定**为 `store(a, i, v)` —— 值语义，与其他 `=` 相同
的 SSA 纪律。运行位置上的读写携带 `index-in-bounds` AoRTE 义务
（`i u< N`，长度来自编译期）；量词体内的读取不携带 —— 那里
的界由规格自身的守卫承担。`ms_of(a)` 把数组 N 个元素折叠为
幽灵 Multiset（元素→计数），于是 `permutation(s, old(s))` 就是
`forall(x, ms_count(ms_of(s), x) == ms_count(ms_of(old(s)), x))`
—— N 展开后是纯粹的数组合同推理。V5 出口样例 —— 对
`Array(i64, 8)` 的原地插入排序，通过这两条量词式不变式同时证明
有序性与置换性 —— 见
`tests/spec/fixtures/valid/spec_insertion_sort.yo`。

## 求解器

单一固定版本的 Z3（见 `src/verifier/z3.yo` 的 `Z3_VERSION`；当前为
5.1.0）。解析顺序：`YO_Z3_PATH` → `~/.cache/yo/solvers/` 下的固定
安装 → 从 GitHub Releases 自动一次性下载。判定结果按义务缓存在
`~/.cache/yo/verify-cache/`（以查询内容、版本钉扎与运行选项的
sha256 为键）；传 `--no-cache` 可跳过。确定性来自 `:rlimit` 预算
（而非墙上时钟）与固定的 `:random-seed 0`。

## 试一试

仓库自带的验证集就是一个可用示例 —— 其中每个函数都可证明，旁边的
每个负例夹具都配有一个必然被驳倒的孪生错误版本：

```bash
yo verify ./tests/spec/verify_straight_line.test.yo
```
