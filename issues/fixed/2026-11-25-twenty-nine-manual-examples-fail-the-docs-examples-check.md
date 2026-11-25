# Twenty-nine manual examples fail the docs examples check

**Severity:** S3 — 29 complete-program examples in `docs/en-US` and `docs/zh-CN` (14 en, 15 zh) are rejected by the compiler. A reader or agent who copies one gets an error instead of a working program.

Filed 2026-11-25 by the docs-design-split lane (docs plan PRs 3–5), on develop `f35415952`.

## Reproducer

`scripts/check-docs.py` runs every complete-program ```yo block (one containing `export(`, `test(` or `main ::`) through `yo check`, or `yo test` when it has a top-level `test(`. Each block runs alone in an empty directory against the tree's `std`.

```bash
python3 scripts/check-docs.py --checks examples --yo yo-out/x86_64-unknown-linux-gnu/bin/yo --jobs 6 --report-only
```

```text
examples: 200 program blocks (130 unique) checked, 29 failed; 734 fragments not checked, 50 `yo ignore`
```

The checker was the tree binary built from `6ce55890e`, with `--std-path ./std`. Nothing in the parser, lexer or formatter has changed since. Each line below is page:line of the block's fence, its heading, the oracle, and the first error.

| Block | Heading | Oracle | First error |
| --- | --- | --- | --- |
| `docs/en-US/ASYNC_AWAIT.md:39` | Concurrency vs Parallelism | check | E0401 `Variable "Thread" not found` |
| `docs/zh-CN/ASYNC_AWAIT.md:39` | 并发 vs 并行 | check | E0401 `Variable "Task" not found` (zh text differs from en) |
| `docs/en-US/BUILD_SYSTEM.md:236` | Build Steps | check | E0401 `Variable "build" not found` |
| `docs/zh-CN/BUILD_SYSTEM.md:227` | 构建步骤 | check | E0401 `Variable "build" not found` |
| `docs/zh-CN/CTFE.md:461` | 编译时断言 | test | E0610 `No method "to_string" on Type` (zh only; `Type.to_string(T)`) |
| `docs/en-US/DATA_TYPES.md:456` | Private members | check | E0401 `Variable "String" not found` |
| `docs/zh-CN/DATA_TYPES.md:443` | 私有成员 | check | E0401 `Variable "String" not found` |
| `docs/en-US/MEMORY_SAFETY.md:384` | FFI | check | `Module not found: tried ".../my_ffi.yo"` (imports a sibling file) |
| `docs/zh-CN/MEMORY_SAFETY.md:376` | FFI | check | same |
| `docs/en-US/MODULES.md:10` | Module importing and exporting | check | E0401 `Variable "println" not found` |
| `docs/zh-CN/MODULES.md:9` | 模块的导入和导出 | check | same |
| `docs/en-US/MODULES.md:65` | Anonymous module | check | E0401 `Variable "println" not found` |
| `docs/zh-CN/MODULES.md:59` | 匿名模块 | check | same |
| `docs/en-US/MODULES.md:121` | Definition Order | check | E0401 `Variable "String" not found` |
| `docs/zh-CN/MODULES.md:113` | 定义顺序 | check | same |
| `docs/en-US/SYNTAX.md:25` | Hello World | check | E0610 `No matching call found with arguments` (calls an undefined `ok()`) |
| `docs/zh-CN/SYNTAX.md:24` | Hello World | check | same |
| `docs/en-US/SYNTAX.md:345` | if/else | check | `Defining a macro ... requires 'pragma(Pragma.AllowMacroDef);'` |
| `docs/en-US/TESTING.md:12` | Basic Test Syntax | test | E0401 `Variable "assert" not found` |
| `docs/zh-CN/TESTING.md:12` | 基本测试语法 | test | same |
| `docs/en-US/TESTING.md:54` | Runtime Assertions | test | `Expected "::" instead of ":=" for compile-time known value assignment` |
| `docs/zh-CN/TESTING.md:54` | 运行时断言 | test | same |
| `docs/zh-CN/TESTING.md:76` | 编译时断言 | test | E0610 `No method "to_string" on Type` (zh only; `Type.to_string(T)`) |
| `docs/en-US/TESTING.md:93` | Testing Expected Errors | test | `comptime_expect_error: the expression raised an error, but not the expected one` |
| `docs/zh-CN/TESTING.md:93` | 测试预期错误 | test | same |
| `docs/en-US/TESTING.md:120` | Test Organization | test | E0401 `Variable "assert" not found` |
| `docs/zh-CN/TESTING.md:120` | 测试组织 | test | same |
| `docs/en-US/WASM.md:396` | Testing | check | `Failed to import module "./wasm_api.yo"` (imports a sibling file) |
| `docs/zh-CN/WASM.md:376` | 测试 | check | same |

## Root cause

All 29 blocks predate the docs split. They moved verbatim from `DESIGN.md`, `DEFINITION_ORDER.md` and the other pages in #2065 and #2067, and those PRs added no failing block. The failures fall into four groups:

- **Missing imports (15 blocks).** The block uses `println`, `assert`, `String`, `build` or `Thread` without importing it. It worked when read as part of a larger file, and fails standing alone.
- **Stale code (7 blocks):**
  - the `:=` binding of a compile-time value (TESTING "Runtime Assertions");
  - a `comptime_expect_error` whose expected text no longer matches (TESTING "Testing Expected Errors");
  - the if/else block, which defines a macro without `Pragma.AllowMacroDef`;
  - the Hello World exit example, which calls an `ok()` it never defines.
- **zh drift (3 blocks).** The zh copies of TESTING "编译时断言", CTFE "编译时断言" and ASYNC_AWAIT "并发 vs 并行" differ from en: `Type.to_string(T)`, `Task`. The en blocks pass.
- **Sibling files (4 blocks).** The MEMORY_SAFETY FFI and WASM Testing blocks import a file the example only describes. The checker cannot supply that file, so these blocks become ```` ```yo ignore ```` or get inlined.

## Fix

For each block: add the import, update the stale spelling, or copy the en block into zh. Mark the two sibling-file pairs ```` ```yo ignore ````. Every fix is a docs-only edit.

## Test

The docs examples check, `python3 scripts/check-docs.py --checks examples` (CI job `docs-checks`, report-only until docs plan step 12), lists all 29 blocks today. When fixed it should report `0 failed` for these pages.

## Fix

Fixed on branch `docs/fix-manual-examples`; every edit is in `docs/en-US` and `docs/zh-CN`, in step. `python3 scripts/check-docs.py --checks examples` with a tree binary built from `01673f592` reports `197 program blocks (125 unique) checked, 0 failed`.

- **Missing imports.** ASYNC_AWAIT (`std/thread`), BUILD_SYSTEM (`std/build`), DATA_TYPES (`std/string`), MODULES (`std/fmt`, `std/string`) and TESTING (`std/assert`, `std/sys/timer`) import what they use.
- **DATA_TYPES "Private members"** is two files in one block. It is now two blocks: `counter.yo` is checked, the `app/main.yo` importer is a fragment.
- **MODULES "Module importing and exporting"** exported an `Option` that collides with the prelude's. The type is `Maybe`, and the import fragment names `module1.yo` and `module2.yo`. MODULES "Definition Order" defines the `Greeter` trait its `impl` needs, and takes `&Dog` / `&Self` receivers.
- **Stale code.** TESTING "Runtime Assertions" builds its array from `i32` values (`arr := [1, 2, 3]` is a comptime array, which `:=` rejects); "Testing Expected Errors" asserts the closure case through `Impl(Fn(...))` and the `Cannot reassign variable` message; SYNTAX Hello World defines the `ok()` it calls; SYNTAX if/else is split into the prelude definition (`yo ignore`: it redefines `if` and needs `Pragma.AllowMacroDef`) and a checked usage block.
- **zh drift.** ASYNC_AWAIT "并发 vs 并行" carries en's `Thread(unit).spawn` example; CTFE and TESTING "编译时断言" use `Type.to_comptime_string(T)`; zh SYNTAX if/else and `while` match en.
- **Sibling files.** MEMORY_SAFETY FFI and WASM Testing are `yo ignore`, each with a sentence saying the block needs its companion file. The alternative, teaching `check-docs.py` to supply a sibling, needs a naming convention for which earlier block is which file and is the larger change.
