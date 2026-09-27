# The documented io_uring kernel floor (5.6) is wrong: rename/unlink need 5.11, mkdir/symlink/link need 5.15

**Status: FIXED (2026-09-27), awaiting Linux CI.** Filed the same day from the DROP_LIBURING audit. The opcode list
is **read from the code**; the per-opcode kernel versions come from the upstream
io_uring history and were **not tested here**. The runtime behaviour predates the
campaign. What is new is that DROP_LIBURING §3.5 and Phase 2's docs present "5.6+"
as the contract.

## What is wrong

`docs/en-US/STD_SYS_MODULE.md` and `docs/en-US/INSTALL_LINUX.md` (and their zh-CN
twins) and `plans/DROP_LIBURING.md` §3.5 say the op set the runtime submits needs
5.6+. The Linux runtime also submits:

| Opcode | Kernel |
| --- | --- |
| `IORING_OP_RENAMEAT`, `IORING_OP_UNLINKAT` | 5.11 |
| `IORING_OP_MKDIRAT`, `IORING_OP_SYMLINKAT`, `IORING_OP_LINKAT` | 5.15 |

On 5.6–5.14 (5.10 LTS is common), `io_uring_setup` succeeds, so the backend ladder
never falls back. Then `create_dir`, `remove_file`, `rename`, `symlink` and
`hard_link` complete with `-EINVAL`.

Also stale: `STD_SYS_MODULE.md` still says "kernel 5.1+" in one place and never
mentions the epoll fallback. `std/sys/timer.yo`'s doc comment still describes ring
init failure as the degradation path that Phase 5 replaced.

## Fix direction

- Correct the tables in both languages and in the plan.
- Better: on `-EINVAL` from those five ops, redo the op synchronously (the epoll
  backend's behaviour for the same ops). The contract then really is 5.6+.

## Fix (landed)

- **Docs:** the tables list the per-operation floors, in both languages and in the plan.
- **Runtime:** at ring setup it probes the kernel's opcodes once
  (`IORING_REGISTER_PROBE`, 5.6: `__yo_uring_probe_ops` in
  `src/codegen/async/runtime_io_linux.yo`). `renameat`/`unlinkat`/`mkdirat`/
  `symlinkat`/`linkat`/`ftruncate` complete synchronously when their opcode is
  missing, through the same implementation the epoll fallback uses. So the
  contract really is 5.6+: an operation newer than the running kernel is slower,
  not broken.
- **When the probe itself fails:** every op is assumed present, which is the old
  behaviour.
