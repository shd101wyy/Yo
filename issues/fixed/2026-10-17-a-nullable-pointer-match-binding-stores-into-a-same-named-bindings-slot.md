# A nullable-pointer match binding stores into a same-named binding's slot

**Severity:** S2 — a valid `io.async` body fails to compile (the C does not
type-check) when two `match` arms bind the same name to nullable-pointer
payloads and the first arm awaits.

Found while fixing
`issues/fixed/a-mut-match-place-binding-cannot-live-across-an-await.md`: the
whole `tests/match_async_arms.test.yo` batch stopped compiling once a `mut`
place test bound `xs` in two matches of one task. The bug does not need `mut`
places; `&` matches show it on develop (`ed733408c`).

## Symptom

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ yield } :: import("std/async");
_same_name_slots :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    (os : Option(String)) = .Some(String.from("old"));
    (ol : Option(ArrayList(i32))) = .Some(ArrayList(i32).new());
    match(&os, .Some(xs) => {
      io.await(yield(io), io);
      assert(xs.len() == usize(3), "first");
    }, .None => ());
    n := (usize(1) + match(&ol, .Some(xs) => xs.len(), .None => usize(0)));
    assert(n == usize(1), "second");
  });
  io.await(task, io);
});
main :: (fn(io : Io) -> unit)({ _same_name_slots(io); });
export(main);
```

```text
error: incompatible pointer types assigning to '__yo_t_9812871385482154704'
(aka 'struct __yo_t_11645877847810610317_struct *') from
'__yo_t_280885673680761782 *' [-Werror,-Wincompatible-pointer-types]
```

The second arm's `xs` (an `ArrayList(i32)`) is stored into the first arm's
slot, typed `String`, and read back from it:

```c
if (sm->var_ol_… != NULL) {
  __yo_t_280885673680761782* __yo_v_xs = sm->var_ol_…;
  sm->var_xs_<first arm's site> = __yo_v_xs;   /* the String slot */
  … len(sm->var_xs_<first arm's site>) …
```

When the two payload types agree the C compiles, and the second binding
silently uses the first one's slot.

Whether it shows depends on what else the compiler evaluated: the same body
inlined in `main`, or next to another `io.async` function, compiles.
`YO_SCOPE_RELEASE=off` and `YO_SCOPE_RELEASE=shadow` compile it every time.

## Root cause

A nullable-pointer arm (`if (x != NULL) { T* xs = x; … }`,
`src/codegen/exprs/match.yo`) chose its binding's task slot by an env lookup:
`scope_variables` on the pattern atom, then a name scan of the task's
variables. With the scope release on (the default for `compile`), the
recorded answer for the second `xs` atom is the first arm's `xs`, so the
store went to that variable's slot. Every other pattern binding finds its
slot by its declaration site (`_bind_pattern_name` through
`_inline_binding_sm_field`), which the slot naming also keys on, so only this
path went wrong.

## Fix

Under the single-pass lowering the nullable-pointer arm stores its binding
through `_bind_pattern_name`, so the slot is the one declared at the
binding's own site, as for tagged-union and struct patterns. The env lookup
stays for a body outside that lowering.

## Verification

`tests/match_async_arms.test.yo`, "same-named nullable-pointer bindings of one
task each use their own slot", is the symptom above. The develop binary
(`ed733408c`) fails to compile its body as a standalone program, with the
error above. With the fix the test passes, and so does the file's `mut` place
test that first showed the bug ("a mut place of a counted payload is
replaced after an await").
