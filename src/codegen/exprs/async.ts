import {
  isIoAsyncCall,
  isIoAwaitCall,
  isIoSpawnCall,
} from "../../evaluator/async/await-analysis";
import type { AwaitAnalysisResult } from "../../evaluator/async/await-analysis-types";
import { awaitIsWhileCondition } from "../async/state-code-gen";
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
  FunctionType,
  FutureTraitType,
  SomeType,
  SourceNamespaceType,
  StructType,
  Type,
} from "../../types/definitions";
import {
  isAtomicReferenceStructType,
  isDynType,
  isFunctionType,
  isIsoType,
  isSourceNamespaceType,
  isReferenceStructType,
  isRcType,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType, typeToString } from "../../types/utils";
import { isFunctionValue } from "../../value";
import {
  computeCrossBoundaryVariables,
  computeOverlappingSlots,
  generateAsyncBlockResumeFunction,
  getStateMachineFieldName,
} from "../async/state-machine";
import type { OverlappingSlot } from "../async/state-machine";
import type { FunctionGenerationContext } from "../functions/context";
import { getEvidenceParameters } from "../functions/declarations";
import { getTypeString, getVariableTypeString, quoteCString } from "../utils";
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
  const futureTraitType = extractFutureTraitFromType(futureType);
  if (!futureTraitType) {
    return `/* Error: Could not extract Future trait type */`;
  }

  // The state machine struct name will be based on the async block ID
  // This struct IS the Future implementation (value type, not pointer)
  const asyncBlockId = expr.$?.variableName || `async_block_${Date.now()}`;
  const structName = `${asyncBlockId}_state_t`;
  const resumeFunctionName = `${asyncBlockId}_resume`;
  const constructorName = `__yo_new_${asyncBlockId}`;
  const disposeFunctionName = `${asyncBlockId}_state_dispose`;
  const setEffectFunctionName = `${asyncBlockId}_set_effect`;

  // Register this state machine struct as the concrete type for this specific async block's SomeType.
  // IMPORTANT: We use futureType.id (the SomeType's ID) rather than futureTraitType.id because
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
  let resultType = futureTraitType.isFuture.outputType;

  // If outputType is an unresolved SomeType (type parameter T from generic),
  // resolve it to a concrete type. The evaluator may set resolvedConcreteType
  // on the SomeType when the body returns a concrete type, but the
  // FutureTraitType's outputType may be a different SomeType instance.
  // Walk several resolution paths to find the concrete type.
  if (isSomeType(resultType)) {
    if (resultType.resolvedConcreteType) {
      resultType = resultType.resolvedConcreteType;
    } else {
      const closureArg = expr.$?.runtimeArgExprsInOrder?.[0];
      const closureFnValue = closureArg?.$?.closureFunctionValue;
      if (closureFnValue && isFunctionValue(closureFnValue)) {
        const fnRetType = closureFnValue.type?.return?.type;
        if (
          fnRetType &&
          isSomeType(fnRetType) &&
          fnRetType.resolvedConcreteType
        ) {
          resultType = fnRetType.resolvedConcreteType;
        } else if (closureFnValue.body?.$?.type) {
          const bodyType = closureFnValue.body.$.type;
          if (isSomeType(bodyType) && bodyType.resolvedConcreteType) {
            resultType = bodyType.resolvedConcreteType;
          } else if (!isSomeType(bodyType)) {
            resultType = bodyType;
          }
        }
      }
    }
  }

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
  emitter.emitDeclarationLine(
    `void ${setEffectFunctionName}(void* ptr, const char* field, void* value);`
  );
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

  // Collect closure parameter slots. For io.async(closure) — the closure
  // declares an `e : E` bundle param; the value flows in at io.await time
  // via set_effect("__bundle", &value). We stash each runtime param so the
  // SM struct can carry it across yields.
  const closureParamSlots: {
    fieldName: string;
    cType: string;
    paramName: string;
    paramType: Type;
  }[] = [];
  if (isIoAsyncCall(expr)) {
    const closureArg = expr.$?.runtimeArgExprsInOrder?.[0];
    const closureFnValue = closureArg?.$?.closureFunctionValue;
    if (closureFnValue && isFunctionValue(closureFnValue)) {
      const callType = closureFnValue.type;
      for (let i = 0; i < callType.parameters.length; i++) {
        const param = callType.parameters[i]!;
        if (param.isCompileTimeOnly) continue;
        const cType = getTypeString(param.type, context);
        closureParamSlots.push({
          fieldName: `__yo_param_${i}`,
          cType,
          paramName: param.label ?? `param_${i}`,
          paramType: param.type,
        });
      }
    }
  }

  context.deferredAsyncBlocks.push({
    bodyExpr,
    asyncBlockId,
    structName,
    resumeFunctionName,
    constructorName,
    disposeFunctionName,
    setEffectFunctionName,
    futureType: futureType,
    futureTraitType: futureTraitType,
    resultType: resultType,
    resultTypeCName: resultTypeCName,
    captureType: expr.$?.captureType,
    analysis,
    closureParamSlots:
      closureParamSlots.length > 0 ? closureParamSlots : undefined,
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
      functionContext.inAsyncStateMachine !== undefined ||
      functionContext.inEffectStateMachine !== undefined;

    let usedDeferredDups = false;
    const captureFields = captureType.fields
      .map((elem) => {
        // Effect param fields are zero-initialized at io.async time.
        // They will be populated at io.spawn/io.await time.
        if (elem.isEffectParam) {
          return `.${elem.label} = NULL`;
        }

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
          usedDeferredDups = true;
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

    // Dup the capture struct to ensure proper RC for all captured variables.
    // This is needed when:
    // 1. In a special context (SM/closure): deferredDupExpressions are skipped
    //    because they reference variables by original names that don't exist.
    // 2. Not in a special context but no deferred dups were used: the async block
    //    is created in a regular function body where deferred dups may not exist.
    // In both cases, use the capture struct type's dup function.
    if (!usedDeferredDups) {
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
      // Lazy execution: future stays cold until await/spawn starts it.
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
      // Lazy execution: future stays cold until await/spawn starts it.
      return resultVar;
    } else {
      return constructorCall;
    }
  }
}

/**
 * Mapping from an effect-bundle leaf function field (e.g. `exn.throw`) to the
 * full SM access path that stores it. Examples:
 *   - `__capture.throw` (legacy: function-typed effect field stored in capture)
 *   - `var_<id>.exn.throw` (Phase 7: effect is a struct bundle stored as a
 *     SM-level field, recursed into struct-typed sub-fields)
 */
function getInjectableFutureEffectFieldMappings(
  futureTraitType: FutureTraitType,
  captureType: StructType | undefined,
  stateMachineVariables?: Map<
    string,
    import("../../evaluator/async/await-analysis-types").CapturedVariable
  >,
  stateMachineFieldAliases?: Map<string, string>
): Array<{ effectLabel: string; accessPath: string }> {
  const mappings: Array<{ effectLabel: string; accessPath: string }> = [];
  const addMapping = (effectLabel: string, accessPath: string) => {
    if (
      !mappings.some(
        (m) => m.effectLabel === effectLabel && m.accessPath === accessPath
      )
    ) {
      mappings.push({ effectLabel, accessPath });
    }
  };

  const effect = futureTraitType.isFuture.effect;
  if (!effect) {
    return mappings;
  }

  // Path 1: function-typed effect — look for matching capture field.
  if (isFunctionType(effect.type) && captureType) {
    const captureField =
      captureType.fields.find((field) => field.label === effect.label) ??
      captureType.fields.find(
        (field) => field.label.toLowerCase() === effect.label.toLowerCase()
      ) ??
      captureType.fields.find((field) => field.type.id === effect.type.id);
    if (captureField) {
      addMapping(effect.label, `__capture.${captureField.label}`);
    }
    return mappings;
  }

  // Path 2: struct-typed effect (e.g. `IoExn { io : Io, exn : Exception }`).
  if (isSourceNamespaceType(effect.type) || isStructType(effect.type)) {
    // First try the legacy path: top-level fn-typed fields in __capture.
    if (captureType) {
      for (const field of effect.type.fields) {
        if (isFunctionType(field.type)) {
          const captureField =
            captureType.fields.find((f) => f.label === field.label) ??
            captureType.fields.find(
              (f) => f.label.toLowerCase() === field.label.toLowerCase()
            ) ??
            captureType.fields.find((f) => f.type.id === field.type.id);
          if (captureField) {
            addMapping(field.label, `__capture.${captureField.label}`);
          }
        }
      }
    }

    // Phase 7: if some leaf-function fields are reached through nested
    // struct fields (e.g. `exn.throw` inside an IoExn bundle), they live
    // in a SM-level field `var_<id>_<param>` (the closure's bundle param)
    // rather than in __capture. Look up `stateMachineVariables` for a
    // variable whose type matches the bundle, then build paths into it.
    if (stateMachineVariables) {
      let bundleVarFieldName: string | undefined;
      for (const [, smVar] of stateMachineVariables) {
        if (smVar.kind === "outer") continue;
        if (smVar.type.id === effect.type.id) {
          // Honor field aliases (e.g., closure-param slots map to
          // __yo_param_<i>, not the default var_<id> naming).
          const aliased = stateMachineFieldAliases?.get(smVar.id);
          bundleVarFieldName = aliased ?? `var_${smVar.id}`;
          break;
        }
      }
      if (bundleVarFieldName) {
        const visit = (
          structType: StructType | SourceNamespaceType,
          basePath: string,
          baseLabel: string
        ) => {
          for (const field of structType.fields) {
            if (isFunctionType(field.type)) {
              const effectLabel = baseLabel
                ? `${baseLabel}.${field.label}`
                : field.label;
              addMapping(effectLabel, `${basePath}.${field.label}`);
            } else if (
              (isSourceNamespaceType(field.type) || isStructType(field.type)) &&
              field.type.fields.length > 0
            ) {
              const subLabel = baseLabel
                ? `${baseLabel}.${field.label}`
                : field.label;
              visit(field.type, `${basePath}.${field.label}`, subLabel);
            }
          }
        };
        visit(effect.type, bundleVarFieldName, "");
      }
    }
  }

  return mappings;
}

/**
 * Look up the SM-level field that stores the closure's effect-bundle param
 * (e.g. `var_yoa51d630f_e` for an `(e : IoExn) =>` async closure). Returns
 * undefined when no SM variable matches the effect's struct type — i.e.
 * the bundle either isn't a struct effect, or there are no SM variables
 * available (set_effect emitted outside the SM body region).
 */
export function findBundleFieldName(
  futureTraitType: FutureTraitType,
  stateMachineVariables:
    | Map<
        string,
        import("../../evaluator/async/await-analysis-types").CapturedVariable
      >
    | undefined,
  stateMachineFieldAliases?: Map<string, string>
): string | undefined {
  const effect = futureTraitType.isFuture.effect;
  if (!effect) return undefined;
  if (!(isSourceNamespaceType(effect.type) || isStructType(effect.type))) {
    return undefined;
  }
  if (!stateMachineVariables) return undefined;
  // Prefer entries with a field alias (e.g., synthetic closure-param slots
  // mapped to __yo_param_<i>) over the default var_<id> form. The aliased
  // slot is where set_effect writes the bundle; reading from var_<id> would
  // see zero-initialized memory.
  let fallback: string | undefined;
  for (const [, smVar] of stateMachineVariables) {
    if (smVar.kind === "outer") continue;
    if (smVar.type.id === effect.type.id) {
      const aliased = stateMachineFieldAliases?.get(smVar.id);
      if (aliased) return aliased;
      if (fallback === undefined) fallback = `var_${smVar.id}`;
    }
  }
  return fallback;
}

function generateFutureEffectSetter(
  structName: string,
  setEffectFunctionName: string,
  futureTraitType: FutureTraitType,
  captureType: StructType | undefined,
  context: FunctionGenerationContext,
  syncParamSlot?: { fieldName: string; cType: string }
): void {
  const mappings = getInjectableFutureEffectFieldMappings(
    futureTraitType,
    captureType,
    context.stateMachineVariables,
    context.stateMachineFieldAliases
  );
  const bundleFieldName = findBundleFieldName(
    futureTraitType,
    context.stateMachineVariables,
    context.stateMachineFieldAliases
  );
  const effect = futureTraitType.isFuture.effect;
  const emitter = context.emitter;

  emitter.emitDeclarationLine(
    `void ${setEffectFunctionName}(void* ptr, const char* field, void* value) {`
  );
  emitter.emitDeclarationLine(`  ${structName}* sm = (${structName}*)ptr;`);

  const hasSyncParamCase = !!syncParamSlot;
  // When the synthetic syncParamSlot case is active, suppress the
  // findBundleFieldName-driven case to avoid two "__bundle" branches in the
  // same if/else-if chain (only the first would ever fire, leaving the
  // findBundleFieldName slot uninitialized — see SIGSEGV in fs tests).
  const hasBundleCase = !hasSyncParamCase && !!(bundleFieldName && effect);
  const hasAnyCase = hasSyncParamCase || hasBundleCase || mappings.length > 0;

  if (!hasAnyCase) {
    emitter.emitDeclarationLine(`  (void)sm;`);
    emitter.emitDeclarationLine(`  (void)field;`);
    emitter.emitDeclarationLine(`  (void)value;`);
  } else {
    let firstCase = true;
    if (hasSyncParamCase) {
      // Sync future closure parameter slot: io.await/io.spawn passes the
      // bundle value via set_effect("__bundle", &value). Copy into the
      // dedicated __yo_param_<i> field so resume() can hand it to the
      // closure call. Sync futures have no await analysis state to consult,
      // so bundleFieldName is empty — this case handles them directly.
      emitter.emitDeclarationLine(`  if (strcmp(field, "__bundle") == 0) {`);
      emitter.emitDeclarationLine(
        `    sm->${syncParamSlot!.fieldName} = *((${syncParamSlot!.cType}*)value);`
      );
      emitter.emitDeclarationLine(`  }`);
      firstCase = false;
    }
    if (hasBundleCase) {
      // Whole-bundle copy: writer passes the bundle struct's address as
      // `value` and `field == "__bundle"`. The set_effect copies the
      // pointed-to struct into the SM's bundle field. This is how
      // `io.await(future, IoExn(io, exn))` injects nested effect records.
      const bundleCName = getTypeString(effect.type, context);
      const keyword = firstCase ? "if" : "else if";
      emitter.emitDeclarationLine(
        `  ${keyword} (strcmp(field, "__bundle") == 0) {`
      );
      emitter.emitDeclarationLine(
        `    sm->${bundleFieldName} = *((${bundleCName}*)value);`
      );
      emitter.emitDeclarationLine(`  }`);
      firstCase = false;
    }
    mappings.forEach(({ effectLabel, accessPath }) => {
      const keyword = firstCase ? "if" : "else if";
      firstCase = false;
      const lastSegment = effectLabel.split(".").pop() ?? effectLabel;
      const capitalizedLast =
        lastSegment.length > 0
          ? `${lastSegment[0]!.toUpperCase()}${lastSegment.slice(1)}`
          : lastSegment;
      const aliases = [...new Set([effectLabel, lastSegment, capitalizedLast])];
      const condition = aliases
        .map((alias) => `strcmp(field, ${quoteCString(alias)}) == 0`)
        .join(" || ");
      emitter.emitDeclarationLine(`  ${keyword} (${condition}) {`);
      emitter.emitDeclarationLine(`    sm->${accessPath} = value;`);
      emitter.emitDeclarationLine(`  }`);
    });
  }
  emitter.emitDeclarationLine(`}`);
}

function emitAsyncBlockStructDefinition(
  asyncBlockInfo: {
    asyncBlockId: string;
    structName: string;
    resultType: Type;
    resultTypeCName: string;
    captureType: StructType | undefined;
    analysis: AwaitAnalysisResult;
    crossBoundaryIds?: Set<string>;
    awaitFutureTempVarAliases?: Map<string, string>;
    overlappingSlotAliases?: Map<string, string>;
    overlappingSlots?: OverlappingSlot[];
    closureParamSlots?: {
      fieldName: string;
      cType: string;
      paramName: string;
      paramType: Type;
    }[];
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
    crossBoundaryIds,
    awaitFutureTempVarAliases,
    overlappingSlotAliases,
    overlappingSlots,
    closureParamSlots,
  } = asyncBlockInfo;

  emitter.emitDeclarationLine(
    `// State machine for async block ${asyncBlockId} - implements Future(${typeToString(resultType)})`
  );
  emitter.emitDeclarationLine(`struct ${structName}_struct {`);

  // Reference counting header - must be first for __yo_ref_header_t* casting
  emitter.emitDeclarationLine(
    `  __yo_ref_header_t header;  // Reference counting header (must be first)`
  );

  emitter.emitDeclarationLine(
    `  int state;  // Current state (0 = cold, 1..N = intermediate, -1 = completed, -2 = aborted)`
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
    `  void (*continuation_fn)(void*);  // Resume function of awaiting task`
  );
  emitter.emitDeclarationLine(
    `  void* continuation_sm;  // State machine of awaiting task`
  );
  emitter.emitDeclarationLine(``);

  // Resume function pointer for lazy start at await
  emitter.emitDeclarationLine(
    `  void (*__yo_resume_fn)(void*);  // Resume function pointer (for lazy start at await/spawn)`
  );
  emitter.emitDeclarationLine(
    `  void (*__yo_set_effect_fn)(void*, const char*, void*);`
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

  // Closure parameter slots — bundle value supplied at io.await/io.spawn
  // time via set_effect("__bundle", &value). See [[yo-anon-closure-param-name-extraction]].
  if (closureParamSlots && closureParamSlots.length > 0) {
    emitter.emitDeclarationLine(`  // Closure parameter slots`);
    for (const slot of closureParamSlots) {
      emitter.emitDeclarationLine(
        `  ${slot.cType} ${slot.fieldName};  // ${slot.paramName}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Local variables — only those that cross await boundaries need struct fields.
  // Segment-local variables (used in only one segment) will be C locals in their case block.
  // Also exclude temp vars aliased to await_future_N fields (Phase 1b)
  // and vars sharing overlapping storage slots (Phase 2).
  let localVariables = analysis.capturedVariables.filter(
    (v) => v.kind !== "outer"
  );
  if (crossBoundaryIds) {
    localVariables = localVariables.filter(
      (v) =>
        crossBoundaryIds.has(v.id) &&
        !awaitFutureTempVarAliases?.has(v.id) &&
        !overlappingSlotAliases?.has(v.id)
    );
  }
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

  // Phase 2: Overlapping storage slots — variables of the same non-RC type
  // with non-overlapping live ranges share a single struct field.
  if (overlappingSlots && overlappingSlots.length > 0) {
    emitter.emitDeclarationLine(`  // Overlapping storage slots (Phase 2)`);
    for (const slot of overlappingSlots) {
      emitter.emitDeclarationLine(
        `  ${slot.cType} ${slot.fieldName};  // shared: ${slot.variableNames.join(", ")}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Await result temporaries
  // Phase 3 optimization: skip await_result_N for linear (non-cond) awaits.
  // For linear awaits with a target variable, the result is assigned directly
  // to sm->var_X. For linear awaits without a target, the result is unused.
  // Cond awaits still need await_result_N because branch continuation code
  // reads from it.
  if (analysis.awaitPoints.length > 0) {
    const awaitResultFields: string[] = [];
    for (const awaitPoint of analysis.awaitPoints) {
      // When the output type is an unresolved SomeType (e.g., generic(T) from
      // io.await evaluated with io=UnknownValue), treat it as unit since the
      // generic type parameter couldn't be resolved to a concrete type.
      const isEffectivelyUnit =
        isUnitType(awaitPoint.resultType) ||
        (isSomeType(awaitPoint.resultType) &&
          !awaitPoint.resultType.resolvedConcreteType);

      // Skip await_result for linear awaits (non-cond). A `while` whose
      // CONDITION awaits also needs the field: its loop layout tests
      // `sm->await_result_N` to decide whether to run another iteration.
      const needsAwaitResultField =
        !isEffectivelyUnit &&
        (awaitPoint.isInsideCond || awaitIsWhileCondition(awaitPoint));

      if (needsAwaitResultField) {
        // Determine the correct type for await_result_X:
        // For extern futures (e.g., io_uring), use the Future's result type directly
        // For async block futures, use awaitPoint.resultType (which matches the block's result)
        let awaitResultType = awaitPoint.resultType;

        if (awaitPoint.futureType) {
          const futureTraitType = extractFutureTraitFromType(
            awaitPoint.futureType
          );
          if (futureTraitType) {
            // Use the Future's output type as the await_result type
            awaitResultType = futureTraitType.isFuture.outputType;
          }
        }

        const awaitResultTypeCName = getTypeString(awaitResultType, context);
        awaitResultFields.push(
          `  ${awaitResultTypeCName} await_result_${awaitPoint.index};`
        );
      }
    }
    if (awaitResultFields.length > 0) {
      emitter.emitDeclarationLine(`  // Await result temporaries`);
      for (const field of awaitResultFields) {
        emitter.emitDeclarationLine(field);
      }
      emitter.emitDeclarationLine(``);
    }
  }

  // await_future_X fields (used when awaiting an expression that isn't a captured Future variable)
  if (analysis.awaitPoints.length > 0) {
    const awaitPointsNeedingFutureStorage = analysis.awaitPoints.filter(
      (ap) => ap.futureVariableId === undefined
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
    const { crossBoundaryIds, awaitFutureTempVarAliases, variableSegments } =
      computeCrossBoundaryVariables(b.bodyExpr, b.analysis);
    const { slotAliases: overlappingSlotAliases, slots: overlappingSlots } =
      computeOverlappingSlots(
        crossBoundaryIds,
        variableSegments,
        b.analysis.capturedVariables,
        awaitFutureTempVarAliases,
        context
      );
    emitAsyncBlockStructDefinition(
      {
        asyncBlockId: b.asyncBlockId,
        structName: b.structName,
        resultType: b.resultType,
        resultTypeCName: b.resultTypeCName,
        captureType: b.captureType,
        analysis: b.analysis,
        crossBoundaryIds,
        awaitFutureTempVarAliases,
        overlappingSlotAliases,
        overlappingSlots,
        closureParamSlots: b.closureParamSlots,
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
  localVarDrops: string[],
  crossBoundaryIds: Set<string>,
  awaitFutureTempVarAliases: Map<string, string>,
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
        // The capture struct's ___drop function was not generated (likely because
        // the struct contains fields with unresolved SomeType from generic parameters,
        // e.g. Io's method signatures). Generate inline drops for each RC-typed field.
        for (const field of captureType.fields) {
          if (field.isEffectParam) continue;
          const fieldRef = `sm->__capture.${field.label}`;

          if (isDynType(field.type)) {
            emitter.emitLine(
              `  if ((${fieldRef}).data != NULL) { __yo_decr_rc((void*)(${fieldRef}).data); }`
            );
          } else if (
            isIsoType(field.type) ||
            isAtomicReferenceStructType(field.type)
          ) {
            emitter.emitLine(
              `  if (${fieldRef} != NULL) { __yo_decr_rc_atomic((void*)${fieldRef}); }`
            );
          } else if (
            isReferenceStructType(field.type) ||
            (isSomeType(field.type) && isRcType(field.type))
          ) {
            const dropFn = getDropFunctionForType(field.type, context);
            if (dropFn) {
              emitter.emitLine(
                `  if (${fieldRef} != NULL) { ${dropFn}(${fieldRef}); }`
              );
            } else {
              emitter.emitLine(
                `  if (${fieldRef} != NULL) { __yo_decr_rc((void*)${fieldRef}); }`
              );
            }
          } else if (typeContainsRcType(field.type)) {
            const dropFn = getDropFunctionForType(field.type, context);
            if (dropFn) {
              emitter.emitLine(`  ${dropFn}(${fieldRef});`);
            }
          }
        }
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
    emitter.emitLine(`  int final_state = sm->state;`);
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

  // Drop local variables when escape aborted the SM (state == -2).
  // In normal completion, local vars are dropped inline in the final state.
  // On escape, we must drop ALL cross-boundary local variables from the analysis
  // (they have struct fields). Segment-local variables are C locals and are
  // cleaned up inline by the segment's escape handling code.
  {
    const localDropLines: string[] = [];
    for (const v of analysis.capturedVariables) {
      if (v.kind !== "local") continue;
      // Skip segment-local variables — they are not struct fields
      if (!crossBoundaryIds.has(v.id)) continue;
      // Skip temp future vars aliased to await_future_N — lifecycle managed by resume function
      if (awaitFutureTempVarAliases.has(v.id)) continue;
      // Skip variables that are borrowing an RC value from another variable
      if (v.isOwningTheSameRcValueAs !== undefined) continue;

      const fieldName = getStateMachineFieldName(v.id, "local");
      const fieldRef = `sm->${fieldName}`;

      if (isDynType(v.type)) {
        // Dyn type is a value struct with a .data pointer to RC'd object
        localDropLines.push(
          `    if ((${fieldRef}).data != NULL) { __yo_decr_rc((void*)(${fieldRef}).data); }`
        );
      } else if (isIsoType(v.type) || isAtomicReferenceStructType(v.type)) {
        // Atomic RC pointer — needs NULL guard
        localDropLines.push(
          `    if (${fieldRef} != NULL) { __yo_decr_rc_atomic((void*)${fieldRef}); }`
        );
      } else if (
        isReferenceStructType(v.type) ||
        (isSomeType(v.type) && isRcType(v.type))
      ) {
        // Heap-allocated RC pointer — needs NULL guard
        const dropFn = getDropFunctionForType(v.type, context);
        if (dropFn) {
          localDropLines.push(
            `    if (${fieldRef} != NULL) { ${dropFn}(${fieldRef}); }`
          );
        } else {
          localDropLines.push(
            `    if (${fieldRef} != NULL) { __yo_decr_rc((void*)${fieldRef}); }`
          );
        }
      } else if (typeContainsRcType(v.type)) {
        // Value type with embedded RC fields — drop function handles cleanup.
        // Safe on zeroed values since __yo_decr_rc(NULL) is a no-op.
        const dropFn = getDropFunctionForType(v.type, context);
        if (dropFn) {
          localDropLines.push(`    ${dropFn}(${fieldRef});`);
        }
      }
    }

    if (localDropLines.length > 0) {
      emitter.emitLine(`  // Drop local variables on escape (state == -2)`);
      emitter.emitLine(`  if (sm->state == -2) {`);
      for (const line of localDropLines) {
        emitter.emitLine(line);
      }
      emitter.emitLine(`  }`);
    }
  }

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
 * - await/spawn increments refcount when starting the task (event loop reference)
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
  setEffectFunctionName: string,
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
  if (context.needsCycleGC) {
    emitter.emitLine(`  sm->header.gc_flags = 0;`);
    emitter.emitLine(`  sm->header.gc_mark = __YO_GC_UNMARKED;`);
    emitter.emitLine(`  sm->header.gc_next = NULL;`);
    emitter.emitLine(`  sm->header.gc_prev = NULL;`);
  }
  if (context.needsCycleGC) {
    emitter.emitLine(
      `  sm->header.dispose_fn = (void(*)(void*))${disposeFunctionName};`
    );
  } else {
    // Type-tag dispatch for async SM
    if (!context.disposeTypeIds) {
      context.disposeTypeIds = new Map();
      context.nextDisposeTypeId = 1;
    }
    let typeId = context.disposeTypeIds.get(disposeFunctionName);
    if (typeId === undefined) {
      typeId = context.nextDisposeTypeId!;
      context.nextDisposeTypeId = typeId + 1;
      context.disposeTypeIds.set(disposeFunctionName, typeId);
    }
    emitter.emitLine(`  sm->header.type_id = ${typeId};`);
  }
  if (context.needsCycleGC) {
    emitter.emitLine(
      `  sm->header.traverse_fn = NULL;  // TODO: Add traverse for cycle detection if needed`
    );
  }
  emitter.emitLine(``);

  emitter.emitLine(`  sm->state = 0;`);
  emitter.emitLine(`  sm->continuation_fn = NULL;`);
  emitter.emitLine(`  sm->continuation_sm = NULL;`);
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

  // Store resume function pointer for lazy start at await/spawn
  emitter.emitLine(
    `  sm->__yo_resume_fn = (void(*)(void*))${resumeFunctionName};`
  );
  emitter.emitLine(`  sm->__yo_set_effect_fn = ${setEffectFunctionName};`);
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
      setEffectFunctionName,
      futureType,
      futureTraitType,
      resultType,
      resultTypeCName,
      captureType,
      analysis,
      closureParamSlots: rawClosureParamSlots,
    } = asyncBlockInfo;

    const closureParamSlots = rawClosureParamSlots;

    // Generate resume function implementation (before dispose, to collect local var drops)
    // Set SM context so effect injection can resolve captured variables
    const savedSMVars = context.stateMachineVariables;
    const savedEvidenceParams = context.currentEvidenceParams;
    const smVarMap = new Map<
      string,
      import("../../evaluator/async/await-analysis-types").CapturedVariable
    >();

    // Compute cross-boundary variables so segment-local variables become C locals.
    // Create a filtered analysis where capturedVariables excludes segment-locals.
    // This ensures ALL internal map-building in the resume function generator
    // (which iterates analysis.capturedVariables) automatically excludes them.
    // Phase 1b: aliased temp future vars remain in capturedVariables (for deferred drops)
    // but their struct fields are skipped — atom.ts redirects to await_future_N.
    const { crossBoundaryIds, awaitFutureTempVarAliases, variableSegments } =
      computeCrossBoundaryVariables(bodyExpr, analysis);

    // Phase 2: Compute overlapping storage slots for same-type non-RC variables.
    const { slotAliases: overlappingSlotAliases } = computeOverlappingSlots(
      crossBoundaryIds,
      variableSegments,
      analysis.capturedVariables,
      awaitFutureTempVarAliases,
      context
    );

    const filteredCapturedVariables = analysis.capturedVariables.filter(
      (v) =>
        v.kind === "outer" ||
        crossBoundaryIds.has(v.id) ||
        awaitFutureTempVarAliases.has(v.id) ||
        overlappingSlotAliases.has(v.id)
    );
    // Register closure parameters as state-machine variables so atom.ts emits
    // `sm->__yo_param_<i>` for references to them inside resume segments.
    // Without this the SM resume body emits the bare parameter name and clang
    // errors with "undeclared identifier". See [[yo-anon-closure-param-name-extraction]].
    // Inject into the captured-variables list so they survive the many SM
    // contexts that rebuild stateMachineVariables from analysis.capturedVariables.
    // (closureParamSlots was already filtered upstream to drop entries that
    // overlap with an existing local var.)
    if (closureParamSlots) {
      for (let cpIdx = 0; cpIdx < closureParamSlots.length; cpIdx++) {
        const slot = closureParamSlots[cpIdx]!;
        const slotVarId = `__closure_param_${cpIdx}`;
        filteredCapturedVariables.push({
          id: slotVarId,
          name: slot.paramName,
          type: slot.paramType,
          kind: "local",
          isOwningTheSameRcValueAs: undefined,
        });
      }
    }
    const filteredAnalysis: AwaitAnalysisResult = {
      ...analysis,
      capturedVariables: filteredCapturedVariables,
    };

    for (const v of filteredCapturedVariables) {
      smVarMap.set(v.id, v);
    }
    if (captureType) {
      for (const field of captureType.fields) {
        smVarMap.set(field.label, {
          id: field.label,
          name: field.label,
          type: field.type,
          kind: "outer",
          isOwningTheSameRcValueAs: undefined,
        });
      }
    }

    context.stateMachineVariables = smVarMap;
    // Phase 1b + Phase 2: Set field aliases so atom.ts redirects variable
    // lookups to the corresponding aliased field (await_future_N or slot_N).
    const savedFieldAliases = context.stateMachineFieldAliases;
    const mergedAliases = new Map<string, string>(awaitFutureTempVarAliases);
    for (const [varId, slotField] of overlappingSlotAliases) {
      mergedAliases.set(varId, slotField);
    }
    if (closureParamSlots) {
      for (let cpIdx = 0; cpIdx < closureParamSlots.length; cpIdx++) {
        const slot = closureParamSlots[cpIdx]!;
        mergedAliases.set(`__closure_param_${cpIdx}`, slot.fieldName);
      }
    }
    context.stateMachineFieldAliases = mergedAliases;

    const localVarDrops = generateAsyncBlockResumeFunction(
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      filteredAnalysis,
      futureType,
      captureType,
      context,
      crossBoundaryIds
    );

    // Emit the set_effect impl before restoring context, so the SM-var
    // lookup in `getInjectableFutureEffectFieldMappings` can see the SM's
    // own var_<id> fields (the closure params, e.g. the bundle param `e`).
    // Outside the SM body region those vars are dropped from context.
    emitter.emitLine(``);

    generateFutureEffectSetter(
      structName,
      setEffectFunctionName,
      futureTraitType,
      captureType,
      context,
      closureParamSlots?.[0]
    );

    // Restore context
    context.stateMachineVariables = savedSMVars;
    context.currentEvidenceParams = savedEvidenceParams;
    context.stateMachineFieldAliases = savedFieldAliases;

    emitter.emitLine(``);

    // Generate state machine dispose function
    generateAsyncBlockStateDisposeFunction(
      asyncBlockId,
      structName,
      disposeFunctionName,
      resultType,
      captureType,
      filteredAnalysis,
      localVarDrops,
      crossBoundaryIds,
      awaitFutureTempVarAliases,
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
      setEffectFunctionName,
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
        const {
          crossBoundaryIds: newCrossBoundaryIds,
          awaitFutureTempVarAliases: newAliases,
          variableSegments: newVarSegments,
        } = computeCrossBoundaryVariables(newBlock.bodyExpr, newBlock.analysis);
        const { slotAliases: newSlotAliases, slots: newSlots } =
          computeOverlappingSlots(
            newCrossBoundaryIds,
            newVarSegments,
            newBlock.analysis.capturedVariables,
            newAliases,
            context
          );
        emitAsyncBlockStructDefinition(
          {
            asyncBlockId: newBlock.asyncBlockId,
            structName: newBlock.structName,
            resultType: newBlock.resultType,
            resultTypeCName: newBlock.resultTypeCName,
            captureType: newBlock.captureType,
            analysis: newBlock.analysis,
            crossBoundaryIds: newCrossBoundaryIds,
            awaitFutureTempVarAliases: newAliases,
            overlappingSlotAliases: newSlotAliases,
            overlappingSlots: newSlots,
            closureParamSlots: newBlock.closureParamSlots,
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

/** Prefixes of extern "yo" function names that require the async runtime. */
const ASYNC_RUNTIME_EXTERN_PREFIXES = [
  "__yo_poll_",
  "__yo_fs_event_",
  "__yo_async_",
];

/** Returns true if the given extern name is defined in the async runtime. */
function isAsyncRuntimeExternName(name: string): boolean {
  return ASYNC_RUNTIME_EXTERN_PREFIXES.some((prefix) =>
    name.startsWith(prefix)
  );
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
    if (isIoAsyncCall(expr)) {
      // Mark that the program uses async — enables runtime emission
      context.usesAsync = true;
      // Found an async block - extract info and pre-register type
      const futureType = expr.$?.type;
      if (futureType && typeImplementsFuture(futureType)) {
        const futureTraitType = extractFutureTraitFromType(futureType);
        if (futureTraitType) {
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
        const futureTraitType = extractFutureTraitFromType(futureType);
        if (futureTraitType) {
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

    // Check if this is an io.await or io.spawn call — both need the async runtime
    // (io.await emits __yo_async_poll_step; io.spawn cold-starts a Future)
    if (isIoAwaitCall(expr) || isIoSpawnCall(expr)) {
      context.usesAsync = true;
    }

    // Check if this is an extern "yo" call to a function defined in the async runtime
    // (e.g., __yo_poll_init, __yo_fs_event_init, __yo_async_*)
    {
      const calledType = funcCallExpr.func.$?.type;
      if (
        calledType &&
        "isExtern" in calledType &&
        calledType.isExtern === "yo" &&
        "externName" in calledType &&
        typeof calledType.externName === "string" &&
        isAsyncRuntimeExternName(calledType.externName)
      ) {
        context.usesAsync = true;
      }
    }

    // Check if this is a parallelism call (__yo_thread_spawn or __yo_worker_spawn)
    {
      const calledType = funcCallExpr.func.$?.type;
      if (
        calledType &&
        "isExtern" in calledType &&
        calledType.isExtern === "yo" &&
        "externName" in calledType &&
        typeof calledType.externName === "string" &&
        (calledType.externName === "__yo_thread_spawn" ||
          calledType.externName === "__yo_worker_spawn")
      ) {
        context.usesParallelism = true;
      }
    }

    // Recursively search in arguments
    for (const arg of funcCallExpr.args) {
      preRegisterAsyncBlocksInExpr(arg, context);
    }
  }
}

/**
 * Generate C code for io.async(closure) as a lazy synchronous future.
 * The closure is NOT called at io.async time. Instead, the closure function
 * pointer and capture data are stored in the future struct. When io.await
 * detects state==0 and a resume function, it calls the resume function which
 * executes the closure and completes the future.
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

  const futureTraitType = extractFutureTraitFromType(futureType);
  if (!futureTraitType) {
    return `/* Error: Could not extract Future trait type */`;
  }

  let resultType = futureTraitType.isFuture.outputType;

  // If outputType is an unresolved SomeType (type parameter T from generic),
  // resolve it to a concrete type. Same resolution chain as the state machine path.
  if (isSomeType(resultType)) {
    if (resultType.resolvedConcreteType) {
      resultType = resultType.resolvedConcreteType;
    } else {
      const closureArg = expr.$?.runtimeArgExprsInOrder?.[0];
      const closureFnValue = closureArg?.$?.closureFunctionValue;
      if (closureFnValue && isFunctionValue(closureFnValue)) {
        const fnRetType = closureFnValue.type?.return?.type;
        if (
          fnRetType &&
          isSomeType(fnRetType) &&
          fnRetType.resolvedConcreteType
        ) {
          resultType = fnRetType.resolvedConcreteType;
        } else if (closureFnValue.body?.$?.type) {
          const bodyType = closureFnValue.body.$.type;
          if (isSomeType(bodyType) && bodyType.resolvedConcreteType) {
            resultType = bodyType.resolvedConcreteType;
          } else if (!isSomeType(bodyType)) {
            resultType = bodyType;
          }
        }
      }
    }
  }

  const resultTypeCName = getTypeString(resultType, context);
  const structName = expr.$?.asyncStateMachineStructName;
  if (!structName) {
    return `/* Error: Missing sync future struct name */`;
  }

  const disposeFunctionName = `${structName}_dispose`;
  const resumeFunctionName = `${structName}_resume`;
  const emitter = context.emitter;

  // Get the closure argument expression
  const closureArgExpr = expr.$?.runtimeArgExprsInOrder?.[0];
  if (!closureArgExpr?.$) {
    return `/* Error: Missing closure argument for io.async */`;
  }

  // Generate the closure argument value — this also registers the closure
  // function in implClosureCallMap and emits capture struct declarations.
  const closureCode = generateExpr(closureArgExpr, indent, context);

  // Look up the closure function name from implClosureCallMap
  const closureValueType = closureArgExpr.$.type;
  let closureFunctionCName: string | undefined;
  let captureCName: string | undefined;

  if (isSomeType(closureValueType) && closureValueType.resolvedConcreteType) {
    const concreteType = closureValueType.resolvedConcreteType;
    const mapped = context.implClosureCallMap.get(concreteType.id);
    if (mapped) {
      closureFunctionCName = mapped.functionCName;
    }
    // Get the C name for the capture/context type
    const captureTypeEntry = context.types[concreteType.id];
    if (captureTypeEntry) {
      captureCName = captureTypeEntry.cName;
    }
  }

  if (!closureFunctionCName || !captureCName) {
    return `/* Error: no closure function or capture type for io.async sync path */`;
  }

  // Discover the closure's runtime parameters (non-comptime, non-evidence).
  // For io.async-shaped closures these are the `e : E` bundle parameter.
  // We surface them as `__yo_param_<i>` slots on the SM struct so the bundle
  // value supplied at the io.await/io.spawn call site (via set_effect's
  // "__bundle" path) survives until the resume function actually calls the
  // closure — sync futures have no awaits, but the closure body still reads
  // its parameter.
  const syncParamSlots: { fieldName: string; cType: string }[] = [];
  let closureCallType: FunctionType | undefined;
  for (const funcId in context.functions) {
    const entry = context.functions[funcId]!;
    if (entry.cName === closureFunctionCName) {
      closureCallType = entry.value.type;
      for (let i = 0; i < closureCallType.parameters.length; i++) {
        const param = closureCallType.parameters[i]!;
        if (param.isCompileTimeOnly) continue;
        const cType = getTypeString(param.type, context);
        syncParamSlots.push({ fieldName: `__yo_param_${i}`, cType });
      }
      break;
    }
  }

  // Emit struct definition — includes an embedded __capture field so the
  // capture data lives as long as the future (heap-allocated).
  emitter.emitDeclarationLine(`struct ${structName}_struct {`);
  emitter.emitDeclarationLine(`  __yo_ref_header_t header;`);
  emitter.emitDeclarationLine(`  int state;`);
  if (isUnitType(resultType)) {
    emitter.emitDeclarationLine(`  uint8_t result;`);
  } else {
    emitter.emitDeclarationLine(`  ${resultTypeCName} result;`);
  }
  emitter.emitDeclarationLine(`  void (*continuation_fn)(void*);`);
  emitter.emitDeclarationLine(`  void* continuation_sm;`);
  emitter.emitDeclarationLine(`  void (*__yo_resume_fn)(void*);`);
  emitter.emitDeclarationLine(
    `  void (*__yo_set_effect_fn)(void*, const char*, void*);`
  );
  emitter.emitDeclarationLine(`  ${captureCName} __capture;`);
  for (const slot of syncParamSlots) {
    emitter.emitDeclarationLine(`  ${slot.cType} ${slot.fieldName};`);
  }
  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);

  // Build resume call args: evidence params come from __capture; runtime
  // params come from the dedicated __yo_param_<i> slots populated by
  // set_effect("__bundle", ...).
  let closureEvidenceArgs = "";
  if (closureCallType) {
    const evidenceParams = getEvidenceParameters(closureCallType);
    const shimArgs: string[] = [];
    for (const ep of evidenceParams) {
      shimArgs.push(`(void*)sm->__capture.${ep.fieldPath.join(".")}`);
    }
    for (const slot of syncParamSlots) {
      shimArgs.push(`sm->${slot.fieldName}`);
    }
    if (shimArgs.length > 0) {
      closureEvidenceArgs = ", " + shimArgs.join(", ");
    }
  }
  const syncSetEffectFunctionName = `${structName}_set_effect`;
  const syncCaptureType = closureArgExpr.$.captureType;
  generateFutureEffectSetter(
    structName,
    syncSetEffectFunctionName,
    futureTraitType,
    syncCaptureType,
    context,
    syncParamSlots[0]
  );
  emitter.emitDeclarationLine(``);

  // Emit resume function — calls the closure with the embedded capture data
  emitter.emitDeclarationLine(`void ${resumeFunctionName}(void* ptr) {`);
  emitter.emitDeclarationLine(`  ${structName}* sm = (${structName}*)ptr;`);
  if (!isUnitType(resultType)) {
    emitter.emitDeclarationLine(
      `  sm->result = ${closureFunctionCName}(&sm->__capture${closureEvidenceArgs});`
    );
  } else {
    emitter.emitDeclarationLine(
      `  ${closureFunctionCName}(&sm->__capture${closureEvidenceArgs});`
    );
  }
  // If an effect handler called escape(), the closure returned early.
  // Set state to -2 (aborted) instead of -1 (completed).
  // Self-decrement the event loop reference (matching full SM behavior in
  // emitAsyncFutureEscape). The synchronous await abort path does NOT
  // decrement — all futures handle their own event loop ref cleanup.
  if (closureEvidenceArgs) {
    emitter.emitDeclarationLine(`  if (__yo_effect_escaped) {`);
    emitter.emitDeclarationLine(`    __yo_effect_escaped = 0;`);
    emitter.emitDeclarationLine(`    sm->state = -2;`);
    emitter.emitDeclarationLine(`    __yo_decr_rc(ptr);`);
    emitter.emitDeclarationLine(`    return;`);
    emitter.emitDeclarationLine(`  }`);
  }
  emitter.emitDeclarationLine(`  sm->state = -1;`);
  emitter.emitDeclarationLine(
    `  void (*continuation)(void*) = sm->continuation_fn;`
  );
  emitter.emitDeclarationLine(`  if (continuation) {`);
  emitter.emitDeclarationLine(`    void* cont_sm = sm->continuation_sm;`);
  emitter.emitDeclarationLine(`    continuation(cont_sm);`);
  emitter.emitDeclarationLine(`  }`);
  emitter.emitDeclarationLine(`  __yo_decr_rc(ptr);`);
  emitter.emitDeclarationLine(`}`);
  emitter.emitDeclarationLine(``);

  // Emit dispose function
  const captureType = closureArgExpr.$.captureType;
  const captureDropFn =
    captureType && typeContainsRcType(captureType)
      ? getDropFunctionForType(captureType, context)
      : undefined;
  const captureDupFn =
    captureType && typeContainsRcType(captureType)
      ? getDupFunctionForType(captureType, context)
      : undefined;
  const resultDropFn = getDropFunctionForType(resultType, context);
  emitter.emitDeclarationLine(`void ${disposeFunctionName}(void* ptr) {`);
  if (captureDropFn || resultDropFn) {
    emitter.emitDeclarationLine(`  ${structName}* sm = (${structName}*)ptr;`);
    if (captureDropFn) {
      emitter.emitDeclarationLine(
        `  // Drop captured variables (future owns its references)`
      );
      emitter.emitDeclarationLine(`  ${captureDropFn}(sm->__capture);`);
    }
    if (resultDropFn) {
      emitter.emitDeclarationLine(`  if (sm->state == -1) {`);
      emitter.emitDeclarationLine(`    ${resultDropFn}(sm->result);`);
      emitter.emitDeclarationLine(`  }`);
    }
  }
  emitter.emitDeclarationLine(`}`);
  emitter.emitDeclarationLine(``);

  // Generate the sync future allocation and initialization (body code)
  const resultVar = expr.$?.variableName || `__io_async_result`;
  const varTypeAndName = getVariableTypeString(futureType, resultVar, context);
  emitter.emitLine(
    `${indent}${varTypeAndName} = (${structName}*)__yo_malloc(sizeof(${structName}));`
  );
  emitter.emitLine(`${indent}memset(${resultVar}, 0, sizeof(${structName}));`);
  emitter.emitLine(`${indent}${resultVar}->header.ref_count = 1;`);
  if (context.needsCycleGC) {
    emitter.emitLine(`${indent}${resultVar}->header.gc_flags = 0;`);
    emitter.emitLine(
      `${indent}${resultVar}->header.gc_mark = __YO_GC_UNMARKED;`
    );
    emitter.emitLine(`${indent}${resultVar}->header.gc_next = NULL;`);
    emitter.emitLine(`${indent}${resultVar}->header.gc_prev = NULL;`);
  }
  if (context.needsCycleGC) {
    emitter.emitLine(
      `${indent}${resultVar}->header.dispose_fn = (void(*)(void*))${disposeFunctionName};`
    );
  } else {
    // Type-tag dispatch for sync_fut_t
    if (!context.disposeTypeIds) {
      context.disposeTypeIds = new Map();
      context.nextDisposeTypeId = 1;
    }
    let typeId = context.disposeTypeIds.get(disposeFunctionName);
    if (typeId === undefined) {
      typeId = context.nextDisposeTypeId!;
      context.nextDisposeTypeId = typeId + 1;
      context.disposeTypeIds.set(disposeFunctionName, typeId);
    }
    emitter.emitLine(`${indent}${resultVar}->header.type_id = ${typeId};`);
  }
  if (context.needsCycleGC) {
    emitter.emitLine(`${indent}${resultVar}->header.traverse_fn = NULL;`);
  }
  // Copy capture data from stack-allocated struct into the heap-allocated future
  emitter.emitLine(`${indent}${resultVar}->__capture = ${closureCode};`);
  // Dup captured variables so the future owns its own references.
  // The caller may drop the original captured variables after this function returns
  // but before the future's resume function runs.
  if (captureDupFn) {
    emitter.emitLine(
      `${indent}${resultVar}->__capture = ${captureDupFn}(${resultVar}->__capture);`
    );
  }
  // State 0 = not started (lazy), resume function will execute the closure
  emitter.emitLine(`${indent}${resultVar}->state = 0;`);
  emitter.emitLine(
    `${indent}${resultVar}->__yo_resume_fn = ${resumeFunctionName};`
  );
  emitter.emitLine(
    `${indent}${resultVar}->__yo_set_effect_fn = ${syncSetEffectFunctionName};`
  );
  emitter.emitLine(`${indent}${resultVar}->continuation_fn = NULL;`);
  emitter.emitLine(`${indent}${resultVar}->continuation_sm = NULL;`);

  return resultVar;
}
