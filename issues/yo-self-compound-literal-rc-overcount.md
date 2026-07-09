# yo-self: compound-literal incr_rc over-counts stores — breaks cycle collection (corpus hashmap_self_cycle DIFF)

## Status

OPEN. Introduced by `10e82d0c0` ("fix(yo-self): compound literal RC management
for pointer-typed fields"). That commit's message records the corpus result
"106/107, 1 DIFF on hashmap_self_cycle.yo (RC timing change … non-fatal)".
The DIFF is **not** benign: the self-compiled binary's output leaks the
`a <-> b` HashMap cycle (`after == mid`, nothing reclaimed), while the TS
binary reclaims it.

## Symptom

```
YO_SELF_BIN=<bin> bash scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4
  DIFF  tests/codegen-bootstrap/hashmap_self_cycle.yo  (ts_rc=0 self_rc=0)
  # TS prints "hashmap cycle fully reclaimed", self prints "hashmap cycle leaked"
```

Instrumented counts (self binary): `before=0 mid=4 after=4` — `Gc.collect()`
reclaims nothing. Trace functions, traverse dispatch, and Bucket visitors are
all emitted correctly (verified by C diff against the TS emission); the cycle
is simply never identified as garbage because every stored reference is
over-counted.

## Root cause

For `new_bucket := Bucket(key : key, value : value)` followed by
`data_ptr(index).* = new_bucket` (std/collections/hash_map.yo `set`), the two
compilers emit different RC protocols:

TS (`src/codegen/exprs/...`, the reference):

```c
tmp = ___dup(value);                                  // +1 into the literal
new_bucket = (Bucket){ .key = key, .value = tmp };
stored = ___dup(new_bucket);                          // +1 on store
*(data_ptr + index) = stored;
___drop(new_bucket);                                  // -1 local literal copy
___drop(old_bucket);                                  // -1 local slot copy
// net: slot holds exactly one reference
```

yo-self after 10e82d0c0:

```c
new_bucket = (Bucket){ .key = key,
                       .value = (__yo_incr_rc(value), value) };  // +1 (NEW)
temp_dup = new_bucket;
temp_dup.value = __yo_incr_rc(temp_dup.value);        // +1 (dup-on-store)
temp_dup;                                             // ← discarded; stores new_bucket
*(data_ptr + index) = new_bucket;
// NO ___drop of new_bucket / old_bucket
// net: +2 for one slot reference
```

Every value stored through a compound-literal-with-managed-field path carries
one extra refcount. The Bacon–Rajan trial deletion then always finds an
"external" reference on cycle members → never collected.

Before 10e82d0c0 the literal did **not** incr (net +1 via dup-on-store alone),
which balanced by accident — but left true dangling-pointer bugs where a
value-struct local was the only owner (the "parsed 0 top-level exprs" Parser
bug that commit fixed). So:

- pre-10e82d0c0: under-counts when the literal is the only owner (dangling ptr)
- post-10e82d0c0: over-counts on every store (cycle leak)

## Correct fix (faithful port)

Port the missing half of the TS protocol: yo-self must emit `___drop(local)`
for **value-struct locals containing RC-managed fields** at scope end / after
the value is stored (TS emits `fn_..___drop(new_bucket)` + `___drop(old_bucket)`),
and the dup-on-store path must store the dup temp instead of discarding it.
Then the literal-site incr from 10e82d0c0 becomes balanced exactly as in TS.

Relevant sites:

- `yo-self/codegen/exprs/other_fn_call.yo` (~line 1254, compound-literal builder)
- dup-on-store emission (`temp_dup_struct_...` builder) — stores original,
  discards dup
- scope-end drop machinery (`_emit_deferred_drops` family) — no entry for
  value-struct locals with managed fields

## Repro

```bash
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin
/tmp/yo-self-bin compile tests/codegen-bootstrap/hashmap_self_cycle.yo -o /tmp/hsc && /tmp/hsc
# prints "hashmap cycle leaked"; TS-compiled prints "fully reclaimed"
```
