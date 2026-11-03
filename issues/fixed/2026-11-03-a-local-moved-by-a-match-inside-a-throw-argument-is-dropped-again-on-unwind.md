# A local moved by a match inside a throw argument is dropped again on unwind

**Severity:** S1 — a valid program that throws ``dyn(match(local, .Some(m) => `…`, …))`` inside an `if` double-frees the matched local when the throw unwinds; the compiler itself does this in `evaluate_panic`, so a comptime `panic` with a message hangs or aborts `yo compile`.

**Status:** fixed 2026-11-03 on `vbd/b9-helps-b8-tplfix`, by the parser fix of
`issues/fixed/2026-11-03-a-template-string-in-a-later-arm-skips-an-early-returns-drop-of-the-interpolated-local.md`.

Found by the B8 flip (ArrayList/String values, v0.2.74). The cli case
`comptime-panic-is-a-compile-error` hung under the flipped tree binary
(`yo-tree-1e0c6a5ed`). The ASan build of the compiler (`--sanitize address
--allocator system`) reports a double free of a `String` inside
`evaluate_panic` (`src/evaluator/builtins/panic.yo`), where
`match(ct_msg, .Some(m) => …)` sits inside `exn.throw(dyn(…))` within an `if`.

## Reproducer

`tests/codegen-bootstrap/match_in_throw_arg_template_double_drop.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ Exception } :: import("std/error");
throw_matched :: (fn(fail : bool, exn : Exception) -> i32)({
  (msg : Option(String)) = .Some(String.from("boom"));
  if(fail, {
    exn.throw(
      dyn(
        match(
          msg,
          .Some(m) => `failed: ${m}`,
          .None => String.from("failed")
        )
      )
    );
  });
  i32(0)
});
run_throw_matched :: (fn() -> i32)({
  exn := Exception(throw : (_err -> unwind(i32(-1))));
  throw_matched(true, exn)
});
main :: (fn() -> unit)({
  println(run_throw_matched());
});
export(main);
```

```
$ yo compile r.yo -o r && ./r
free(): double free detected in tcache 2      # rc=134; expected "-1"
```

The emitted C for `throw_matched` moves the payload into `m`, drops `m` at the
end of the arm, and then on the escape check after the throw drops `msg` as a
whole:

```c
__yo_t_... __yo_pat___yo_v_m = __yo_v_msg.data.__yo_v_Some.__yo_v_value;
...
yo_id_4683339436075136311000000(&(__yo_v_m));          // String drop of the moved payload
...
(((void* (*)(...))__yo_v_exn.__yo_v_throw)(...));
if (__yo_effect_escaped) {
  // Drop consumed variables (unwind propagation)
  __yo_venum_drop___yo_t_11596669080538037199((void*)&(__yo_v_msg));   // second free
  __yo_effect_escaped = 1;
  return (int32_t){0};
}
```

## What triggers it

Each row below varies one thing from the reproducer, and counts the
`unwind propagation` drops in `--emit-c` (tree binary `yo-tree-533e15040`):

| variant | drops |
| --- | --- |
| the reproducer (template arm on `.Some`, inside `if`) | 1 (bug) |
| ``.Some(m) => `f: ${String.from("x")}` `` (template not naming `m`) | 1 (bug) |
| ``.Some(m) => { t := `f: ${m}`; t }`` | 1 (bug) |
| the throw not inside an `if` | 0 |
| the template on the `.None` arm instead | 0 |
| `.Some(m) => m` / `m.clone()` / `String.from("x")` | 0 |
| `.Some(m) => { mut(t) := String.from("x"); t.push_str("y"); t }` (the template desugared by hand) | 0 |
| the match bound to a local before the throw | 0 |

The trigger is the template string itself. The hand-desugared form is clean,
and a `yo test` case cannot reproduce the bug: the test runner's batch
reprints the test file's AST, the template becomes ordinary source, and the
drop disappears (an in-file test of the same function passes).

## Root cause

`parse_template_string` (`src/parser.yo`) built the lowering's `.`,
`to_string` and `format` tokens with `Parser.make_syn_tok`, at row 0 /
character 0 of the module's own token stream. They are comparable with every
real token of the file and read as its earliest position. Any token-order
decision that takes the minimum over an arm body holding a template (for
example the `UndoneMove` windows built from `_first_token_of`,
`src/evaluator/utils.yo`) saw the arm start at the top of the file. The
escape check after the throw orders `msg`'s move against the throw through
this machinery, and with the mis-positioned tokens it kept the drop.
Positioning the tokens removes the drop; that was measured. Which comparison
misfired was not instrumented. The guess above (tokens from the template's
own lexer input) was close but not exact. The tokens shared the function's
stream; they were mis-positioned in it.

## Fix

The parser positions the three tokens at the template token
(`_template_syn_tok`), as it already did for the builder lowering's own
tokens. On the fixed tree binary the reproducer prints `-1` with rc 0. On
`yo-tree-533e15040` it reports an ASan double free. The same fix closes the
early-return leak in the companion doc.

## Workaround, kept until the seed carries the fix

`evaluate_panic` (`src/evaluator/builtins/panic.yo`) binds the message to a
local before the throw (the clean "bound before" row above; baec08af7,
3a7ca187e). The workaround has to stay for now. The compiler's own
`evaluate_panic` is compiled by the seed, and the seed's parser still
mis-positions the template tokens. Measured: with the workaround reverted, a
tree binary built by the v0.2.73 seed from the fixed parser still hangs at
exit on the cli case `comptime-panic-is-a-compile-error` (rc 124, timeout
300 s). It prints the right diagnostic first. The workaround can be reverted
once `SEED_VERSION` carries the parser fix.

## Test

`tests/codegen-bootstrap/match_in_throw_arg_template_double_drop.yo`, with its
golden (`mode=run compile_rc=0 rc=0`, output `-1`). Before the fix,
`scripts/diff-test.sh <file> --release` reports GOLDEN-DIFF with `rc=134`.
