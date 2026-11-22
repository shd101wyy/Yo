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
