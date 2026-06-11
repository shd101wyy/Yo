import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type PathCollection,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import type { TypeField } from "../../types/definitions";
import { isFunctionType } from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  isComptimeOnlyType,
  tupleFieldToString,
  typeToString,
} from "../../types/utils";
import type { Value } from "../../value";
import type { EvaluatorContext, TypeCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * This is for calling struct/enum/union types with arguments
 * to initialize their members.
 *
 */
export function tryToCallTypeWithArguments({
  typeFields,
  functionCalleeExpr,
  argExprs,
  callerEnv,
  context,
  isUnionType,
}: {
  typeFields: TypeField[];
  functionCalleeExpr: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isUnionType?: boolean;
}): TypeCallResult {
  if (argExprs.length > typeFields.length) {
    throw formatErrorMessage({
      token: functionCalleeExpr.token,
      errorMessage: `Failed to call the type. Too many members provided. Expected ${typeFields.length} arguments, got ${argExprs.length}.`,
    });
  }
  if (isUnionType && argExprs.length !== 1) {
    throw formatErrorMessage({
      token: functionCalleeExpr.token,
      errorMessage: `Failed to call the union type. Expected exactly one argument, got ${argExprs.length}.`,
    });
  }

  const checkedMemberElements: Set<TypeField> = new Set();
  const values: (Value | undefined)[] = Array(typeFields.length).fill(
    undefined
  );
  const runtimeArgExprsInOrder: Expr[] = [];

  for (let i = 0; i < typeFields.length; i++) {
    let memberElement = typeFields[i]!;

    let argExpr = argExprs[i];
    if (!argExpr) {
      break;
    }

    // Check if it's a label
    let labelExpr: Expr | undefined = undefined;
    if (exprIsFunctionCall(argExpr) && exprIsFunctionCallOf(argExpr, ":", 2)) {
      labelExpr = argExpr.args[0]!;
      argExpr = argExpr.args[1]!;

      if (!exprIsAtom(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for label, got:\n${exprToString(labelExpr)}`,
        });
      }
    }

    if (labelExpr) {
      const label = labelExpr.token.value;
      // Find the matching label in the expectedType
      const paramElement_ = typeFields.find(
        (element) => element.label === label
      );
      if (!paramElement_) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Failed to find "${label}" in the type.`,
        });
      } else if (paramElement_.assignedValue) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Cannot use label "${label}" for already assigned value:
${tupleFieldToString(paramElement_)}`,
        });
      } else {
        memberElement = paramElement_;
      }
    }

    if (checkedMemberElements.has(memberElement)) {
      // Already checked this element
      // We cannot have duplicate labels
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Type member "${memberElement.label}" is already implemented.`,
      });
    }
    const memberElementPositionIndex = typeFields.indexOf(memberElement);

    // Evaluate the argExpr
    const evaluatedArgExpr = evaluateExpression({
      expr: argExpr,
      env: callerEnv,
      context: {
        ...context,
        expectedType: { type: memberElement.type, env: callerEnv },
      },
    });

    if (!evaluatedArgExpr.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
      });
    }

    setExprAsNeedsToCallDup(evaluatedArgExpr, context);
    callerEnv = evaluatedArgExpr.$.env;

    // Get the type of the evaluated arg expr
    let argType = evaluatedArgExpr.$.type;

    // Convert compile-time types to runtime types only if:
    // 1. The member element is not compile-time only, AND
    // 2. The member type itself is not comptime-only (e.g., comptime_int, Type, etc.)
    // This allows struct fields like `x : comptime_int` (without comptime modifier) to accept comptime values.
    if (!isComptimeOnlyType(memberElement.type, callerEnv)) {
      argType = convertComptimeTypeToRuntimeType({
        type: argType,
        expectedType: memberElement.type,
        expr: evaluatedArgExpr,
        env: callerEnv,
      });
    }

    // Attach information to labelExpr
    if (labelExpr) {
      labelExpr.$ = evaluatedArgExpr.$;
    }

    // Compare the types
    if (
      !areTypesCompatible(
        { type: memberElement.type, env: callerEnv },
        { type: argType, env: callerEnv }
      )
    ) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Type mismatch for type member "${memberElement.label}":
Expected: ${typeToString(memberElement.type)}
Got:   ${typeToString(argType)}`,
      });
    }

    const argValue = evaluatedArgExpr.$?.value;

    // Propagate ioBuiltin from extern function types to struct field types.
    // This ensures io.async/io.await/io.spawn/etc. are detected as Io builtins
    // even when accessed through a struct field (mirrors the behavior in
    // record-type.ts for record constructors).
    if (argType.ioBuiltin && isFunctionType(memberElement.type)) {
      memberElement.type.ioBuiltin = argType.ioBuiltin;
    }

    // Set the values
    // if (memberElement.isCompileTimeOnly) {
    values[memberElementPositionIndex] = argValue;
    runtimeArgExprsInOrder[memberElementPositionIndex] = evaluatedArgExpr;
    // }
    checkedMemberElements.add(memberElement);
  }

  if (!isUnionType) {
    // Check if any unchecked member elements have no default value
    for (let i = 0; i < typeFields.length; i++) {
      const memberElement = typeFields[i]!;
      if (!checkedMemberElements.has(memberElement)) {
        if (!memberElement.defaultValue && !memberElement.assignedValue) {
          throw formatErrorMessage({
            token: functionCalleeExpr.token,
            errorMessage: `Type member "${memberElement.label}" is not provided and has no default value or assigned value.`,
          });
        } else {
          // Set the default value to values
          // if (memberElement.isCompileTimeOnly) {
          values[i] = memberElement.defaultValue ?? memberElement.assignedValue;
          runtimeArgExprsInOrder[i] = (memberElement.exprs.defaultValueExpr ??
            memberElement.exprs.assignedValueExpr)!;
          // }
        }
      }
    }
  }

  const pathCollection: PathCollection = [];

  return { values, pathCollection, callerEnv, runtimeArgExprsInOrder };
}
