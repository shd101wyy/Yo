# `for(m.iter(), ...)` in safe code reports an uncoded raw-pointer error at a desugar temporary

**Severity:** S3 — the error is correct to reject (`iter()` yields raw pointers, which safe code may not hold) but it carries no code, prints the element type with the binder's internal constraint text, and names `for_iter_var1.next`, an identifier the user never wrote.

Found 2026-11-25 by the std-against-Rust audit (`plans/backlog/STD_RUST_ALIGNMENT.md` §3.5, probe c32). Filed by the S-0 PR.

## Reproducer

```yo
{ HashMap } :: import("std/collections/hash-map");

main :: (fn() -> unit)({
  mut(m) := HashMap(i32, i32).new();
  m.insert(i32(1), i32(2));
  mut(t) := i32(0);
  for(m.iter(), e => {
    t = (t + i32(1));
  });
  println(t);
});
export(main);
```

`yo check tmp/fixme.yo` (tree binary at `8da9761d1`; the `check:` progress lines and the unrelated kebab-case warning are omitted):

```text
error: Raw pointer values are not available in safe code: '(for_iter_var1.next)()' has type '?(*(MapEntry(K : ((== : fn(lhs : &Self, rhs : &K : (<trait:trait_std__prelude_Call_s2_r31c4_n68> + Hash)) -> bool, != : fn(lhs : &Self, rhs : &K) -> bool) + Hash), V)))'.

To borrow the elements of a collection, iterate it with 'for(&coll, x => ...)' (read-only) or 'for(&mut coll, x => ...)' (in place). If this file genuinely needs raw pointers, declare 'pragma(Pragma.AllowUnsafe);'.
  --> tmp/fixme.yo:7:3
```

`yo explain` has no code to look up, and `yo fix` has nothing to attach a repair to, although `for(&m, (k, v) => ...)` is the one fix.

## Root cause

`_evaluate_expression_raw_wrapper` (`src/evaluator/exprs/dispatch.yo`, the "Memory-safety gate") rejects any runtime value whose type surfaces a raw pointer (`_surfaces_raw_pointer`) outside an unsafe-capable file. It raises through `exn.throw(dyn(Box.new(format_error_message(...))))` with no `with_code`, at the token of the `for` desugar's `.next()` call, and prints `type_to_string` of the type unabridged.

## Fix direction

Give the gate a registry code (with `yo explain` text in both languages naming `for(&coll, ...)` and `for(&mut coll, ...)`), print the user's `for` source as the subject when the value is the desugar's `.next()` temporary, and shorten the type (a `*(T)` with `T` printed by `type_to_string_for_message`). When VERDICTS-82 §3.5 lands (`iter()` borrows), this program is accepted and the gate only fires for genuine raw-pointer values, so the fix may be better made then.

## Test

None yet. The fix adds a `tests/cli-cases/` row with the new code and a `yo explain` row.
