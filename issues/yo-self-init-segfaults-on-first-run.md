# `yo-self init` SIGSEGVs — `init_project` had never been executed

**Found 2026-08-09**, the first hour of P1, by wiring `init` into the
self-hosted CLI and running the first differential.

## Symptom

```bash
mkdir /tmp/x && cd /tmp/x
<yo-self-bin> init myproj      # rc=139 (SIGSEGV), NO output
```

It creates `myproj/`, `myproj/src/` and `myproj/tests/` — the three
`create_dir_all` calls — then dies before writing any file. The reference
compiler writes all seven files and prints its summary:

```
build.yo  deps.yo  src/main.yo  src/lib.yo  tests/main.test.yo  .gitignore  README.md
```

Not stack exhaustion: `YO_MAIN_STACK_MB=4096` does not change it, and the
binary is `--release` (-O2), so the giant-frame `-O0` failure mode
(`AGENTS.md` "Common Pitfalls") does not apply.

## Why this was invisible

`plans/PRE_P1_HANDOVER.md` §5 recommends starting P1 with `init` because it is
"genuinely ready (239 lines, complete `init_project`)". It type-checks — it is
inside `check ./yo-self`'s 238 files — but **`init_project` was wired to no
CLI subcommand**, so it had never been RUN, not once. `grep '"init"'
yo-self/main.yo` returned nothing before this change.

That is the general shape to watch for in P1: "ported" in this codebase can mean
"type-checks and is unreachable". `check` cannot distinguish those. Every ported
subcommand needs an execution differential before it is called ready — which is
exactly what §5 step 4 (`scripts/cli-diff-test.sh`) is for.

## Where it dies

Between the last `create_dir_all` and the first file write
(`yo-self/init.yo:171-179`):

```rust
e.io.await(create_dir_all(project_dir.join(Path.new(String.from("tests")))), e.io), e);   // OK — dir exists
build_yo_path := project_dir.join(Path.new(String.from("build.yo")));
if(e.io.await(exists(build_yo_path, e.io), e.io), {                                        // <- suspect
  e.exn.throw(dyn(`Error: ${build_yo_path.to_string()} already exists. Aborting.`));
});
e.io.await(write_file(build_yo_path, generate_build_yo(project_name), e.io), e);
```

**One inconsistency worth checking first**: every other `await` in this function
passes the effect BUNDLE `e` as its second argument, but the `exists(...)` calls
pass `e.io`. yo-self detects io/await STRUCTURALLY (see
`issues/fixed/` notes on `io2.await` misrouting to `JoinHandle`), so an
`Io`-typed second argument where an `IoExn` is expected is exactly the kind of
thing that type-checks and then misroutes at runtime.

**Ruled out so far:** the same shape in isolation does NOT crash —
`io.await(exists(p, io), io)` in a standalone program compiles and runs cleanly
under the same binary. So it is not the `await`-argument shape alone; it needs
the surrounding `io.async((e) => {...})` closure context, or one of the other
values in scope.

## Next step

Bisect inside the `io.async` closure. `init_project` returns
`Impl(Future(unit, IoExn))`, so a harness must `io.await` it — calling it
directly does nothing and prints nothing (a harness that "runs clean" without
awaiting is a false negative; this cost one iteration).

## Regression guard

Once fixed, `init` is the first candidate for `scripts/cli-diff-test.sh`: run
both compilers' `init` into two temp dirs and `diff -r` the trees. That
comparison already works and is what found this — the TS tree has 7 files, the
self-hosted tree has 0.
