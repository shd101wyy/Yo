# Windows rc=139: `main` runs on the default 1 MB stack and `YO_MAIN_STACK_MB` is ignored

**Status: OPEN** (root-caused 2026-08-15 on PR #126, run 31854687362.)

## Symptom

`test (windows-latest)` fails its stage-1 `yo build` **8 seconds in** with
exit **139** (128 + 11 = SIGSEGV), before emitting any C:

```
Building yo a12c337 → yo-out/x86_64-windows-msvc/bin/yo.exe
##[error]yo build failed with exit code 139
--- partial yo-out tree (was any C emitted before the failure?) ---
yo-out/x86_64-windows-msvc/bin:      <- EMPTY, no .c was written
```

The runner is not short of memory (16,379 MB total, 13,686 MB available), and
the job env sets `YO_MAIN_STACK_MB: 4096`.

## Root cause

`src/codegen/functions/generation.ts:996`:

```ts
// Windows / WASM keep the direct main-thread call (no pthread there;
// those targets are not used for the bootstrap workload).
const useWorkerStack = isTargetPosix(context.targetInfo);
```

- **POSIX**: `main` starts a pthread whose stack is sized by
  `__yo_main_stack` — 1 GiB default, overridable at runtime with
  `YO_MAIN_STACK_MB` (`generation.ts:1031-1057`).
- **Windows**: no worker thread at all. `main` calls `__yo_user_main`
  directly, so the program runs on the process's default stack, which on
  Windows is **1 MB** (the PE header's stack reserve). **`YO_MAIN_STACK_MB`
  has no effect whatsoever on Windows** — it is only read inside the
  `useWorkerStack` arm.

AGENTS.md already documents that the self-hosted compiler's deep comptime
recursion needs multi-MB frames and gigabytes of stack. 1 MB is nowhere near
enough, so the seed SEGVs almost immediately — consistent with the 8-second,
zero-output failure.

## Why it appeared now

The comment's own justification — "those targets are not used for the
bootstrap workload" — **stopped being true**. P2.5 step 18 put a full
self-build (`yo build`) on all five `test` matrix legs, Windows included. The
assumption the Windows arm was written under is exactly the assumption step 18
invalidated.

This also explains the older, vaguer Windows rc=139 notes in
`issues/fixed/windows-native-selfhosted-build-fails.md` and the P3 item-4
follow-up: the same missing-stack cause, observed through different symptoms.

## Fix

Give Windows a worker thread with the same configurable stack, so the POSIX
and Windows paths agree and `YO_MAIN_STACK_MB` means the same thing
everywhere:

```c
HANDLE __yo_main_thread = CreateThread(
    NULL, __yo_main_stack, __yo_main_thread_entry, NULL, 0, NULL);
WaitForSingleObject(__yo_main_thread, INFINITE);
```

`CreateThread`'s `dwStackSize` is the direct analogue of
`pthread_attr_setstacksize`. The entry point signature differs
(`DWORD WINAPI (LPVOID)` vs `void* (void*)`), so the emitted entry function
needs a Windows arm — note `src/codegen/parallelism/runtime.ts:28` already does
exactly this dance for `__yo_thread_entry`
(`static unsigned __stdcall` vs `static void*`), so there is a precedent to
copy rather than invent.

Alternative (weaker): set the PE stack reserve at link time
(`-Wl,--stack,<bytes>` for clang/lld, `/STACK:<bytes>` for MSVC). Simpler, but
it bakes the size in and leaves `YO_MAIN_STACK_MB` a no-op on Windows, so the
knob keeps lying. Prefer the thread.

Fix in both compilers (`src/codegen/` and `yo-self/codegen/`).

## The sequencing trap — read before expecting CI to go green

**Fixing codegen does not unblock the Windows CI leg.** The crash is in the
**seed** (v0.2.4), a released binary compiled by the _old_ codegen. A fix
landed today only affects binaries emitted by the _new_ compiler, so the seed
will keep SEGVing on Windows until a release ships that contains this fix and
`SEED_VERSION` is bumped to it.

So the Windows leg cannot perform a seed-driven self-build until at least one
release cycle after this fix lands. Options in the meantime, in preference
order:

1. Land the codegen fix, ship a release, bump `SEED_VERSION` — then the leg
   works. Correct, but not immediate.
2. Raise the stack reserve of the _downloaded seed binary_ in the install-seed
   action for Windows only (`editbin /STACK:` or `llvm-objcopy`-style PE
   patching). Unblocks CI now with an unfixed seed, at the cost of a
   Windows-only step that must be removed later.
3. Accept that the Windows leg does not build stage 1 this cycle, and keep the
   native-Windows build proof in a non-required job until the seed is fixed.

This is a release-ordering decision, not a code decision.
