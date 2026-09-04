# A dropped call result on an async early-completion path

(For the OTHER blocker in the same batch — same-named locals in sibling
branches, which accounted for the `redefinition` and undeclared-temp errors and
had a SILENT variant — see
[`async-sibling-arm-same-named-locals.md`](async-sibling-arm-same-named-locals.md).)

**Status: FIXED** 2026-08-09, in BOTH compilers, with a regression test
(`tests/async_await.test.yo`, "Test a match arm early-returning a freshly built
value before an await"). Found the same day, as one of the last 4 C errors that
kept `build`/`fetch`/`install` from being dispatched in `yo-self/main.yo`. The
five-bug async-branch cluster before it is fixed
([write-up](async-await-in-nested-match-arms.md)).

Reproducer:
[`repros/async-match-arm-early-return-drops-call-result.yo`](repros/async-match-arm-early-return-drops-call-result.yo)
— 30 lines, invalid C:

```rust
item := match(
  stack.pop(),
  .None => {
    return(String.new());     // <- early-return a FRESH value from the arm
  },
  .Some(it) => it
);
e.io.await(yield(e.io), e.io);   // a later await makes this a multi-state SM
```

A `match` used as a DEFINITION's right-hand side, one arm early-`return`ing a
freshly-constructed value, inside an async body that awaits later. Without the
later await there is a single state and the shape compiles.

`check ./yo-self` is green throughout — see plans/archive/P1_CLI_PARITY.md §1 for why
that proves nothing about codegen.

---

## The symptom

`// Error: Regular function call returns X but no temp variable assigned`

```c
__yo_struct_yoa98c08fb_id_44 _yof13d1245_temp_291228 =
  // Error: Regular function call returns __yo_struct_yoa98c08fb_id_44 but no temp variable assigned;
```

C then reports `initializing … with an expression of incompatible type 'void'`.
In `yo-self` it is two instances, both in `fetch.yo`'s `compute_content_hash`,
both in the `.None` arm of a `match` on `stack.pop()`, both on an
EARLY-COMPLETION path ("Drop local variables before early completion" follows
immediately).

## Root cause

`codegen/exprs/other-fn-call.ts:1557` emits that comment when the call has no
temp variable to hold its result (`expr.$.variableName` is undefined). A
non-unit call is emitted as a STATEMENT into a temp, never as an expression, so
with no temp allocated codegen has nothing to emit.

The evaluator did not allocate one because the call is the operand of a
`return(...)` — normally fine, since `return X` puts the call inline in the C
`return`. Inside an async state machine the `return` instead completes the
future, and the match generator then tries to assign the arm's "value" to the
match's result temp:

```c
__yo_struct_… _yof13d1245_temp_291228 = <the error comment>;
```

## The fix

Emit the call as an EXPRESSION when no temp was attached, instead of a comment:

```ts
// src/codegen/exprs/other-fn-call.ts
return `${cFuncName}(${namedCastedArgsList})`;
```

The evaluator is right not to allocate a temp — `return(String.new())` in a plain
function is `return fn_String_new();`, and a holding variable would be pure
overhead. What it cannot know is that the async lowering turns that `return` into
"declare a result temp, assign `sm->result`", which needs the call to appear as a
value. Emitting the call itself satisfies both: it is used exactly once, by the
declaration the caller is already building, and ownership transfers to that
declaration exactly as it would have to a temp.

Ported to `yo-self/codegen/exprs/other_fn_call.yo` (the `.None` arm of the
`variable_name` match).
