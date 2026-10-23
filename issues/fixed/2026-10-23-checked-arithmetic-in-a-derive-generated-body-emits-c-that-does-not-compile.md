# Checked arithmetic in a derive-generated body emits C that does not compile

**Severity:** S2 — a valid program is rejected: any `derive_rule` body that
does checked integer arithmetic (`+`, `-`, `*`, unary `-`, `/`, `%`) or a
checked index fails in the C compiler with `expected expression`.

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 while writing the loop probes for
`issues/fixed/2026-10-23-a-break-or-continue-before-a-later-move-skips-the-drop-of-a-loop-body-local.md`.
Reproduced with the v0.2.68 seed and a develop-built binary (`56dd8253f`).

## Reproducer

```yo
{ println } :: import("std/fmt");
Count :: trait(next_of : (fn(k : i32) -> i32));
__derive_count :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))({
  body :: "({ j := (k + i32(1)); j })";
  ctx.make_impl(quote(Count(next_of : (k -> unquote(body.to_expr())))))
});
derive_rule(Count, __derive_count);
H :: struct(n : i32);
derive(H, Count);
main :: (fn() -> unit)({
  println(H.next_of(i32(1)));
});
export(main);
```

```text
error: expected expression
  __yo_add_chk_s((long long)(__yo_v_k), (long long)(1), (-2147483647 - 1), 2147483647, "auto-generated://
```

## Root cause

A checked operation passes its source location to the runtime trap as a C
string literal built by `_idx_c_string_literal`
(`src/codegen/utils/index.yo`), which escaped only `"` and `\`. Code the
compiler parses from a string carries the pseudo module path
`auto-generated://\n// === START auto-generated code ===\n<code>\n// === END …`
(`src/parser.yo`), so the literal held raw newlines and the C string was
unterminated.

## Fix

`_idx_c_string_literal` writes every control byte (below 0x20, and 0x7f) as
a three-digit octal escape. The trap's message then names the generated code
as its file, which is what the token says. The same helper serves the checked
index, division and negation guards.

**Regression test:** `tests/derive.test.yo`, "a derive-generated body with
checked arithmetic compiles; a `break` drops a live value local". Under the
v0.2.68 seed the file fails in the C compiler.
