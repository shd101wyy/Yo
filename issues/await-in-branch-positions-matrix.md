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
| `match(m, .Some(x) => { await f })` — ARM             | ✅ both           |
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

### `io.async` capture fields were never RC-retained (a loop freed them)

```rust
n := Box(i32)(0);
while(e.io.await(e.io.async((io2 : Io) => {
  io2.await(yield(io2), io2);
  return(n.* < i32(3));
}), e.io), { n.* = (n.* + i32(1)); });
```

TS: `n=3`. SELF: **rc=139** — the captured Box was freed under the loop.

**Root cause:** the state machine's dispose DOES drop the capture struct's RC
fields, but nothing retained them. TS balances that by dupping the whole capture
struct through its synthesized `___dup`; yo-self synthesizes no such helper —
for this program it emits **zero** per-type `___dup` where TS emits **124** — and
its deferred-dup path is deliberately skipped inside a state machine.

An earlier draft blamed registry keying (yo-self looking `___dup` up by
`type_id_or_empty` where TS reads `type.trait.fields`). **That was wrong**: there
is no capture dup to find under any key. It is also why a `type_key`-keyed
fallback "fixed" the crash while returning `n=4640` — it resolved something
else.

Fixed with `_rc_field_retain_line`, the exact mirror of the existing
`_rc_field_drop_line`: every branch there has its counterpart here, so a field
dropped on dispose is the one retained on construction. RC changes get an
emit diff, not just a green suite — the capture repro went incr 11 -> 12 (exactly
the one added retain) with decr unchanged, and two unrelated repros were
byte-identical.

### Two `io.async` closures capturing the same local emitted invalid C

**Was reference-compiler only; the self-hosted one happened to be correct, but
had the same latent mismatch.**

```
error: used type '__yo_struct_..._id_28' where arithmetic or pointer type is required
  fn_..._id_40___drop((__yo_struct_..._id_28)(sm->await_future_1));
```

**Root cause:** an inline `io.async(...)` produces two temps that can share a
generated name — the closure's CAPTURE STRUCT and the future itself. Only the
future is stored in `await_future_N`, but the alias search matched on NAME
alone, so it could pick the capture struct. Its deferred drop then ran against
that field: a drop of a struct BY VALUE applied to a state machine POINTER.

Fixed in both compilers by requiring the aliased variable to actually be a
future (`typeImplementsFuture` / `type_implements_future`). yo-self matched by
name only too — it just didn't manifest on this repro — so the guard went in
there as well rather than waiting for it to bite.

## Still open

_Nothing. All six are fixed, each covered by `tests/async_await.test.yo`._

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
