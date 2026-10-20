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

A temporary that moves nothing (`b(Key(n : i32(1)))`), a copyable argument,
or a non-generic impl all work. A temporary whose construction moves a named
local fails the same way (`b(Wrap(k : k))`, `b(take(k))`), and so does a write,
which re-dispatches to `index_mut` (`m(key) = v`, a `&mut m(key)` argument,
`addr_of(m(key))`), and the bounds-check-free twin's specialization.

## Root cause

`try_to_call_with_index_trait` (`src/evaluator/calls/index_trait.yo`) applies
the by-value index argument's ownership rule first
(`consume_argument_for_parameter`), which moves a move-only named local: `k`
is consumed at the argument's token. It then specializes the index method
with a trial call (`_specialize_index_method`) that re-evaluates the receiver
and the argument inside a whole call. That call's own argument rule moved `k`
again,
and `set_expr_as_consumed` has no same-site exemption, so the trial threw
E0901. The trial's exception is swallowed, and the call fell back to the
unspecialized generic method value, which codegen never emits. The same
trial runs again for the unchecked twin (`_record_index_unchecked_twin`) and,
after the read dispatch, for a write's `index_mut` (`_promote_index_call`).

## Fix

`_specialize_index_method`, which all three trials go through, collects the
locals the index call has already moved (`_locals_moved_inside`): every local
the call names whose `consumed_at_token` lies inside the call's own source,
the receiver and the argument both. The trial sees each one unmoved, and its
move is put back at the same token afterwards, so the variable is moved once
and the trial's specialization reaches codegen. A copyable or shared named
argument is never marked, and nothing changes for it.

The first version of the fix (review of #1420) only covered a bare named
argument on the read dispatch (`_index_arg_moved_here`, keyed on the
argument's own token); the write, the twin and a temporary that moves a
local still fell back to the undeclared method.

## Verification

- The reproducer fails at the C compiler with the develop-built
  `yo-dev-ed733408c` and compiles and prints `78` after the fix.
- `tests/index.test.yo`, "Index: a generic impl takes a move-only named local
  by value": the reproducer, a later read of the moved `k` is still E0901, and
  a `HashMap(Box(i32), i32)` looked up by a named box (on develop that half
  fails earlier, at the map's probe E0901 of
  `issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`).
- The extra Consume events the trials log are harmless. Rechecked with the
  final fix under ASan, with a `Drop`-counting key: a read through a named
  key, a constructor temporary and a call temporary each drop the key exactly
  once, and so does a `b(k)` in one `cond` arm only, on each path (1, then 2).
  A `b(k)` of an outer `k` inside a `while` is still E0901 ("moved inside the
  loop"), and so is a read of `key` after `m(key) = v`. The write itself drops
  its key twice, but that is the assignment's codegen running the
  `index_mut` call twice, on develop too and with any owning key
  (`issues/fixed/2026-10-17-an-assignment-through-an-index-call-runs-the-call-twice.md`, S1).
- A nested access through generic impls can still fall back to an
  unspecialized method without any named move
  (`issues/fixed/2026-10-17-a-nested-index-call-on-generic-impls-calls-an-unspecialized-method.md`).
- The review cases, both of which fail at the C compiler with the
  first-version binary (`call to undeclared function`) and pass after:
  "IndexMut: a write through a generic impl with a move-only named key"
  writes `m(wk) = i32(60)` and reads it back, and "Index: a temporary
  argument that moves a named local" looks up `b(_IxWrap(k : k1))` and
  `b(_ix_wrap(k2))`, each local still E0901 afterwards and each key dropped
  once.
- `tests/rc.test.yo`'s unique-`Box` section looks a `HashMap(Box(UBoxPoint),
  Box(i32))` up by the named box `h2`.
