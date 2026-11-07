# A fused block that throws drops its by-value capture twice

**Severity:** S1: a double free in emitted code. The fused block of an immediately awaited `io.async` wrapper throws while the wrapper's by-value argument is held by the site's capture. If the await sits in a match arm, a loop body or a nested block, the argument is freed twice on the unwind.

Found 2026-11-07 by an extra test written for `issues/fixed/2026-11-07-a-fused-await-reads-the-callers-match-binding-of-the-wrappers-name.md` (#1817). Before #1817 that test failed with the wrong thrown message; after it, with this double free. The two are separate defects.

## Symptom

```text
ERROR: AddressSanitizer: attempting double-free on 0x77a829fe0010 in thread T1:
    #1 _file____home_temp_103041535180771482801_state_dispose
0x77a829fe0010 is located 0 bytes inside of 3-byte region
freed by thread T1 here:
    #1 _file____home_temp_103041535180771482801_resume
```

The 3-byte region is the wrapper's argument (`String.from("arg")`). The caller's resume function frees it first, at an escape inside the fused site. The state machine's dispose frees it again, through the site's capture.

## Reproducer

The three `a throw in a fused block releases the call's argument once` tests in `tests/async/fusion.test.yo`. The wrapper:

```yo ignore
_throws_taking :: (fn(sink(name) : String, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async(e => {
    r := e.io.await(_leaf(i32(1), e.io), e.io);
    cond(
      (r > i32(0)) => e.exn.throw(dyn(Boom(msg : name.clone()))),
      true => name.len()
    )
  })
);
```

It is awaited as `e.io.await(_throws_taking(String.from("arg"), e.io), e)` inside a match arm, a `while` body, or a nested `{ … }` block. All three double-free. The same await at the top level of the caller's `io.async` body does not.

## Root cause

The emitted C at both escape points inside the fused block (the `_leaf` call's escape check, and the throw's) carried:

```c
if (__yo_effect_escaped) {
  // Drop consumed variables (unwind propagation)
  yo_id_..._drop(&(_file____home_temp_116191851338486809300));   /* String.from("arg") */
  ...
  sm->state = -2; ... return;
}
```

That temp is the call's argument. The fused call moved it into the wrapper's parameter and from there into the site's capture (`sm->__fz…_capture = {.__yo_v_name = __yo_v_name}; sm->__fz…_live = 1;`). The dispose releases the capture while the site is live.

The drop came from `consumed_var_pending_drops`. A match arm, a loop body and a begin block each push the consumed-variable drops of their body onto that list (`match.yo`, `while_loop.yo`, `begin.yo`), so an escape before a consumption releases the value. `generate_consumed_var_drops_for_escape` keeps an entry only if the escape comes before the consumption, and it decides this by comparing source tokens.

At a fused site the escape points are the wrapper's statements, emitted into the caller's resume function, so the comparison sets a token of the wrapper's source against a consumption in the caller's. Here the wrapper is defined above the caller in the same file, so its escape points looked like they came before the argument was consumed. At an ordinary await the same throw happens in the wrapper's own state machine, whose lists hold only its own values. The caller's resume emits no drops when the awaited future aborts: everything goes to the dispose.

#1817's fix (the caller's match arms set aside around the site) already removed the arm bindings' drops from both escape lists. It left the call's own arguments in them.

## Fix

`emit_fused_await` (`src/codegen/exprs/async.yo`) collects the values its call hands the wrapper (`_fused_call_taken`): an atom argument's own name, else the temp the argument is stored in. For both parts it emits in the wrapper's scope, the caller's two escape-drop lists lose those drops as well as the arm bindings' (`_drops_outside_site`, applied by `_enter_wrapper_scope`). From the call on, those values belong to the wrapper, as they belong to the callee at an ordinary call. The arguments themselves are still generated with the caller's lists in force, before the filter applies.

## Verification

- `tests/async/fusion.test.yo`: the three new tests (match arm, loop body, nested block) fail with #1817's stage 1, each with an ASan `attempting double-free` (16 passed, 3 failed). They pass with the fixed stage 1.
