# A local borrowed into `addr_of` dangles after return, and launders E0921

**Severity:** S3 — `addr_of` of a local borrow is accepted in unsafe code and yields a dangling pointer when it escapes; it also bypasses the new E0921 rule for `&T` parameters

Found while gating `fix/reject-addr-of-borrowed-param` (E0921,
`issues/retired/2026-10-25-should-addr-of-a-borrowed-parameter-be-rejected.md`),
by probing the laundering shapes the review asked for.

## Symptom

Two silent forms (no diagnostic at all), both under `pragma(Pragma.AllowUnsafe)`:

```yo
S :: struct(n : usize);
// Form 1: launders E0921 — the &T parameter hides behind a local borrow.
laundered :: (fn(s : &S) -> *S)({
  r := &s;
  addr_of(r)
});
// Form 2: the same hole without any parameter — the borrow root is a plain local.
plain_local :: (fn() -> *S)({
  x := S(n : usize(1));
  r := &x;
  addr_of(r)
});
```

Driver evidence (v0.2.70 tree binary, 2026-10-25): the pointer
`laundered(&ss)` returns is NOT `addr_of(ss)` (the callee's frame, not the
caller's place), and after `plain_local()` returns, reading `p.*.n` prints a
stale stack value (`108607386489200` in the run). Both pointers dangle the
moment the enclosing `fn` returns.

By contrast, the projection laundering shape IS blocked today, but only
incidentally: `addr_of(s.first_n())` with `first_n : (fn(self : &Self) -> &usize)`
raises E0908 (`Cannot write ... is a read projection`), because `addr_of`
treats its operand as a write position. E0921 itself never fires there.

## Root cause

`evaluate_address_call` (`src/evaluator/builtins/ptr_fns.yo`) raises E0921 by
resolving the operand's variable chain (`_by_value_borrow_param_root`): an
`Atom`, or a place reached through field/element steps of aggregates the
variable holds inline. A local BORROW (`r := &s`) binds a fresh local variable,
so `addr_of(r)` resolves `r` — not `s` — and `r` is not a parameter. Nothing
follows the borrow back to its root, for a `&T` parameter or for any local:
`addr_of` of an escaping local borrow is accepted in general, and the
borrow root's storage dies with the callee's frame either way.

## Disposition

Not fixed here, deliberately. Closing the hole means resolving what a local
borrow borrows at every `addr_of` site — borrow roots are the refs/origins
machinery of decision 43 (`plans/backlog/REFERENCES_AND_ORIGINS.md`), and the
plain-local form shows the gap is broader than E0921's subject. The E0921 rule
of this cycle rejects the direct spelling (`addr_of(s)` and its places); the laundered
spelling needs unsafe code that names the borrow, which the
refs/origins work should cover wholesale.

Reproducers: `tmp/` probes from 2026-10-25 (the `r := &s; addr_of(r)` and
`x := S(...); r := &x; addr_of(r)` drivers, with the `same=0` and stale-read
outputs). No test added to `tests/`: pinning today's silence would cement the
gap as desired behavior.
