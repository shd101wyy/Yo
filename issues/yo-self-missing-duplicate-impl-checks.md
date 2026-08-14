# yo-self is missing TS's duplicate-impl registration checks — re-registration silently corrupts instead of erroring loudly

**Status: OPEN** (found 2026-08-14 while fixing
issues/fixed/seed-built-stage1-array-fill-method-miss.md).

## The parity gap

When the same impl is registered twice (e.g. the prelude evaluated twice),
the two compilers diverge:

| Site                                        | TS                                                                                                                                                                                                | yo-self                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Generic-impl registry                       | `registerGenericImpl` (src/evaluator/values/impl.ts:1074-1114) scans anonymous impls for a clashing method name on the same receiver base and **throws** "Method X is already defined for type Y" | `register_generic_impl` (yo-self/evaluator/values/impl.yo:344) **appends unconditionally** — no check at all     |
| Direct-impl trait flatten                   | impl.ts:2865-2892: same `sourceModulePath` → **replace** the stale field (harmless re-eval of a cached builtin singleton); distinct module → **throw** the duplicate-method error                 | no `source_module_path` on trait fields anywhere in yo-self — neither the replace path nor the reject path exist |
| Trait-impl duplicate (`checkDuplicateImpl`) | impl.ts:1129+: throws "Trait already implemented for type"                                                                                                                                        | (verify during port — likely also missing)                                                                       |

Consequence: a double evaluation of the prelude in TS dies immediately with
`Method "len" is already defined for type "comptime_str"` — loud, at the
registration site. The same double evaluation in yo-self **succeeds** and
poisons the registries with duplicate entries under re-minted type
identities; the failure then surfaces much later, in an unrelated file, as
`No matching call found` on the first fresh `Array(T,N)` specialization of a
where-constrained impl (the GATE 3 signature). Silent corruption instead of
a loud error at the cause.

## Why it is currently unreachable (but still worth fixing)

The double-evaluation sources were closed by the GATE 3 fix:

- yo-self `mm_load_file` now treats an already-cached prelude as a hit and
  never re-evaluates its body (evaluation-level populate-once).
- TS module-cache keys are canonicalized (`canonicalizeModulePath`), so one
  file under two path spellings shares one cache entry.

So no shipped code path re-registers today. But the checks are what turn a
future regression in this area (a new caller of `mm_load_prelude_file`, an
LSP-style cache invalidation, a vendored second std tree) from a delayed
"weird method-miss three files later" into an immediate, located error.
The faithful-port doctrine applies: TS's mechanism in TS's place.

## Fix sketch

1. Port impl.ts:1074-1114 into `register_generic_impl` — needs an error
   channel (return a violation to the evaluator frame and throw there;
   handlers cannot capture outer runtime vars).
2. Add `source_module_path` to yo-self's trait-field record, thread the
   registering module's path through the attach path, and port the
   replace-or-reject logic of impl.ts:2865-2892.
3. Check `checkDuplicateImpl` (impl.ts:1129) has a yo-self counterpart;
   port if missing.
4. Pin with a differential test: a file that defines the same method for
   the same receiver in two impl blocks must produce the same error under
   both compilers (a `compile-duplicate-method` cli-case).
