# `io.await` in branch positions: what works, what is rejected

**Measured 2026-08-09**, both compilers, re-measured after each fix. Every row
below was run, not inferred.

"TS" = the reference compiler (`src/`). "SELF" = the self-hosted binary built
from `yo-self/`. All rows are inside an `io.async((e) => { ... })` block; outside
one, `io.await` is a synchronous drive loop and none of this applies (which is
why `tests/fs/dir.test.yo` has used `cond(io.await(...) => ...)` at top level for
ages without trouble).

| shape                                                 | status            |
| ----------------------------------------------------- | ----------------- |
| `cond(c => { await f })` — branch VALUE               | ✅ both           |
| `if(c, { await f })` / `if`+`else` bodies             | ✅ both           |
| `x := await f; if(x, ...)` — hoisted                  | ✅ both           |
| `if(await f, ...)` — CONDITION                        | ✅ both           |
| `cond(await f => ...)` — FIRST condition              | ✅ both           |
| `match(await f, ...)` — SCRUTINEE                     | ✅ both           |
| `while(await f, ...)` — CONDITION                     | ✅ both           |
| `while(c, { ...await f... }, body)` — STEP            | ✅ both           |
| `match(m, .Some(x) => { await f })` — ARM             | ✅ both (fixed)   |
| `if(!(await f), ...)` — await NESTED in a condition   | ⛔ rejected, both |
| `cond(c1 => .., await f => .., ..)` — LATER condition | ⛔ rejected, both |

The two rejections are deliberate and carry a diagnostic naming the fix:

- **Nested** — the await must BE the condition. Substituting the extracted
  result into a larger expression asks codegen for helper specialisations the
  collection pass never saw, so the C calls undeclared functions. A general
  limit on nested awaits: plain `b := !(io.await(f, io))` fails identically.
- **Later `cond` branch** — `cond` is lazy, so hoisting would await even when an
  earlier branch matches. That is a change of meaning, not just of timing.

Everything above is covered by `tests/async_await.test.yo` (139 tests, green
under both compilers) and `src/tests/async-await-position-gate.test.ts` (the
rejections must fail at COMPILE time, not silently).

---

## Fixed

### `match` arm containing an await was silently dropped by SELF

**Was the worst class in the table: rc=0, no diagnostic, wrong behaviour.**

```rust
m := Option(i32).Some(i32(1));
match(m, .Some(x) => {
  v := e.io.await(num(e.io), e.io);
  println(`arm ${x} ${v}`);      // TS printed "arm 1 7". SELF printed nothing.
}, .None => ());
```

**Root cause:** `generate_match_with_await` resolved the enum's C name with
`context.base.types.get(enum_id)` — a faithful port of TS's
`context.types[enumType.id]?.cName`. But yo-self's type registry is keyed by
`type_key(t)`, **not** by the enum's `id` field, so the lookup missed for every
generic enum instance (`Option(i32)` included). It then emitted
`// Error: enum type has no C name` **as a C comment** and returned, and the
caller went on to emit the await machinery with the arm bodies simply gone.

Fixed by using the accessor the non-async match generator already uses
(`context.base.get_type_c_name(type_key(...))`, `exprs/match.yo:1205`), and by
making the remaining failure a hard error instead of a comment — reaching it
means the whole `match` disappears, so it can never be benign.

This is the second instance of the same shape in a week: **a faithful port of a
TS registry lookup is wrong when yo-self keys that registry differently.** TS
reads values off the type/expr; yo-self resolves through a global table. Porting
the lookup literally compiles fine and silently returns nothing.

### `return(<compound expr>)` as a closure's FINAL expression emitted invalid C

```
int32_t __yo_scope_ret = return _temp_5219;
```

**Root cause:** the B1 tail materialization (`codegen/functions/generation.yo`)
wraps the tail expression's code in `T __yo_scope_ret = <code>;` when the body
has drops and a non-unit return. yo-self's `return(...)` codegen yields a
COMPLETE `return X` statement (and emits the scope-end drops itself), where TS
yields the value temp and lets the caller emit the return. So the statement got
spliced into an initialiser.

A SIMPLE `return(n.*)` was fine — the materialization only kicks in for the
compound case — which is why this hid.

Fixed by detecting an already-complete `return` and emitting it verbatim.

---

## Still open

### 1. `io.async` capture is not dup'd, so a future re-created in a loop is UAF

```rust
n := Box(i32)(0);
while(e.io.await(e.io.async((io2 : Io) => {
  io2.await(yield(io2), io2);
  return(n.* < i32(3));
}), e.io), { n.* = (n.* + i32(1)); });
```

TS: `n=3`. SELF: **rc=139**. TS emits
`__yo_new_X(fn___dup((struct){.n = sm->var_n}))`; SELF emits
`__yo_new_X((__yo_t15){.n = sm->var_600288})` — no dup, so the captured Box is
freed under the loop.

**Same registry-keying shape as the `match` bug above.** TS's
`getDupFunctionForType` reads `type.trait.fields` off the TYPE VALUE, so it
finds the `___dup` of a synthesized capture struct. yo-self's `_method_c_name`
resolves through the method registry keyed by `type_id_or_empty(type)`, and the
capture struct is registered under its instantiation-precise `type_key` — so it
misses. (`get_dispose_function_for_type` already documents and keys around
exactly this.)

**A naive fix is WRONG — do not repeat it.** Adding a `type_key`-keyed fallback
for `___dup` at the capture site removes the segfault but yields `n=4640`
instead of `n=3`: a loud crash traded for a silent wrong answer, which is worse.
The dup alone is not the whole story; the capture's ownership across iterations
needs to be worked out properly before touching this. Reverted rather than
shipped.

**Workaround in use:** hoist the future into a top-level helper that takes its
inputs by value (`future_lt` in `tests/async_await.test.yo`) instead of an
inline closure capturing a mutable local.

### 2. An await-result binding plus a compound `return` tail loses its SM field

Both compilers:

```rust
task := io.async((io : Io) => {
  n := Box(i32)(3);
  v := io.await(future_with_returned_state(i32(1), io), io);
  return((n.* * i32(10)) + n.*)      // <- compound return, does not read `v`
});
```

```
error: no member named 'var_yoebb42233_v' in 'struct ..._state_t_struct'
```

Not the underscore (`_v` and `v` behave identically) and not "unused" on its own
— `_x := io.await(...)` in a `while` step is fine. It is the combination with a
compound `return` tail. Loud, so not dangerous.

---

## Reproducing

Each row is a body spliced into a fixed harness and compiled by both binaries:

```rust
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    <BODY>
  })
);
main :: (fn(io : Io, exn : Exception) -> unit)({
  io.await(do_it(io, exn), IoExn(io : io, exn : exn));
  println(String.from("END"));
});
```

`END` alone in the output means the branch body was skipped — that is how the
dropped `match` arm was caught. A harness that only checks the exit code passes
it, which is why the corpus never noticed.
