# An error in a lazily forced callee under `!` is reported as E0610 at the `!`, and the real error is lost

**Severity:** S3: a body error (here an E0914 missing `&` marker) two calls down is reported as `E0610 No matching call found with arguments: !(_middle(s))` at the outermost `!`. The message names neither the failing function nor its error, so the author has to bisect by hand.

**Status:** OPEN.
**Found:** 2026-11-03 while staging decision 43 N1f (`vbd/d43-n1f`). A bare `name` passed to a `&String` parameter in a new helper surfaced only as an E0610 at an `if(!_callee_slot_is_fnmut(...), ...)` two definitions up (`src/evaluator/calls/function.yo`). Reproduced with yo 0.2.73 (the seed) and with develop ce827ae52.

## Reproducer

```yo
{ String } :: import("std/string");
_outer :: (fn(s : &String) -> bool)(!_middle(s));
_middle :: (fn(s : &String) -> bool)(_inner(s).is_some());
_inner :: (fn(s : &String) -> Option(usize))({
  name := s.clone();
  _len_of(name)
});
_len_of :: (fn(t : &String) -> Option(usize))(Option(usize).Some(t.len()));
main :: (fn() -> unit)({
  s := String.from("ab");
  _outer(&s);
});
export(main);
```

`yo check` prints:

```text
error[E0610]: No matching call found with arguments:
!(_middle(s))
  --> lost_err.yo:2:37
```

When `_outer`'s body is `_middle(s)` (no `!`), the same check reports the real error, at `_inner`'s line 6:

```text
error[E0914]: Parameter "t" is a `&` borrow (`t : &T`): lend `name` with `&name`. ...
```

## Root cause (suspected)

`!` is one of the prelude's operator `Call` tuples, and its dispatch tries each candidate against the argument types. The argument `_middle(s)` forces `_middle` (and, through it, `_inner`) lazily, because `_middle` is referenced before its definition (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`). That forcing raises the E0914. The candidate loop seems to treat the raised error as "this candidate does not match", then reports that no candidate matched. The forced body's own error should propagate. This has not been traced in the dispatcher yet.

## Fix direction

When the operator-candidate trial raises an error that came from forcing a definition, rather than from the candidate's own parameter match, re-raise that error. The regression test is the reproducer above: its `yo check` must name E0914 at line 6. It belongs in a `comptime_expect_error`-free CLI or `tests/` check case, because the error sits in a top-level definition.
