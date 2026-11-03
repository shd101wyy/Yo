# A local moved by a match inside a throw argument is dropped again on unwind

**Severity:** S1 — a valid program that throws ``dyn(match(local, .Some(m) => `…`, …))`` inside an `if` double-frees the matched local when the throw unwinds; the compiler itself does this in `evaluate_panic`, so a comptime `panic` with a message hangs or aborts `yo compile`.

Found by the B8 flip (ArrayList/String values, v0.2.74). The cli case
`comptime-panic-is-a-compile-error` hung under the flipped tree binary
(`yo-tree-1e0c6a5ed`). The ASan build of the compiler (`--sanitize address
--allocator system`) reports a double free of a `String` inside
`evaluate_panic` (`src/evaluator/builtins/panic.yo`), where
`match(ct_msg, .Some(m) => …)` sits inside `exn.throw(dyn(…))` within an `if`.

## Reproducer

`issues/repros/2026-11-03-a-local-moved-by-a-match-inside-a-throw-argument-is-dropped-again-on-unwind.yo`:

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

The trigger is the template string itself. A template is desugared at parse
time into a `begin` whose tokens come from the template's own lexer input, so
the tokens are not `_tokens_are_comparable` with the enclosing function's. The
hand-desugared form, whose tokens share the function's stream, is clean. That
is also why a `yo test` case cannot reproduce the bug: the test runner's batch
reprints the test file's AST, the template becomes ordinary source, and the
drop disappears (an in-file test of the same function passes).

The drop is emitted by `generate_consumed_var_drops_for_escape`
(`src/codegen/exprs/return.yo`). Its keep decision should reject `msg` through
`_variable_moved_before_cleanup_point` or
`_consumption_is_ordered_against_cleanup_point`. It does not: the template
arm's foreign-stream tokens change either the `Variable` that
`_cleanup_drop_variables` / `_resolve_drop_target_in_scope` resolve or its
`consumed_at_token`, so the move by the match is not seen at the escape point.
Which of the two needs instrumenting with a built compiler; it has not been
pinned down yet.

## Workaround in the tree

`evaluate_panic` (`src/evaluator/builtins/panic.yo`) binds the message to a local before the throw (the clean "bound before" row above), so the compiler no longer double-frees on a comptime panic and the cli-case `comptime-panic-is-a-compile-error` passes. The codegen bug itself is open.

## Test

The reproducer moves to `tests/codegen-bootstrap/match_in_throw_arg_template_double_drop.yo` with its golden (`mode=run compile_rc=0 rc=0`, output `-1`) together with the fix. Before the fix, `scripts/diff-test.sh <file> --release` reports GOLDEN-DIFF with `rc=134`.
