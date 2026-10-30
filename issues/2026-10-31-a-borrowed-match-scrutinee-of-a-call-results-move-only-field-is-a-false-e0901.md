# A borrowed `match` scrutinee of a call result's move-only field is a false E0901

**Severity:** S2 — a valid program is rejected. `match(&make().fd, x => x.n)` reports E0901 "cannot copy `make().fd` … it is a field of another value", though the scrutinee only lends the field. The same match over a local (`t := make(); match(&t.fd, …)`) is accepted.

**Status:** OPEN — found 2026-10-31 on `vbd/b8-arraylist-string-flip`: `tests/match_structs.test.yo`'s "a scrutinee over a field of a call result releases the result once per evaluation" (`match(&_scr_tok(i).s, x => x.len())`) stopped compiling once `String` became a value; that test now matches on a `.clone()` and names this issue. Develop `9c78fdaf0` and the v0.2.73 seed reject the same shape with any move-only field.

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
