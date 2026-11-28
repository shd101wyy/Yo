# Error diagnostics — codes, `yo explain`, and machine-readable output

Yo's error channel is designed for both humans and the agents that iterate on
compiler feedback. Every error the compiler reports is a structured
diagnostic: a severity, a message, an exact source span, an optional error
code, and an optional help hint — rendered in whichever format the consumer
asks for.

## The render formats

The default (human) format is rustc-shaped — one block per entry, entry 0 is
the primary error, later entries are notes:

```bash
$ yo check ./src
error[E0401]: Variable "undefined_fn_xyz" not found.
 --> src/main.yo:12:5
  |
1 |   undefined_fn_xyz();
  |   ^^^^^^^^^^^^^^^^^^
help: run `yo explain E0401` for more information
```

`--error-format` selects the rendering. It is a **global** flag — it goes
before the subcommand — and the `YO_ERROR_FORMAT` environment variable sets
the same thing at lower precedence:

```bash
yo --error-format short check ./src     # one line per entry
yo --error-format json compile app.yo   # machine-readable
YO_ERROR_FORMAT=json yo build           # same, via the environment
```

- `human` (default) — the block render above.
- `short` — `path:row:col: error[CODE]: message`, grep-friendly.
- `json` — one JSON object per diagnostic, 0-based positions, plus the human
  render under `rendered` so a single consumer can show either:

```json
{
  "severity": "error",
  "code": "E0401",
  "message": "Variable \"undefined_fn_xyz\" not found.",
  "span": { "file": "src/main.yo", "row": 11, "col": 2, "end_col": 19 },
  "rendered": "error[E0401]: ..."
}
```

- `sarif` — the whole diagnostic group as one [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
  2.1.0 log on stdout: codes become driver rules, positions are 1-based per
  the SARIF spec, and a mechanical repair becomes a `fixes` entry — the
  field GitHub code scanning and most CI lint pipelines ingest. Never
  colored, whatever `--color` says.

`--json-summary` (accepted by the test/check drivers) additionally prints the
final `N passed / M failed` style footer as one machine-readable line, so a
harness can parse the outcome without scraping prose.

### Color

The human render colors its output when it is writing to a terminal: the
severity header and its carets carry the severity color (red/yellow/cyan),
the `-->` anchor and gutter carry blue, and `help:` labels magenta. It is a
**global** flag like `--error-format`, with the `YO_COLOR` environment
variable at lower precedence:

```bash
yo --color always check ./src    # force color even into a pipe
yo --color never check ./src     # force plain text
YO_COLOR=always yo build         # same, via the environment
```

`auto` (the default) colors only when stderr is a terminal, `NO_COLOR` is
unset (https://no-color.org), and `TERM` is not `dumb`; an explicit
`--color always` overrides all three. `short` output stays plain — it exists
for grepping — and `json` output never carries ANSI escapes, including the
human text embedded in its `rendered` field, so a machine consumer gets
byte-identical payloads whatever `--color` says. `yo lsp` ignores the flag:
protocol frames are a data channel.

### Repairs and `yo fix`

A diagnostic carries a `repair` when exactly ONE edit fixes it; the compiler
never guesses between alternatives, so a message that names two possible fixes
carries none. In the JSON render the field is
`{ "file", "row", "col", "end_col", "replacement", "description" }` (0-based,
rune columns; `col == end_col` is an insertion) — the same edit `yo fix <path>`
applies, formatting each file it rewrites and re-running until a pass changes
nothing. `yo fix --dry-run` prints the repairs without writing.

The repairs the compiler computes today:

| diagnostic | repair |
| --- | --- |
| E0401 name not found, one close candidate in scope | rename the token (`countr` → `counter`) |
| E0401 name not found, exported by exactly one std module | insert `{ name } :: import("std/…");` above the first non-comment line (the help names the module; two exporting modules, or a rename candidate as well, give help only) |
| E0007 `{ a, b }`, `{ k : v }` as a value — a bare expression brace is a block | insert `.` before the `{` (the record `.{ … }`) |
| E0007 `.{ a } := s`, `.V(.{ x })` in a pattern — a dot on the binding side | delete the `.` |
| E0007 `.{ a; b }` — a dotted block | delete the `.` |
| E0618 a named callable passed bare into a `Dyn(Fn(...))` slot | erase the name over the pointer the slot takes: `run(f)` → `run(dyn(Box.new(f)))` (`dyn(Rc.new(f))` for an `Rc`, `dyn(&f)` for a reference; a longer value gives help only) |
| E0620 `dyn(v)` of a named plain value | box it: `dyn(v)` → `dyn(Box.new(v))` (a longer value gives help only) |
| `Module not found` for an import whose kebab-case spelling reaches exactly one module | rewrite the import string to that spelling (`./string_util.yo` → `./string-util.yo`); segment-wise `_` → `-` and lower case, no other guess. Several matches, or none for a path that breaks the naming rule, give help only |

`yo fix <path>... --module-names` applies the naming rule for module files and directories (a `.yo` file, a
directory and a `[modules]` key are kebab-case, see the Naming Convention in
`SYNTAX.md`). Every `.yo` file or directory under the paths whose name holds
`_` or an upper-case letter is renamed to its kebab-case spelling (`_` written
`-`, upper case lowered, a leading or trailing `-` dropped:
`array_list.yo` → `array-list.yo`, `_fsm.yo` → `fsm.yo`), and everything that
resolves to it is rewritten: every `import("…")` string, resolved as the
compiler resolves it (so `./foo_bar.yo`, `../foo_bar`, `pkg/foo_bar`,
`std/…/foo_bar` when std is one of the paths, and a directory module
`foo_bar/index.yo` all move), the `[modules]` keys and values of the
`yo.toml` above the paths, and the `root : "…"` paths of `build.yo` files.
The rename map is printed (`fix: rename old -> new`, and
`[modules] old -> new` for a key, which renames an import name downstream
packages use), so a downstream package can apply it. An import that no longer
resolves (a std or dependency module renamed upstream) is pointed at the one
module its kebab-case spelling reaches, the same candidate the error's repair
names; several candidates are listed and left as written. So a package
whose dependency renamed a module runs `yo fix . --module-names` once. `--dry-run` prints the
map and writes nothing. A name whose new spelling already exists (`foo_bar.yo`
beside `foo-bar.yo`: `-` and `_` are different names), or two names that
become one, refuse the whole run before anything is written. A case-only
rename moves through a temporary name, so case-insensitive filesystems see it.
cli-case fixtures, `tests/origins/corpus` and `issues/repros` are left alone,
and a second run renames nothing. Strings the compiler cannot see as a module
path (a path in a comment, a shell script or a test's string literal) are
not rewritten.

A module-level or `thread_local` runtime binding is immutable (Rust's
`static`) unless its name is wrapped in `mut(...)` (`static mut`). Writing an immutable global is E0917: reassigning it, writing a field or
element of a value it holds, lending a place of that value as `&mut`, or
calling a `&mut self` method on it. A write through a door the
global holds (`r.with_mut(...)` on a `RefCell`, the door types of
`std/sync`) is not a write of the binding and needs no marker; only
reassigning the binding does.
The marker goes on the declared name: `mut(G) := v`, `(mut(G) : T) = v`,
`thread_local(mut(G))`.

Lending a `mut(...)` global, or a
place under it, to a call (a `&`/`&mut` argument, a borrowed receiver, an
operand its operator borrows, an interpolated value) is E0916, because the
callee could reach the global by name, or await while another task writes it,
and the borrow would then change under it. Read it into a local first
(`v := G; f(&v)`) and write it back after a `&mut` call. A `String`, a
collection or a value holding one is read with `v := G.clone()`: the receiver
of a `clone()` whose every `Clone` impl is derived or std's is the one lend
allowed, since that clone runs no user code. An unmarked global
is lent freely. A door the global holds (`G.with_mut(...)` on a `RefCell`, the
door types of `std/sync`) lends nothing past its closure, so no lend reaches the
storage behind it while the door is written.

The same rule applies below module level: a local,
a pattern or destructuring binding and a compile-time binding (`x :: v`,
`comptime(x) := v`) are immutable unless the name is wrapped in `mut(...)`.
Writing an unmarked one is E0917, for the same four writes (a reassignment, a
field or element write of its value, a `&mut` lend of a place of it, including
`y := &mut x`, a `&mut` match scrutinee and a `&mut` capture, and a `&mut self`
call on it), and `yo fix <path>` repairs it by wrapping the declared name:
`x := v` becomes `mut(x) := v`, `(x : T) = v` becomes `(mut(x) : T) = v`,
`x :: v` becomes `mut(x) :: v`, `comptime(x)` becomes `comptime(mut(x))`,
`.Some(v)` becomes `.Some(mut(v))`, and `{ a, b }` becomes `{ a, mut(b) }`. A
parameter takes no marker: rebind it by hand (`mut(p_m) := p;`).
`YO_AUDIT_MUT_BINDINGS=1` prints every write of a binding below module level
(`[mut-binding] how=… kind=… marked=yes|no`) without rejecting it.

A write through an `Rc` handle is E0919: an assignment to `h.*` or to a place
under it (`h.*.n = v`, `h.*.items(i) = v`), a `&mut` argument
(`bump(&mut h.*.n)`), or a `self : &mut Self` method called on such a place
(`h.*.items.push(v)`). An
`Rc(T)` is Rust's `Rc`: every copy of the handle shares one cell, so its
payload is read-only through the handle. Shared state that is
written goes through a door instead, and the error names them: an
`Rc(RefCell(T))`, written inside `h.*.with_mut(v => ...)`
(`std/sync/refcell`); `Rc.get_mut(&mut h)`, `.Some(&mut T)` when no other
handle shares the cell; `Rc.make_mut(&mut h)`, which moves `h` to a fresh cell
first when the cell is shared (`T <: Clone`); `Rc.try_unwrap(h)`, the payload
out of the only handle; a uniquely owned value or `Box(T)`; and
`Arc(Mutex(T))` or atomics across threads. Which door fits depends on why the
state is shared, so there is no repair.

## Warnings

`check`, `compile` and `build` also carry warning-severity diagnostics for
code that compiles but looks wrong. The first family is **unused variables**:
an initialized local whose value nothing ever reads warns once at the end of
its scope —

```text
warning: unused variable `x`
 --> src/main.yo:3:3
  |
3 |   x := i32(7);
  |   ^
help: prefix the name with `_` to silence this warning
```

Reading a variable marks it used; only assigning it does not (`x := 1; x = 2;`
still warns — the value never influenced anything). A `_` name prefix silences
the warning, parameters and module-level bindings are never warned, and
warnings never change the exit code. In the `json` render they arrive as JSON
Lines with `"severity":"warning"`, in `short` as `warning:` lines.

The second family is **module names**. `check` and `compile` warn once per
`.yo` file or directory they evaluated whose name holds `_` or an upper-case
letter, when it is project-local: a `yo.toml` sits at or above it and it is not
a dependency in the content store (a checkout's own `std` is project-local, an
installed std is not; cli-case fixtures, `tests/origins/corpus` and
`issues/repros` are exempt) —

```text
warning: module file name `string_util.yo` is not kebab-case
 --> src/string_util.yo:1:1
help: rename it `string-util.yo`: `yo fix . --module-names` renames every such file and directory under the project and rewrites the imports, `[modules]` entries and `build.yo` roots that reach them
```

It is a warning and never an error, and `yo fmt` does not rename files: a
file name is a repository fact, so the compiler points at it and
`yo fix <root> --module-names` (above) renames it.

## Error codes and `yo explain`

Errors of a known family carry a stable `EXXXX` code in the header and a
`help:` tail pointing at the explainer. The code belongs to the mistake, not to
the wording: the place that raises an error names its family, so the same
underlying mistake produces the same code whichever stage reports it (an
argument of the wrong type is E0601 whether it is a function argument or a
variant payload), and rewording a message never moves its code. Errors
without a family render without a code.

Codes are allocated in bands: E00xx–E02xx syntax, E03xx–E05xx name/scope/
module resolution, E06xx–E08xx types and traits, E09xx–E10xx ownership and
async, E11xx–E12xx comptime, E13xx internal codegen, E15xx the CLI/build/
dependency toolchain. Two of those bands name failures that have no source
span. `E1301` is the internal-compiler-error wrapper — a compiler bug, to
report rather than chase in your program. The E15xx family is what
`yo install` / `yo add` / `yo update` raise — the fetch, manifest and lock
failures an agent hits on a fresh clone:

| code | failure |
| --- | --- |
| E1501 | a dependency could not be fetched (`--offline` with nothing cached, an unreachable repository, a failed clone) |
| E1502 | no `yo.toml` at or above the working directory |
| E1503 | `yo.lock` disagrees with `yo.toml` (out of date, absent or unusable under `--locked`) |
| E1504 | the fetched dependency tree does not hash to what `yo.lock` records |
| E1505 | no tag of the dependency satisfies every requirement on it |
| E1506 | a package name (`[package] name`, a dependency key, `yo add --name`) outside `[A-Za-z0-9_-]+` |

These render with their code and the `explain` tail like any other error, and
`--error-format json` carries the code, so an error router can branch on the
family instead of string-matching prose.

```bash
$ yo explain E0401
E0401 — name not found

A name lookup failed: the identifier is not defined in this scope.

...

Example — this fails:
    undefined_fn_xyz();
```

- `yo explain --list` — every registered code with its one-line title.
- `yo explain E0401 --format json` — the full entry as JSON (for tooling).
- `yo explain E0401 --lang zh` — the Chinese version of the entry; the
  `YO_LANG` environment variable selects the language for both `explain` and
  its defaults.

Unknown code? `yo explain` suggests the nearest registered one — the same
edit-distance engine behind the compiler's own "did you mean" hints for
misspelled names and enum variants.

## Where an error is reported

An error points at the code that caused it: the argument that does not fit its
parameter, the field a constructor call is missing. An error raised inside the
standard library, while checking a call you wrote, is reported at that call,
with the standard-library location as a note:

```
error[E0602]: Type P does not implement required trait ToString.
  --> main.yo:5:3
  |
5 |   println(p);
  |   ^^^^^^^
note: raised here, inside the standard library
  --> /…/std/fmt/index.yo:63:50
```

## Where diagnostics surface

- `yo check`, `yo compile`, `yo build`, `yo test`, `yo install` — every CLI
  edge prints each diagnostic exactly once, in the selected format.
- `yo lsp` — the language server receives diagnostics through a structured
  channel (exact ranges, no text re-parsing), so editors get precise squiggles
  even when the error originates in an imported file.
- Runtime panics carry a call-site location suffix:
  `panic: <message> (at file://…/app.yo:3:17)`.

## C-compiler diagnostics (`--line-directives`)

Yo compiles through C. Without help, a C compiler's own diagnostic points at a
line of the generated `yo.c`, a machine-generated file nobody reads. `yo compile
--line-directives` gives it a Yo location: the emitted C carries `#line` directives
that map every statement back to its `.yo` source, and restore directives that
give compiler-generated code (drops, async state machines, runtime
scaffolding) its honest C numbering:

```c
#line 42 "app.yo"
  len := __yo_strlen(...);
#line 2603630 "out.c"
```

With the flag on:

- a C debugger (lldb/gdb on the compiled binary, ideally with `-g`) steps
  through `.yo` files — breakpoints on Yo lines and files work;
- C-compiler diagnostics for code that came from Yo report the `.yo`
  position, and a failed compile re-renders them as regular structured
  diagnostics in the selected `--error-format` — `error: incompatible
  pointer types` shows a `--> app.yo:12:9` anchor like any Yo error;
- `--emit-chunks` works: each translation unit's restore directives name that
  unit's own chunk file.

The flag is off by default (it grows the emitted C and is a debugging aid);
combine it with `-g` when you want a source-level debugging session.

## Exit codes

Errors exit `1`, success exits `0` — both in every format. Machine consumers
should rely on the exit code for the outcome and on the JSON output for the
detail, not on parsing prose.
