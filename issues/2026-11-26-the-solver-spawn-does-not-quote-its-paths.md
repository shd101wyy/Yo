# The solver spawn does not quote its paths, so a solver or temp dir with a space cannot run

**Severity:** S3 — a Z3 under a directory whose path contains a space (a Windows user name such as `C:\Users\Jane Doe\…`, which is where the solver cache now lives on Windows, `%LOCALAPPDATA%\yo\cache\solvers\`) never runs. `yo verify` fails, and `check`, `compile` and `build` report the solver as one that cannot run and keep the runtime checks. No wrong verdict results; nothing is proved.

- Filed: 2026-11-26 (lane `dov-sd`, step SD of `plans/backlog/DEFAULT_ON_VERIFICATION.md`), while moving the solver cache to `src/cache.yo`'s root.

## Reproducer

```bash
mkdir -p "/tmp/with space"
cp ~/.cache/yo/solvers/z3-5.1.0-x86_64-unknown-linux-musl/bin/z3 "/tmp/with space/z3"
cat > tmp/fixme.yo <<'EOF'
pragma(Pragma.VerifyOrAssert);

halve :: (fn(a : i32, requires(a >= i32(0)), ensures(r <= a)) -> (r : i32))(
  a / i32(2)
);
EOF
YO_Z3_PATH="/tmp/with space/z3" yo check tmp/fixme.yo
```

The shell the spawn goes through, given the same command line:

```text
$ sh -c '/tmp/with space/z3 --version > /tmp/out 2>&1'; echo rc=$?; cat /tmp/out
rc=127
sh: line 1: /tmp/with: No such file or directory
```

## Root cause

`src/verifier/z3.yo` runs the solver through `system(3)` with the paths
interpolated bare: `run_z3_script` builds `${binary} -smt2 ${script_path} >
${out_path} 2>&1`, and `_z3_run_version` builds `${binary} --version >
${out_path} 2>&1`. `sh` (and `cmd.exe` on Windows) split the command at the
space. The script and output paths come from `temp_dir()`, which on Windows is
also under the user's profile.

## Fix direction

Quote every path in the two command lines. `cmd /c` strips the first and last
quote of a command line that starts with one, so on Windows the whole command
needs one more pair of quotes around it. A test needs the real solver
(`YO_TEST_Z3=1`): copy it into a directory with a space and run the harness
self-test through `YO_Z3_PATH`.
