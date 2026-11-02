# A borrowed `match` scrutinee of a call result's move-only field is a false E0901

**Severity:** S2 — a valid program is rejected. `match(&make().fd, x => x.n)` reports E0901 "cannot copy `make().fd` … it is a field of another value", though the scrutinee only lends the field. The same match over a local (`t := make(); match(&t.fd, …)`) is accepted.

**Status:** OPEN — found 2026-10-31 on `vbd/b8-arraylist-string-flip`: `tests/match_structs.test.yo`'s "a scrutinee over a field of a call result releases the result once per evaluation" (`match(&_scr_tok(i).s, x => x.len())`) stopped compiling once `String` became a value; that test now matches on a `.clone()` and names this issue. Develop `9c78fdaf0` and the v0.2.73 seed rejected the same shape with any move-only field at the time of filing.

**Re-measured 2026-10-31 on the rebased branch** (`vbd/b8-arraylist-string-flip-r2`, develop `40ba307f2` + the flip): the v0.2.73 seed now ACCEPTS every repro shape under `check --test-bodies` — `match(&_mk().fd, x => x.n)` over a `Drop` struct field, `match(&_mk().s, x => x.len())` over a value `String` field, and the exact `_scr_tok(i).s` borrowed-literal shape with the drop-counting global (`tmp/scrut-repro*.test.yo` in the worktree). Something in develop's 10-31 evaluator fixes (#1692 V4 AstExpr era, #1694's `match.yo` false-E0901 fix) covers it. Pending: the same shapes under the TREE binary and a real `yo test` run of `match_structs`; if they pass, restore `match(&_scr_tok(i).s, ...)` in the test and move this doc to `fixed/`.

## Reproducer

```yo
{ assert } :: import("std/assert");
_Fd :: struct(n : i32);
impl(_Fd, Drop(drop : (fn(self : &mut Self) -> unit)(())));
_T :: struct(n : i32, fd : _Fd);
_mk :: (fn() -> _T)(_T(n : i32(1), fd : _Fd(n : i32(7))));
test("call", {
  c := match(&_mk().fd, x => x.n); // E0901
  assert(c == i32(7), "n");
});
```

## Expected

The scrutinee lends the field of the call's result temporary, which lives until the match ends (the temporary is released after the match, as the test above already checks for `&_scr_tok(i).s` while `String` was a reference type). A fix restores `match(&_scr_tok(i).s, x => x.len())` in `tests/match_structs.test.yo` and adds the reproducer as a test.
