# A closure that moves a by-value capture on one branch leaks it when the other branch runs

**Severity:** S1 — an unbounded leak in accepted safe code: each call of such a closure that takes the branch which does not move the capture leaks the capture's heap buffer.

**Status:** open. Found 2026-11-17 by the deref-owner lane (VERDICTS-63 Generation A): `tests/internal/diagnostics_registry_examples.test.yo` failed on a LeakSanitizer report (317 bytes in 8 allocations), all allocated by `String.clone` in `set_closure_writes_captures` (`src/evaluator/utils.yo`), whose closure moved its `fid` capture into the map when `writes` held and only borrowed it otherwise. The reproducer below leaks on a develop `916b279c1` binary as well. The compiler no longer uses the pattern (that function now builds one closure per branch); the codegen bug is open.

## Reproducer

`issues/repros/2026-11-17-a-closure-moving-a-by-value-capture-on-one-branch-leaks-it-on-the-other.yo`, built with
`--std-path ./std --optimize 1 --sanitize address --allocator system`:

```yo
{ String } :: import("std/string");
{ HashMap } :: import("std/collections/hash_map");
{ RefCell } :: import("std/sync/refcell");
(g_tbl : RefCell(HashMap(String, bool))) = RefCell(HashMap(String, bool)).new(HashMap(String, bool).new());
note :: (fn(func_id : &String, writes : bool) -> unit)({
  fid := func_id.clone();
  g_tbl.with_mut({ fid, writes }(m) => {
    if(writes, {
      m.insert(fid, true);
    }, {
      m.remove(&fid);
    });
    ()
  });
});
main :: (fn() -> unit)({
  k := String.from("a-func-id-long-enough-to-be-on-the-heap");
  note(&k, false);
  note(&k, true);
  note(&k, false);
});
export(main);
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 39 byte(s) in 1 object(s) allocated from:
Direct leak of 39 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 78 byte(s) leaked in 2 allocation(s).
```

Two leaks, one per `writes = false` call. A closure that never moves `fid` (`{ fid }(m) => { m.remove(&fid); () }`) does not leak, and the `writes = true` call does not either.

## Root cause

The closure's C body moves `closure_context->fid` into `insert` on one branch and only lends it to `remove` on the
other. A closure that never moves `fid` has its capture dropped with the record, so the record's drop skips a
capture the body moves on SOME path, and the non-moving branch drops nothing either. A capture moved on some paths
needs a drop on the others (a drop flag, or a drop at the end of each non-moving branch), as a conditionally moved
local gets.

## Workaround

Build one closure per branch, so each closure moves its capture on every path or never moves it
(`set_closure_writes_captures`, `src/evaluator/utils.yo`).
