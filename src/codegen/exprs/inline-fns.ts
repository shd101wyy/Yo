import { BuiltinFunctions, type FnCallExpr } from "../../expr";
import { isEnumType } from "../../types/guards";
import { isTargetWindows } from "../../target";
import {
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  getTypeString,
} from "../utils";

let _maybeUninitCounter = 0;

/**
 * Generate Yo operator function call - extracted from original codegen-c.ts
 */
export function generateYoInlineFunctionCall(
  functionName: string,
  args: string[],
  expr: FnCallExpr,
  context: CodeGenContext,
  indent: string = "  "
): string {
  // +
  if (BuiltinFunctions.__yo_op_add.includes(functionName)) {
    return `((${args[0]!}) + (${args[1]!}))`;
  }
  // -
  else if (BuiltinFunctions.__yo_op_sub.includes(functionName)) {
    return `((${args[0]!}) - (${args[1]!}))`;
  }
  // *
  else if (BuiltinFunctions.__yo_op_mul.includes(functionName)) {
    return `((${args[0]!}) * (${args[1]!}))`;
  }
  // /
  else if (BuiltinFunctions.__yo_op_div.includes(functionName)) {
    return `((${args[0]!}) / (${args[1]!}))`;
  }
  // %
  else if (BuiltinFunctions.__yo_op_mod.includes(functionName)) {
    return `((${args[0]!}) % (${args[1]!}))`;
  }
  // neg -
  else if (BuiltinFunctions.__yo_op_neg.includes(functionName)) {
    return `(-(${args[0]!}))`;
  }
  // ==
  else if (BuiltinFunctions.__yo_op_eq.includes(functionName)) {
    return `((${args[0]!}) == (${args[1]!}))`;
  }
  // !=
  else if (BuiltinFunctions.__yo_op_neq.includes(functionName)) {
    return `((${args[0]!}) != (${args[1]!}))`;
  }
  // <
  else if (BuiltinFunctions.__yo_op_lt.includes(functionName)) {
    return `((${args[0]!}) < (${args[1]!}))`;
  }
  // <=
  else if (BuiltinFunctions.__yo_op_lte.includes(functionName)) {
    return `((${args[0]!}) <= (${args[1]!}))`;
  }
  // >
  else if (BuiltinFunctions.__yo_op_gt.includes(functionName)) {
    return `((${args[0]!}) > (${args[1]!}))`;
  }
  // >=
  else if (BuiltinFunctions.__yo_op_gte.includes(functionName)) {
    return `((${args[0]!}) >= (${args[1]!}))`;
  }
  // !
  else if (BuiltinFunctions.__yo_op_not.includes(functionName)) {
    return `(!(${args[0]!}))`;
  }
  // &
  else if (BuiltinFunctions.__yo_op_bit_and.includes(functionName)) {
    return `((${args[0]!}) & (${args[1]!}))`;
  }
  // |
  else if (BuiltinFunctions.__yo_op_bit_or.includes(functionName)) {
    return `((${args[0]!}) | (${args[1]!}))`;
  }
  // ^
  else if (BuiltinFunctions.__yo_op_bit_xor.includes(functionName)) {
    return `((${args[0]!}) ^ (${args[1]!}))`;
  }
  // ~
  else if (BuiltinFunctions.__yo_op_bit_complement.includes(functionName)) {
    return `(~(${args[0]!}))`;
  }
  // <<
  else if (BuiltinFunctions.__yo_op_bit_left_shift.includes(functionName)) {
    return `((${args[0]!}) << (${args[1]!}))`;
  }
  // >>
  else if (BuiltinFunctions.__yo_op_bit_right_shift.includes(functionName)) {
    return `((${args[0]!}) >> (${args[1]!}))`;
  }
  // __yo_noop
  else if (BuiltinFunctions.__yo_noop.includes(functionName)) {
    return "";
  }
  // __yo_return_self
  else if (BuiltinFunctions.__yo_return_self.includes(functionName)) {
    // This is a special case where we just return the first argument
    return `(*${args[0]!})`;
  }
  // __yo_ms_sleep
  else if (BuiltinFunctions.__yo_ms_sleep.includes(functionName)) {
    // Cross-platform sleep - takes milliseconds
    if (isTargetWindows(context.targetInfo)) {
      return `Sleep(${args[0]!})`;
    } else {
      return `usleep((${args[0]!}) * 1000)`;
    }
  }
  // __yo_decr_rc
  else if (BuiltinFunctions.__yo_decr_rc.includes(functionName)) {
    return `__yo_decr_rc((void*)(${args[0]!}))`;
  }
  // __yo_as - generic type casting for primitives and pointers
  else if (BuiltinFunctions.__yo_as.includes(functionName) && expr.$?.type) {
    // The return type tells us what to cast to
    const targetCType = getTypeString(expr.$.type, context);

    // Check if source is a non-simple enum (tagged union) - need to access .tag
    const sourceType = expr.args[0]?.$?.type;
    if (
      sourceType &&
      isEnumType(sourceType) &&
      !canOptimizeAsSimpleEnum(sourceType)
    ) {
      return `((${targetCType})((${args[0]!}).tag))`;
    }

    return `((${targetCType})(${args[0]!}))`;
  }
  // __yo_ptr_add
  else if (BuiltinFunctions.__yo_ptr_add.includes(functionName)) {
    return `(${args[0]!} + ${args[1]!})`;
  }
  // __yo_ptr_sub
  else if (BuiltinFunctions.__yo_ptr_sub.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_diff
  else if (BuiltinFunctions.__yo_ptr_diff.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_eq
  else if (BuiltinFunctions.__yo_ptr_eq.includes(functionName)) {
    return `(${args[0]!} == ${args[1]!})`;
  }
  // __yo_ptr_neq
  else if (BuiltinFunctions.__yo_ptr_neq.includes(functionName)) {
    return `(${args[0]!} != ${args[1]!})`;
  }
  // __yo_ptr_lt
  else if (BuiltinFunctions.__yo_ptr_lt.includes(functionName)) {
    return `(${args[0]!} < ${args[1]!})`;
  }
  // __yo_ptr_lte
  else if (BuiltinFunctions.__yo_ptr_lte.includes(functionName)) {
    return `(${args[0]!} <= ${args[1]!})`;
  }
  // __yo_ptr_gt
  else if (BuiltinFunctions.__yo_ptr_gt.includes(functionName)) {
    return `(${args[0]!} > ${args[1]!})`;
  }
  // __yo_ptr_gte
  else if (BuiltinFunctions.__yo_ptr_gte.includes(functionName)) {
    return `(${args[0]!} >= ${args[1]!})`;
  }
  // __yo_str_* — builtin str (static string view) intrinsics
  else if (BuiltinFunctions.__yo_str_len.includes(functionName)) {
    return `(${args[0]!}.len)`;
  } else if (BuiltinFunctions.__yo_str_ptr.includes(functionName)) {
    return `((uint8_t*)${args[0]!}.ptr)`;
  } else if (BuiltinFunctions.__yo_str_byte.includes(functionName)) {
    return `(${args[0]!}.ptr[${args[1]!}])`;
  } else if (BuiltinFunctions.__yo_str_from_raw_parts.includes(functionName)) {
    return `(__yo_str){ .ptr = (const uint8_t*)${args[0]!}, .len = ${args[1]!} }`;
  }
  // __yo_getrandom - Linux getrandom() syscall wrapper
  else if (BuiltinFunctions.__yo_getrandom.includes(functionName)) {
    return `getrandom(${args[0]!}, ${args[1]!}, ${args[2]!})`;
  }
  // __yo_arc4random_buf - macOS arc4random_buf() wrapper
  else if (BuiltinFunctions.__yo_arc4random_buf.includes(functionName)) {
    return `(arc4random_buf(${args[0]!}, ${args[1]!}), (void)0)`;
  }
  // __yo_bcrypt_gen_random - Windows BCryptGenRandom() wrapper
  else if (BuiltinFunctions.__yo_bcrypt_gen_random.includes(functionName)) {
    return `(int32_t)BCryptGenRandom(NULL, ${args[0]!}, ${args[1]!}, BCRYPT_USE_SYSTEM_PREFERRED_RNG)`;
  }
  // __yo_getentropy - WASM/Emscripten getentropy() wrapper (max 256 bytes per call)
  else if (BuiltinFunctions.__yo_getentropy.includes(functionName)) {
    return `getentropy(${args[0]!}, ${args[1]!})`;
  }
  // __yo_maybe_uninit_new - declare uninitialized storage (no runtime args, return type is Self)
  else if (
    BuiltinFunctions.__yo_maybe_uninit_new.includes(functionName) &&
    expr.$?.type
  ) {
    const selfCType = getTypeString(expr.$.type, context);
    const uninitVar = `__yo_uninit_${_maybeUninitCounter++}`;
    context.emitter.emitLine(`${indent}${selfCType} ${uninitVar};`);
    return uninitVar;
  }
  // __yo_maybe_uninit_as_ptr - cast pointer (newtype is transparent, no .value field)
  else if (
    BuiltinFunctions.__yo_maybe_uninit_as_ptr.includes(functionName) &&
    expr.$?.type
  ) {
    const returnCType = getTypeString(expr.$.type, context);
    return `((${returnCType})(${args[0]!}))`;
  }
  // __yo_maybe_uninit_assume_init - identity (newtype is transparent)
  else if (
    BuiltinFunctions.__yo_maybe_uninit_assume_init.includes(functionName)
  ) {
    return `(${args[0]!})`;
  }
  // __yo_array_index - get pointer to array element: &(arr->data[idx])
  else if (BuiltinFunctions.__yo_array_index.includes(functionName)) {
    return `(&((${args[0]!})->data[${args[1]!}]))`;
  }
  // Handle other operators that are not defined in Yo
  else {
    return `/* Unhandled operator ${functionName} */`;
  }
}
