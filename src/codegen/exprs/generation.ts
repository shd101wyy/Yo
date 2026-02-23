import {
  isIoAsyncCall,
  isIoAwaitCall,
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
} from "../../expr";
import { isSomeType, isUnitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  isFunctionValue,
  isTypeValue,
  isUnknownValue,
  type Value,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import type { FunctionGenerationContext } from "../functions/context";
import { type CodeGenContext, getVariableNameForCodegen } from "../utils";
import { generateOpAnd, generateOpOr } from "./and-or";
import { generateAnonymousArray, generateYoArrayFill } from "./array-fns";
import { generateAssignment } from "./assignment";
import { generateAsyncBlock, generateIoAsyncSyncCall } from "./async";
import { generateAtom } from "./atom";
import { generateAwait } from "./await";
import { generateBegin } from "./begin";
import { generateBinding } from "./binding";
import { generateClosureConstruction, isClosureConstruction } from "./closures";
import { generateComptimeValue } from "./comptime-value";
import { generateCondExpression } from "./cond";
import { generateConsume } from "./consume";
import { generateDeferredDupExpressions } from "./drop-dup";
import { generateDynCall } from "./dyn";
import { generateExpr } from "./expr";
import { generateYoGcCollect } from "./gc";
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
import { generateOtherFunctionCall } from "./other-fn-call";
import { generatePanic } from "./panic";
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
import { generatePendingDeferredDrops, generateReturn } from "./return";
import { generateSizeOf } from "./sizeof";
import { generateAnonymousTuple } from "./tuple-fn";
import { generateWhileLoop } from "./while";

/**
 * Generate C code for `abort(value)` — ctl handler discontinue.
 *
 * Inside a ctl handler body, `abort(value)` discards the continuation
 * and returns from the enclosing function with the given value.
 * In C codegen, this translates to dropping handler params then `return <value>;`.
 */
function generateAbort(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const functionContext = context as FunctionGenerationContext;
  const arg = expr.args[0];

  // Check if we're inside a resume handler's body (nested abort).
  // If so, the abort should set the outer handler's result variable and
  // goto its exit label instead of doing a C `return`.
  const resumeInfo = functionContext.continuationVariables?.get("resume");
  const hasDirectExit =
    resumeInfo && "directReturnVar" in resumeInfo && resumeInfo.directExitLabel;

  if (hasDirectExit) {
    // Nested abort: assign to outer handler's result var and goto exit label
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

  // Normal abort: emit a C `return` from the enclosing function.
  // Must drop local variables from enclosing scopes (pendingDeferredDrops)
  // before returning, to avoid memory leaks.
  // Use skipEnvCheck=true because the abort expression's environment is from
  // the handler's scope, not the enclosing function's scope where the
  // local variables actually live.
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
      false,
      true
    );
    return `return`;
  }
  const argCode = generateExpr(arg, indent, context);
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
    false,
    true
  );
  return `return ${argCode}`;
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

  // rc - get the reference count of a value
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
    return generateRcCall(expr, indent, context);
  }

  // panic - print error message and abort execution
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
    return generatePanic(expr, indent, context);
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

  // async - async block that creates a Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return generateAsyncBlock(expr, indent, context);
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

  // await - extract value from Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
    return generateAwait(expr, indent, context);
  }

  // io.await(future) - extract value from Future (via IO module)
  if (isIoAwaitCall(expr)) {
    return generateAwait(expr, indent, context);
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    return generateReturn(expr, indent, context);
  }

  // abort(value) — ctl handler discontinue keyword
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.abort)) {
    return generateAbort(expr, indent, context);
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
  // Skip this optimization if controlFlow is set (e.g., abort/return) because
  // we need to generate the actual control flow code, not just the value.
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type) &&
    !expr.$?.controlFlow
  ) {
    const value: Value = expr.$.value;
    return generateComptimeValue(value, context, expr);
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
  // consume
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
    return generateConsume(expr, indent, context);
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
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // open for runtime struct
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
    return generateOpen(expr, indent, context);
  }
  // other function call
  else {
    const result = generateOtherFunctionCall(expr, indent, context);
    if (result !== undefined) {
      return result;
    }
  }

  if (exprIsFunctionCall(expr)) {
    const fnCallExpr = expr as FnCallExpr;
    const funcType = fnCallExpr.func.$?.type;
    const funcValue = fnCallExpr.func.$?.value;
    throw new Error(
      `Unhandled function call: ${exprToString(expr)}\n` +
        `  expr.$.value: ${expr.$?.value}, isUnknown: ${expr.$?.value !== undefined ? isUnknownValue(expr.$!.value!) : "N/A"}\n` +
        `  expr.$.type: ${expr.$?.type ? typeToString(expr.$.type) : "undefined"}\n` +
        `  func.$.type: ${funcType ? typeToString(funcType) : "undefined"}\n` +
        `  func.$.value type: ${typeof funcValue}, isFV: ${funcValue ? isFunctionValue(funcValue) : "N/A"}, isTV: ${funcValue ? isTypeValue(funcValue) : "N/A"}\n` +
        `  func.$.value: ${funcValue}`
    );
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}
