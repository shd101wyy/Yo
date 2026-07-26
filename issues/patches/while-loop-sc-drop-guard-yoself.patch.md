# Prepared patch: yo-self while_loop.yo short-circuit drop guard (mirror of the TS fix)

Apply AFTER the in-flight TIER 2 completes (the TS side is already edited in
`src/codegen/exprs/while.ts`; both must land in ONE commit — see
`issues/ts-while-loop-body-drops-missing-guards.md`).

In `yo-self/codegen/exprs/while_loop.yo`, the loop-body end-of-scope drop pass
(the `match(current_drops, .Some(drops) => { ... })` loop around line 167)
already skips undeclared temps (`undeclared_temp`). Add the
`short_circuit_handled_drop_var_names` skip around the drop emission, mirroring
`yo-self/codegen/exprs/begin.yo:132-144`:

```rust
                if(!(undeclared_temp), {
                  sc_skip := match(
                    context.short_circuit_handled_drop_var_names,
                    .Some(handled) => match(
                      get_deferred_drop_target_atom_name(de),
                      .Some(target) => if(handled.contains(target.clone()), {
                        _r := handled.remove(target);
                        true
                      }, false),
                      .None => false
                    ),
                    .None => false
                  );
                  if(!(sc_skip), {
                    code := _call_generate_expr(de, indent.clone(), context);
                    if(code.len() > usize(0), {
                      line := indent.clone();
                      line.push_string(code);
                      line.push_str(";");
                      em.emit_string_line(line);
                    });
                  });
                });
```

Then add the corpus test (BOTH compilers must emit working C — before the
mirror the yo-self side double-drops):
`tests/codegen-bootstrap/while_or_shortcircuit_owned_temp.yo` — the reproducer
from the issue doc (loop with `flagged := ((i == usize(0)) || (make_list(i).len() > usize(1)))`,
prints `2`). Corpus baseline becomes PASS 141.

Gates: TIER 1 + (batch) TIER 2 — this changes EMITTED C for any loop body
containing a side-effectful `||`/`&&` RHS with owned temps, so watch the
corpus diff and the stage2 hollow-marker count specifically.
