# The D1 thread reach walk trusts every std body, including the user impls a std generic calls

**Severity:** S1. A thread closure that writes a `mut(G)` global through a user trait impl is rule D1's error when
it calls the impl directly (`a == b`, `${a}`, a user generic `run(&a)`), and is accepted when a std generic makes
the same call: `xs.contains(&k)` running `K`'s `Eq`, `println(&a)` running `K`'s `ToString`. The impl's write races
with the main thread (TSan: data race on `G`). Pre-existing: v0.2.76 accepts both reproducers.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A42). Confirmed on develop `64f33c710`. Companion:
`issues/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.md`
(A41); the D3 twin of this trust was fixed in
`issues/fixed/2026-10-15-d3-trusts-every-mutator-defined-in-a-pragma-file-so-std-writes-through-an-arc.md`.

## Reproducers

`issues/repros/2026-11-11-the-d1-thread-reach-walk-trusts-every-std-body-including-the-user-impls-a-std-generic-calls.yo`
(negative, expects rule D1's "This closure runs on another thread … references the module-level global 'G'"
error, which carries no code today):

```yo ignore
K :: struct(n : i64);
derive(K, Copy, Clone);
impl(K, Eq(K)((==) : (fn(lhs : &Self, rhs : &Self) -> bool)({
  G = (G + i64(1));
  lhs.n == rhs.n
})));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(K).new();
  xs.push(K(n : i64(1)));
  t := Thread(unit).spawn({ xs }(io : Io) => {
    mut(i) := i64(0);
    while(i < i64(1000000), { _ := xs.contains(&K(n : i64(2))); i = (i + i64(1)); });
    ()
  });
  mut(j) := i64(0);
  while(j < i64(1000000), { G = (G + i64(1)); j = (j + i64(1)); });
  t.join();
  …
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize thread --allocator system --cc clang -o t && ./t
WARNING: ThreadSanitizer: data race (pid=…)
SUMMARY: ThreadSanitizer: data race ??:? in __yo_user_main
```

- `…-println.yo` (negative, D1): `println(&a)` on the thread, `K`'s `ToString` writes `G`: TSan data race.
- `…-pos.yo` (positive control): the same `xs.contains(…)` on the thread with an `Eq` that touches no global.
  Accepted, TSan clean, `OUT: 1000000`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `xs.contains(&k)` (std `ArrayList`) on the thread; `K`'s `Eq` writes `mut(G)` | accepted, data race | D1 error |
| `println(&a)` (std `fmt`) on the thread; `K`'s `ToString` writes `mut(G)` | accepted, data race | D1 error |
| `a == K(…)` on the thread, same `Eq` | D1 error ("calls '=='") | D1 error |
| `` `${a}` `` on the thread, same `ToString` (ledger, base) | D1 error | D1 error |
| a USER generic `run(&a)` whose body calls `x.tick()`; `K`'s `Tick` writes `G` | D1 error ("calls 'run', which calls '(x.tick)'") | D1 error |
| the std call with an impl that writes nothing global | accepted, TSan clean | accept |

## Root cause

Confirmed by reading the source. `function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`)
returns early, memoizing "no reach", for any body whose module path satisfies `is_implicitly_unsafe_capable_file`
(`src/evaluator/memory_safety.yo`: a `pragma(Pragma.AllowUnsafe)` file or an `auto-generated://` module), with the
comment "A body defined in a pragma'd file is the audited base". `std/collections/array_list.yo`,
`std/fmt/index.yo`, `std/fmt/to_string.yo` and `std/prelude.yo` all carry the pragma, so the walk stops at
`ArrayList.contains` and `println` and never sees the trait call inside them. The user-generic row shows the walk
does follow a trait call inside a generic body once it descends (`run` → `(x.tick)`), so it is the location-based
early return, not missing resolution, that hides the impl. Whether the specialized std instance's call nodes carry
the user impl's `FuncVal` the same way is a hypothesis to confirm with the fix.

The D3 twin had the same shape: `d3_check_pending` trusted "every mutator in every pragma'd file", and the fix
replaced the location test with a per-callee fact (the mutation mask). The pattern applies here, but not verbatim:
D1 cannot simply walk std bodies, because std's own globals are legitimately non-`Sync` under a lock (`std/log`,
the html tables, per the section comment). What the trust can soundly cover is std's own code, not code std calls
on the user's behalf: a pragma'd body is trusted for the globals it references itself, and the walk still descends
into each callee it reaches that is defined outside a pragma'd file (a trait impl, a closure argument).

## Expected

Rule D1 (`plans/reference/PARALLELISM_RULES.md`): a thread closure may not reach a non-`Sync` or written
module-level global "directly or through any function it can call". A user `Eq` that std calls is such a function.

The design side (shared with A41): D1's "a body defined in a pragma'd file is the audited base and is not
descended into" has no clause for trait-bound callbacks of generic std bodies, nor for implicit drop glue (A41).
An audit of std can vouch for std's code, not for the user impls it instantiates. `docs/en-US/THREAD_SAFETY.md`
"Known Holes: None known" is false while either stands, and its "Trust Boundary" table should state what the std
trust covers.

## Test

With the fix: the two negative programs and the positive control go to `tests/parallelism_soundness.test.yo`
beside the D1 cases (negative: the D1 message naming the user impl reached through the std callee), plus a canary
that a spawn body calling `std/log` still compiles (std's own lock-guarded globals stay trusted).
