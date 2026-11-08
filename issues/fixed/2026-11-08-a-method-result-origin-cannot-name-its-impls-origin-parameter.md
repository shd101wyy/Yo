# A method's spelled result origin cannot name its impl's origin parameter

**Severity:** S2 — valid programs are rejected: a method of an origin-parameterized holder whose result spells the holder's origin (`-> &(T, p)` / `-> &mut(T, p)` with `p` from `impl(generic(p : Origin), H(p), …)`) is E0922 "The origin `p` is not declared", so the decided signatures of G2's holders (`HashMapEntry.or_insert(self : Self, v : V) -> &mut(V, p)`, VERDICTS-36 Q4; `REFERENCES_AND_ORIGINS.md` §3's entry row) cannot be written.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) on a develop `a25a71ee1` tree binary. The same origin in a PAYLOAD position is accepted: `-> Option(&(i32, p))` on the same impl checks and runs, as does an `Iterator(Item : &(T, p), next : … -> Option(&(T, p)))` impl. Only a projection result (a function returning `&`/`&mut` directly) loses the impl's `p`.

## Reproducer

`issues/repros/2026-11-08-a-method-result-origin-cannot-name-its-impls-origin-parameter.yo`:

```yo
{ assert } :: import("std/assert");
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p)));
impl(generic(p : Origin), H(p), get : (fn(self : &Self) -> &(i32, p))(&self.r.*));
main :: (fn() -> unit)({
  x := i32(1);
  h := H(x)(r : &x);
  y := h.get();
  assert(y.* == i32(1), "read through the holder's origin");
});
export(main);
```

```text
error[E0922]: The origin `p` is not declared.
help: declare it in the signature, `generic(p : Origin)`, or name a reference parameter, `-> &(T, xs)` for `xs : &T`
```

Every receiver mode fails the same way (`self : Self`, `&Self`, `&mut Self`), for `&` and `&mut` results.

## A second gap on the same shape

With the result origin elided instead (`take : (fn(self : Self) -> &mut i32)(&mut self.r.*)` on `H(p)` holding `r : &mut(i32, p)`), the body is E0910 "This argument moves `self`, which an earlier argument of the same call lends to it" — a by-value holder cannot yield a place through its own reference field, which is how Rust's `Entry::or_insert(self) -> &'a mut V` is written.

## Where to look

The spelled-origin check of a projection result resolves origin names against the method's own `generic(...)` clause and its reference parameters only; the impl's `generic(p : Origin)` (in scope for the method's parameter and payload types) is not consulted there.

## Fix

Rust's rule for `impl<'p, K, V> Entry<'p, K, V> { fn or_insert(self) -> &'p mut V }`: the impl's origin parameter is in scope in every method's signature, and a call binds it from the receiver's type.

- `evaluate_result_origin` (`src/evaluator/types/function.yo`) accepts an origin-kind name from the impl's environment. A name no parameter's type spells (`type_spells_origin`, `src/types/definitions.yo`) is E0922 with a message saying the call could not bind it, instead of a guess.
- At the call, specialization elides origins, so the result's name matches no parameter slot. `projection_call_root_args` (`src/evaluator/utils.yo`) then roots every origin-carrying argument. `origin_of` now walks a method call's receiver (`m.entry(k)` lends `m`), so `or_insert`'s result points into the map, not into the entry.
- The result of a holder's projection takes over the holder's loan (`_bind_projection_result`), so `e.or_insert(v)` does not conflict with `e`'s own `&mut` of the map.
- The by-value body `&mut self.m.*` is no longer E0910: `_call_lends` skips a function literal's own value (the end-of-body `___drop(self)` saw the literal's body as a lent argument).
- The single-root rule (`_projection_call_root_error`, `src/evaluator/builtins/ptr_fns.yo`) checks a holder argument's places, so an entry of a local map returned from a projection is E0912.

## Test

`tests/origins/impl_origin_result.test.yo`, std-free: the reproducer's `&` holder (bound, read in place, outliving the holder; a write to its place while the result lives is rejected), the entry's `or_insert` shape (in place and bound; a read of the map while the result lives and a result that outlives a local map are rejected), the by-value `self : Self -> &mut i32` holder, and the E0922 case of a name no parameter's type spells.
