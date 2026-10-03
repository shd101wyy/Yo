# Algebraic Effects and Handlers

## Overview

Yo supports **algebraic effects** — one-shot delimited continuations
for control flow. Effects are regular function parameters whose
handler bodies may use `unwind(value)` to discard the continuation, or
`return(value)` to resume it.

The code generation strategy is **evidence passing** — handler
function pointers are passed as extra C parameters.

## Design

| Principle              | Decision                                                 |
| ---------------------- | -------------------------------------------------------- |
| Explicit parameters    | Every fn parameter is passed at every call site          |
| Evidence passing       | Handler fn pointers as C params                          |
| One-shot continuations | `return` resumes, `unwind` discards                      |
| Handler type           | `ctl(args) -> ret` parallel to `fn(args) -> ret`         |
| Escape discipline      | Type-level check via `type_is_control_bound`                |
| Effect polymorphism    | `generic(E : Type.Struct)` + `e : E`                     |
| Effect bundling        | Anonymous structs `{ raise, log }` or named struct types |

## Syntax

### Declaring and using effects

A handler is a **control function**, written `ctl(args) -> ret`:

```rust
// Declare a handler type
Raise :: (ctl(msg : String) -> i32);

// Function that takes the handler as a regular parameter
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`),
    true => (x / y)
  )
);

// Install a handler — annotated to ctl so the body may `unwind`.
// Note: there is no operator precedence in Yo; wrap the lambda in
// extra parens.
(raise : Raise) = (
  msg -> {
    unwind(i32(42));
  }
);

// Call site — explicit parameter passing
result := safe_divide(1, 0, raise);
```

### Continuation control

- **`unwind(value)`** — discards the continuation, returns from the
  enclosing function with `value`.
- **`return(value)`** — resumes the continuation with `value` at the
  effect call site.

```rust
Raise :: (ctl(msg : String) -> i32);

// Unwind handler: discards continuation. The enclosing function
// returns with i64(42).
(raise : Raise) = (
  msg -> {
    println(msg);
    unwind(i64(42));
  }
);

// Resume handler: continues after the effect call with i32(0).
(raise : Raise) = (
  msg -> {
    println(msg);
    return(i32(0));
  }
);
```

### Effect propagation

Functions propagate effects by accepting them as parameters and
forwarding to callees. A function that takes a `ctl`-typed parameter
and forwards it does _not_ itself need to be `ctl` — the unwind
targets the handler's install frame, which is above the propagating
function in the call stack.

```rust
// `wrapper` is plain `fn` even though it forwards a ctl handler.
wrapper :: (fn(x : i32, raise : Raise) -> i32)(
  safe_divide(x, 0, raise)
);
```

#### Install site vs propagation site

`unwind` returns to the frame where the handler was **locally bound**
— that's the install site. A function that received the handler as a
parameter is a **propagation site**: the unwind travels further up the
stack, past it, until it reaches the install frame. Yo decides this
purely by the binding's frame:

| Where the handler value comes from              | Site      |
| ----------------------------------------------- | --------- |
| `(raise : Raise) = …` inside this function body | Install   |
| `r2 := r` where `r` is itself local             | Install   |
| `record.handler` where `record` is local        | Install   |
| `raise : Raise` as a parameter to this function | Propagate |
| A value captured from an outer scope            | Propagate |
| `record.handler` where `record` is a parameter  | Propagate |

Re-binding (`r2 := r`) does **not** change the install site — only the
frame of the innermost binding matters. This is what lets middle-tier
functions stay plain `fn` and lets a single handler be installed once
at the top, then flow through any number of forwarding layers.

#### An unwind skips the code after the call

On its way out, `unwind` releases the values the frames it leaves own (their
`Dispose` impls run), and runs no other code. In the install frame, every
statement after the call that raised is skipped, and so is the rest of every
propagating frame in between. A save/restore of mutable state around the
guarded call therefore never restores on the failure path:

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : String) -> i32);
Ctx :: ref(struct(depth : i32));

parse :: (fn(n : i32, raise : Raise) -> i32)(
  cond((n < i32(0)) => raise(`negative`), true => n)
);

// ✗ the handler is installed HERE, so its unwind exits `try_parse`
try_parse :: (fn(n : i32, ctx : Ctx) -> i32)({
  (raise : Raise) = (msg -> { unwind(i32(-1)); });
  saved := ctx.depth;
  ctx.depth = (ctx.depth + i32(1));
  r := parse(n, raise);
  ctx.depth = saved; // skipped when parse raises
  r
});

main :: (fn() -> unit)({
  ctx := Ctx(depth : i32(0));
  a := try_parse(i32(5), ctx);
  println(`ok: r=${a} depth=${ctx.depth}`); // ok: r=5 depth=0
  b := try_parse(i32(-5), ctx);
  println(`raised: r=${b} depth=${ctx.depth}`); // raised: r=-1 depth=1
});
export(main);
```

Moving the save/restore into a function that only receives `raise` as a
parameter does not help: that frame is a propagation site, and the unwind
passes through it the same way. Put the handler in a helper of its own, so the
unwind ends at the helper and the code after the helper call always runs:

```rust
// ✓ the unwind ends `_parse_or`, never the frame that restores
_parse_or :: (fn(n : i32) -> i32)({
  (raise : Raise) = (msg -> { unwind(i32(-1)); });
  parse(n, raise)
});

try_parse :: (fn(n : i32, ctx : Ctx) -> i32)({
  saved := ctx.depth;
  ctx.depth = (ctx.depth + i32(1));
  r := _parse_or(n);
  ctx.depth = saved; // always runs
  r
});
// try_parse(i32(-5), ctx) now answers -1 and leaves ctx.depth at 0
```

The failure is silent where it happens: the stale state surfaces only in
whatever runs next. That also makes adding a swallowing handler to existing
code a behaviour change. While the error propagated to the top, the state it
left behind was never read; once a handler swallows it, the program keeps
running on that state.

### Effect row polymorphism

Effect-polymorphic functions use `generic(E : Type.Struct)`. The
constraint `Type.Struct` restricts `E` to struct types (single bundle
of effects), and enables auto-flattening of struct fn-ptr fields into
separate C parameters at specialization.

```rust
run :: (
  fn(
    generic(T : Type, E : Type.Struct),
    f : (fn(e : E) -> T),
    e : E
  ) -> T
)(f(e));

effects := { raise : my_raise, log : my_log };
result := run(might_fail, effects);
```

No effects → empty struct `{}`:

```rust
result := run(pure_func, {});
```

### Async + effects

`Future` is parameterised by the return type plus zero or more effect
type arguments. Each effect arg should itself be a struct type (or a
generic E bound to one), so that callers can pass a struct value
containing the actual handlers:

```rust
// Single bundle (most common)
fut1 : Impl(Future(i32, IoExn)); // IoExn = { io, exn }
y := io.await(fut1, { io, exn });

// Single-effect future — pass the effect value directly
fut2 : Impl(Future(i32, Io));
x := io.await(fut2, io);
```

The closure passed to `io.async` must pin `e`'s type — the inferencer
cannot derive it from the bare closure literal. Use `typeof(effects)`
at top-level call sites, or rely on the enclosing function's annotated
return type when the closure is inside a function body:

```rust
effects := { raise, log };

// Top-level: annotate e with typeof(effects).
fut := io.async((e : typeof(effects)) => {
  e.raise(`err`);
  e.log(`hello`);
});

result := io.await(fut, effects);
```

```rust
{ Exception, IoExn } :: import("std/error");

// Inside a function with annotated return type — the return type
// pins E, so `(e)` without an annotation is fine:
do_work :: (fn(io : Io) -> Impl(Future(unit, IoExn)))(
  io.async(e => {
    e.io.await(some_io_call(...), e.io);
    e.exn.throw(...);
  })
);
```

Width matching is **strict** — Yo structs are nominal. If a caller
holds `e : IoExn` but a nested future only needs `Io`, project:

```rust
// fut needs Io; project to e.io
result := io.await(fut, e.io);
```

## Typing rules for control functions

A `ctl(args) -> ret` value is a **control function** — its body may
contain `unwind`, and its value is bound to the frame where it was
locally installed.

1. **`unwind` placement.** `unwind(value)` is valid only inside a
   `ctl(...) -> ret` body. A `fn(...) -> ret` body containing `unwind`
   is a type error.

2. **Inline lambda annotation.** An inline lambda whose body contains
   `unwind` needs an explicit `ctl(...)` target — supplied by the
   binding's typed LHS or written on the lambda. Inference is not
   performed from body content.

3. **Closures cannot be control functions.** A closure body (one that
   captures outer-scope variables, lowered to `=>` syntax) cannot
   contain `unwind`. Handlers must be bare anonymous functions.

4. **Closures cannot capture control-bound values.** Even when the
   closure body has no `unwind`, capturing a `ctl`-typed value (or a
   value whose type contains one transitively) is rejected — the
   closure could escape its enclosing frame and take the handler with
   it.

5. **Subtyping `fn <: ctl`** (covariant). A regular `fn(T) -> R` is
   assignable to a `ctl(T) -> R` slot — a non-unwinder is a valid
   value where unwind is permitted. The reverse is unsafe and
   rejected.

6. **Generics over function kinds.** `generic(T : Type)` can bind `T`
   to either `fn(...)` or `ctl(...)` — uses of `T` are handled
   uniformly.

7. **Control-bound types.** A type is _control-bound_ iff it
   transitively contains a `ctl(...) -> ret` (directly, or as a
   struct/tuple/enum/union field, or as an array/slice element, or as
   a pointer pointee). The predicate is `type_is_control_bound(T)`.

8. **Escape boundaries.** Control-bound types are rejected as:

   - **Function return type** — would let the handler outlive its
     install frame.
   - **Module-level binding type** — module scope outlives every call
     frame.
   - **`Box(T)` / `Arc(T)` / any heap-allocating type constructor** —
     heap outlives every stack frame.
   - **Closure capture type** (covered by rule 4).
   - **Pointer pointee type** — `*(Raise)` is rejected so a handler
     can't be installed and then written through a pointer to
     outer-frame storage.

9. **Middle-tier propagation.** A function that takes a `ctl`-typed
   parameter (or a struct containing one) and forwards it to a callee
   does **not** itself need to be `ctl`. The unwind targets the
   install frame above the propagating function.

### Worked example

```rust
Raise :: (ctl(msg : String) -> i32);

// Caller installs the handler at frame F.
do_caller :: (fn() -> i32)({
  (raise : Raise) = (
    msg -> {
      println(msg);
      unwind(i32(0)); // unwind targets `do_caller` frame
    }
  );
  // `compute` runs *below* F in the call stack; calls into `raise`
  // unwind back up to F.
  compute(raise)
});

// Middle tier: plain `fn`, forwards the handler.
compute :: (fn(raise : Raise) -> i32)(safe_divide(1, 0, raise));

safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond((y == 0) => raise(`div-by-zero`), true => (x / y))
);
```

### What you can't do (and why)

```rust
Raise :: (ctl(msg : String) -> i32);

// ❌ Returning the handler — its install frame would be dead.
make_handler :: (fn() -> Raise)({
  (r : Raise) = ((msg) -> { unwind(i32(0)); });
  r          // rejected: return type is control-bound
});

// ❌ Module-level binding — outlives every call frame.
top_handler :: (raise : Raise) = ((msg) -> { unwind(i32(0)); });

// ❌ Pointer to a handler — could write through to outer storage.
P :: *(Raise);  // rejected

// ❌ Storing in a Box — heap outlives the install frame.
b := box((msg) -> { unwind(i32(0)); });

// ❌ Closure capturing a handler — closure escapes; handler with it.
(r : Raise) = ((msg) -> { unwind(i32(0)); });
cb := (() => r(`hi`));  // closure captures r; rejected
```

## Bare `ctl`-typed effects vs struct effect records

A handler type can be a bare `ctl(...) -> R`, or a struct whose fields
are `ctl(...) -> R`. Both shapes are first-class — the choice is
purely an API-shape question:

```rust
// Bare ctl — single-method effect.
Raise :: (ctl(msg : String) -> i32);

// Struct record — multi-method effect.
Exception :: struct(
  throw : (ctl(generic(T : Type), msg : String) -> T)
);
```

Rules of thumb:

- **Single-method effect, called directly** (`raise(msg)`): a bare
  `ctl(...) -> R` is shorter and reads fine. Good for one-shot
  effects like `Raise`, `Log`.
- **Multi-method effect** (`exn.throw(...)`, `logger.warn(...)`): wrap
  the handlers in a `struct(...)` so the methods share a namespace and
  travel together as one value.
- **Effect bundle for a Future** (`Future(T, E)`, `generic(E : Type.Struct)`):
  the bundle is already a struct, so the handlers live as its fields.

The two shapes have the same install-site, escape, and codegen
semantics. A bare `ctl` value is just a function-typed parameter; a
struct field of `ctl` type behaves the same way once accessed.

## Struct-Based Effect Records

Effects can be grouped into struct records. The handler fields use
`ctl(...)` types so the struct value can install them via local
binding. Common bundles (e.g., `Exception`, `IoExn`) live in
`std/error.yo`:

```rust
Logger :: struct(
  info : (ctl(msg : String) -> unit),
  warn : (ctl(msg : String) -> unit)
);

log_and_check :: (fn(x : i32, logger : Logger) -> i32)({
  logger.info(`checking`);
  cond((x < 0) => logger.warn(`negative`), true => ());
  x
});

(my_logger : Logger) = Logger(
  info : (
    msg -> {
      println(msg);
      return(());
    }
  ),
  warn : (
    msg -> {
      println(`WARNING: ${msg}`);
      unwind(());
    }
  )
);

result := log_and_check(42, my_logger);
```

## Handler Functions Are Not Closures

Effect handler functions — both the struct-record and the `fn`-type forms — are
compiled as standalone C functions via evidence passing. They are **not**
closures: no capture struct is generated, and a handler body cannot read a local
from the scope that installed it. This is by design.

If a handler needs state, pass it explicitly:

- take it as an argument to the effect function, so the caller supplies it at
  the `ctl` call site; or
- allocate a `Box` outside the handler and pass its address in.

(`.github/instructions/c-codegen.instructions.md` § "Handler functions are
standalone, not closures" is the implementation-side statement of the same rule.)

## Semantics

- Handler bodies are compiled as **standalone C functions** via evidence
  passing, so they can NOT reference variables from the enclosing scope —
  no closure/capture struct is generated. See
  [Handler Functions Are Not Closures](#handler-functions-are-not-closures).
- `return(value)` is **one-shot** — the captured continuation can be
  resumed at most once.
- `unwind(value)` exits the frame that **installed** the handler: the
  function or the `io.async` block whose body the handler literal is written
  in. Frames in between, including async tasks, are unwound through (a task in
  between is aborted). When the installer is an `io.async` block, the value
  **resolves that block's future**, so it must have the block's result type:

  ```rust
  guarded := io.async((e : IoExn) => {
    local := Exception(throw : (err -> { unwind(Result(String, String).Err(err.to_string())); }));
    raw := e.io.await(may_fail(e.io), IoExn(io : e.io, exn : local));
    Result(String, String).Ok(raw)
  });
  // .Err("...") when may_fail threw: the error is caught per task.
  r := io.await(guarded, e);
  ```

  A frame that only passes a handler along never catches its unwind, so no
  frame reads another frame's value as its own.
- An `unwind` that no handler catches is **never lost**.
  - One that ends an async task aborts the task, and the abort is reported
    only if nobody observes it. Observing is silent: `JoinHandle.await`
    returning `.None`, an awaiter's `io.await` (the unwind propagates into
    the awaiter, whose own abort is then tracked the same way),
    `JoinHandle.state()` / `is_finished()`, or `io.state`.
  - A task nobody observed prints `unhandled effect unwind aborted an async
    task that was never awaited`, once. It prints when the task's last
    reference is released (a fire-and-forget spawn) or when the program body
    returns (a bound handle that was never awaited).
  - One that escapes `main` prints `unhandled effect unwind escaped to top
    level` and aborts the process.
  - A task cancelled through `JoinHandle.abort()` (the losers of `race` and
    `timeout`) is never reported, because no unwind happened.
- Handler types are enforced at the type level via `ctl(...)`. The
  evaluator does not infer ctl from body content; the user must
  annotate.

## Code Generation

Evidence passing is unchanged:

- Handler functions are passed as fn-ptr C parameters.
- Effect call sites emit:
  ```c
  __yo_effect_escaped = 0;
  result = (fn_ptr_call)(args);
  if (__yo_effect_escaped) { /* propagate unwind */ }
  ```
- `unwind` sets `__yo_effect_escaped = 1` and stores the value via
  `__yo_unwind_value`.
- `return` resumes normally — no flag set.

## Reporting capabilities: `yo effects`

Because effects travel as ordinary parameters, a function's signature IS its
capability list, and the type checker guarantees a callee cannot use a
capability it was not handed. `yo effects <file-or-dir>` reads that list off
the function types of every exported top-level `fn`, so an agent or a sandbox
can answer "may this program throw / touch the async runtime" without reading
bodies:

```
lib.yo
  add: (none)
  parse_or_throw: exn : Exception [ctl]
  tick: io : Io [io]
  run: e : IoExn [io, ctl]
  later: io : Io [io]; future IoExn [io, ctl]
```

A parameter is an effect when its type is, transitively through struct
fields, a handler record (a struct with a `ctl(...)` field — `Exception`,
`ResumableException(T)`: kind `ctl`) or the prelude `Io` (kind `io`). A
returned `Impl(Future(T, E))` reports `E` under `future`, since the awaiter must supply it. `--json` prints one object
per module: `{"file", "functions": [{"name", "effects": [{"param", "type",
"via": "param" | "implicit" | "future", "kinds"}]}]}`.
