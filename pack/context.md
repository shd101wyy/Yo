# Yo — context pack for coding agents

pack-version: 4 — shipped with the toolchain; `yo context` prints this file.
It covers the LANGUAGE only. APIs come from `yo context --list` (modules),
`yo context <module> [name]` (signatures, docs) and
`yo context --search <query>` (ANDed keywords). Examples are `yo fmt`-clean,
complete programs compile and run, and rejected code names its error code.

## What Yo is

A statically typed, expression-oriented language compiled to C11, with no
garbage collector: every value has one owner, the last use of a value moves
it, copies are explicit (`.clone()`) except for `Copy` types, and a
compile-time borrow checker checks every reference (`&T`, `&mut T`), whose
type carries an origin. `Rc(T)` and `Arc(T)` are the only shared handles.
Async is single-threaded per thread (an event loop, like JavaScript's or
tokio's `current_thread`); threads are a separate, explicit runtime. There is
no operator precedence and no overloading, and diagnostics carry repairs.

## The toolchain loop

```bash
yo check main.yo           # type-check; run after EVERY edit
yo fix main.yo             # apply the repairs the diagnostics carry
yo explain E0901           # a diagnostic's full explanation, offline
yo compile main.yo -o app  # full pipeline: emit C, run the C compiler
yo test ./tests            # run *.test.yo files
yo fmt file.yo             # format; --check verifies
yo build                   # a project: build.yo + yo.toml (yo init creates both)
```

- `check` reports errors in `test(...)` bodies only with `--test-bodies`;
  `--watch` re-checks only what changed; `--error-format json` emits spans
  and repairs.
- One rule fires only in codegen (a hollow `io.async` body, E0905): gate async
  code with `yo compile main.yo --skip-c-compiler`.

## Syntax essentials

```yo
{ assert } :: import("std/assert");

grade :: (fn(s : i32) -> str)(
  cond(
    (s >= i32(90)) => "A",
    (s >= i32(60)) => "B",
    true => "F" // `true` closes a cond
  )
);

main :: (fn() -> unit)({
  a := i32(2);
  b := i32(3);
  y := ((a + b) * i32(4)); // no precedence: group mixed operators
  z := (a - b - i32(1)); // one operator chains left: ((a - b) - 1)
  r := .{ x : a, y : b }; // `.{ ... }` is a record value
  { x, y : ry } := r; // `{ names }` on a binding side picks fields
  v := {
    t := (x + ry);
    t * i32(2) // any other `{ ... }` is a block; it yields its tail
  };
  if(z < i32(0), assert((v == i32(10)) && (grade(y) == "F"), "cond"));
});
export(main);
```

- A function is `name :: (fn(a : A) -> R)(body);`: the parenthesized type,
  then the body. `::` binds at compile time, `:=` at run time; module-level
  `::`, `impl` and `derive` are order-independent. Only `export`ed names leave
  a module; `main` returns `unit` and is exported.
- Parenthesize wherever two different operators meet, including the right side
  of `:=`, `=` and a field's `:` (`x := (a + b);`, `.{ x : (a + b) }`), or it
  is E0003.
- A bare `{ ... }` in expression position is a block (`{}` is unit); a `,` or
  `label : value` inside one is E0007. `(a, b)` is a tuple, `Tuple(A, B)` its
  type.
- Control flow is calls: `cond(...)`, `match(...)`, `while(c, body)`,
  `return(v)`, `return()`, `unwind(v)`; `break`/`continue` are bare; `if(c, a)`
  and `if(c, a, b)` are sugar for `cond`. Sibling arms have one type (a block
  ending in `;` is `unit`).
- Integer literals take their type from the slot; otherwise write `i32(1)`.
  Distinct integer types never mix implicitly; `usize(n)` converts. Overflow,
  division by zero and out-of-bounds indexing trap (`wrapping_add` wraps).

## Types, traits, generics

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt"); // brings the ToString derive rule
{ String } :: import("std/string");

Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone, Eq(Point), ToString);

Norm :: trait(
  norm1 : (fn(self : &Self) -> i32)
);
impl(
  Point,
  Norm(norm1 : (fn(self : &Self) -> i32)((self.x.abs() + self.y.abs())))
);
impl(
  Point,
  flip : (fn(self : Self) -> Self)(Point(x : self.y, y : self.x)) // inherent
);

// A generic function: T is inferred from the argument.
describe :: (fn(generic(T : Type), x : &T, where(T <: ToString)) -> String)(
  `<${x.to_string()}>`
);

main :: (fn() -> unit)({
  p := Point(x : i32(3), y : i32(-4));
  q := p; // Copy: p stays usable
  assert((p == q) && (p.flip().norm1() == i32(7)), "copied; methods");
  assert(describe(&p).len() > usize(2), "generic call");
});
export(main);
```

- Constructors take named fields. Variants are declared without a dot
  (`enum(Leaf, Node(v : i32))`) and built or matched with one (`.Some(v)`). A
  type names itself `Self` in its definition (`next : Option(Box(Self))`).
- No overloading; operators are trait methods (`Eq`, `Ord`, `Add`, ...).
- Derivable: `Copy` (with `Clone`), `Clone`, `Eq(T)`, `Ord(T)`, `Hash`,
  `Default`, `ToString` and `Debug` (import `std/fmt` first), `Error` (import
  `std/error`).
- `impl(...)` statements end with `;`. A generic impl:
  `impl(generic(T : Type), where(T <: ToString), Box(T), ...)`.
- A generic type is a compile-time function, used as `Pair(i32)`:
  `Pair :: (fn(comptime(A) : Type) -> comptime(Type))(struct(a : A, b : A));`

## Ownership: values by default

- **Three kinds of type.** `Copy` (integers, floats, `bool`, `&T` and
  types you `derive(T, Copy, Clone)`) copies bit for bit. Explicit-copy
  (`String`, collections, `Box`, `Rc`, `Arc` and types holding them) copies
  only through `x.clone()`. Move-only (no `Clone`, or a `Drop` impl: files,
  locks, `&mut T`) never copies.
- **The last use moves.** `y := x`, a by-value argument, a store, a capture
  and a return move a non-`Copy` value; a later use is E0901, whose help names
  the repair. There are no partial moves: copy the field, borrow it, or move
  the whole value through a `match` struct pattern.
- **Bindings are immutable** unless declared `mut(x) := v` /
  `(mut(x) : T) = v` (module-level ones too). Reassigning, lending `&mut`,
  calling a `&mut self` method or writing a field of an unmarked binding is
  E0917.
- **Drops** run at scope end, early exit and reassignment; a destructor is
  `impl(T, Drop(drop : (fn(self : &mut Self) -> unit)(...)))`. `drop(x)` ends
  a value early (`x.drop()` is E0915).

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");

Account :: struct(name : String, balance : i64);
derive(Account, Clone); // String is Clone, not Copy

balance_of :: (fn(a : &Account) -> i64)(a.balance); // reads
deposit :: (fn(a : &mut Account, amount : i64) -> unit)({
  a.balance = (a.balance + amount); // writes the caller's value
});
// Takes ownership; a struct pattern moves the field out of the owned value.
close :: (fn(a : Account) -> String)(
  match(a, { name, balance : _ } => name)
);

main :: (fn() -> unit)({
  mut(acct) := Account(name : `ada`, balance : i64(10));
  deposit(&mut acct, i64(5)); // the call site marks the lend
  b := balance_of(&acct);
  backup := acct.clone(); // an explicit copy
  name := close(acct); // last use of acct: moved
  assert((b == backup.balance) && (name == `ada`), "lent, then moved");
});
export(main);
```

## References and the borrow checker

- **Parameters**: `x : T` by value (copy or move), `x : &T` read-only,
  `x : &mut T` exclusive. The call site repeats the sigil, `f(&x)`,
  `f(&mut x)` (a mismatch is E0914); receivers, temporaries and a reference
  passed whole take none.
- **`.*` names the referent**: `r.*` reads, `r.* = v` writes. Operators do not
  look through references (`n + 1` with `n : &i32` is E0926); fields, methods
  and indexing do (`r.x`, `r.len()`, `r(i)`).
- **Local borrows**: `y := &place`, `y := &mut place`. A borrow is live until
  its last use and freezes its place meanwhile: no write or move under `&`,
  no access at all except through it under `&mut` (E0911). Sibling fields
  borrow independently. `&T` is `Copy`; a `&mut T` moves: `a := m` hands
  `m`'s borrow to `a` and a later use of `m` is E0901, while `a := &mut m.*`
  reborrows and leaves `m` usable after `a`'s last use.
- Writing through `&` is E0908. A later argument may read what an earlier one
  lends (`xs.push(xs.len())`) but not move or `&mut`-lend it; overlapping
  lends with a `&mut` (`s.push_string(&s)`) are E0910.
- A function may return `&T`/`&mut T` rooted at a reference parameter (the
  argument stays frozen while the result lives); a reference to a local cannot
  escape (E0912).
- **Origins** are Yo's lifetimes, usually elided: `-> &(i32, s)` borrows
  only from parameter `s`; `generic(p : Origin)` declares one, and a struct
  holding a reference takes `comptime(p) : Origin`. No reference may live in a
  collection element, a heap cell, a global or another thread.

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

Grid :: struct(a : i32, b : i32);

// A returned reference is rooted at a reference parameter.
larger :: (fn(g : &mut Grid) -> &mut i32)(
  cond((g.a >= g.b) => &mut g.a, true => &mut g.b)
);

main :: (fn() -> unit)({
  mut(g) := Grid(a : i32(1), b : i32(2));
  r := larger(&mut g); // g is frozen until r's last use
  r.* = i32(20); // `.*` reads and writes the referent
  assert(g.b == i32(20), "written through the reference");

  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(xs.len())); // a later argument may read xs
  for(&mut xs, x => {
    x.* = (x.* + i32(1)); // each element in place
  });
  xs(usize(0)) = i32(100); // indexing is a place
  assert((xs(usize(0)) + xs(usize(1))) == i32(102), "walked");
});
export(main);
```

- `for(&xs, x => ...)` reads (the body may read `xs`), `for(&mut xs, x => ...)`
  writes in place (the body may not name `xs`), `for(xs, x => ...)` consumes
  `xs`; `for(xs.indices(), i => ...)` walks positions. Maps:
  `for(&m, (k, v) => ...)`.
- `xs(i)` copies out a `Copy` element; `xs.get(i)` is the checked form
  (`Option`); a non-`Copy` element is cloned with `xs.get_cloned(i)` or
  borrowed with `r := xs.index(i)`.
- Rejected:

```yo ignore
mut(x) := i32(1);
y := &x;
x = i32(2); // E0911: `y` borrows `x` and is used below
z := y.*;
peek(x); // E0914 for `peek :: (fn(n : &i32) -> i32)`: write peek(&x)
```

Full rules: `docs/en-US/OWNERSHIP_AND_BORROWING.md`
(`yo context --doc OWNERSHIP_AND_BORROWING`).

## Pattern matching

```yo
{ assert } :: import("std/assert");

Shape :: enum(Circle(r : i32), Rect(w : i32, h : i32), Empty);

area :: (fn(s : &Shape) -> i32)(
  match(
    s, // matching through a reference: bindings are references
    .Circle(r) => (r.* * r.* * i32(3)),
    (.Rect({ w, h }) && (w.* > i32(0))) => (w.* * h.*), // pick fields; guard
    .Rect(_, _) => i32(0),
    .Empty => i32(0)
  )
);

main :: (fn() -> unit)({
  s := Shape.Rect(w : i32(2), h : i32(3));
  assert(area(&s) == i32(6), "rect");
  o := Option(Shape).Some(Shape.Circle(r : i32(1)));
  k := match(&o, .Some(.Circle(_) | .Empty) => i32(1), _ => i32(2)); // borrows o
  m := match(o, .Some(sh) => area(&sh), .None => i32(0)); // consumes o
  assert((k == i32(1)) && (m == i32(3)), "nested or-pattern");
});
export(main);
```

- A match takes its scrutinee like a parameter: an owned non-`Copy` value is
  consumed, `match(&x, ...)` borrows, `match(&mut x, ...)` binds writable
  places (`v.* = ...`), a reference scrutinee binds references.
- Forms: literals, `_`, bindings, nested variants, or-patterns `(a | b)`,
  ranges `(0 .. 10)` / `(0 ..= 9)`, guards `(p && (cond))`, `(whole := p)`,
  tuples, struct patterns, `Rc(p)`, `Box(p)`.
- Exhaustiveness is checked (E0607 names the missing case); an arm that can
  never run is E0608. A bare name binds unless it is a `::` constant in scope.

## Closures

```yo
{ assert } :: import("std/assert");

apply_twice :: (fn(f : Impl(Fn(x : i32) -> i32), x : i32) -> i32)(f(f(x)));

main :: (fn() -> unit)({
  k := i32(10);
  // No capture list: the closure captures what it names, by value.
  assert(apply_twice(x => (x + k), i32(1)) == i32(21), "captured k");

  mut(total) := i32(0);
  (i32(1) .. i32(3)).for_each({ &mut total }(x) => {
    total.* = (total.* + x.*); // a &mut capture writes the caller's local
  });
  assert(total == i32(3), "1 + 2");
});
export(main);
```

- A capture list names every capture: `x` (by value), `&y`, `&mut z`,
  `name : expr` (`{ h : Rc.clone(&h) }`); `{}` captures nothing. Captured
  places stay frozen while the closure lives.
- `Fn` reads its captures, `FnMut` writes them (call it through a `mut`
  binding or `&mut Impl(FnMut(...))`), `FnOnce` moves one out (`Thread.spawn`
  and `io.async` bodies).
- Only `=>` closures capture, and one cannot fill a bare `fn(...)` slot
  (E0605): take `Impl(Fn(...))`.

## Strings, Option, Result, errors

- `"..."` is a reference to static UTF-8 bytes: a parameter takes
  `s : &str`; a function returning a literal is typed `-> str`. A backtick
  literal is an owned `String` with `${expr}` interpolation (`ToString`).
  `String` is a value (`mut(s)` to `push_str`, `.clone()` to copy); indices
  are byte offsets.
- `Option(T)` (`.Some(v)` / `.None`) is absence; `Result(T, E)` is a
  recoverable failure with a real error enum (`derive(E, Error(...))`), never
  `Result(_, String)`. I/O reports failure through the `exn : Exception`
  effect.
- `unwrap`/`expect` are E0611 outside unsafe and test files: `match`, or use
  `unwrap_or`, `map`, ... (`assert`/`panic` from `std/assert` are for bugs).

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt");
{ Error } :: import("std/error"); // brings the Error derive rule

ParseError :: enum(Empty, BadDigit(at : usize));
derive(
  ParseError,
  Error(
    .Empty => `empty input`,
    .BadDigit => `bad digit at ${at}`
  )
);

first_digit :: (fn(s : &str) -> Result(u8, ParseError))({
  if(s.len() == usize(0), return(.Err(.Empty)));
  c := s.bytes(usize(0));
  cond(
    ((c >= u8(48)) && (c <= u8(57))) => .Ok(c - u8(48)),
    true => .Err(.BadDigit(at : usize(0)))
  )
});

main :: (fn() -> unit)({
  v := match(first_digit("7"), .Ok(n) => n, .Err(_) => u8(0));
  e := match(first_digit("x"), .Ok(_) => `ok`, .Err(err) => err.to_string());
  assert((v == u8(7)) && (e == `bad digit at 0`), "parsed, rendered");
});
export(main);
```

## Sharing: Box, Rc, Arc, Weak, RefCell, std/sync

- `Box(T)` is a unique heap cell (`Option(Box(Self))`). `Rc(T)` (one thread) and `Arc(T)` (threads) share one cell; a second handle
  is `Rc.clone(&h)`. Members forward (`h.x`, `h.len()`; `h.*` is the
  payload), which is read-only (E0919): mutate through `RefCell(T)` (`with`,
  `with_mut`), `Rc.make_mut(&mut h)` or `Rc.get_mut(&mut h)`.
- A cycle of strong handles leaks; put a `Weak` on the back edge
  (`Rc.downgrade(&h)`, `w.upgrade()`).
- `Mutex(T)`, `RwLock(T)`, `WaitGroup`, the `Atomic*` types and the other
  `std/sync` types are move-only values. Share one across threads as
  `Arc(Mutex(T))`: give each thread its own `Arc.clone(&a)`, captured by
  value. `RefCell` is single-threaded.
- `Dyn(Trait)` lives behind `Box`, `Rc` or `&`: `dyn(Box.new(v))`.

```yo
{ assert } :: import("std/assert");
{ RefCell } :: import("std/sync/refcell");
{ Mutex } :: import("std/sync/mutex");
{ Thread } :: import("std/thread");

main :: (fn() -> unit)({
  shared := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(&shared); // a second handle to the same cell
  other.with_mut(v => {
    v.* = (v.* + i32(1)); // written through the RefCell door
  });
  seen := shared.with(v => v.*);

  total := Arc.new(Mutex(i32).new(i32(0)));
  mine := Arc.clone(&total); // the spawned thread's own handle
  t := Thread(unit).spawn({ mine }(io : Io) => {
    mine.with_lock(v => {
      v.* = (v.* + i32(1));
    });
  });
  t.join();
  assert((seen == i32(1)) && (total.with_lock(v => v.*) == i32(1)), "shared");
});
export(main);
```

## Effects, async, threads

- An effect is a `ctl(...) -> R` value passed as an ordinary parameter. In its
  handler, `return(v)` RESUMES the caller with `v`; `unwind(v)` DISCARDS the
  continuation and returns `v` from the function that installed the handler.

```yo
{ assert } :: import("std/assert");

Fail :: (ctl(code : i32) -> i32);

checked_div :: (fn(a : i32, b : i32, fail : Fail) -> i32)(
  cond((b == i32(0)) => fail(i32(1)), true => (a / b))
);

or_minus_one :: (fn(b : i32) -> i32)({
  (fail : Fail) = (code -> unwind(i32(-1))); // or_minus_one returns -1
  checked_div(i32(6), b, fail) + i32(100)
});

main :: (fn() -> unit)({
  (zero : Fail) = (code -> return(i32(0))); // the call fail(...) yields 0
  assert(checked_div(i32(6), i32(0), zero) == i32(0), "resumed");
  assert(or_minus_one(i32(0)) == i32(-1), "unwound");
});
export(main);
```

- std's exception effect: `exn := Exception(throw : (e -> unwind(.None)));`
  catches what `exn.throw(dyn(Box.new(err)))` raises (`std/error`).
- Async runs on ONE event-loop thread per thread and a task never migrates:
  async state needs no mutexes or atomics (blocking work goes to
  `spawn_blocking`). `io.async((io : Io) => body)` builds a lazy future that
  `io.await(f, io)` runs once or `io.spawn(f, io)` starts. `io.await`
  suspends only when written in the `io.async` body itself; in a function the
  task calls, it blocks.

```yo
{ assert } :: import("std/assert");
{ yield } :: import("std/async");

double_later :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io); // suspends this task; others run
    n * i32(2)
  })
);

main :: (fn(io : Io) -> unit)({
  a := io.spawn(double_later(i32(1), io), io); // a JoinHandle
  b := io.await(double_later(i32(5), io), io);
  ra := match(a.await(io), .Some(v) => v, .None => i32(0)); // .None: aborted
  assert((ra == i32(2)) && (b == i32(10)), "both tasks ran");
});
export(main);
```

- Threads (`Thread` and `ThreadPool` in `std/thread`, `Channel` in
  `std/sync/channel`) are for CPU parallelism; only `Send` values cross. Each
  thread has its own event loop.

## Unsafe code and FFI

Only a file declaring `pragma(Pragma.AllowUnsafe);` may hold raw pointers
(`addr_of(x)` gives `*(T)`; `&x` never does), dereference them or call C.
Wrap each such operation in `unsafe(...)` (required for C calls) with a
`// SAFETY:` comment.

```yo
pragma(Pragma.AllowUnsafe);
{ strlen } :: import("std/libc/string");
{ assert } :: import("std/assert");

main :: (fn() -> unit)({
  mut(x) := i32(41);
  p := addr_of(x);
  // SAFETY: p points at x, which is live for this whole block.
  unsafe(p.* = (p.* + i32(1)));
  n := unsafe(strlen((*char)("four")));
  assert((x == i32(42)) && (n == usize(4)), "wrote through p");
});
export(main);
```

## Modules, projects, tests

- `{ a, b } :: import("std/...")` picks names, `m :: import("./m.yo")` binds
  the module, `{ ... } :: import("m")` takes everything; a bare `import("m");`
  binds nothing. The prelude is implicit.
- File, directory and package names are kebab-case
  (`std/collections/array-list`); identifiers are `snake_case`/`PascalCase`.
- A field or method named `_x` is private to its module and its
  same-directory siblings (E0405).
- Dependencies live in `yo.toml` (`yo add user/repo`); `yo install` fetches
  them, and `import("dep/...")` resolves through the nearest manifest.
- Doc comments are `//!` (module) and `///` (item).
- Tests live in `*.test.yo` files (`unwrap` is allowed there). `assert` is not
  in the prelude:

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

test("push then len", {
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  assert(xs.len() == usize(1), "one element");
});
```

## Where to look next

- `yo context --list`, then `yo context <module>`: the real API surface.
- `yo explain E0xxx` for any diagnostic; `yo fix` applies its repair.
- The manuals ship with the toolchain: `yo context --docs` lists them,
  `yo context --doc STRINGS` prints one (`docs/en-US/` in the repository).
- Contracts (`requires`, `ensures`, `invariant`) are proved by `yo verify`:
  `yo context --doc FORMAL_VERIFICATION`.
- `yo lsp` (and the VS Code extension) gives hover, completion and go-to.
