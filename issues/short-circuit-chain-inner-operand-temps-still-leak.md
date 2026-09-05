# A short-circuit CHAIN's inner operand still leaks its temps (the #409 remainder)

**Found**: 2026-09-05, measuring PR #409's fix. **Status**: OPEN. Split out of
`issues/fixed/short-circuit-bare-fn-body-operand-temps-leak.md`, whose
"Remaining work" section describes it — this file exists so the remaining work
is discoverable in `issues/` root rather than only inside a `fixed/` doc.

## Measurement

Per-shape, 1000 calls each, `leaks --atExit`, `--allocator system --optimize 2`.
BEFORE = `yo` 0.2.24 (predates #409), AFTER = develop at `ca13e3c82`.

| shape (whole fn body) | before | after | verdict |
| --- | --- | --- | --- |
| `(id == \`a\`) \|\| (id == \`b\`)` | 4/call | **0** | fixed |
| `(a == \`x\`) && (b == \`y\`)` | 2/call | **0** | fixed |
| `\|\|` inside a match arm | 4/call | **0** | fixed |
| `((a) \|\| (b)) && ((c) \|\| (d))` | 4/call | 2/call | **halved** |
| `((a) \|\| (b)) \|\| (c)` | 6/call | 2/call | **halved** |
| `(((a) \|\| (b)) \|\| (c)) \|\| (d)` | 8/call | 4/call | **halved** |
| statement-position `\|\|` (begin-opened) | 0 | 0 | never affected |
| `\|\|` in a while body | 0 | 0 | never affected |
| `\|\|` in a closure body | 0 | 0 | never affected |

A chain parses as NESTED binaries, so the outermost node's list carries the
outer operands' drops (now emitted) while each INNER `||`'s own list is empty —
its operand temps' drops were scheduled onto the outermost/body node.

## Reproducer

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
probe :: (fn(id : String) -> bool)(
  ((id == `a`) || (id == `bb`)) || (id == `ccc`)
);
main :: (fn() -> unit)({
  (i : usize) = usize(0);
  (a : usize) = usize(0);
  while(i < usize(1000), {
    if(probe(String.from("zz")), { a = (a + usize(1)); });
    i = (i + usize(1));
  });
  println(`done ${a.to_string()}`);
});
export(main);
```

```
$ yo compile chain3.yo --allocator system --optimize 2 -o chain3
$ leaks --atExit -- ./chain3
Process: 2000 leaks for 64000 total leaked bytes
```

(Do NOT try to measure this with `--sanitize address` — on macOS it produces a
binary with zero `__asan` symbols, and CI has leak verdicts off everywhere:
`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`.)

## Where to look

`issues/fixed/short-circuit-bare-fn-body-operand-temps-leak.md` §"Remaining
work" carries the full design record: threading the OUTERMOST short-circuit
node (a `short_circuit_root_node` context field, set when unset and restored on
exit) so an inner `||`'s emission points read the root's list. It was built and
locally validated twice and BOTH times double-dropped operand `a`'s temp at the
fall-through, with both dedup signals reading empty at the second consideration
of the same drop expr — evidence of an uninstrumented fourth emitter placing
fall-through drops.

The named next step is to instrument the remaining direct
`_call_generate_expr(drop_expr)` sites before re-landing the threading:
`return.yo:376/468/522`, `atom.yo:53/388/554`, `while_loop.yo:214`,
`begin.yo:153`.

**Structural note found while verifying #409**: `while_loop.yo:201` consults
ONLY the name-keyed `short_circuit_handled_drop_var_names`, and every consumer
of that set REMOVES the entry on hit (`begin.yo:145`, `while_loop.yo:206`,
`drop_dup.yo:885`), so it is a consume-once signal. Unlike `begin.yo:121` and
`drop_dup.yo:861`, `while_loop.yo` never consults `emitted_deferred_drop_ids`
and never inserts into it. That asymmetry is not tripped by #409 as it stands
(measured: the while-body shape is unchanged at 0 leaks and 26 emitted drops
before and after), but it is the shape the re-landing attempt keeps hitting.
