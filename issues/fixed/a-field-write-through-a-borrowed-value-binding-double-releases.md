# A field write through a borrowed value binding releases a value it does not own

**Found:** 2026-09-25, chasing a nondeterministic hang of `yo check` (`plans/TYPE_SYSTEM_SOUNDNESS.md`
Phase 4.4b). **Severity:** CRITICAL (use-after-free and double release in safe code).
**Status:** FIXED on `tss/field-write`.

## Reproducer

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
P :: struct(s : String);
f :: (fn(p : P) -> unit)({
  p.s = String.from("a-new-string-long-enough-to-live-on-the-heap");
  println(p.s);
});
h :: (fn(o : Option(P)) -> unit)(match(o, .Some(d) => {
  d.s = String.from("another-new-string-long-enough-for-the-heap");
  println(d.s);
}, .None => ()));
main :: (fn() -> unit)({
  x := P(s : String.from("the-original-string-long-enough-for-the-heap"));
  f(x);
  println(x.s);
  o := Option(P).Some(P(s : String.from("the-original-payload-long-enough-for-heap")));
  h(o);
  match(o, .Some(q) => println(q.s), .None => ());
});
export(main);
```

Built with the v0.2.42 seed or a develop compiler (`--optimize 2`), the binary traps
(rc=133, a corrupted malloc freelist); under `libgmalloc` it faults (rc=139).

## Root cause

A by-value parameter and a `match`-arm binding BORROW their value: the parameter is a C
copy of the caller's struct, and the binding is a C copy of the scrutinee's payload. Neither
owns the RC data inside. Writing a field through such a binding (`p.s = …`, the documented
"you can mutate fields through a parameter") lowers like a write into owned storage:

```c
old = p.s;            // save the old value
p.s = new_string;     // write into the C copy
__yo_decr_rc(old);    // release the old value: the CALLER still owns it
```

The caller (or the scrutinee temp) later releases the same old value again, and the new
value is never released, because the borrowed binding is not dropped at scope end.

It surfaced in the compiler itself: Phase 4.4b's `with_code` (`src/error.yo`) wrote
`d.code = …` through a `match` binding of an `ArrayList(Diagnostic).get` result. The
compiler binary corrupted its heap and hung in `__yo_gc_collect` at exit about one run in
three. `with_code` now builds a fresh `Diagnostic` (the compiler source is compiled by the
seed, which has this bug).

## Fix

A write whose storage is a borrowed value binding's own copy, and whose old value holds RC
data, is rejected with E0908 (`borrowed_value_root_of_place`,
`src/evaluator/exprs/assignment.yo`). The path from the root must stay inside the copy: a
field of a value struct or tuple, an element of a fixed array. A write through a `ref`
object, a pointer, a `Box` or a collection goes into heap storage its object owns, and is
unaffected; so is a field without RC data (the documented "mutate a field through a
parameter"), which changes only the local copy.

```
error[E0908]: Cannot write `p.s`: `p` is a by-value parameter, which borrows its value, and the old value holds data (String) that its owner still holds. Writing it would release that data. To change it, take it as `own(p) : T` or `inout(p) : T`, or copy it into a local first (`q := p;`) and write the copy.
```

Making such a binding own a copy instead (dup at its binding, drop at its scope end) was
weighed and rejected. A probe over `src/` and `std/` found only two such writes in the whole
tree, and both were wrong in another way too: each wrote into a copy that was then
discarded or written back by hand. Rejecting them points at the mistake.

The two sites:
- `format_error_messages_with_help` (`src/error.yo`) set `first.help` on a COPY of the
  primary diagnostic, so the help line never reached the error. It now writes the updated
  diagnostic back.
- `src/doc/context_index.yo` wrote `e.origin` on a borrowed element before storing it back.
  It now updates an owned copy.

## Tests

- `tests/cli-cases/field-write-through-a-borrowed-parameter-is-e0908`
- `tests/cli-cases/field-write-through-a-match-binding-is-e0908`
- `tests/rc.test.yo`: "a borrowed value is changed through an owned copy" (the owned-copy
  forms and a non-RC field write still work).
- The E0908 registry example (`yo explain E0908`, `diagnostics_registry_examples`).
