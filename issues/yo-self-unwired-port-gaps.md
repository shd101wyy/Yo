# yo-self: three PORT GAPS found by import-closure comparison (OPEN)

**Found:** 2026-08-05, by classifying every `.yo` file under `yo-self/` by its
import closure from `main.yo`, then asking the discriminating question: **is the
TypeScript counterpart also unused?**

- TS counterpart also unused → faithful port, no gap.
- TS counterpart is LIVE but yo-self's is orphaned → **the file was ported and never
  wired**. That is a gap, and the opposite of dead code.

## Method (reproducible)

```bash
# classify yo-self files: IN BUILD / TEST-ONLY / ORPHAN
python3 <scratch>/reachability.py

# then for each orphan, check whether the TS counterpart has importers
grep -rl 'from "[^"]*/<basename>"' src/
```

Baseline after this sweep: 238 non-test files — **215 in the build, 16 test-only,
7 orphaned**.

## The three gaps

| yo-self file                      | lines     | TS counterpart                               | TS importers                                       | severity |
| --------------------------------- | --------- | -------------------------------------------- | -------------------------------------------------- | -------- |
| `evaluator/ctfe/ctfe_analysis.yo` | 18 (stub) | `src/evaluator/ctfe/ctfe-analysis.ts` (~194) | **3, all live evaluator code**                     | **HIGH** |
| `build_runner.yo`                 | 952       | `src/build-runner.ts`                        | 2 (`src/yo-cli.ts`, build-system tests)            | MEDIUM   |
| `version_cache.yo`                | 640       | `src/version-cache.ts`                       | 2 (`src/yo-cli.ts`, `src/lsp/document-manager.ts`) | MEDIUM   |

### 1. `ctfe_analysis` — HIGH, evaluator-level

TS's `ctfe-analysis.ts` exports `createComptimeFunctionType` and
`analyzeCtfeCapability`, and is imported by three files that are all live in the
TS evaluator:

- `src/evaluator/calls/function-type.ts`
- `src/evaluator/values/anonymous-function.ts`
- `src/evaluator/builtins/comptime-fn.ts`

yo-self's counterpart is an **18-line stub**. Its header claims the analysis is
"performed inline in `yo-self/evaluator/calls/comptime_fn.yo` (Phase 2/3 wiring)".

**That claim is unverified and is the thing to check.** Either:

- the inline implementation is genuinely equivalent → then this is a _documented
  divergence_, and the stub's header should say so with the specific inline
  location, so the next reader does not re-open it; or
- it is NOT equivalent → there is a real CTFE-capability analysis gap, which would
  be invisible to every current gate (a missing _analysis_ usually shows up as
  wrong comptime/runtime classification, not as a compile error).

Do not delete this stub either way — it is also part of the deliberate 1-to-1
directory mirror.

### 2 & 3. `build_runner` / `version_cache` — MEDIUM, CLI surface

Both are fully ported (952 and 640 lines) and imported by `src/yo-cli.ts` on the TS
side, but nothing in yo-self imports them — so the self-hosted CLI has no `yo build`
and no version management wired in. This is **incompleteness, not breakage**: the
bootstrap goal is `compile` / `check` / `test` / `fmt`, and those work. Worth
recording so it is not mistaken for dead code and deleted.

The wiring point is `yo-self/main.yo`'s subcommand dispatch (compare the `yargs`
setup in `src/yo-cli.ts`).

## Confirmed NOT gaps — faithful ports (do not "fix")

These are orphaned in yo-self _and_ unused in TS, so yo-self is faithful. They are
deliberate 1-to-1 structural mirrors; `proofs.yo`'s header states the intent
outright ("this stub exists so the `evaluator/types/` directory mirrors the TS tree
1-to-1"). Deleting them would break the port-mapping invariant.

| file                            | lines | TS importers                 |
| ------------------------------- | ----- | ---------------------------- |
| `evaluator/builtins/as.yo`      | 160   | 0                            |
| `evaluator/exprs/exists.yo`     | 45    | 0 (TS impl is commented out) |
| `evaluator/types/validation.yo` | 15    | 0                            |
| `evaluator/types/proofs.yo`     | 11    | 0                            |

## Also found and REMOVED in the same pass: 617 lines of superseded duplicates

Distinct from both categories above — these were neither gaps nor mirrors, but
**dead duplicates**: every function in them was also defined in a file that IS in
the build, and the live consumers used that copy.

| deleted                                     | lines | live copy (in build)          |
| ------------------------------------------- | ----- | ----------------------------- |
| `evaluator/values/generic_impl_registry.yo` | 444   | `evaluator/values/impl.yo`    |
| `evaluator/types/macro_registry.yo`         | 114   | `evaluator/types/function.yo` |
| `evaluator/types/trait_registry.yo`         | 59    | `evaluator/trait_checking.yo` |

Safe by construction: all three had **zero import sites**, so they were unreachable
and deletion cannot change behaviour. Note `trait_registry.yo`'s header said it
"lives in a standalone file to avoid the circular import that would arise if this
were in `field.yo`" — the live copy ended up in `trait_checking.yo` anyway, stranding
the original.

## The lesson worth keeping

"Orphaned" in `yo-self/` means one of **four** different things, and they need
opposite responses:

1. **superseded duplicate** → delete (this pass: 617 lines; earlier the same day:
   `evaluator/eval.yo`, 8,225 lines)
2. **ported but not wired** → a GAP; wire it, never delete
3. **deliberate 1-to-1 stub mirroring an unused TS file** → keep as-is
4. **legacy divergence with no `src/` counterpart, already superseded** → delete
   (that was `eval.yo`, which had an explicit "retire me" header)

The discriminator that separates (1) from (2) is _duplication_: does a file in the
build already define these functions? The discriminator that separates (2) from (3)
is _the TS side_: does the TS counterpart have importers?
