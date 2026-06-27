# Memory Safety

Yo is **memory-safe by default**. The code you write as a regular user cannot dereference a dangling pointer, walk off the end of an array, double-free, or otherwise trigger undefined behavior. You do not need to learn a borrow checker, manage lifetimes, or annotate references to get this guarantee — the safety story is structural: the constructs that cause memory unsafety in C (raw pointers, address-of, pointer arithmetic, FFI, inline assembly) are simply unavailable in safe code. Where static analysis reaches its limit, a lightweight runtime borrow flag (zero extra memory, ~0% overhead) turns the one remaining interior-reference shape into a deterministic panic instead of silent corruption.

Stdlib internals use raw pointers to build the safe abstractions you call. That code opts into a per-file unsafe-capable mode via `pragma(Pragma.AllowUnsafe);` and is audited as the trusted base. Your code stays clean.

This page describes the safety model from a user's perspective: what you can write, what you cannot, how the stdlib gives you in-place mutation without raw pointers, and how to opt into unsafe-capable mode for the cases where you genuinely need to (binding a C library, writing your own allocator).

## The Contract

```
Safe Yo code cannot express undefined behavior.
```

That is the rule. It is enforced by removing UB-capable constructs from the user's vocabulary rather than by proving their absence. The model parallels Swift, Go, and Java: a safe surface for users, a small trusted base in the stdlib that's allowed to use raw memory.

## What Safe Code Can Do

Everything you'd expect from a modern general-purpose language:

- **Value types.** `i32`, `bool`, `str` (a view of STATIC string bytes — immortal backing), structs, enums, tuples, `Array(T, N)`.
- **Heap-managed collections.** `ArrayList(T)`, `HashMap(K, V)`, `HashSet(T)`, `Deque(T)`, `LinkedList(T)`, `String`, immutable variants in `std/imm/*`.
- **Shared ownership.** `object` types (single-threaded Rc), `Arc(T)` (atomic Rc for cross-thread sharing), `Iso(T)` (ownership transfer).
- **Sum / option / result types.** `Option(T)`, `Result(T, E)`, your own `enum`s.
- **Closures and higher-order functions** over safe types.
- **Generics, traits, GADTs.** All of Yo's type-system features.
- **Algebraic effects, async/await, comptime.** Full access.
- **In-place mutation.** Via `inout(name) : T` parameters — covered below.

This is the default user experience. No pragma needed, no `&()` annotations, no `*(T)` types, no `unsafe(...)` wraps:

```rust
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));

  total := i32(0);
  for(list, (item) => {
    total = (total + item);
  });
  println("total = ${total}");
});
```

The `for` macro iterates by value (`(item) => …` calls `.into_iter()` under the hood). Object elements are handles, so mutating `item` in the body mutates the element in place; for struct/scalar elements, write back with index assignment (`coll(i) = v`). The old borrow form `for(coll, inout(item) => …)` was removed and produces a compile error with this recipe.

## What Safe Code Cannot Do

Each of the following is a compile error in a file without `pragma(Pragma.AllowUnsafe);`. Each error includes a "use this instead" hint.

| Construct                                               | Diagnostic (short)                                                               | Safe alternative                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `*(T)` type expression in a parameter, field, or return | "raw pointer types are not available in safe code"                               | owned collections (`ArrayList`/`String`), `inout(name) : T`, an `object` type, or a stdlib wrapper |
| `&(expr)` address-of                                    | "this expression has type `*(T)`, which is not available in safe code"           | `inout(name) : T` parameter, or pass the owned collection                                          |
| `unsafe(...)` call                                      | "`unsafe(...)` is not available in safe code"                                    | Use the stdlib's safe API, or add `pragma(Pragma.AllowUnsafe);` if you genuinely need raw ops    |
| `asm(...)` block                                        | "inline assembly is not available in safe code"                                  | Same                                                                                             |
| `extern(...)` / `c_include(...)` declaration            | "extern FFI declarations are not available in safe code"                         | Call a stdlib wrapper (e.g., `std/sys`, `std/fs`)                                                |
| Pointer arithmetic (`&+`, `&-`, `&/`)                   | "pointer arithmetic requires raw pointers, which are not available in safe code" | Indexing on `ArrayList(T)` / `Array(T, N)`                                                       |
| `consume(p.* = v)` on a pointer                         | "`consume` on a pointer deref requires raw pointers"                             | Use `:=` for ownership transfer of safe types                                                    |

The principle: **anything that could let a user write UB is gated.** If the user can't construct a raw pointer, they can't dereference one — full stop.

## In-Place Mutation: `inout(name) : T`

The pattern C/Rust solve with `&mut T` is solved in safe Yo with a parameter modifier:

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // no &() at the call site — `inout` is in the param spec
  assert((x == i32(2)), "swapped");
});
```

`inout` is **second-class** and exists ONLY in parameter position (`inout(name) : T`). Functions cannot return `inout`, there are no local ref bindings (`inout(r) := …` is rejected — fields read and write in place), there is no first-class "`inout` type", and a borrow cannot leak into a struct field or a closure capture. An `inout` argument is a simple lvalue place (a variable, or `var.field` rooted at a local/param), so the borrowed storage is alive for the whole call by construction. See [FLOWABILITY.md](./FLOWABILITY.md).

Use cases:

- Stdlib trait methods that mutate (`Hash.hash`, `Clone.clone`, `Iterator.next`) all take `inout(self) : Self`. You write `value.hash()`, `it.next()` — no `&()` needed.
- Your own mutation helpers (`swap`, `increment`, `clear`, ...) take `inout(name) : T`.
- Callback APIs that lend a value for a scope: `Mutex.with_lock(body : Impl(Fn(inout(v) : T) -> R))`.

## Stdlib Collections Stay Safe

`ArrayList(T)`, `HashMap(K, V)`, `String`, and friends all carry raw pointers in their internal representation. They are safe to use because the implementation hides the pointer:

1. **No public method has `*(T)` in its signature.** Methods take and return safe types only.
2. **All indexing is bounds-checked.** `s(i)` on a `str`, `arr.get(i)`, `list(usize(0))` either trap or return `Option(T)` on out-of-bounds. The pointer arithmetic that backs them lives inside `unsafe(...)` blocks with verified bounds invariants.
3. **No raw construction.** You can't build an `ArrayList(T)` with an arbitrary pointer; the constructors are safe.

The language also closes the **dangling-view hole** that other languages with raw-pointer abstractions have to manage by hand, by construction:

- `str` is the only built-in view type, and it can only refer to **static** string data (literals, `comptime_str`) — it is never backed by a heap buffer that could be freed under it.
- **Range operations on collections copy.** `list(usize(1)..usize(3))` and `String` ranges produce an owned value, not a window into the source buffer — there is no heap-backed slice type to dangle.
- **Element access hands out values, never interior pointers.** `xs.get(i)` returns the element — for object elements that is a handle to the element _object_ (it mutates in place and survives the container's growth/realloc); for struct elements it is a copy, written back with `xs(i) = v`. No safe expression yields a pointer into a container's buffer, so growth invalidation is inexpressible.

The walkthrough of these rules is in [FLOWABILITY.md](./FLOWABILITY.md); you don't need to know them to write safe code — the compiler rejects the dangerous shapes.

## Escape Hatch: `pragma(Pragma.AllowUnsafe);`

When you genuinely need raw pointers — binding a C library, writing a custom allocator, implementing a new collection — opt into unsafe-capable mode with a one-line declaration at the top of the file:

```rust
pragma(Pragma.AllowUnsafe);

// In this file you can now use *(T), &(x), unsafe(...), asm(...),
// extern(...), c_include(...), and pointer arithmetic.
```

Opt-in is **per file**, not per function or per block. The granularity is deliberate: a file with `pragma(...)` accepts audit responsibility for everything in it; you don't sprinkle unsafe through otherwise-safe code. If you find yourself wanting only a small unsafe region, that region usually belongs in its own file (often a thin stdlib-style wrapper).

Within a privileged file you still write the operations explicitly:

```rust
pragma(Pragma.AllowUnsafe);
{ memcpy } :: import("std/libc/string");

copy_bytes :: (fn(dst : *(u8), src : *(u8), n : usize) -> unit)({
  // The extern call MUST be wrapped in unsafe(...) — see "Per-Call
  // Audit Marker" below.
  _ := unsafe(memcpy((*(void))(dst), (*(void))(src), n));
});
```

## `unsafe(...)`: the Per-Op Audit Marker

Inside a privileged file, every UB-capable operation must appear inside an `unsafe(...)` call:

| Operation                   | Example                                               |
| --------------------------- | ----------------------------------------------------- |
| Pointer dereference (read)  | `unsafe(p.*)`                                         |
| Pointer dereference (write) | `unsafe(p.* = v)`                                     |
| `consume(p.* = v)`          | `unsafe(consume(p.* = v))`                            |
| Pointer arithmetic          | `unsafe(p &+ n)`, `unsafe(p &- n)`, `unsafe(p &/ q)`  |
| Extern "c" function call    | `unsafe(strlen(cstr))`, `unsafe(memcpy(dst, src, n))` |

The wrap is a **compile-time marker only** — it lowers to its inner expression at codegen time, so there's no runtime cost. The purpose is audit precision: `yo unsafe-report` can point at the exact line where unsafety happens, instead of just listing the file. Reviewers grep for `unsafe(` and see every UB-capable site.

Operations that are NOT gated (addresses are just data; moving them around doesn't risk UB):

- `&(x)` — taking an address
- Passing `*(T)` to a function
- Storing `*(T)` in a struct field
- Returning `*(T)`
- Pointer comparison: `p &== q`, `p &< q`, etc.
- Pointer type casts: `*(u8)(p)`
- `asm(...)` blocks (the `asm` keyword is itself the marker)
- `extern(...)` / `c_include(...)` _declarations_ (only the _call sites_ need wrapping)

## `// SAFETY:` Comments

When you write `unsafe(...)`, you're claiming a specific contract holds. Document it:

```rust
match(
  self._ptr,
  // SAFETY: idx has been bounds-checked above (idx < self._length);
  // _ptr points at the Rc-managed heap buffer, alive while self
  // holds the Rc.
  .Some(_ptr) => (_ptr &+ idx),
  .None => panic("ArrayList: index on empty list")
)
```

`yo unsafe-report` picks up `// SAFETY:` comments within ~8 lines preceding an `unsafe(...)` site and shows them in the report. The convention is the stdlib's: every non-obvious unsafe site has a comment explaining why the contract holds.

## The Audit Tools

### `yo unsafe-report [path]`

Lists every unsafe-related construct under a path:

```
$ yo unsafe-report ./std
Unsafe surface report
=====================

Scanned 148 .yo file(s); 99 declare pragma(Pragma.AllowUnsafe);.
  unsafe(...) sites: 78
    extern-call: 64
    deref:       4
    arith:       2
    addr-of:     7
    other:       1
  asm(...) sites:    0
  extern(...) sites: 20

Top extern callees (by unsafe-wrapped call-site count):
    26  snprintf
    12  memcpy
     8  fwrite
     7  memcmp
     2  memset
     ...

Findings (file:line:col):
  std/collections/array_list.yo:521:24: unsafe(arith) — .Some(_ptr) => unsafe(_ptr &+ pos),
    SAFETY: assert above bounds `pos < self._length` and the
  ...
```

The classification (extern-call / deref / arith / addr-of / other) and top-callees summary turn the report into an audit inventory: an auditor scanning a release can see which C functions are the highest-volume callees, which `unsafe(...)` sites are pointer ops vs FFI, and which sites have explicit SAFETY: justifications.

Useful flags:

- `--json` — machine-readable output (for CI scripts or dashboards).

### Other lints

- `yo public-safe-report [path]` — flags public stdlib APIs that leak `*(T)` in their signatures. Used to keep the safe surface clean as the stdlib evolves.

## FFI

User code cannot declare `extern(...)` or `c_include(...)`. To call a C function:

1. **Preferred:** call an existing stdlib wrapper (`std/sys/*`, `std/fs`, `std/libc/*`, `std/net`, etc.).
2. **If no wrapper exists:** create a new file with `pragma(Pragma.AllowUnsafe);`, declare the extern there, wrap each call site in `unsafe(...)`, and treat the file as part of your project's trusted base.

```rust
// my_ffi.yo
pragma(Pragma.AllowUnsafe);

c_include(
  "<mylib.h>",
  mylib_init : (fn() -> int),
  mylib_compute : (fn(input : i32) -> i32)
);

init :: (fn() -> Result(unit, int))({
  // SAFETY: mylib_init has no preconditions; non-zero return signals
  // initialization failure.
  rc := unsafe(mylib_init());
  cond(
    (rc == int(0)) => .Ok(()),
    true => .Err(rc)
  )
});

compute :: (fn(input : i32) -> i32)(unsafe(mylib_compute(input)));
```

Then in the consuming safe file:

```rust
// main.yo  (no pragma)
{ init, compute } :: import("./my_ffi");

main :: (fn() -> unit)({
  match(
    init(),
    .Ok(_) => println("result: ${compute(i32(42))}"),
    .Err(e) => println("init failed: ${e}")
  );
});
```

Same workflow as writing FFI bindings in Swift or Go.

## Integer Overflow

Yo compiles `i32(...)`, `i64(...)`, etc. to C signed integer types. By default, Yo passes `-fwrapv` to the C compiler, which defines signed-integer overflow as **two's-complement wrap-around** — not undefined behavior.

```rust
x := i32(2147483647);   // i32 max
y := (x + i32(1));      // y == i32(-2147483648) — defined wrap, not UB
```

Most user code never hits the limit because Yo provides `i64` / `u64` for cases where overflow is plausible. The `-fwrapv` default ensures that if your code _does_ overflow, the behavior is predictable rather than a silent miscompile.

If you measure a perf regression in a numerically-intensive loop and want to opt back into strict-overflow optimization, build with `--cflags='-fno-wrapv'`. In practice the perf delta is < 0.5% on realistic loops; this flag exists for completeness, not because you'll usually need it.

## What This Doesn't Guarantee

The safety model is honest about its scope:

- **It prevents UB.** It does not prevent logic errors, panics, infinite loops, or resource exhaustion. `panic("...")` still terminates the program; an unbounded `while(true, ...)` still hangs.
- **It applies to your code.** Stdlib bugs can still cause UB, since the stdlib uses raw pointers internally. The mitigation is audit, fuzz testing, and the `yo unsafe-report` inventory — the same approach Swift, Go, and Java take for their unsafe internals.
- **FFI is the caller's problem.** Calling a C function with the wrong argument types or violating its precondition contract is UB at the C level. The `unsafe(...)` wrap around extern calls is the per-site review marker; it doesn't validate the contract.
- **Data races across threads** are handled by `Send` / `Iso(T)` / `Arc(T)`, not by this model. They're orthogonal.
- **Inside `pragma(Pragma.AllowUnsafe);` files**, all bets are off — that's the point of the opt-in. You accept audit responsibility for what's in the file.

The framing: **safe Yo code cannot violate memory safety. The unsafe surface is confined to files that explicitly opt in via pragma — primarily stdlib — which is small, audited per release, and fuzz-tested.**

## Further Reading

- `plans/MEMORY_SAFETY.md` — the design document for the safety model. Covers the full rationale, phase rollout, alternatives considered.
- [FLOWABILITY.md](./FLOWABILITY.md) — the user-facing `inout`/borrow rules (flowability + borrow invalidation).
- `plans/SLICE_REWORK.md` — the design that removed heap-backed slices (builtin `str`, copying ranges).
- `plans/EXTERN_UNSAFE_WRAP.md` — the per-call-site wrap requirement for extern "c" functions.
- `plans/ITERATOR_REDESIGN.md` — how iteration works under the safe model.
- `docs/en-US/DESIGN.md` — the broader language design; the pointer / unsafe sections cross-reference this page.
