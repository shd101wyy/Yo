# A typed declaration is not a holder binding: it freezes nothing, and its joins skip the scope check

**Severity:** S1. A use-after-scope passes `yo check`. A holder declared with a type annotation (`(h : T) = v` or
`(mut(h) : T) = v`) registers no loans and has no binding site. A lend stored into it from an inner block is
therefore read after the block ends, and its initial value's root can be written while the holder is live.

Found 2026-11-09 while fixing
`issues/fixed/2026-11-08-a-match-binding-of-a-reference-payload-carries-its-own-place-as-origin.md`: std's
`IterFilter.next` declares its result holder as `(mut(loop_result) : Option(A)) = .None`. Present on develop ee24d9058.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (mut(h) : Option(&String)) = .None;
  {
    inner := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
    h = .Some(&inner);
  };
  match(h, .Some(s) => println(`OUT: ${s.*.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

`yo check` accepts it. Under ASan the binary reports `stack-use-after-scope`. The written spelling
`mut(h) := Option(&String).None` is E0911.

A second shape: `(h : Option(&String)) = .Some(&s); s = String.from("x"); _ := h;` is accepted. `h` observes the
write, because nothing froze `s`.

## Root cause

A typed declaration is evaluated by `evaluate_assignment` (an `=` whose left side is a `:` call), not by the `:=`
path. Three gaps followed:

- `bind` (N2b's binding freeze) ran only on the `:=` path.
- The begin block armed no look-ahead frame for the statement (`local_borrow_is_mut_binding_stmt` and its siblings
  match `:=` only).
- `_lb_binding_site_of` recognized only `:=`, so the `=` join's live range ended at the store (`site=NO` in the
  `YO_DEBUG_N2B` trace), and the §7 scope check never compared the root's block end with the holder's last use.

## Fix

- `evaluate_assignment` runs `bind` for a typed declaration whose type carries an origin, as the `:=` path does.
- `local_borrow_is_typed_decl_stmt` arms the declaration's look-ahead frame.
- `_lb_binding_site_of` recognizes `(name : T) = v` and `(mut(name) : T) = v` as the binding's site.

## Tests that pin it

- G-B: `tests/origins/unsound/typed-holder-inner-block.yo` must be E0911. Its positive twin,
  `typed-holder-inner-block-pos.yo`, must be accepted.
- `tests/local_borrows.test.yo`: `_typed_holder_freezes` (the write while the holder is live) and
  `_typed_holder_scope` (the inner-block join).
