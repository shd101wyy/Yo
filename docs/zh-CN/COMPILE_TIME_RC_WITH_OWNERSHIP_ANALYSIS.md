# 编译期引用计数与所有权及生命周期分析

Yo 对堆分配的对象使用非原子引用计数，并通过编译期**所有权分析**和**生命周期分析**来消除不必要的引用计数操作。

非原子引用计数在 Yo 中是安全的，因为 GC 管理的对象是**线程局部**的，除非显式标记为 `Send`，否则不会跨线程共享（参见 [PARALLELISM.md](./PARALLELISM.md)）。

## 所有权模型

Yo 采用一套规则清晰的简化所有权模型：

### 1. 变量赋值：始终拥有所有权

`:=`（初始化）和 `=`（重新赋值）都会使左侧**拥有**该值的所有权：

```rust
x := Point(3, 4);   // temp_var 拥有 Point(3, 4)，RC = 1
                    // ___dup(temp_var)，x 获得所有权，RC = 2
y := x;             // ___dup(x)，y 获得所有权，RC = 3
z = y;              // ___dup(y)，___drop(旧 z)，z 获得所有权，RC = 4
// 作用域结束：___drop(z)、___drop(y)、___drop(x)、___drop(temp_var)
```

**规则：** 变量始终拥有其值的所有权。每次赋值都调用 `___dup`，每次作用域退出都调用 `___drop`。

### 2. 函数参数：默认借用

函数参数默认**借用**（不改变引用计数）。没有 `own()` 显式标记即表示参数是借用的：

```rust
print_point :: (fn(p : Point) -> unit) {
  printf("(%d, %d)", p.x, p.y);  // 仅读取，无 RC 开销
}

point := Point(3, 4);
print_point(point);  // 调用处无 ___dup，p 借用 point
```

**规则：** 参数默认借用，除非显式使用 `own()` 标记。没有 `own()` 就意味着借用。

**解构同样是借用的：**

```rust
// 解构赋值是借用
Point(x, y) := point;  // x 和 y 从 point 借用，不调用 dup

// match 解构也是借用
match(result,
  .Ok(value) => printf("%d", value),  // value 从 result 借用
  .Err(e) => printf("error")
);
```

### 3. 参数修改：允许通过参数修改字段，禁止重新赋值参数

可以**通过**参数修改字段，但不能**重新赋值**参数本身：

```rust
move_point :: (fn(p : Point, dx : i32, dy : i32) -> unit) {
  p.x = (p.x + dx);  // ✅ 允许：通过参数修改字段
  p.y = (p.y + dy);  // ✅ 允许：通过参数修改字段
}

broken :: (fn(p : Point) -> unit) {
  p = Point(0, 0);   // ❌ 错误：不能重新赋值参数
}
```

**规则：** 参数**不可重新赋值**，以防止所有权状态变更。

### 4. 显式所有权转移：`own()` 关键字

使用 `own()` 将所有权转移给函数参数。

**移动所有权语义：**

- 如果实参已经**拥有** GC 值的所有权，调用会将所有权**移动**到被调用函数中（调用方的绑定变为已消费状态）。
- 如果实参仅是**借用/非拥有**的（例如借用的参数），编译器会插入 `___dup` 以创建一个拥有所有权的临时值传入被调用函数，同时原始绑定仍会被**消费**（变为不可用），以保证 `own()` 调用的线性/消费语义。

```rust
consume :: (fn(own(box): Box(i32)) -> unit) {
  printf("value: %d\n", box.(*));
  // box 在函数末尾被 drop
}

b := box(42);      // b 拥有所有权
consume(b);        // 此后 b 不可再使用

call_consume :: (fn(p : Box(i32)) -> unit) { // p 默认借用
  consume(p); // 编译器插入 ___dup(p) 以满足 own(box)
  // p 在此处不可使用（已被 own() 调用移动/消费）
}

call_consume_but_keep_using :: (fn(p : Box(i32)) -> unit) { // p 默认借用
  p2 := p;    // 编译器插入 ___dup(p)；p2 拥有所有权
  consume(p2); // p2 被消费
  // p 在此处仍可使用
}
```

**规则：** `own()` 参数获取所有权；传入拥有所有权的值会移动它，传入借用的值会通过 `___dup` 克隆并仍然消费实参绑定。

## 基本模型

### 所有权与引用计数

每个堆分配的 ARC 值在创建时有一个所有者，引用计数初始为 1。

```rust
Point :: ref(struct(x : i32, y : i32));

Point(3, 4); // temp_var 拥有 Point(3, 4)，RC = 1
```

### 赋值创建所有权

使用 `:=` 初始化时会调用 `___dup` 以创建新的所有者：

```rust
p1 := Point(3, 4); // temp_var 拥有 Point(3, 4)，RC = 1
                   // ___dup(temp_var)
                   // p1 现在拥有该值，RC = 2
```

当拥有所有权的变量离开作用域时，自动调用 `___drop`：

```rust
p1 := Point(3, 4); // temp_var 拥有 Point(3, 4)，RC = 1
                   // ___dup(temp_var)，p1 拥有所有权，RC = 2

// 作用域结束
___drop(p1);       // RC = 1
___drop(temp_var); // RC = 0，内存释放
```

### 函数参数借用

函数参数不会增加引用计数：

```rust
use_point :: (fn(p : Point) -> unit) {
  printf("(%d, %d)", p.x, p.y);  // p 是借用的，不改变 RC
}

point := Point(3, 4);  // temp_var 拥有所有权，RC = 1
                       // ___dup(temp_var)，point 拥有所有权，RC = 2
use_point(point);      // 不调用 ___dup，p 借用 point
// 作用域结束：___drop(point)、___drop(temp_var)
```

## 生命周期问题

**关键问题**：不经过生命周期分析的朴素借用会导致释放后使用（use-after-free）错误！

```rust
x := box(12);      // temp_var_x 拥有 box(12)，RC = 1
                   // ___dup(temp_var_x)，x 拥有所有权，RC = 2
{
  y := box(13);    // temp_var_y 拥有 box(13)，RC = 1
                   // ___dup(temp_var_y)，y 拥有所有权，RC = 2
  x = y;           // 如果 x 只是从 y 借用的话就危险了...

  // 内层作用域结束
  ___drop(y);           // RC = 1
  ___drop(temp_var_y);  // RC = 0，内存释放
};

printf("%d\n", x.*); // BUG：x 会指向已释放的内存！
```

**解决方案**：赋值时始终调用 `___dup` 以维持所有权。

使用我们的模型（赋值始终拥有所有权）：

```rust
x := box(12);      // ___dup，x 拥有所有权，RC = 2
{
  y := box(13);    // ___dup，y 拥有所有权，RC = 2
  x = y;           // ___dup(y)，___drop(旧 x)，x 拥有新值
                   // 新 box(13)：RC = 3，旧 box(12)：RC = 1

  ___drop(y);           // box(13)：RC = 2
  ___drop(temp_var_y);  // box(13)：RC = 1
  ___drop(temp_var_x);  // box(12)：RC = 0，已释放
};

printf("%d\n", x.*); // ✅ 安全：x 拥有 box(13)，RC = 1
___drop(x);          // box(13)：RC = 0，已释放
```

## 我们的方案：简洁的所有权模型与优化

Yo 优先保证**安全性和简洁性**，同时为优化留有空间：

1. **始终安全**：代码不会出现释放后使用的错误
2. **规则简单**：赋值拥有所有权，参数借用
3. **可预测**：何时发生 dup/drop 一目了然
4. **可优化**：第二阶段分析可消除不必要的操作

**示例——简洁且安全：**

```rust
x := box(12);
{
  y := box(13);
  x = y;  // 始终安全：___dup(y)，___drop(旧 x)
}
printf("%d\n", x.*); // 始终有效：x 拥有一个有效引用
```

**权衡：**

- ✅ 简洁的思维模型（赋值始终拥有所有权）
- ✅ 零内存安全风险
- ✅ 参数默认借用（读取时高效）
- ⚠️ 赋值可能带来 RC 开销
- ✅ 可通过第二阶段分析优化消除

## 何时调用 `___dup` 增加引用计数？

### 规则 1：赋值时（`:=` 和 `=`）

**赋值 ARC 值时，始终对右侧调用 `___dup`：**

```rust
p1 := Point(3, 4); // ___dup(temp_var)，p1 拥有所有权
p2 := Point(5, 6); // ___dup(temp_var2)，p2 拥有所有权

p2 = p1;           // ___dup(p1)，___drop(旧 p2)，p2 拥有 p1 值的副本

// 作用域结束
___drop(p2);       // 减少 RC
___drop(p1);       // 减少 RC
___drop(temp_var2);
___drop(temp_var);
```

**字段/索引赋值同样调用 `___dup`：**

```rust
data.point = p1;   // ___dup(p1)，存入数据结构
arr(0) = p1;       // ___dup(p1)，存入数组
```

### 规则 2：传递给构造器

**传递给 struct/enum/array 构造器时，始终调用 `___dup`：**

```rust
p1 := Point(3, 4);           // p1 拥有所有权
data := Data(p1);            // ___dup(p1)，data 拥有副本
arr := [p1,];                 // ___dup(p1)，数组拥有副本
result := Result(Point).Ok(p1); // ___dup(p1)，enum 拥有副本
```

### 规则 3：函数返回时

**返回借用的参数时调用 `___dup`：**

```rust
identity :: (fn(p : Point) -> Point) {  // p 是借用的（参数）
  return p;  // ___dup(p)，返回值拥有副本
}

create :: (fn() -> Point) {
  p := Point(3, 4);  // p 拥有所有权
  return p;          // ___dup(p)，返回值拥有副本
  // return 之后 ___drop(p)
}
```

### 规则 4：离开作用域时

**值离开其作用域时调用 `___dup`：**

**begin 块：**

```rust
x := box(1);
y := {
  ();
  x  // 从 begin 块返回时调用 ___dup(x)
};
// y 现在拥有一个副本，x 仍然拥有它自己的副本
```

**match 表达式：**

```rust
optional := Option(Box(i32)).Some(box(42)); // optional 拥有所有权
x := match(optional,
  .Some(value) => // 这里的 `value` 是借用的，不拥有所有权
    value
    // 此处插入 ___dup(value)
  ,
  .None => {
    // 处理 None 的情况
    box(0)
  }
)
```

**注意：** 第 1.5 阶段优化通常会在 dup 调用与对应的 drop 调用配对时取消它们，从而有效地转移所有权而非创建不必要的副本。

### 规则 5：`own()` 关键字

**`own()` 参数获取所有权（可能时移动，否则 dup）：**

```rust
consume :: (fn(own(box): Box(i32)) -> unit) {
  printf("value: %d\n", box.(*));
  // box 在函数末尾被 drop
}

b := box(42);      // b 拥有所有权
consume(b);        // b 被消费
// 此后 b 不可再使用

// 如果实参是借用/非拥有的，编译器会插入 ___dup。
// 示例：借用的参数传递给 own() 参数。
call_consume :: (fn(p : Box(i32)) -> unit) {
  consume(p); // 插入 ___dup(p)；p 被消费（此后不可使用）
}
```

### 例外：函数参数（默认借用）

**传递给借用参数（没有 `own()` 的参数）时不调用 `___dup`：**

```rust
print_point :: (fn(p : Point) -> unit) {  // p 是借用的（无 own 关键字）
  printf("(%d, %d)", p.x, p.y);
}

point := Point(3, 4);  // point 拥有所有权
print_point(point);    // 不调用 ___dup！p 借用 point
```

**match 表达式中的解构同样是借用的：**

```rust
match(optional,
  .Some(value) => {
    // `value` 从 optional 借用，不调用 ___dup
    // `value` 同样不可重新赋值。
    printf("%d", value);
  },
  .None => ()
);
```

## 特殊情况：循环

在循环中，赋值遵循同样的"始终拥有所有权"规则：

### 示例：链表遍历

```rust
current_opt := self.head;  // ___dup(self.head)，current_opt 拥有所有权

while runtime(true), {
  match(current_opt,
    .None => return false,
    .Some(current) => {
      current_opt = current.next;  // ___dup(current.next)
                                   // ___drop(旧 current_opt)
    }
  );
}

// 作用域结束：___drop(current_opt)
```

**分析：**

- 初始化：`___dup(self.head)` 创建拥有所有权的副本
- 每次迭代：`___dup(current.next)` + `___drop(旧 current_opt)`
- 结束：`___drop(current_opt)` 清理

**开销（优化前）：** 每次迭代 2 次 RC 操作（dup + drop）+ 1 次初始 dup + 1 次最终 drop = N 次迭代共 2N + 2 次操作。

#### 循环遍历借用链优化

编译器现在能检测此遍历模式并消除**所有** RC 操作（2N + 2 → 0）。核心洞察：通过遍历变量访问的每个节点都由参数对整个数据结构的所有权保持存活。所有迭代中每个节点的净 RC 效果为零，因此移除所有 dup/drop 操作是安全的。

**模式检测条件：**

1. 变量从不拥有 RC 值的参数（或参数字段）初始化（`isOwningTheRcValue: false`）
2. 在 `while`-`match` 循环中，该变量是 match 的被匹配值
3. 在某个 match 分支中，变量被重新赋值为 match 绑定的字段（遍历步骤）
4. 变量不会逃逸循环作用域（循环后无引用，除了 begin 块返回值）

**被移除的操作：**

- 参数表达式上的初始 `___dup`
- 每次迭代重新赋值右侧的 `___dup`
- 每次迭代旧值的 `___drop`（保存 + drop 对）
- begin 块结束时的作用域退出 `___drop`
- 提前返回分支中的 `___drop`

**优化后输出（0 次 RC 操作）：**

```c
void traverse(Node* head) {
    // current_opt = head（无 dup）
    while (1) {
        if (current_opt.tag == None) {
            return;  // 无 drop
        }
        Node* current = current_opt.Some;
        current_opt = current->next;  // 无 dup，无旧值 drop
    }
    // 无作用域退出 drop
}
```

此优化实现在 `src/evaluator/exprs/begin.ts` 中的 `optimizeLoopTraversalBorrowChain` 函数。
