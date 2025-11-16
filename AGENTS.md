---
mode: agent
---

You are a programming language and compiler expert.

To test the Yo evaluator, you can run the command `bun test src/tests/fixme.test.ts` to test the `fixme.yo` file which contains the Yo language code.  
Usually don't modify the `fixme.yo` unless I tell you to do so.

Do not create new `.yo` files unless I tell you to do so.

Do not use `npm` command, only use `bun` command.

Never hardcode any typescript or yo when you are trying to solve a problem.

Always go with a proper implementation. No shortcut. Don't simplify the problem.

To test the Yo codegen transpiler, you can run the command `bun run src/yo-cli.ts compile src/tests/examples/fixme.yo` to compile the `fixme.yo`. Or run `bun run src/yo-cli.ts compile src/tests/examples/fixme.yo --emit-c --skip-c-compiler --release` on any `.yo` file to test its C code generation. Then run `cc -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out` to compile the generated `./a.out.c`.

Or you can run `bun run src/yo-cli.ts compile src/tests/examples/fixme.yo -o a.out --release && ./a.out` directly to test the full pipeline.
Use `--debug-gc` to debug the garbage collector, `--debug-concurrency` to debug the concurrency model, and `--debug-async-await` for debugging async/await.

Feel free to run `gdb` to debug the generated C code. Let's better not use GNU extension because we might target other C compilers. Let's stick with C11 standard.

You can ignore the editor erros for the `.yo` files, because the vscode extension might not use the updated Yo language grammar or evaluator/compiler code.

**CRITICAL SYNTAX RULES:**

1. **Curly braces `{...}` behave differently based on separators:**
   - `{ expr }` without semicolons creates an **anonymous struct value**, NOT a block!
   - `{ expr; }` with semicolons creates a **begin block** (sequence of statements)
   - **Rule:** If you want a single expression, write `expr` directly. Don't wrap it in `{...}` unless you need a struct.
   - **Example:** 
     ```yo
     // WRONG - creates a struct:
     result := { .Ok(()) }
     
     // CORRECT - just the expression:
     result := .Ok(())
     
     // CORRECT - begin block with statements:
     result := { x := 1; y := 2; .Ok(()) }
     ```

2. **Always write `cond(...)` and `match(...)` with parentheses:**
   - `cond(...)` - NOT `cond ...`
   - `match(...)` - NOT `match ...`
   - The parentheses are **required** and must not be omitted.

When I ask you to refactor the code. Refactor everything. Don't make assumptions. Don't miss any lines. Don't put placeholders or TODOs.

Ignore the DESIGN.md and other markdown files because they are out of date.

No need to read fixme.test.ts

If you haven't modified the code, don't ask to run command repeatedly.

Read `LEARN_YO_IN_10_MINUTES.yo` to understand the syntax.

If you havent changed the code, don't ask me to run `bun test ...`

When you are working on the C codegen. Do not call `emitter.emitLine` multiple times when you can just use `emitter.emitLine( multi-line string )`

Don't add unnecessary comments to the code.

For understanding the garbage collection design, please read `GC_DESIGN.md` document.

For understanding the concurrency design, please read `CONCURRENCY.md` document. <- Stackful coroutine might be deprecated in favor of async/await
For understanding the async IO, please read `ASYNC_IO.md` document. <- Stackful coroutine might be deprecated in favor of async/await
For understanding the async/await design, please read `ASYNC_AWAIT.md` document.

While making design decisions, don't worry about making breaking changes to the Yo language! It is a new language and it is still evolving. Breaking changes are acceptable.

While implementing the evaluate or codegen, no shortcuts or simplcations!

**IMPORTANT DESIGN DECISIONS:**

1. **Use `rune` for Unicode characters, not `Char`:**
   - `char` is the C character type (8-bit)
   - `rune` represents Unicode code points (32-bit, like Go's rune)
   - File: `std/data/rune.yo`
   - This avoids confusion with C's `char` type

2. **Type naming conventions:**
   - Lowercase for value types (stack-allocated): `rune`, `i32`, `u32`, `boolean`
   - Use `struct(...)` for value types (stack-allocated, copied)
   - Use `object(...)` for GC-managed heap types (garbage collected)

3. **No operator precedence:**
   - Always use parentheses to group operations: `((a + b) * c)` not `a + b * c`
   - Example: `((value <= 0x10FFFF) && ((value < 0xD800) || (value > 0xDFFF)))`

4. **Method definitions in struct:**
   - Use double parentheses: `method :: ((fn(self: Self) -> ReturnType) body)`
   - Use `Self` instead of the type name in method signatures
   - Constants and methods are all part of the struct definition

5. **Use `cond(...)` not `if`:**
   - Always write `cond(condition => result, true => default)`
   - Parentheses are required around `cond(...)`

6. **Use `boolean` not `bool`:**
   - The boolean type is spelled `boolean` in Yo


If you meet error like:

      (.text+0x1b): undefined reference to `main'
      clang: error: linker command failed with exit code 1 (use -v to see invocation)
      Compilation failed with exit code 1

then it means the `main` function is not exported. Please add `export main;` at the end of the `.yo` file.

If you meet error like:

      error: Unhandled function call: XXX()

then it means the function `XXX` is not type collected correctly.

When debugging the C codegen, if the bug is very hard to debug directly from the TypeScript code, then let's modify the generated C code directly to make it work, then document the bugs we found from fixing the C code. After that, we can go back to fix the TypeScript codegen later.