# The verifier loses a lent list argument at a contracted call

**Severity:** S2: a contracted call that lends a list (`f(&xs, &out)`) fails
verification with a subset error, so a `distinct(...)` requirement and the
`old(...)` havoc of a mutated list argument stop working once the call site
carries decision 33's markers.

> Found 2026-10-12 by develop's "Formal verification (pinned Z3)" job after
> #1318 (E0914 always on). `tests/spec/fixtures/valid/list_distinct.yo` still
> passed its lists bare, so it failed to load with E0914; with the markers
> added it loaded and then failed to verify.

## Reproducer

`tests/spec/fixtures/valid/list_distinct.yo` with markers:

```yo ignore
append_all :: (fn(src : &ArrayList(i32), dst : &ArrayList(i32),
  requires(distinct(src, dst), (dst.len() + src.len()) >= dst.len()),
  ensures(dst.len() == (old(dst.len()) + src.len()))) -> unit)(...);
into_fresh :: (fn(xs : ArrayList(i32), ensures(r.len() == xs.len())) -> (r : ArrayList(i32)))({
  out := ArrayList(i32).new();
  append_all(&xs, &out);
  out
});
```

`yo verify` reported `subset ... cannot verify: unbound runtime name 'dst'`
for `into_fresh` and `forward`.

## Root cause

`src/verifier/vc.yo`'s call handling names the caller's variable behind each
argument in two places: `call_arg_names` (what a callee's `distinct(p, q)` is
proved from) and the `old(...)` havoc of a list argument the callee mutates.
Both required the argument to be a bare atom, so a marker `&xs` named
nothing: the havoc skipped `out`, and the callee's ensures then read its own
parameter `dst`, which nothing bound.

## Fix

`_arg_place_atom` peels a call-site marker (`&x`, `&mut x`) to the lent atom,
and both places use it.

Regression: the two `list_distinct` fixtures (now with markers), run by
`tests/internal/verifier_list_len.test.yo` ("distinct(a, b) lets a body
mutate one of two same-typed lists; one list passed as both refutes").
