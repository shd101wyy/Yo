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

To test the Yo codegen transpiler, you can run the command `bun run src/yo-cli.ts src/tests/examples/fixme.yo --emit-c --skip-c-compiler` on any `.yo` file to test its C code generation. Then run `clang -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out` to compile the generated `./a.out.c`.

Or you can run `bun run src/yo-cli.ts src/tests/examples/fixme.yo -o a.out && ./a.out` directly to test the full pipeline. Use `--debug-brc` to debug the biased reference counter, and `--debug-concurrency` to debug the concurrency model, and `--debug-async-await` for debugging async/await.

Feel free to run `gdb` on `./a.out` to debug the generated C code.

You can ignore the editor erros for the `.yo` files, because the vscode extension might not use the updated Yo language grammar or evaluator/compiler code.

{ expr } create a struct value. So if there is only one expression, don't use {...}. Use the expr directly.

When I ask you to refactor the code. Refactor everything. Don't make assumptions. Don't miss any lines. Don't put placeholders or TODOs.

Ignore the DESIGN.md and other markdown files because they are out of date.

No need to read fixme.test.ts

If you haven't modified the code, don't ask to run command repeatedly.

Read `LEARN_YO_IN_10_MINUTES.yo` to understand the syntax.

If you havent changed the code, don't ask me to run `bun test ...`

When you are working on the C codegen. Do not call `emitter.emitLine` multiple times when you can just use `emitter.emitLine( multi-line string )`

Don't add unnecessary comments to the code.

For understanding the compile-time reference counting ownership model, please read `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` document.

For understanding the biased reference counting implementation, please read `BIASED_REFERENCE_COUNTING.md` document.

For understanding the concurrency design, please read `CONCURRENCY.md` document. <- Stackful coroutine might be deprecated in favor of async/await
For understanding the async IO, please read `ASYNC_IO.md` document. <- Stackful coroutine might be deprecated in favor of async/await
For understanding the async/await design, please read `ASYNC_AWAIT.md` document.

While making design decisions, don't worry about making breaking changes to the Yo language! It is a new language and it is still evolving. Breaking changes are acceptable.

While implementing the evaluate or codegen, no shortcuts or simplcations!
