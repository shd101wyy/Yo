# A `match` arm binding that shadows a local of the same name is never dropped

**Severity:** S1 — an unbounded leak in ordinary synchronous code: every evaluation of a by-value `match` whose arm binding reuses an enclosing local's name, and does not move the binding, leaks the payload (a `String`, a list, any `Drop` value).

Found while migrating `tests/async_await.test.yo` off `ref(struct)` (V5 part B, branch
`vbd/v5-part-b-tests`), on develop 68b45b81d. ASan reported a leak in the
"nullable-pointer arm binding" case once its `Cargo` payload became a value (`Rc`) instead of
a `ref` object. The leak is not async-specific.

## Symptom

```yo ignore
parsed := V(tag : i32(1));
inner := match(find_v(), .Some(parsed) => parsed.tag, .None => i32(0)); // arm binding shadows `parsed`
```

The arm's `parsed` (the payload moved out of the `find_v()` temp) is never dropped. Reproducer:
`issues/repros/2026-11-05-shadowing-match-arm-binding-leaks.yo` (`yo compile <it> -o r && ./r`
prints `drops=1` for the shadowing arm and `drops=11` for the same match with a distinct binding
name; both should be 11). With a `String` payload, `--sanitize address` reports the string's
bytes as leaked.

Measured shapes (develop 68b45b81d):

| Shape | Payload dropped |
| --- | --- |
| `match(temp, .Some(parsed) => parsed.tag, …)` beside a local `parsed` | no |
| the same with a named scrutinee (`o := find_v(); match(o, …)`) | no |
| the same with a distinct binding name (`.Some(other)`) | yes |
| the same without an enclosing `parsed` | yes |
| the arm moves the binding (`.Some(parsed) => take(parsed)`) | yes (by the callee) |
| a borrowed scrutinee (`match(&find_v(), .Some(parsed) => …)`) | yes (the temp owns it) |
| `ref(struct)` payloads (the binding is a dup) | yes |
| inside an `io.async` body, across awaits | no |

## Root cause

A consuming arm's binding that still owns its payload after the arm's body gets a
`___drop(parsed)` attached to the end of the arm (`drop_owned_match_binding_at_arm_end` →
`_drop_in_arms_that_keep`, `src/evaluator/utils.yo`). The drop names the value, so that helper
refuses to attach it when another binding of the same name could capture the name in the arm
(a `.Some(x)` pattern in an arm that keeps an outer `x`). Its check scanned EVERY same-named
binding visible in the arm body's env, including the bindings the value itself shadows: the
enclosing local `parsed` counted as "another binding", so the helper returned without attaching
the drop, and nothing else releases the payload.

A name resolves to its innermost binding, so only a same-named binding declared after the value
(deeper, or later in its own frame) can capture the drop. `get_variables_from_env` lists
bindings outermost first, so the check now starts the scan just past the value's own entry.
The by-value join (`Case 3`, a value moved in some arms) runs the same helper and keeps its
behavior: there the value is the outer local, so an arm's same-named pattern binding still lies
after it and still blocks the drop.

## Second cause, uncovered by the first fix

With the drop attached, an early `return` (or an unwind) inside the shadowing arm released the
binding twice and the enclosing local never: the exit drops both values by name, and the arm's
C block declared the binding under the enclosing local's C name (`__yo_v_parsed`), so both
drops named the binding. Before the fix this shape dropped the binding once through the
enclosing local's drop and leaked the local. `issues/fixed/2026-11-03-an-unwind-drop-names-a-shadowing-local-of-another-type.md`
assumed a target declared before the exit point is never hidden behind a same-named inner
local; a `match` pattern binding is exactly such a local.

- A pattern binding whose C name is already declared in an open enclosing block is declared
  under a fresh C name (`shadow_binding_decl_name`, `src/codegen/functions/context.yo`), and
  the arm's reads of the name resolve to the innermost binding's C local
  (`FunctionGenerationContext.shadow_bindings`, a stack per name, so an outer arm's binding is
  visible again after a nested arm of the same name closes).
- A compiler-emitted drop resolves its target by identity (`_drop_operand`,
  `src/codegen/exprs/rc_fns.yo`): the drop's atom resolves through the scope the drop was
  attached in, so a target that is a further-out binding renders that binding's C local, and a
  value declared before every binding of the name renders as if no arm shadowed it.

The emit diff over `src/main.yo` (develop 58ec8be03, base binary vs this branch) is two
renames: the compiler has two pattern bindings that shadow a same-named C local
(`_dtm_walk`'s `o` parameter in `src/main.yo`, a `.Some(n)` binding in `generate_deferred_drop_expressions`, `src/codegen/exprs/drop_dup.yo`), now declared
`__yo_v_o_s0` / `__yo_v_n_s0`.

## Test

`tests/shadowed_binding_early_return_drop.test.yo`: the reproducer's value shape, the named
scrutinee, an early return from the shadowing arm, nested shadowing arms (and a read of the
outer arm's binding after the nested arm), an early return from a nested shadowing arm, an
unwind out of a shadowing arm, a `String` payload (the LeakSanitizer verdict), and the async
nullable-pointer (`Rc`) shape with and without an early return. The
"nullable-pointer arm binding" case of `tests/async_await.test.yo` is back on `Cargo` (an
`Rc` value payload), as before V5 part B moved it to a `ref` object.
