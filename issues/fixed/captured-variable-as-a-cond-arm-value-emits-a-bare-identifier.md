# A captured variable used as a `cond` arm's VALUE emits a bare identifier

**Status:** FIXED 2026-09-10 — `src/codegen/exprs/atom.yo`.

## Symptom

Inside an `io.async` closure, reading a captured parameter as a `cond` arm's
value emits the bare name instead of the `closure_context` access, and the C
compiler rejects the file:

```
./tests/http/.yo_selftest_batch_1_0.bin.c:20486:32: error: use of undeclared identifier 'size'
```

## Minimal reproducer

`issues/repros/captured-variable-as-a-cond-arm-value.yo`:

```rust
{ println } :: import("std/fmt");
{ IoExn, Exception } :: import("std/error");

pick :: (fn(cap : usize, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async(e => {
    r := cond((cap < usize(10)) => usize(0), true => cap);
    r
  })
);

main :: (fn(io : Io, exn : Exception) -> unit)({
  e := IoExn(io : io, exn : exn);
  println(`${io.await(pick(usize(42), io), e)}`);
});
export(main);
```

```
$ yo compile tmp/fixme.yo --optimize 2 -o /tmp/fixme_bin
/tmp/fixme_bin.c:2153:32: error: use of undeclared identifier 'cap'
```

The emitted C shows the asymmetry exactly — the condition's `cap` is rewritten,
the arm's is not:

```c
static inline size_t closure_yo_id_11460(void* closure_context, __yo_t0 e) {
  size_t _file____priv_temp_17218;
  if (((((__yo_t14*)closure_context)->cap) < (10ULL))) {   /* rewritten */
    _file____priv_temp_17218 = 0ULL;
  }
  else {
    _file____priv_temp_17218 = cap;                        /* NOT rewritten */
  }
  ...
```

Shapes measured, same closure and same variable:

| arm value | result |
| --- | --- |
| `cond((cap < usize(10)) => usize(0), true => cap)` | **broken** |
| `cond((cap < usize(10)) => cap, true => usize(0))` | **broken** |
| `cond(true => cap)` | **broken** |
| `cond((cap < usize(10)) => usize(0), true => (cap + usize(1)))` | fine |
| `cond((usize(1) < usize(10)) => usize(0), true => cap)` | fine (the cond folds away) |

So the trigger is a **bare** capture atom in an arm-value position. Wrapping it
in any expression routes it through the function-call argument path, which
rewrites correctly — which is why this survived: almost every real use of a
capture is inside some expression.

## Root cause

`src/codegen/exprs/atom.yo` asked "is this variable captured?" **twice**, and
the two copies keyed on **different names**.

The emitting path keys on the source token:

```rust
cap_name := tv.clone();
is_captured := ... caps.contains(cap_name.clone()) && check_variable_is_closure_captured(cap_name, e, level) ...
```

The guard that decides whether to take the plain-identifier early return keyed
on `ExprInfo.variable_name`:

```rust
captured := ... caps.contains(var_name.clone()) && check_variable_is_closure_captured(var_name, e, level) ...
if(!captured, {
  return(_var_read_code(tv.clone(), env_opt));   // <-- bare identifier
});
```

And `variable_name` is exactly the field that is untrustworthy in this
position. The comment immediately below the guard already said so:

> yo-self's `attach_temp_variable_to_expr` can stamp a SPURIOUS temp
> `variable_name` onto a bare reference used as a cond/match arm value (e.g.
> `(cap == 0) => min_cap`); emitting that temp yields an undeclared identifier.

For a cond-arm value, `variable_name` is that spurious temp
(`_file____priv_temp_17218`). The capture set holds the real name (`cap`), so
`caps.contains(var_name)` was false, the guard concluded "not captured", took
the early return, and emitted the bare token — never reaching the path that
would have rewritten it. The fix for the *spurious temp* was already in place
(resolve by token, not by `variable_name`); what was missing is that the
**capture question must be asked about the token too**.

## Fix

One predicate, `_is_captured_here(name, env_opt, context)`, used by both sites
with the source token. Two copies of one question, keyed differently, is the
defect; deleting the duplicate is the fix rather than patching the guard's key.

```rust
_is_captured_here :: (fn(name : String, env_opt : Option(Environment), context : FunctionGenerationContext) -> bool)(
  match(
    context.current_closure_captures,
    .Some(caps) => match(
      context.current_closure_capture_frame_level,
      .Some(level) => (
        caps.contains(name.clone()) &&
          match(env_opt, .Some(e) => check_variable_is_closure_captured(name.clone(), e, level), .None => true)
      ),
      .None => false
    ),
    .None => false
  )
);
```

## Why byte-identity still holds

The change only affects atoms the old guard classified as "not captured" while
the emitter would have classified them as captured — and every such program
**failed to compile**. Nothing that compiled before can change, which the
stage-2/stage-3 fixpoint confirms.

## Test

`tests/closure_capture_cond_arm.test.yo` — the capture read as a bare arm value
in every broken shape (final arm, first arm, single-arm `cond`, `match` arm),
plus the expression-wrapped shape as a control.

Verified in both directions with the same test file:

```
$ <compiler built BEFORE the fix> test ./tests/closure_capture_cond_arm.test.yo
./tests/.yo_selftest_batch_1_0.bin.c:5922:32: error: use of undeclared identifier 'cap'
./tests/.yo_selftest_batch_1_0.bin.c:5949:32: error: use of undeclared identifier 'cap'
./tests/.yo_selftest_batch_1_0.bin.c:5977:37: error: use of undeclared identifier 'cap'
./tests/.yo_selftest_batch_1_0.bin.c:6011:32: error: use of undeclared identifier 'cap'

$ <compiler built AFTER the fix> test ./tests/closure_capture_cond_arm.test.yo
5 passed
```

Four of the five shapes were broken; the fifth is the control.

## How it was found

Writing a test-local `Reader` for `std/http/wire`'s keep-alive framing:

```rust
limit := cond((self.chunk < size) => self.chunk, true => size);
```

`size` is the `read` parameter, captured by the `io.async` closure. Every
`std/` and `src/` use of a capture happens to sit inside some larger
expression, so nothing in the tree had ever hit the bare-atom arm position.
