import { typeImplementsFuture } from "../../evaluator/trait-checking";
import { findMethodsFromGenericImpls } from "../../evaluator/values/impl";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import type { Type } from "../../types/definitions";
import {
  isBoxedType,
  isDynType,
  isEnumType,
  isFunctionSpecializable,
  isFunctionType,
  isFunctionTypeHardGeneric,
  isReferenceStructType,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import {
  isFunctionValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
  type StructValue,
  type TraitValue,
} from "../../value";
import { collectType, collectTypesFromFunctionType } from "../types/collection";
import { type CodeGenContext, sanitizeForCIdentifier } from "../utils";
import { getEvidenceParameters } from "./declarations";

/**
 * Check if an expression tree contains any UnknownValue.
 * This indicates that the expression was not fully evaluated, which usually means
 * it's part of a generic function that wasn't fully specialized.
 */
function exprContainsUnknownValue(expr: Expr): boolean {
  // Check if this expression has an unknown value
  if (expr.$ && expr.$.value && isUnknownValue(expr.$.value)) {
    // If the expression has a function type that is extern, it's not truly unknown
    // External functions (like printf, gc_collect) are known at codegen time
    if (isFunctionType(expr.$.type) && expr.$.type.isExtern) {
      // return false; // Continue to check args
    } else if (isUnitType(expr.$.type)) {
      // Continue to check args
    } else {
      return true;
    }
  }

  // Recursively check function calls
  if (exprIsFunctionCall(expr)) {
    if (exprContainsUnknownValue(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (arg.$?.type && isUnitType(arg.$.type)) {
        continue;
      }

      if (exprContainsUnknownValue(arg)) {
        return true;
      }
    }
  }

  // Check macro expansions
  if (expr.$ && expr.$.macroExpansion) {
    if (expr.$.type && isUnitType(expr.$.type)) {
      return false;
    }

    if (exprContainsUnknownValue(expr.$.macroExpansion)) {
      return true;
    }
  }

  // Check deferred expressions
  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      if (exprContainsUnknownValue(dupExpr)) {
        return true;
      }
    }
  }

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      if (exprContainsUnknownValue(dropExpr)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * First pass: collect all functions that need to be generated.
 *
 * When isLibrary or executable mode, functions from the current module get
 * plain C names for external linkage — UNLESS the plain name would collide
 * with another function (e.g., trait impl methods named `print` for different
 * types). Collisions fall back to mangled funcId-based names.
 */
export function collectRequiredFunctions(
  moduleValue: StructValue | TraitValue,
  context: CodeGenContext,
  isTopLevelExport = true
): void {
  // Start with exported functions
  for (let i = 0; i < moduleValue.fields.length; i++) {
    const value = moduleValue.fields[i]!;
    const field = moduleValue.type.fields[i]!;

    if (isFunctionValue(value)) {
      const label = field.label;

      // Exported functions keep their original names (except main)
      if (label === "main") {
        // Rename user's main to __yo_user_main - we'll wrap it
        context.functions[value.funcId] = {
          value,
          cName: "__yo_user_main",
        };
      } else if (context.isLibrary) {
        // In library mode, exported functions from the current module use their
        // plain label name so they can be referenced by extern "Yo" in other modules.
        // Functions from other modules (e.g., std library trait impls) keep hashed names.
        // Skip plain names for trait impl methods (not top-level exports) or
        // when the plain name would collide with an already-collected function.
        const isFromCurrentModule =
          isTopLevelExport &&
          context.currentModuleId &&
          value.funcId.startsWith(`fn_${context.currentModuleId}_`);
        if (isFromCurrentModule) {
          const plainCName = sanitizeForCIdentifier(label);
          const hasCollision = Object.values(context.functions).some(
            (f) => f.cName === plainCName
          );
          if (!hasCollision) {
            context.functions[value.funcId] = {
              value,
              cName: plainCName,
            };
            if (!context.exportedFunctionLabels) {
              context.exportedFunctionLabels = new Map();
            }
            context.exportedFunctionLabels.set(value.funcId, label);
          } else {
            context.functions[value.funcId] = {
              value,
              cName: sanitizeForCIdentifier(value.funcId),
            };
          }
        } else {
          context.functions[value.funcId] = {
            value,
            cName: sanitizeForCIdentifier(value.funcId),
          };
        }
      } else {
        // Executable mode: top-level exports from the current module use their
        // plain label name so they can be referenced by emcc's
        // -sEXPORTED_FUNCTIONS (e.g., _wasm_render). Functions collected from
        // other modules or through recursive traversal (isTopLevelExport=false)
        // keep hashed names to avoid C/POSIX collisions.
        const isFromCurrentModule =
          isTopLevelExport &&
          context.currentModuleId &&
          value.funcId.startsWith(`fn_${context.currentModuleId}_`);
        if (isFromCurrentModule) {
          const plainCName = sanitizeForCIdentifier(label);
          const hasCollision = Object.values(context.functions).some(
            (f) => f.cName === plainCName
          );
          if (!hasCollision) {
            context.functions[value.funcId] = {
              value,
              cName: plainCName,
            };
            // Register for external linkage (no static inline prefix)
            if (!context.exportedFunctionLabels) {
              context.exportedFunctionLabels = new Map();
            }
            context.exportedFunctionLabels.set(value.funcId, label);
          } else {
            context.functions[value.funcId] = {
              value,
              cName: sanitizeForCIdentifier(value.funcId),
            };
          }
        } else {
          context.functions[value.funcId] = {
            value,
            cName: sanitizeForCIdentifier(value.funcId),
          };
        }
      }

      // Recursively collect functions called by this function
      findFunctionCallsInExpr(value.body, context);
    }
  }
}

/**
 * Recursively collect function values from a struct namespace and its nested records,
 * marking them as effect record members so they get compiled as standalone functions.
 */
function collectEffectRecordMembers(
  mv: StructValue,
  context: CodeGenContext
): void {
  for (let i = 0; i < mv.fields.length; i++) {
    const fieldValue = mv.fields[i];
    if (fieldValue && isFunctionValue(fieldValue)) {
      if (!context.functions[fieldValue.funcId]) {
        fieldValue.isEffectRecordMember = true;
        context.functions[fieldValue.funcId] = {
          value: fieldValue,
          cName: sanitizeForCIdentifier(fieldValue.funcId),
        };
        findFunctionCallsInExpr(fieldValue.body, context);
      }
      // Also collect specialized versions (e.g., forall throw handlers specialized
      // for concrete ResumeTypes such as SomeType or struct types). Without this,
      // the codegen emits a call to the specialized name but never defines it.
      if (fieldValue.specializedFunctionCaches) {
        for (const cache of fieldValue.specializedFunctionCaches) {
          const specialized = cache.specializedFunction;
          if (specialized && !context.functions[specialized.funcId]) {
            specialized.isEffectRecordMember = true;
            context.functions[specialized.funcId] = {
              value: specialized,
              cName: sanitizeForCIdentifier(specialized.funcId),
            };
            findFunctionCallsInExpr(specialized.body, context);
          }
        }
      }
    } else if (fieldValue && isStructValue(fieldValue)) {
      collectEffectRecordMembers(fieldValue, context);
    }
  }
}

/**
 * Find function calls in an expression and collect them
 */
export function findFunctionCallsInExpr(
  expr: Expr,
  context: CodeGenContext
): void {
  // Collect function values inside StructValues that are bound to variables
  // used as effect handlers (e.g., given(exn) := Exception(throw : handler)).
  // These functions live inside compile-time struct namespace values and are NOT represented
  // as function call expressions in the AST, so the normal traversal misses them.
  if (expr.$?.value && isStructValue(expr.$.value)) {
    const mv = expr.$.value;
    collectEffectRecordMembers(mv, context);
  }
  // Skip test blocks - they should not generate code
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.test)
  ) {
    return;
  }

  // Skip comptime_expect_error blocks - they are no-ops in C codegen.
  // Functions only called inside comptime_expect_error may have unresolved
  // implicit parameters and should not be collected for code generation.
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_expect_error)
  ) {
    return;
  }

  // If this is a macro expansion, recursively collect from the expanded expression
  if (expr.$ && expr.$.macroExpansion) {
    findFunctionCallsInExpr(expr.$.macroExpansion, context);
  }

  // Collect functions from effect handler bodies (re-evaluated handler bodies may
  // contain function calls like println that need to be collected for codegen)
  if (expr.$?.effectAnalysis) {
    const handlerValue = expr.$.effectAnalysis.handlerValue as
      | FunctionValue
      | undefined;
    if (handlerValue && isFunctionValue(handlerValue)) {
      findFunctionCallsInExpr(handlerValue.body, context);
    }
  }

  // For closure construction, collect the closure function
  if (expr.$ && expr.$.closureFunctionValue) {
    const closureFunctionValue = expr.$.closureFunctionValue;
    if (!context.functions[closureFunctionValue.funcId]) {
      context.functions[closureFunctionValue.funcId] = {
        value: closureFunctionValue,
        cName: sanitizeForCIdentifier(closureFunctionValue.funcId),
      };
      // Also recursively collect functions called by this closure function
      findFunctionCallsInExpr(closureFunctionValue.body, context);
    }
  }

  // Collect Index trait method from expr.$.indexMethodValue.
  // Index trait dispatch stores the specialized method function on the expression
  // metadata, which the normal traversal doesn't visit.
  if (expr.$?.indexMethodValue && isFunctionValue(expr.$.indexMethodValue)) {
    const indexFuncValue = expr.$.indexMethodValue;
    if (!context.functions[indexFuncValue.funcId]) {
      context.functions[indexFuncValue.funcId] = {
        value: indexFuncValue,
        cName: sanitizeForCIdentifier(indexFuncValue.funcId),
      };
      findFunctionCallsInExpr(indexFuncValue.body, context);
    }
  }

  // Check for dyn() calls to collect impls
  if (
    exprIsFunctionCall(expr) &&
    expr.$ &&
    expr.$.dynCallTraitValues &&
    expr.$.dynCallTraitValues.length > 0
  ) {
    const dynType = expr.$.type;
    const valueExpr = expr.args[0];

    if (isDynType(dynType) && valueExpr && valueExpr.$?.type) {
      const valueType = valueExpr.$.type;
      const traitValues = expr.$.dynCallTraitValues;

      if (
        traitValues.length > 0 &&
        (isReferenceStructType(valueType) || isBoxedType(valueType))
      ) {
        const concreteType: Type = isBoxedType(valueType)
          ? valueType.fields[0]!.type
          : valueType;

        // Store all trait values in order so wrapper generation can match
        // trait requirements with their values.

        // Use ID-based key for now, will be fixed up later
        const implKey = `${concreteType.id}_${dynType.id}`;

        context.dynImpls.set(implKey, {
          dynType,
          concreteType,
          dataType: valueType,
          traitValues,
        });
      }
    }
  }

  if (exprIsFunctionCall(expr)) {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (expr.func.token.value === "?=") {
      // Skip the default value assignment in a module/function parameter?
      return;
    }

    if (isFunctionType(functionType)) {
      // If the callee is a ctl function, the handler will be inlined by
      // the effect state machine. Don't collect it as a standalone function,
      // but still recurse into its body to collect sub-function calls (e.g., println).
      if (isFunctionValue(functionValue) && functionValue.isControlFunction) {
        findFunctionCallsInExpr(functionValue.body, context);
        // Still recurse into args
        for (const arg of expr.args) {
          findFunctionCallsInExpr(arg, context);
        }
        return;
      }

      if (isFunctionValue(functionValue)) {
        // Skip collecting CTFE (compile-time function evaluation) functions.
        // These are functions whose return type is isCompileTimeOnly, meaning
        // their results are computed at compile time and shouldn't generate runtime code.
        if (functionValue.type.return.isCompileTimeOnly) {
          return;
        }

        // Skip collecting functions that are generic and haven't been specialized.
        // BUT still recurse into args — they may contain closure constructions
        // (e.g. `io.async((io2 : Io) => { ... })` where io.async stays generic
        // but the closure arg needs registration) or other functions that
        // need to be collected independently.
        if (
          isFunctionSpecializable(functionValue) &&
          !functionValue.specializedType
        ) {
          findFunctionCallsInExpr(expr.func, context);
          for (const arg of expr.args) {
            findFunctionCallsInExpr(arg, context);
          }
          return;
        }

        // Also skip if the specialized type still has unresolved type parameters
        // This can happen when type substitution is incomplete
        // BUT: still scan the args — they may contain closure constructions or
        // other functions that need to be collected independently.
        // Use isFunctionTypeHardGeneric: functions generic ONLY due to implicit
        // params (e.g., using(io : Io)) can still be codegen'd because implicit
        // params are compile-time-only and don't appear in C signatures.
        // EXCEPTION: Functions with evidence parameters (from implicit params that
        // resolve to module/function effects) are valid for codegen even if
        // "hard-generic" — the implicit params become C function pointer parameters.
        if (
          functionValue.specializedType &&
          isFunctionTypeHardGeneric(functionValue.specializedType)
        ) {
          const evidenceParams = getEvidenceParameters(
            functionValue.specializedType
          );
          if (evidenceParams.length === 0) {
            // Truly hard-generic — skip but still scan args
            findFunctionCallsInExpr(expr.func, context);
            for (const arg of expr.args) {
              findFunctionCallsInExpr(arg, context);
            }
            return;
          }
          // Has evidence params — fall through to collect normally
        }

        if (context.functions[functionValue.funcId]) {
          // Already collected this function
          // return;
          // NOTE: We shouldn't return here, because it's arguments might be different
        } else {
          // Skip collecting functions whose body contains UnknownValue
          let isGenericOnlyDueToImplicitParams = false;
          if (exprContainsUnknownValue(functionValue.body)) {
            // Functions that are only "generic" due to implicit parameters
            // (e.g., using(io : Io)) may have UnknownValue in their body for the
            // implicit parameter references (like `io` or `io.await`). These functions
            // are still valid for codegen because:
            // 1. Io builtin calls (io.await, io.async, io.state) are handled specially by codegen
            // 2. The implicit parameters are compile-time-only and don't appear in C signatures
            // 3. The function body is otherwise fully evaluated
            // Check both original and specialized types: the original type may be
            // "hard-generic" due to implicit params, but having evidence parameters
            // means those implicits are handled via evidence passing.
            // No implicit parameters exist post-EXPLICIT_EFFECTS;
            // this whole "specialize-only-for-implicit-params" path
            // is no longer reachable.
            isGenericOnlyDueToImplicitParams = false;
            if (!isGenericOnlyDueToImplicitParams) {
              return;
            }
          }

          // Skip collecting SomeType's ARC functions (___drop, ___dup) that have
          // generic Impl(Future) parameters without resolvedConcreteType.
          // Exception: user-defined functions with evidence parameters (e.g.,
          // test_escape(task: Impl(Future(...)), using(io: Io))) should be
          // collected — their SomeType params are valid for codegen because the
          // concrete type is resolved at the call site.
          if (!isGenericOnlyDueToImplicitParams) {
            const hasEvidence =
              getEvidenceParameters(
                functionValue.specializedType ?? functionValue.type
              ).length > 0;
            if (!hasEvidence) {
              const checkParamTypes = (
                functionValue.specializedType ?? functionValue.type
              ).parameters.map((p) => p.type);
              const hasSomeTypeWithoutResolved = checkParamTypes.some(
                (t) =>
                  isSomeType(t) &&
                  typeImplementsFuture(t) &&
                  !t.resolvedConcreteType
              );
              if (hasSomeTypeWithoutResolved) {
                return;
              }
            }
          }

          // Collect the function if it's not already collected
          context.functions[functionValue.funcId] = {
            value: functionValue,
            cName: sanitizeForCIdentifier(functionValue.funcId), // Use the function id as the C name
          };

          // Recursively collect functions called by this function
          findFunctionCallsInExpr(functionValue.body, context);
        }
      } else if (functionType.isExtern === "c") {
        // Might be the extern functions
        // Use externName if available (set during c_include evaluation)
        // This ensures we use the original C function name even if it was imported with a rename
        const cName = functionType.externName
          ? functionType.externName
          : exprIsAtom(expr.func)
            ? expr.func.token.value
            : functionType.id;
        context.externFunctions[functionType.id] = {
          type: functionType,
          cName,
        };
      } else if (functionType.isExtern === "yo") {
        // Extern Yo functions — from other Yo modules (static libraries)
        // Skip internal Yo builtins (__yo_* prefixed) — they are compile-time only
        const externName = functionType.externName;
        if (externName && externName.startsWith("__yo_")) {
          // Internal builtin — skip
        } else {
          // Use the externName (set during extern "Yo" evaluation) as the C name,
          // since the library exports functions with their plain label name
          const cName = externName
            ? sanitizeForCIdentifier(externName)
            : exprIsAtom(expr.func)
              ? sanitizeForCIdentifier(expr.func.token.value)
              : sanitizeForCIdentifier(functionType.id);
          context.externFunctions[functionType.id] = {
            type: functionType,
            cName,
          };
        }
      }
    }

    // Recursively check the function call itself
    findFunctionCallsInExpr(expr.func, context);

    // Recursively check the function call arguments
    for (const arg of expr.args) {
      findFunctionCallsInExpr(arg, context);
    }
  }

  // expr might be anonymous function value
  const functionType = expr.$?.type;
  const functionValue = expr.$?.value;
  if (isFunctionType(functionType)) {
    // Ctl handler functions (isControlFunction=true) are normally inlined at call
    // sites by generateDirectCtlCall. However, when used as evidence handlers
    // (passed as fn ptr evidence args), they must be standalone C functions.
    // Collect them and mark as effect members so generateUnwind sets the unwind flag.
    if (isFunctionValue(functionValue) && functionValue.isControlFunction) {
      functionValue.isEffectRecordMember = true;
      if (!context.functions[functionValue.funcId]) {
        context.functions[functionValue.funcId] = {
          value: functionValue,
          cName: sanitizeForCIdentifier(functionValue.funcId),
        };
      }
      // Also collect specialized versions of forall ctl handlers
      if (functionValue.specializedFunctionCaches) {
        for (const cache of functionValue.specializedFunctionCaches) {
          const specialized = cache.specializedFunction;
          if (specialized && !context.functions[specialized.funcId]) {
            specialized.isEffectRecordMember = true;
            context.functions[specialized.funcId] = {
              value: specialized,
              cName: sanitizeForCIdentifier(specialized.funcId),
            };
            findFunctionCallsInExpr(specialized.body, context);
          }
        }
      }
      findFunctionCallsInExpr(functionValue.body, context);
      return;
    }
    if (isFunctionValue(functionValue)) {
      // Skip collecting generic functions that haven't been specialized
      if (
        isFunctionSpecializable(functionValue) &&
        !functionValue.specializedFunctionCaches
      ) {
        return;
      }

      if (context.functions[functionValue.funcId]) {
        // Already collected this function
        return;
      } else {
        // Skip collecting functions whose body contains UnknownValue
        // This means the function wasn't fully evaluated (e.g., nested function in an unspecialized generic)
        if (exprContainsUnknownValue(functionValue.body)) {
          return;
        }

        // Collect the function if it's not already collected
        context.functions[functionValue.funcId] = {
          value: functionValue,
          cName: sanitizeForCIdentifier(functionValue.funcId),
        };

        // Recursively collect functions called by this function
        findFunctionCallsInExpr(functionValue.body, context);
      }
    }
  }
  // Note: Closures are now runtime-only values, so we can't collect their function information at compile time
  // The closure's function will be collected when it's defined (as a FunctionValue)

  // expr might be a comptime function call that returns a type
  if (isTypeValue(expr.$?.value)) {
    collectType(expr.$.value.value, context);
  }

  // Check for deferredDupExpressions and collect their functions
  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      findFunctionCallsInExpr(dupExpr, context);
    }
  }

  // Check for deferredDropExpressions and collect their functions
  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      findFunctionCallsInExpr(dropExpr, context);
    }
  }

  // Check for dynCallTraitValues and collect their functions
  if (expr.$?.dynCallTraitValues) {
    for (const traitValue of expr.$.dynCallTraitValues) {
      // Recursively collect functions from the dyn() trait values.
      collectRequiredFunctions(traitValue, context, false);
    }
  }
}

/**
 * Collect dispose methods from generic impls for all collected struct types.
 * This is needed because generic impls like:
 *   impl(forall(T : Type), ArrayList(T), Dispose(...))
 * store a generic dispose function that doesn't get specialized until it's called.
 * Since the ___dispose function needs to call the user's dispose method,
 * we need to specialize and collect it here.
 */
export function collectDisposeMethodsFromGenericImpls(
  context: CodeGenContext
): void {
  const disposeFuncName = BuiltinFunctions.dispose[0]!;

  for (const typeId in context.types) {
    const { type } = context.types[typeId]!;

    // Only check RC struct types (object types)
    if (!isStructType(type) || !type.isReferenceSemantics) {
      continue;
    }

    // Try to find dispose method from generic impls
    const methods = findMethodsFromGenericImpls({
      concreteType: type,
      methodName: disposeFuncName,
      env: type.env,
    });

    for (const method of methods) {
      if (method.value && isFunctionValue(method.value)) {
        const funcValue = method.value;

        // Skip if already collected
        if (context.functions[funcValue.funcId]) {
          continue;
        }

        // Set funcName if not already set
        if (!funcValue.funcName) {
          funcValue.funcName = disposeFuncName;
        }

        // Register the specialized dispose function
        context.functions[funcValue.funcId] = {
          value: funcValue,
          cName: sanitizeForCIdentifier(funcValue.funcId),
        };

        // Collect types from the function signature
        collectTypesFromFunctionType(funcValue.type, context);

        // Recursively collect functions called by this dispose function
        findFunctionCallsInExpr(funcValue.body, context);
      }
    }
  }
}

/**
 * Collect `trace` methods (the Trace trait) from generic impls for all collected
 * reference-counted types. Like collectDisposeMethodsFromGenericImpls: a generic
 * impl such as `impl(ArrayList(forall(E)), Trace(...))` stores a generic `trace`
 * that isn't specialized until called, but the cycle-GC traverse function for the
 * container needs to CALL it — so specialize and collect it here (which also pulls
 * in the per-element `GcTracer.visit` monomorphizations referenced in its body).
 */
export function collectTraceMethodsFromGenericImpls(
  context: CodeGenContext
): void {
  const traceFuncName = "trace";

  for (const typeId in context.types) {
    const { type } = context.types[typeId]!;

    // Reference-counted struct OR enum types can carry a Trace impl.
    const isRc =
      (isStructType(type) || isEnumType(type)) && type.isReferenceSemantics;
    if (!isRc) {
      continue;
    }

    const methods = findMethodsFromGenericImpls({
      concreteType: type,
      methodName: traceFuncName,
      env: type.env,
    });

    for (const method of methods) {
      if (method.value && isFunctionValue(method.value)) {
        const funcValue = method.value;

        if (context.functions[funcValue.funcId]) {
          continue;
        }
        if (!funcValue.funcName) {
          funcValue.funcName = traceFuncName;
        }
        context.functions[funcValue.funcId] = {
          value: funcValue,
          cName: sanitizeForCIdentifier(funcValue.funcId),
        };
        collectTypesFromFunctionType(funcValue.type, context);
        findFunctionCallsInExpr(funcValue.body, context);
      }
    }
  }
}
