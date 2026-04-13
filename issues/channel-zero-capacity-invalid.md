# `Channel.new(0)` violates ring-buffer invariants

## Problem

After migrating `std/sync/channel` to an inline ring buffer, the constructor still
accepted `capacity == 0` even though the API comment says capacity must be greater
than zero.

That leaves `_capacity == 0` inside the channel and later operations compute indices
with `% self._capacity`, which is invalid.

## Fix

Reject zero capacity in `Channel.new()` with an explicit assertion so invalid
channels fail immediately instead of reaching modulo-by-zero behavior later.
