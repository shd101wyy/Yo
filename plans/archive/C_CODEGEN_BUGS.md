# C Codegen Bugs
> **ARCHIVED 2026-09-04 — BUG LEDGER, CLOSED.** Every entry below is fixed
> (TS-era; later codegen bugs are tracked in issues/fixed/).


Known C codegen bugs discovered during std library development. These need proper fixes in the codegen — do not work around them in `.yo` files.

---

## Bug 1: `self._field` not captured in match arms

**Status**: Fixed
**Discovered in**: `std/url/url.yo` — `origin` and `host_port` methods

**Description**: When `self._field` is used inside a `match` arm, the generated C code does not properly capture the field access. The resulting C code references a stale or incorrect variable, causing compilation errors or wrong behavior.

**Workaround** (in `.yo` code — should not be necessary after fix):

```rust
// BROKEN — self._scheme not properly captured inside match arm:
origin : (fn(self: Self) -> String)(
  match(self._scheme,
    .Http => `http://${self.host_port()}`,
    .Https => `https://${self.host_port()}`,
    _ => `${self._scheme_raw}://${self.host_port()}`
  )
)

// WORKAROUND — capture in local variable first:
origin : (fn(self: Self) -> String)({
  scheme := self._scheme;
  scheme_raw := self._scheme_raw;
  hp := self.host_port();
  match(scheme,
    .Http => `http://${hp}`,
    .Https => `https://${hp}`,
    _ => `${scheme_raw}://${hp}`
  );
})
```

**Root cause**: The codegen emits code that assumes `self` field accesses inside match arms resolve correctly, but the match arm code generation may emit the access in a context where `self` is not in scope or has been shadowed.

**Where to fix**: `src/codegen/exprs/` — match arm code generation

---

## Bug 2: `io.await` inside `cond` branches breaks async state machine

**Status**: Fixed
**Discovered in**: `std/sys/bufio/bufio.yo` — `BufReader.read` method

**Description**: When `io.await(...)` calls are placed inside separate `cond` (if/else) branches within an `io.async` closure, the async state machine C codegen fails. Variables declared inside those branches don't get added to the async state struct, causing C compilation errors like:

```
error: 'state_struct_name' has no member named 'n'
```

**Example**:

```rust
// BROKEN — io.await in separate cond branches:
io.async((using(io)) => {
  cond(
    condition1 => {
      n := io.await(IO_file.read(fd, buf, len));  // 'n' not added to state struct
      // ...
    },
    true => {
      // another branch
    }
  );
})
```

**Root cause**: The `nameFrameToOriginalId` map in `suspension-analysis.ts` uses `name:frameLevel` as a key. When two independent variables with the same name exist in different sequential `cond` expressions at the same frame level, the second variable is incorrectly remapped to the first via `variableIdRemapping` instead of being added as its own entry in `capturedVariables`. This causes the second variable's state struct field to be missing in the generated C code.

**Fix**: Save and restore `nameFrameToOriginalId` in `handleBranchingExpr()` so that variables declared inside cond/match branches don't leak into subsequent cond/match expressions. This preserves correct SSA rename behavior (same variable reassigned across scope boundaries shares one field) while preventing independent variables in sibling scopes from being conflated.

**Where fixed**: `src/evaluator/shared/suspension-analysis.ts` — `handleBranchingExpr()` function

---

## Bug 3: `break` inside `cond` arm in async `while` loop is silently ignored

**Status**: Fixed
**Discovered in**: `std/fs/file.yo` — `File.read_all`, `std/sys/bufio/buf_reader.yo` — `BufReader.read_all`

**Description**: When `break` is used inside a `cond` arm within a `while runtime(true)` loop inside an `io.async` closure, the `break` is silently ignored. The loop continues infinitely instead of terminating.

This only affects **async** code (state machine codegen). Non-async `break` in `cond` (e.g., in `std/string/string.yo`) works correctly.

**Root cause**: In `src/codegen/exprs/atom.ts`, when `smWhileBreakInfo` is set (indicating we're inside an async while loop's state machine), the `break` atom was returning a compound string like `"{ sm->while_loop_0_active = false; goto after_while_loop_0; }"`. However, `src/codegen/exprs/cond.ts` detects control flow via checks like `valueCode === "break"` and `valueCode.startsWith("goto")` — neither matches the compound `{ ... }` format. Since the cond's result type is `unit`, the code was silently dropped.

**Fix**: Changed `atom.ts` to emit `sm->while_loop_X_active = false;` as a side effect via the emitter, and return a simple `goto label` string. This allows `cond.ts`'s `valueCode.startsWith("goto")` check to properly detect and emit the break-as-goto.

**Where fixed**: `src/codegen/exprs/atom.ts` — break handling when `smWhileBreakInfo` is set

---

## Bug 4: `break`/`continue` inside `match` arm in async `while` loop generates invalid C

**Status**: Fixed
**Discovered in**: Testing `break`/`continue` in tagged union `match` inside `io.async` `while` loop

**Description**: When `break` or `continue` is used as a match arm body inside a tagged union (e.g., `Option`) `match` expression within an async `while` loop, the generated C code assigns a `goto` statement to a temp variable:

```c
// BROKEN — invalid C:
_temp_17353 = goto after_while_loop_0;   // break
_temp_17420 = goto while_loop_0_continue; // continue
```

This only affects **tagged union match** (which uses `switch` on `.tag` with temp variable assignment). Simple enum match and `cond` expressions correctly detect control flow via `startsWith("goto")` checks.

**Root cause**: In `src/codegen/exprs/match.ts`, 9 sites where `bodyCode` is assigned to `tempVariableName` did not check for control flow statements (`goto`, `break`, `continue`, `return`). When `break`/`continue` in an async while loop generates a `goto label` string (after Bug 3 fix), the match codegen blindly assigns it to the temp variable instead of emitting it as a standalone statement.

**Fix**: Added `isControlFlowCode()` helper function that checks for `goto`, `break`, `continue`, and `return` patterns. Updated all 9 sites (7 tagged union match + 2 nullable pointer match) to skip temp variable assignment when the body code is a control flow statement, emitting it directly instead.

**Where fixed**: `src/codegen/exprs/match.ts` — all `bodyCode`-to-`tempVariableName` assignment sites

---
