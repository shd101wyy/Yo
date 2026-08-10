# Emitted C `#include` block ordering differs between the TS and self-hosted compilers

**Status: OPEN (cosmetic; 2026-08-10).** Surfaced by the first cli-diff case
that tree-compares a SUCCESSFULLY emitted `.c` file (`std-path-flag`, since
reworked to use `check`): the same source produces the same set of base
includes in a different order —

```
TS:   stdbool, stdint, stddef, stdarg, stdatomic, stdlib, stdio, string, errno, fcntl, ...
self: stdio, stdatomic, errno, stdint, string, stdbool, fcntl, stdarg, stdlib, stddef, ...
```

C semantics are unaffected (standard headers are order-independent), clang
accepts both, and the FIXPOINT is unaffected (it compares self-emit vs
self-emit). What it breaks is **byte-parity of emitted artifacts between the
two compilers**, which is why no `tests/cli-cases/` case can currently
tree-compare an emitted `.c`.

Likely root cause (same class as the PR #92 capture-field bug —
"first-match-by-name over hash maps"): TS `context.cIncludes` is a `Set`
(insertion order preserved); yo-self `c_includes` iterates a hash-ordered
container. A faithful fix needs BOTH the container to preserve insertion
order AND the insertion sequence (type walk, extern walk, base adds) to match
TS's — worth doing if/when emitted-artifact parity becomes a differential
gate; until then this is recorded as an accepted divergence.
