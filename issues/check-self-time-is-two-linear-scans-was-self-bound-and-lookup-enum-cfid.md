# `check src/main.yo` self time: ~45% is TWO linear scans — `_was_self_bound` (RC churn + TLS reads) and `lookup_enum_cfid`

**Status: DIAGNOSED 2026-09-20 (profile-verified, v0.2.38 release binary). Not yet fixed.**

Found while measuring the allocator share for `plans/backlog/PERCEUS_REUSE.md`
Phase 0 step 3. It is not a Perceus finding; it is the thing that sits in
front of every allocation-side lever.

## Measurement

`yo check src/main.yo --std-path ./std` (yo 0.2.38 release binary, quiet Mac
Mini M4 16 GB, tree `7eada73f8`): 380 s wall, 31.5 GB peak footprint.
macOS `sample <pid> 40` taken 75 s in; the worker thread had 29,987 busy
samples (the 30,245 `__ulock_wait` samples are the parked main thread).

| top of stack                          | samples | share     |
| ------------------------------------- | ------- | --------- |
| `_tlv_get_addr` (libdyld)             | 7,329   | **24.4%** |
| `__yo_decr_rc`                        | 6,133   | **20.5%** |
| malloc/free family (libsystem_malloc) | 4,566   | 15.2%     |
| `<deduplicated_symbol>` (in yo)       | 3,586   | 12.0%     |
| `lookup_enum_cfid` (self)             | 1,645   | 5.5%      |
| memset/memmove/memcmp                 | 1,917   | 6.4%      |
| `_was_self_bound` (self)              | 543     | 1.8%      |

Attribution of the `_tlv_get_addr` leaf samples by caller (call-graph walk of
the same sample): 7,006 of 7,329 are under `__yo_decr_rc`, and **6,566 of
those are `_was_self_bound → __yo_decr_rc → _tlv_get_addr`**. So one function
accounts for ~22% of all busy samples through its refcount traffic alone,
before its own self time and its share of the `__yo_decr_rc` self time.

The C ids were resolved against the release's portable C
(`yo-v0.2.38-aarch64-apple-darwin.c.gz`, `gh release download v0.2.38`):
`yo_id_4335934203646402126000000` = `_was_self_bound`
(`src/types/env_lookup.yo:208`), `yo_id_2093485829674852146000000` =
`lookup_enum_cfid` (`src/value.yo:992`).

## Mechanism

### `_was_self_bound(env, name, id_to_find)`

Called from `resolve_some_type_to_concrete`'s name-collision arm
(`env_lookup.yo:394`, `:424`) — i.e. on the hot SomeT-resolution path. It
walks EVERY frame of the env and EVERY variable in each frame:

```rust
match(vars.get(vi), .Some(var) => cond((var.name == name) => match(var.value.get(usize(0)), ...
```

`vars.get(vi)` hands back an owned `Option(Variable)` — a dup of a TRACKED
`Variable` (192 B, cycle-capable) and its scope-end drop. That drop is the
`__yo_decr_rc` tracked tail: `if (__yo_gc_collecting)` and the
`__yo_gc_add_root` / `__YO_GC_BUFFERED` bookkeeping read `_Thread_local`
state, and on Darwin every `_Thread_local` read is a `_tlv_get_addr` CALL
(the runtime comment at `gc_runtime.yo:385` already records this cost). One
scan of an env with a few thousand variables is therefore a few thousand
tracked dup/drop pairs, each paying two TLS calls — for a `String ==`
that is false for almost every variable.

### `lookup_enum_cfid(enum_id)`

A global `ArrayList(EnumCfidEntry)` scanned linearly with `String ==` on
every call; the list grows with every registered enum. 5.5% self time.

## Levers (not applied here)

- `_was_self_bound`: compare `var.name` through a borrowed accessor (the
  `for` borrowed iteration or an index-based `inout` read) so the scan dups
  nothing; better, key the "ever bound to TypeVal id" fact in a per-env
  `HashSet` maintained at bind time so the scan disappears.
- `lookup_enum_cfid`: a `HashMap(String, String)` beside the list.
- Both are `type_key`/`String`-identity symptoms
  (`issues/yo-self-compile-performance-rc-string-eq.md` levers still apply).

Raw profile: `sample` output kept in the Phase 0 scratch directory of the
measuring session (top-of-stack table reproduced above; regenerate with the
command in the Measurement section).
