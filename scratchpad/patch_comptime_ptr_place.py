#!/usr/bin/env python3
"""Stage 1 of the comptime-pointer-place port (tests/comptime.test.yo arms 22/23).

Two faithful-port fixes:

A. yo-self/evaluator/builtins/ptr_fns.yo — restore TS's ladder ORDER
   (src/evaluator/builtins/ptr-fns.ts:130-205): comptimeRef, then
   sourceVariable, then indexTraitPtrType, then an UnknownValue argument. TS
   documents the order as load-bearing ("We check comptimeRef BEFORE
   indexTraitPtrType because comptime arrays set both properties"); yo-self had
   the index-trait arm first, so `p :: &(arr(0))` on a COMPTIME array always
   produced the runtime-only pointer.

B. yo-self/evaluator/exprs/property_access.yo — the compile-time `p.*` deref
   discarded the pointer's INDEX (returning the whole aggregate instead of the
   element) and stamped no place, so `p.* = v` had nothing to write through. TS
   indexes the target and stamps `ptrTargetValue`/`ptrTargetIndex`
   (property-access.ts:327-352); yo-self's `ComptimeRef.ArrayRef(elements,
   index)` IS that pair, and assignment.yo Step 6 is already its consumer.

Anchored on unique context; run once from the repo root.
"""
import sys


def patch(path, old, new, what):
    s = open(path).read()
    if old not in s:
        print(f'ANCHOR NOT FOUND ({what}) in {path}', file=sys.stderr)
        sys.exit(1)
    if s.count(old) != 1:
        print(f'ANCHOR NOT UNIQUE ({what}) in {path}', file=sys.stderr)
        sys.exit(1)
    open(path, 'w').write(s.replace(old, new))
    print('patched', path, '—', what)


# ---------------------------------------------------------------- A: ptr_fns
P1 = 'yo-self/evaluator/builtins/ptr_fns.yo'
OLD_A = """  // If no comptimeRef, check source_variable or unknown val.
  ptr_val_opt := match(
    ptr_val_from_comptime_ref,
    .Some(_) => ptr_val_from_comptime_ref,
    .None => {
      src_val := match(
        arg_info.source_variable,
        .Some(src_var) => match(
          src_var.value,
          .Some(sv) => Option(EvalValue).Some(EvalValue.PtrVal(sv, usize(0))),
          .None => Option(EvalValue).None
        ),
        .None => Option(EvalValue).None
      );
      match(
        src_val,
        .Some(_) => src_val,
        .None => match(
          arg_info.value,
          .Some(v) => if(
            is_unknown_val(v),
            Option(EvalValue).Some(create_unknown_val(pointer_type)),
            Option(EvalValue).None
          ),
          .None => Option(EvalValue).None
        )
      )
    }
  );
  out_info := new_expr_info(cur_env, pointer_type);
  // Handle index_trait_ptr_type: &(value(i)) skips auto-deref.
  match(
    arg_info.index_trait_ptr_type,
    .Some(itp_ty) => {
      // Use the Index-trait pointer type; value is runtime only.
      out_info.ty = itp_ty;
      out_info.is_index_trait_address_of = Option(bool).Some(true);
    },
    .None => {
      // Set compile-time pointer value if available.
      out_info.value = ptr_val_opt;
    }
  );"""
NEW_A = """  // A compile-time PLACE: `comptimeRef` first, then `sourceVariable`
  // (ptr-fns.ts:138-186). Kept separate from the UnknownValue fallback so the
  // ladder below can follow TS's order exactly.
  ptr_place_val_opt := match(
    ptr_val_from_comptime_ref,
    .Some(_) => ptr_val_from_comptime_ref,
    .None => match(
      arg_info.source_variable,
      .Some(src_var) => match(
        src_var.value,
        .Some(sv) => Option(EvalValue).Some(EvalValue.PtrVal(sv, usize(0))),
        .None => Option(EvalValue).None
      ),
      .None => Option(EvalValue).None
    )
  );
  // Last arm (ptr-fns.ts:200-205): the argument itself is a comptime
  // UnknownValue, so `&(arg)` is a comptime unknown pointer too.
  ptr_unknown_val_opt := match(
    arg_info.value,
    .Some(v) => if(
      is_unknown_val(v),
      Option(EvalValue).Some(create_unknown_val(pointer_type)),
      Option(EvalValue).None
    ),
    .None => Option(EvalValue).None
  );
  out_info := new_expr_info(cur_env, pointer_type);
  // TS's ladder, IN ORDER (ptr-fns.ts:130-205). Its own comment says the order
  // is load-bearing: "We check comptimeRef BEFORE indexTraitPtrType because
  // comptime arrays set both properties, and comptimeRef allows creating a
  // comptime pointer whereas indexTraitPtrType would return a runtime-only
  // pointer." yo-self had the index-trait arm FIRST, so `p :: &(arr(0))` on a
  // COMPTIME array always took it and every later `p.*` / `p.* = v` emitted
  // "// Failed to transpile" (tests/comptime.test.yo arms 22/23). The place arm
  // deliberately leaves `ty` at `pointer_type` and does NOT set
  // `is_index_trait_address_of` — TS sets neither there.
  match(
    ptr_place_val_opt,
    .Some(_) => {
      out_info.value = ptr_place_val_opt;
    },
    .None => match(
      arg_info.index_trait_ptr_type,
      .Some(itp_ty) => {
        // Use the Index-trait pointer type; value is runtime only.
        out_info.ty = itp_ty;
        out_info.is_index_trait_address_of = Option(bool).Some(true);
      },
      .None => {
        out_info.value = ptr_unknown_val_opt;
      }
    )
  );"""
patch(P1, OLD_A, NEW_A, 'ptr-fns ladder order')

# ------------------------------------------------------- B: property_access
P2 = 'yo-self/evaluator/exprs/property_access.yo'
OLD_B = """                .PtrVal(target_box, _) => {
                  // Compile-time pointer: dereference to the pointed-to value.
                  out_ptr := new_expr_info(env, resolved_base);
                  out_ptr.value = Option(EvalValue).Some(target_box);"""
NEW_B = """                .PtrVal(target_box, ptr_tgt_idx) => {
                  // Compile-time pointer: dereference to the pointed-to value.
                  // TS indexes the target when it is an aggregate —
                  // `dereferencedValue = target.elements[objectValue.targetIndex]`
                  // (property-access.ts:329-334) — and stamps
                  // `ptrTargetValue`/`ptrTargetIndex` so a later `p.* = v` has a
                  // place to write (consumed by assignment.ts:1150-1173).
                  // yo-self dropped the index, so `p.*` read the whole
                  // aggregate and `p.* = v` had no place at all; its
                  // `ComptimeRef.ArrayRef(elements, index)` IS that pair, and
                  // assignment.yo's Step 6 already consumes it.
                  (deref_val : EvalValue) = target_box;
                  (deref_place : Option(ComptimeRef)) = Option(ComptimeRef).None;
                  match(
                    target_box,
                    .ArrayVal(deref_elems) => {
                      deref_val = match(deref_elems.get(ptr_tgt_idx),.Some(de) => de,.None => target_box);
                      deref_place = Option(ComptimeRef).Some(ComptimeRef.ArrayRef(deref_elems, ptr_tgt_idx));
                    },
                    _ => ()
                  );
                  out_ptr := new_expr_info(env, resolved_base);
                  out_ptr.value = Option(EvalValue).Some(deref_val);
                  out_ptr.comptime_ref = deref_place;"""
patch(P2, OLD_B, NEW_B, 'comptime deref index + place')
