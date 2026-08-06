# yo-self: forward-ref impl method with a POINTER receiver, called only via the shell thunk, is never collected

_2026-07-20. **FIXED — tests/forward_ref_impl_block.test.yo FLIPS 5/5 (#69 +1).**
Commit: (pending gate). One-line codegen collection fix. Full battery +
STRICT_FIXPOINT below. This is the diagnosis + resolution._

## Symptom

`tests/forward_ref_impl_block.test.yo` (s2) fails C compile: the forward-called
method body emits a call to an **undeclared** function.

Minimal repro (`src/tests/fixme.yo`, Test 1 of the file):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
P :: struct(x : i32, y : i32);
impl(
  P,
  caller : (fn(self : *(Self)) -> i32)(self.callee()),
  callee : (fn(self : *(Self)) -> i32)(self.x)   // defined AFTER caller — forward ref
);
main :: (fn(io : Io) -> unit)({ p := P(x : i32(7), y : i32(0)); r := p.caller(); () });
export(main);
```

yo-self (s1/s2) emits (WRONG — `yo_id_4688` never declared/defined):

```c
static inline int32_t fn_yo_id_4684_callee(__yo_t0* self) {
  return yo_id_4688(self);   // thunk forwards to real func...
}
// ...but yo_id_4688 is emitted NOWHERE → "call to undeclared function"
```

TS emits ONE merged function (`callee` id_31, body `return self->x;`).

## Root cause

yo-self models forward-ref impl methods differently from TS. TS mutates the
shell `FunctionValue` IN PLACE (`shell.body = real.body`) and redirects the
orphan's `funcId` to the shell's (impl.ts:718-757) → one function, real body.
yo-self can't do that (value semantics; `EvalValue` has no `.clone()` and
`clone_value` consumes), so it uses a **thunk**: the shell func id is registered
via `register_shell_redirect(shell_fid, real_fid)`
(evaluator/values/impl.yo:2320) and codegen emits the shell id as a thunk
`return <real_fid>(...)` (codegen/functions/generation.yo:382-397). This
requires the REAL func to be collected+emitted separately.

The real func is reachable ONLY through the trait-method registry (the shell
entry is updated in place to hold the real func at impl.yo:2322-2324). Codegen's
method-call collection (`find_function_calls_in_expr`,
codegen/functions/collection.yo:504-539) looks it up there — but keys the lookup
on `type_id_or_empty(recv_ty)`, and **`type_id_or_empty` has no `Pointer` case**
(type*trait_methods.yo:58, falls to `* => ""`). So for a POINTER receiver
(`self : \*(Self)`) `ctid == ""` and the whole registry lookup is skipped. The
shell (thunk) is still collected via the method-callee side-table, but the real
func is never collected → undeclared.

Why it hid so long: the thunk works whenever the method is ALSO called from a
non-forward site (that site collects the real func via its real id) — e.g.
parser.yo's recursive `get_program`. It breaks only when a method is called
EXCLUSIVELY through a forward-ref/self-recursive `self.m()` on a pointer
receiver. Value-receiver forward refs (`self : Self`, Tests 2 & 5) already
worked — `type_id_or_empty(Struct)` returns the id, so the registry lookup ran.

## Fix

`codegen/functions/collection.yo` — deref a pointer receiver to its pointee
before computing the registry lookup id, so the real func is collected:

```rust
recv_ty_for_id := match(recv_ty,.Pointer(inner) => inner, _ => recv_ty);
ctid := if(recv_static_id.len() > usize(0), recv_static_id, type_id_or_empty(recv_ty_for_id));
```

Mirrors the pointer-deref idiom at match.yo:1153 / property_access.yo:524. The
emission side needs no change: it already resolves `self.m()` to the shell via
the method-callee side-table and emits the thunk; the thunk now resolves.

## Verification (full battery, all green)

- Repro: `yo_id_4688` now declared + defined (`return self->x;`), clang-clean.
- `forward_ref_impl_block.test.yo`: **5 passed / 5 total** under both s1 and s2
  (was C-compile failure). All 5 sub-tests flip: pointer-receiver forward call
  (1), value-receiver mutual recursion (2), forward call + effect params (3),
  mutual recursion + effect params / specialization-cycle (4), shell+orphan
  no-dup (5).
- Corpus diff-test: `PASS 135 DIFF 2 SELF-FAIL 0` (exact baseline, no change).
- `check ./std`: 153/153.
- stage2 emit → clang -O2 → stage3 emit → **STRICT_FIXPOINT=HOLDS**
  (byte-identical). `s2 check std/env.yo` = 0.
- Prior flips hold under s2: comptime 28, error 8, forward_ref_self_method 2,
  str 3, ref_return_ban 2, lexer 34, parser 49.
- `tests/impl.test.yo` remains red (`conflicting types for 'yo_id_6061'`,
  a `void*` return type-identity bug) — **pre-existing**, byte-identical error
  under the pre-fix HEAD binary; unrelated to forward-ref collection.
