# A function body stores one reference parameter through another with elided origins

**Severity:** S1 — use-after-free in safe code: a named function with no closure and no origin spelled stores its `&` parameter into its `&mut` parameter's pointee, and the caller's slot outlives the referent

Found 2026-11-08 while scoping O-3 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8): the named-function form of H2 (`issues/2026-11-07-a-closure-body-stores-a-per-call-reference-parameter-through-another-parameter.md`).

## Reproducer

Program: `issues/repros/2026-11-08-a-function-body-stores-one-reference-parameter-through-another-with-elided-origins.yo`.

`store :: (fn(v : &Rc(X), s : &mut Option(&Rc(X))) -> unit)({ s.* = .Some(v); })` is called as `store(&k, &mut slot)` with `k` a block local, and `slot` is read after the block. `yo check` accepts it (tree binary at develop `a25a71ee1`; the v0.2.75 seed too). Compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`.

## Root cause

The elision rule (O2; plan §7's table: "a fresh anonymous origin per `&` occurrence, innermost included") makes `v`'s origin and the origin inside `s`'s pointee two distinct rigid origins of the body, so the store is an origin mismatch. The checker does not implement this. A parameter's elided origins carry no name in the body, so the `=` join's subset check (`bind_join`) has nothing to compare and only grows `s`'s flow set. At the call, `lend_through` fixes nothing either: no origin is spelled, so the caller's `slot` never learns that it holds `&k`.

## Fix

Not fixed. The O-3 lane proposes rigid elided origins in every body (literal and named function); see the lane's design question.

## Test that pins it

None yet. The fix adds this program under `tests/origins/unsound/` (G-B, expect E0923) with a positive twin that spells one shared origin parameter.
