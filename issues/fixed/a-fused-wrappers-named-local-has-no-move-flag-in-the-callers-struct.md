# A fused wrapper's named local has no move flag in its caller's struct

**Severity:** S2. Under await-site fusion (#1073, on by default), a task that fuses a wrapper whose named local moves out of its slot fails in the C compiler. Found integrating #1073 with #1093.

**Status: FIXED (2026-10-02)**, on the integration of #1073 with #1093. The bug needs both: #1093's move flags and #1073's fused fields.

## Symptom

`tests/async/async_await.test.yo` with fusion on (`YO_ASYNC_FUSION` unset); with `YO_ASYNC_FUSION=0` it passes (261):

```
error: no member named '__yo_mv_var_cstr_bytes_11268203931698698199' in 'struct _file____tmp__temp_181732127303320575491_state_t_struct'
error: no member named '__yo_mv_var_buf_9933853085740183429' in 'struct …_state_t_struct'
```

## Cause

#1093 gives a named local's task slot a move flag (`uint8_t __yo_mv_<field>`). The struct emitter declares it and records the field in `g_sm_move_flag_fields`, and `sm_move_flag_of` finds it by field name, since a field name carries the variable id. Fusion inlines a wrapper's body into its caller's state machine and gives each of the wrapper's locals a field in the caller's struct under the same program-unique name (`_emit_fused_site_fields`, `src/codegen/exprs/async.yo`). That emitter declared the slot but not its flag, while the fused body's moves and stores named the flag by the shared field name.

## Fix

`_emit_fused_site_fields` declares and records the move flag beside every named fused local, as the regular struct emitter does (`FusedLocalField` now carries the local's name). The dispose's fused-local release (`_emit_fused_local_release`) empties a flagged slot before its drop, as the regular dispose does.

Test: `tests/async_await.test.yo` with fusion on (it failed to compile before the fix).
