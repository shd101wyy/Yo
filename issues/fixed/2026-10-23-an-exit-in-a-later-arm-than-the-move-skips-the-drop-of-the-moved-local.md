# An exit in a later arm than the move skips the drop of the moved local

**Severity:** S1 — a leak per call or per loop iteration (unbounded): a
`return`, `break` or `continue` in a later arm of an `if`/`cond`/`match` than
the arm that moves a local never drops the local, though the move is not on
its path.

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the adversarial review of that branch.
Present on develop (`6dee22187`); the branch's `break`/`continue` exit drops
inherited the gap. Hand-written and `derive_rule`-generated bodies alike.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
take :: (fn(s : Box(String)) -> usize)(s.len());
f_return :: (fn(c : bool) -> usize)({
  s := box(String.from("leaked on the else path"));
  (mut(acc) : usize) = usize(0);
  if(c, {
    acc = take(s);
  }, {
    return(usize(9));
  });
  acc
});
f_break :: (fn(k : i32) -> usize)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : usize) = usize(0);
  while(i < i32(4), {
    s := box(String.from("leaked on the break path"));
    i = (i + i32(1));
    if(i != k, {
      acc = (acc + take(s));
    }, {
      break;
    });
  });
  acc
});
main :: (fn() -> unit)({
  a := f_return(false);
  b := f_break(i32(2));
  println(`${a} ${b}`);
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`:

```text
develop (6dee22187):   9 24
                       SUMMARY: AddressSanitizer: 111 byte(s) leaked in 4 allocation(s).
fixed:                 9 24   (no leak)
```

## Root cause

When the other arms of a branch leave (return, break, continue), the join
keeps the moving arm's move token as `consumed_at_token`. The exit-drop attach
(`_attach_if_cleanup_needs_drop`, `src/evaluator/exprs/begin.yo`) only fires
for an exit before that token in source, and an exit in a LATER arm follows it
in source, though the move is not on the exit's path.

## Fix

The exit-drop walks (`_m3_attach_to_returns`, `_m3_attach_to_loop_exits`)
carry the move an exit is ordered against down the tree. Entering arm `i` of a
`cond`/`match`, `_m3_consumed_for_arm` drops it (`.None`: no move ahead on
this path) when it lies in the body of an earlier arm and the flow log kept
it for that arm (an `UndoneMove` at that token, recorded when the next arm
started). A move in a `cond` condition stays, since it runs on every later
arm's path. A move inside the exit's own arm before the exit is still covered
by the flow log's undone moves (`variable_moved_at_cleanup_point`).

The flow-log condition is load-bearing. A first version used the token alone,
and the compiler's own C gained ~1000 drops of minted temps at exits in later
arms (`parse_target` in `src/target.yo`, under ASan a heap-use-after-free):
a temp is not flow-logged, and its `consumed_at_token` is rewritten by each
later use that re-consumes it, so it can sit in an earlier arm although the
temp's count went to `parts := <temp>` long before the branch. The shape
needs a template literal in the earlier arm (its desugaring re-consumes the
temp); `yo test` serializes a batch with templates already desugared, so a
`tests/` case does not reach it, and the gate for it is the dup/drop emit
diff of `src/main.yo` (zero temp drops added) plus this probe under
`--sanitize address --allocator system`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
pt :: (fn(triple : &String) -> Result(i32, String))({
  parts := triple.split(String.from("-"));
  n := parts.len();
  os_str := match(parts.get(usize(0)), .None => String.new(), .Some(p) => p);
  r := cond(
    (n == usize(4)) => {
      env_str := match(parts.get(usize(3)), .None => String.new(), .Some(p) => p);
      if(env_str.len() == usize(0), {
        return(.Err(`no environment for ${os_str}`));
      });
      i32(env_str.len())
    },
    true => {
      if(n == usize(1), {
        return(.Err(String.from("one")));
      });
      i32(0)
    }
  );
  .Ok(r)
});
main :: (fn() -> unit)({
  a := pt(&String.from("x"));
  b := pt(&String.from("a-b-c-dd"));
  c := pt(&String.from("a-b"));
  println(`${a.is_err()} ${b.is_ok()} ${c.is_ok()}`);
});
export(main);
```

**Regression tests:** `tests/move_only.test.yo`, "move-only: an exit in a
later arm than the move drops the local once" (`if`/`else` with `break`, a
nested `match`/`cond` with `continue`, `if`/`else` with `return`).
`tests/derive.test.yo`, "a derive-generated body: … one in a later arm drops
the local".
