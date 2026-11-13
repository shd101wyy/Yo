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
| E0401 on `rc`/`box`/`arc`, the prelude builtins static-argument inference B3 deleted | rewrite the name to the handle's constructor (`rc` → `Rc.new`, `box` → `Box.new`, `arc` → `Arc.new`); a closure or `.None` argument then needs its type written, E0613 |
| E0401 name not found, exported by exactly one std module | insert `{ name } :: import("std/…");` above the first non-comment line (the help names the module; two exporting modules, or a rename candidate as well, give help only) |
| E0007 `{ a, b }`, `{ k : v }` as a value — a bare expression brace is a block | insert `.` before the `{` (the record `.{ … }`) |
| E0007 `.{ a } := s`, `.V(.{ x })` in a pattern — a dot on the binding side | delete the `.` |
| E0007 `.{ a; b }` — a dotted block | delete the `.` |
| E0618 a named callable passed bare into a `Dyn(Fn(...))` slot | wrap the name: `run(f)` → `run(dyn(f))` (a longer value gives help only) |

`yo fix <path> --migrate deref` runs a migration rather than a repair, for
decision 43 step 2 (N1e-1): outside std and the compiler's own source, a
reference binding reads and writes the value it refers to with `.*`. It
evaluates every file with E0926 recording instead of rejecting, and appends
`.*` where a reference is read or written as a whole value (`n + 1` →
`n.* + 1`, `r = v` → `r.* = v`, `&r` → `&r.*`), turns `v.*` into `v.*.*`
where `v.*` meant the `Box`/`Rc`/pointer deref through a reference, labels a
capture-list pun (`{ r }` → `{ r : r.* }`), and drops the redundant marker of
`match(&r, …)`. A site whose source text no longer prints as the evaluated
expression on one line, or a copy whose referent is not implicitly copyable
(`r.*` would be E0901 there), is listed with its position and left as
written. A second run records nothing.

The migration reaches only what evaluation reaches, so two options widen
it. `yo fix ./std ./tests --migrate deref` evaluates several paths in one
session: a generic `std` body is evaluated when a test instantiates it.
Without `--target`, a file whose platform-gated `cond` leaves an arm the host
does not evaluate is evaluated again for every other supported architecture
and OS, and a position two targets read differently is listed and left as
written; `--target <triple>` evaluates for that one target, as
`compile --target` does. A file that does not evaluate keeps what evaluation
never reached, and `fix` exits non-zero naming it.

`yo fix <path> --migrate record-literal` is the migration for the brace-group
rule (`plans/reference/BRACE_BLOCKS.md`): since v0.2.78 a record value is
spelled with a dot before the opening brace and a bare brace in expression
position is a block, and the migration reads source written before that
(where a bare brace group of fields was a record) and writes the dot before
every such group in expression position, the punned one-field group and the
empty group included. It retires in v0.2.79. It
reads the parse and does not evaluate, so it needs no prelude and reaches
every file. It touches no binder: the left side of `:=`, `=` and `::`
(destructurings, imports, globs), match patterns and sub-patterns, `for`
element patterns, closure capture lists and parameters, and blocks keep their
braces. A group that already carries the dot is left alone, so a second run
changes nothing; a file that does not parse is named and `fix` exits non-zero.

`yo fix <path> --migrate unsized` is the migration for decision 49
(`plans/VALUES_BY_DEFAULT.md`): `Dyn(...)` is unsized and lives behind a
pointer, so the owning trait object that a bare `Dyn(...)` value type names
in v0.2.77 is written `Box(Dyn(...))`. The migration rewrites every bare
`Dyn(...)` type spelling to `Box(Dyn(...))`: a binding, parameter, field,
element or result type, a type alias body, a `Type.impls`/`Type.eq`/`size_of`
argument, and `*Dyn(...)`/`?*Dyn(...)`, which point at an owned box. A
`Dyn(...)` that is the immediate argument of `Box`, `Rc`, `Arc`, `Weak`,
`ArcWeak`, `&` or `&mut` (with or without an origin) already names the
unsized object and is left alone, and so is `upcast`'s target, so a second
run changes nothing. Under v0.2.77 the two spellings are one type, so a
`yo check` verdict does not change. The type spellings are read from the
parse, so every platform arm is reached. The migration also evaluates every
file, as `yo check` does, with a recorder on: `dyn(v)` of a plain value
becomes `dyn(Box.new(v))`, and `dyn(Rc.new(e))`/`dyn(Arc.new(e))` evaluated
against an owning `Dyn` becomes `dyn(Box.new(e))` (`alloc` kept as written).
It lists, with their positions and without rewriting them, a spelling that
does not print back on one line, `Rc(Dyn(T)).new(...)` (write
`dyn(Rc.new(v))` for one shared object, or keep the box with
`Rc(Box(Dyn(T))).new(...)`), `impl(Dyn(...), ...)` (the owning value today,
the unsized object in v0.2.78), `dyn(p)` over a raw pointer (it boxes the
pointer today and unsizes it in v0.2.78), `dyn(h)` over a named `Rc`/`Arc`
handle, a `downcast` of an owned `Dyn` (its owning form arrives in v0.2.78),
and a file with a platform-gated `cond` arm the target does not evaluate
(run it again with `--target`). A file that does not evaluate is named and
`fix` exits non-zero.

A module-level or `thread_local` runtime binding is immutable (Rust's
`static`) unless its name is wrapped in `mut(...)` (`static mut`, decision
47). Writing an immutable global is E0917: reassigning it, writing a field or
element of a value it holds, lending a place of that value as `&mut`, or
calling a `&mut self` method on it. A write through a `ref` handle the global
holds (`g.push(x)` on an `ArrayList`, `h.name = …` on a `ref(struct)`) is not
a write of the binding and needs no marker; only reassigning the binding does.
The marker goes on the declared name: `mut(G) := v`, `(mut(G) : T) = v`,
`thread_local(mut(G))`.

The marker is what decision 18 rule 3 reads: lending a `mut(...)` global, or a
place under it, to a call (a `&`/`&mut` argument, a borrowed receiver, an
operand its operator borrows, an interpolated value) is E0916, because the
callee could reach the global by name, or await while another task writes it,
and the borrow would then change under it. Read it into a local first
(`v := G; f(&v)`) and write it back after a `&mut` call. A `String`, a
collection or a value holding one is read with `v := G.clone()`: the receiver
of a `clone()` whose every `Clone` impl is derived or std's is the one lend
allowed, since that clone runs no user code. An unmarked global
is lent freely. A global holding a `ref` handle adds two conflicts, each
reported wherever the compiler sees the second site: a lend into the storage
behind it (`&g(i)`) is E0916 when a `&mut self` method is called on it
anywhere, and a lend of a field written through it (`&h.name` after
`h.name = …`) is E0916 too. Both errors apply everywhere, `std` and the
compiler's own sources included.

Decision 47's second step applies the same rule below module level: a local,
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
under it (`h.n = v`, `h.items(i) = v`), a `&mut` argument (`bump(&mut h.n)`),
or a `self : &mut Self` method called on such a place (`h.items.push(v)`). An
`Rc(T)` is Rust's `Rc`: every copy of the handle shares one cell, so its
payload is read-only through the handle (decision 46). Shared state that is
written goes through a door instead, and the error names them: an
`Rc(RefCell(T))`, written inside `h.with_mut(v => ...)`
(`std/sync/refcell`); `Rc.get_mut(&mut h)`, `.Some(&mut T)` when no other
handle shares the cell; `Rc.make_mut(&mut h)`, which moves `h` to a fresh cell
first when the cell is shared (`T <: Clone`); `Rc.try_unwrap(h)`, the payload
out of the only handle; a uniquely owned value or `Box(T)`; and
`Arc(Mutex(T))` or atomics across threads. Which door fits depends on why the
state is shared, so there is no repair.

#### Retired migrations

Each `yo fix --migrate <name>` existed to carry code across one change of the
language, and is retired once the code we own is across. The errors stay hard
errors, with help that names the fix, and the per-diagnostic repairs above
stay. To upgrade code written before a change, install the release that last
shipped its migration, run it there, and step to the next release:

```sh
yo version install 0.2.76
yo fix <path> --migrate borrow-spelling
```

| Migration | What it rewrote | Error it stood for | Last shipped |
| --- | --- | --- | --- |
| `explicit-copy` (with the `YO_AUDIT_IMPLICIT_COPY` listing) | a copy of a `String`, a collection or a value holding one whose source is used again, to `.clone()` | E0901 | v0.2.73 |
| `cloned-accessors` (with the `YO_AUDIT_COPYING_ACCESSOR` listing and `--hot-path`) | a copying accessor call whose result holds a `String` or a collection, `r.get(i)` to `r.get_cloned(i)` | E0901 | v0.2.73 |
| `handle-ctors` | the prelude's `rc(x)`/`box(x)`/`arc(x)` to `Rc.new(x)`/`Box.new(x)`/`Arc.new(x)`, with the type argument a closure or `.None` argument needs | E0401 (its repair rewrites the name) | v0.2.73 (later releases carry the mode, but v0.2.74 deleted the builtins, so only v0.2.73 can type an old call) |
| `modes` | the deleted `own(x)` parameter to `sink(x)` | E0009 | v0.2.76 |
| `params` | a plain parameter whose type is not `Copy` to `x : &T`, what it meant before the by-value flip | E0901 | v0.2.76 |
| `addr-of` | a `&x` that was the raw-pointer address-of to `addr_of(x)` | E0914 | v0.2.76 |
| `markers` | a bare named place passed to a `&T`/`&mut T` parameter to `&x`/`&mut x` | E0914 | v0.2.76 |
| `match-scrutinee` | `match(x, …)` to `match(&x, …)` where moving the scrutinee is an error (decision 26) | E0901 | v0.2.76 |
| `borrow-spelling` | the mode words to the sigils: `imm(x) : T` to `x : &T`, `mut(x) : T` to `x : &mut T`, `mut(y) := p` to `y := &mut p`, `for(xs, mut(x) => …)` to `for(&mut xs, x => …)` (decision 42) | E0009 | v0.2.76 |
| `drop-trait` | `Dispose`/`dispose` to `Drop`/`drop`, and `x.dispose()` to `drop(x)` (decision 45) | E0915 | v0.2.76 |
| `rc-pattern` | a pattern `p` at an `Rc(T)` position to `Rc(p)` (decision 31) | E0609 | v0.2.76 |
| `dyn-spelling` | a callable passed bare into a `Dyn(Fn(...))` slot to `dyn(f)` (decision 44) | E0618 | v0.2.76 |
| `mutable-globals` | `mut(G)` on every module-level binding the program writes (decision 47) | E0917 | v0.2.76 |
| `mut-bindings` | `mut(x)` on every local, pattern and compile-time binding the program writes (decision 47 step 2) | E0917 | v0.2.76 |
| `rc-clone` | `Rc.clone(h)`/`Arc.clone(h)`/`e.clone()` on an implicit copy of a counted handle whose source is used again, and a capture list on a closure that captures one (decision 17) | E0901 | v0.2.76 |

Run them in phase order. Code older than decision 42 runs
`borrow-spelling` before `mut-bindings`: there `mut(z) := x` is the deleted
local-borrow spelling, and `mut-bindings` would read it as a mutable local.
Never run `borrow-spelling` on code that already spells decision 47's
`mut(x) := v`. The copy migrations run on v0.2.73 in their own order,
`explicit-copy`, `cloned-accessors`, then `rc-clone`, before pinning v0.2.74.
`yo fix --migrate deref` and `yo fix --migrate record-literal` are the two modes this release ships.

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

Yo compiles through C, and the C compiler's own diagnostics used to be the one
channel with no Yo location: an error in the generated `yo.c` pointed at a
line in a machine-generated file nobody reads. `yo compile
--line-directives` closes that gap. The emitted C carries `#line` directives
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
