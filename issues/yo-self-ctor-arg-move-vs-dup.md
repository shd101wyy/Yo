# yo-self: struct-ctor RC arg — TS moves, yo-self dups (+1 divergence)

Found 2026-07-16 during the round-6 hunt. `b := B(k : kk, n : 1)` where `B`
is a value struct with an RC field: TS treats the ctor arg as a MOVE
(consumes `kk`; rc stays 1), yo-self emits a dup (+1; rc becomes 2).

Repros: /tmp/deref_battery.yo (TS rc=1 vs self rc=2);
tests/codegen-bootstrap/ptr_deref_copy_rc_struct.yo prints "2 2 2" under
yo-self vs "1 1 1" under TS for the same reason (the buffer-store path).

Impact: a systematic +1 per RC ctor-arg — a LEAK class (objects never freed,
GC tracked counts inflated), not a UAF. Not the fixpoint blocker. Fix by
porting TS's ctor-arg consumption (setExprAsConsumed on owning args /
dup only for borrowed) — see evaluator/values struct-construction and the
calls/function.yo fv_p_owning block for the existing move machinery.
