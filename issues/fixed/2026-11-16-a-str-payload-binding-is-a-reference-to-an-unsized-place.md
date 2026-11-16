# A `str` payload binding is a reference to an unsized place: `t := s` in its arm is rejected and its origin is lost

**Severity:** S2. On the `str` flip's tree binary (decision 49 S2, `vbd/d49-str`; never on develop), a valid program
was rejected. A local copy of a `.Some(s)` binding over an `Option(str)` failed with "Cannot bind `t` to `s`: the
projection borrows no argument, so its place has no storage to borrow." This held for a consuming match, for a
borrowed match, and for a scrutinee from `ArrayList(str).get`. The same binding yielded by an arm
(`.Some(s) => s, .None => "~"`) was G-E's `[origin-totality] lost origin_of` in the compiler's own tree, at
`src/expr.yo:950` and `src/expr.yo:1185`. That made `scripts/check-origin-sinks.sh --totality` fail on `./src` with 2
findings.

Filed 2026-11-16 by the d49-str lane, fixed on the same branch before it was opened.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
or_default :: (fn(o : Option(str), d : str) -> str)(
  match(
    o,
    .Some(s) => {
      t := s;
      t
    },
    .None => d
  )
);
first :: (fn(xs : &ArrayList(str)) -> str)({
  v := match(xs.get(usize(0)), .Some(s) => s, .None => "~");
  v
});
export(or_default, first);
```

`yo check` rejected `or_default`. For `first`, `YO_AUDIT_ORIGIN_TOTALITY=1 yo check` printed a `lost origin_of`
line.

## Root cause

Under the flip, a value `str` is the legacy alias of `&(str, static)`, so `Option(str)`'s payload is a reference.
`evaluate_match` (`src/evaluator/exprs/match.yo`) binds a reference payload as a *reference binding*. The name gets
the pointee's type (here the unsized `str`, with `is_ref` set) and its C slot holds the pointer (decision 43 step 3).
For `&(str, static)` that is wrong in two ways:

- `t := s` reads a reference binding, so R-TAIL binds `t` as a local borrow of what `s` borrows
  (`_bind_projection_result`). A static reference borrows nothing, so there is no place to borrow and the binding is
  rejected.
- A read of `s` is typed as the fat `&str` (the value-`str` arm A2) with an elided origin, which carries an origin.
  Once the arm's frame has ended, `origin_of` no longer resolves `s`, so G-E reports the name as lost.

Develop's flip binary rejects `t := s` the same way over a sized reference payload, in safe code too
(`o : Option(&i32)`). That case is filed as `issues/2026-11-16-a-reference-payload-copied-to-a-local-in-its-arm-is-rejected.md`.

## Fix

A payload whose type is a legacy static view (`is_static_view_slot`: a shared `&(P, static)` over an unsized `P`)
binds by value, as the `&(str, static)` it is. This matches how `s := "abc"` and a `s : str` parameter bind
(`function_type.yo`'s and `helper.yo`'s `p_view`). In `evaluate_match` it is not a reference payload, and a borrowed
match does not bind it as a pointer into the scrutinee (`p_view`). `_emit_pattern_binding_decl`
(`src/codegen/exprs/match.yo`) declares it as the `__yo_str` value and does not register it as a place.

Test: `tests/str.test.yo`, "a str payload binds the &(str, static) value". On the branch before the fix, the batch
failed to compile with the error above (measured with the d27 tree binary). It passes after the fix. The
`./src` totality count goes from 2 to 0.
