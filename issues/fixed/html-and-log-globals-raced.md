# `std/encoding/html` lazy-initialised its tables through an unsynchronised flag; `std/log`'s setters wrote its globals outside the mutex

**Status: FIXED** (2026-09-06, `std/encoding/html.yo`, `std/log.yo`). Found by
the std API audit — `plans/STD_API_STABILIZATION.md` §3 item 5.

## html

`_entity_map` / `_legacy_set` were built by the first `html_decode` behind a
plain `_state_initialized` bool. Two threads' first decodes raced: both could
build, one could observe the flag set while the other's assignment to the map
was still in flight, and the loser's tables leaked.

Fix: build both tables once at module initialisation (before `main`, on one
thread) — `_entity_map := _build_entity_map();`. No flag, no `_ensure_init`,
nothing to race. Programs that never import the module pay nothing.

## log

The module doc promised one mutex, and `_emit` did take it — but `set_level`,
`set_output`, `set_timestamps`, `get_level` and the public `enabled` read and
wrote `_global_level` / `_global_output` / `_global_timestamps` bare. A thread
reconfiguring while another logged was a data race on three globals.

Fix: every access goes through `_log_mutex`. The filter test is split into
`_enabled_locked` (for `_emit`, which already holds the lock — the mutex is not
recursive) and the public `enabled`, which locks around it.

## Regression test

`tests/thread_safety.test.yo` — four threads reconfigure and query the logger
concurrently at level `Off` (nothing written); it must neither crash nor tear,
and ends in the state the last writer set. A canary rather than a red-first
witness: a data race has no deterministic observable on a native host.
