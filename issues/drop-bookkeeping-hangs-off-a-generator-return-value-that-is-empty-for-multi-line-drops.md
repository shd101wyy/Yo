# Drop bookkeeping hangs off a return value that is EMPTY for multi-line drops, so the drop is emitted but never recorded

**Found**: 2026-09-05, root-causing the short-circuit chain double-drop
(`issues/fixed/short-circuit-chain-inner-operand-temps-still-leak.md`).
**Status**: OPEN for the two remaining sites. **Severity: latent double-free** —
a drop that is emitted without being recorded can be emitted again by the next
flush that considers it, which is a double `__yo_decr_rc` and a use-after-free.

## The shape

`_call_generate_expr(drop_expr, …)` does not always RETURN the drop code. For an
enum/`Option`-typed target it lowers to a multi-line `switch` block that
`drop_dup.yo` writes **directly to the emitter**, handing back `""`. A promoted
string literal — `(id == \`lit\`)` — is exactly such a target, so this is the
common case, not an exotic one.

Every guarded flush is written like this:

```rust
drop_code := _call_generate_expr(drop_expr, indent.clone(), context);
if(drop_code.len() > usize(0), {
  line := indent.clone();
  line.push_string(drop_code);
  line.push_str(";");
  em.emit_string_line(line);
  _m := context.emitted_deferred_drop_ids.insert(ast_expr_id(drop_expr));   // <-- never runs
});
```

The generator has ALREADY emitted by the time `drop_code` is inspected. When it
returned `""` the body is skipped, so `emitted_deferred_drop_ids` — and any
name-keyed set maintained beside it — never learns that this drop is on the
page. The next emission point that considers the same drop sees both signals
empty and emits it a second time.

## How it was found

Instrumenting all 25 drop-emission sites with a `// __DBG_SRC=<file><n>` marker
line before each `emit_string_line` and compiling
`((id == \`a\`) || (id == \`bb\`)) || (id == \`ccc\`)` produced **18
`dropdup4` markers and ZERO `and_or` markers** — `and_or`'s bookkeeping branch
never executed, while its drops appeared in the output anyway. That is the
signature: emissions with no owner.

It is also the answer to a question that cost two prior sessions. The record in
`issues/fixed/short-circuit-chain-inner-operand-temps-still-leak.md` describes
"an uninstrumented fourth emitter" placing fall-through drops, and both dedup
signals "reading empty at the second consideration". There is no fourth
emitter — there is a generator that emits as a side effect and a guard that
believes an empty string means nothing happened.

## Fixed at one site, still live at two

`src/codegen/exprs/and_or.yo` now records unconditionally and emits
conditionally (both the pending source and the node source).

Still carrying the pattern:

| site | line | what it guards |
| --- | --- | --- |
| `src/codegen/exprs/begin.yo` | 154 | the begin/scope-end deferred-drop flush |
| `src/codegen/exprs/drop_dup.yo` | 895 | `generate_deferred_drop_expressions` |

Neither is currently observed to double-drop, because nothing else reconsiders
the drops they emit. That is a property of the current emission graph, not of
the code — the short-circuit family had the same property until a chain gave it
a second emission point.

## Fix

Move the guard inserts out of the `len() > 0` body at both sites, so the
recording tracks the DECISION to generate rather than the shape of the return
value. The safest form is what `and_or.yo` now uses:

```rust
drop_code := _call_generate_expr(drop_expr, indent.clone(), context);
_m := context.emitted_deferred_drop_ids.insert(ast_expr_id(drop_expr));
if(drop_code.len() > usize(0), { ...emit drop_code... });
```

Better still, make the contract explicit: have the drop generator report whether
it emitted (return a bool alongside the string, or always return the text and
never emit), so a caller cannot get this wrong by writing the obvious thing.
That is the change that would retire the class rather than the instance.

## Regression test

The short-circuit side is covered by `tests/short_circuit_drops.test.yo`, whose
chain and mixed cases are exactly the second-consideration shapes (they
double-dropped, `rc=133`, before this was fixed). For `begin.yo` and
`drop_dup.yo` the equivalent gate is a shape where one of their flushes emits a
multi-line drop that a LATER flush also considers — construct it before
changing them, so the fix is verified rather than assumed.
