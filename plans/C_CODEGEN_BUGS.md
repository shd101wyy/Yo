# C Codegen Bugs

Known C codegen bugs discovered during std library development. These need proper fixes in the codegen — do not work around them in `.yo` files.

---

## Bug 1: `self._field` not captured in match arms

**Status**: Open
**Discovered in**: `std/url/url.yo` — `origin` and `host_port` methods

**Description**: When `self._field` is used inside a `match` arm, the generated C code does not properly capture the field access. The resulting C code references a stale or incorrect variable, causing compilation errors or wrong behavior.

**Workaround** (in `.yo` code — should not be necessary after fix):

```yo
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

**Status**: Open
**Discovered in**: `std/sys/bufio/bufio.yo` — `BufReader.read` method

**Description**: When `io.await(...)` calls are placed inside separate `cond` (if/else) branches within an `io.async` closure, the async state machine C codegen fails. Variables declared inside those branches don't get added to the async state struct, causing C compilation errors like:

```
error: 'state_struct_name' has no member named 'n'
```

**Example**:

```yo
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

**Root cause**: The async state machine generator scans the closure body to collect all variables that need to persist across `io.await` suspension points. When an `io.await` call is inside a `cond` branch, the variable declarations in that branch are not discovered during the scan, so they're missing from the generated C state struct.

**Where to fix**: `src/codegen/effects/` or `src/codegen/exprs/async.ts` — the state machine variable collection pass needs to traverse into `cond`/`match` branches to find all `io.await` calls and their surrounding variable declarations.

---
