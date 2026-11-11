# Borrow and ownership diagnostics name the wrong place, mode or rule

**Severity:** S3. The verdicts below are right (or are tracked by their own issues); the text is not: an E0911 that
names a method as the place, an E0912 that says a caller's storage "ends with the call", an E0908 that calls a
closure capture a `match` binding, help lines that suggest a fix the language no longer has. A user, and an agent
repairing code from the message, is sent to the wrong line or the wrong rule.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C8): one roll-up of every misleading message the ten
probing lanes met, grouped by cause. Measured on develop `64f33c710`. Related open documents, not repeated here:
`issues/e0908-calls-an-untyped-self-receiver-a-match-or-for-binding.md`,
`issues/2026-10-29-e0920-calls-a-shared-projection-binding-a-mut-borrow.md`,
`issues/2026-11-07-origin-mismatch-diagnostics-print-the-declared-type-without-its-origins.md`,
`issues/2026-11-07-e0909-is-raised-with-three-meanings-under-one-registry-entry.md`,
`issues/2026-11-07-yo-explain-e0911-e0912-e0910-teach-the-pre-decision-43-model.md`,
`issues/2026-11-10-e0926-prints-a-double-reference-for-a-reference-binding-bound-from-a-call.md`.

## 1. The place printed is not a place

| Program | Message | Should name |
| --- | --- | --- |
| `r := xs.index(usize(0)); xs.push(v); use(r)` (and `clear`, `append_to`, `bump`: any method call on a frozen receiver) | E0911 "Cannot read `xs.push` here" | `xs` (and "write", not "read", for a `&mut self` method) |
| a lend of a field, `f(&mut w.s)`, under a live loan of `w.s` | E0911 names `w`; the lend is printed `&mut((w.s))` | `w.s`, printed `&mut w.s` |
| `d := io.async({ &mut x }(io : Io) => …)` beside a second capture of `x` | E0910 prints the desugared expression: `(io.async)(_(__yo_mut(x))(io : Io) => begin(...))` | the source text of the capture |
| a capture or a parameter whose type is a reference | the type is printed `*(String)` (also E0605 "Expected type `*(String)`") | `&String` |
| `dyn(H(r : &s))` | E0909 names the internal `Rc(H)` | `Dyn(...)`'s payload `H` |
| an import cycle | the cycle list contains internal binding names | module paths only |

## 2. The storage or the rule is misdescribed

| Program | Message | True |
| --- | --- | --- |
| a projection that yields a reference into a module-level binding; a by-value `o : Option(&(String, q))` parameter returned; an `io.async` returning `&x.*` of a `&x` capture | E0912 "its storage ends with the call" / "the origin names a local of this function" | the place is the caller's or a global's; if the program is to be rejected, the reason is another (the last case is tracked as the audit's C7) |
| a write through a `&` capture of a closure; an `FnMut` closure calling a `&mut self` method on its own state | E0908 "`x` is a `match` or `for` binding" | `x` is a closure capture |
| `match(&G, .Some(r) => r.*.*)` over a global | E0920 "`r` is a `&mut` borrow" | the scrutinee is a `&` |
| a read walk `for(&xs, x => …)` whose element is misused | "it is a `&mut` borrow" | it is a `&` borrow |
| a handler body naming an installer binding | E0923 "A closure's reference result … the closure captures" | a handler is not a closure; the other handler captures say "A regular function … cannot capture" |
| an implicit capture of a `&mut` parameter `p` | "`p` is a local borrow (`p := &place` …)" | `p` is a parameter |
| `thread_local(mut(G)) := Option(&i64).None` | "cannot hold a reference-counted type" | E0909: a module-level binding accepts no origin |
| a decision 25 cursor walk whose pattern is `Box(n)` | "`n` is a binding of a by-value `match`" | the match is borrowed; the program is one decision 25 accepts |
| `H(x)(r : &y)`; `(h : H(x)) = H(y)(…)` | no diagnostic at the mismatch (a later write of the root is still E0911) | E0923 at the constructor |
| a generic callee whose origins are fixed by the first argument | E0923 "fixed to `p, q`": the callee's unsubstituted parameter names | the caller's places |
| `Option(H(static))` after an earlier `Option(H(p))` instantiation | printed as `Option(H(origin(p)))` | the erased identity of the first instantiation leaks into the text |

## 3. Types called move-only that are not, and fixes that no longer exist

| Program | Message | True |
| --- | --- | --- |
| a second use of a moved `String`, `ArrayList` or `Box` | E0901 calls the type "move-only", then suggests `.clone()` | a type with `Clone` is not move-only; say "moved here" and suggest the clone or a borrow |
| a tuple `(&i32, i32)`; an implicit capture of `s : &String` | "whose type … is move-only" | both are `Copy`; the capture copies the reference |
| a move out of a global | help: `.clone()` or `sink(G)` | `sink` is not the spelling for a global |
| a `for(&mut xs, x => …)` element moved | help: `sink(x)` | an element behind a `&mut` cannot be moved out; suggest `mem.replace` / `take` |
| `replace(&mut x, x)` | an uncoded error in the pre-decision-42 vocabulary | E0910 |
| a union with a `String` field | "must be runtime types" | the field type needs `Copy` / no destructor |

## 4. Forms rejected with the text of a different form

| Program | Message | True |
| --- | --- | --- |
| `r := &b.*.s`, `mut(r) := &b.*` over a local `b : Box(X)` | "cannot reach through a pointer dereference … no owner" | `b` owns the payload; `r := &b.s` and `H(r : &b.*)` are accepted, so the rejection is inconsistent (the rooting rule is the audit's D10) |
| `type_of(ra)` for `ra := &a` | E0926 (a reference must be read with `.*`) | `type_of` reads no value |
| a module-level initializer that names a later runtime binding | E0401 | a forward reference in a runtime initializer; the message should say that module-level `:=` initializers run in order |

## Root causes

Three causes would cover most rows; they are hypotheses read off the messages, not confirmed in the source. (1) The
access-conflict diagnostic prints the callee expression of a method call as the accessed place, and prints lends
from the desugared AST rather than the source text. (2) Binding provenance is a small set of flags — parameter,
local borrow, `match`/`for` binding — and a capture, a handler parameter or a global falls into the nearest one;
the message is chosen from the flag. (3) E0901's text predates explicit `Clone` and decision 43: "move-only" is
used for every non-`Copy` type, and reference types are not recognized as `Copy` in the wording path.

## Expected

Each message names the source-level place in source syntax, the mode the user wrote, and the rule that applies to
the binding's real provenance; help lines suggest only spellings the current language accepts.

## Test

Golden rows for each table line in `tests/cli-cases/` (diagnostic text is golden-tested there) or as
`expect_error` cases beside `tests/local_borrows.test.yo`, added with the fix of each cause.
