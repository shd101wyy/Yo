# An awaiting `io.async` body captures a local alias without retaining it

**Severity:** S1: use-after-free in safe code. A future whose body awaits and reads `b`, where `b := a` aliases an RC-holding local of the enclosing function, reads `a`'s payload after the function has released it. An `ArrayList` alias crashes (SIGSEGV, exit code 11). A `String` alias reads as empty, so `s.ptr().unwrap()` panics with "Called unwrap on a None value".

**Status: FIXED 2026-10-05.** Found 2026-10-05 while gating String S3a: its migration had turned `sb := s.as_bytes()` (a call result) into `sb := s` (an alias) in `TlsStream.write_str`, and the live TLS test started failing. S3a drops those aliases (the `write_str` / `write_string` methods of `std/crypto/tls.yo`, `std/net/tcp.yo` and `std/net/unix.yo` capture the string itself), which sidesteps this bug but does not fix it. **Measured on:** yo 0.2.52, a stage-1 of develop `41477231a`, `--std-path ./std`. Reproduces unchanged on develop `c80de6ebe`.

The title is the first guess at the cause, kept so the references from the S3 branch resolve. The task never failed to retain the alias: it read it from the wrong slot (see Root cause).

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
{ assert, panic } :: import("std/assert");
{ String } :: import("std/string");
{ IoExn, Exception } :: import("std/error");
give :: (fn(p : *u8, n : usize, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async(e => n)
);
cap_str :: (fn(data : str, io : Io) -> Impl(Future(usize, IoExn)))({
  s := String.from(data);
  sb := s; // an alias of the local
  io.async(e => {
    n := e.io.await(give(sb.ptr().unwrap(), sb.len(), e.io), e);
    return(n);
  })
});
test("an io.async body that awaits reads a String copied from a local", {
  exn := Exception(throw : (err -> panic("x")));
  e := IoExn(io : io, exn : exn);
  n := io.await(cap_str("hello", io), e);
  assert(n == usize(5), `got ${n.to_string()}`);
});
```

Result: `Called unwrap on a None value`.

| Shape inside `cap_str` | Result |
| --- | --- |
| `s := String.from(data); sb := s;` then capture `sb` | fails (None) |
| `sb := String.from(data);` then capture `sb` | passes |
| `sb := s.clone();` then capture `sb` | passes |
| `sb := data;` where `data : String` is a parameter | passes |
| `s := ArrayList(u8).new(); …; sb := s;` then capture `sb` | SIGSEGV (exit code 11) |

## The first guess was wrong

The doc first blamed the dup/drop pair optimizer (`_optimize_dup_drop_pairs`) for cancelling the alias's dup against a drop. The emitted C rules that out. `cap_str`'s reference counting is balanced and the task holds a live reference:

```c
__yo_t_… __yo_v_s = <String.from temp>;
if ((__yo_v_s) != NULL) { __yo_incr_rc((void*)(__yo_v_s)); }
__yo_t_… __yo_v_sb = __yo_v_s;
if ((__yo_v_sb) != NULL) { __yo_incr_rc((void*)(__yo_v_sb)); }
… = __yo_new_<sm>((<capture>){.__yo_v_sb = __yo_v_sb});   // the task's +1
if ((__yo_v_sb) != NULL) { __yo_decr_rc((void*)(__yo_v_sb)); }
if ((__yo_v_s) != NULL) { __yo_decr_rc((void*)(__yo_v_s)); }
```

and the task's dispose releases `sm->__capture.__yo_v_sb`. Nothing was cancelled.

## Root cause

The resume function never reads the capture. The state-machine struct carries a LOCAL slot for the owner `s`, which the body does not capture, and every read of `sb` goes through that slot:

```c
struct <sm> {
  …
  <capture> __capture;                    // holds sb, retained
  …
  __yo_t_… var_s_11312046658674615463;    // s: nothing ever writes it
  uint8_t __yo_mv_var_s_11312046658674615463;
};
…
__yo_state_0: ;
  uint8_t* … = String_ptr(sm->var_s_11312046658674615463);   // NULL String
  size_t   … = String_len(sm->var_s_11312046658674615463);
```

The struct is zeroed at allocation, so the String reads as empty (`ptr()` is None) and the ArrayList is a NULL pointer (SIGSEGV). Replacing the two reads with `sm->__capture.__yo_v_sb` in the emitted C and compiling it by hand prints the right result.

How the slot got there:

1. `_capture_env_variable` (`src/evaluator/shared/suspension_analysis.yo`, "Case 2") handles a variable that shares its owner's RC value (`Variable.is_owning_the_same_rc_value_as`). It records the OWNER as a captured body local, and the alias as sharing it, so that codegen reads the alias through the owner's slot (`sm_storage_id`, `src/codegen/async/state_machine_naming.yo`). The analysis has no notion of the closure boundary, so it records the owner even when the owner is a local of the ENCLOSING function.
2. The `io.async` re-kind pass (`src/codegen/exprs/async.yo`) turns the captures that live in the closure's capture struct into `.Outer` entries (`sm->__capture.<name>`), matching by the struct's field labels. `sb` is a label, so it becomes `.Outer`. `s` is not a label, so it stayed a `.Local` and got a `var_s_<hash>` field.
3. `sm_storage_id(sb)` finds `sb`'s owner `s` in the state-machine map as a `.Local` and returns `s`'s slot. Its contract, "the owner's slot when the owner is a local of the same body", was violated by step 2.

The controls behave as observed: a direct capture of `s` and `sb := s.clone()` have no owner link; a parameter alias `sb := data` has none either (a parameter is borrowed); `sb := String.from(data)` is not an alias.

## Fix

The re-kind pass drops the owner. An alias that is a capture was declared outside the closure, and its owner was declared before it, so the owner cannot be a local of the body. Unless the body captures the owner too (then it is a label and already `.Outer`), it has no storage in the task. With the owner gone from the map, `sm_storage_id(sb)` falls through to `sb`'s own `.Outer` entry, the body reads `sm->__capture.__yo_v_sb`, and the dead `var_s_<hash>` field (with its abort-dispose drop) is no longer emitted. Every consumer of the analysis reads the re-kinded result, including the fused await-site path (`DeferredAsyncBlock.analysis`).

The dup/drop optimizer is unchanged.

## Tests

`tests/io_async_captured_alias.test.yo`:

- a String alias and an ArrayList alias, each read before the await, and a String alias read after the await: **red before the fix** (None unwrap, SIGSEGV);
- a `ref(struct)` alias read after the await, with a Dispose counter: the task retains the value and releases it exactly once;
- controls: a parameter alias, a direct capture, a `clone()`;
- canaries for the paths the fix leaves alone: the body captures both the owner and the alias, and an owner and alias that are both locals of the body (the alias still shares the owner's slot across the await).

## Verification

- `tests/io_async_captured_alias.test.yo`: develop `c80de6ebe` stage-1 **2 passed / 4 failed** (exit 6 on the String shapes, SIGSEGV 11 on the ArrayList and ref-struct shapes); with the fix **6 passed**.
- A/B emission, the develop stage-1 against the fixed one, both under one pinned `YO_STD`: `src/main.yo` (1,910,460 lines) is **byte-identical**. So are the runner batches of `tests/async_await.test.yo` (3 batches), `tests/closure.test.yo`, `tests/closure_inside_io_async.test.yo` and `tests/rc.test.yo`, each compiled from one fixed path. The only diff is the new test's batch: in each of the four failing shapes the `var_<owner>` field disappears, its abort-dispose drop disappears (`__yo_decr_rc` 377 → 373, `__yo_incr_rc` 45 → 45), and the reads become `sm->__capture.<alias>`. The canaries' C is unchanged.
