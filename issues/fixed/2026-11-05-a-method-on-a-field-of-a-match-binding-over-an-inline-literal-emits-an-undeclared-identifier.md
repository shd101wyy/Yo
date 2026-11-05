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

## Root cause

Not match-specific: any field read of a struct literal with a runtime field fails the same way
(`Point(x : f(), y : i32(1)).x` emits `__yo_v_x`). The evaluator records a runtime construction
as a `StructVal` shell with `UnknownVal` leaves (`value_contains_unknown`, `src/value.yo`), and a
`match` binding over the literal inherits that value. `_generate_field_access_raw`
(`src/codegen/exprs/property_access.yo`) took every object whose value is a `StructVal` down
the module-namespace path: a field with a known value was emitted as that constant, and any
other field by name as a variable of its own, which only a module member is. So the runtime
field became the bare `__yo_v_name`.

The same path had a second consequence: a known field of a runtime construction was folded to
its constant without evaluating the object, so `Point(x : f(), y : i32(1)).y` never called
`f()` (develop 58ec8be03 prints `1 0` for the call count of that read).

## Fix

The namespace path takes a module, or a struct value with no runtime leaf (a compile-time
struct, where folding is exact and has nothing to run). A runtime construction falls through to
the ordinary value-shape access, `(<object code>).<field>`, which runs the construction once.
Inside the path, only a module's member is resolved by name; a compile-time struct's
struct-valued field is read from its C value.

## Test

`tests/match_structs.test.yo`: "a method on a field of a match binding over an inline literal"
(owned and borrowed scrutinee) and "a field of a struct literal with a runtime field" (the
runtime field, the folded constant field with the construction's call counted, a method on a
field). `tests/async_await.test.yo`: `Task` is a value struct again, and "a method on a field of
a match binding over an inline literal across an await" covers the `io.async` shape.
