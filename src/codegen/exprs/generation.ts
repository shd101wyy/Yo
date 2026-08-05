import {
  isIoAsyncCall,
  isIoAwaitCall,
  isIoSpawnCall,
  isIoStateCall,
  isJoinHandleAwaitCall,
} from "../../evaluator/async/await-analysis";
import { typeImplementsFuture } from "../../evaluator/trait-checking";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
} from "../../expr";
import { getVariablesFromEnv } from "../../env";
import { isSomeType, isUnitType } from "../../types/guards";
import { isTempVariableName } from "../../utils";
import { isFunctionValue, isUnknownValue } from "../../value";
import { isIoFutureType } from "../async/state-machine";
import { BuiltinYoInlineFunctions } from "../constants";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
} from "../utils";
import { generateOpAnd, generateOpOr } from "./and-or";
import { generateAnonymousArray, generateYoArrayFill } from "./array-fns";
import { generateAssignment } from "./assignment";
import { generateAsyncBlock, generateIoAsyncSyncCall } from "./async";
import { emitAsyncFutureEscape } from "./async-completion";
import { generateAtom } from "./atom";
import {
  emitIoSpawnEffectInjection,
  generateAwait,
  generateJoinHandleAwait,
  generateState,
} from "./await";
import { generateBegin } from "./begin";
import { generateBinding } from "./binding";
import { generateClosureConstruction, isClosureConstruction } from "./closures";
import {
  comptimeValueAllocatesRcObject,
  generateComptimeValue,
} from "./comptime-value";
import { generateCondExpression } from "./cond";
import { generateConsume } from "./consume";
import { generateDowncast } from "./downcast";
import { generateDeferredDupExpressions } from "./drop-dup";
import { generateDynCall } from "./dyn";
import { generateExpr } from "./expr";
import { generateYoGcCollect, generateYoGcTraceChild } from "./gc";
import { generateInitializationAssignment } from "./initialization-assignment";
import { generateYoInlineFunctionCall } from "./inline-fns";
import {
  generateIsoTypeCall,
  generateYoIsoDispose,
  generateYoIsoExtract,
  isIsoTypeCall,
} from "./iso";
import { generateMatchExpression } from "./match";
import { generateOpen } from "./open";
import {
  generateOtherFunctionCall,
  storeTempVarToStateMachineIfNeeded,
} from "./other-fn-call";
import { generatePanic } from "./panic";
import { generateAsm, generateGlobalAsm } from "./asm";
import { generateYoThreadSetMaximumThreads } from "./parallelism";
import { generateFieldAccess } from "./property-access";
import { generateAddressOf } from "./ptr-fns";
import {
  generateDrop,
  generateDup,
  generateRcCall,
  generateYoDecrRc,
  generateYoDecrRcAtomic,
  generateYoDropArrayElement,
  generateYoDropTupleElement,
  generateYoDupArrayElement,
  generateYoDupTupleElement,
  generateYoDynDrop,
  generateYoDynDup,
  generateYoIncrRc,
  generateYoIncrRcAtomic,
  generateYoRcOwn,
  generateYoSomeTypeDrop,
  generateYoSomeTypeDup,
} from "./rc-fns";
import { generateRecur } from "./recur";
import {
  generatePendingDeferredDrops,
  generateConsumedVarDropsForEscape,
  generateReturn,
} from "./return";
import { generateSizeOf } from "./sizeof";
import { generateAnonymousTuple } from "./tuple-fn";
import { generateTypeId } from "./typeid";
import { generateWhileLoop } from "./while";

let indexTraitTempCounter = 0;

/**
 * Generate C code for Index trait dispatch: value(i) → *index_fn(&value, i)
 * The index method returns a pointer, and we auto-deref it unless
 * this is wrapped in &() (isIndexTraitAddressOf).
 */
function generateIndexTraitCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const methodValue = expr.$?.indexMethodValue;
  if (!methodValue || !isFunctionValue(methodValue)) {
    return `/* Error: Index trait method value missing */`;
  }

  // Generate &callee (address-of the receiver)
  const calleeExpr = expr.func!;
  let calleeCode = generateExpr(calleeExpr, indent, context);

  // If the callee is a function call returning a temporary (rvalue), we can't
  // take its address directly. Emit it into a temp variable first.
  // IMPORTANT: Property access (`.` calls) generates lvalue C code (e.g.,
  // `self->_buf`), so we must NOT copy those into temps — writes to the temp
  // would not affect the original struct field.
  if (
    exprIsFunctionCall(calleeExpr) &&
    !exprIsAtom(calleeExpr) &&
    !exprIsFunctionCallOf(calleeExpr, ".") &&
    calleeExpr.$?.type
  ) {
    // Check if generateExpr already assigned a named variable
    const isAlreadyVariable =
      calleeExpr.$?.variableName &&
      calleeCode ===
        getVariableNameForCodegen(calleeExpr.$.variableName, calleeExpr.$.env);
    if (!isAlreadyVariable) {
      const calleeType = getTypeString(calleeExpr.$.type, context);
      const tempName = `__yo_idx_tmp_${indexTraitTempCounter++}`;
      context.emitter.emitLine(
        `${indent}${calleeType} ${tempName} = ${calleeCode};`
      );
      context.declaredCVarNames?.add(tempName);
      calleeCode = tempName;
    }
  }

  // Generate the index argument
  const indexArg = expr.args[0];
  const indexCode = indexArg ? generateExpr(indexArg, indent, context) : "0";

  // Determine the call code: inline builtin body or call the specialized function
  let callCode: string;
  const inlineOp =
    isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(methodValue);
  if (inlineOp) {
    // Inline the builtin expansion directly at the call site.
    // This avoids generating a standalone C function for the specialized method.
    // Element index: __yo_array_index → &(self->data[idx])
    if (BuiltinFunctions.__yo_array_index.includes(inlineOp)) {
      callCode = `(&((&${calleeCode})->data[${indexCode}]))`;
    } else {
      // Fallback: call the function by name
      const cFuncName = context.functions[methodValue.funcId]?.cName;
      if (!cFuncName) {
        return `/* Error: Index method ${methodValue.funcId} not found in function registry */`;
      }
      callCode = `${cFuncName}(&${calleeCode}, ${indexCode})`;
    }
  } else {
    // Non-inline method: call the specialized function by name
    const cFuncName = context.functions[methodValue.funcId]?.cName;
    if (!cFuncName) {
      return `/* Error: Index method ${methodValue.funcId} not found in function registry */`;
    }
    callCode = `${cFuncName}(&${calleeCode}, ${indexCode})`;
  }

  // Deref unless this is an &(value(i)) expression
  if (expr.$?.isIndexTraitAddressOf) {
    return callCode;
  }

  // Deref the pointer returned by the index method.
  // Note: For RC types, the evaluator handles dup via setExprAsNeedsToCallDup
  // when the result is consumed (assignment, function argument, return).
  // We do NOT dup inline here, as that would leak for unassigned uses like y(0).*.
  return `(*${callCode})`;
}

/**
 * Generate C code for `escape(value)` — ctl handler discontinue.
 *
 * Inside a ctl handler body, `escape(value)` discards the continuation
 * and returns from the enclosing function with the given value.
 * In C codegen, this translates to dropping handler params then `return <value>;`.
 */
function generateUnwind(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const functionContext = context as FunctionGenerationContext;
  const arg = expr.args[0];

  // Check if we're inside a resume handler's body (nested escape).
  // If so, the escape should set the outer handler's result variable and
  // goto its exit label instead of doing a C `return`.
  const resumeInfo = functionContext.continuationVariables?.get("resume");
  const hasDirectExit =
    resumeInfo && "directReturnVar" in resumeInfo && resumeInfo.directExitLabel;

  if (hasDirectExit) {
    // Nested escape: assign to outer handler's result var and goto exit label
    if (arg) {
      const argCode = generateExpr(arg, indent, context);
      // Emit handler param drops before the goto
      if (functionContext.effectHandlerParamDrops) {
        for (const dropCode of functionContext.effectHandlerParamDrops) {
          functionContext.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
      functionContext.emitter.emitLine(
        `${indent}${resumeInfo.directReturnVar} = ${argCode};`
      );
      functionContext.emitter.emitLine(
        `${indent}goto ${resumeInfo.directExitLabel};`
      );
    } else {
      // Emit handler param drops before the goto
      if (functionContext.effectHandlerParamDrops) {
        for (const dropCode of functionContext.effectHandlerParamDrops) {
          functionContext.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
      functionContext.emitter.emitLine(
        `${indent}goto ${resumeInfo.directExitLabel};`
      );
    }
    return "";
  }

  // Normal escape: emit a C `return` from the enclosing function.
  // Must drop local variables from enclosing scopes (pendingDeferredDrops)
  // before returning, to avoid memory leaks.
  // Use skipEnvCheck=true because the escape expression's environment is from
  // the handler's scope, not the enclosing function's scope where the
  // local variables actually live.

  // In async state machine context, escape must properly mark the Future as
  // ABORTED (-2) and notify any waiting continuation, instead of just returning
  // from the resume function (which would leave the Future stuck in an
  // intermediate state forever).
  if (functionContext.inAsyncStateMachine) {
    const emitter = functionContext.emitter;

    // Compute the unwind value for side effects, but don't store it as the
    // Future's result — the unwind value's type matches the enclosing fn's
    // return type, which may differ from the Future's result type.
    if (arg) {
      const argCode = generateExpr(arg, indent, context);
      // If the computed value is non-trivial, emit it as a statement for side effects
      if (argCode && argCode !== "(void)0") {
        emitter.emitLine(`${indent}(void)${argCode};`);
      }
    }

    // Emit handler param drops
    if (functionContext.effectHandlerParamDrops) {
      for (const dropCode of functionContext.effectHandlerParamDrops) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }

    // Drop pending local variables from enclosing scopes
    generatePendingDeferredDrops(
      indent,
      functionContext,
      expr,
      false,
      true,
      true
    );
    generateConsumedVarDropsForEscape(indent, functionContext, expr, true);

    emitAsyncFutureEscape({
      emitter,
      indent,
      debugLabel: functionContext.currentFunctionName,
    });
    return ``;
  }

  // effect record member function (e.g., Exception.throw handler):
  // Set thread-local flag so the calling SM knows this handler escaped.
  // Always set for any function that uses unwind (Phase 2).
  functionContext.emitter.emitLine(`${indent}__yo_effect_escaped = 1;`);

  if (!arg) {
    // Emit handler param drops before returning
    if (functionContext.effectHandlerParamDrops) {
      for (const dropCode of functionContext.effectHandlerParamDrops) {
        functionContext.emitter.emitLine(`${indent}${dropCode};`);
      }
    }
    generatePendingDeferredDrops(
      indent,
      functionContext,
      expr,
      false,
      true,
      true
    );
    // Suppress consumed-variable drops in effect-record-member (ctl)
    // handler bodies — those drops belong to the caller's scope. See the
    // matching guard below the arg-eval path.
    if (!functionContext.isEffectRecordMemberFunction) {
      generateConsumedVarDropsForEscape(indent, functionContext, expr, true);
    }
    // For functions with non-void return type, return a dummy value
    // (the caller checks __yo_effect_escaped and ignores the return value).
    // Phase B of plans/ITERATOR_REDESIGN.md — for `-> ref(T)` functions,
    // the C-level return is `T*` (a pointer). The dummy must be NULL of
    // that pointer type, not `(T){0}` (which is a value of T).
    if (functionContext.currentFunctionType) {
      const returnType = functionContext.currentFunctionType.return.type;
      if (!isUnitType(returnType)) {
        let returnTypeStr =
          functionContext.overrideReturnTypeStr ??
          getTypeString(returnType, context);
        if (
          functionContext.currentFunctionType.return.isRef &&
          !returnTypeStr.endsWith("*")
        ) {
          returnTypeStr = `${returnTypeStr}*`;
        }
        if (returnTypeStr !== "void") {
          return `return (${returnTypeStr}){0}`;
        }
      }
    }
    return `return`;
  }
  // Snapshot drop list lengths BEFORE arg evaluation. Drops added during
  // arg evaluation belong to the value being escaped — that value is
  // transferred to the handler installation site via __yo_unwind_value,
  // so its ownership escapes with it and we must not emit drops for it here.
  const consumedDropsBaselineForEscapeArg =
    functionContext.consumedVarPendingDrops?.length ?? 0;
  const pendingDropsBaselineForEscapeArg =
    functionContext.pendingDeferredDrops?.length ?? 0;
  const argCode = generateExpr(arg, indent, context);
  if (
    functionContext.consumedVarPendingDrops &&
    functionContext.consumedVarPendingDrops.length >
      consumedDropsBaselineForEscapeArg
  ) {
    functionContext.consumedVarPendingDrops.length =
      consumedDropsBaselineForEscapeArg;
  }
  if (
    functionContext.pendingDeferredDrops &&
    functionContext.pendingDeferredDrops.length >
      pendingDropsBaselineForEscapeArg
  ) {
    functionContext.pendingDeferredDrops.length =
      pendingDropsBaselineForEscapeArg;
  }
  // Also remove any pre-existing drop whose target variable IS the escape
  // argument's resulting C expression (e.g., a temp var holding the freshly
  // allocated unwind value, scheduled by the enclosing begin block as a
  // "consumed-by-return-value" drop). The value's ownership escapes via
  // __yo_unwind_value, so dropping it here would cause a use-after-free
  // at the handler installation site.
  const argCodeTrimmed = (argCode ?? "").trim();
  if (argCodeTrimmed && functionContext.consumedVarPendingDrops) {
    functionContext.consumedVarPendingDrops =
      functionContext.consumedVarPendingDrops.filter((dropExpr) => {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        return varName !== argCodeTrimmed;
      });
  }
  if (argCodeTrimmed && functionContext.pendingDeferredDrops) {
    functionContext.pendingDeferredDrops =
      functionContext.pendingDeferredDrops.filter((dropExpr) => {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        return varName !== argCodeTrimmed;
      });
  }
  // Emit handler param drops before returning
  if (functionContext.effectHandlerParamDrops) {
    for (const dropCode of functionContext.effectHandlerParamDrops) {
      functionContext.emitter.emitLine(`${indent}${dropCode};`);
    }
  }
  generatePendingDeferredDrops(
    indent,
    functionContext,
    expr,
    false,
    true,
    true
  );
  // Suppress consumed-variable drops when we are emitting a separate
  // effect-record-member (ctl) handler function: the drops were recorded
  // against variables in the *caller's* scope (the function that
  // installed this handler), not against any variables visible in this
  // handler body, so emitting them here references undeclared C
  // identifiers. The caller's own drops still run at the handler
  // installation site after `__yo_effect_escaped` is observed.
  if (!functionContext.isEffectRecordMemberFunction) {
    generateConsumedVarDropsForEscape(indent, functionContext, expr, true);
  }
  // For effect record members or evidence-passing functions:
  // store unwind value in thread-local buffer for retrieval at handler
  // installation site, then return a dummy value.
  // The unwind value type may differ from the handler's C return type.
  if (
    (functionContext.isEffectRecordMemberFunction ||
      (functionContext.currentEvidenceParams &&
        functionContext.currentEvidenceParams.size > 0)) &&
    functionContext.currentFunctionType
  ) {
    const argType = arg.$?.type;
    if (argType && !isUnitType(argType)) {
      const argTypeStr = getTypeString(argType, context);
      functionContext.emitter.emitLine(
        `${indent}{ ${argTypeStr} _unw_val = ${argCode}; memcpy(__yo_unwind_value, &_unw_val, sizeof(${argTypeStr})); }`
      );
    }
    const returnType = functionContext.currentFunctionType.return.type;
    if (!isUnitType(returnType)) {
      let returnTypeStr =
        functionContext.overrideReturnTypeStr ??
        getTypeString(returnType, context);
      if (
        functionContext.currentFunctionType.return.isRef &&
        !returnTypeStr.endsWith("*")
      ) {
        returnTypeStr = `${returnTypeStr}*`;
      }
      if (returnTypeStr !== "void") {
        return `return (${returnTypeStr}){0}`;
      }
    }
    return `return`;
  }
  return `return ${argCode}`;
}

/**
 * Some compile-time values ALLOCATE when they materialize in C. The clearest
 * case is a payload-free variant of a reference-semantics enum: its comptime
 * value emits `__yo_new_<Enum>_<Variant>()`, which mallocs with
 * `ref_count = 1`. Inlined at the use site that produces an owned RC object
 * nothing ever drops — `f(E.UnitVal)` leaks it, because the callee treats the
 * parameter as borrowed and dups whatever it retains.
 *
 * When the evaluator recorded such an expression as owning its RC value
 * (`attachTempVariableToExpr(expr, true)`), it registered a temp variable at
 * the enclosing begin-block frame so the normal scope-end drop pass releases
 * it. That only works if codegen actually DECLARES the temp: the drop emitters
 * skip any target missing from `declaredCVarNames`. So materialize the value
 * into its temp and hand back the temp's name.
 *
 * Non-allocating comptime values (numbers, string literals, value-enum
 * compound literals like `Color.Red`) carry no owning temp and are returned
 * unchanged.
 */
function materializeOwnedRcComptimeValue(
  expr: Expr,
  comptimeCode: string,
  indent: string,
  context: CodeGenContext
): string {
  const info = expr.$;
  if (!info?.variableName || !info.value) {
    return comptimeCode;
  }
  const { variableName, env, type } = info;
  // Only shapes that actually malloc need an owner (see the predicate's doc).
  if (!comptimeValueAllocatesRcObject(info.value)) {
    return comptimeCode;
  }
  if (!isTempVariableName(env.modulePath, variableName)) {
    return comptimeCode;
  }
  const variables = getVariablesFromEnv(env, variableName);
  const variable = variables[variables.length - 1];
  if (!variable?.isOwningTheRcValue) {
    return comptimeCode;
  }
  const cName = getVariableNameForCodegen(variableName, env);
  context.emitter.emitLine(
    `${indent}${getVariableTypeString(type, cName, context)} = ${comptimeCode};`
  );
  storeTempVarToStateMachineIfNeeded(variableName, indent, context);
  return cName;
}

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function _generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  let result: string;

  switch (expr.tag) {
    case ExprTag.FnCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context, indent);
      break;
  }

  return result;
}

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle macro function calls (functions with isUnquote return type)
  // If expr.$.macroExpansion is set, this macro call has already been expanded
  // during evaluation. Generate code for the expanded form instead.
  if (expr.$?.macroExpansion) {
    return generateExpr(expr.$.macroExpansion, indent, context);
  }

  // Handle method calls to ___drop/___dup on SomeType with resolvedConcreteType.
  // These are wrapper functions that were not collected during function collection
  // because they just call builtins. We handle them here by dispatching to the
  // concrete type's methods or using the appropriate ref-counting operation.
  if (
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 2) &&
    expr.func.args[1] &&
    exprIsAtom(expr.func.args[1])
  ) {
    const methodName = expr.func.args[1].token.value;
    const receiverExpr = expr.func.args[0];
    const receiverType = receiverExpr?.$?.type;

    if (
      receiverType &&
      isSomeType(receiverType) &&
      typeImplementsFuture(receiverType)
    ) {
      // SomeType implementing Future - ALWAYS use ref-counting operations directly.
      // Futures are heap-allocated state machines (pointers), not value types.
      // The resolvedConcreteType might be the capture struct (value type), but we can't
      // dispatch to its ___drop/___dup because those expect struct values, not pointers.
      // The state machine manages its own memory and uses ref-counting.
      if (methodName === BuiltinFunctions.___drop[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `if (${receiverCode} != NULL) { __yo_decr_rc((void*)${receiverCode}); }`;
      }

      if (methodName === BuiltinFunctions.___dup[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `__yo_incr_rc((void*)${receiverCode})`;
      }
    }
  }

  // Handle anonymous function/closure construction
  if (isClosureConstruction(expr)) {
    return generateClosureConstruction(expr, indent, context);
  }

  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    return generateYoDecrRc(expr, indent, context);
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    return generateYoIncrRc(expr, indent, context);
  }

  // __yo_rc_own - return the value itself, used for transferring ownership
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
    return generateYoRcOwn(expr, indent, context);
  }

  // __yo_drop_array_element - drop array element at index without borrowing
  // This is used when dropping arrays to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_array_element)) {
    return generateYoDropArrayElement(expr, indent, context);
  }

  // __yo_dup_array_element - dup array element at index without borrowing
  // This is used when duping arrays to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_array_element)) {
    return generateYoDupArrayElement(expr, indent, context);
  }

  // __yo_drop_tuple_element - drop tuple element at index without borrowing
  // This is used when dropping tuples to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_tuple_element)) {
    return generateYoDropTupleElement(expr, indent, context);
  }

  // __yo_dup_tuple_element - dup tuple element at index without borrowing
  // This is used when duping tuples to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_tuple_element)) {
    return generateYoDupTupleElement(expr, indent, context);
  }

  // ___dup - generic dup hook used by evaluator for reference-counted values.
  // In many cases the evaluator rewrites `___dup(x)` into `x.___dup()`, but in
  // some contexts (e.g. deferred dup for dyn-closure captures) the builtin call
  // is intentionally deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___dup)) {
    return generateDup(expr, indent, context);
  }

  // ___drop - generic drop hook used by evaluator for reference-counted values.
  // Similar to ___dup, some drops are deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___drop)) {
    return generateDrop(expr, indent, context);
  }

  // __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
    return generateYoDynDrop(expr, indent, context);
  }

  // __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
    return generateYoDynDup(expr, indent, context);
  }

  // __yo_incr_rc_atomic - atomic reference count increment for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc_atomic)) {
    return generateYoIncrRcAtomic(expr, indent, context);
  }

  // __yo_decr_rc_atomic - atomic reference count decrement for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc_atomic)) {
    return generateYoDecrRcAtomic(expr, indent, context);
  }

  // __yo_iso_extract - extract inner value from Iso type
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_extract)) {
    return generateYoIsoExtract(expr, indent, context);
  }

  // __yo_iso_dispose - dispose inner value of Iso if not extracted
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_dispose)) {
    return generateYoIsoDispose(expr, indent, context);
  }

  // Iso(T)(value) - Iso value constructor
  // Check if this is a call to an Iso type constructor (not just any expression returning Iso type)
  // The function being called must be a TypeValue containing an IsoType
  if (isIsoTypeCall(expr)) {
    return generateIsoTypeCall(expr, indent, context);
  }

  // __yo_sometype_drop - dispatch to resolvedConcreteType's ___drop if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)) {
    return generateYoSomeTypeDrop(expr, indent, context);
  }

  // __yo_sometype_dup - dispatch to resolvedConcreteType's ___dup if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_dup)) {
    return generateYoSomeTypeDup(expr, indent, context);
  }

  // __yo_gc_collect - trigger garbage collection
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
    return generateYoGcCollect(expr, indent, context);
  }

  // __yo_gc_trace_child - per-value edge tracer (body of GcTracer.visit)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_trace_child)) {
    return generateYoGcTraceChild(expr, indent, context);
  }

  // rc - get the reference count of a value
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
    return generateRcCall(expr, indent, context);
  }

  // panic - print error message and call abort() [C stdlib]
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_panic)) {
    return generatePanic(expr, indent, context);
  }

  // asm - inline assembly
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.asm)) {
    return generateAsm(expr, indent, context);
  }

  // global_asm - module-level assembly
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.global_asm)) {
    return generateGlobalAsm(expr, indent, context);
  }

  // test - test declaration, skipped during normal compilation
  // Tests are handled by the test runner which generates a main function for each test
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
    // No-op: test declarations produce no C code
    return `/* test declaration skipped */`;
  }

  // __yo_thread_set_maximum_threads - set maxmium number of threads for coroutine schedular
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_thread_set_maximum_threads)
  ) {
    return generateYoThreadSetMaximumThreads(expr, indent, context);
  }

  // op_and - && operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)) {
    return generateOpAnd(expr, indent, context);
  }

  // op_or - || operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)) {
    return generateOpOr(expr, indent, context);
  }

  // io.async(closure) - with await points: generates a state machine (same as async block)
  // io.async(closure) - without await points: creates a sync Future by calling closure immediately
  if (isIoAsyncCall(expr)) {
    if (expr.$?.awaitAnalysis) {
      return generateAsyncBlock(expr, indent, context);
    }
    return generateIoAsyncSyncCall(expr, indent, context);
  }

  // dyn() - dynamic dispatch constructor
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
    return generateDynCall(expr, indent, context);
  }

  // io.await(future) - extract value from Future (via Io module)
  if (isIoAwaitCall(expr)) {
    return generateAwait(expr, indent, context);
  }

  // io.state(future) - read the state of a Future without awaiting it
  if (isIoStateCall(expr)) {
    return generateState(expr, indent, context);
  }

  // io.spawn(future) - start a cold Future and return JoinHandle
  if (isIoSpawnCall(expr)) {
    const futureArg = expr.args[0];
    if (!futureArg) {
      return `// Error: spawn requires a Future argument`;
    }
    const functionContext = context as FunctionGenerationContext;
    const emitter = functionContext.emitter;
    const futureCode = generateExpr(futureArg, indent, context);
    const futureType = futureArg.$?.type;
    const futureTypeName = futureType
      ? getTypeString(futureType, context)
      : "void*";

    // Get the JoinHandle type from the spawn expression's result type
    const joinHandleType = expr.$?.type;
    const joinHandleTypeName = joinHandleType
      ? getTypeString(joinHandleType, context)
      : null;

    const spawnVar = expr.$?.variableName
      ? `__spawn_future_${expr.$.variableName}`
      : `__spawn_future`;
    const spawnStateVar = expr.$?.variableName
      ? `__spawn_state_${expr.$.variableName}`
      : `__spawn_state`;
    emitter.emitLine(
      `${indent}// io.spawn — start cold Future, return JoinHandle`
    );
    emitter.emitLine(`${indent}${futureTypeName} ${spawnVar} = ${futureCode};`);
    emitter.emitLine(`${indent}int ${spawnStateVar} = ${spawnVar}->state;`);
    // Panic if already aborted
    emitter.emitLine(`${indent}if (${spawnStateVar} == -2) {`);
    emitter.emitLine(
      `${indent}  fprintf(stderr, "panic: attempted to spawn an aborted Future\\n");`
    );
    emitter.emitLine(`${indent}  abort();`);
    emitter.emitLine(`${indent}}`);
    // Phase 7: inject the bundle effect (e.g. `IoExn(io, exn)`) into the
    // future's SM via its set_effect callback BEFORE cold-starting. This is
    // the same mechanism used by io.await — see emitEffectInjectionForAwait
    // and src/codegen/exprs/async.ts:findBundleFieldName.
    emitIoSpawnEffectInjection(expr, spawnVar, indent, context);

    const isIoFuture = isIoFutureType(futureArg.$?.type);
    if (!isIoFuture) {
      emitter.emitLine(
        `${indent}if (${spawnStateVar} == 0 && ${spawnVar}->__yo_resume_fn) {`
      );
      emitter.emitLine(`${indent}  __yo_incr_rc((void*)${spawnVar});`);
      emitter.emitLine(
        `${indent}  ${spawnVar}->__yo_resume_fn((void*)${spawnVar});`
      );
      emitter.emitLine(`${indent}}`);
    }
    // Return a JoinHandle struct wrapping the future pointer (non-owning view)
    if (joinHandleTypeName) {
      return `(${joinHandleTypeName}){ .__future = (void*)${spawnVar} }`;
    }
    return `(void*)${spawnVar}`;
  }

  // JoinHandle.await(using(io)) - await spawned task, return Option(T)
  if (isJoinHandleAwaitCall(expr)) {
    return generateJoinHandleAwait(expr, indent, context);
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    return generateReturn(expr, indent, context);
  }

  // escape(value) — ctl handler discontinue keyword
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) {
    return generateUnwind(expr, indent, context);
  }

  // __yo_array_fill builtin (handled similarly to Array.fill)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_array_fill, 2)) {
    return generateYoArrayFill(expr, indent, context);
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    return generateBinding(expr, indent, context);
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    const result = generateInitializationAssignment(expr, indent, context);
    if (result !== undefined) {
      return result;
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    return generateAssignment(expr, indent, context);
  }
  // already computed and it's not unit value
  // Skip this optimization if controlFlow is set (e.g., escape/return) because
  // we need to generate the actual control flow code, not just the value.
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type) &&
    !hasAnyControlFlow(expr.$?.controlFlow)
  ) {
    const comptimeCode = generateComptimeValue(expr.$.value, context, expr);
    return materializeOwnedRcComptimeValue(expr, comptimeCode, indent, context);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    return generateBegin(expr, indent, context);
  }
  // cond
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return generateCondExpression(expr, indent, context);
  }
  // match
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    return generateMatchExpression(expr, indent, context);
  }
  // ptr value
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1)) {
    return generateAddressOf(expr, indent, context);
  }
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    return generateAnonymousTuple(expr, indent, context);
  }
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
    const result = generateAnonymousArray(expr, indent, context);
    if (result !== undefined) {
      return result;
    }
  }
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    return generateRecur(expr, indent, context);
  }
  // runtime - just generate the inner expression (conversion happens at evaluation time)
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.runtime, 1)) {
    return generateExpr(expr.args[0]!, indent, context);
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    return generateSizeOf(expr, indent, context);
  }
  // typeid
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeid, 1)) {
    return generateTypeId(expr, indent, context);
  }
  // downcast
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.downcast, 2)) {
    return generateDowncast(expr, indent, context);
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    // NOTE: || expr.args is necessary to support function call like __yo_as(i, i32);
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder || expr.args;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      const args = runtimeArgExprs.map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for inline function arguments
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            return getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        return argCode;
      });

      return generateYoInlineFunctionCall(
        expr.func.token.value,
        args,
        expr,
        context,
        indent
      );
    }
  }
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // anonymous function (fn(x) -> body)
  else if (
    exprIsFunctionCallOf(expr, "->", 2) &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
  ) {
    // Anonymous functions should have been evaluated and have a function value
    const functionValue = expr.$?.value;
    if (isFunctionValue(functionValue)) {
      return generateComptimeValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // closure / lambda (x => body) or (x =>> body)
  else if (
    exprIsFunctionCallOf(expr, "=>", 2) ||
    exprIsFunctionCallOf(expr, "=>>", 2)
  ) {
    // Skip closure-type annotations (fn(x : T) => U); only handle implementations
    const isClosureType =
      exprIsFunctionCall(expr.args[0]) &&
      exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn);
    if (!isClosureType) {
      const functionValue = expr.$?.value;
      if (isFunctionValue(functionValue)) {
        return generateComptimeValue(functionValue, context);
      } else {
        return `// Error: Anonymous closure missing function value`;
      }
    }
  }
  // consume
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
    return generateConsume(expr, indent, context);
  }
  // unsafe(expr) — pure compile-time marker, lowers to its inner
  // expression. See plans/MEMORY_SAFETY.md.
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.unsafe)) {
    return generateExpr(expr.args[0]!, indent, context);
  }
  // old(expr) — Phase 0 transparent pass-through. Later phases will
  // snapshot the value at function entry; for now it lowers to the
  // inner expression. See plans/FORMAL_VERIFICATION.md.
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.old)) {
    return generateExpr(expr.args[0]!, indent, context);
  }
  // ghost_fn(fn_value) — Phase 0 transparent pass-through. Later
  // phases erase ghost functions entirely; this site is reachable in
  // Phase 0 only if the ghost function is called from non-ghost code,
  // which the verifier will eventually forbid.
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.ghost_fn)) {
    return generateExpr(expr.args[0]!, indent, context);
  }
  // functions that should be skipped
  // comptime_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_expect_error) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_assert) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_var_is_owning_the_rc_value
    ) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases) ||
    // Phase 0 contract markers — no C output. requires/ensures inside
    // function signatures are skipped during signature processing;
    // these branches catch contract markers appearing in other
    // positions (e.g. invariant in a loop body) so they don't leak to
    // codegen. See plans/FORMAL_VERIFICATION.md.
    exprIsFunctionCallOf(expr, BuiltinFunctions.requires) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.ensures) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.invariant) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.ghost)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // open for runtime struct
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
    return generateOpen(expr, indent, context);
  }
  // Index trait dispatch: value(i) → *index_fn(&value, i)
  else if (expr.$?.indexTraitPtrType && expr.$?.indexMethodType) {
    return generateIndexTraitCall(expr, indent, context);
  }
  // other function call
  else {
    const result = generateOtherFunctionCall(expr, indent, context);
    if (result !== undefined) {
      return result;
    }
  }

  if (exprIsFunctionCall(expr)) {
    throw new Error(`Unhandled function call: ${exprToString(expr)}`);
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}
