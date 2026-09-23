# The syntax cheatsheet advertised a FIXED `inout` miscompile as OPEN, with avoidance guidance for a pattern that works

**Status:** FIXED 2026-09-24
**Severity:** papercut (documentation) — actively misleading: agents following the
cheatsheet would avoid a correct, useful shape (`generic(...)` trait methods
with primitive `inout(self)` receivers — the D3.9 Hasher shape) and rewrite
code around a bug that no longer exists.
**Found:** 2026-09-24, during the `inout` soundness sweep of
`plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` (round 2, re-verifying every
inout-related known-issue claim against the current tree).

## Symptom

`.github/skills/yo-syntax/syntax-cheatsheet.md` carried:

> **KNOWN MISCOMPILE — a trait method carrying its own `generic(...)` reads a
> PRIMITIVE `inout(self)` as a POINTER (OPEN, 2026-08-25).** … Until it is
> fixed, write such a method with a by-value `self`, or keep the receiver a
> struct.

while the cited record,
`issues/fixed/generic-trait-method-reads-primitive-inout-self-as-pointer.md`,
has been **FIXED BY EVENTS** since 2026-08-28 (re-measured under the v0.2.19
seed and the tree binary; pinned since by `tests/hash.test.yo`'s SipHash
values through primitive receivers).

## Verification (2026-09-24, this branch's tree-built binary)

```rust
G :: trait(g : (fn(generic(S : Type), inout(self) : Self, dummy : S) -> u64));
impl(i32, G(g : (fn(generic(S : Type), inout(self) : Self, dummy : S) -> u64)(u64(self))));
i32(42).g(true)   // → 42 (was: the receiver's address)
```

## Fix

The bullet now states the correct behavior and points at the fixed-issue
record; the avoidance guidance is gone. Because the cheatsheet's sha256 is
pinned in the skills-coupled cli-case goldens, all seven were re-recorded
(`init`, `init-cwd`, `init-existing`, `skills-install`, `skills-install-zh`
via the recorder; `build-stamp-dotted-dir` and `init-build-test` by
hand-hashing the single cheatsheet line — their build legs need clang, which
this box lacks; CI's corpus leg is the end-to-end arbiter). Exactly one hash
line changed per golden.
