# A `str` literal passed as a `String` argument inside template interpolation type-checks but miscompiles

## Symptom

```rust
ident :: (fn(s : String) -> String)(s);
main :: (fn() -> unit)({
  println(`k=${ident("key")}:`);     // compiles clean, emits wrong C
});
export(main);
```

`yo check` passes (comptime `str` unifies with `String`), but the emitted C
passes the raw `__yo_str` struct where the callee's `String`
(`__yo_t_…`) parameter is expected — the C compiler rejects it:

```text
error: passing '__yo_str' to parameter of incompatible type '__yo_t_…'
```

The same call OUTSIDE a template interpolation is believed to have the same
hole (the conversion is missing at the argument-lowering level, not the
interpolation level); the interpolation case is where it was found.

## Root cause

The evaluator's argument unification accepts a comptime `str` literal for a
`String` parameter, but the str→String conversion (heap copy of the bytes
into an owned String) is never emitted by codegen for argument positions —
`__yo_str` is lowered verbatim. Everywhere else the codebase (and std)
writes `String.from("…")` explicitly, which is why nothing tripped it: the
conversion exists only as the explicit `String.from` call.

## Workaround used

Pass `String.from("literal")` at the call site (what `yo context --format
json`'s key emission now does).

## Proper fix (open)

Either (a) codegen emits the str→String materialization for any argument
whose parameter type is String and whose argument is a comptime str, or
(b) the evaluator REJECTS str-for-String at the argument gate so the
mismatch is a check error instead of a miscompile. (b) is smaller but
pushes `String.from` noise onto every call site; (a) matches user
expectation and the checker's existing unification. Discovered in
`yo context` C4 (`plans/YO_CONTEXT.md`) — the `--format json` key
emission was the first `${f("literal")}` shape in the tree.
