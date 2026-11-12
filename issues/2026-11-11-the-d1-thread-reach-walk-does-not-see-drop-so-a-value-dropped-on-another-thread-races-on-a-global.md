# The D1 thread reach walk does not see `Drop`, so a value dropped on another thread races on a global

**Severity:** S1. A value moved into a `Thread.spawn` closure, or received from a `Channel` on the other thread,
is dropped there; when its type's `Drop` writes a `mut(G)` global, `yo check` accepts the program and the
destructor races with the main thread's writes (TSan: data race on `G`; without TSan, lost updates: `OUT:` between
1126671 and 1269231 in five of six runs, expected 2000000). The same write in the closure body is rule D1's error.
Pre-existing: v0.2.76 accepts both reproducers.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A41). Confirmed on develop `64f33c710`. Companion:
`issues/2026-11-11-the-d1-thread-reach-walk-trusts-every-std-body-including-the-user-impls-a-std-generic-calls.md`
(the other half of the D1 trust boundary, A42).

## Reproducers

`issues/repros/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.yo`
(negative, expects rule D1's "This closure runs on another thread … references the module-level global 'G'"
error, which carries no code today):

```yo ignore
S :: struct(n : i64);
impl(S, Drop(drop : (fn(self : &mut Self) -> unit)({
  mut(i) := i64(0);
  while(i < i64(1000000), { G = (G + i64(1)); i = (i + i64(1)); });
})));
main :: (fn() -> unit)({
  s := S(n : i64(1));
  t := Thread(unit).spawn({ s }(io : Io) => { _ := s.n; () });   // `s` is dropped on the thread
  mut(i) := i64(0);
  while(i < i64(1000000), { G = (G + i64(1)); i = (i + i64(1)); });
  t.join();
  v := G;
  println(`OUT: ${v.to_string()} (expect 2000000)`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize thread --allocator system --cc clang -o t && ./t
WARNING: ThreadSanitizer: data race (pid=…)
SUMMARY: ThreadSanitizer: data race ??:? in __yo_user_main
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
OUT: 1126671 (expect 2000000)
```

- `…-channel.yo` (negative, D1): the closure captures a `Channel(S)` and discards each `rx.recv()`; every `S` it
  receives is dropped on the thread, whose `Drop` writes `G`: TSan reports data races on `G`, one of them in the
  spawn wrapper.
- `…-pos.yo` (positive control): the thread captures `n := s.n`, a copy of the field; `s` is dropped on the main
  thread after `join`. Accepted, TSan clean, `OUT: 1000000`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| a capture whose `Drop` writes `mut(G)`, dropped at the end of the thread closure | accepted, data race | D1 error |
| a value received from a `Channel(S)` and discarded on the thread; `S`'s `Drop` writes `mut(G)` | accepted, data race | D1 error |
| the same write spelled in the closure body, or in a function or user generic it calls (`run(&a)` → `x.tick()`) | D1 error | D1 error |
| a capture that is a copy of a field; the `Drop` value stays on the main thread | accepted, TSan clean | accept |

## Root cause

Confirmed by reading the source. `function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`,
the "GLOBAL-REACH mode — rule D1" section) runs `_gr_walk` over the closure's evaluated body. `_gr_walk` visits AST
nodes: atoms (`_gr_atom`, `_gr_value_function`), and for each `FnCall` the statically resolved callee
(`_MsP.callee`), a local closure value's body (`_gr_walk_closure_callee`), then the callee expression and the
arguments. Destruction is not an AST node: the drop of a by-value capture when the closure's environment dies, of a
discarded `_ := rx.recv()` result, or of a local at its scope end is emitted by codegen as drop glue, and the walk has
no case that asks which types are dropped in the body or in its captures and walks their `Drop` impls. The section
contains no `drop`/`Drop` handling at all. The capture check passes because `S(n : i64)` is `Send`: D10 asks whether
the VALUE may move, not what its destructor touches.

## Expected

Rule D1 (`plans/reference/PARALLELISM_RULES.md`): a closure that runs on another thread "may not REACH a
module-level global whose type is not `Send`, directly or through any function it can call"; for a written value
global, `docs/en-US/THREAD_SAFETY.md` "Module-Level Globals" says the same ("directly or through any function it
calls"). A `Drop` impl is a function the thread calls. The walk must treat each type the closure drops (its by-value
captures, and every value its body destroys, temporaries and discarded results included) as a call of that type's
`Drop` impl and walk it, transitively through drop glue of fields.

The design gap behind this and A42: D1's trust sentence — "a body defined in a pragma'd file is the audited base and
is not descended into" (`PARALLELISM_RULES.md` D1) — and the walk built on it cover only code the AST names. Neither
the rule nor the doc has a clause for implicit drop glue (this issue) or for trait-bound callbacks that a generic std
body makes into user impls (A42), and `docs/en-US/THREAD_SAFETY.md` "Known Holes: None known" is false while
either stands.

## Test

With the fix: the two negative programs and the positive control go to `tests/parallelism_soundness.test.yo`
beside the other D1 cases (negative: the D1 message naming the `Drop` impl; positive: compiles and runs), and the
thread corpus that `scripts/tsan-thread-corpus.sh` runs under `--sanitize thread` gains the positive control.
