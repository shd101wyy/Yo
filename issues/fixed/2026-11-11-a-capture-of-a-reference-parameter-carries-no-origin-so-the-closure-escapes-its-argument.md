# A `{ p }` capture of a reference parameter carries no origin, so the closure escapes its argument

**Severity:** S1. `mkd :: (fn(p : &Rc(S)) -> Dyn(Fn() -> usize))(dyn({ p }() => p.*.*.a.len()));` passes `yo check`:
the closure copies the reference into its capture record, is boxed and returned, and is called after the argument's
root has died (ASan: stack-use-after-scope; the `Impl(Fn)` form: heap-use-after-free). New with #1891 (capture PR1,
2026-11-11): v0.2.76 and develop before it reject the capture itself with E0926.

**Status:** FIXED 2026-11-11 (`fix/capture-param-origin`): a capture entry's origin borrows are resolved where the
entry is evaluated, in the scope that writes the literal, before the capture frame binds the labels.

Found 2026-11-11 by the borrow/ownership audit (yo-6c; the audit plan's §3 A9, branch `audit/borrow-ownership-origins`).
Confirmed on develop `64f33c710`.

## Reproducers

`tests/origins/unsound/closure-ref-param-capture-dyn-returned.yo` (negative, expects E0909):

```yo
mkd :: (fn(p : &Rc(S)) -> Dyn(Fn() -> usize))(dyn({ p }() => p.*.*.a.len()));
main :: (fn() -> unit)({
  (mut(d) : Dyn(Fn() -> usize)) = dyn({}() => usize(0));
  {
    h := Rc.new(S(a : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    d = mkd(&h);
  };
  println(`OUT: ${d().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: E0926 "`p` is a reference (`&Rc(S)`) …"
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope
```

- `tests/origins/unsound/closure-ref-param-capture-returned.yo` (negative, expects E0909 until P4, then E0911 at the caller's write):
  `mk :: (fn(p : &Rc(S)) -> Impl(Fn() -> usize))({ p }() => p.*.*.a.len());`, the caller reassigns `h` while the
  closure lives: heap-use-after-free.
- `tests/origins/unsound/closure-ref-param-capture-dyn-returned-pos.yo` (positive control): the closure over the parameter is called inside the function and never leaves it.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `dyn({ p }() => …)` returned as `Dyn(Fn(...))`, `p : &T` a parameter | accepted, UAF | E0909 |
| `{ p }() => …` returned as `Impl(Fn(...))`; the caller then writes the argument's root | accepted, UAF | E0909 (E0911 at the write once P4 lands) |
| a `self : &Self` method returning `dyn({ self }() => …)` or `{ self }() => …` | accepted, UAF | E0909 |
| the same with a `&String` parameter; the caller writes the root | accepted; the closure reads the new value | E0909 |
| `{ y }() => …` where `y := &x` is a LOCAL reference binding, returned or boxed | E0909 | E0909 |
| a holder / `Option(&T)` capture returned or boxed | E0909 / E0912 | — |

## Root cause

VERDICTS-44 R-CAP-2: a by-value capture of a reference contributes the reference's origin to the closure, and "a
parameter-rooted reference contributes the parameter's origin". #1891 computed the entry's origin (`origin_of` on
the initializer answers `p(imm)` for a `&T` parameter `p`, the parameter's own lent place) but turned it into capture
borrows only later, in `_capture_origin_borrows` (`src/evaluator/values/anonymous_function.yo`), when the closure's
capture struct is registered. By then the capture frame binds every entry's label, and `_capture_origin_borrows`
resolves each root by name and accepts it only when the binding found is the root's declaration. For `{ p }` the name
`p` finds the capture binding `p`, whose token is the entry's, not the parameter's, so the root was skipped as "names
no binding of this scope". The closure carried no borrow: not second-class, not frozen, and returning or boxing it was
accepted.

The same shadowing hit a local root whose name the entry reuses as its label: `{ s : y }` with `y := &s` registered
nothing either (accepted, and `dyn(...)` stored into an outer slot read `s` after its block freed it). `{ q : p }`
(a label other than the root) was already E0909. A local `{ y }` with `y := &x` worked because its root `x` is not a
label.

## Fix

`_evaluate_capture_list` resolves the origin borrows of a reference-copy entry and of an origin-carrying by-value
entry where it evaluates the initializer, in the enclosing scope (the entry field `origin_borrows`); the registration
pushes them as they are.

## The `io.async` half (reported by yo-6c through the coordinator; VERDICTS-58 §2–3)

An `io.async` body's `{ p }` / `{ self }` hit the same skipped root, with two effects on develop `64f33c710`:

- **Caller not frozen.** `fut := mk(&x, io); x = String.from("b"); io.await(fut, io)` was accepted (the future had no
  origin). Returning the future is correct (O8 forwarding); what was missing is the caller-side freeze, E0911.
- **Codegen: stack-use-after-scope with no write at all.** A `&String` parameter is a by-value C parameter, and the
  capture record took `&(__yo_v_s)`, the address of the callee's parameter copy. The §3.13 A2 machinery that gives a
  returned future its own copy of a lent `&T` parameter (`_lent_param_capture_fields` in
  `src/codegen/exprs/async.yo`) keys on the capture borrow (`root_is_value_param`, the entry's own label), which the
  skipped root never registered. The corpus positive `async-captures-ref-param` has no `main`, so the crash was never
  run. The v0.2.76 seed rejects `{ p }` (E0926) and runs its spelling `{ q : &p.* }` clean: new with #1891.

With the borrow registered, both are fixed by the same change: the future roots at the caller's argument in `&` mode
(E0911 at a write while it is live, E0912 when returned over a caller's local), and codegen installs the future's
own copy (`sm->__yo_lent___yo_v_s = *(sm->__capture.__yo_v_s); sm->__capture.__yo_v_s = &sm->__yo_lent___yo_v_s;`),
exactly as for `{ &p }`. No codegen edit.

## Expected

The closure's origin is `{(p, &)}`, the parameter's place. Until P4 (first-class closures) lands that makes it
second-class: E0909 at the `dyn(...)` and at the return. After P4: returning it as `Impl(Fn(...))` is legal, the
caller's argument root stays frozen while the result lives (E0911 at the write), and `Dyn(Fn(...))` without an
origin still rejects it (its payload must be `Escapable`).

## Test

`tests/origins/unsound/` (G-B, ASan): `closure-ref-param-capture-dyn-returned` and `closure-ref-param-capture-returned`
(this doc's two reproducers), `closure-self-ref-capture-dyn-returned` (`{ self }`), `closure-ref-capture-label-shadows-root`
(`{ s : y }`), `async-ref-capture-caller-writes-arg` and `async-self-ref-capture-root-written` (E0911),
`async-ref-capture-local-returned` (E0912), each with an accepted `-pos` twin, plus `async-captures-ref-param-pos` (the
corpus row with a `main`, run under ASan). Corpus rows `async-ref-capture-caller-writes-arg` (E0911) and
`async-ref-capture-local-returned` (E0912). `tests/closure_capture_list.test.yo`: "a label that names the reference's
own root still borrows it" and "a `&T` parameter's copy borrows the parameter (R-CAP-2)". Develop `64f33c710` accepts
every negative closure/caller row and crashes `async-captures-ref-param-pos` under ASan; the fix rejects and runs them.
