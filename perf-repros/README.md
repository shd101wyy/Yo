# perf-repros

Standalone repro fixtures for known TS-evaluator perf bugs. Each
sub-directory holds a baseline + a slow form so a fix can be
benchmarked head-to-head without rerunning the full
~8-minute `yo-self/main.yo` compile.

## ts-nested-tostring

Tracks `issues/ts-evaluator-slow-compile-of-nested-tostring-calls.md`.

```
./perf-repros/run.sh ts-nested-tostring
```

Compiles `baseline.yo` and `slow.yo` (each with
`YO_DEBUG_CALL_PROFILE=1`), prints wall time and the top
`tryToCallFunctionWithArguments` callees by self-time, and emits
the delta. A successful fix should shrink `slow.yo`'s self-time
toward `baseline.yo`'s.
