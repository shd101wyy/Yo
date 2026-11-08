# A method's spelled result origin cannot name its impl's origin parameter

**Severity:** S2 — valid programs are rejected: a method of an origin-parameterized holder whose result spells the holder's origin (`-> &(T, p)` / `-> &mut(T, p)` with `p` from `impl(generic(p : Origin), H(p), …)`) is E0922 "The origin `p` is not declared", so the decided signatures of G2's holders (`HashMapEntry.or_insert(self : Self, v : V) -> &mut(V, p)`, VERDICTS-36 Q4; `REFERENCES_AND_ORIGINS.md` §3's entry row) cannot be written.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) on a develop `a25a71ee1` tree binary. The same origin in a PAYLOAD position is accepted: `-> Option(&(i32, p))` on the same impl checks and runs, as does an `Iterator(Item : &(T, p), next : … -> Option(&(T, p)))` impl. Only a projection result (a function returning `&`/`&mut` directly) loses the impl's `p`.

## Reproducer

`issues/repros/2026-11-08-a-method-result-origin-cannot-name-its-impls-origin-parameter.yo`:

```yo
{ assert } :: import("std/assert");
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p)));
impl(generic(p : Origin), H(p), get : (fn(self : &Self) -> &(i32, p))(self.r));
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

## Test

The fix adds the reproducer and the by-value `self : Self -> &mut(T, p)` shape to `tests/origins/reference_read_rule.test.yo` and moves this doc to `issues/fixed/`.
