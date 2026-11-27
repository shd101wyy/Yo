# 共享所有权

由多个所有者共享的值：引用计数单元 `Rc(T)` 与 `Arc(T)`、唯一所有的 `Box(T)`、
`Weak` 句柄、借助 `RefCell` 的内部可变性，以及这些单元所依赖的值规则（`Copy`、
只能移动的值、`Drop`）。单一所有权与引用见
[OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md)；`Arc` 与 `Weak` 的详细说明见
[ARC.md](./ARC.md) 和 [WEAK.md](./WEAK.md)。

## 共享单元与内存管理

Yo 使用**引用计数单元**（`Rc`、`Arc`）实现共享所有权。`Rc(T)` 以非原子方式对句柄计数，`Arc(T)` 以原子方式计数。非原子计数是可靠的，因为 `Rc` 不是 `Send`：它从不离开自己的线程，所以只有一个线程会访问它的计数（[PARALLELISM.md](./PARALLELISM.md)）。跨线程共享请用 `Arc`（[ARC.md](./ARC.md)）。克隆是一次递增，丢弃一个句柄是一次递减，移动没有开销：编译器不会再加入其他计数操作。

### 引用计数单元

`Rc(T)` 与 `Arc(T)` 是带有自动引用计数的堆单元。句柄就是新的所有者，所以第二个句柄写作 `Rc.clone(h)`：

```yo
// 一个共享单元：`Rc(T)` 对指向同一个堆单元的句柄计数。
Resource :: struct(id : i32);
impl(
  Resource,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // 当引用计数降为零时运行 `drop`
    })
  )
);

// 使用
s1 := Rc.new(Resource(id : i32(1))); // RC = 1
s2 := Rc.clone(s1); // RC = 2（两个句柄指向同一个单元）
s3 := Rc.clone(s2); // RC = 3
// 当 s1、s2、s3 离开作用域时，RC 递减
// 当 RC 降为零时，载荷的 `drop` 运行并释放单元
```

### 选择值、借用还是共享单元

两个问题决定了一个持有状态的类型的形态：

1. 构造之后它会被写入吗？
2. 它是否被两个所有者需要，而这两个所有者的生存期超出彼此的调用？

都不是：普通 `struct`，按 `&` 传入、按值返回。是、否：一个拥有所有权的值，写入处以
`&mut` 借出，只读处以 `&` 借出。都是：`Rc(RefCell(S))`。

std 的类型展示了方法的形态，每个方法只有一种形态：

- 构建器消耗并返回：链式写 `Command.new(p).arg(a).arg(b)`，或在 `mut(cmd)` 绑定上写
  `cmd = cmd.arg(a);`。`HttpRequest`/`HttpResponse` 的 `.header`/`.with_body` 以及
  `FetchOptions.with_*` 也是如此。
- 修改器借出：`mut(u) := Url.parse(&s).unwrap(); u.set_path(&p);`。`ArgParser.add_*`、
  `Rng` 的取数方法与 `Interval.tick` 也是如此。
- 终结方法消耗：哈希器的 `update(&mut self)` 喂入数据，`finish(self)` 结束它，所以第二次
  `finish` 是移动后使用（E0901）。
- `HttpServer` 是共享的那一个：它的 `serve` future 拥有一个 `server.clone()`，保留下来的
  克隆在处理函数或另一个任务中调用 `stop`。

### 读取计数

内建函数 `ref_count(x)` 以 `usize` 返回 `x` 所持单元的句柄数；`Arc(T)` 以原子加载读取。对值类型（普通 `struct`、整数）它总是 `1`，在编译期已知。`Box` 没有计数，所以 `ref_count(b)` 是编译错误。计数用于唯一性检查（写时复制）和测试，不用于程序逻辑。

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "两个句柄，一个单元");
```

### 显式分配器

引用计数决定对象何时释放，显式分配器决定它放在哪里。不带分配器参数的创建使用全局分配器；放置是创建处的一个参数：`Box.new`、`Rc.new`、`Arc.new` 以及容器的 `new` / `with_capacity` 都用 `alloc : .Some(a)`：

```yo
{ ArrayList } :: import("std/collections/array-list");
Point :: struct(x : i32, y : i32);

// `a` 是任意 `Allocator` 值，例如 `Allocator.global()`。
p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a)); // 放在 `a` 里
p2 := Rc.new(Point(x : i32(1), y : i32(2))); // 没有参数：全局分配器
xs := ArrayList(i32).new(alloc : .Some(a)); // 缓冲区在 `a` 里
```

不需要新关键字，也没有分配作用域：一个调用做什么从不取决于它的调用者。每个内存块在 16 字节前缀中记录自己的所有者，所以释放总是回到分配它的分配器，无论在哪个线程。安全规则见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md#显式分配器)；完整指南见 [EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)。

### Copy

`Copy` 是 prelude 中的标记 trait，表示一个值的复制就是按位复制。它要求 `Clone`，与 Rust 的 `Copy: Clone` 一样：这个 trait 声明为 `Copy :: trait(where(Self <: Clone))`，所以每个 `Copy` impl 旁边都需要一个 `Clone` impl，而 `where(T <: Copy)` 让泛型函数体可以调用 `x.clone()`。整数、浮点数、`bool`、`char`、`unit`、`str` 视图和裸指针两者都实现；`Option(T)` 与 `Result(T, E)` 在载荷实现它们时也实现。具名类型通过 `derive(T, Copy, Clone)` 选择加入，泛型类型则加上 `where` 约束：

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);

Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
derive(generic(T : Type), where(T <: Clone), Pair(T), Clone);
derive(generic(T : Type), where(T <: Copy), Pair(T), Copy);

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // 复制：`p` 仍然可用
  r := p.clone(); // 派生的 clone；对 Copy 类型来说就是复制
});
export(main);
```

这个 impl 会被检查。必须有一个覆盖相同实例化的 `Clone` impl，而编译器从不替你写：单独的 `derive(T, Copy)` 是错误，错误信息会给出 `derive(T, Copy, Clone)`。每个字段和变体载荷都必须是 `Copy`，错误信息会指出第一个不是的部分（`String` 字段：`holds a move-only value in its field \`name\``）。实现了 `Drop` 的类型不能是 `Copy`（无论两个 impl 的先后顺序），引用类型也不能。`derive(T, Clone)` 总是允许的（对 `Copy` 字段逐字段克隆就是按位复制），这也是只在约束下才是 `Copy` 的类型在每个实例化上获得 `clone()` 的写法：`derive(generic(T : Type), where(T <: Clone), Pair(T), Clone)`——派生的 clone 会对字段调用 `.clone()`，所以需要这个约束——再加上 `derive(generic(T : Type), where(T <: Copy), Pair(T), Copy)`，使 `Pair(i32)` 被隐式复制，`Pair(String)` 被显式克隆。只有在 impl 服务的每个实例化都是 `Copy` 的类型上（例如具体的 `Copy` 类型），手写的 `Clone` impl 才是错误；同时服务于非 `Copy` 类型的泛型 impl（例如 prelude 中 `Option(T)` 的）是允许的。元组、`Array(T, N)`、匿名记录、闭包和 `fn` 指针没有可以标注的声明，所以它们在所有组成部分都是 `Copy`（`Clone`）时才是 `Copy`（`Clone`）。当它是 `Copy` 时，`x.clone()` 就是复制，所以对 `fn` 指针可以写 `f.clone()`；是 `Clone` 但不是 `Copy` 的记录或闭包按字段克隆：`Copy` 的部分被复制，其余部分被克隆。闭包的组成部分就是它的捕获记录，与 Rust 相同：按值捕获按其自身类型计算（列出的 `{ s }`，以及隐式捕获——绑定到名字的闭包拥有它捕获的东西），`&` 捕获是指针，因此是 `Copy`，`&mut` 捕获使闭包既不是 `Copy` 也不是 `Clone`。所以拥有 `String` 的闭包是 `Clone` 而不是 `Copy`：`d := c` 会移动它，`c.clone()` 则得到持有自己 `String` 的第二个闭包。`Rc`、`Arc`、`String`、各种集合和 `Dyn` 永远不是。裸指针的 `p.clone()` 复制的是指针本身，而不是它指向的值；如果被指向类型的字段与指针自身的方法同名（`clone`、`add`、`sub`、`offset_from`），`p.m(...)` 是错误，错误信息会给出指向字段的写法 `p.*.m(...)`，对指针的 clone 则给出复制写法 `q := p`。

`Copy` 是规则。不是 `Copy` 的纯数据类型只能显式复制：`q := p` 会移动一个没有 `Copy` 的 `Point`，之后再使用 `p` 就是 E0901，其提示会给出 `derive(Point, Copy, Clone)` 和 `p.clone()`。`&T` 参数或 `match` 绑定只是借用这样的值，所以在那里存储或返回它也是 E0901；要拥有它，请按值接受参数（`p : Point`，不写 `&`）。仅编译期类型、`Exception` 之类绑定控制流的记录、union、C 不透明类型，以及 `Copy` 类型的精化类型，仍然隐式复制。

### 只能移动的值

资源（文件描述符、锁、套接字）是不能被复制的值：两份副本会把它释放两次。实现了 `Drop` 的值类型（`struct`、`enum`、`newtype`）是**只能移动的**（move-only），既不是 `Copy` 也不是 `Clone` 的纯值类型也是（必须保持唯一的令牌不需要 `Drop`：两者都不声明即可），包含这种值的每个值也是：结构体字段、枚举载荷、元组或数组元素、闭包捕获。`Option(Fd)` 和 `Tuple(Fd, i32)` 都是只能移动的。计数句柄（`Rc`、`Arc`）无论包含什么都不是，因为它的副本共享同一个单元；其载荷的 `Drop` 在计数归零时运行一次。

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`)) // 真实的实现会关闭这个描述符
  )
);

peek :: (fn(f : &Fd) -> i32)(f.n); // `&T` 参数是借用：不复制
keep :: (fn(f : Fd) -> unit)(()); // 按值参数把值移动进来

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  n := peek(&a); // 借用；`a` 仍可使用
  b := a; // 把 `a` 移动到 `b`
  // a.n           // E0901：使用了被移动的值：`a`
  keep(b); // 移动 `b`；`keep` 返回时把它 drop
});
export(main);
```

每个复制点都会移动只能移动的值：`:=`、`=`、`sink` 实参、字段或元素写入、构造器实参、返回以及闭包捕获。移动之后再使用就是 E0901，其说明会指出该类型为什么只能移动。只能移动的值也不能从并不拥有它的存储中复制出来：`&T` 参数以及 `match`/`for` 绑定只是借用它，字段属于其持有者（没有部分移动），模块级绑定永远不会被移动。在 `cond`/`match` 的部分分支中被移动的值，会在每个保留它的分支末尾被 drop，所以在各分支汇合处它在每条路径上都已不存在，之后再使用就是 E0901（这是 Rust drop 标志的静态形式：分支是结构化的，不需要运行时标志）。在循环的各个出口汇合处，值仍然必须要么在所有出口上都被移动，要么都不被移动（E0907）。赋值语句（`x = y;`、`h.f = y;`、`xs(i) = y;`）会在写入后立即 drop 旧值，与 Rust 一致；`old := (x = y)` 则把旧值保存在 `old` 中。它唯一的所有者在 drop 它时恰好运行一次 `drop`，然后 drop 它的字段。实现了 `Clone` 的类型用 `x.clone()` 显式复制；要共享一个值，请把它放在引用类型之后。

要把字段从一个仍然存活的持有者中移出，请使用 `std/mem`（即 Rust 的 `std::mem`）：`replace(&mut h.f, v)` 写入 `v` 并返回旧值，`take(&mut h.f)` 写入 `T` 的默认值（`where(T <: Default)`）并返回旧值，`swap(&mut a, &mut b)` 交换两个位置的值。它们都按位移动，因此只能移动的值既不会被复制，也不会被 drop 两次。它们位于独立的模块而不是 prelude 中，所以这些名字仍可用于你自己的定义：`{ replace, take, swap } :: import("std/mem");`。

泛型函数在每次实例化时检查：`ArrayList(Fd).get(i)` 会把元素复制出来，所以这个实例化是 E0901，报告在调用处。集合元素改为按位置访问：`xs(i)` 原地读取元素，`xs.with(i, (v) => …)` 以 `&mut` 借用元素运行一段代码并返回其结果，`xs.take(i)` 把元素移出并留下 `T` 的默认值，`xs.swap(i, j)` 交换两个元素，`std/mem` 的 `replace(&mut xs(i), v)` 移入新值并移出旧值。每个会复制的访问器都有一个用于实现了 `Clone` 的元素的克隆版本：`ArrayList` 的 `get_cloned`、`first_cloned` 和 `last_cloned`；`Deque` 的 `get_cloned`、`front_cloned` 和 `back_cloned`；各种映射的 `get_cloned`，以及 `get_key_value_cloned`（`HashMap`）、`get_index_cloned`（`OrderedMap`）和 `first_entry_cloned`/`last_entry_cloned`（`BTreeMap`）；`PriorityQueue` 的 `peek_cloned`。`xs.extend(ys)` 会消耗 `ys`；`xs.extend_cloned(&ys)` 追加克隆并保留它。`Option` 和 `Result` 的 `unwrap`、`expect`、`unwrap_or`、`unwrap_or_else`、`unwrap_or_default`、`unwrap_err` 和 `expect_err` 会消耗接收者，因此 `make().unwrap()` 能把只能移动的载荷移出。

### std 的资源是只能移动的

`std/` 中的资源是只能移动的值：`File`、`TempDir`、`TempFile`、`Watcher`、`TcpStream`、`TcpListener`、`UdpSocket`、`UnixStream`、`UnixListener`、`TlsStream`、`HttpClient`、`Child` 及其管道句柄（`ChildStdin`、`ChildStdout`、`ChildStderr`）、`Thread`，以及拥有其中之一的 `BufReader`/`BufWriter`。每个都是状态存放在 `Box` 里的结构体，因此句柄可以移动，而 future 或运行时仍持有状态的地址。丢弃句柄即释放资源：描述符被关闭、临时文件被删除、监视被停止、线程被分离。`std/sync` 原语（`Mutex`、`RawMutex`、`RwLock`、`Cond`、`Barrier`、`Semaphore`、`WaitGroup`、`Once`、`OnceCell` 以及 `Atomic*` 类型）同样是只能移动的值，跨线程时以 `Arc(Mutex(T))` 的形式共享；`Channel(T)` 是持有队列 `Arc` 的值，`ch.clone()` 是该队列上的另一个句柄。

- **复制是 E0901。** `g := f` 移动文件，之后再使用 `f` 是 E0901（使用已移动的值）。把一个句柄存两次、或在两个闭包中捕获它，同样是 E0901。在这次改动之前，`File` 是引用句柄，副本共享它的描述符和位置。
- **借出它。** 每个方法都取 `self : &Self`，所以 `f.read_to_string(io)` 借用 `f`。只使用资源的函数取 `&File`。
- **通过引用类型共享。** 在单个线程内，`Rc.new(f)` 得到 `Rc(File)`，它的所有句柄都指向同一个文件（`h.*.read_to_string(io)`）。跨线程时用 `Arc(Mutex(TcpStream))`；这要求资源是 `Send` 的：各种套接字、`File`、临时文件、`Child` 及其管道和 `Thread`（`File`、临时文件和 `UnixListener` 持有 `String` 路径，自 B8 起它是值类型）。`Watcher`、`TlsStream` 和 `HttpClient` 留在自己的线程上。持有资源的 `ref` 结构体出于同样的原因把它存为 `Rc` 字段，就像 `HttpServer` 持有它的监听器那样。
- **把它移出来。** `Option(T).unwrap` 通过借用读取，不能把只能移动的载荷移出来。改用消耗型 match：`f := match(opt, .Some(x) => x, .None => …)`。
- **交出所有权。** `BufReader(File).new(f)` 和 `TcpListener.incoming()` 取得所有权（`sink`）；`get_ref()` 和 `Incoming.listener()` 把它借回来，`BufReader.into_inner()` / `BufWriter.into_parts()` 按值把它交还。要在派生的任务中服务一个套接字，把它移入该任务。
- **丢弃即释放。** 未经 `wait()` 就被丢弃的 `Child` 会关闭它仍持有的管道端（但不等待进程）。

每个 I/O 方法的 future 都借用资源直到完成，因为它使用的描述符会在资源被丢弃时关闭。这包括上述资源上的所有读、写、`close`、`flush`、`set_len`、`metadata`、`accept`、`connect`（UDP）、`send`/`recv`、`shutdown` 和套接字选项，`BufReader.read_line`，`Child.wait` 及其管道读写，`HttpClient.fetch`，`Watcher.next`，`Reader`/`Writer` 的默认方法（`read_to_end`、`read_to_string`、`write_all`），以及基于它们的自由函数（`io.copy`、`read_http_message`）。借用型 future 遵守 §3.13 A2 的规则：

- 在创建它的地方 await。它不能被绑定到名字、被 spawn 或被返回（E0909）。
- 它的 effect bundle 必须是一个位置。写成 `b := IoExn(io : io, exn : exn); io.await(f.read_to_string(io), b)`；在 `io.await` 里内联 `IoExn(...)` 是 E0910。
- 被借用的资源不能位于 `Rc` 载荷之内或指针解引用之后（E0909）：改为借出句柄。

出于同样的原因，没有 `Dyn(Reader)` 和 `Dyn(Writer)`。这两个 trait 的默认方法（`read_to_end`、`read_to_string`、`write_all`）返回借用 reader 或 writer 的 future，而 vtable 的 future 类型不携带借用，因此对任何实现者，把 `dyn(r)` 当作这两种 trait 对象都是 E0909。请改用泛型 `Impl(Reader)` / `Impl(Writer)` 参数。

### 析构函数：`Drop`

`Drop` 是析构 trait，其方法 `drop` 采用 Rust 的语义：析构函数会自动运行且恰好运行一次——在所有者 drop 该值时，或在最后一个 `Rc`/`Arc` 引用消失时；实现它的值类型是只能移动的。它的接收者与 Rust 的 `drop(&mut self)` 一致：`drop : (fn(self : &mut Self) -> unit)`，因此析构函数可以在字段被 drop 之前把某个字段取出或重置（`self.f = .None`），而声明为 `self : &Self` 的 impl 不符合该 trait。

手动调用析构函数是错误 E0915，与 Rust 相同：`x.drop()`、`Fd.drop(&x)` 和 `(Fd <: Drop).drop(&x)` 会在值仍然存活时再运行一次析构函数。把它当作值读取（`f := Fd.drop`）也是 E0915，因为通过 `f` 调用会造成同样的结果。其他 trait 中恰好名为 `drop` 的方法是普通方法，可以直接调用，也可以通过 `Dyn` 调用。析构函数也不调用其字段的析构函数：字段会在它返回后自行 drop。要提前结束一个值，请把它传给 prelude 的 `drop(x)`：它把值移入，并在调用返回时 drop 它；之后再使用 `x` 是 E0901。

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`))));

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  drop(a); // 现在打印 "closing 3"
  // a.drop()      // E0915：显式调用析构函数
  // a.n           // E0901：使用已移动的值 `a`
});
export(main);
```

必须在其他引用可能仍然存活时就释放的资源，提供一个普通方法供析构函数委托，例如 `TcpStream.close_sync()`。

## Box：唯一所有的单元

`Box(T)` 是只有一个所有者、没有引用计数的堆单元，类似 Rust 的 `Box<T>`。递归类型和
需要稳定地址的值使用它；值需要共享时使用 `Rc`。

```yo
Tree :: enum(
  Leaf(v : i32),
  Node(l : Box(Self), r : Box(Self))
);
sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*))
  )
);
t := Tree.Node(Box.new(Tree.Leaf(1)), Box.new(Tree.Leaf(2)));
assert(sum(&t) == 3);
```

- **`Box.new(v)`** 把 `v` 移入一个新单元。`b.*` 是载荷的位置，在安全代码中同样可用：
  `b.* = v` 替换载荷，`b.field` / `b.method()` 通过自动解引用访问载荷。模式用 `Box(p)`
  穿过 `Box` 的载荷进行匹配，与用 `Rc(p)` 穿过 `Rc` 相同；目前不写 `Box(…)` 也会穿透。
- **显式复制。** `Box` 永远不是 `Copy`。当 `c := b` 是 `b` 的最后一次使用时，它移动
  `b`；其他任何复制都是 E0901。`Box.clone(b)` 是深拷贝：一个持有载荷克隆的新单元
  （`b.clone()` 是 E0616，因为载荷可能有自己的 `clone`）。`T` 实现 `Clone` 时
  `Box(T)` 才实现 `Clone`，所以装着仅可移动值的 `Box` 也是仅可移动的。
- **一次释放。** 丢弃 `Box` 时会丢弃其载荷并释放单元。`ref_count(b)` 是编译错误：
  它没有计数。
- **移出载荷。** `b.into_inner()` 消耗 `Box`、释放单元并返回载荷，因此仅可移动的载荷
  无需复制即可离开单元（`RefCell.into_inner` 和 `BufWriter.into_parts` 用的就是它）。
- **`Eq`、`Hash` 和 `Default`** 比较、哈希和构造的都是载荷。`T` 是 `Send`/`Sync`
  时 `Box(T)` 才是。
- **布局。** `Box` 值是一个指针，`Option(Box(T))` 也是一个指针（`NULL` 即
  `.None`）。全局单元就是载荷本身，与 Rust 一样占 `size_of(T)` 字节，零大小的载荷不分配任何内存。由 `alloc` 参数放置的单元在载荷前带有 16 字节的所有者前缀，记录放置它的分配器，句柄用指针的第 0 位标明这一点（每个单元至少按 16 字节对齐，所以这一位是空闲的）。`Box` 的载荷可以是非定长类型（`comptime(V) : ?Sized`）：`Box([T])` 或 `Box(Dyn(T))` 的句柄是两个字。
- **分配器。** `Box.new(v, alloc : .Some(a))` 把单元放在 `a` 中；不传 `alloc` 时单元
  使用全局分配器。单元通过其所有者释放，
  `Box.clone(b)` 落在 `b` 所在的位置（由显式分配器放置的 box 克隆到同一个分配器中）。
  `Box.allocator(b)` 读回所有者（全局分配器为 `.None`）。
- **环。** `Box` 是其所有者的值的一部分，所以经由 `Box` 闭合的 `Rc` 环就是这些
  `Rc` 单元的环：与其他环一样会泄漏，除非用 `Weak` 打破。

## Rc 和引用计数单元

Yo 提供了 `Rc`（用 `Rc.new` 构造）用于将值类型堆分配并自动进行引用计数。

### Rc 类型

> **⚠️ `Rc` 对应 Rust 的 `Rc`，而不是 Rust 的 `Box`。** Rust 的 `Box<T>` 是唯一
> 所有者——传递即移动，克隆即深拷贝。Yo 的 `Rc(T)` 是计数句柄：`Rc.clone(a)`
> **产生指向同一个堆上值的第二个句柄并增加引用计数**，与 Rust 的 `Rc::clone`
> 完全一致。
>
> ```yo
> a := Rc.new(i32(42));
> b := Rc.clone(a);          // 第二个句柄，而不是值的副本
> assert(ref_count(a) == usize(2), "a 和 b 指向同一个值");
> ```
>
> **第二个句柄要显式写出**：句柄是新的
> 所有者，所以共享在创建处可见。句柄的最后一次使用会移动它（`b := a` 之后不再
> 使用 `a`）；源值之后仍被使用的隐式拷贝是 E0901，其提示写出 `Rc.clone(a)`。
> `&Rc(T)` 形参借用句柄而不拷贝。持有句柄的值（结构体字段、`Option(Rc(T))`）
> 用 `.clone()` 拷贝，它会克隆每个句柄；闭包在捕获列表里取得第二个句柄：
> `{ a : Rc.clone(a) }() => a.*`。克隆通过类型来写（`Rc.clone(a)`），因为 `a.clone()` 可能指
> 负载自己的 `clone`。`Rc(T)` 和 `Arc(T)` 对任何 `T` 都实现 `Clone`，
> 克隆总是第二个句柄；深拷贝写作 `Rc.new(h.*.clone())`。泛型函数体按每个实例化检查，所以当 `T` 是
> 句柄时，在那里拷贝 `T` 同样要写 `.clone()`（`where(T <: Clone)`）。std 的泛型
> 读取方法也同样检查：`ArrayList(Rc(T)).get(i)`、`HashMap.get` 通过 `T` 拷贝元素，
> 所以元素是句柄时，这个调用就是 E0901，报在你的调用处，std 内的位置作为附注。
> 请用不拷贝的访问器读取句柄元素：原地读取 `xs(i)`、用 `xs.get_cloned(i)` 取得
> 第二个句柄，或 `xs.with(i, ...)`。
>
> 实际影响：共享是隐式的；`Rc` 形成的环若不打破就会泄漏（Rust 的 `Box` 根本无法
> 形成环；`Weak` 回边可以打破它，见 [Weak：不拥有的句柄](#weak不拥有的句柄)）；用
> `ref_count(b)` / `Rc.try_unwrap` 来询问唯一性。
>
> `Box` 是另一种类型：唯一所有、不计数的单元，类似 Rust 的 `Box<T>`
> （[Box：唯一所有的单元](#box唯一所有的单元)）。

`Rc(T)` 是一个泛型单元类型，可以包装任何值类型：

```yo
// Rc 定义在 std/prelude.yo 中
Rc :: (fn(comptime(V) : ?Sized) -> comptime(Type))(
  newtype(_cell : __yo_cell(V))
);
```

构造函数是 `Rc(T).new(value, (alloc : Option(Allocator)) ?= .None)`。它分配一个计数为 1
的新单元；计数用 `ref_count(x)` 读取。`Rc.new(v)` 从实参推断 `T`，`Box.new(v)` 和
`Arc.new(v)` 也一样；实参不携带类型时（例如枚举简写 `.None`、闭包字面量）写出类型：
`Rc(T).new(...)`。`alloc : .Some(a)` 把单元放到分配器 `a` 中；默认值 `.None` 把它放到
全局分配器（[EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)）。`dyn(Rc.new(v))`
在一个新的单元之上构造 `Rc(Dyn(Trait))`（[TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)）。

### 使用示例

```yo
// 包装一个基本值
i := Rc.new(42); // i: Rc(i32)
assert(i.* == 42); // 使用 .* 解引用
// 包装一个结构体
Point :: struct(x : i32, y : i32);
p := Rc.new(Point(x : 3, y : 4)); // p: Rc(Point)
assert(p.*.x == 3);

// 使用显式类型的 Rc
b := Rc(i32)(100); // 等同于 Rc.new(100)
// 载荷经由句柄是只读的（E0919）；通过“门”写入
m := Rc.new(i32(10));
Rc.make_mut(&mut m) = i32(20); // 原地写入：m 是唯一的句柄
assert(m.* == 20);
```

### Rc 与赋值

重新赋值要求绑定以 `mut` 声明，而赋值表达式的值是句柄的**旧值**：

```yo
{ assert } :: import("std/assert");

test("Rc assignment behavior", {
  mut(x) := Rc.new(1);
  y := (x = Rc.new(2)); // y 获得旧值
  assert(x.* == 2); // x 现在指向新的 Rc
  assert(y.* == 1); // y 持有旧的 Rc
});
```

### Rc 与引用计数

`Rc(T)` 使用自动引用计数；第二个句柄写作 `Rc.clone`：

```yo
{ assert } :: import("std/assert");

test("Rc reference counting", {
  original := Rc.new(42);
  copy := Rc.clone(original); // 引用计数递增
  another := Rc.clone(copy); // 引用计数递增
  // 三者都指向同一个 Rc
  assert(original.* == 42);
  assert(copy.* == 42); // 共享的！
  assert(ref_count(another) == usize(3));

  // 变量离开作用域时引用计数递减
});
```

### 修改共享载荷：`RefCell`、`Rc.get_mut`、`Rc.make_mut`、`Rc.try_unwrap`

`Rc` 的载荷是共享的，因此**通过句柄只能读取**，与 Rust 相同。通过 `Rc` 的写入（`h.n = v`、`h.* = v`、`bump(&mut h.n)`、`h.items.push(v)`）是错误 E0919，错误信息会列出下面这些入口（`yo explain E0919`）：

- **`RefCell(T)`**（`std/sync/refcell`）是共享修改的载荷：`Rc(RefCell(T))`。访问限定在闭包内，与 `Mutex(T)` 相同：`with(v => ...)` 借出 `v : &T`，`with_mut(v => ...)` 借出 `v : &mut T`，二者都返回闭包的结果。Rust 的按值移动方法不向调用者借出任何东西：`replace(v)` 和 `take()`（要求 `T <: Default`）存入新值并返回旧值，`replace_with(v => ...)` 存入闭包根据 `v : &T` 算出的新值并返回旧值，`into_inner()` 消耗这个单元。与 Rust 的 `replace_with`（闭包是 `FnOnce(&mut T) -> T`）不同，这里的闭包是借到 `&T` 的 `Fn`，与 `with` 闭包体相同。多个 `with` 闭包体可以同时运行；`with_mut`（以及 `replace_with` 的闭包）只能单独运行，运行期间的冲突访问会 panic，与 Rust 的 `RefCell::borrow_mut` 相同。闭包体返回或 unwind 时标记被释放。`RefCell` 在 `T` 是 `Send` 时是 `Send`，但永远不是 `Sync`，因此 `Arc(RefCell(T))` 会被拒绝（跨线程请共享 `Arc(Mutex(T))`）。它也可以放在普通值中，此时可以通过 `&` 借用进行写入。

  ```yo
  { RefCell } :: import("std/sync/refcell");
  log := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(log); // 指向同一个单元的第二个句柄
  other.replace_with(n => (n + i32(1)));
  assert(log.with(n => n) == i32(1), "seen through the first handle");
  ```

- **`Rc.make_mut(&mut h)`**（`T <: Clone`）是被写入的载荷：若另一个句柄共享该单元，`h` 先移到一个持有载荷克隆的新单元，因此其他句柄永远看不到这次写入。若 `h` 是唯一句柄，则就地写入。即 Rust 的 `Rc::make_mut`；克隆体现在名字里。

  ```yo
  a := Rc.new(Point(x : 1, y : 2));
  b := Rc.clone(a);
  Rc.make_mut(&mut b).x = 10; // b 得到自己的单元
  assert((a.x == 1) && (b.x == 10), "a is unchanged");
  ```

- **`Rc.try_unwrap(h)`** 消耗该句柄：若它是唯一句柄，返回 `.Ok(payload)`（单元被释放），否则返回 `.Err(h)`，即原句柄。它不需要 `Clone`。
- **`Rc.get_mut(&mut h)`** 在没有其他 `Rc` 或 `Weak` 共享该单元时为 `.Some(&mut T)`，即指向单元内部的引用，否则为 `.None`；它从不克隆，因此不需要 `Clone`。即 Rust 的 `Rc::get_mut`。

  ```yo
  h := Rc.new(i32(1));
  match(
    Rc.get_mut(&mut h),
    .Some(v) => {
      v.* = i32(2);
    },
    .None => ()
  );
  assert(h.* == i32(2), "the only handle writes in place");
  ```

这些入口与 Rust 一样通过类型调用，因此载荷上同名的方法仍可用 `h.name()` 调用。`Arc` 有同样的 `Arc.get_mut`、`Arc.make_mut` 和 `Arc.try_unwrap`（[ARC.md](./ARC.md)）。

### Weak：不拥有的句柄

`Weak(T)` 对应 Rust 的 `rc::Weak<T>`：`Rc.downgrade(&h)` 创建一个指向该单元、但不让载荷保持存活的句柄；
只要还有指向它的 `Rc`，`w.upgrade()` 就是 `.Some(handle)`，最后一个 `Rc` 消失后为 `.None`。最后一个 `Rc`
释放载荷，任一种类的最后一个句柄释放单元。`Weak` 没有 `Deref`，是显式复制的（`Weak.clone(&w)`），也不是
所有权图中的边，因此父指针 `Weak(RefCell(Node))` 不会闭合环。见 [WEAK.md](./WEAK.md)。

```yo
a := Rc.new(i32(7));
w := Rc.downgrade(&a);
assert(w.upgrade().is_some(), "alive while a is");
consume(a);
assert(w.upgrade().is_none(), "the last Rc dropped the payload");
```

### 何时使用 Rc

- **堆分配**：当你需要将值类型放在堆上时
- **共享所有权**：同一个值的多个句柄；共享修改通过 `Rc(RefCell(T))` 进行
- **共享的动态分发**：`dyn(Rc.new(v))` 构造一个 `Rc(Dyn(Trait))`，即多个句柄共享的一个 trait 对象；唯一所有的则是 `dyn(Box.new(v))`
- **递归类型**：仅当节点被共享时；唯一所有的节点组成的树使用 `Box`

```yo
impl(i32, SomeTrait(...));
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({ ... });

// 一个 i32 放在共享的 trait 对象后面
(shared : Rc(Dyn(SomeTrait))) = dyn(Rc.new(i32(42)));
use_dyn(&shared.*);
```
