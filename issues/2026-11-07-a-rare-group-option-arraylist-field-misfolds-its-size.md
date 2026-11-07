# An `Option(ArrayList(T))` field of the rare group misfolds its size: the evaluator counts 16, the C layout is 32

**Severity:** S1 — heap-buffer-overflow in every binary the tree builds (a 504-byte
allocation receives a 512-byte struct copy), found while landing O-1's
`ExprInfoRare.origin` field (branch `vbd/o1-o2-origin-architecture`, commit
`4eb5b9f43` + the un-boxed field).

## Reproducer

Add `origin : Option(ArrayList(OriginRootPlace))` as the last field of
`ExprInfoRare` (`src/expr_info.yo`, `OriginRootPlace` a local 96-byte struct in
the same file) and build the compiler with the v0.2.75 seed:

```bash
nix develop . --command bash -c 'yo build --std-path ./std --cc clang'
yo-out/<target>/bin/yo check tmp/fixme.yo --std-path ./std
# ArrayList.push: allocation failed (RSS stays ~4 MB — a single huge allocation)
```

Under ASan (`yo compile src/main.yo --sanitize address --allocator system`):

```
ERROR: AddressSanitizer: heap-buffer-overflow, READ of size 512
0x... is located 0 bytes after 504-byte region
#0 __asan_memcpy ... #1 std's Box.new specialization for ExprInfoRare
```

## Root cause

The emitted C lays `Option<ArrayList(T)>` out as `{tag, union{struct{ptr,len,cap}}}`
(32 bytes with padding), but the size the evaluator folds into `Box.new`'s
allocation (`+ 496ULL` where the field-free struct folds `480ULL`) counts the new
field as **16** — the rare group's `Box` allocation is 16 bytes short, and the
struct copy into it overflows. Measured: base (no field) fold `480`, tip (with
`Option<ArrayList(OriginRootPlace))`) fold `496`, tip C `sizeof` `512`. A
user-level probe of the same shape (`tmp/sizeprobe.yo`: `Holder :: struct(a :
i32, origin : Option(ArrayList(ORPlace)), b : i32)`) agrees with itself
(`size_of(Option(ArrayList(ORPlace))) == 32`, `Holder == 48`), so the divergence
is specific to the seed compiling the `src` tree's rare-group context — the
layout engine's `Option`-over-`ArrayList` size and the C emitter's disagree
there.

## Fix

The O-1/O-2 branch works around it by boxing:
`origin : Option(Box(ArrayList(OriginRootPlace)))` — an `Option` over a pointer
is a nullable pointer on both sides (8 bytes). The underlying layout-engine
divergence (`size_of` vs the C layout for `Option(ArrayList(T))` in this
context) remains open for the layout owner: any other struct reaching the same
shape inside a `Box`'d group will corrupt the same way.

## Test that pins it

The O-1 corpus rows (`tests/origins/corpus/match-arm-composite.yo` and its
siblings) and `check ./src` on the built tree: with the un-boxed field both are
unreachable (every check aborts); with the box they run.
