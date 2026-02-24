import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import type { AwaitAnalysisResult } from "../../evaluator/async/await-analysis-types";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  type AtomExpr,
  BuiltinFunctions,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  type FnCallExpr,
} from "../../expr";
import type {
  DynType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import { isSomeType, isUnitType } from "../../types/guards";
import { typeContainsRcType, typeToString } from "../../types/utils";
import { isFunctionValue } from "../../value";
import {
  generateAsyncBlockResumeFunction,
  getStateMachineFieldName,
} from "../async/state-machine";
import type { FunctionGenerationContext } from "../functions/context";
import { getTypeString, getVariableTypeString } from "../utils";
import { generateAtom } from "./atom";
import { getDropFunctionForType, getDupFunctionForType } from "./drop-dup";
import { generateExpr } from "./expr";

/**
 * Generate C code for an async block expression.
 * async { body } creates a Future by calling a constructor function
 * similar to how closures are created.
 */
export function generateAsyncBlock(
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  // For io.async(closure) calls, extract the body from the closure's function value.
  // For regular async { body } blocks, the body is expr.args[0].
  let bodyExpr: Expr | undefined;
  if (isIoAsyncCall(expr)) {
    const closureArg = expr.$?.runtimeArgExprsInOrder?.[0];
    const closureFnValue = closureArg?.$?.closureFunctionValue;
    if (closureFnValue && isFunctionValue(closureFnValue)) {
      bodyExpr = closureFnValue.body;
    }
  } else {
    bodyExpr = expr.args[0];
  }
  if (!bodyExpr) {
    return `/* Error: async requires exactly 1 argument */`;
  }

  const futureType = expr.$?.type;
  if (!futureType || !typeImplementsFuture(futureType)) {
    return `/* Error: async block must have Future type */`;
  }

  // Extract the FutureTraitType from Impl(Future(T)) or Dyn(Future(T))
  const futureModuleType = extractFutureTraitFromType(futureType);
  if (!futureModuleType) {
    return `/* Error: Could not extract Future module type */`;
  }

  // The state machine struct name will be based on the async block ID
  // This struct IS the Future implementation (value type, not pointer)
  const asyncBlockId = expr.$?.variableName || `async_block_${Date.now()}`;
  const structName = `${asyncBlockId}_state_t`;
  const resumeFunctionName = `${asyncBlockId}_resume`;
  const constructorName = `__yo_new_${asyncBlockId}`;
  const disposeFunctionName = `${asyncBlockId}_state_dispose`;

  // Register this state machine struct as the concrete type for this specific async block's SomeType.
  // IMPORTANT: We use futureType.id (the SomeType's ID) rather than futureModuleType.id because
  // each async block creates its own fresh SomeType, but they may share the same FutureTraitType
  // (e.g., multiple async blocks returning Impl(Future(unit)) share the same Future(unit) module).
  // Using the SomeType's unique ID ensures each async block gets its own state machine struct.
  context.types[futureType.id] = {
    type: futureType,
    cName: structName,
  };

  // Get the await analysis result that was computed during evaluation
  // This avoids redundant tree walking and ensures consistency
  const analysis = expr.$?.awaitAnalysis;
  if (!analysis) {
    throw new Error(
      `Missing await analysis for async block. This should have been computed during evaluation.`
    );
  }

  // Get the result type (T in Future(T))
  const resultType = futureModuleType.isFuture.outputType;
  const resultTypeCName = getTypeString(resultType, context);

  const emitter = context.emitter;

  // Generate forward declaration for state machine dispose function
  emitter.emitDeclarationLine(
    `void ${disposeFunctionName}(void* sm_ptr);  // Dispose function for state machine`
  );
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for resume function
  emitter.emitDeclarationLine(`void ${resumeFunctionName}(${structName}* sm);`);
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for constructor function
  // Constructor returns the state machine struct by value (not a pointer)
  if (expr.$?.captureType) {
    const captureType = expr.$.captureType;
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitDeclarationLine(
      `${structName}* ${constructorName}(${captureStructName} __capture);`
    );
  } else {
    emitter.emitDeclarationLine(`${structName}* ${constructorName}();`);
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
    futureType: futureType,
    futureModuleType: futureModuleType,
    resultType: resultType,
    resultTypeCName: resultTypeCName,
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
    // Otherwise, use dup expressions if available (they handle proper Rc semantics)
    const functionContext = context as FunctionGenerationContext;
    const inSpecialContext =
      functionContext.currentClosureCaptures !== undefined ||
      functionContext.inStateMachine !== undefined;

    const captureFields = captureType.fields
      .map((elem) => {
        // Find the dup expression for this variable by checking the variable name
        // deferredDupExpressions only contains dup expressions for Rc types,
        // so we need to match by variable name, not by index
        let dupExpr: Expr | undefined;
        if (!inSpecialContext && expr.$?.deferredDupExpressions) {
          for (const possibleDupExpr of expr.$.deferredDupExpressions) {
            // Dup expression can be in two forms:
            // 1. Method call: (varName.___dup)()
            // 2. Function call: ___dup(varName)
            let varName: string | undefined;

            if (exprIsFunctionCall(possibleDupExpr)) {
              // Check for function call: ___dup(varName)
              if (
                possibleDupExpr.args.length > 0 &&
                exprIsAtom(possibleDupExpr.args[0])
              ) {
                varName = possibleDupExpr.args[0].token.value;
              }
              // Check for method call: (varName.___dup)()
              else if (
                possibleDupExpr.args.length === 0 &&
                exprIsFunctionCall(possibleDupExpr.func) &&
                exprIsFunctionCallOf(possibleDupExpr.func, ".") &&
                possibleDupExpr.func.args.length >= 2 &&
                exprIsAtom(possibleDupExpr.func.args[0])
              ) {
                varName = possibleDupExpr.func.args[0].token.value;
              }
            }

            if (varName === elem.label) {
              dupExpr = possibleDupExpr;
              break;
            }
          }
        }

        if (dupExpr) {
          // Generate the dup expression
          // If the dup expression has a temp variable, we need to generate it outside the struct literal
          if (dupExpr.$?.variableName) {
            // Generate the temp variable declaration and assignment outside the struct
            /* const _dupCode = */ generateExpr(dupExpr, indent, context);
            // Return just the variable name for use in the struct literal
            return `.${elem.label} = ${dupExpr.$.variableName}`;
          } else {
            // No temp variable, generate inline
            return `.${elem.label} = ${generateExpr(dupExpr, indent, context)}`;
          }
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

    let captureStructLiteral = `(${captureStructName}){${captureFields}}`;

    // When in a special context (state machine/closure), deferredDupExpressions are skipped
    // because they reference variables by original names that don't exist in the special context.
    // But we still need to dup RC fields in the capture struct to maintain proper ref counts.
    // Use the capture struct type's dup function to dup all RC fields at once.
    if (
      inSpecialContext &&
      expr.$?.deferredDupExpressions &&
      expr.$.deferredDupExpressions.length > 0
    ) {
      const dupFnName = getDupFunctionForType(captureType, context);
      if (dupFnName) {
        captureStructLiteral = `${dupFnName}(${captureStructLiteral})`;
      }
    }

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
      // Lazy execution: future stays cold until await/join starts it.
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
      // Lazy execution: future stays cold until await/join starts it.
      return resultVar;
    } else {
      return constructorCall;
    }
  }
}

function emitAsyncBlockStructDefinition(
  asyncBlockInfo: {
    asyncBlockId: string;
    structName: string;
    resultType: Type;
    resultTypeCName: string;
    captureType: StructType | undefined;
    analysis: AwaitAnalysisResult;
  },
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const {
    asyncBlockId,
    structName,
    resultType,
    resultTypeCName,
    captureType,
    analysis,
  } = asyncBlockInfo;

  emitter.emitDeclarationLine(
    `// State machine for async block ${asyncBlockId} - implements Future(${typeToString(resultType)})`
  );
  emitter.emitDeclarationLine(`struct ${structName}_struct {`);

  // Reference counting header - must be first for yo_ref_header_t* casting
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header;  // Reference counting header (must be first)`
  );

  emitter.emitDeclarationLine(
    `  _Atomic int state;  // Current state (0 = initial, ${analysis.awaitPoints.length + 1} = done, -1 = completed)`
  );

  // Always include a result field to keep continuation_fn/continuation_sm at consistent offsets
  // For unit type, use uint8_t as a dummy (cannot use void in struct)
  if (isUnitType(resultType)) {
    emitter.emitDeclarationLine(
      `  uint8_t result;  // Dummy result for unit type`
    );
  } else {
    emitter.emitDeclarationLine(
      `  ${resultTypeCName} result;  // The result value of type ${typeToString(resultType)}`
    );
  }

  // Continuation tracking fields for await chaining
  emitter.emitDeclarationLine(
    `  _Atomic(void (*)(void*)) continuation_fn;  // Resume function of awaiting task`
  );
  emitter.emitDeclarationLine(
    `  _Atomic(void*) continuation_sm;  // State machine of awaiting task`
  );
  emitter.emitDeclarationLine(``);

  // Resume function pointer for lazy start at await
  emitter.emitDeclarationLine(
    `  void (*__yo_resume_fn)(void*);  // Resume function pointer (for lazy start at await/join)`
  );
  emitter.emitDeclarationLine(``);

  // Capture struct field
  if (captureType) {
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

  // Local variables (exclude "outer" variables which are in the __capture struct)
  const localVariables = analysis.capturedVariables.filter(
    (v) => v.kind !== "outer"
  );
  if (localVariables.length > 0) {
    emitter.emitDeclarationLine(`  // Local variables`);
    for (const variable of localVariables) {
      const varTypeCName = getTypeString(variable.type, context);
      const fieldName = getStateMachineFieldName(variable.id, "local");
      emitter.emitDeclarationLine(
        `  ${varTypeCName} ${fieldName};  // ${variable.name}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Await result temporaries
  if (analysis.awaitPoints.length > 0) {
    emitter.emitDeclarationLine(`  // Await result temporaries`);
    for (const awaitPoint of analysis.awaitPoints) {
      // When the output type is an unresolved SomeType (e.g., forall(T) from
      // io.await evaluated with io=UnknownValue), treat it as unit since the
      // generic type parameter couldn't be resolved to a concrete type.
      const isEffectivelyUnit =
        isUnitType(awaitPoint.resultType) ||
        (isSomeType(awaitPoint.resultType) &&
          !awaitPoint.resultType.resolvedConcreteType);
      if (!isEffectivelyUnit) {
        // Determine the correct type for await_result_X:
        // For extern futures (e.g., io_uring), use the Future's result type directly
        // For async block futures, use awaitPoint.resultType (which matches the block's result)
        let awaitResultType = awaitPoint.resultType;

        if (awaitPoint.futureType) {
          const futureModuleType = extractFutureTraitFromType(
            awaitPoint.futureType
          );
          if (futureModuleType) {
            // Use the Future's output type as the await_result type
            awaitResultType = futureModuleType.isFuture.outputType;
          }
        }

        const awaitResultTypeCName = getTypeString(awaitResultType, context);
        emitter.emitDeclarationLine(
          `  ${awaitResultTypeCName} await_result_${awaitPoint.index};`
        );
      }
    }
    emitter.emitDeclarationLine(``);
  }

  // await_future_X fields (used when awaiting an expression that isn't a captured Future variable)
  if (analysis.awaitPoints.length > 0) {
    const awaitPointsNeedingFutureStorage = analysis.awaitPoints.filter(
      (ap) => ap.futureVariableId === undefined && !ap.isJoinPoint
    );
    if (awaitPointsNeedingFutureStorage.length > 0) {
      emitter.emitDeclarationLine(`  // Future references for awaits`);
      for (const awaitPoint of awaitPointsNeedingFutureStorage) {
        const awaitExpr = awaitPoint.expr as Expr;
        if (awaitExpr.tag !== ExprTag.FnCall) {
          continue;
        }
        const futureExpr = awaitExpr.args[0];
        const futureType = futureExpr?.$?.type;
        if (!futureType) {
          throw new Error(
            `Internal error: await expression missing type info for future argument in async block ${asyncBlockId}`
          );
        }
        const awaitedFutureTypeCName = getTypeString(futureType, context);
        emitter.emitDeclarationLine(
          `  ${awaitedFutureTypeCName} await_future_${awaitPoint.index};`
        );
      }
      emitter.emitDeclarationLine(``);
    }
  }

  // cond_branch_X fields
  const condAwaitPoints = analysis.awaitPoints.filter(
    (ap) => ap.needsOwnCondBranchField
  );
  if (condAwaitPoints.length > 0) {
    emitter.emitDeclarationLine(
      `  // Branch tracking for cond expressions with await`
    );
    for (const awaitPoint of condAwaitPoints) {
      emitter.emitDeclarationLine(
        `  int cond_branch_${awaitPoint.index};  // Which branch was taken in cond with await ${awaitPoint.index}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // while_loop_X_active fields
  const whileAwaitPoints = analysis.awaitPoints.filter(
    (ap) => ap.isInsideWhile
  );
  if (whileAwaitPoints.length > 0) {
    emitter.emitDeclarationLine(
      `  // Loop state tracking for while loops with await`
    );
    let nextExtraWhileIndex = analysis.awaitPoints.length;
    for (const awaitPoint of whileAwaitPoints) {
      // Innermost while uses the awaitPoint.index
      emitter.emitDeclarationLine(
        `  _Bool while_loop_${awaitPoint.index}_active;  // Whether while loop ${awaitPoint.index} should continue`
      );
      // Outer while loops (nesting depth > 1) need additional active fields
      const extraDepth = (awaitPoint.whileNestingDepth ?? 1) - 1;
      for (let d = 0; d < extraDepth; d++) {
        emitter.emitDeclarationLine(
          `  _Bool while_loop_${nextExtraWhileIndex}_active;  // Whether outer while loop ${nextExtraWhileIndex} should continue`
        );
        nextExtraWhileIndex++;
      }
    }
    emitter.emitDeclarationLine(``);
  }

  // join_pending_N fields (atomic counter for join points)
  const joinPoints = analysis.awaitPoints.filter((ap) => ap.isJoinPoint);
  if (joinPoints.length > 0) {
    emitter.emitDeclarationLine(`  // Join pending counters`);
    for (const jp of joinPoints) {
      emitter.emitDeclarationLine(
        `  _Atomic int join_pending_${jp.index};  // Pending count for join ${jp.index}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);
}

function emitDeferredAsyncBlockStructDefinitions(
  context: FunctionGenerationContext
): void {
  if (
    !context.deferredAsyncBlocks ||
    context.deferredAsyncBlocks.length === 0
  ) {
    return;
  }

  const blocks = context.deferredAsyncBlocks;
  const byStructName = new Map<string, (typeof blocks)[number]>();
  for (const b of blocks) {
    byStructName.set(b.structName, b);
  }

  // Build dependency graph: A depends on B if A's struct embeds B by value.
  // For Kahn's algorithm we store reverse edges: B -> {A...}.
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const b of blocks) {
    dependents.set(b.structName, new Set());
    indegree.set(b.structName, 0);
  }

  for (const b of blocks) {
    const addDep = (depStructName: string) => {
      // depStructName must be emitted before b.structName
      const ds = dependents.get(depStructName)!;
      if (ds.has(b.structName)) {
        return;
      }
      ds.add(b.structName);
      indegree.set(b.structName, (indegree.get(b.structName) ?? 0) + 1);
    };

    // Local variable fields
    for (const v of b.analysis.capturedVariables) {
      // Try to get the C type string for the variable type
      // If it fails (not registered), skip this dependency - it's from an external function
      let t: string;
      try {
        t = getTypeString(v.type, context);
      } catch (e) {
        // Type not registered yet - skip this dependency check
        continue;
      }

      const target = byStructName.get(t);
      if (target && target.structName !== b.structName) {
        addDep(target.structName);
      }
    }

    // await_future_X fields
    for (const ap of b.analysis.awaitPoints) {
      if (ap.futureVariableId !== undefined) {
        continue;
      }
      const awaitExpr = ap.expr as Expr;
      if (awaitExpr.tag !== ExprTag.FnCall) {
        continue;
      }
      const futureExpr = awaitExpr.args[0];
      const futureType = futureExpr?.$?.type;
      if (!futureType) {
        continue;
      }

      // Try to get the C type string for the future type
      // If it fails (not registered), skip this dependency - it's from an external function
      let t: string;
      try {
        t = getTypeString(futureType, context);
      } catch (e) {
        // Future type not registered yet - it's from a function call, not an inline async block
        // Skip this dependency check
        continue;
      }

      const target = byStructName.get(t);
      if (target && target.structName !== b.structName) {
        addDep(target.structName);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of indegree.entries()) {
    if (deg === 0) queue.push(name);
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    ordered.push(n);
    const ds = dependents.get(n);
    if (!ds) continue;
    for (const m of ds) {
      const next = (indegree.get(m) ?? 0) - 1;
      indegree.set(m, next);
      if (next === 0) queue.push(m);
    }
  }

  // If there are cycles (shouldn't happen), fall back to input order
  const orderedBlocks =
    ordered.length === blocks.length
      ? ordered.map((n) => byStructName.get(n)!).filter(Boolean)
      : blocks;

  for (const b of orderedBlocks) {
    emitAsyncBlockStructDefinition(
      {
        asyncBlockId: b.asyncBlockId,
        structName: b.structName,
        resultType: b.resultType,
        resultTypeCName: b.resultTypeCName,
        captureType: b.captureType,
        analysis: b.analysis,
      },
      context
    );
  }
}

/**
 * Generate the state machine struct, resume function, and constructor for an async block.
 * This reuses the async function state machine infrastructure.
 */
/**
 * Generate the state machine dispose function for an async block.
 * This drops the capture struct before freeing the state machine.
 *
 * NOTE: This is the dispose function, called by __yo_decr_rc when refcount hits 0.
 * It should NOT call __yo_free - that's handled by __yo_decr_rc.
 */
function generateAsyncBlockStateDisposeFunction(
  asyncBlockId: string,
  structName: string,
  disposeFunctionName: string,
  resultType: Type,
  captureType: StructType | undefined,
  analysis: AwaitAnalysisResult,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  emitter.emitLine(
    `// Dispose function for async block ${asyncBlockId} state machine`
  );
  emitter.emitLine(
    `// Called by __yo_decr_rc when refcount hits 0 - do NOT call __yo_free here`
  );
  emitter.emitLine(`void ${disposeFunctionName}(void* sm_ptr) {`);
  emitter.emitLine(`  ${structName}* sm = (${structName}*)sm_ptr;`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${disposeFunctionName}: Disposing state machine\\n");`
  );
  emitter.emitLine(``);

  // Drop capture struct (like closures do)
  if (captureType && typeContainsRcType(captureType)) {
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
      const dropFunction = captureType.trait.fields.find(
        (field) => field.label === BuiltinFunctions.___drop[0]
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

  // Drop the result field if it contains GC-managed data
  // This is critical: when the state machine completes, the result is stored
  // but never dropped. The dispose function must clean it up.
  if (!isUnitType(resultType) && typeContainsRcType(resultType)) {
    const resultTypeCName = getTypeString(resultType, context);

    emitter.emitLine(
      `  // Drop result field if it was set (state == -1 means completed)`
    );
    emitter.emitLine(
      `  int final_state = atomic_load_explicit(&sm->state, memory_order_acquire);`
    );
    emitter.emitLine(`  if (final_state == -1) {`);
    emitter.emitLine(`    ASYNC_DEBUG("  Dropping result field\\n");`);

    // Find the ___drop function for the result type
    const dropFunctionName = getDropFunctionForType(resultType, context);
    if (dropFunctionName) {
      emitter.emitLine(`    ${dropFunctionName}(sm->result);`);
    } else {
      emitter.emitLine(
        `    /* Warning: No ___drop function found for result type ${resultTypeCName} */`
      );
    }

    emitter.emitLine(`  }`);
  }

  emitter.emitLine(``);

  // NOTE: Local variables are ALWAYS handled by deferred drop expressions
  // that run in the final state before completion. The state machine dispose
  // function only needs to clean up captured variables and the result field.
  // Memory is freed by __yo_decr_rc after this function returns.

  emitter.emitLine(
    `  // Memory freed by __yo_decr_rc after this function returns`
  );
  emitter.emitLine(`}`);
}

/**
 * Generate the resume function for an async block.
 * This follows the same pattern as async function resume functions.
 */
/**
 * Generate the constructor function for an async block.
 * The constructor allocates the state machine and Future, initializes captured variables,
 * and returns a cold (unstarted) future.
 *
 * LIFETIME MODEL (lazy execution):
 * - State machine starts with refcount = 1 (owned by caller)
 * - await/join increments refcount when starting the task (event loop reference)
 * - Completion decrements refcount (releases event loop reference)
 * - User code decrements refcount when dropping the Future
 * - State machine is freed when refcount hits 0
 */
function generateAsyncBlockConstructor(
  asyncBlockId: string,
  structName: string,
  resumeFunctionName: string,
  constructorName: string,
  disposeFunctionName: string,
  futureType: SomeType | DynType,
  resultType: Type,
  resultTypeCName: string,
  captureType: StructType | undefined,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Ensure Future/state-machine struct has a stable address: allocate on heap and return pointer.

  // Generate constructor signature - returns pointer
  if (captureType) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitLine(
      `${structName}* ${constructorName}(${captureStructName} __capture) {`
    );
  } else {
    emitter.emitLine(`${structName}* ${constructorName}() {`);
  }

  // Allocate + initialize async block state machine
  emitter.emitLine(
    `  // Allocate async block state machine (heap-backed, ref-counted)`
  );
  emitter.emitLine(
    `  ${structName}* sm = (${structName}*)__yo_malloc(sizeof(${structName}));`
  );
  emitter.emitLine(`  memset(sm, 0, sizeof(${structName}));`);
  emitter.emitLine(``);

  // Initialize reference counting header
  emitter.emitLine(`  // Initialize reference counting header`);
  emitter.emitLine(
    `  sm->header.ref_count = 1;  // Caller owns initial reference`
  );
  emitter.emitLine(
    `  GC_DEBUG("AsyncBlock ${structName}: Created ptr=%p RC=1\\n", (void*)sm);`
  );
  emitter.emitLine(`  sm->header.gc_flags = 0;`);
  emitter.emitLine(`  sm->header.gc_mark = YO_GC_UNMARKED;`);
  emitter.emitLine(`  sm->header.gc_next = NULL;`);
  emitter.emitLine(`  sm->header.gc_prev = NULL;`);
  emitter.emitLine(
    `  sm->header.dispose_fn = (void(*)(void*))${disposeFunctionName};`
  );
  emitter.emitLine(
    `  sm->header.traverse_fn = NULL;  // TODO: Add traverse for cycle detection if needed`
  );
  emitter.emitLine(``);

  emitter.emitLine(`  atomic_init(&sm->state, 0);`);
  emitter.emitLine(`  atomic_init(&sm->continuation_fn, NULL);`);
  emitter.emitLine(`  atomic_init(&sm->continuation_sm, NULL);`);
  emitter.emitLine(``);

  // Initialize capture struct
  if (captureType) {
    emitter.emitLine(`  // Initialize captured variables`);
    emitter.emitLine(`  sm->__capture = __capture;`);
    emitter.emitLine(``);
  }

  // Initialize result to default/zero value
  // For now, we just zero-initialize
  emitter.emitLine(
    `  // Initialize result (will be set when async block completes)`
  );
  if (isUnitType(resultType)) {
    emitter.emitLine(`  // Result is unit type, no initialization needed`);
  } else {
    emitter.emitLine(`  memset(&sm->result, 0, sizeof(${resultTypeCName}));`);
  }
  emitter.emitLine(``);

  // Store resume function pointer for lazy start at await/join
  emitter.emitLine(
    `  sm->__yo_resume_fn = (void(*)(void*))${resumeFunctionName};`
  );
  emitter.emitLine(``);

  emitter.emitLine(`  return sm;`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);
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

  // Emit all async block struct definitions in a dependency-safe order.
  // This avoids incomplete-type errors when one state machine embeds another by value.
  emitDeferredAsyncBlockStructDefinitions(context);

  emitter.emitLine(`// Deferred async block implementations`);

  // Use index-based loop because generating resume functions for outer async blocks
  // may discover nested async blocks (e.g., `async { task := async { ... }; await task; }`)
  // which get pushed to deferredAsyncBlocks during iteration.
  let i = 0;
  while (i < context.deferredAsyncBlocks.length) {
    const asyncBlockInfo = context.deferredAsyncBlocks[i]!;
    const prevLength = context.deferredAsyncBlocks.length;

    const {
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      constructorName,
      disposeFunctionName,
      futureType,
      //      futureModuleType,
      resultType,
      resultTypeCName,
      captureType,
      analysis,
    } = asyncBlockInfo;

    // Generate state machine dispose function
    generateAsyncBlockStateDisposeFunction(
      asyncBlockId,
      structName,
      disposeFunctionName,
      resultType,
      captureType,
      analysis,
      context
    );

    emitter.emitLine(``);

    // Generate join notify functions for each join point
    if (analysis.awaitPoints.some((ap) => ap.isJoinPoint)) {
      for (const awaitPoint of analysis.awaitPoints) {
        if (!awaitPoint.isJoinPoint) continue;
        const joinIndex = awaitPoint.index;
        const notifyFnName = `${asyncBlockId}_join_${joinIndex}_notify`;

        emitter.emitLine(
          `// Notify function for join point ${joinIndex} in ${asyncBlockId}`
        );
        emitter.emitLine(`static void ${notifyFnName}(void* sm_ptr) {`);
        emitter.emitLine(`  ${structName}* sm = (${structName}*)sm_ptr;`);
        emitter.emitLine(
          `  int prev = atomic_fetch_sub_explicit(&sm->join_pending_${joinIndex}, 1, memory_order_acq_rel);`
        );
        emitter.emitLine(
          `  ASYNC_DEBUG("${asyncBlockId}_join_${joinIndex}_notify: pending=%d\\n", prev - 1);`
        );
        emitter.emitLine(`  if (prev == 1) {`);
        emitter.emitLine(`    // All futures complete — resume the caller`);
        emitter.emitLine(
          `    yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
        );
        emitter.emitLine(`  }`);
        emitter.emitLine(
          `  // Release the event loop reference taken per-future at join time`
        );
        emitter.emitLine(`  __yo_decr_rc((void*)sm);`);
        emitter.emitLine(`}`);
        emitter.emitLine(``);
      }
    }

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
      resultType,
      resultTypeCName,
      captureType,
      context
    );

    emitter.emitLine(``);

    // If new async blocks were discovered during resume function generation
    // (nested async blocks), emit their struct definitions now before processing them
    if (context.deferredAsyncBlocks.length > prevLength) {
      const newBlocks = context.deferredAsyncBlocks.slice(prevLength);
      for (const newBlock of newBlocks) {
        emitAsyncBlockStructDefinition(
          {
            asyncBlockId: newBlock.asyncBlockId,
            structName: newBlock.structName,
            resultType: newBlock.resultType,
            resultTypeCName: newBlock.resultTypeCName,
            captureType: newBlock.captureType,
            analysis: newBlock.analysis,
          },
          context
        );
      }
    }

    i++;
  }
}

/**
 * Pre-register async block state machine types before generating function declarations.
 * This ensures that when function prototypes are generated, the correct state machine
 * struct names are already registered in context.types.
 */
export function preRegisterAsyncBlockTypes(
  context: FunctionGenerationContext
): void {
  // Iterate through all functions and find async blocks
  for (const funcId in context.functions) {
    const { value: functionValue } = context.functions[funcId]!;
    if (functionValue.body) {
      preRegisterAsyncBlocksInExpr(functionValue.body, context);
    }
  }
}

/**
 * Recursively search for async blocks in an expression and pre-register their types.
 */
function preRegisterAsyncBlocksInExpr(
  expr: Expr,
  context: FunctionGenerationContext
): void {
  if (!expr) return;

  if (exprIsFunctionCall(expr)) {
    const funcCallExpr = expr as FnCallExpr;

    // Check if this is an async block
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
      // Found an async block - extract info and pre-register type
      const futureType = expr.$?.type;
      if (futureType && typeImplementsFuture(futureType)) {
        const futureModuleType = extractFutureTraitFromType(futureType);
        if (futureModuleType) {
          const asyncBlockId =
            expr.$?.variableName || `async_block_${Date.now()}`;
          const structName = `${asyncBlockId}_state_t`;

          // Store the struct name directly on the expression for later lookup
          // This is more reliable than context.types which can be overwritten
          if (expr.$) {
            expr.$.asyncStateMachineStructName = structName;
          }

          // Register in context.types using the SomeType's unique ID.
          // IMPORTANT: Each async block creates its own fresh SomeType with a unique ID,
          // but they may share the same FutureTraitType (e.g., multiple async blocks
          // returning Impl(Future(unit)) share the same Future(unit) module).
          // Using the SomeType's unique ID ensures each async block's state machine
          // struct is registered separately.
          context.types[futureType.id] = {
            type: futureType,
            cName: structName,
          };

          // Emit forward declaration for the state machine struct
          // The full struct definition will be emitted later during generateAsyncBlock
          context.emitter.emitDeclarationLine(
            `typedef struct ${structName}_struct ${structName}; // Forward declaration for async state machine`
          );
        }
      }
    }

    // Check if this is an io.async(closure) call
    if (isIoAsyncCall(expr)) {
      const futureType = expr.$?.type;
      if (futureType && typeImplementsFuture(futureType)) {
        const futureModuleType = extractFutureTraitFromType(futureType);
        if (futureModuleType) {
          const asyncBlockId =
            expr.$?.variableName || `io_async_block_${Date.now()}`;
          // Use _state_t for async closures (with await points), _sync_fut_t for sync
          const hasAwaitAnalysis = !!expr.$?.awaitAnalysis;
          const structName = hasAwaitAnalysis
            ? `${asyncBlockId}_state_t`
            : `${asyncBlockId}_sync_fut_t`;

          if (expr.$) {
            expr.$.asyncStateMachineStructName = structName;
          }

          context.types[futureType.id] = {
            type: futureType,
            cName: structName,
          };

          context.emitter.emitDeclarationLine(
            `typedef struct ${structName}_struct ${structName}; // Forward declaration for io.async ${hasAwaitAnalysis ? "state machine" : "sync future"}`
          );
        }
      }
    }

    // Recursively search in arguments
    for (const arg of funcCallExpr.args) {
      preRegisterAsyncBlocksInExpr(arg, context);
    }
  }
}

/**
 * Generate C code for io.async(closure) as a synchronous call.
 * Calls the closure immediately and wraps the result in a completed future.
 */
export function generateIoAsyncSyncCall(
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  const futureType = expr.$?.type;
  if (!futureType || !typeImplementsFuture(futureType)) {
    return `/* Error: io.async must return a Future type */`;
  }

  const futureModuleType = extractFutureTraitFromType(futureType);
  if (!futureModuleType) {
    return `/* Error: Could not extract Future module type */`;
  }

  const resultType = futureModuleType.isFuture.outputType;
  const resultTypeCName = getTypeString(resultType, context);
  const structName = expr.$?.asyncStateMachineStructName;
  if (!structName) {
    return `/* Error: Missing sync future struct name */`;
  }

  const disposeFunctionName = `${structName}_dispose`;
  const emitter = context.emitter;

  // Emit struct definition
  emitter.emitDeclarationLine(`struct ${structName}_struct {`);
  emitter.emitDeclarationLine(`  yo_ref_header_t header;`);
  emitter.emitDeclarationLine(`  _Atomic int state;`);
  if (isUnitType(resultType)) {
    emitter.emitDeclarationLine(`  uint8_t result;`);
  } else {
    emitter.emitDeclarationLine(`  ${resultTypeCName} result;`);
  }
  emitter.emitDeclarationLine(`  _Atomic(void (*)(void*)) continuation_fn;`);
  emitter.emitDeclarationLine(`  _Atomic(void*) continuation_sm;`);
  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);

  // Emit dispose function
  const resultDropFn = getDropFunctionForType(resultType, context);
  emitter.emitDeclarationLine(`void ${disposeFunctionName}(void* ptr) {`);
  if (resultDropFn) {
    emitter.emitDeclarationLine(`  ${structName}* sm = (${structName}*)ptr;`);
    emitter.emitDeclarationLine(
      `  if (atomic_load_explicit(&sm->state, memory_order_acquire) == -1) {`
    );
    emitter.emitDeclarationLine(`    ${resultDropFn}(&sm->result);`);
    emitter.emitDeclarationLine(`  }`);
  }
  emitter.emitDeclarationLine(`}`);
  emitter.emitDeclarationLine(``);

  // Get the closure argument expression
  const closureArgExpr = expr.$?.runtimeArgExprsInOrder?.[0];
  if (!closureArgExpr?.$) {
    return `/* Error: Missing closure argument for io.async */`;
  }

  // Generate the closure argument value
  const closureCode = generateExpr(closureArgExpr, indent, context);

  // Generate the closure call
  const closureValueType = closureArgExpr.$.type;
  let closureCallCode: string;

  if (isSomeType(closureValueType) && closureValueType.resolvedConcreteType) {
    const concreteTypeId = closureValueType.resolvedConcreteType.id;
    const mapped = context.implClosureCallMap.get(concreteTypeId);
    if (mapped) {
      closureCallCode = `${mapped.functionCName}(&(${closureCode}))`;
    } else {
      closureCallCode = `/* Error: no implClosureCallMap entry for closure */`;
    }
  } else {
    closureCallCode = `/* Error: closure type is not Impl(Fn) */`;
  }

  // Generate the sync future allocation and initialization
  const resultVar = expr.$?.variableName || `__io_async_result`;

  // Call the closure and store the result
  if (!isUnitType(resultType)) {
    emitter.emitLine(
      `${indent}${resultTypeCName} __io_async_call_result = ${closureCallCode};`
    );
  } else {
    emitter.emitLine(`${indent}${closureCallCode};`);
  }

  // Allocate and initialize the sync future
  const varTypeAndName = getVariableTypeString(futureType, resultVar, context);
  emitter.emitLine(
    `${indent}${varTypeAndName} = (${structName}*)__yo_malloc(sizeof(${structName}));`
  );
  emitter.emitLine(`${indent}memset(${resultVar}, 0, sizeof(${structName}));`);
  emitter.emitLine(`${indent}${resultVar}->header.ref_count = 1;`);
  emitter.emitLine(`${indent}${resultVar}->header.gc_flags = 0;`);
  emitter.emitLine(`${indent}${resultVar}->header.gc_mark = YO_GC_UNMARKED;`);
  emitter.emitLine(`${indent}${resultVar}->header.gc_next = NULL;`);
  emitter.emitLine(`${indent}${resultVar}->header.gc_prev = NULL;`);
  emitter.emitLine(
    `${indent}${resultVar}->header.dispose_fn = (void(*)(void*))${disposeFunctionName};`
  );
  emitter.emitLine(`${indent}${resultVar}->header.traverse_fn = NULL;`);
  if (!isUnitType(resultType)) {
    emitter.emitLine(`${indent}${resultVar}->result = __io_async_call_result;`);
  }
  emitter.emitLine(
    `${indent}atomic_store_explicit(&${resultVar}->state, -1, memory_order_release);`
  );
  emitter.emitLine(
    `${indent}atomic_store_explicit(&${resultVar}->continuation_fn, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(
    `${indent}atomic_store_explicit(&${resultVar}->continuation_sm, NULL, memory_order_relaxed);`
  );

  return resultVar;
}
