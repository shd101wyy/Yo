# The explicit-copy tool over-inserts `.clone()` inside an `FnOnce` body

**Severity:** S3 — `yo fix --migrate explicit-copy` rewrites a capture that an `FnOnce` closure moves at its last use into `.clone()`, which costs a needless deep copy of a `String` or collection; the program it produces still compiles and runs correctly.

**Status:** open. Filed 2026-10-24 from the VBD lookahead (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §8, probe P-B; D1 and B4-0b). Reproduced with the v0.2.68 seed.

## Reproducer

`issues/repros/2026-10-24-explicit-copy-clones-a-listed-capture-an-fnonce-body-moves.yo`:

```yo
{ String } :: import("std/string");
{ HashMap } :: import("std/collections/hash_map");
{ println } :: import("std/fmt");
with_once :: (fn(h : &mut HashMap(String, String), sink(body) : Impl(FnOnce(v : &mut HashMap(String, String)) -> unit)) -> unit)(
  body(h)
);
main :: (fn() -> unit)({
  (mut(h) : HashMap(String, String)) = HashMap(String, String).new();
  k := String.from("a");
  v := String.from("b");
  with_once(&mut h, { k, v }(m) => {
    _ := m.insert(k, v);
  });
  println(`${h.len()}`);
});
export(main);
```

`yo check` passes and the compiled program prints `1`: the evaluator already accepts moving the listed captures `k` and `v` out of the `FnOnce` body. The migration disagrees:

```text
$ yo fix ./repro.yo --migrate explicit-copy --dry-run
fix: ./repro.yo:12:19: param: `k` would become `k.clone()`
fix: ./repro.yo:12:22: param: `v` would become `v.clone()`
fix: would insert 2 `.clone()` call(s); 0 site(s) left as written (listed above); 0 file(s) did not evaluate
```

Expected: nothing to insert. A capture named in a by-value capture list is owned by the closure, and an `FnOnce` body runs once, so its last use is a move.

## Fix

The lookahead's B4-0b: the explicit-copy tool treats a by-value listed capture used at its last use in an `FnOnce` body as a move. Its regression test is a `fix-migrate-explicit-copy*` cli-case over this reproducer whose golden lists no site. It blocks B4's `RefCell.with_mut` move to `sink(body) : Impl(FnOnce(...))` (D1): without it, the 82 rewritten `with_mut` sites would each gain clones.
