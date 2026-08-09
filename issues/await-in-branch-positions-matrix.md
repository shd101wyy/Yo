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

### An await whose result is never read broke the SM struct

Both compilers:

```rust
task := io.async((io : Io) => {
  n := Box(i32)(3);
  v := io.await(future_with_returned_state(i32(1), io), io);
  return(n.*);          // `v` is never read
});
```

```
error: no member named 'var_yoebb42233_v' in 'struct ..._state_t_struct'
```

**Root cause:** the struct only gets a field for variables that cross a state
boundary, and a target nothing ever reads does not — but the extraction wrote
`sm-><field>` regardless.

An earlier note here called this "the combination with a compound `return`
tail". **That was wrong**: `return(n.*)`, a compound return, and a plain
assignment tail all fail identically, and reading the value anywhere makes all
of them pass. Being unread is the whole trigger; the tail shape is irrelevant.

Fixed by skipping the store when the target has no field — which is what the
linear-await path already does when there is no target at all. Not the
underscore either: `_v` and `v` behave the same.

---

## Still open

### `io.async` capture is not RC-incremented, so a future re-created in a loop is UAF

```rust
n := Box(i32)(0);
while(e.io.await(e.io.async((io2 : Io) => {
  io2.await(yield(io2), io2);
  return(n.* < i32(3));
}), e.io), { n.* = (n.* + i32(1)); });
```

TS: `n=3`. SELF: **rc=139**. TS emits
`__yo_new_X(fn___dup((struct){.n = sm->var_n}))`; SELF emits
`__yo_new_X((__yo_t15){.n = sm->var_598000})` — the captured Box is never
retained, so it is freed under the loop.

**An earlier draft of this file blamed registry keying (that yo-self looks
`___dup` up by `type_id_or_empty` where TS reads `type.trait.fields`). That
diagnosis is WRONG — measured 2026-08-09.** For this program the self-hosted
compiler emits **zero** `___dup` functions; TS emits 124. yo-self does not
synthesize per-type dup helpers here at all, it works through inline
`__yo_incr_rc` on the RC header (12 calls vs TS's 11). So there is no dup
function to look up under any key, and the fix is not a lookup fix.

What actually has to happen: in the state-machine context TS deliberately skips
the deferred dups (they name variables that no longer exist there) and falls
back to the capture struct's own `___dup`. yo-self has no such fallback, so the
capture's RC-typed fields are simply never retained. It needs an explicit
`__yo_incr_rc` per RC-typed capture field at construction — which means
`_build_async_capture_struct_literal` has to emit statements, not just return an
expression string.

**A shortcut was tried and reverted — do not repeat it.** Adding a
`type_key`-keyed `___dup` fallback at the capture site removes the segfault but
yields `n=4640` instead of `n=3` (it resolves _something_, and the something is
wrong). A loud crash traded for a silent wrong answer is worse. This needs the
RC increment done properly, with the usual RC discipline: diff the per-function
incr/decr counts against the TS emit before believing any green.

**Workaround in use:** hoist the future into a top-level helper taking its
inputs by value (`future_lt` in `tests/async_await.test.yo`) rather than an
inline closure capturing a mutable local.

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
