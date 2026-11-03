# A template string in a later arm skips an early return's drop of the interpolated local

**Severity:** S1 — a leak per call (unbounded): an early `return` before a
`cond`/`match` never drops a local when one arm of that branch moves it and
another arm interpolates it in a template string (`${p}`).

**Status:** fixed 2026-11-03 on `vbd/b9-helps-b8-tplfix` (for the B8
ArrayList/String value flip). **Found:** 2026-11-03 by B9, through
`tests/internal/verifier_loops.test.yo`: two of its solver-free tests failed
under LeakSanitizer on the B8 tree binary (`yo-tree-1e0c6a5ed`), and develop
passes 14/14. The mis-positioned tokens are older than the flip and are on
develop too. A develop-built binary does not leak on the reproducer, though,
so it is the flip that sends `p` down this drop path, where the arm-drop window
decides.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
R :: enum(Found(s : String), Ambiguous(base : String));
f :: (fn(flag : bool, amb : bool) -> R)({
  p := String.from("std/abc");
  if(flag, {
    return(R.Found(`file://${p}`));
  });
  cond(
    amb => R.Ambiguous(p),
    true => {
      q := `${p}`;
      R.Found(q)
    }
  )
});
main :: (fn() -> unit)({
  r := f(true, false);
  match(&r, .Found(s) => println(&s), _ => ());
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` reported
`Direct leak of 7 byte(s)`: `p`'s buffer, never released on the early-return
path. In the emitted C, the `if (__yo_v_flag)` block returns with no drop of
`__yo_v_p`. The leak goes away if the true arm says `p.to_string()`, `p.len()`
or `p.append_to(&mut t)` instead of the template.

The compiler hit this shape in `resolve_module_path_ex`
(`src/evaluator/exprs/import.yo`), once per module resolve: the `has_ext` early
`return(ModuleResolveResult.Found(`file://${module_path_to_import}`))` comes
before the final `cond`, which moves `module_path_to_import` into
`.Ambiguous(...)` in one arm and interpolates it in the others.

## Root cause

`parse_template_string` (`src/parser.yo`) built its `.`, `to_string` and
`format` tokens with `Parser.make_syn_tok`. That helper puts a token at row 0,
column 0, character 0, carrying the module's own `input` and `module_path`
cells. Those tokens are comparable with every real token of the file, so they
read as the earliest position in it.

The local `p` is moved in the `amb` arm. The branch-aware join then gives the
true arm its own drop of `p`. It also records that arm as an `UndoneMove`
window with `arm_drop : true`, which runs from `_first_token_of(body)` to
`_last_token_of(body)` (`src/evaluator/utils.yo`). The window is there so
that a `return` inside the arm does not drop `p` a second time.

`_first_token_of` takes the minimum character in the arm body. That minimum
was the template's character-0 `.` token. The window therefore started at
the beginning of the file and covered the early `return` above the `cond`.
`_m3_attach_to_returns` asks `variable_moved_at_cleanup_point(…, true)`,
which counts arm-drop windows, and the answer was "already gone here". No exit
drop was attached to the early `return`.

`yo test` re-serializes a batch with templates already lowered and then
re-lexed. The `.`/`to_string` tokens then get real positions, so a
`tests/*.test.yo` case does not reproduce the bug. The same blind spot is
noted in
`issues/fixed/2026-10-23-an-exit-in-a-later-arm-than-the-move-skips-the-drop-of-the-moved-local.md`.

## Fix

The three tokens are now built with `_template_syn_tok(tok, …)`, which
positions them at the template token, as the builder lowering's own tokens
already were. `make_syn_tok` had no other caller and is removed.

One gap is left. An interpolation whose origin is unknown is parsed by
`Parser.new_shared` over a fresh copy of the interpolation text, so its tokens
carry small characters in a different `input` cell. `_first_token_of` and
`_last_token_of` compare `module_path` only, not `input`. The template parser
takes that fallback only when the body origin is missing or does not match
the text, and no case of it is known in source files.

## Seed caveat

The fix takes effect in code compiled by a compiler that carries it. A tree
binary built by the v0.2.73 seed has its own code, including
`resolve_module_path_ex`, lowered by the seed's parser, so that binary still
leaks once per resolve until `SEED_VERSION` carries the fix. Code it compiles
(user programs, `tests/internal` test binaries) is fixed. The companion double
drop has the same caveat, which is why its `evaluate_panic` workaround stays
(`issues/fixed/2026-11-03-a-local-moved-by-a-match-inside-a-throw-argument-is-dropped-again-on-unwind.md`).

Measured on the fixed tree binary (`yo-tree-tplfix-97eaae7e9`):
- the reproducer is clean under ASan;
- `tests/internal/parser.test.yo` passes 93/93;
- `tests/internal/verifier_loops.test.yo` passes 14/14 (12/14 before).

## Regression test

`tests/internal/parser.test.yo`, "a template's lowered tokens sit at the
template, not at the start of the module". It fails before the fix, because
the `.`/`to_string`/`format` tokens are at character 0, and passes after.
The end-to-end check is the reproducer above under `--sanitize address
--allocator system`, plus `tests/internal/verifier_loops.test.yo`.
