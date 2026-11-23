# An `FnMut` closure stores its by-value holder parameter through a `&mut` capture unchecked

**Severity:** S1 — safe code passes `yo check` and reads freed memory: the closure stores a holder of `&y` into the outer `o`, `y` dies with its block, and the read through `o` follows a dangling reference.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/holders/e07_closure_elided_holder.yo`
in `scripts/test7/audit-corpus.tar.gz`, respelled in `scripts/test7/respelled/`. Reproduced with a stage 1 of develop
`f06ff5889` (src and std unchanged through `b69bce2f5`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
H :: struct(r : &Box(String));
main :: (fn() -> unit)({
  mut(o) := Option(H).None;
  {
    (mut(f) : Impl(FnMut(h : H) -> unit)) = ({ o : &mut o }(h) => {
      o.* = .Some(h);
    });
    y := Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
    f(H(r : &y));
  };
  match(&o, .Some(h) => println(`OUT: ${h.r.*.len().to_string()}`), .None => ());
});
export(main);
```

```bash
yo check repro.yo --std-path ./std                    # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
# ERROR: AddressSanitizer: heap-use-after-free
```

The same store through a named function is E0923 ("Cannot store `.Some(h)` through `o`: the value holds the origin
inside `h`, and `o` points only into the origin inside `o`'s pointee"):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
H :: struct(r : &Box(String));
stash :: (fn(o : &mut Option(H), h : H) -> unit)({
  o.* = .Some(h);
});
main :: (fn() -> unit)({
  mut(o) := Option(H).None;
  {
    y := Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
    stash(&mut o, H(r : &y));
  };
  match(&o, .Some(h) => println(`OUT: ${h.r.*.len().to_string()}`), .None => ());
});
export(main);
```

## Root cause

Not traced to a line. A store through a capture-list `&mut` entry inside a closure body is not checked like a
store through a `&mut` parameter: the parameter `h : H` carries the elided field origin, the capture `o` points
into `o`'s own origin, and the E0923 store check (`lend_through` / the elided-origins rule) is not applied at the
closure's `o.* = …`. The neighbour fixed on 2026-11-19
(`issues/fixed/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.md`)
covers a `&T` parameter stored through a method of the capture, not a by-value holder stored by assignment.

## Fix

Apply the store check to an assignment through a `&mut` capture with the closure's parameters as unrelated origins.
Add the reproducer to `tests/origins/unsound/`.

## Fixed

Fixed on `v0280/s1-test7b` (2026-11-23). Traced: `bind_join` (`src/evaluator/utils.yo`) judges `o.* = .Some(h)`
with `o` the capture binding. `origin_of(.Some(h))` is empty (a by-value parameter's own place is no root of its
value), so `_capture_store` and `_capture_state_store`, which judge roots, never ran; the by-value parameter's
origins (`byvalue_param_origin_names`, `h`'s rigid elided field origin) were compared only against a holder whose
type spells origins, and the outer `o : Option(H)` spells none. The named-function form is E0923 because there the
holder is a `&mut` parameter whose pointee's elided origin is rigid.

`_capture_store_param_origins` now runs for a holder that outlives the closure call — the outer place of a `&mut`
capture, or an `FnMut` literal's by-value state (the same hole: `{ o : Option(H).None }(h) => { o = .Some(h) }`
keeps `h`'s per-call origin across calls) — and rejects each by-value-parameter origin the holder's type does not
name with E0923 ("… holds the origin inside `h`, an origin of this literal's per-call parameter `h`, `o` outlives
the call, and a per-call origin cannot be named outside the literal"). A slot type that shares an origin parameter
of the enclosing function with the holder's type still passes.

G-B: `tests/origins/unsound/t7-fnmut-capture-stores-byvalue-holder-param.yo` (the reproducer, probe e07),
`t7-fnmut-state-stores-byvalue-holder-param.yo` (the by-value state form, ASan heap-use-after-free on develop), and
the positive twin `t7-fnmut-capture-stores-byvalue-holder-param-pos.yo` (an owned value stored).
