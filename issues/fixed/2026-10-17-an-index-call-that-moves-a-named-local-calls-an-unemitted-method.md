# An index call that moves a named local calls an unemitted method

**Severity:** S2 — valid programs are rejected by the C compiler: `b(k)` on a generic `Index(K)` impl, with `k` a move-only named local, passes `yo check` and emits a call to a C function that is never declared. `HashMap(Box(K), V)` looked up by a named box (`m(key)`) is one case.

**Status:** fixed 2026-10-17 (branch `fix/hashmap-move-only-key-value`).
Found while gating
`issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`: the
new `tests/rc.test.yo` lookup `m(h2)` on a `HashMap(Box(UBoxPoint), Box(i32))`
failed at the C compiler. It reproduces on develop `ed733408c` without any
`HashMap`, so it predates that fix, which only made the map reachable.

## Symptom

```text
tmp/idx5.c:2254:55: error: call to undeclared function 'yo_id_3828744076870483533000000'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
 2254 |   int32_t _file____home_temp_68551150193446671280 = (*yo_id_3828744076870483533000000(&__yo_v_b, __yo_v_k));
```

## Reproducer

```yo
{ println } :: import("std/fmt");
Key :: struct(n : i32);
Bag :: (fn(comptime(K) : Type) -> comptime(Type))(struct(v : i32));
impl(generic(K : Type), Bag(K), Index(K)(Output : i32, index : (fn(self : &Self, idx : K) -> &Self.Output)(&self.v)));
main :: (fn() -> unit)({
  b := Bag(Key)(v : i32(78));
  k := Key(n : i32(1));
  v := b(k);
  println(&v);
});
export(main);
```

A temporary argument (`b(Key(n : i32(1)))`), a copyable argument, or a
non-generic impl all work.

## Root cause

`try_to_call_with_index_trait` (`src/evaluator/calls/index_trait.yo`) applies
the by-value index argument's ownership rule first
(`consume_argument_for_parameter`), which moves a move-only named local: `k`
is consumed at the argument's token. It then specializes the index method
with a trial call (`_specialize_index_method`) that re-evaluates the same
argument inside a whole call. That call's own argument rule moved `k` again,
and `set_expr_as_consumed` has no same-site exemption, so the trial threw
E0901. The trial's exception is swallowed, and the call fell back to the
unspecialized generic method value, which codegen never emits.

## Fix

Around the trial, `_index_arg_moved_here` finds the variable the argument
names when this call's rule has just moved it (its `consumed_at_token` is the
argument's own token). The trial sees it unmoved, and the move at that token
is put back afterwards, so the variable is moved once and the trial's
specialization reaches codegen. Nothing changes for an argument that was not
moved here: a copyable or shared one, or a temporary.

## Verification

- `tests/index.test.yo`, "Index: a generic impl takes a move-only named local
  by value": the reproducer, a later read of the moved `k` is still E0901, and
  a `HashMap(Box(i32), i32)` looked up by a named box. It failed at the C
  compiler before the fix.
- `tests/rc.test.yo`'s unique-`Box` section looks a `HashMap(Box(UBoxPoint),
  Box(i32))` up by the named box `h2`.
