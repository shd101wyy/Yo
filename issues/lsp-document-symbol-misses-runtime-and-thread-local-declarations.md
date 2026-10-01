# documentSymbol misses `x := value;` and the `thread_local(...)` declaration forms

**Severity:** S3 — the outline only listed `name :: value` bindings and
typed `(name : T) = value` declarations; a module-level runtime static
(`x := value;`), a plain thread-local (`thread_local(t) := init;`) and the
typed thread-local (`(thread_local(u : T)) = init;`) were all missing from
documentSymbol AND workspace/symbol. Found 2026-09-30 by the closeout
review of the 2026-09-29 audit's documentSymbol fix — the audit itself only
listed the typed-declaration form.

## Reproduction

```rust
(c : i32) = i32(3);
x := i32(4);
thread_local(t) := i32(5);
(thread_local(u : i32)) = i32(6);
```

Only `c` appeared in the outline.

## Fix

`_runtime_decl_symbol` (`src/lsp/symbols.yo`) matches the three forms — via
`_decl_name_tok`, which reads the bound name from the left side (the atom,
or the atom inside `thread_local(name)`) — and reports each as a Variable
(13), the same kind as the typed module constant: the binding is a mutable
slot regardless of initializer shape. Covered by an internal test over all
four forms.
