# `return(<owned RC local>)` inside a branch was double-dropped (TypeScript compiler)

**Status:** FIXED in `src/codegen/exprs/return.ts`. A regression test lives in
`tests/rc.test.yo` ("Returning an OWNED RC local from inside a branch is not
double-dropped").

This was a miscompile in the **ground-truth TypeScript compiler**, not in the
self-hosted port. It silently returned a freed pointer.

## Reproducer

```rust
{ ArrayList } :: import("std/collections/array_list");
{ assert } :: import("std/assert");
f :: (fn(flag : bool) -> ArrayList(i32))({
  out := ArrayList(i32).new();
  if(flag, {
    out.push(i32(7));
    return(out);          // <-- owned RC local, returned from inside a branch
  });
  out.push(i32(2));
  out.push(i32(3));
  out
});
main :: (fn() -> unit)({
  a := f(true);
  assert(a.len() == usize(1), "early-return branch should yield 1 element");
});
export(main);
```

`./yo-cli compile /tmp/retdrop.yo --release -o /tmp/x && /tmp/x` → the assert
fails (`rc=134`). `a` is not an `ArrayList` with one element; its buffer has
already been freed.

## The emitted C, before

```c
static inline __yo_struct_..._831* fn_..._f(bool flag) {
  ...
  if (flag) {
    push(out, 7);
    ..._temp_40620 = ___dup(out);   // rc 1 -> 2   (the caller's copy)
    _temp_40620;
    ___drop(out);                   // rc 2 -> 1   correct: release the local
    // Drop consumed variables (unwind propagation)
    ___drop(out);                   // rc 1 -> 0   *** FREED ***
    return _temp_40620;             // returns a dangling pointer
  }
```

After the fix the second `___drop(out)` is gone and the `___dup` / `___drop`
pair balances, leaving rc=1 for the caller.

## Root cause

`out` is dup'd for the caller, so the local must be released **exactly once** on
the early-return path. Two independent emitters each released it:

1. `generateEarlyReturnOnlyDeferredDropExpressions` — the M3 early-return-only
   drops carried on the return node (`expr.$.earlyReturnOnlyDeferredDropExpressions`).
2. `generateConsumedVarDropsForEscape` — the consumed-var escape drops
   (`context.consumedVarPendingDrops`), invoked at `return.ts` whenever
   `handledDeferredDup` is true.

Both legitimately contain `out`: the dup/drop optimizer marks a dup'd original
"consumed" and moves its drop into `consumedVarPendingDrops` for escape paths,
while the M3 pass independently attaches an early-return-only drop for a local
that is initialized before this exit but moved out after it. Neither knew about
the other.

`generatePendingDeferredDrops` had already solved exactly this collision for
_its_ drop list — it builds an `alreadyDroppedVars` set from **both**
`deferredDropExpressions` and `earlyReturnOnlyDeferredDropExpressions` and
filters against it (`return.ts:280-300`). `generateConsumedVarDropsForEscape`
had no equivalent guard.

## The fix

`generateConsumedVarDropsForEscape` takes a new optional
`excludeVarNames: ReadonlySet<string>` and filters `consumedVarPendingDrops`
against it before its existing env / initialization / declared-C-name guards.
The return path builds that set from the same two lists
`generatePendingDeferredDrops` uses, and passes it. A second release of the same
variable within one return sequence can only ever be a double free, so the
filter cannot mask a legitimate drop.

Only the `handledDeferredDup` call site passes the set; the other seven callers
are unchanged (the parameter defaults to `undefined`).

## Why it mattered beyond the reproducer

Found while root-causing `tests/fs/dir.test.yo`, which **hangs** (rc=124
timeout) under the self-hosted compiler. `yo-self/codegen/async/state_code_gen.yo`
contains

```rust
_collect_exprs_from(remaining_exprs, body_exprs, await_found_index + usize(1));
return(remaining_exprs);
```

— a `return` of an owned `ArrayList(AstExpr)` local from inside a nested `if`.
The s1 binary was built by the buggy TS compiler, so that function returned a
freed list; the caller read `after.len()` as 0 and the async state machine never
emitted a while-loop's post-await tail, dropping the loop's `i = i + 1`
increment and producing an infinite loop. The fingerprint in the emitted C is a
`// Execute remaining code from while loop body` section immediately followed by
`while_loop_N_continue:` with nothing between.

The same fix is **ported** to `yo-self/codegen/exprs/return.yo` in the same
commit, so a self-rebuilt s1 no longer reproduces it either. Yo has no optional
parameters, so `exclude : Option(HashSet(String))` is passed explicitly at all
five call sites (`.None` where TS omits the argument).

Note this does not by itself prove `fs/dir` passes: repairing the compiler that
_builds_ s1 removes the freed-list read, and the port keeps a rebuilt s1 correct,
but the file has to be re-measured to confirm nothing else blocks it.

## Verification

- Reproducer: fails (`rc=134`) before, passes (`rc=0`) after.
- Emitted C inspected before and after: the redundant `___drop` is gone and no
  other drop moved.
- `tests/rc.test.yo` — 16/16 (was 15, +1 new test).
- Full integration suite run after the change.
