# A `&mut` reference binding passed bare to a `&mut &T` parameter passes its referent

**Severity:** S1 — safe code passes `yo check` and the emitted C hands the callee the wrong pointer: `rp := &mut r;
g(rp)` with `g`'s parameter `dst : &mut &T` passes `*rp` (the `&T` that `r` holds) where `dst` expects `rp`, so
every read through `dst` is one level too deep and a write through `dst.*` overwrites the referent `r` points at.
ASan reports a stack-buffer-overflow.

Filed 2026-11-24 by the test 7 rehearsal lane (`plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6, leg (b)).
Corpus program: `repros/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.yo`
in `scripts/test7/audit-corpus.tar.gz`, which was rejected (E0601) on develop `f06ff5889` and is accepted and
ASan-dirty on develop `964a9c2d6`. Bisected with prebuilt stage 1 binaries: `4cdc10d31` rejects it, `b751ac902`
accepts it; between them only #2048 (VERDICTS-75 receiver riders, `e1ece945d`) touches `src/`.

## Reproducer

`issues/repros/2026-11-24-a-mut-reference-binding-passed-bare-to-a-mut-reference-to-a-reference-parameter-passes-its-referent.yo`:

```yo
{ println } :: import("std/fmt");
g :: (fn(dst : &mut &i32) -> i32)(dst.*.*);
main :: (fn() -> unit)({
  a := i32(7);
  mut(r) := &a;
  rp := &mut r;
  println(`OUT: ${g(rp).to_string()}`);
});
export(main);
```

```bash
yo check repro.yo --std-path ./std        # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
```

```text
==554241==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7bffb35ff060 at pc 0x5555556cd5d9 bp 0x7bfff3ffec90 sp 0x7bfff3ffec88
READ of size 8 at 0x7bffb35ff060 thread T1
Address 0x7bffb35ff060 is located in stack of thread T1 at offset 96 in frame
    [96, 100) '__yo_v_a' <== Memory access at offset 96 partially overflows this variable
SUMMARY: AddressSanitizer: stack-buffer-overflow (.../t+0x1795d8)
```

The emitted call (`--emit-c`):

```c
int32_t const ** __yo_v_rp = ((int32_t const **)&(__yo_v_r));
... g((int32_t const **)((*__yo_v_rp)));   /* should be g(__yo_v_rp) */
```

The corpus program writes through the parameter (`dst.* = v` at `dst : &mut &(Rc(X), p)`, `set(rp, &other)`), so
the store lands on `outer`'s `Rc` slot instead of on `r`, and the later `r.*.*.s` read is a stack-buffer-overflow
past `other`:

```text
==511127==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7bffb33ff070 at pc 0x5555556cd65d bp 0x7bfff3dfec70 sp 0x7bfff3dfec68
READ of size 8 at 0x7bffb33ff070 thread T1
  This frame has 2 object(s):
    [32, 64) '__yo_v_buffer'
    [96, 104) '__yo_v_other' <== Memory access at offset 112 overflows this variable
```

| Shape (develop `964a9c2d6`) | Verdict | Run |
| --- | --- | --- |
| `g(rp)`, `g : fn(dst : &mut &i32)`, `rp := &mut r` | accepted | dirty (`g(*rp)`) |
| `set(rp, &b)`, `dst : &mut &(i32, p)` (origin-generic, writes `dst.* = v`) | accepted | wrong value (`r.*` prints 1, not 2: the store missed `r`); dirty at `--optimize 0` |
| `set(&mut rp.*, &b)` | accepted | right |
| `set(&mut r, &b)` | accepted | right |
| `g(rp)`, `g : fn(dst : &mut i32)`, `rp := &mut a` | accepted | right (`g(rp)`) |
| `f(r)`, `f : fn(generic(p : Origin), x : &(i32, p))`, `r := &a` | accepted | right |

## Root cause

#2048's rider r1 ("a call result typed `&T` reads through as a receiver") changed two things that meet here:

- The evaluator now judges an already-evaluated argument whose type IS its borrow slot against the slot itself,
  not against the slot's pointee. Before, `rp : &mut &i32` was compared with the pointee `&i32` and rejected
  (E0601, `issues/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.md`);
  now it is admitted as the slot's value, with no lend recorded.
- Codegen: `_apply_ref_amp` (`src/codegen/exprs/other-fn-call.yo`) lowers an argument for which
  `_reference_value_at_own_slot` holds as the place `(*p)` it names, expecting "a pointer slot folds `&(*p)` to `p`,
  a by-value `&T` slot reads the referent". For a `&mut &T` slot, nothing adds the `&` back: the argument has no
  recorded lend and the slot is not a `param_is_ref` slot, so `(*rp)` is passed as it is and the C cast to
  `int32_t const **` hides the type mismatch. At a `&mut i32` slot the same binding takes the ordinary reborrow route
  and is passed as `rp`.

So for a slot whose pointee is itself a reference, the "reference value at its own slot" lowering takes the
referent instead of the reference.

## Expected

The program is sound and should print `OUT: 7`: a `&mut` binding passed to a `&mut` slot is a reborrow
(`plans/backlog/REFERENCES_AND_ORIGINS.md` O3), and its C is the pointer `rp`. Either the rider r1 lowering passes
the value as is when the slot's C type is the pointer itself, or the evaluator records the reborrow `&mut rp.*`
for a bare `&mut` binding at a `&mut` slot whatever the pointee, and codegen folds `&(*rp)` to `rp`.

## Test

The reproducer (with a write-through twin, `dst.* = v` at `dst : &mut &(i32, p)`) as a positive case in
`tests/ref-of-ref.test.yo` that checks the printed value, which fails today (wrong value or ASan) and passes with the
fix. The open S2 above (the E0601 rejection) closes with the same fix.

## Fix (2026-11-24, `fix/r1-reference-slot-relend`)

Accepting the program is correct. A bare `&mut` binding at a `&mut` slot is a reborrow (O3), and the evaluator's flow analysis treats it exactly like the spelled `&mut rp.*`. Both forms report the same E0911 when the new referent dies first:

```yo ignore
{
  other := mk();
  set(rp, &other);   // E0911: `other`'s scope ends with its block
};
```

The fault is in codegen, so codegen must pass `rp` itself. `rp := &mut r` is a by-`ref` binding: its C storage is the pointer, and `_var_read_code` already reads it as the place it refers to, `(*rp)`. `_reference_value_at_own_slot` keyed only on the read's recorded type (`&mut &i32`, the slot), took that C for the pointer, and wrapped it once more. `_apply_ref_amp`'s `&(*·)` fold then removed only the added level, which left `(*rp)`.

A new predicate, `_arg_reads_ref_binding`, makes `_reference_value_at_own_slot` skip a by-`ref` binding (`is_ref`, not a `&` match binding). That argument takes the ordinary place lowering: at the pointer-ABI `&mut &T` slot, `&(*rp)` folds to `rp`.

Tests: `tests/ref-of-ref.test.yo` gains three rows, all run under the test runner:
- the reproducer and its write-through twin
- the corpus shape over `Rc(X)`
- the siblings: a `&&T` reborrow, a bare `&mut &mut T` binding, and a `&mut &T` receiver
