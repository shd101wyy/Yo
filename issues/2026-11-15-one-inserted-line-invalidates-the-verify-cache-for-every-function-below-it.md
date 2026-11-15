# One inserted line invalidates the verify cache for every function below it

**Severity:** S3 — a performance observation: after any edit that shifts lines, every obligation of every function further down the file is solved again, so the "warm" cost of verification is the cold cost for the file being edited.

Filed 2026-11-15 while estimating the cost of
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../plans/backlog/DEFAULT_ON_VERIFICATION.md)
(§2.2). Measured with `yo 0.2.77`, Z3 5.1.0.

## Measurement

A module of 70 small contracted functions under `pragma(Pragma.Verify);`,
verified three times with `yo verify <file> --format json`; the summary's
`queries`, `cached` and `elapsed_ms`:

| Run | Queries | Cached | Solver time |
| --- | --- | --- | --- |
| first | 140 | 0 | 2,737 ms |
| second, file unchanged | 140 | 140 | 14 ms |
| third, after adding one comment line at line 2 | 140 | 0 | 3,253 ms |

Nothing a proof depends on changed between the second and third runs.

## Cause

The cache key is the sha256 of the query's SMT text (`verify_cache_key`,
`src/verifier/driver.yo`). The text names every variable through
`mangle_vc_name(ctx.fn_name, …)` (`src/verifier/vc.yo`), and `fn_name` is the
function id `fn@<path>:<row>`, so a variable is spelled
`__yo_vfn_std_encoding_json_yo_551_b`: the module path and the function's row
are part of every name. A function that moves down one line gets a different
query text and a different key.

The path has the same effect across machines: an entry file given by an
absolute path puts that path in the names (`fn@/tmp/…`), so a cache directory
copied to another checkout location misses.

## Fix

Name the variables of a query independently of where the function sits: by
the function's name within its module, or by an index local to the query,
with the `fn@<path>:<row>` id kept for the report only. The fix belongs to
DEFAULT_ON_VERIFICATION's S4, which also adds a per-function key (§5 item 6
there); a per-function key built from the same position-bearing text would
have this defect too.

## Test

The three-run sequence above as a `tests/internal` case, or a cli-case, over
a fixture of a few contracted functions: the third run must report every
obligation as cached.
