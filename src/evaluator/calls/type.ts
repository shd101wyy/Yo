import { Borrowing, checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  PathCollection,
  setExprAsConsumed,
} from "../../expr";
import {
  areTypesCompatible,
  isMutRefType,
  isRefType,
  TupleElement,
  tupleElementToString,
  typeToString,
} from "../../types";
import { Value } from "../../value";
import { EvaluatorContext, TypeCallResult } from "../context";

/**
 * This is for calling struct/enum/union types with arguments
 * to initialize their members.
 *
 */
export function tryToCallTypeWithArguments({
  memberElements,
  functionCalleeExpr,
  argExprs,
  callerEnv,
  context,
  isUnionType,
}: {
  memberElements: TupleElement[];
  functionCalleeExpr: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isUnionType?: boolean;
}): TypeCallResult {
  if (argExprs.length > memberElements.length) {
    throw formatErrorMessage({
      token: functionCalleeExpr.token,
      errorMessage: `Failed to call the type. Too many members provided. Expected ${memberElements.length} arguments, got ${argExprs.length}.`,
    });
  }
  if (isUnionType && argExprs.length !== 1) {
    throw formatErrorMessage({
      token: functionCalleeExpr.token,
      errorMessage: `Failed to call the union type. Expected exactly one argument, got ${argExprs.length}.`,
    });
  }

  const initialBorrowings: Borrowing[] = [...context.borrowings];
  let borrowings: Borrowing[] = [...context.borrowings];

  const checkedMemberElements: Set<TupleElement> = new Set();
  const values: (Value | undefined)[] = Array(memberElements.length).fill(
    undefined
  );
  const runtimeArgExprsInOrder: Expr[] = [];

  for (let i = 0; i < memberElements.length; i++) {
    let memberElement = memberElements[i]!;

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
      const paramElement_ = memberElements.find(
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
${tupleElementToString(paramElement_)}`,
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
    const memberElementPositionIndex = memberElements.indexOf(memberElement);

    // Evaluate the argExpr
    const evaluatedArgExpr = context.evaluateExpression({
      expr: argExpr,
      env: callerEnv,
      context: {
        ...context,
        expectedType: { type: memberElement.type, env: callerEnv },
        borrowings,
      },
    });

    if (!evaluatedArgExpr.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
      });
    }
    // Set the argExpr as consumed
    callerEnv = setExprAsConsumed(
      evaluatedArgExpr,
      evaluatedArgExpr.$.env,
      context
    );

    // Get the type of the evaluated arg expr
    const argType = evaluatedArgExpr.$.type;

    // Attach information to labelExpr
    if (labelExpr) {
      labelExpr.$ = evaluatedArgExpr.$;
    }

    // Check the borrowings
    if (evaluatedArgExpr.$ && (isMutRefType(argType) || isRefType(argType))) {
      checkBorrowings(borrowings, evaluatedArgExpr);

      // Add the evaluated arg expr to the borrowings
      borrowings = borrowings.concat([
        {
          expr: evaluatedArgExpr,
          type: argType,
          pathCollection: evaluatedArgExpr.$.pathCollection,
        },
      ]);
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

    // Set the values
    // if (memberElement.isCompileTimeOnly) {
    values[memberElementPositionIndex] = evaluatedArgExpr.$?.value;
    runtimeArgExprsInOrder[memberElementPositionIndex] = evaluatedArgExpr;
    // }
    checkedMemberElements.add(memberElement);
  }

  if (!isUnionType) {
    // Check if any unchecked member elements have no default value
    for (let i = 0; i < memberElements.length; i++) {
      const memberElement = memberElements[i]!;
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
  if (borrowings.length !== initialBorrowings.length) {
    const newBorrowings = borrowings.slice(initialBorrowings.length);
    newBorrowings.forEach((borrowing) => {
      const pc = borrowing.pathCollection;
      pc.forEach((path) => {
        pathCollection.push(path);
      });
    });
  }

  return { values, pathCollection, callerEnv, runtimeArgExprsInOrder };
}
