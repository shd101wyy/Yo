# DESIGN.md collection and error-handling examples use API spellings that no longer exist

**Severity:** S3 — a documentation defect: a reader who copies a `HashMap`, `HashSet` or `Result` example from `docs/*/DESIGN.md` gets type errors instead of the behavior the comments describe.

**Status:** open. Found 2026-10-24 while rewriting the `LinkedList` section for P6 (that section is fixed in the same branch, `vbd/p6-linked-list-raw-nodes`).

## What is stale

Checked against `std/` on develop `d90303ab4`:

- **`.Error(...)` arms.** `Result` is `enum(Ok(value), Err(error))` (`std/prelude.yo`), but `docs/en-US/DESIGN.md` matches or builds `.Error(...)` 6 times and `docs/zh-CN/DESIGN.md` 6 times: in the HashMap, HashSet and error-handling (`safe_div`) examples, among others.
- **`HashMap.insert`** returns `Option(V)` (the old value), not a `Result`, so the example's `.Ok(opt)` match is a type error.
- **`HashSet.insert`** returns `bool`, not `Result(bool, _)`. **`HashSet.contains`/`remove`** take `&T`, so `set.contains(i32(42))` passes a value where a borrow is required. **`union`/`is_subset`** take `&Self`.
- The examples call `printf` bare. Calling an extern C function needs `unsafe(...)` at the call site, so even a correct example does not compile when copied.

## Fix

Rewrite each example against the current signatures in both languages, matching `.Err` and lending with `&`. The DESIGN.md Markdown `yo` blocks are formatted but not compiled by CI, so check each rewritten block by compiling it in a scratch file (`tmp/`) with a `main`. The other DESIGN.md example defect is `issues/2026-10-23-design-md-examples-write-locals-declared-without-mut.md`; both can be fixed in one pass.
