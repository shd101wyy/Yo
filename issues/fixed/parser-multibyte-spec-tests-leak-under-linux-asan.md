# The two multibyte spec-peel parser tests leak under Linux ASan (clang 21) — the `||` first-operand literal temps

**Status: FIXED** (found 2026-09-03; root cause fully characterized
2026-09-04; fix in the P1–P3 close-out: `src/codegen/exprs/and_or.yo`).

Originally filed as: the two multibyte spec-peel parser tests
(`Peel a format spec off a MULTIBYTE template expression`, `A spaced
colon-pair stays a colon-pair with multibyte content`) leak
`SUMMARY: AddressSanitizer: 1881 byte(s) leaked in 32 allocation(s)` under
the local clang-21 toolchain, CI-invisible, pre-existing on pristine develop.

## The real mechanism (not multibyte, not the peel path)

A minimal repro reduced it to nothing multibyte at all — every parse of a
template interpolation leaks, ASCII included (100 × `parse("\`${x:>8}\`")`
leaks 200 allocations; the multibyte variant identically):

```rust
is_res :: (fn(id : String) -> bool)(
  (id == `forall`) || (id == `∀`)
);
```

Symbolized stacks (batch C rebuilt with `-g`): the leaked objects are the
`String.from(...)` temps the `==` promotions create for the str literals —
allocated inside the tokenizer's reserved-word check
(`src/lexer.yo` `(id_str == `forall`) || (id_str == `∀`)`), which every
identifier tokenization evaluates. The emitted C showed the cause:

```c
t1 = String.from("forall");
b1 = eq(id, t1);
if (!b1) { t2 = String.from("∀"); b2 = eq(id, t2); ... }
return sc;            // ← NO drop of t1 anywhere on the fall-through
```

In `generate_op_and` / `generate_op_or` (`src/codegen/exprs/and_or.yo`), the
closing-brace loop emits branch drops for operands 1..n via
`_emit_drops_for_conditional_branch` — but the FIRST operand is evaluated
unconditionally, so its created temps have no in-branch point, the body-level
flush-first gate-skips them (their C declarations do not exist yet at that
point), and the implicit-return tail flushes param-targeted drops only. The
temps simply had no owner. Deeper nesting sometimes covered the second
operand's temp (a later flush point) — which is why only some shapes tripped
LeakSanitizer.

## The fix

Both operators now emit the first operand's created-temp drops at the
construct's fall-through (after all braces, before the value is returned to
the caller), through the same `_emit_drops_for_conditional_branch` helper —
which also removes them from pending and marks them handled, the identical
discipline to the in-branch operands, so the scope-end flush cannot
double-emit. The two multibyte parser tests are the regression net: they
leak-aborted before the fix under the internal shards' LeakSanitizer build
and pass after it.

Validation vehicle: the internal-test shards (LeakSanitizer builds) plus the
minimal repro above compiled with `--sanitize address --allocator system`.
