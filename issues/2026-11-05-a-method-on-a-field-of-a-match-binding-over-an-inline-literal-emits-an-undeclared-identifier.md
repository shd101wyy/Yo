# A method on a field of a `match` binding over an inline literal emits an undeclared C identifier

**Severity:** S2 — a valid program fails in the C compiler (`use of undeclared identifier '__yo_v_name'`); naming the scrutinee first is the workaround.

Found while migrating `tests/async_await.test.yo` off `ref(struct)` (V5 part B, branch
`vbd/v5-part-b-tests`), on develop 68b45b81d. The case "a reassignment in an awaitless nested
arm beside an awaiting arm" matches on `Option(Task).Some(Task(name : …))`. It compiled while
`Task` was a `ref` object and fails in clang once `Task` is a value struct.

## Symptom

```yo ignore
Task :: struct(name : String);
a := match(Option(Task).Some(Task(name : String.from("exe"))), .Some(t) => t.name.len(), .None => usize(0));
```

```
error: use of undeclared identifier '__yo_v_name'
yo: error: compile: C compiler failed (exit 1)
```

Reproducer: `issues/repros/2026-11-05-method-on-field-of-match-binding-over-inline-literal.yo`
(`yo compile <it> -o r && ./r` should print `3`).

The emitted C binds the arm correctly (`Task __yo_v_t = <tmp>.data.__yo_v_Some.__yo_v_value;`),
but the receiver of the method call is emitted as `__yo_v_name`, the field name alone, where the
scope-end drop of the same arm correctly spells `(__yo_v_t).__yo_v_name`.

Measured (develop 68b45b81d):

| Shape | Result |
| --- | --- |
| `match(Option(S).Some(S(name : …)), .Some(t) => t.name.len(), …)` | C error |
| the same in an `io.async` body, with or without an await in the arm | C error |
| `match(&Option(S).Some(S(…)), …)` (borrowed temp) | C error |
| `o := Option(S).Some(S(…)); match(o, …)` (named scrutinee) | compiles, correct |
| `S :: struct(x : i32, y : i32)` (Copy), `.Some(p) => (p.x + p.y)` | compiles, correct |
| `S :: ref(struct(name : String))` | compiles, correct |

## Root cause (not yet located)

The scrutinee is a literal whose variant and payload are known statically, so the match is
probably resolved early and the arm binding is tied to the constructor's argument list. A field
read through the binding then resolves to the constructor argument *named* `name` and is emitted
as a variable reference, `__yo_v_name`. A `ref` payload was a heap handle read through its
pointer, so it did not take that path.

## Test

`tests/async_await.test.yo`'s "a reassignment in an awaitless nested arm beside an awaiting arm"
keeps a `ref` payload (`Task`) until this is fixed; its comment names this doc. The fix makes
`Task` a value struct again, adds the reproducer as a test case (a method on a field of the
binding, sync and inside `io.async`), and moves this doc to `issues/fixed/`.
