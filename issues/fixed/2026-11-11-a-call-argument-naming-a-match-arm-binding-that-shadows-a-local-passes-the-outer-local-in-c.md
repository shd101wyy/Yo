# A call argument naming a match arm binding that shadows a local passes the outer local in C

**Severity:** S1. A miscompile of valid code with no borrows involved: in `x := …; match(o, .Some(x) => eat(x), …)`
the C for `eat(x)` passes the OUTER `x`. A moving call frees the outer local, and its later use is a
heap-use-after-free (the arm's `__yo_v_x_s0` is declared and never used or dropped); a reading call sees the wrong value. Pre-existing: v0.2.76
accepts the program and its binary fails the same way under ASan.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A16). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-call-argument-naming-a-match-arm-binding-that-shadows-a-local-passes-the-outer-local-in-c.yo`
(a valid program, `// expect: accept`; correct output `OUT: OUTER-…`):

```yo
eat :: (fn(b : String) -> unit)(());
main :: (fn() -> unit)({
  x := String.from("OUTER-0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  o := Option(String).Some(String.from("INNER-0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  match(o, .Some(x) => eat(x), .None => ());
  println(`OUT: ${x}`);
  ()
});
```

```text
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free          # develop 64f33c710 and v0.2.76
$ yo compile repro.yo --emit-c --skip-c-compiler            # the arm's C block:
    __yo_t_… __yo_v_x_s0 = __yo_v_o.data.__yo_v_Some.__yo_v_value;
    yo_id_…(__yo_v_x);                                       # eat(x): the OUTER local
```

- `…-parameter.yo`: the shadowed name is a by-value parameter `x`; heap-use-after-free.
- `…-read.yo`: no move: `show(&x)` with `show(b : &String)` (a small `&T` parameter is passed by value in C)
  prints `OUT: OUTER`; correct is `OUT: INNER`.
- `…-pos.yo` (positive control): the arm binding is named `y`; prints `OUT: OUTER-…`, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `.Some(x) => eat(x)` over `Option(String)`, local `x : String` | UAF | `eat` gets the arm's `x` |
| `.Some(x) => eat2(x)` over `Option(Box(String))`, local `x : Box(String)` (ledger sh06) | UAF | same |
| `.A(s) => eat(s)` over an enum payload, local `s` (ledger sh15) | UAF | same |
| the shadowed name is a parameter (ledger sh19) | UAF | same |
| `.Some(x) => show(&x)`, `show(b : &String)` | prints the outer value | the arm's value |
| `.Some(x) => { y := x; eat(y); }` (the binding read outside a call argument) | correct (`y = __yo_v_x_s0`) | — |

## Root cause

Confirmed in `src/codegen/exprs/other_fn_call.yo`, `_materialize_arg`. The argument's code comes from the atom
emitter, which resolves the arm binding through `shadow_binding_c_name` (`src/codegen/functions/context.yo`) to
`__yo_v_x_s0`. `_materialize_arg` then asks whether the SOURCE name is already declared in an open C scope
(`already_in_scope`, `scope_stack_contains(ds, sanitize_for_c_identifier(vname))`), which the outer `x` is, and
on that answer replaces the code with the source name ("the in-scope local/param holds the same value, so reuse
it"): `final_name := if(emitted || already_in_scope, vname, arg_code)`. A pattern binding that
`shadow_binding_decl_name` renamed because the name was taken is exactly the case where that assumption is false.
The check should compare against the resolved C name (`shadow_binding_c_name`), not the source name.

Related, distinct defects (all in the same shadowed-name family, none on the argument path):

- `issues/2026-10-30-an-escape-path-drop-names-a-later-local-that-a-same-named-pattern-binding-shadows-in-c.md`:
  an effect-escape DROP names a later local through a same-named pattern binding (C compile error). Here the
  value passed to a call is wrong, and no drop path is involved. The repro above also shows that drop-path
  shape: the escape branch after `eat(…)` drops `__yo_v_x`.
- `issues/seed-early-return-drops-later-local-through-shadowing-pattern-name.md`: an early `return`'s scope-end
  drop names a later local (C compile error). Same split: a drop list, not an argument.
- `issues/fixed/2026-11-05-a-match-arm-binding-that-shadows-a-local-is-never-dropped.md`: the arm binding was
  never dropped (leak); fixed by the `shadow_bindings` stack this defect bypasses.

## Expected

The program prints `OUT: OUTER-…` and runs clean: a pattern binding shadows the outer name for the whole arm
(`plans/reference/MATCH_PATTERN_MATCHING.md` §4.3: "a bare identifier is a binding unless it resolves, in the
enclosing scope, to a compile-time-only value"), in every C use of the name.

## Test

With the fix: the three programs and the positive control as cases of
`tests/shadowed_binding_early_return_drop.test.yo` (or a new `tests/match_shadowed_binding_argument.test.yo`),
run under `--sanitize address` and comparing the output.

## Fix

Fixed 2026-11-13 (branch `fix/c8-codegen-ownership`). `_materialize_arg` (`src/codegen/exprs/other_fn_call.yo`)
resolves the argument's source name through `shadow_binding_c_name` before it asks whether the name is declared in
an open C scope, and the in-scope reuse passes that resolved C name (`__yo_v_x_s0`), not the source name. Without a
shadowing pattern binding the resolved name is the sanitized source name, so every other argument emits the same C as
before.

All four reproducers run clean under ASan (`OUT: OUTER-…` for the three moving forms, `OUT: INNER` for `show(&x)`).

**Regression test:** `tests/shadowed_binding_early_return_drop.test.yo`, "a call argument naming a shadowing arm
binding passes the arm's value": the `String`, `Box(String)`, enum-payload, parameter and `&x` forms, each asserting
the value the callee received and that the outer binding is intact (the moving forms are a heap-use-after-free under
the runner's ASan before the fix).
