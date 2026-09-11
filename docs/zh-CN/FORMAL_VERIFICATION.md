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
refuted  fn@/abs/path.yo:8 [verify]
    fn@/abs/path.yo:8/divisor-nonzero: REFUTED  counter-example: y = #x00000000
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
| Ghost 代码（`ghost`/`ghost_fn` 擦除）、`std/spec` 集合 | V5（剩余） |
| 跨抽象边界的 trait/泛型、`Refine` | V6 |
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
