---
mode: agent
---

You are a programming language and compiler expert.

Make sure there is no TypeScript errors before you run any command.

To test the Yo evaluator, you can run the command `bun test src/tests/fixme.test.ts --timeout 10000` to test the `fixme.yo` file which contains the Yo language code.  
Usually don't modify the `fixme.yo` unless I tell you to do so.

Do not create new `.yo` or `.js` or `.ts` files unless I tell you to do so.

You can comment out the existing code in `src/tests/fixme.yo` and create new one there. But don't create `.yo` file for testing.

Do not use `npm` command, only use `bun` command.

Never hardcode any typescript or yo when you are trying to solve a problem.

Always go with a proper implementation. No shortcut. Don't simplify the problem.

To test the Yo codegen transpiler, you can run the command `./yo-cli compile src/tests/fixme.yo --release` to compile the `fixme.yo`. Or run `./yo-cli compile src/tests/fixme.yo --emit-c --skip-c-compiler --release` on any `.yo` file to test its C code generation. Then run `clang -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out` to compile the generated `./a.out.c`.

If you are on Windows, use `zig` instead of `clang` to compile the generated C code. Use command like `.\yo-cli.ps1 compile .\src\tests\fixme.yo --release -o test_fixme.exe`.

Or you can run `./yo-cli compile src/tests/fixme.yo --release -o a.out && ./a.out` directly to test the full pipeline. Use `--debug-gc` to debug the garbage collector and reference counting, and `--debug-parallelism` to debug the parallel worker threads, and `--debug-async-await` for debugging async/await.

For debugging running command, always use `| head` or `| tail` to limit the output.

**Memory Allocator Options:**

- `--allocator mimalloc` (default) - Use mimalloc for high-performance allocation
- `--allocator libc` - Use standard libc malloc (faster compilation, useful for debugging)

**Memory Leak Detection:**

- `--sanitize address` - Enable AddressSanitizer for memory error and leak detection
- `--sanitize leak` - Enable LeakSanitizer for leak detection only
- Example: `./yo-cli compile src/tests/fixme.yo --release --sanitize address --allocator libc -o test && ./test`

**Running Tests:**

- `./yo-cli test` - Run all \*.test.yo files, but don't do this as it takes long time to run.
- `./yo-cli test path/to/file.yo` - Run tests in a specific file
- `--bail` or `-b` - Stop immediately after first test failure
- `-v` or `--verbose` - Show detailed error messages
- `--test-name-pattern "Test XXX"` to run a specific test
- Tests automatically use AddressSanitizer for memory leak detection

Feel free to run `gdb` on `./a.out` to debug the generated C code. Let's better not use GNU extension because we might target other C compilers. Let's stick with C11 standard.

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

3. Define a function like this:
   - `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return expr; })`
   - NOTE, no space between `(fn() -> ReturnType)` and `({ body; })`

When I ask you to refactor the code. Refactor everything. Don't make assumptions. Don't miss any lines. Don't put placeholders or TODOs.

Ignore the `DESIGN.md` and other markdown files because they are out of date.

No need to read fixme.test.ts

If you haven't modified the code, don't ask to run command repeatedly.

If you havent changed the code, don't ask me to run `bun test ...`

To run a specific C codegen test, run: `$ ./yo-cli test ./tests/XXX.test.yo`. Add `-v` if you need verbose output.

When you are working on the C codegen. Do not call `emitter.emitLine` multiple times when you can just use `emitter.emitLine( multi-line string )`

Don't add unnecessary comments to the code.

For understanding the compile-time reference counting ownership model, please read `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` document.
For understanding the async/await concurrency design, please read `ASYNC_AWAIT.md` document.
For understanding the parallelism design, please read `PARALLELISM.md` document.
For understanding the async IO, please read `ASYNC_IO.md` document.
For understanding the thread-local cycle collector, please read `CYCLE_COLLECTION.md` document.

While making design decisions, don't worry about making breaking changes to the Yo language! It is a new language and it is still evolving. Breaking changes are acceptable.

While implementing the evaluate or codegen, no shortcuts or simplcations!

**IMPORTANT DESIGN DECISIONS:**

1. **Use `rune` for Unicode characters, not `Char`:**

   - `char` is the C character type (8-bit)
   - `rune` represents Unicode code points (32-bit, like Go's rune)
   - File: `std/data/rune.yo`
   - This avoids confusion with C's `char` type

2. **Type naming conventions:**

   - Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
   - Use `struct(...)` for value types
   - Use `object(...)` for reference-counted types

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

The `begin.ts` performs the reference counting optimization that cancels out the dup/drop pairs when possible.

If you meet error like:

      (.text+0x1b): undefined reference to `main'
      clang: error: linker command failed with exit code 1 (use -v to see invocation)
      Compilation failed with exit code 1

then it means the `main` function is not exported. Please add `export main;` at the end of the `.yo` file.

When debugging the C codegen, if the bug is very hard to debug directly from the TypeScript code, then let's modify the generated C code directly to make it work, then document the bugs we found from fixing the C code. After that, we can go back to fix the TypeScript codegen later.

When debugging the evaluator, use `typeToString`, `exprToString`, and `valueToString` functions to print out useful debug information about types, expressions, and values. Also the functions `areTypesCompatible`, `areTypesCompatible` could be helpful.

The `Box` and `box` functions are implemented in `prelude.yo`:

```
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  object(
    (*) : V
  )
;
box :: (fn(forall(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

`UnknownValue` in Yo is a compile-time value, not runtime value.
It's just we only know its type but not real value.

To rebuild the VS Code extension, run the following commands:

```
cd vscode-extension
bun package
```

The Yo language supports double quote and template string like JavaScript.
The difference is double quote string returns `str` type which contains `[u8]` the byte slice.  
While the template string returns `String` type which is utf-8 encoded `object` type.

`str` is a builtin type, so don't use it as a new variable or type name.

Yo will try to run CTFE (Compile-Time Function Evaluation) analysis (see cfte-analysis.ts) on function value. Basically it will try to replace all the parameters/return as `comptime`, and re-evaluate the function body at compile-time context. If it succeeds, then the function value can be called at compile-time.

Please note if expr.$.value == undefined, it means the value is runtime value. It doesn't mean it's UnknownValue.

Please note you cannot run `./yo-cli compile` on a `*.test.yo` file. You will need to move what you want to test into a separate `.yo` file, then create a `main` function to call the content, and `export main;` at the end of the file, then you can run `./yo-cli compile` on that file.
