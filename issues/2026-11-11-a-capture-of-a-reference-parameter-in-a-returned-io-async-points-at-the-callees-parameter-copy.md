# A `{ s }` capture of a reference parameter in a returned `io.async` points at the callee's parameter copy

**Severity:** S1. `mk :: (fn(s : &String, io : Io) -> Impl(Future(usize, Io)))(io.async({ s }(io : Io) => s.len()))`
passes `yo check`, and the future it returns reads `mk`'s dead stack frame: ASan stack-use-after-scope with no write
anywhere in the program. The corpus POSITIVE row `async-captures-ref-param` is this program. New with #1891 (capture
PR1): v0.2.76 rejects the capture with E0926 ("`s` is a reference (`&String`): reading the value it refers to is
spelled `s.*`").

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A49). Confirmed on develop `64f33c710`. Fix lane:
`fix/capture-param-origin`. This doc is the CODEGEN half and the future-specific verdict; the checker half shares
its root cause with `issues/2026-11-11-a-capture-of-a-reference-parameter-carries-no-origin-so-the-closure-escapes-its-argument.md`
(A9), with one difference stated under Expected.

## Reproducers

`issues/repros/2026-11-11-a-capture-of-a-reference-parameter-in-a-returned-io-async-points-at-the-callees-parameter-copy.yo`
(positive, must run clean):

```yo
mk :: (fn(s : &String, io : Io) -> Impl(Future(usize, Io)))(
  io.async({ s }(io : Io) => {
    io.await(yield(io), io);
    s.len()
  })
);
main :: (fn(io : Io) -> unit)({
  x := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  println(`OUT: ${io.await(mk(&x, io), io).to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: E0926
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope
```

C passes a `&T` parameter by value, so `s` is `mk`'s C parameter `__yo_v_s`, and the capture record stores its
address (emitted C of the repro, probe `b07`; `__yo_t_17030455559196638567` is `String`):

```c
static inline _file____home_temp_39235027400195755681_state_t* yo_id_18161896624961682261000000(__yo_t_17030455559196638567 __yo_v_s, __yo_t_14133940505611760074 __yo_v_io) {
  _file____home_temp_39235027400195755681_state_t* _file____home_temp_39235027400195755681 = __yo_new__file____home_temp_39235027400195755681((__yo_t_6467258230697736188){.__yo_v_s = (&(__yo_v_s))});
  return _file____home_temp_39235027400195755681;
}
/* the resume function, after mk has returned: */
  size_t _file____home_temp_127188582392356370040 = yo_id_1865991500699323366000000((*sm->__capture.__yo_v_s));
```

The borrow-entry spelling `{ s : &s.* }` emits the copy the future needs:
`sm->__yo_lent___yo_v_s = *(sm->__capture.__yo_v_s); sm->__capture.__yo_v_s = &sm->__yo_lent___yo_v_s;`.

- `…-self.yo` (positive): a `self : &Self` method returning `io.async({ self }(io : Io) => …)`, bound and awaited with
  nothing in between: stack-use-after-scope.
- `…-caller-write.yo` (negative, expects E0911): the caller reassigns `x` while the future lives: accepted, the same crash.
- `…-pos.yo` (positive control): `{ s : &s.* }`, accepted, runs clean (`OUT: 72`).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `{ s }` of a `&String` parameter, future returned and awaited | accepted, stack-use-after-scope | accept, run clean |
| `{ self }` of `self : &Self`, future returned, bound, awaited | accepted, stack-use-after-scope | accept, run clean |
| corpus row `async-captures-ref-param` given a `main` (`{ p }`, `p : &P`) | accepted, stack-use-after-scope | accept, run clean |
| `{ s }` / `{ self }`, the caller writes the argument's root while the future lives | accepted, stack-use-after-scope | E0911 at the write |
| `{ s : &s.* }` (borrow entry of the whole parameter) | accepted, runs clean | accept |

## Root cause

Codegen: `_lent_param_capture_fields` (`src/codegen/exprs/async.yo`) picks the capture fields that get a copy slot
(`_emit_lent_param_slots`, `_emit_lent_param_installs`) from the capture struct's REGISTERED borrows: a borrow with
`root_is_value_param`, an empty path, and the field's label. The borrow entry `{ s : &s.* }` registers one
(`_CapListEntry … root_is_value_param : root_var.is_imm_borrow()` in `src/evaluator/values/anonymous_function.yo`).
The by-value entry of a reference binding (`ref_copy_var`, VERDICTS-44 R-CAP-1) records the reference's origin
instead (`uses_origin_roots`), and `_capture_origin_borrows` turns it into capture borrows only for roots it finds
as bindings of the current scope. `YO_DEBUG_ORIGIN=1` shows `s -> [s(imm)]` for the capture, but no future origin is
recorded for the `io.async` call (in the `{ s : &s.* }` program the trace prints the `io.async` with `[s(imm)]` and
the caller's `mk(&x, io)` with `[x(imm)]`; in the `{ s }` program neither line appears). The C field is then the
plain lowering of the reference value, `&(__yo_v_s)`, the address of the parameter copy. Which test in
`_capture_origin_borrows` drops the root is not instrumented; the A9 doc's reading (a reference parameter's root is
skipped) matches what the trace shows.

## Expected

Accept, and run clean. `plans/backlog/REFERENCES_AND_ORIGINS.md` O8 ("As built", made precise 2026-11-11): "a
`{ s }` capture of a reference parameter contributes the parameter's origin, so the returned future is accepted and
the caller's argument stays frozen (E0911 at its write) — for a future this is forwarding, where the same capture in
a closure returned as `Dyn(Fn(...))` is E0909." So, unlike A9, the fix must NOT make the future second-class or
reject its return: the corpus rows `async-forward-param` and `async-captures-ref-param` are positive. The capture
must register the parameter-rooted borrow `{(s, &)}`; then codegen copies the lent value into the future as it does
for `{ s : &s.* }`, and the caller's R-CALL freezes `x`.

## Test

With the fix: the two positives (the main repro and `…-self.yo`), the negative `…-caller-write.yo` and the control
`…-pos.yo` move to `tests/origins/unsound/`; `async-captures-ref-param` in `tests/origins/corpus.tsv` gains a run
(ASan) check; a `{ s }` case goes into `tests/async_await.test.yo`.
