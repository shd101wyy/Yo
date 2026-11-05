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

## Root cause (not yet located)

The arm binding owns the moved-out payload, so the arm's scope end must drop it. The drop is
attached by name, and the name resolves to the enclosing local of the same name. That local is
dropped once at its own scope end, so the arm's value is never released. The binding needs its
own identity (the pattern-binding node or a fresh symbol) for drop scheduling, not its spelling.
Before V5, most payloads in this shape were `ref` handles, where the binding is a dup of the
scrutinee's count and the scrutinee's drop released it.

## Test

`tests/async_await.test.yo`'s "nullable-pointer arm binding" case keeps a `ref` payload
(`_NpCargo`) until this is fixed; its comment names this doc. The fix switches that case to
`Cargo` (an `Rc`, so the nullable-pointer lowering still applies), adds the reproducer's value
and `String` shapes as test cases, and moves this doc to `issues/fixed/`.
