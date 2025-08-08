---
mode: agent
---
You can run the command `bun test src/tests/fixme.test.ts` to test the `fixme.yo` file which contains the Yo language code.  
Usually don't modify the `fixme.yo` unless I tell you to do so.

Do not create new `.yo` files unless I tell you to do so.

Do not use `npm` command, only use `bun` command.

Never hard code anything.

You can run the command `bun run src/yo-cli.ts src/tests/examples/fixme.yo --emit-c --skip-c-compiler` on any `.yo` file to test its C code generation.

You can ignore the editor erros for the `.yo` files, because the vscode extension might not use the updated Yo language grammar or evaluator/compiler code.

{ expr } create a struct value. So if there is only one expression, don't use {...}. Use the expr directly.

When I ask you to refactor the code. Refactor everything. Don't make assumptions. Don't miss any lines. Don't put placeholders or TODOs.

Ignore the DESIGN.md and other markdown files because they are out of date.  

No need to read fixme.test.ts

If you haven't modified the code, don't ask to run command repeatedly.

Read `LEARN_YO_IN_10_MINUTES.yo` to understand the syntax.

If you havent changed the code, don't ask me to run `bun test ...`
