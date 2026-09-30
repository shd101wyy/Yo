# An impl member cannot call a trait method defined in a later impl of its own type

**Severity:** S2 — `impl` registration is documented as order-independent within a module (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), but a member that calls a method of a LATER `impl` on the same type is rejected

**Status:** OPEN (filed 2026-09-30).
**Found:** diagnosing `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`'s second case.

## Measured

```rust
S :: struct(x : i32);
impl(S, dup_via : (fn(self : Self) -> S)({
  (r : S) = self.clone();
  r
}));
impl(S, Clone(clone : (fn(inout(self) : Self) -> Self)(S(x : self.x))));
export(S);
```

```
$ yo check main.yo
error[E0610]: No method "clone" on S: the type has no field or method with that name.
  --> main.yo:5:19
```

The same on develop (2026-09-29, after #1022) and on the v0.2.46 line. With the `Clone` impl
placed first it checks. A user-defined trait in place of `Clone` behaves the same. When the
member is generic, the miss is not reported but degrades to `unit` in its definition-time trial
(`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`).

## Where (read, not yet fixed)

A method miss on a named receiver forces the type's pending impls and retries
(`force_pending_impls_for_type_name`, `src/evaluator/context.yo`). It refuses to force while an
impl of the same type is itself being evaluated. The guard was added because forcing a later
`impl(Sha1, Digest(...))` in the middle of Sha1's own registration evaluated it against a
half-registered type (`tests/crypto/digest.test.yo`). The guard also blocks this cross-impl
reference, which is not an in-block sibling reference.

## Next step

Separate the two cases. An in-block sibling miss belongs to the impl's own shell pre-pass. A
miss for a name that no member of the in-flight impl defines may force a later impl. Alternatively,
defer the member's trial until every impl of the type is registered. The Sha1 digest test is the
regression guard for the first path.
