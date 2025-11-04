import { Environment, getVariablesFromEnv } from "../../env";
import {
  AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { TypeValue } from "../../type-value";
import {
  ArrayType,
  ClosureType,
  FutureType,
  isArrayType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isFutureType,
  isMutPtrType,
  isObjectType,
  isSliceType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  ModuleType,
  SliceType,
  StructType,
  Type,
  typeContainsARCType,
  TypeTag,
  typeToString,
} from "../../types";
import {
  isArrayValue,
  isBooleanValue,
  isComptStringValue,
  isEnumValue,
  isFunctionValue,
  isNumberValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "../../value";
import {
  analyzeAwaitPoints,
  AwaitAnalysisResult,
} from "../async/await-analysis";
import {
  generateAsyncBlockResumeFunction,
  getStateMachineFieldName,
} from "../async/state-machine";
import { BuiltinYoInlineFunctions } from "../constants";
import { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import { generateArrayFillCall, isArrayFillMethodCall } from "./array";

/**
 * Check if a variable is captured by the closure or is a local variable.
 * A variable is captured if the latest variable with that name exists at a frame level
 * that is <= the closure capture frame level.
 * Variables at higher frame levels (more recent scopes) are local variables.
 */
function checkVariableIsClosureCaptured(
  variableName: string,
  env: Environment,
  closureCaptureFrameLevel: number
): boolean {
  // Get all variables with this name, ordered from oldest to newest
  const variables = getVariablesFromEnv(env, variableName);

  if (variables.length === 0) {
    // Variable not found in environment - assume it's not captured
    return false;
  }

  // Get the latest (most recent) variable with this name
  const latestVariable = variables[variables.length - 1]!;

  // Check if it's from a captured frame level
  return latestVariable.frameLevel <= closureCaptureFrameLevel;
}

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  let result: string;

  switch (expr.tag) {
    case ExprTag.FuncCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context);
      break;
  }

  return result;
}

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;

  // Handle macro function calls (functions with isUnquote return type)
  // If expr.$.macroExpansion is set, this macro call has already been expanded
  // during evaluation. Generate code for the expanded form instead.
  if (expr.$?.macroExpansion) {
    return generateExpr(expr.$.macroExpansion, indent, context);
  }

  // Handle anonymous function/closure construction
  // If expr.$.closureFunctionValue is set, this is a closure that needs to be constructed
  if (
    expr.$?.closureFunctionValue &&
    expr.$?.type &&
    isClosureType(expr.$.type)
  ) {
    const closureType = expr.$.type;
    const closureFunctionValue = expr.$.closureFunctionValue;
    const captureType = expr.$.captureType;

    const functionCName = (context as FunctionGenerationContext).functions[
      closureFunctionValue.funcId
    ]?.cName;

    if (!functionCName) {
      return `// Error: Closure implementation function not found in context`;
    }

    const closureTypeEntry = context.types[closureType.id];

    if (!closureTypeEntry) {
      return `// Error: Closure type not found in context`;
    }

    const closureCName = closureTypeEntry.cName;

    // Check if this closure has captures
    const hasCaptures =
      captureType &&
      isStructType(captureType) &&
      captureType.elements.length > 0;

    const constructorName = hasCaptures
      ? `__yo_create_${closureCName}`
      : `__yo_new_${closureCName}`;

    if (hasCaptures && captureType && isStructType(captureType)) {
      // Closure with captures
      const captureTypeEntry = Object.values(context.types).find(
        (entry) => entry.type === captureType
      );

      if (!captureTypeEntry) {
        return `// Error: Capture type not found for closure`;
      }

      const captureCName = captureTypeEntry.cName;

      // Get captured variable values
      // Dup expressions are created at evaluation time and don't have correct context for code generation
      // When in a closure or state machine, always use generateAtom for proper context-aware access
      // Otherwise, use dup expressions if available (they handle proper ARC semantics)
      const functionContext = context as FunctionGenerationContext;
      const inSpecialContext =
        functionContext.currentClosureCaptures !== undefined ||
        functionContext.inStateMachine !== undefined;

      const captureArgs = captureType.elements.map((element) => {
        // Find the dup expression for this variable by checking the variable name
        // capturedVariableDupExpressions only contains dup expressions for ARC types,
        // so we need to match by variable name, not by index
        let dupExpr: Expr | undefined;
        if (!inSpecialContext && expr.$?.capturedVariableDupExpressions) {
          for (const possibleDupExpr of expr.$.capturedVariableDupExpressions) {
            // Dup expression is in the form: ___dup(varName)
            // Extract the variable name from the first argument
            if (
              exprIsFunctionCall(possibleDupExpr) &&
              possibleDupExpr.args.length > 0 &&
              exprIsAtom(possibleDupExpr.args[0])
            ) {
              const varName = possibleDupExpr.args[0].token.value;
              if (varName === element.label) {
                dupExpr = possibleDupExpr;
                break;
              }
            }
          }
        }

        if (dupExpr) {
          return generateExpr(dupExpr, indent, context);
        }

        // Fallback: generate proper variable access using generateAtom
        // This handles closure context and state machine access properly
        const atomExpr: AtomExpr = {
          tag: ExprTag.Atom,
          token: element.exprs.expr.token,
          $: element.exprs.expr.$,
        };
        return generateAtom(atomExpr, context);
      });

      // Generate capture struct initialization
      const captureDataCode = `(${captureCName}){ ${captureArgs
        .map((arg, i) => {
          const element = captureType.elements[i];
          if (!element) {
            return `/* Error: missing element at index ${i} */`;
          }
          return `.${sanitizeForCIdentifier(element.label)} = ${arg}`;
        })
        .join(", ")} }`;

      // Generate a unique temporary variable name for the capture data
      const captureTempVar = `__capture_${closureType.id}_${Date.now()}`;

      // Allocate capture data on heap using standard C (no GNU extensions)
      // We'll emit this as separate statements before the constructor call
      emitter.emitLine(
        `${indent}${captureCName}* ${captureTempVar} = (${captureCName}*)__yo_malloc(sizeof(${captureCName}));`
      );
      emitter.emitLine(`${indent}*${captureTempVar} = ${captureDataCode};`);

      // Generate a unique closure instance ID combining closure type and capture type
      // This is necessary because the same closure type can have different capture types (e.g., in conditionals)
      // Strip type prefixes to avoid redundancy: closure_closure_xxx_struct_yyy -> xxx_yyy
      const closureIdPart = closureType.id.replace(/^closure_/, "");
      const captureIdPart = captureType.id.replace(/^struct_/, "");
      const closureInstanceId = `${closureIdPart}_${captureIdPart}`;

      // Generate a closure-instance-specific dispose function name
      // Each closure instance gets its own dispose function that knows how to clean up its specific capture type
      const closureDisposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;

      // Store the closure-capture mapping so we can generate the dispose function later
      if (!context.closureCaptureMap) {
        context.closureCaptureMap = new Map();
      }
      context.closureCaptureMap.set(closureInstanceId, {
        closureType,
        closureCName,
        captureType,
        captureCName,
      });

      // Cast function pointers to generic void* function types for constructor
      const callType = closureType.callType;
      const returnTypeStr = getTypeString(callType.return.type, context);
      const callParamList = callType.parameters
        .map((param) => {
          const paramTypeStr = getTypeString(param.type, context);
          return paramTypeStr;
        })
        .join(", ");

      const castCallFunction = `(${returnTypeStr} (*)(void*${callParamList ? ", " + callParamList : ""}))${functionCName}`;
      const castDisposeFunction = `(void (*)(void*))${closureDisposeFunctionName}`;

      return `${constructorName}(${captureTempVar}, ${castCallFunction}, ${castDisposeFunction})`;
    } else {
      // Closure without captures
      const callType = closureType.callType;
      const returnTypeStr = getTypeString(callType.return.type, context);
      const callParamList = callType.parameters
        .map((param) => {
          const paramTypeStr = getTypeString(param.type, context);
          return paramTypeStr;
        })
        .join(", ");

      const castCallFunction = `(${returnTypeStr} (*)(void*${callParamList ? ", " + callParamList : ""}))${functionCName}`;
      return `${constructorName}(${castCallFunction}, NULL)`;
    }
  }

  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_decr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_decr_rc(${selfCode})`;
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc(${selfCode})`;
  }

  // __yo_rc_own - return the value itself, used for transferring ownership
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_rc_own requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return selfCode; // Just return the argument as-is
  }

  // __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_drop requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Decrement RC - dispose function is stored in header
    return `__yo_decr_rc((void*)(${selfCode}))`;
  }

  // __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_dup requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Only increment the dyn object's own reference count, don't duplicate wrapped object
    return `__yo_incr_rc((void*)(${selfCode}))`;
  }

  // __yo_closure_drop - call dispose on closure via vtable then __yo_decr_rc on closure
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_closure_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_closure_drop requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Decrement RC - dispose function is stored in header
    return `__yo_decr_rc((void*)(${selfCode}))`;
  }

  // __yo_closure_dup - call __yo_incr_rc on closure
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_closure_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_closure_dup requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc((void*)(${selfCode}))`;
  }

  // __yo_future_drop - call __yo_decr_rc on future with special running check
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_future_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_future_drop requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Use a special dispose function that checks is_running flag
    return `__yo_future_drop((void*)(${selfCode}))`;
  }

  // __yo_future_dup - call __yo_incr_rc on future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_future_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_future_dup requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc((void*)(${selfCode}))`;
  }

  // __yo_gc_collect - trigger garbage collection
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
    if (expr.args.length !== 0) {
      return `// Error: __yo_gc_collect requires exactly 0 arguments`;
    }
    return `__yo_gc_collect()`;
  }

  // panic - print error message and abort execution
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
    // panic() never returns, so we need to handle it specially
    // We need to generate the panic code and then provide a dummy value for the assignment
    const returnType = expr.$?.type;
    if (!returnType) {
      return `// Error: panic() missing type information`;
    }

    if (expr.args.length === 0) {
      // No message provided, just call abort()
      emitter.emitLine(`${indent}abort();`);
    } else if (expr.args.length === 1) {
      // Message provided, print to stderr then abort
      const messageArg = expr.args[0]!;

      // The message should be a compile-time string value
      if (messageArg.$?.value && isComptStringValue(messageArg.$.value)) {
        const message = messageArg.$.value.value;
        emitter.emitLine(
          `${indent}fprintf(stderr, "%s\\n", ${JSON.stringify(message)});`
        );
        emitter.emitLine(`${indent}abort();`);
      } else {
        // Runtime message - generate code to evaluate it
        const messageCode = generateExpr(messageArg, indent, context);
        emitter.emitLine(`${indent}fprintf(stderr, "%s\\n", ${messageCode});`);
        emitter.emitLine(`${indent}abort();`);
      }
    } else {
      return `// Error: panic accepts 0 or 1 arguments, got ${expr.args.length}`;
    }

    // Since panic never returns, we need to provide a dummy value of the correct type
    // This code is unreachable but needed for C compilation
    const returnTypeStr = getTypeString(returnType, context);
    return `(*((${returnTypeStr}*)NULL))`; // This will never execute but has the right type
  }

  // __yo_concurrency_set_maximum_threads - set maxmium number of threads for coroutine schedular
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_concurrency_set_maximum_threads
    )
  ) {
    const numArg = expr.args[0];
    if (!numArg) {
      return `// Error: __yo_concurrency_set_maximum_threads requires exactly 1 argument`;
    }
    const numCode = generateExpr(numArg, indent, context);
    return `__yo_concurrency_set_maximum_threads(${numCode})`;
  }

  // op_and - && operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)) {
    if (expr.args.length === 0) {
      return `true`; // Empty && returns true
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 && arg2 && ... && argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" && ")})`;
  }

  // op_or - || operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)) {
    if (expr.args.length === 0) {
      return `false`; // Empty || returns false
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 || arg2 || ... || argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" || ")})`;
  }

  // async - async block that creates a Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return generateAsyncBlock(expr, indent, context);
  }

  // dyn() - dynamic dispatch constructor
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
    return generateDynCall(expr, indent, context);
  }

  // await - extract value from Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
    const futureArg = expr.args[0];
    if (!futureArg) {
      return `// Error: await requires exactly 1 argument`;
    }

    const futureCode = generateExpr(futureArg, indent, context);
    const futureType = futureArg.$?.type;

    if (!futureType || !isFutureType(futureType)) {
      return `// Error: await argument must be a Future type`;
    }

    const resultType = (futureType as FutureType).elementType;
    const isUnit = isUnitType(resultType);

    // For now, futures complete immediately, so we just extract the result
    // TODO: Add actual async waiting/polling when we implement the async runtime
    if (isUnit) {
      // Future(unit) - just check if completed and return unit
      return `({ (void)(${futureCode})->state; })`;
    } else {
      // Future(T) - extract the result field
      return `(${futureCode})->result`;
    }
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    const arg = expr.args[0];
    if (arg) {
      if (!expr.$) {
        throw new Error(`Internal error: return expression missing metadata`);
      }
      // For non-unit types, we need a temporary variable to hold the return value
      // before deferred drop expressions run
      if (!expr.$.variableName && !isUnitType(expr.$.type)) {
        return `// Error: return expression missing temporary variable name`;
      }

      const argCode = generateExpr(arg, indent, context);
      const returnType = getTypeString(expr.$.type!, context);

      if (
        !isUnitType(expr.$.type) &&
        expr.$.variableName &&
        expr.$.variableName !== argCode // Prevent something like: int32_t _yof4ca7ba3_temp_2071 = _yof4ca7ba3_temp_2071;
      ) {
        context.emitter.emitLine(
          `${indent}${returnType} ${expr.$.variableName} = ${argCode};`
        );
      }

      if (expr.$.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      // Check if we're in a state machine - if so, complete the Future instead of returning
      const functionContext = context as FunctionGenerationContext;
      if (functionContext.inStateMachine) {
        // State machine return - complete the Future and clean up
        const futureType = functionContext.inStateMachine.futureType;
        const elementType = futureType.elementType;
        const isUnitResult = isUnitType(elementType);
        const futureTypeCName = context.types[futureType.id]?.cName;

        if (!futureTypeCName) {
          context.emitter.emitLine(
            `${indent}// Error: Future type not found for async return`
          );
          return `return`;
        }

        context.emitter.emitLine(
          `${indent}// Final state - complete the result Future`
        );
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Completing async function\\n");`
        );

        // Store the result if not unit
        if (!isUnitResult) {
          context.emitter.emitLine(
            `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting result = %d\\n", (int)${expr.$.variableName});`
          );
          context.emitter.emitLine(
            `${indent}sm->result->result = ${expr.$.variableName};`
          );
        }

        // Set state to COMPLETED with release semantics
        // This ensures the result write above is visible to other threads
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting state to COMPLETED\\n");`
        );
        context.emitter.emitLine(
          `${indent}atomic_store_explicit(&sm->result->state, YO_FUTURE_COMPLETED, memory_order_release);`
        );

        // Check if there's a continuation waiting (with acquire semantics to see the continuation registration)
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// Check if there's a continuation waiting for this Future to complete`
        );
        context.emitter.emitLine(
          `${indent}void (*continuation_fn)(void*) = atomic_load_explicit(&sm->result->continuation_fn, memory_order_acquire);`
        );
        context.emitter.emitLine(
          `${indent}void* continuation_sm = atomic_load_explicit(&sm->result->continuation_sm, memory_order_acquire);`
        );
        context.emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
        context.emitter.emitLine(
          `${indent}  ASYNC_DEBUG("${context.currentFunctionName}: Spawning continuation: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(
          `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(`${indent}}`);

        context.emitter.emitLine(
          `${indent}sm->state = ${Number.MAX_SAFE_INTEGER};  // Terminal state`
        );
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// State machine will be freed when Future is disposed (RC reaches 0)`
        );
        // Return from the void resume function
        context.emitter.emitLine(`${indent}return;`);
        // Return empty string so no additional code is generated
        return ``;
      }

      // Normal (non-state-machine) return
      if (isUnitType(expr.$.type)) {
        return `return`;
      }

      return `return ${expr.$.variableName}`;
    } else {
      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      return "return";
    }
  }

  // Array.fill method call (macro-like expansion)
  if (isArrayFillMethodCall(expr)) {
    return generateArrayFillCall(expr, indent, context);
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    const lhs = expr.args[0]!;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const varName = lhs.token.value;
    const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

    context.emitter.emitLine(
      // NOTE: We cannot assign "const" here.
      `${indent}${varTypeAndName};`
    );
    return "";
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    const lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    // Debug: Log all := assignments in state machines
    const functionContext = context as FunctionGenerationContext;

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    // In state machine context, skip variable "load" expressions (localVar := stateMachineVar)
    // These are generated by the type checker to create local copies of variables
    // But in state machines, we access variables directly through sm->var_xxx
    if (functionContext.inStateMachine && exprIsAtom(lhs) && exprIsAtom(rhs)) {
      const lhsName = lhs.token.value;
      const rhsName = rhs.token.value;

      // Check if both refer to the same state machine variable
      // This handles cases like: b := b (creating a local copy)
      const lhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === lhsName
        );
      const rhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === rhsName
        );

      // Skip if both sides reference state machine variables with the same name
      // OR if we're trying to create a local copy of a state machine variable
      if (
        lhsName === rhsName &&
        (lhsIsStateMachineVar || rhsIsStateMachineVar)
      ) {
        // Self-assignment of state machine variable - skip to avoid redundant local copy

        return "";
      }
    }

    // Check if it's destructurings
    if (expr.$?.runtimeDestructurings) {
      const runtimeDestructurings = expr.$.runtimeDestructurings;
      const rhsCode = generateExpr(rhs, indent, context);
      const rhsType = rhs.$?.type;
      runtimeDestructurings.forEach(({ label, type, variableName }) => {
        // Sanitize the variable name for C
        const sanitizedVariableName = sanitizeForCIdentifier(variableName);
        const varTypeAndName = getVariableTypeString(
          type,
          sanitizedVariableName,
          context
        );

        // Handle newtype destructuring - just use the value itself
        if (
          rhsType &&
          isStructType(rhsType) &&
          rhsType.isNewtype &&
          rhsType.elements.length === 1
        ) {
          const singleField = rhsType.elements[0];
          if (singleField && singleField.label === label) {
            // For newtype, destructuring the single field just returns the value itself
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode}; // Destructuring ${label} (newtype)`
            );
            return;
          }
        }

        let fieldName = label.match(/^\d+$/)
          ? `_${label}`
          : sanitizeForCIdentifier(label);

        if (rhsType && isTupleType(rhsType) && !label.match(/^\d+$/)) {
          const index = rhsType.elements.findIndex((el) => el.label === label);
          fieldName = index >= 0 ? `_${index}` : fieldName;
        }

        // Use -> for ref types (which are pointers), . for regular types
        const memberAccessOp = rhsType && isObjectType(rhsType) ? "->" : ".";

        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${rhsCode}${memberAccessOp}${fieldName}; // Destructuring ${label}`
        );
      });
      return "";
    }

    if (exprIsAtom(lhs)) {
      const varName = lhs.token.value;
      if (!lhs.$?.type) {
        return `// Error: No type information for variable ${varName}\n`;
      }

      // Check if we're in a state machine context and this is a captured variable
      const functionContext = context as FunctionGenerationContext;

      // To check if a variable is in the state machine, we need to:
      // 1. Look up the variable in the environment to get its ID
      // 2. Check if that ID is a key in stateMachineVariables map
      let isStateMachineVar = false;
      let varId: string | undefined;

      if (
        functionContext.inStateMachine &&
        functionContext.stateMachineVariables &&
        lhs.$?.env
      ) {
        // Get the variable from the environment
        const variables = getVariablesFromEnv(lhs.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          // Check if this variable (or its owner if it's borrowing) is in state machine
          const idToCheck = variable.isOwningTheSameARCValueAs
            ? variable.isOwningTheSameARCValueAs.id
            : variable.id;

          if (functionContext.stateMachineVariables.has(idToCheck)) {
            isStateMachineVar = true;
            varId = idToCheck;
          }
        }
      }

      // Handle array initialization specially
      if (isArrayType(lhs.$.type)) {
        // Check if RHS is an array literal
        if (
          exprIsFunctionCall(rhs) &&
          exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
        ) {
          // Direct initialization with array literal
          const rhsCode = generateExpr(rhs, indent, context);

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        } else {
          // Copying from another array - use direct struct assignment
          // Handle temp variable assignment for ARC values
          let rhsCode: string;
          if (rhs.$?.variableName) {
            const tempVarName = sanitizeForCIdentifier(rhs.$.variableName);
            const rhsExprCode = generateExpr(rhs, indent, context);

            // Generate temp variable assignment first (only if not in state machine)
            if (!isStateMachineVar) {
              const tempVarType = getVariableTypeString(
                rhs.$.type!,
                tempVarName,
                context
              );
              if (tempVarName !== rhsExprCode) {
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }
            }

            // Use temp variable for the main assignment
            rhsCode = tempVarName;
          } else {
            rhsCode = generateExpr(rhs, indent, context);
          }

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        }
      } else {
        // Non-array initialization - use existing logic
        let rhsCode: string;

        // If RHS has a temp variable name (e.g., for ARC values), we need to:
        // 1. First generate the RHS expression and assign it to the temp variable
        // 2. Then use the temp variable for the assignment
        // BUT: don't create temp variables for captured variables
        // ALSO: don't create temp variables if the temp var name is the same as the variable itself
        if (rhs.$?.variableName) {
          const tempVarName = sanitizeForCIdentifier(rhs.$.variableName);
          const sanitizedVarName = sanitizeForCIdentifier(varName);

          // Skip temp variable creation if temp var name matches the actual variable name
          // This prevents redundant declarations like "int32_t x = x;"
          if (tempVarName === sanitizedVarName) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);
          } else if (
            exprIsAtom(rhs) &&
            tempVarName === sanitizeForCIdentifier(rhs.token.value)
          ) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);
          } else {
            // Check if this temp variable is for a captured variable - if so, skip temp variable creation
            const functionContext = context as FunctionGenerationContext;
            if (
              exprIsAtom(rhs) &&
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                rhs.token.value
              ) &&
              rhs.$?.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                rhs.token.value,
                rhs.$.env,
                functionContext.currentClosureCaptureFrameLevel
              )
            ) {
              // This is a captured variable, don't create a temp variable for it
              // Generate closure access directly
              const currentClosureType = functionContext.currentClosureType;
              if (currentClosureType && isClosureType(currentClosureType)) {
                const closureTypeEntry = Object.values(
                  functionContext.types
                ).find((entry) => entry.type === currentClosureType);
                if (closureTypeEntry) {
                  // Note: captureType is no longer on ClosureType, so we use a naming convention
                  // The capture struct name follows the pattern: closure_type_name + "_capture"
                  const captureStructName = `${closureTypeEntry.cName}_capture`;
                  rhsCode = `((${captureStructName}*)closure_context->data)->${sanitizeForCIdentifier(rhs.token.value)}`;
                } else {
                  rhsCode = `closure_context->${sanitizeForCIdentifier(rhs.token.value)}`;
                }
              } else {
                rhsCode = `closure_context->${sanitizeForCIdentifier(rhs.token.value)}`;
              }
            } else {
              // Normal temp variable handling
              const rhsExprCode = generateExpr(rhs, indent, context);

              // Check if the RHS expression already generates the same temp variable
              // If so, don't generate a redundant assignment
              if (rhsExprCode.trim() !== tempVarName) {
                // Generate temp variable assignment first
                const tempVarType = getVariableTypeString(
                  rhs.$.type!,
                  tempVarName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }

              // Use temp variable for the main assignment
              rhsCode = tempVarName;
            }
          }
        } else {
          rhsCode = generateExpr(rhs, indent, context);
        }

        // Special handling for slice initialization.
        if (isSliceType(lhs.$.type)) {
          const sliceType = lhs.$.type; // Get the slice type directly

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              sliceType,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        } else {
          // Normal initialization
          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        }
      }
      return "";
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    let isInitialization = false;
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      isInitialization = true;
      lhs = lhs.args[0]!; // Get the actual variable being assigned
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
    ) {
      // compile-time variable
      return "";
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const lhsCode = generateExpr(lhs, indent, context);

    // Check if we need to save the old value into temp variable
    if (expr.$?.variableName) {
      const tempVarName = expr.$.variableName;

      // Skip temp variable declaration in state machines if lhsCode already accesses sm->var_xxx
      const functionContext = context as FunctionGenerationContext;
      const skipTempVar =
        functionContext.inStateMachine && lhsCode.startsWith("sm->");

      if (!skipTempVar) {
        const tempVarNameAndType = getVariableTypeString(
          lhs.$.type,
          tempVarName,
          context
        );

        // Handle array assignment specially
        if (isArrayType(lhs.$.type)) {
          // For array, use direct struct assignment
          context.emitter.emitLine(
            `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
          );
        } else {
          if (!isUnitType(lhs.$.type)) {
            context.emitter.emitLine(
              `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
            );
          }
        }
      }
    }

    // Handle array assignments specially
    if (isArrayType(lhs.$.type)) {
      // Since we use struct wrappers consistently, we can use direct struct assignment
      const rhsCode = generateExpr(rhs, indent, context);
      if (isInitialization) {
        // For initialization
        const varTypeAndName = getVariableTypeString(
          lhs.$.type,
          generateExpr(lhs, indent, context),
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${rhsCode};`);
      } else {
        // For assignment to existing array variable, use direct struct assignment
        context.emitter.emitLine(`${indent}${lhsCode} = ${rhsCode};`);
      }
    } else {
      // Non-array assignment - use existing logic
      const rhsCode = generateExpr(rhs, indent, context);

      // Check if we need to cast closure types
      const lhsType = lhs.$.type;
      const rhsType = rhs.$?.type;
      if (
        lhsType &&
        rhsType &&
        isClosureType(lhsType) &&
        isClosureType(rhsType)
      ) {
        // Note: All closure types are now the same (no base vs specific distinction)
        // since captureType is no longer part of ClosureType
        // No cast needed
      }

      if (!isUnitType(lhs.$.type)) {
        context.emitter.emitLine(
          `${indent}${isInitialization ? getTypeString(lhs.$.type, context) + " " : ""}${lhsCode} = ${rhsCode};`
        );
      }
    }

    return expr.$?.variableName ?? "";
  }
  // already computed and it's not unit value
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type)
  ) {
    const value: Value = expr.$.value;
    return generateComptValue(value, context, expr);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;

    if (tempVariableName && valueType) {
      // Expression form: begin block that returns a value
      if (!isUnitType(valueType) && !expr.$?.controlFlow) {
        context.emitter.emitLine(
          `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
        );
      }

      // Evaluate each argument
      context.emitter.emitLine(`${indent}{ // begin block`);

      // Generate and emit code for each arg IMMEDIATELY to preserve order
      // This is important because generateExpr may have side effects that emit code
      const argsCode: string[] = [];
      const isReturningValue = !isUnitType(valueType) && !expr.$?.controlFlow;

      for (let idx = 0; idx < expr.args.length; idx++) {
        const arg = expr.args[idx]!;
        const result = generateExpr(arg, indent + "  ", context);
        argsCode.push(result);

        // Emit immediately to preserve order (generateExpr might emit temp vars as side effects)
        // But skip emitting the last expression if it's being used as the return value
        const isLastExpr = idx === expr.args.length - 1;
        if (result && !(isLastExpr && isReturningValue)) {
          context.emitter.emitLine(`${indent}  ${result};`);
        }
      }
      if (isReturningValue) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${argsCode[argsCode.length - 1]};`
        );
      }

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);

      return isUnitType(valueType) || expr.$?.controlFlow
        ? ""
        : tempVariableName;
    } else {
      // Statement form: begin block without returning a value
      context.emitter.emitLine(`${indent}{ // begin block`);
      const argsCode = expr.args.map((arg) =>
        generateExpr(arg, indent + "  ", context)
      );
      argsCode.forEach((argCode) => {
        if (argCode) {
          context.emitter.emitLine(`${indent}  ${argCode};`);
        }
      });

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);
      return "";
    }
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
    const type = expr.$?.type;
    if (!type) {
      return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
    }
    const arg = expr.args[0]!;

    // Special case: *(arr(0:3)) or *(arr(:)) should create slice values directly
    if (exprIsFunctionCall(arg)) {
      const funcType = arg.func.$?.type;
      if (funcType && isArrayType(funcType)) {
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(arr(start:end)) -> create slice value directly
          const arrayCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(
                (funcType as ArrayType).elementType,
                context
              ),
            });
          }
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(arr(:)) -> create slice value for whole array
          const arrayCode = generateExpr(arg.func!, indent, context);
          const arrayType = funcType as ArrayType;
          const elementType = arrayType.elementType;

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(elementType, context),
            });
          }

          if (isNumberValue(arrayType.length)) {
            return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
          } else {
            return `/* Error: Cannot slice array with non-compile-time length */`;
          }
        }
      } else if (
        funcType &&
        (isSliceType(funcType) ||
          (isMutPtrType(funcType) && isSliceType(funcType.type)))
      ) {
        // Handle slice-from-slice: *(slice(start:end))
        const sliceBaseType = isSliceType(funcType)
          ? (funcType as SliceType)
          : (funcType.type as SliceType);
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(slice(start:end)) -> create sub-slice
          const sliceCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(sliceBaseType.elementType, context),
            });
          }
          return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(slice(:)) -> create slice copy of whole slice
          const sliceCode = generateExpr(arg.func!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(sliceBaseType.elementType, context),
            });
          }
          return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
        }
      }
    }

    const argCode = generateExpr(arg, indent, context);

    // For pointer/reference creation, we need to be careful about constness
    // Simply use the address-of operator without an explicit cast to avoid const issues
    return `(&${argCode})`;
  }
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const cName = context.types[expr.$?.type?.id ?? ""]?.cName;
    const tempVar = expr.$?.variableName;

    if (runtimeArgExprs && cName) {
      // Generate tuple initialization
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");

      // If this tuple has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const tupleValue = `(${cName}){ ${argsList} }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
        return tempVar;
      } else {
        return `(${cName}){ ${argsList} }`;
      }
    } else if (expr.args.length === 0) {
      // unit
      return "";
    }
  }
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const arrayType = expr.$?.type;
    const tempVar = expr.$?.variableName;

    if (isArrayType(arrayType) && runtimeArgExprs) {
      // Generate struct wrapper initialization
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");
      const arrayTypeName = getTypeString(arrayType, context);

      // If this array has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const arrayValue = `(${arrayTypeName}){ .data = { ${argsList} } }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${arrayValue};`);
        return tempVar;
      } else {
        return `(${arrayTypeName}){ .data = { ${argsList} } }`;
      }
    }
  }
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      // Generate recur call with arguments
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");
      return `${context.currentFunctionName}(${argsList})`;
    } else {
      return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
    }
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `sizeof(${argCode})`; // Use sizeof operator on the argument
  }
  // __yo_decr_rc
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `__yo_decr_rc(${argCode})`;
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const args = runtimeArgExprs.map((arg) => {
        return generateExpr(arg, indent, context);
      });

      return generateYoInlineFunctionCall(
        expr.func.token.value,
        args,
        expr,
        context
      );
    }
  }
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // for loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.for)) {
    return generateForLoop(expr, indent, context);
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
      return generateComptValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // consume
  // compt_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.consume) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // other function call
  else {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (isFunctionType(functionType)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // Check if this is a method call on a dyn object
        let isDynMethodCall = false;
        if (
          exprIsFunctionCall(expr.func) &&
          exprIsFunctionCallOf(expr.func, ".", 2)
        ) {
          const objectExpr = expr.func.args[0];
          const objectType = objectExpr?.$?.type;
          if (objectType && isDynType(objectType)) {
            isDynMethodCall = true;
          }
        }

        // Generate arg list with special handling for dyn method calls
        const args = runtimeArgExprs.map((arg, index) => {
          // First, check if this argument needs a temporary variable
          if (arg.$?.variableName && arg.$?.type) {
            const functionContext = context as FunctionGenerationContext;

            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              const varTypeAndName = getVariableTypeString(
                arg.$.type,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
            }

            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .module)
            if (isDynMethodCall && index === 0) {
              // Check if this method exists in the dyn type's own module
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's module
                  const dynMethod = dynType.module.elements.find(
                    (element) => element.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return arg.$.variableName;
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              return `${arg.$.variableName}->data`;
            } else {
              // If this is a closure-captured variable, use the generated code (inline access)
              // If this is a state machine variable, use the generated code (sm->var_xxx access)
              // Otherwise use the variable name
              return isClosureCapturedVariable || isStateMachineCapturedVariable
                ? argCode
                : arg.$.variableName;
            }
          } else {
            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .module)
            if (isDynMethodCall && index === 0) {
              const dynObjectCode = generateExpr(arg, indent, context);

              // Check if this method exists in the dyn type's own module
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's module
                  const dynMethod = dynType.module.elements.find(
                    (element) => element.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return dynObjectCode;
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              return `${dynObjectCode}->data`;
            } else {
              return generateExpr(arg, indent, context);
            }
          }
        });
        const argsList = args.join(", ");

        // Check if this is an extern "yo" function - handle these first before regular function values
        if (functionType.isExtern === "yo" && functionType.externName) {
          const externFuncName = functionType.externName;

          if (BuiltinYoInlineFunctions.includes(externFuncName)) {
            return generateYoInlineFunctionCall(
              externFuncName,
              args,
              expr,
              context
            );
          } else if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(
              `${indent}${externFuncName}(${argsList});`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            return `${externFuncName}(${argsList})`;
          }
        }

        if (isFunctionValue(functionValue)) {
          // Check if it's function vaue whose body only contains Yo operator
          const operatorFunctionName =
            isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
          if (operatorFunctionName) {
            return generateYoInlineFunctionCall(
              operatorFunctionName,
              args,
              expr,
              context
            );
          }

          // Get new function type, which might be specialized.
          const functionType =
            functionValue.specializedType ?? functionValue.type;
          // Normal function call
          const cFuncName = context.functions[functionValue.funcId]?.cName;
          if (cFuncName) {
            // Generate function call
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(functionValue.specializedType?.return.type ?? functionType.return.type, context)} ${tempVar} = ${cFuncName}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: regular function call returns non-unit type but no temp variable assigned
                return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        } else {
          const externFunction = context.externFunctions[functionType.id];
          if (externFunction) {
            // Generate regular extern function call
            const cFuncName = externFunction.cName;

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return `${cFuncName}(${argsList})`;
          } else {
            // Function parameter call (e.g., callback(x))
            const funcCode = generateExpr(expr.func, indent, context);
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable or return directly
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(functionType.return.type, context)} ${tempVar} = ${funcCode}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: function parameter call returns non-unit type but no temp variable assigned
                return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        }
      }
    } else if (isClosureType(functionType)) {
      // Handle closure calls with dynamic dispatch through vtable
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // First, handle arguments that need temporary variables
        const functionContext = context as FunctionGenerationContext;
        for (const arg of runtimeArgExprs) {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              const varTypeAndName = getVariableTypeString(
                arg.$.type,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
            }
          }
        }

        // Generate closure value and function arguments
        const closureCode = generateExpr(expr.func, indent, context);
        const args = runtimeArgExprs.map((arg) => {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this is a closure-captured variable - if so, use the full access expression
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            if (isClosureCapturedVariable) {
              // Return the inline access expression
              return generateExpr(arg, indent, context);
            } else {
              // Check if this is a state machine variable
              const argCode = generateExpr(arg, indent, context);
              const isStateMachineCapturedVariable =
                functionContext.inStateMachine && argCode.startsWith("sm->");
              return isStateMachineCapturedVariable
                ? argCode
                : arg.$.variableName;
            }
          } else {
            return generateExpr(arg, indent, context);
          }
        });

        // Call through the vtable - closure->vtable.call(closure->data, args...)
        // Note: The first argument to the call function is the capture data pointer, not the closure itself
        const allArgs = [`(${closureCode})->data`, ...args];
        const closureCall = `(${closureCode})->vtable.call(${allArgs.join(", ")})`;

        // Get return type from the closure's function signature
        const returnType = functionType.callType.return.type;

        if (isUnitType(returnType)) {
          // If the closure returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${closureCall};`);

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return ""; // No return value
        } else {
          // If it returns a value, assign to a temp variable or return directly
          const tempVar = expr.$?.variableName;
          if (tempVar) {
            context.emitter.emitLine(
              `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return tempVar; // Return the temp variable name
          } else {
            // Error: closure returns non-unit type but no temp variable assigned
            return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
          }
        }
      } else {
        // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
        // by checking for expr.$?.closureFunctionValue
        return `// Error: No runtime args found for closure call`;
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const structType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[structType.id]?.cName;
        const labels = structType.elements.map((element) => element.label);
        const tempVar = expr.$?.variableName;

        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          // Handle newtype as zero-cost abstraction
          if (structType.isNewtype && structType.elements.length === 1) {
            // For newtype, just use the underlying value directly (with cast for type safety)
            const argCode = generateExpr(runtimeArgExprs[0]!, indent, context);
            const newtypeValue = `((${cName})(${argCode}))`;

            // If this newtype has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${newtypeValue};`
              );
              return tempVar;
            } else {
              return newtypeValue;
            }
          }

          if (structType.isReferenceSemantics) {
            // For object, call the constructor function
            const argsList = runtimeArgExprs
              .map((arg) => generateExpr(arg, indent, context))
              .join(", ");

            const constructorName = `__yo_new_${cName}`;
            const structValue = `${constructorName}(${argsList})`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          } else {
            // For regular struct, generate struct initialization as before
            const argsList = runtimeArgExprs
              .map((arg, index) => {
                const sanitizedLabel = sanitizeForCIdentifier(labels[index]!);
                return (
                  `.${sanitizedLabel} = ` + generateExpr(arg, indent, context)
                );
              })
              .join(", ");
            const structValue = `(${cName}){ ${argsList} }`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          }
        }
      }
      // closure type - closure construction
      // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
      else if (isClosureType(functionValue.value)) {
        return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
      }
      // union
      // union is supposed to have only one member initialized
      else if (isUnionType(functionValue.value)) {
        const tempVar = expr.$?.variableName;
        const arg = expr.args[0]!;
        if (
          arg &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, ":", 2)
        ) {
          const labelExpr = arg.args[0]!;
          const fieldExpr = arg.args[1]!;
          const cName = context.types[functionValue.value.id]?.cName;
          if (cName && exprIsAtom(labelExpr) && fieldExpr) {
            const label = labelExpr.token.value;
            const sanitizedLabel = sanitizeForCIdentifier(label);
            const fieldCode = generateExpr(fieldExpr, indent, context);
            const unionValue = `(${cName}){ .${sanitizedLabel} = ${fieldCode} }`;

            // If this union has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${unionValue};`
              );
              return tempVar;
            } else {
              return unionValue;
            }
          }
        }
      }
      // enum
      else if (isEnumType(functionValue.value)) {
        const enumType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[enumType.id]?.cName;
        const tempVar = expr.$?.variableName;

        if (enumType.selectedVariantName && runtimeArgExprs && cName) {
          // Check if this enum can be optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);
          if (nullablePointerType) {
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );

            if (variant) {
              if (!variant.elements || variant.elements.length === 0) {
                // This is the "None" case - return NULL
                const enumValue = "NULL";
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${enumValue};`
                  );
                  return tempVar;
                } else {
                  return enumValue;
                }
              } else if (variant.elements.length === 1) {
                // This is the "Some" case - return the pointer value directly
                const pointerValue = generateExpr(
                  runtimeArgExprs[0]!,
                  indent,
                  context
                );
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${pointerValue};`
                  );
                  return tempVar;
                } else {
                  return pointerValue;
                }
              }
            }
          }

          // Check if this enum can be optimized as a simple C enum
          const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
          if (simpleEnumOptimizable) {
            const variantName = enumType.selectedVariantName;
            // For simple enums, just return the enum constant
            const enumValue = getEnumVariantCName(
              enumType,
              variantName,
              context
            );
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }

          // Generate enum initialization (fallback for non-optimized enums)
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            // Filter out unit type arguments - they don't need to be stored
            const nonUnitElements =
              variant.elements?.filter(
                (element) => !isUnitType(element.type)
              ) || [];

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                if (variant.elements) {
                  const element = variant.elements[index];
                  if (element && !isUnitType(element.type)) {
                    const sanitizedLabel = sanitizeForCIdentifier(
                      element.label
                    );
                    return (
                      `.${sanitizedLabel} = ` +
                      generateExpr(arg, indent, context)
                    );
                  }
                  return ""; // Skip if no element matches or if it's unit type
                } else {
                  return "";
                }
              })
              .filter((s) => s) // Remove empty strings
              .join(", ");

            // If there are no non-unit fields, we only need the tag
            const enumValue =
              nonUnitElements.length > 0
                ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
                : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }
        }
      }
    } else if (isArrayType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a slicing operation: arr(start:end) or arr(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // arr(start:end) -> create slice value
        const arrayCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as ArrayType).elementType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            elementType: getTypeString(
              (functionType as ArrayType).elementType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // arr(:) -> create slice value for whole array
        const arrayCode = generateExpr(expr.func!, indent, context);
        const arrayType = functionType as ArrayType;
        const elementType = arrayType.elementType;

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(elementType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            elementType: getTypeString(elementType, context),
          });
        }

        if (isNumberValue(arrayType.length)) {
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
        } else {
          return `/* Error: Cannot slice array with non-compile-time length */`;
        }
      }

      // Array access by index: arr[index] or arr(index)
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    } else if (isSliceType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a sub-slicing operation: slice(start:end) or slice(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // slice(start:end) -> create sub-slice
        const sliceCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).elementType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            elementType: getTypeString(
              (functionType as SliceType).elementType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // slice(:) -> create slice copy of whole slice
        const sliceCode = generateExpr(expr.func!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).elementType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            elementType: getTypeString(
              (functionType as SliceType).elementType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
      }

      // Slice access by index: slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    } else if (
      functionType &&
      isMutPtrType(functionType) &&
      isSliceType(functionType.type)
    ) {
      // This case should no longer exist since slices are no longer behind pointers
      // But keep it for backward compatibility during migration
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    }
  }

  if (exprIsFunctionCall(expr)) {
    throw new Error(`Unhandled function call: ${exprToString(expr)}`);
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

/**
 * Generate C code for an async block expression.
 * async { body } creates a Future by calling a constructor function
 * similar to how closures are created.
 */
function generateAsyncBlock(
  expr: FuncCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  const bodyExpr = expr.args[0];
  if (!bodyExpr) {
    return `/* Error: async requires exactly 1 argument */`;
  }

  const futureType = expr.$?.type;
  if (!futureType || !isFutureType(futureType)) {
    return `/* Error: async block must have Future type */`;
  }

  const futureTypeCName = context.types[futureType.id]?.cName;
  if (!futureTypeCName) {
    return `/* Error: Future type not found in context */`;
  }

  // Generate a unique name for this async block's state machine
  const asyncBlockId = expr.$?.variableName || `async_block_${Date.now()}`;
  const structName = `${asyncBlockId}_state_t`;
  const resumeFunctionName = `${asyncBlockId}_resume`;
  const constructorName = `__yo_new_${asyncBlockId}`;
  const disposeFunctionName = `${asyncBlockId}_state_dispose`;

  // Analyze the body for await points
  const analysis = analyzeAwaitPoints(bodyExpr);

  // Generate the state machine struct declaration
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `// State machine for async block ${asyncBlockId}`
  );
  emitter.emitDeclarationLine(`typedef struct {`);
  emitter.emitDeclarationLine(
    `  int state;  // Current state (0 = initial, ${analysis.awaitPoints.length + 1} = done)`
  );
  emitter.emitDeclarationLine(
    `  ${futureTypeCName}* result;  // The Future this async block returns`
  );
  emitter.emitDeclarationLine(``);

  // Add capture struct as a single field if there are captured variables
  if (expr.$?.captureType) {
    const captureType = expr.$.captureType;
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitDeclarationLine(`  // Captured variables from outer scope`);
    emitter.emitDeclarationLine(`  ${captureStructName} __capture;`);
    emitter.emitDeclarationLine(``);
  }

  // Add local variables as fields
  if (analysis.capturedVariables.length > 0) {
    emitter.emitDeclarationLine(`  // Local variables`);
    for (const variable of analysis.capturedVariables) {
      const varTypeCName = getTypeString(variable.type, context);
      const fieldName = getStateMachineFieldName(variable.id, "local");
      emitter.emitDeclarationLine(
        `  ${varTypeCName} ${fieldName};  // ${variable.name}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Add await result temporaries
  if (analysis.awaitPoints.length > 0) {
    emitter.emitDeclarationLine(`  // Await result temporaries`);
    for (const awaitPoint of analysis.awaitPoints) {
      if (!isUnitType(awaitPoint.resultType)) {
        const resultTypeCName = getTypeString(awaitPoint.resultType, context);
        emitter.emitDeclarationLine(
          `  ${resultTypeCName} await_result_${awaitPoint.index};`
        );
      }
    }
    emitter.emitDeclarationLine(``);
  }

  // Note: We don't need separate await_future_X fields because we use the captured Future variables directly
  emitter.emitDeclarationLine(`} ${structName};`);
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for state machine dispose function
  emitter.emitDeclarationLine(
    `void ${disposeFunctionName}(void* sm_ptr);  // Dispose function for state machine`
  );
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for resume function
  emitter.emitDeclarationLine(`void ${resumeFunctionName}(${structName}* sm);`);
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for constructor function
  if (expr.$?.captureType) {
    const captureType = expr.$.captureType;
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitDeclarationLine(
      `${futureTypeCName}* ${constructorName}(${captureStructName} __capture);`
    );
  } else {
    emitter.emitDeclarationLine(`${futureTypeCName}* ${constructorName}();`);
  }
  emitter.emitDeclarationLine(``);

  // Store information for deferred generation of implementations
  if (!context.deferredAsyncBlocks) {
    context.deferredAsyncBlocks = [];
  }

  context.deferredAsyncBlocks.push({
    bodyExpr,
    asyncBlockId,
    structName,
    resumeFunctionName,
    constructorName,
    disposeFunctionName,
    futureType: futureType as FutureType,
    futureTypeCName,
    captureType: expr.$?.captureType,
    analysis,
  });

  // Generate the constructor call with captured variables
  const captureType = expr.$?.captureType;

  if (captureType) {
    // We have captured variables in a struct
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;

    // Build the capture struct literal
    // Dup expressions are created at evaluation time and don't have correct context for code generation
    // When in a closure or state machine, always use generateAtom for proper context-aware access
    // Otherwise, use dup expressions if available (they handle proper ARC semantics)
    const functionContext = context as FunctionGenerationContext;
    const inSpecialContext =
      functionContext.currentClosureCaptures !== undefined ||
      functionContext.inStateMachine !== undefined;

    const captureFields = captureType.elements
      .map((elem) => {
        // Find the dup expression for this variable by checking the variable name
        // capturedVariableDupExpressions only contains dup expressions for ARC types,
        // so we need to match by variable name, not by index
        let dupExpr: Expr | undefined;
        if (!inSpecialContext && expr.$?.capturedVariableDupExpressions) {
          for (const possibleDupExpr of expr.$.capturedVariableDupExpressions) {
            // Dup expression is in the form: ___dup(varName)
            // Extract the variable name from the first argument
            if (
              exprIsFunctionCall(possibleDupExpr) &&
              possibleDupExpr.args.length > 0 &&
              exprIsAtom(possibleDupExpr.args[0])
            ) {
              const varName = possibleDupExpr.args[0].token.value;
              if (varName === elem.label) {
                dupExpr = possibleDupExpr;
                break;
              }
            }
          }
        }

        if (dupExpr) {
          return `.${elem.label} = ${generateExpr(dupExpr, indent, context)}`;
        }
        // Fallback: generate proper variable access using generateAtom
        // This handles closure context and state machine access properly
        const atomExpr: AtomExpr = {
          tag: ExprTag.Atom,
          token: elem.exprs.expr.token,
          $: elem.exprs.expr.$,
        };
        return `.${elem.label} = ${generateAtom(atomExpr, context)}`;
      })
      .join(", ");

    const captureStructLiteral = `(${captureStructName}){${captureFields}}`;
    const resultVar = expr.$?.variableName || `async_result`;
    const constructorCall = `${constructorName}(${captureStructLiteral})`;

    // If this has a temporary variable name, declare it
    if (resultVar && expr.$?.type) {
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        resultVar,
        context
      );
      context.emitter.emitLine(
        `${indent}${varTypeAndName} = ${constructorCall};`
      );
      return resultVar;
    } else {
      return constructorCall;
    }
  } else {
    // No captured variables - just call constructor
    const resultVar = expr.$?.variableName || `async_result`;
    const constructorCall = `${constructorName}()`;

    if (resultVar && expr.$?.type) {
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        resultVar,
        context
      );
      context.emitter.emitLine(
        `${indent}${varTypeAndName} = ${constructorCall};`
      );
      return resultVar;
    } else {
      return constructorCall;
    }
  }
}

/**
 * Generate the state machine struct, resume function, and constructor for an async block.
 * This reuses the async function state machine infrastructure.
 */
/**
 * Generate the state machine dispose function for an async block.
 * This drops the capture struct before freeing the state machine.
 */
function generateAsyncBlockStateDisposeFunction(
  asyncBlockId: string,
  structName: string,
  disposeFunctionName: string,
  captureType: StructType | undefined,
  analysis: AwaitAnalysisResult,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  emitter.emitLine(
    `// Dispose function for async block ${asyncBlockId} state machine`
  );
  emitter.emitLine(`void ${disposeFunctionName}(void* sm_ptr) {`);
  emitter.emitLine(`  ${structName}* sm = (${structName}*)sm_ptr;`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${disposeFunctionName}: Disposing state machine\\n");`
  );
  emitter.emitLine(``);

  // Drop capture struct (like closures do)
  if (captureType && typeContainsARCType(captureType)) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    if (!existingCaptureTypeEntry) {
      emitter.emitLine(
        `  /* Error: capture struct type not found in context */`
      );
    } else {
      const captureTypeName = existingCaptureTypeEntry.cName;

      // Find the ___drop function for the capture struct
      const dropFunction = captureType.module.elements.find(
        (element) => element.label === BuiltinFunctions.___drop[0]
      );
      if (
        dropFunction &&
        dropFunction.assignedValue &&
        isFunctionValue(dropFunction.assignedValue)
      ) {
        const dropFunctionCName =
          context.functions[dropFunction.assignedValue.funcId]?.cName;
        if (dropFunctionCName) {
          emitter.emitLine(`  ASYNC_DEBUG("  Dropping capture struct\\n");`);
          emitter.emitLine(`  ${dropFunctionCName}(sm->__capture);`);
        }
      } else {
        emitter.emitLine(
          `  /* Warning: ___drop function not found for capture struct ${captureTypeName} */`
        );
      }
    }
  }

  emitter.emitLine(``);

  // NOTE: Local variables are ALWAYS handled by deferred drop expressions
  // that run in the final state before completion. The state machine dispose
  // function only needs to clean up outer captured variables and free the
  // state machine struct itself.

  // Free the state machine itself
  emitter.emitLine(`  // Free the state machine`);
  emitter.emitLine(`  __yo_free(sm);`);
  emitter.emitLine(`}`);
}

/**
 * Generate the resume function for an async block.
 * This follows the same pattern as async function resume functions.
 */
/**
 * Generate the constructor function for an async block.
 * The constructor allocates the state machine and Future, initializes captured variables,
 * and spawns the task to a worker thread.
 */
function generateAsyncBlockConstructor(
  asyncBlockId: string,
  structName: string,
  resumeFunctionName: string,
  constructorName: string,
  disposeFunctionName: string,
  futureType: FutureType,
  futureTypeCName: string,
  captureType: StructType | undefined,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate constructor signature
  if (captureType) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitLine(
      `${futureTypeCName}* ${constructorName}(${captureStructName} __capture) {`
    );
  } else {
    emitter.emitLine(`${futureTypeCName}* ${constructorName}() {`);
  }

  // Allocate state machine
  emitter.emitLine(`  // Allocate async block state machine`);
  emitter.emitLine(
    `  ${structName}* sm = (${structName}*)__yo_malloc(sizeof(${structName}));`
  );
  emitter.emitLine(`  sm->state = 0;`);
  emitter.emitLine(``);

  // Initialize capture struct
  if (captureType) {
    emitter.emitLine(`  // Initialize capture struct`);
    emitter.emitLine(`  sm->__capture = __capture;`);
    emitter.emitLine(``);
  }

  // Allocate and initialize Future
  emitter.emitLine(`  // Allocate and initialize Future`);
  emitter.emitLine(
    `  ${futureTypeCName}* future = (${futureTypeCName}*)__yo_malloc(sizeof(${futureTypeCName}));`
  );
  emitter.emitLine(`  future->header.owner_thread_id = __yo_get_thread_id();`);
  emitter.emitLine(
    `  future->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);`
  );
  emitter.emitLine(`  future->header.shared_word = 0;`);
  emitter.emitLine(`  future->header.gc_next = NULL;`);
  emitter.emitLine(`  future->header.gc_prev = NULL;`);
  emitter.emitLine(`  future->header.dispose_fn = yo_future_dispose;`);
  emitter.emitLine(`  future->header.traverse_fn = NULL;`);
  emitter.emitLine(
    `  future->state_machine_dispose_fn = ${disposeFunctionName};`
  );
  emitter.emitLine(
    `  atomic_store_explicit(&future->state, YO_FUTURE_RUNNING, memory_order_relaxed);`
  );
  emitter.emitLine(`  future->state_machine = sm;`);
  emitter.emitLine(
    `  future->resume_fn = (void (*)(void*))${resumeFunctionName};`
  );
  emitter.emitLine(
    `  atomic_store_explicit(&future->continuation_fn, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(
    `  atomic_store_explicit(&future->continuation_sm, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(
    `  atomic_store_explicit(&future->detached, false, memory_order_relaxed);`
  );
  emitter.emitLine(`  sm->result = future;`);
  emitter.emitLine(``);

  // Spawn the task immediately (eager spawning - JavaScript-style)
  emitter.emitLine(`  // Spawn task immediately (eager - JavaScript-style)`);
  emitter.emitLine(
    `  yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, sm);`
  );
  emitter.emitLine(
    `  ASYNC_DEBUG("${asyncBlockId}: Created and spawned Future immediately\\n");`
  );
  emitter.emitLine(``);

  emitter.emitLine(`  return future;`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);
}

/**
 * Generate C code for a dyn() constructor call
 */
function generateDynCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$?.dynCallModuleValues || expr.$.dynCallModuleValues.length === 0) {
    return `/* Error: dyn() call missing module values */`;
  }

  const valueExpr = expr.args[0];
  if (!valueExpr) {
    return `/* Error: dyn() requires a value argument */`;
  }

  // Generate the value expression
  const valueCode = generateExpr(valueExpr, indent, context);

  // Use the temp variable name from the expression if available, otherwise generate one
  const tempVarName = expr.$?.variableName || `dyn_temp_${Date.now()}`;

  // Get the dyn type information
  const dynType = expr.$.type;
  let dynTypeName = `yo_dyn_unknown`;

  // Find the type in context.types
  for (const typeEntry of Object.values(context.types)) {
    if (typeEntry.type === dynType) {
      dynTypeName = typeEntry.cName;
      break;
    }
  }

  // Collect all function pointers that need to be passed to constructor
  const functionPointers: string[] = [];
  const moduleValues = expr.$.dynCallModuleValues;
  for (const moduleValue of moduleValues) {
    // Find functions in the module and collect their function IDs
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const elementType = moduleValue.type.elements[i];

      if (element && isFunctionValue(element) && elementType) {
        const methodName = elementType.label;
        // Skip 'Self' and 'This' type declarations (compile-time only)
        if (methodName !== "Self") {
          const functionId = element.funcId;
          // Check if function exists in context
          if (context.functions[functionId]) {
            functionPointers.push(functionId);
          } else {
            functionPointers.push("NULL");
          }
        }
      }
    }
  }

  // Generate constructor call
  const constructorName = `__yo_new_${dynTypeName}`;
  const disposeFunctionName = `__yo_dispose_${dynTypeName}`;
  const functionArgs = functionPointers.join(", ");

  context.emitter.emitLine(
    `${indent}${dynTypeName}* ${tempVarName} = ${constructorName}(${valueCode}, ${disposeFunctionName}, ${functionArgs});`
  );

  // Return the variable reference
  return tempVarName;
}

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  const functionContext = context as FunctionGenerationContext;

  // If this atom is a unit type value, don't generate any code
  if (expr.$?.type && isUnitType(expr.$.type)) {
    return "";
  }

  // Handle control flow atoms first (before checking computed values or variable names)
  if (expr.token.value === "continue") {
    return "continue";
  }

  if (expr.token.value === "break") {
    return "break";
  }

  if (expr.token.value === "return") {
    return "return";
  }

  // Check if we're in a closure function and this variable is captured
  // Type assertion to access function-specific context

  // Check if we're in a state machine and this is a captured variable
  if (functionContext.inStateMachine && functionContext.stateMachineVariables) {
    const varName = expr.token.value;

    // Check if this variable is in the state machine
    for (const [varId, capturedVar] of functionContext.stateMachineVariables) {
      if (capturedVar.name === varName) {
        // This is a state machine variable - access it through sm->
        // Use kind to determine field name:
        // - "outer": Use __capture.varName (sm->__capture.varName)
        // - "local": Use var_{varId} (sm->var_{varId})
        const fieldName =
          capturedVar.kind === "outer"
            ? `__capture.${varName}`
            : `var_${varId}`;
        return `sm->${fieldName}`;
      }

      // Also check if this variable is the owner of a borrowed variable in the state machine
      // e.g., _temp_123 owns the value, future1 borrows from _temp_123
      // In deferred drops, we drop _temp_123, but in state machine it's stored as sm->var_future1
      if (
        capturedVar.isOwningTheSameARCValueAs &&
        capturedVar.isOwningTheSameARCValueAs.name === varName
      ) {
        const fieldName =
          capturedVar.kind === "outer"
            ? `__capture.${varName}`
            : `var_${varId}`;
        return `sm->${fieldName}`;
      }
    }

    // Variable not found directly - check if it's borrowing from a captured variable
    // This handles the case where we reference `future1` but only `temp_2198` (its owner) is captured
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheSameARCValueAs) {
          // This variable is borrowing - try to find the owner in state machine
          const ownerName = variable.isOwningTheSameARCValueAs.name;
          const ownerId = variable.isOwningTheSameARCValueAs.id;

          for (const [
            varId,
            capturedVar,
          ] of functionContext.stateMachineVariables) {
            if (capturedVar.name === ownerName || varId === ownerId) {
              const fieldName =
                capturedVar.kind === "outer"
                  ? `__capture.${ownerName}`
                  : `var_${varId}`;
              return `sm->${fieldName}`;
            }
          }
        }
      }
    }

    // Variable not in stateMachineVariables - it's a local C variable in the resume function
    // Just use the variable name (don't regenerate its value)
    if (expr.$?.variableName) {
      return sanitizeForCIdentifier(expr.$.variableName);
    }
  }

  // If this atom has a temp variable name (e.g., for ARC values), use that instead of regenerating code
  // This prevents regenerating constructor calls for temp variables that should just use their variable names
  // BUT: if this is a captured variable in a closure, we should use closure access instead
  // ALSO: if this is a compile-time only variable with a value, inline it instead
  if (expr.$?.variableName) {
    // Check if this is a compile-time only variable - if so, inline the value
    if (expr.$?.env && expr.$?.value && !isUnknownValue(expr.$.value)) {
      const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
      if (
        variables.length > 0 &&
        variables[variables.length - 1]!.isCompileTimeOnly
      ) {
        return generateComptValue(expr.$.value, context, expr);
      }
    }

    // Check if this is a captured variable in a closure - if so, don't use temp variable name
    if (
      functionContext.currentClosureCaptures &&
      functionContext.currentClosureCaptures.includes(expr.token.value) &&
      expr.$?.env &&
      functionContext.currentClosureCaptureFrameLevel !== undefined &&
      checkVariableIsClosureCaptured(
        expr.token.value,
        expr.$.env,
        functionContext.currentClosureCaptureFrameLevel
      )
    ) {
      // Don't return early - let it fall through to closure capture logic
    } else {
      return sanitizeForCIdentifier(expr.$.variableName);
    }
  }

  // Check if this atom has a compile-time value
  // This is only reached for closure-captured variables (non-closure variables return early above)
  // For closure-captured variables, we should NOT inline their values - we access them via closure context
  // So this code path should never actually inline a value for variables
  if (expr.$?.value) {
    if (isUnknownValue(expr.$.value)) {
      throw new Error(
        `Cannot generate code for unknown compile-time value of atom: ${exprToString(expr)}`
      );
    }
    // Only inline if this is NOT a variable (e.g., it's a literal constant without a variable name)
    // But all variables should have been handled above, so this is just for safety
    return generateComptValue(expr.$.value, context, expr);
  }

  const isClosureCaptured =
    expr.$?.env && functionContext.currentClosureCaptureFrameLevel !== undefined
      ? checkVariableIsClosureCaptured(
          expr.token.value,
          expr.$.env,
          functionContext.currentClosureCaptureFrameLevel
        )
      : false;

  if (
    functionContext.currentClosureCaptures &&
    functionContext.currentClosureCaptures.includes(expr.token.value) &&
    functionContext.currentClosureCaptureFrameLevel !== undefined &&
    (expr.$?.env ? isClosureCaptured : true) // If no env info, trust currentClosureCaptures
  ) {
    // We're accessing a captured variable in a closure function
    // The closure_context parameter is a void* that points directly to the capture struct
    // Need to cast it to the appropriate capture struct type
    const captureTypeCName = functionContext.currentClosureCaptureTypeCName;
    if (captureTypeCName) {
      // Cast void* closure_context directly to the capture struct pointer
      return `((${captureTypeCName}*)closure_context)->${sanitizeForCIdentifier(expr.token.value)}`;
    }
    // Fallback to old approach if we can't determine the type (should not happen)
    return `closure_context->${sanitizeForCIdentifier(expr.token.value)}`;
  }

  // Fallback: Check if this is a closure function by looking at the current function name and finding its type
  if (
    functionContext.currentFunctionName &&
    !functionContext.currentClosureCaptures
  ) {
    // Find the function value being generated
    const currentFunctionEntry = Object.values(functionContext.functions).find(
      (entry) => entry.cName === functionContext.currentFunctionName
    );

    if (currentFunctionEntry && currentFunctionEntry.value.type.isClosure) {
      // This is a closure function, find its closure type
      const closureTypeEntry = Object.values(functionContext.types).find(
        (t) =>
          t.type.tag === TypeTag.Closure &&
          (t.type as ClosureType).callType === currentFunctionEntry.value.type
      );

      if (closureTypeEntry) {
        // Note: captureType is no longer on ClosureType, use naming convention
        const captureStructName = `${closureTypeEntry.cName}_capture`;
        return `((${captureStructName}*)closure_context->data)->${sanitizeForCIdentifier(expr.token.value)}`;
      }
    }
  }

  return sanitizeForCIdentifier(expr.token.value);
}

/**
 * Generate C code for a compile-time value - extracted from original codegen-c.ts
 */
function generateComptValue(
  value: Value,
  context: CodeGenContext,
  _sourceExpr?: Expr
): string {
  if (isNumberValue(value)) {
    // For numbers, we can directly return the value as a string
    return valueToString(value);
  } else if (isBooleanValue(value)) {
    // For booleans, return true/false
    return value.value ? "true" : "false";
  } else if (isComptStringValue(value)) {
    // Check if there's a converted runtime type (e.g., compt_string -> [u8]
    const targetType =
      _sourceExpr?.$?.convertedRuntimeType || _sourceExpr?.$?.type;

    // Check if the target type is a pointer to a slice (e.g., [u8]
    // In Yo, [u8] is a fat pointer (slice value), not a pointer to a slice struct
    // So we generate a slice struct value directly
    if (targetType && isMutPtrType(targetType)) {
      const pointeeType = targetType.type;
      if (isSliceType(pointeeType)) {
        const sliceCType = getTypeString(pointeeType, context);
        const stringLiteral = JSON.stringify(value.value);
        const stringLength = Buffer.byteLength(value.value, "utf8");

        // Generate slice struct value (fat pointer)
        return `(${sliceCType}){ .data = (uint8_t*)${stringLiteral}, .length = ${stringLength} }`;
      }
    }

    // For regular strings, return the C string literal with proper escaping
    return JSON.stringify(value.value);
  } else if (isEnumValue(value)) {
    // For enums, check if it's optimized as nullable pointer
    const enumType = value.type;
    const nullablePointerType = canOptimizeAsNullablePointer(enumType);

    if (nullablePointerType) {
      // Generate optimized nullable pointer construction
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant) {
        return `// Error: Variant ${value.variantName} not found in enum`;
      }

      if (!variant.elements || variant.elements.length === 0) {
        // This is the null case (None variant)
        return "NULL";
      } else if (variant.elements.length === 1 && value.elements.length === 1) {
        // This is the pointer case (Some variant)
        return generateComptValue(value.elements[0]!, context);
      }
    }

    // Check if this enum can be optimized as a simple C enum
    const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
    if (simpleEnumOptimizable) {
      // For simple enums, just return the enum constant
      return getEnumVariantCName(enumType, value.variantName, context);
    }

    // Generate regular tagged union construction
    const cName = context.types[enumType.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for enum ${typeToString(enumType)}`;
    }

    const variantTag = getEnumVariantCName(
      enumType,
      value.variantName,
      context
    );

    if (!value.elements || value.elements.length === 0) {
      // Variant with no data
      return `(${cName}){ .tag = ${variantTag} }`;
    } else {
      // Variant with data
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant || !variant.elements) {
        return `// Error: Variant ${value.variantName} not found or has no elements`;
      }

      // Filter out unit type fields
      const nonUnitFields = value.elements
        .map((element, index) => {
          const variantElement = variant.elements![index];
          if (variantElement && !isUnitType(variantElement.type)) {
            const fieldName = sanitizeForCIdentifier(variantElement.label);
            const fieldCode = generateComptValue(element, context);
            return `.${fieldName} = ${fieldCode}`;
          }
          return null;
        })
        .filter((f) => f !== null);

      // If all fields are unit types, just return the tag
      if (nonUnitFields.length === 0) {
        return `(${cName}){ .tag = ${variantTag} }`;
      }

      return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${nonUnitFields.join(", ")} } } }`;
    }
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      // Handle newtype as zero-cost abstraction
      if (
        type.isNewtype &&
        type.elements.length === 1 &&
        value.elements.length === 1
      ) {
        // For newtype, just use the underlying value with a cast
        const underlyingValue = generateComptValue(value.elements[0]!, context);
        return `((${cName})(${underlyingValue}))`;
      }

      if (type.isReferenceSemantics) {
        // For object compile-time values, use constructor function
        const fieldValues = value.elements.map((element) =>
          generateComptValue(element, context)
        );

        const constructorName = `__yo_new_${cName}`;
        return `${constructorName}(${fieldValues.join(", ")})`;
      } else {
        // For regular struct compile-time values, generate as before
        const fields = value.elements.map((element, index) => {
          const fieldValue = element;
          const fieldName = sanitizeForCIdentifier(type.elements[index]!.label);
          const fieldCode = generateComptValue(fieldValue, context);
          return `.${fieldName} = ${fieldCode}`;
        });

        return `(${cName}){ ${fields.join(", ")} }`;
      }
    }
  } else if (isArrayValue(value)) {
    // For array values, generate struct wrapper initialization
    const arrayType = value.type;
    const arrayTypeName = getTypeString(arrayType, context);
    const elementCodes = value.elements.map((element) =>
      generateComptValue(element, context)
    );
    return `(${arrayTypeName}){ .data = { ${elementCodes.join(", ")} } }`;
  } else if (isFunctionValue(value)) {
    // For function values, we need to register them and return their C function name
    const cName = context.functions[value.funcId]?.cName;
    if (cName) {
      return cName; // Return the function name as a function pointer
    } else {
      return `// Error: No C function name found for function value with ID ${value.funcId}\n`;
    }
  } else if (isTypeValue(value)) {
    // For type values, we can return the C type name if available
    const type = value.value;
    if (type) {
      if (context.types[type.id]) {
        return context.types[type.id]!.cName;
      } else {
        return `/* Error: No C type name found for type ${typeToString(type)} */`;
      }
    }
  }

  return ""; // No need to generate. It might be module value, etc
}

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
function generateFieldAccess(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return "/* ERROR: field access requires exactly 2 arguments */";
  }

  const objectExpr = expr.args[0];
  const fieldExpr = expr.args[1];

  if (!objectExpr || !fieldExpr) {
    return "/* ERROR: invalid field access arguments */";
  }

  const objectCode = generateExpr(objectExpr, indent, context);
  const objectType = objectExpr.$?.type;
  const objectValue = objectExpr.$?.value;

  if (exprIsAtom(fieldExpr)) {
    const fieldName = fieldExpr.token.value;

    // Check if this field access is actually a method access (function from type's module or nested modules)
    // This includes both direct type methods and methods from nested modules
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Fallback: Check if this is an ARC method call (___drop, ___dup, ___dispose)
    // Sometimes, we only called addARCFunctionSignaturesToStructType / addARCFunctionSignaturesToEnumType
    // So they are using the `undefined` function value, before we actually update its module elements.
    if (
      !expr.$?.value &&
      (BuiltinFunctions.___dispose.includes(fieldName) ||
        BuiltinFunctions.___drop.includes(fieldName) ||
        BuiltinFunctions.___dup.includes(fieldName)) &&
      objectType
    ) {
      // For ARC methods, we need to look up the function from the type's module
      // and return the function name directly instead of treating it as field access
      let typeModule: ModuleType | null = null;

      if (isStructType(objectType)) {
        typeModule = objectType.module;
      } else if (isEnumType(objectType)) {
        typeModule = objectType.module;
      }

      if (typeModule) {
        // Find the function in the type's module
        const functionElement = typeModule.elements.find(
          (element) =>
            element.label === fieldName &&
            element.assignedValue &&
            isFunctionValue(element.assignedValue)
        );

        if (functionElement && isFunctionValue(functionElement.assignedValue)) {
          const functionValue = functionElement.assignedValue;
          const cFunctionName =
            context.functions[functionValue.funcId]?.cName ||
            functionValue.funcId;
          return cFunctionName;
        } else {
          return `/* ERROR: ARC method ${fieldName} not found in type module */`;
        }
      } else {
        return `/* ERROR: No module found for ARC method ${fieldName} */`;
      }
    }

    // Handle newtype field access - just return the object itself (zero-cost abstraction)
    if (
      isStructType(objectType) &&
      objectType.isNewtype &&
      objectType.elements.length === 1
    ) {
      // For newtype, accessing the single field just returns the value itself
      // since newtype is typedef'd to the underlying type
      const singleField = objectType.elements[0];
      if (singleField && singleField.label === fieldName) {
        return objectCode;
      }
    }

    // Check if the object is an enum type
    if (isEnumType(objectType)) {
      const enumType = objectType;

      // Check if this enum is optimized as a nullable pointer
      const nullablePointerType = canOptimizeAsNullablePointer(enumType);
      if (nullablePointerType) {
        // For optimized nullable pointer enums, direct field access should be simplified
        // ptr.value becomes ptr (since ptr is already the pointer)
        // NOTE: No need to check fieldName, as the nullablePointerType always only has one field
        // if (fieldName === "value") {
        return objectCode; // Return the pointer directly
        // }
      }

      // For enum field access, we need to determine which variant contains this field
      // and generate the appropriate path: object.data.VariantName.fieldName
      for (const variant of enumType.variants) {
        if (variant.elements) {
          for (const element of variant.elements) {
            if (element.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no elements.
      // Like: Color.Red
      if (!!variant && !variant.elements && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Special handling for slice types: even if they appear as pointer types in AST,
    // they should use dot notation because we generate them as struct values
    else if (isMutPtrType(objectType) && isSliceType(objectType.type)) {
      // For slice types, always use dot notation regardless of pointer level in AST
      return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
    }
    // Check if the object is pointer or reference
    else if (isMutPtrType(objectType)) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
        return `*(${objectCode})`; // Dereference the pointer/reference
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (isMutPtrType(currentType)) {
          dereferenceLevel++;
          currentType = currentType.type;
        }
        if (dereferenceLevel > 0) {
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
          } else {
            // Multiple levels of dereference: **(ptr).field
            const dereferencedObjectCode = `${"*".repeat(dereferenceLevel - 1)}(${objectCode})`;
            return `${dereferencedObjectCode}->${sanitizeForCIdentifier(fieldName)}`;
          }
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.elements.findIndex(
          (element) => element.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    }
    // Handle dynamic dispatch method access
    else if (isDynType(objectType)) {
      // For dyn types, access methods through vtable
      // e.g. s.speak becomes s->vtable.speak
      return `${objectCode}->vtable.${sanitizeForCIdentifier(fieldName)}`;
    } else {
      // For C structs and unions, access fields directly
      // Check if this is a reference-counted type (object)
      if (isObjectType(objectType)) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
      }
    }
  }

  return "/* ERROR: field name must be an identifier */";
}

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
function generateCondExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if the cond expression has been evaluated and has a variable name
  if (expr.$) {
    const tempVar = expr.$.variableName;
    const valueType = expr.$.type;
    const isUnit = valueType && isUnitType(valueType);

    // For unit types, don't declare a temporary variable
    if (!isUnit && tempVar) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
    }

    // Generate if-else chain for each condition => value pair
    // Strategy:
    // - If all conditions before a compile-time true are compile-time false, just generate the value directly
    // - Otherwise: First condition becomes `if (...) {}`, all subsequent become nested in a single `else { ... }`

    // First pass: check if we can optimize to direct value generation
    let firstNonFalseBranchIndex = -1;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        const condition = arg.args[0];
        if (condition) {
          const isFalse =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false;
          if (!isFalse) {
            firstNonFalseBranchIndex = i;
            break;
          }
        }
      }
    }

    // Check if the first non-false branch is a compile-time true
    let canOptimizeToDirect = false;
    if (firstNonFalseBranchIndex >= 0) {
      const firstArg = expr.args[firstNonFalseBranchIndex];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, "=>", 2)
      ) {
        const firstCondition = firstArg.args[0];
        if (
          firstCondition &&
          isBooleanValue(firstCondition.$?.value) &&
          firstCondition.$.value.value === true
        ) {
          canOptimizeToDirect = true;
        }
      }
    }

    // If we can optimize to direct generation, just generate the value expression
    if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
      const arg = expr.args[firstNonFalseBranchIndex];
      if (
        arg &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, "=>", 2)
      ) {
        const value = arg.args[1];
        if (value) {
          // Generate the value expression directly
          const valueCode = generateExpr(value, indent, context);

          // Check if we need to assign to temp variable
          if (tempVar && !isUnit) {
            if (
              valueCode &&
              valueCode !== "" &&
              valueCode !== "continue" &&
              valueCode !== "break" &&
              !valueCode.includes("return")
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
          }
        }
      }

      // For unit types, return empty string; for others, return temp variable
      return isUnit ? "" : (tempVar ?? "");
    }

    // Otherwise, generate full if-else chain
    let currentIndent = indent;
    let elseBlockDepth = 0; // Track how many else blocks we need to close at the end
    let hasEmittedBranch = false; // Track whether we've emitted any branch (not skipped)

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          // Skip compile-time false conditions
          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false
          ) {
            continue;
          }

          // For the first EMITTED branch, generate `if (...) {}` or just `{}`
          if (!hasEmittedBranch) {
            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              // Compile-time true as first condition - just use a block
              context.emitter.emitLine(`${currentIndent}{`);
            } else {
              // Regular condition
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
            hasEmittedBranch = true;
          } else {
            // For subsequent conditions, wrap in `else {` and increment depth
            context.emitter.emitLine(`${currentIndent}else {`);
            elseBlockDepth++;
            currentIndent += "  ";

            const isCompileTimeTrue =
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true;

            if (isCompileTimeTrue) {
              // Compile-time true - no condition needed, value goes directly in the else block
              // We'll close the else block at the end, not here
            } else {
              // Regular condition - generate if inside the else block
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
          }

          // Determine the indent for the value block
          const isCompileTimeTrue =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true;

          // For compile-time true in else block (not first branch), don't add extra indentation
          const valueIndent =
            hasEmittedBranch && isCompileTimeTrue
              ? currentIndent
              : currentIndent + "  ";

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // For begin blocks in conditionals, we need to generate the statements inline
            // like generateLoopBody but also capture the final expression result

            const beginArgs = value.args;

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const arg = beginArgs[j]!;
              const argCode = generateExpr(arg, valueIndent, context);
              if (argCode) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0 && tempVar) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;
              const finalExprCode = generateExpr(
                finalExpr,
                valueIndent,
                context
              );

              if (finalExprCode) {
                if (!isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${finalExprCode};`
                  );
                }
              }
            }
          } else {
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, valueIndent, context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${valueIndent}${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              if (!isUnit) {
                context.emitter.emitLine(
                  `${valueIndent}${tempVar} = ${valueCode};`
                );
              }
            }
          }

          // Close the if/block for this condition
          // For compile-time true in an else block, we don't close anything here (the else block closes at the end)
          // For all other cases, close the if block or the initial block
          const needsClosing = !(hasEmittedBranch && isCompileTimeTrue);
          if (needsClosing) {
            context.emitter.emitLine(`${currentIndent}}`);
          }
        }
      }
    }

    // Close all the else blocks we opened
    for (let i = 0; i < elseBlockDepth; i++) {
      currentIndent = currentIndent.slice(0, -2); // Remove 2 spaces
      context.emitter.emitLine(`${currentIndent}}`);
    }

    // For unit types, return empty string; for others, return temp variable
    return isUnit ? "" : (tempVar ?? "");
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is not evaluated */';
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
function generateMatchExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$) {
    return `/* "match" expression is not evaluated */`;
  }
  const tempVariableName = expr.$.variableName;
  const valueType = expr.$.type;
  const isUnit = valueType && isUnitType(valueType);

  // Create temp variable declaration
  if (!isUnit && tempVariableName) {
    const varType = getTypeString(valueType, context);
    context.emitter.emitLine(`${indent}${varType} ${tempVariableName};`);
  }

  // Generate the matched value
  const matchedValueCode = generateExpr(expr.args[0]!, indent, context);
  const matchValueType = expr.args[0]!.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires an enum type`;
  }

  // Check if it's a pointer/reference type OR reference semantics type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.MutPtr | "ref_semantics" | undefined = undefined;

  let enumType: Type;
  if (isMutPtrType(matchValueType)) {
    enumType = matchValueType.type;
    ptrOrRefType = matchValueType.tag;
  } else if (isObjectType(matchValueType)) {
    // ref enum types are represented as pointers in C
    enumType = matchValueType;
    ptrOrRefType = "ref_semantics";
  } else {
    enumType = matchValueType;
  }

  if (!isEnumType(enumType)) {
    return `// Error: "match" expression requires an enum type`;
  }
  const enumCName = context.types[enumType.id]?.cName;
  if (!enumCName) {
    return `// Error: "match" expression enum type ${enumType.typeName} has no C name`;
  }

  // Check if this enum is optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate optimized nullable pointer matching using if/else instead of switch
    const caseExprs = expr.args.slice(1);

    // Find which variant is the null case and which is the pointer case
    let nullCase: { caseBody: Expr } | null = null;
    let pointerCase: {
      caseBody: Expr;
      variantName: string;
      casePattern: Expr;
    } | null = null;

    for (const caseExpr of caseExprs) {
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        const caseValue = caseExpr.args[0]!; // .None, .Some(ptr)
        const caseBody = caseExpr.args[1]!;

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".") // Destructuring pattern like .None
        ) {
          nullCase = { caseBody };
        } else {
          // Destructuring pattern like .Some(value)
          // Handle destructuring pattern
          const variantExpr = (caseValue as FuncCallExpr).func;
          // Check if variant is a field access like .Some
          if (
            variantExpr &&
            exprIsFunctionCall(variantExpr) &&
            exprIsFunctionCallOf(variantExpr, ".")
          ) {
            const variantNameExpr = variantExpr.args[0]!;
            if (variantNameExpr && exprIsAtom(variantNameExpr)) {
              const variantName = variantNameExpr.token.value;
              pointerCase = {
                caseBody,
                variantName,
                casePattern: caseValue,
              };
            }
          }
        }
      }
    }

    // Generate the optimized if/else structure
    context.emitter.emitLine(
      `${indent}if (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      // For nullable pointer optimization with destructuring pattern like .Some(value),
      // we need to bind the destructured variable to the pointer value
      if (
        exprIsFunctionCall(pointerCase.casePattern) &&
        pointerCase.casePattern.args.length > 0
      ) {
        // Destructuring pattern: .Some(value)
        const destructuredVar = pointerCase.casePattern.args[0];
        if (destructuredVar && exprIsAtom(destructuredVar)) {
          const varName = destructuredVar.token.value;
          const varType = nullablePointerType;
          // Declare and bind the destructured variable to the pointer
          context.emitter.emitLine(
            `${indent}  ${getTypeString(varType, context)} ${varName} = ${matchedValueCode};`
          );
        }
      }

      const bodyCode = generateExpr(
        pointerCase.caseBody,
        indent + "  ",
        context
      );
      if (!isUnit && tempVariableName) {
        // For nullable pointer match, the body returns the actual value
        // If bodyCode is empty or just returns the matched value itself, use the matched value
        const resultCode = bodyCode || matchedValueCode;
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${resultCode};`
        );
      } else if (bodyCode) {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateExpr(nullCase.caseBody, indent + "  ", context);
      if (!isUnit && tempVariableName) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate optimized simple enum matching
    context.emitter.emitLine(
      `${indent}switch (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode}) {`
    );

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value;
          const variantTag = getEnumVariantCName(
            enumType,
            variantName,
            context
          );

          // Generate the case label
          context.emitter.emitLine(`${indent}case ${variantTag}:`);

          // Generate the body of the case
          const bodyCode = generateExpr(caseBody, indent + "  ", context);
          if (!isUnit && tempVariableName && bodyCode) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType === "ref_semantics" || ptrOrRefType ? matchedValueCode + "->tag" : "(" + matchedValueCode + ").tag"}) {`
  );

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // This is a case => value pair
      const caseValue = caseExpr.args[0];
      let caseBody = caseExpr.args[1];

      if (
        caseValue &&
        caseBody &&
        // caseValue now has to be a variant:
        exprIsFunctionCall(caseValue) &&
        caseValue.func.tag === ExprTag.Atom &&
        caseValue.func.token.value === "." &&
        caseValue.args.length >= 1 // Allow 1 or more arguments for destructuring
      ) {
        const variantName = caseValue.args[0]!.token.value; // Get the variant name
        const variantTag = getEnumVariantCName(enumType, variantName, context);

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Handle destructuring patterns like .Point(point) => { ... }
        if (caseValue.args.length > 1) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.elements) {
            // Generate local variable declarations for destructured fields
            for (
              let fieldIndex = 0;
              fieldIndex <
              Math.min(caseValue.args.length - 1, variant.elements.length);
              fieldIndex++
            ) {
              const destructuredVar = caseValue.args[fieldIndex + 1]!; // Skip the variant name
              const variantElement = variant.elements[fieldIndex];

              if (destructuredVar.tag === ExprTag.Atom && variantElement) {
                // Skip unit type fields - they don't exist in the generated struct
                if (isUnitType(variantElement.type)) {
                  continue;
                }

                const varName = destructuredVar.token.value;
                const fieldName = sanitizeForCIdentifier(variantElement.label);
                const fieldType = getTypeString(variantElement.type, context);

                // Generate variable declaration and assignment
                const accessPrefix =
                  ptrOrRefType === "ref_semantics" || ptrOrRefType ? "->" : ".";
                context.emitter.emitLine(
                  `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                );
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateExpr(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }
        context.emitter.emitLine(`${indent}  break;`);
      }
      // Handle destructuring patterns like .Point(point) => { ... }
      else if (
        caseValue &&
        caseBody &&
        exprIsFunctionCall(caseValue) &&
        exprIsFunctionCall(caseValue.func) &&
        caseValue.func.func.tag === ExprTag.Atom &&
        caseValue.func.func.token.value === "." &&
        caseValue.func.args.length === 1
      ) {
        // Extract variant name from .Point(point) pattern
        const variantName = caseValue.func.args[0]!.token.value;
        const variantTag = getEnumVariantCName(enumType, variantName, context);
        const destructuringParams = caseValue.args;

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Generate local variable declarations for destructured fields
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant && variant.elements && destructuringParams.length > 0) {
          for (
            let fieldIndex = 0;
            fieldIndex <
            Math.min(destructuringParams.length, variant.elements.length);
            fieldIndex++
          ) {
            const destructuredVar = destructuringParams[fieldIndex]!;
            const variantElement = variant.elements[fieldIndex];

            if (destructuredVar.tag === ExprTag.Atom && variantElement) {
              const varName = destructuredVar.token.value;

              // Skip if variable name is "_" (ignore pattern)
              if (varName !== "_") {
                // For unit type fields, generate a comment instead of a variable
                // This allows the variable name to be "declared" without generating invalid C
                if (isUnitType(variantElement.type)) {
                  context.emitter.emitLine(
                    `${indent}  // ${varName} is unit type (no value)`
                  );
                  // Register this as a unit variable so expression generation can handle it
                  // (Expression generation should skip generating references to unit variables)
                } else {
                  const fieldName = sanitizeForCIdentifier(
                    variantElement.label
                  );
                  const fieldType = getTypeString(variantElement.type, context);

                  // Generate variable declaration and assignment
                  const accessPrefix =
                    ptrOrRefType === "ref_semantics" || ptrOrRefType
                      ? "->"
                      : ".";
                  context.emitter.emitLine(
                    `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                  );
                }
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateExpr(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }
        context.emitter.emitLine(`${indent}  break;`);
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);
  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
}

/**
 * Generate a return statement for a function body expression - extracted from original codegen-c.ts
 */
export function generateReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  switch (expr.tag) {
    case ExprTag.Atom: {
      // Use generateExpressionAsCode to handle compile-time values
      const atomCode = generateAtom(expr, context);
      context.emitter.emitLine(`${indent}return ${atomCode};`);
      break;
    }
    case ExprTag.FuncCall: {
      const funcCallCode = generateFuncCall(expr, indent, context);
      if (!exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
        context.emitter.emitLine(`${indent}return ${funcCallCode};`);
      } else {
        context.emitter.emitLine(`${indent}${funcCallCode};`);
      }
      break;
    }
  }
}

/**
 * Generate Yo operator function call - extracted from original codegen-c.ts
 */
function generateYoInlineFunctionCall(
  functionName: string,
  args: string[],
  expr: FuncCallExpr,
  context: CodeGenContext
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
  else if (BuiltinFunctions.__yo_op_xor.includes(functionName)) {
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
    // Windows Sleep takes milliseconds, usleep takes microseconds
    return `(
#ifdef _WIN32
Sleep(${args[0]!})
#else
usleep((${args[0]!}) * 1000)
#endif
)`;
  }
  // __yo_decr_rc
  else if (BuiltinFunctions.__yo_decr_rc.includes(functionName)) {
    return `__yo_decr_rc((void*)(${args[0]!}))`;
  }
  // __yo_ptr_cast
  else if (BuiltinFunctions.__yo_ptr_cast.includes(functionName)) {
    const typeValueArg = expr.args[expr.args.length - 1]!;
    const typeValue = typeValueArg.$?.value as TypeValue;
    const targetCType = getTypeString(typeValue.value, context);
    return `((${targetCType})(${args[0]!}))`;
  }
  // __yo_as - generic type casting (when type-specific __yo_*_as is simplified)
  else if (BuiltinFunctions.__yo_as.includes(functionName) && expr.$?.type) {
    // The return type tells us what to cast to
    const targetCType = getTypeString(expr.$.type, context);
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
  // Handle other operators that are not defined in Yo
  else {
    return `/* Unhandled operator ${functionName} */`;
  }
}

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
function generateWhileLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    const conditionCode = generateExpr(conditionExpr, indent, context);

    context.emitter.emitLine(`${indent}while (${conditionCode}) {`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    const conditionCode = generateExpr(conditionExpr, indent, context);
    const stepCode = generateStepExpression(stepExpr, context);

    // Generate for loop: for (; condition; step) { body }
    context.emitter.emitLine(
      `${indent}for (; ${conditionCode}; ${stepCode}) {`
    );
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}

/**
 * Generate C code for for loop expression
 * Converts Yo for loops to C for loops with array iteration
 */
function generateForLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length !== 2) {
    context.emitter.emitLine(
      `${indent}/* Error: for loop expects 2 arguments, got ${args.length} */`
    );
    return "";
  }

  const itemsExpr = args[0]!; // Array/slice expression
  const arrowExpr = args[1]!; // lambda expression: (bindings) => body

  if (
    !exprIsFunctionCall(arrowExpr) ||
    !exprIsFunctionCallOf(arrowExpr, "=>", 2)
  ) {
    context.emitter.emitLine(
      `${indent}/* Error: for loop second argument must be => expression */`
    );
    return "";
  }

  const bindingExpr = arrowExpr.args[0]!;
  const bodyExpr = arrowExpr.args[1]!;

  // Generate the array expression
  const arrayCode = generateExpr(itemsExpr, indent, context);

  // Extract variable names from bindings
  let elementVarName: string | undefined;
  let indexVarName: string | undefined;

  // Parse the binding expression to extract variable names
  if (exprIsAtom(bindingExpr)) {
    // Simple case: for arr, elem => body
    elementVarName = bindingExpr.token.value;
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.tuple)
  ) {
    // Tuple case: for arr, (elem, index) => body
    const firstArg = bindingExpr.args[0];
    const secondArg = bindingExpr.args[1];

    if (firstArg) {
      if (exprIsAtom(firstArg)) {
        elementVarName = firstArg.token.value;
      }
    }

    if (secondArg && exprIsAtom(secondArg)) {
      indexVarName = secondArg.token.value;
    }
  }

  if (!elementVarName) {
    context.emitter.emitLine(
      `${indent}/* Error: could not extract element variable name from for loop binding */`
    );
    return "";
  }

  // Get the type information from the evaluated expressions
  const itemsType = itemsExpr.$?.type;

  // Generate unique index variable name if not provided
  const actualIndexVarName =
    indexVarName || `__index_${Math.random().toString(36).substr(2, 9)}`;

  // Get type strings for variable declarations
  let elementTypeStr = "int"; // default fallback
  let arrayLength = "0"; // default fallback

  if (itemsType && isArrayType(itemsType)) {
    elementTypeStr = getTypeString(itemsType.elementType, context);
    // Extract the numeric value from the length Value
    const lengthValue = itemsType.length;
    if (lengthValue && isNumberValue(lengthValue)) {
      arrayLength = lengthValue.value.toString();
    }
  } else if (
    itemsType &&
    (isSliceType(itemsType) ||
      (isMutPtrType(itemsType) && isSliceType(itemsType.type)))
  ) {
    // Handle slice iteration
    const sliceType = isSliceType(itemsType)
      ? (itemsType as SliceType)
      : (itemsType.type as SliceType);
    elementTypeStr = getTypeString(sliceType.elementType, context);
    arrayLength = `${arrayCode}.length`; // Use runtime length from slice
  }

  // Generate the C for loop
  // For arrays, we iterate through indices and access elements
  context.emitter.emitLine(
    `${indent}for (size_t ${actualIndexVarName} = 0; ${actualIndexVarName} < ${arrayLength}; ${actualIndexVarName}++) {`
  );

  // Declare the element variable and assign from array
  context.emitter.emitLine(
    `${indent}  ${elementTypeStr} ${elementVarName} = ${arrayCode}.data[${actualIndexVarName}];`
  );

  // If the user provided an index variable name, declare it as an alias to actualIndexVarName
  if (indexVarName && indexVarName !== actualIndexVarName) {
    context.emitter.emitLine(
      `${indent}  size_t ${indexVarName} = ${actualIndexVarName};`
    );
  }

  // Generate the loop body
  generateLoopBody(bodyExpr, indent + "  ", context);

  context.emitter.emitLine(`${indent}}`);

  return "";
}

export function generateDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate all deferred async block implementations.
 * This must be called after all regular functions are generated,
 * so that async block resume/constructor functions don't get nested inside other functions.
 */
export function generateDeferredAsyncBlocks(
  context: FunctionGenerationContext
): void {
  if (
    !context.deferredAsyncBlocks ||
    context.deferredAsyncBlocks.length === 0
  ) {
    return;
  }

  const emitter = context.emitter;
  emitter.emitLine(`// Deferred async block implementations`);

  for (const asyncBlockInfo of context.deferredAsyncBlocks) {
    const {
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      constructorName,
      disposeFunctionName,
      futureType,
      futureTypeCName,
      captureType,
      analysis,
    } = asyncBlockInfo;

    // Generate state machine dispose function
    generateAsyncBlockStateDisposeFunction(
      asyncBlockId,
      structName,
      disposeFunctionName,
      captureType,
      analysis,
      context
    );

    emitter.emitLine(``);

    // Generate resume function implementation
    generateAsyncBlockResumeFunction(
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      analysis,
      futureType,
      captureType,
      context
    );

    emitter.emitLine(``);

    // Generate constructor function implementation
    generateAsyncBlockConstructor(
      asyncBlockId,
      structName,
      resumeFunctionName,
      constructorName,
      disposeFunctionName,
      futureType,
      futureTypeCName,
      captureType,
      context
    );

    emitter.emitLine(``);
  }
}
