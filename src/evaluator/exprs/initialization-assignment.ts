import { addVariableToEnv, type Environment } from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  hasAnyControlFlow,
  requireExprNotConsumed,
  setExprAsNeedsToCallDup,
  type FnCallExpr,
} from "../../expr";
import { generateNewTempVariableName } from "../../utils";
import { areTypesCompatible } from "../../types/compatibility";
import type { SomeType } from "../../types/definitions";
import { isSomeType } from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  prohibitVoidType,
  typeContainsRcType,
  typeIsControlBound,
  typeProhibitsComptimeModifier,
  typeRequiresComptimeModifier,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isFunctionValue,
  isStructValue,
  isTraitValue,
  isTypeValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { synthesizeExprAndType } from "../types/expr-synthesizer";
import { findRcValueOwnerRelationship, isValidVariableName } from "../utils";
import { cloneValue } from "../values/clone-value";
import { throwRhsContainsControlFlowExpressionError } from "./assignment";
import { evaluateDestructuringAssignment } from "./destructuring-assignment";
import { evaluateExpression } from "./expr";

/**
 * Evaluate the initialization assignment
 * - ::
 * - :=
 */
export function evaluateInitializationAssignment({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (
    !exprIsFunctionCallOf(expr, ":=", 2) &&
    !exprIsFunctionCallOf(expr, "::", 2)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ":=" or "::" for initialization assignment.`,
    });
  }
  // During CTFE (when forceCompileTimeBindings is true), treat `:=` as `::`
  const isCompileTimeOnly =
    exprIsFunctionCallOf(expr, "::") ||
    context.forceCompileTimeBindings === true;

  // For type conversion purposes, only consider :: as compile-time.
  // When using := with forceCompileTimeBindings, we evaluate at compile-time
  // but still convert types (e.g., comptime_int -> i32).
  const shouldConvertToRuntimeType = !exprIsFunctionCallOf(expr, "::");

  if (
    !isCompileTimeOnly &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Unexpected runtime variable declaration in a compile-time only function body.`,
    });
  }

  const lhs = expr.args[0]!;
  let rhs = expr.args[1]!;

  // v4.1 (plans/archive/BORROW_EXCLUSIVITY.md): local `inout(name) := …` bindings
  // are not supported — `inout` exists only in parameter position. Field
  // access already reads/writes in place (`h.s = v`), and binding the handle
  // (`b := a.b`) keeps an object alive without borrow machinery.
  const actualLhs = lhs;
  if (
    exprIsFunctionCall(actualLhs) &&
    exprIsFunctionCallOf(actualLhs, BuiltinKeywords.inout)
  ) {
    throw formatErrorMessage({
      token: actualLhs.token,
      errorMessage: `'inout(name) := ...' local bindings are not supported — 'inout' exists only in parameter position. Read and write fields directly ('h.s = v'), or bind the handle ('b := a.b') to keep an object alive.`,
    });
  }

  // Prevent declaring variable type using :: or :=
  if (exprIsFunctionCall(actualLhs) && exprIsFunctionCallOf(actualLhs, ":")) {
    throw formatErrorMessage({
      token: actualLhs.token,
      errorMessage: `Unexpected use of ":" in type declaration with "${
        expr.token.value
      }". Please consider using "=":
(${exprToString(actualLhs)}) = ${exprToString(rhs)}`,
    });
  }

  // Evaluate the rhs expression
  rhs = evaluateExpression({
    expr: rhs,
    env,
    context: {
      ...context,
      expectedType: undefined,
    },
  });

  if (rhs.$?.env) {
    env = rhs.$?.env;
  }

  if (rhs.$?.type) {
    // Prohibit the rhs to be a void
    prohibitVoidType(rhs.$.type, rhs.token);
  }

  if (hasAnyControlFlow(rhs.$?.controlFlow)) {
    // Check if the RHS is a cond expression to provide a more specific error message
    throwRhsContainsControlFlowExpressionError(rhs, rhs.$!.controlFlow!);
  }

  // §4 escape boundary 2: module-level binding type cannot be
  // control-bound. Module-level bindings outlive every call frame, so
  // a stored handler (or aggregate containing one) would be invokable
  // long after its install frame has returned. Type-level check via
  // `typeIsControlBound` catches direct CF values, structs/tuples with
  // CF fields, etc.
  {
    const isAtModuleLevel = !context.isEvaluatingFunctionBodyOrAsyncBlock;
    if (isAtModuleLevel) {
      const rhsType = rhs.$?.type;
      if (rhsType && typeIsControlBound(rhsType)) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Cannot bind a value whose type is control-bound (transitively contains a \`ctl(...) -> ret\` function type) at module level. Module-level bindings outlive every call frame; invoking the contained control-function later would unwind to a dead frame.

Bound type: ${typeToString(rhsType)}

Define handlers inside the function that uses them:
  use_it :: (fn(...) -> ...)({
    (raise : Raise) = ((msg) -> { unwind(...); });
    some_call(args, raise);
  });`,
        });
      }
    }
  }

  if (exprIsAtom(actualLhs)) {
    // Check if the RHS variable has been consumed (moved)
    requireExprNotConsumed(rhs, env);

    // Insert dup
    // NOTE: For destructuring in `else` block, we don't insert dup there.
    //       Because for simplicity destructuring uses borrowing, not owning.
    setExprAsNeedsToCallDup(rhs, { ...context });
    if (rhs.$?.env) {
      env = rhs.$?.env;
    }

    if (!isValidVariableName(actualLhs)) {
      throw formatErrorMessage({
        token: actualLhs.token,
        errorMessage: `Invalid assignment to ${actualLhs.token.value}, expected identifier or operator`,
      });
    }

    const effectiveIsCompileTimeOnly = isCompileTimeOnly;
    const effectiveShouldConvertToRuntimeType = shouldConvertToRuntimeType;

    // Set the variable type
    let rhsType = rhs.$?.type;
    if (!actualLhs.$?.type) {
      if (!rhsType) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Failed to evaluate, got ${exprToString(rhs)}`,
        });
      }

      // If it's runtime, then we convert
      // comptime_int -> i32
      // comptime_float -> f64
      // etc...
      let lhsType = rhsType;
      if (effectiveShouldConvertToRuntimeType) {
        lhsType = convertComptimeTypeToRuntimeType({
          type: rhsType,
          expectedType: undefined,
          expr: rhs,
          env,
        });
      }

      // user didn't specify the type
      actualLhs.$ = {
        ...actualLhs.$,
        env,
        type: lhsType,
        pathCollection: [],
      };
    } else {
      // If !rhsType, then check if rhs is a function call of _ or a tuple containing _
      try {
        // Infer the type
        const {
          expr: nextRhs,
          type: nextRhsType,
          env: nextEnv,
        } = synthesizeExprAndType({
          expr: rhs,
          type: actualLhs.$?.type,
          env: env,
          context: { ...context },
        });
        rhs = nextRhs;
        rhsType = nextRhsType;
        // as it is actually lhs.type if not synthesized.
        env = nextEnv;
      } catch (e) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `(evaluateInitializationAssignment) Failed to synthesize type for expression: ${exprToString(
            rhs
          )}\n${e}`,
        });
      }

      // Check if the type is compatible
      if (
        !areTypesCompatible(
          { type: actualLhs.$.type, env },
          { type: rhsType, env }
        )
      ) {
        throw formatErrorMessage({
          token: actualLhs.token,
          errorMessage: `Incompatible types:
- Defined: ${typeToString(actualLhs.$.type)}
- Given  : ${typeToString(rhsType)}`,
        });
      }
    }

    // Check some value that requires compile-time only
    if (
      !effectiveIsCompileTimeOnly &&
      typeRequiresComptimeModifier(actualLhs.$.type, env)
    ) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "::" instead of ":=" for compile-time known value assignment:
${exprToString(expr)}

Type:
${typeToString(actualLhs.$.type)}`,
      });
    }
    if (
      effectiveIsCompileTimeOnly &&
      typeProhibitsComptimeModifier(actualLhs.$.type, env)
    ) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected ":=" instead of "::" for value type "${typeToString(actualLhs.$.type)}" which can only be used at the runtime:
${exprToString(expr)}`,
      });
    }

    // Add .typeName info if necessary
    // But don't modify context.SelfType - it refers to the enclosing type
    const rhsValue = rhs.$?.value;
    if (
      isTypeValue(rhsValue) &&
      /*
        (isStructType(rhsValue.value) ||
          isEnumType(rhsValue.value) ||
          isUnionType(rhsValue.value) ||
          isSourceNamespaceType(rhsValue.value)) &&
        */
      !rhsValue.value.typeName &&
      rhsValue.value !== context.SelfType
    ) {
      rhsValue.value.typeName = actualLhs.token.value;
    } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
      rhsValue.funcName = actualLhs.token.value;
      rhsValue.funcId += `_${actualLhs.token.value}`;
    } else if (
      (isStructValue(rhsValue) || isTraitValue(rhsValue)) &&
      !rhsValue.type.typeName &&
      rhsValue.type !== context.SelfType
    ) {
      rhsValue.type.typeName = actualLhs.token.value;
    }

    // Mark bare function-type effect handlers for codegen.
    // When a handler function value uses unwind, mark it as an effect member
    // so its body is generated as a concrete C function for evidence passing.
    if (isFunctionValue(rhsValue) && rhsValue.isControlFunction) {
      rhsValue.isEffectRecordMember = true;
    }

    // No consumption logic needed

    // Prohibit assigning runtime value to comptime-only variable
    if (!rhsValue && effectiveIsCompileTimeOnly) {
      throw formatErrorMessage({
        token: actualLhs.token,
        errorMessage: `Expected compile-time value for "${actualLhs.token.value}".
Got runtime value. Please consider using ":=" instead of "::":
${exprToString(rhs)}`,
      });
    }

    // Set the variable value
    // For compile-time values, use cloneValue to ensure deep copy (value semantics)
    // This prevents mutations to one variable from affecting another
    // e.g., arr2 :: arr1 should create an independent copy
    // cloneValue with preservePointerReferences=true (default) ensures that pointers
    // maintain reference semantics even when nested in data structures
    actualLhs.$ = {
      ...actualLhs.$,
      env,
      type: actualLhs.$.type,
      value: effectiveIsCompileTimeOnly
        ? rhsValue
          ? cloneValue(rhsValue) // preservePointerReferences=true by default
          : createUnknownValue(actualLhs.$.type, {
              variableName: actualLhs.token.value,
              env,
              context,
            })
        : undefined,
      pathCollection: [],
    };

    // Add variable to env
    // Attach the updated env to expr

    // For SomeType (Impl(...)), copy the resolvedConcreteType from RHS to LHS type.
    // This is crucial for closures where the capture struct type is determined at initialization time.
    // The resolvedConcreteType is needed by mergeAndCheckEnvs to verify that all branches
    // have compatible concrete types (Impl uses static dispatch, so concrete type must be known).
    let finalLhsType = actualLhs.$.type;
    if (
      isSomeType(finalLhsType) &&
      rhsType &&
      isSomeType(rhsType) &&
      rhsType.resolvedConcreteType
    ) {
      finalLhsType = {
        ...finalLhsType,
        resolvedConcreteType: rhsType.resolvedConcreteType,
      } as SomeType;
      actualLhs.$.type = finalLhsType;
    }

    // Under the new simplified ownership model:
    // All variables own their values
    // But we track shared ownership for dup/drop optimization
    // Find if RHS is sharing ownership with another variable
    const rhsOwningVariable = findRcValueOwnerRelationship(
      rhs,
      env,
      env.modulePath
    );

    // If the RHS owning variable was consumed (moved), then the LHS should become
    // the primary owner (isOwningTheSameRcValueAs: undefined), not a secondary reference.
    // This ensures ownership transfers completely on move.
    let isOwningTheSameRcValueAs = rhsOwningVariable;
    if (rhsOwningVariable?.consumedAtToken) {
      // The RHS was moved, so LHS becomes the new primary owner
      isOwningTheSameRcValueAs = undefined;
    }

    // Rename "_" to a temp variable name so it gets tracked in the frame
    // for proper drop/RC cleanup. Without this, "_" is skipped by
    // addVariableToFrame and RC-typed values assigned to it would leak.
    const varName =
      actualLhs.token.value === "_"
        ? generateNewTempVariableName(env.modulePath)
        : actualLhs.token.value;

    // Create new variable
    // Error on mutable runtime variables inside impl blocks.
    // impl bodies should only contain :: (compile-time) definitions.
    if (
      !effectiveIsCompileTimeOnly &&
      !context.isEvaluatingFunctionBodyOrAsyncBlock &&
      context.isInsideImplBlock
    ) {
      throw formatErrorMessage({
        token: actualLhs.token,
        errorMessage: `Mutable runtime variable "${varName}" is not allowed inside an impl block.
Use \`::\` for compile-time definitions inside impl.`,
      });
    }

    // Mark as module-level if we're NOT inside a function body — these become
    // C file-scope static variables accessible from all module functions.
    const isModuleLevel =
      !effectiveIsCompileTimeOnly &&
      !context.isEvaluatingFunctionBodyOrAsyncBlock;

    // Look up doc comment for this declaration from the pre-computed lookup
    const docComment = context.docCommentLookup?.get(
      getDocCommentLookupKey(actualLhs.token)
    );

    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: varName,
        type: finalLhsType,
        isCompileTimeOnly: effectiveIsCompileTimeOnly,
        value:
          rhsValue && isFunctionValue(rhsValue)
            ? [rhsValue]
            : actualLhs.$.value
              ? [actualLhs.$.value]
              : undefined,
        token: actualLhs.token,
        initializedAtToken: actualLhs.token,
        consumedAtToken: undefined, // Not consumed yet
        isOwningTheRcValue: typeContainsRcType(finalLhsType),
        // Only set shared ownership for Copy types (shared references)
        // If RHS was moved, LHS becomes the primary owner
        isOwningTheSameRcValueAs,
        isReassignable: true,
        isModuleLevel,
        docComment,
      },
    });
    env = nextEnv;

    // Store the renamed variable name so codegen uses it instead of "_"
    if (actualLhs.token.value === "_") {
      actualLhs.$.variableName = varName;
    }
    actualLhs.$.env = env;
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      pathCollection: [],
      isCompileTimeOnlyAssignment: effectiveIsCompileTimeOnly,
    };
    return expr;
  } else {
    const effectiveIsCompileTimeOnly = isCompileTimeOnly;
    const { env: nextEnv, runtimeDestructurings } =
      evaluateDestructuringAssignment({
        lhs: actualLhs,
        rhs,
        env,
        isCompileTimeOnly,
        context: { ...context },
      });
    env = nextEnv;

    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      pathCollection: [],
      runtimeDestructurings,
      isCompileTimeOnlyAssignment: effectiveIsCompileTimeOnly,
    };
    return expr;
  }
}
