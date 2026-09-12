# A template nested inside an interpolation lowers to `import(...).to_string()`

**Status:** FIXED (2026-09-12) — the interpolation sub-parse uses
`Parser.get_expression_program`, which does not prepend the auto-import.

## Symptom

Any template literal inside another template's `${…}` fails to compile, with a
message that names neither the file position nor the construct:

```
error[E0403]: Module field "to_string" not found in module type
  --> src/build_runner.yo:1:1
  |
1 | //! Build runner — `yo build` implementation.
```

Ten-line reproducer:

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  a := `x${`y`}z`;
  println(a);
});
export(main);
```

The shape it was found in — a separator written inline — is natural enough that
it appears the first time anyone joins a list inside a message:

```rust
deps := if(names.len() == usize(0), String.new(), ` <- ${`, `.join(names)}`);
```

Binding the inner template to a variable first works, which is what makes the
failure so confusing:

```rust
sep := String.from(", ");
deps := ` <- ${sep.join(names)}`;      // fine
```

## Root cause

`parse_template_string` parses each interpolation with a FRESH sub-parser and
takes the first expression of the result:

```rust
inner_prog := Parser.new(sp.expr_text, self.module_path, exn).get_program(exn);
inner_expr := inner_prog.get(usize(0));
```

`get_program` is a MODULE-level entry point: when the source it parsed contains
a template string, it **prepends** `import("std/fmt/to_string")` (or
`std/fmt/format` for a `:spec`) so the `.to_string()` calls the template lowers
to can resolve. A nested template makes that true of the sub-source as well, so
element 0 is the import and the interpolation lowers to

```
import("std/fmt/to_string").to_string()
```

— a `.to_string()` on a MODULE, which is exactly what the evaluator reports.
The diagnostic points at line 1 because the synthesized import carries
row 0/column 0.

## Fix

A sub-parse of ONE expression must not carry a module-level auto-import.
`Parser.get_expression_program` runs `do_parse` and returns the program as
parsed; `parse_template_string` uses it and propagates the sub-parser's
`has_template_spec` upward, because it is the ENCLOSING module's import that
has to become `std/fmt/format` when a nested spec is used.

## Gate

`tests/template_string_specs.test.yo` — "a template nested inside an
interpolation": the minimal `` `x${`y`}z` ``, the inline-separator join that
found it, and a `:spec` inside a nested template (which pins the flag
propagation). Verified red first: the file fails to COMPILE on the pre-fix
compiler with the message above.
