# Certain comments directly above a definition poison its def-eval when the module loads as a dependency

**Status: OPEN.** Found 2026-08-31 building the TLS runtime backend
(fix/tls-runtime-backend): a `//` comment block placed directly above a new
`fn` in `src/codegen/async/runtime_io_common.yo` made the module fail with
`Cannot unify incompatible types: "String" and "str"` — but ONLY when the
module was loaded as a DEPENDENCY (checking `runtime.yo`, which imports it);
checking `runtime_io_common.yo` directly passed.

## Measured

- A 6-line `//` comment above `generate_tls_runtime` (mentioning
  `__yo_tls_*` externs, `std/crypto/tls.yo` paths, and
  `(AsyncRuntimeOptions.uses_tls)` in parens) → dependency-load fails,
  direct check passes.
- Replacing it with the one-liner `// TLS runtime (see generate_tls_runtime).`
  → ALSO fails on dependency load (the parens look like a signature?).
- Removing the comment entirely → the def still failed while the emitter
  body was ~72 separate `em.emit_string_line("...")` calls, with the failing
  prefix BISECT moving as lines were edited (non-monotonic; strongly suggests
  a parse/def-eval interaction, not one bad line).
- Rewriting the SAME emitter as one `emitter.emit_string(...)` with a
  single concatenated string → everything passes (262/262).

So at least two faces: (a) comment-with-parens/paths above a definition, (b)
many sequential `emit_string_line` string literals in one body — both only
reproducible on the dependency-load path, both resolved by the rewrite. Same
family as issues/builtin-name-shadows-user-definition.md's "doc-comment
shaping": comment text influencing def-eval.

## Suggested attack

The dependency-load path (`_load_module_at_abs`) evaluates definitions in a
different env/order than the entry path (`mm_load_file`); a comment-derived
`doc` field that the entry path ignores may be consumed as a SIGNATURE hint
on the dependency path. Repro: the branch `fix/tls-runtime-backend` at the
commit before the `emit_string` rewrite.
