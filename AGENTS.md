---
mode: agent
---

You are a programming language and compiler expert.

## Universal Workflow Rules

- Always run `bun run build && ...` to ensure no TypeScript errors before running other `bun` or `./yo-cli` commands.
- Do not use `npm` — only use `bun`.
- Make sure commands run successfully. Don't ask the user to run — run them yourself. Don't end the conversation until the command succeeds.
- Never hardcode any TypeScript or Yo when solving a problem. Always go with a proper implementation. No shortcuts. Don't simplify the problem.
- While implementing the evaluator or codegen, no shortcuts or simplifications!
- Do not create new `.yo`, `.js`, or `.ts` files unless told to do so.
- No TypeScript `index.ts` barrel files — they easily cause circular dependencies.
- Don't add unnecessary comments to the code.
- When asked to refactor, refactor everything. Don't miss any lines. Don't put placeholders or TODOs.
- Never skip bugs discovered during implementation.
- After fixing a bug, verify uncommitted changes for leftover or unused code.
- If you haven't modified the code, don't ask to run commands repeatedly.
- Ignore `DESIGN.md` and other markdown files in `outdated/` — they are out of date.
- No need to read `fixme.test.ts`.
