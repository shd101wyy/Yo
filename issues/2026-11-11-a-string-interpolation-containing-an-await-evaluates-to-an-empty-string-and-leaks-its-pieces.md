# A string interpolation containing an await evaluates to an empty string and leaks its pieces

**Severity:** S1 (the ledger said S2, a leak; the measured result is also WRONG). Inside an `io.async` body,
`` `n=${io.await(num(io), io)}` `` evaluates to `""`: the program prints `OUT: ` instead of `OUT: n=7`, and LeakSanitizer
reports the pieces (2 bytes for `"n="`, 1 byte for `"7"`). A silently wrong result is S1 on the scale in
`issues/README.md`. v0.2.76 accepts the program too (check rc 0).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A54). Confirmed on develop `64f33c710`. The probe runner
missed the wrong output: when LeakSanitizer fires at exit, the buffered `OUT:` line is never flushed to a file, so
the logs held only the leak report; `ASAN_OPTIONS=detect_leaks=0` shows the printed line.

## Reproducers

`issues/repros/2026-11-11-a-string-interpolation-containing-an-await-evaluates-to-an-empty-string-and-leaks-its-pieces.yo`
(positive, must print `OUT: n=7` and run clean):

```yo
num :: (fn(io : Io) -> Impl(Future(usize, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    usize(7)
  })
);
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => `n=${io.await(num(io), io)}`);
  println(`OUT: ${io.await(f, io)}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t
$ ASAN_OPTIONS=detect_leaks=0 ./t
OUT: 
$ ./t
==…==ERROR: LeakSanitizer: detected memory leaks
SUMMARY: AddressSanitizer: 3 byte(s) leaked in 2 allocation(s).
```

The interpolation desugars to `begin(__yo_tpl := "".to_string(), __yo_tpl.push_str("n="), (… .to_string()).append_to(&mut __yo_tpl), __yo_tpl)`.
`__yo_tpl` lives across the await, so it is a state-machine slot, and every read of it renders as a MOVE (emitted C):

```c
  __yo_t_17030455559196638567 __yo_ref_spill_0 = sm->var___yo_tpl_170230_16934234930401199592 /*yo_mv:m0*/;
  yo_id_35231684989077556000000((&(__yo_ref_spill_0)), (__yo_str){ .ptr = (const uint8_t*)"n=", .len = 2 });
  /* ... the await ... */
  __yo_t_17030455559196638567 __yo_ref_spill_1 = sm->var___yo_tpl_170230_16934234930401199592 /*yo_mv:m1*/;
  fn_yo_id_3990094665871932219000000(__yo_await_value0, (&(__yo_ref_spill_1)));
  sm->result = sm->var___yo_tpl_170230_16934234930401199592 /*yo_mv:m2*/;
```

Each `&mut __yo_tpl` writes a COPY of the slot; the result is the slot's untouched empty string, and the copies'
buffers leak.

- `…-local.yo` (positive): a body local `s := make()` interpolated before the awaiting piece,
  `` `${s} ${io.await(num(io), io).to_string()}` ``: prints `OUT: `, 74 bytes leak.
- `…-pos.yo` (positive control): `n := io.await(num(io), io);` then `` `n=${n}` ``: prints `OUT: n=7`, no leak.

## The family (develop `64f33c710`)

| Shape | Output | Leak |
| --- | --- | --- |
| `` `n=${io.await(…)}` `` | `OUT: ` | 3 bytes |
| `` `${s} ${io.await(…).to_string()}` ``, `s` a body local | `OUT: ` | 74 bytes |
| `` `${make()} ${io.await(…).to_string()}` `` (probe `l04`) | `OUT: ` | 74 bytes |
| await bound first, then `` `n=${n}` `` | `OUT: n=7` | none |

## Root cause

Read from the source, with one step a hypothesis. `_sm_consuming_read` in `src/codegen/exprs/atom.yo` (the code that
appends `/*yo_mv:…*/`) treats a slot read as a move when the variable's `consumed_at_token` has the read's module,
row and column (or `_is_kept_move_site`). The final `__yo_tpl` (the block's tail) is a real move; the hypothesis is
that every `__yo_tpl` atom the desugar synthesizes carries the template literal's position, so the `&mut __yo_tpl`
receiver reads match the tail's token and render as moves too. The receiver code then is
`sm->var___yo_tpl_… /*yo_mv:m0*/`, which `_is_addressable_c_expr` (`src/codegen/exprs/other_fn_call.yo`) rejects,
so the `&mut` argument takes the `__yo_ref_spill_N` copy branch: the callee writes the copy, never the slot. Without
an await `__yo_tpl` is a plain C local and the path is not taken.

## Expected

`OUT: n=7`, no leak. A `&mut` lend of a slot is the slot's address (`&(sm->var_…)`), never a copy; a move is
recognized by the read's own node (its id), not by a source position that synthesized nodes share.

## Test

With the fix: the two positives and the control become cases in `tests/async/sm_shapes_4.test.yo` asserting the
string's value (`assert(s == "n=7", …)`), so the wrong result fails without a sanitizer; the leak is covered by the
sanitizer job.
