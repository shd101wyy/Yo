import { Borrowing, checkBorrowings } from "../../borrow";
import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  FunctionType,
  isFunctionClosureType,
  isFunctionType,
  isMutRefType,
  isRefType,
  MutRefType,
  RefType,
  typeToString,
} from "../../types";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import { evaluateBeginExpression } from "./begin";

/*
  eg:
    borrow((borrowed_values), (borrow_bindings)=> {
      let y = x_ref.*;
      y + 1
    });

  Where
    - (borrowed_values) are the expressions being borrowed from,
    - (borrow_bindings) are the parameter names for the borrowed references,
    - { ... } is the borrow_scope or borrow_block.
  */
export function evaluateBorrow({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.borrow, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "borrow" with 2 arguments, got:\n${exprToString(expr)}`,
    });
  }

  const firstExpr = expr.args[0]!;
  const borrowedValueExprs: Expr[] = [];
  if (
    exprIsFunctionCall(firstExpr) &&
    exprIsFunctionCallOf(firstExpr, BuiltinKeywords.tuple)
  ) {
    borrowedValueExprs.push(...firstExpr.args);
  } else {
    borrowedValueExprs.push(firstExpr);
  }

  const secondExpr = expr.args[1]!;
  if (
    !exprIsFunctionCall(secondExpr) ||
    !exprIsFunctionCallOf(secondExpr, "=>", 2)
  ) {
    throw formatErrorMessage({
      token: secondExpr.token,
      errorMessage: `Expected "=>" with 2 arguments, got:\n${exprToString(secondExpr)}`,
    });
  }
  const borrowBindingExprs: Expr[] = [];
  if (
    exprIsFunctionCall(secondExpr.args[0]!) &&
    exprIsFunctionCallOf(secondExpr.args[0]!, BuiltinKeywords.tuple)
  ) {
    borrowBindingExprs.push(...secondExpr.args[0]!.args);
  } else {
    borrowBindingExprs.push(secondExpr.args[0]!);
  }
  const borrowBlockExpr = secondExpr.args[1]!;

  if (borrowedValueExprs.length !== borrowBindingExprs.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Borrowed ${borrowedValueExprs.length} references, but used ${borrowBindingExprs.length}.`,
    });
  }

  // Evaluate each borrow arguments
  const borrowings: Borrowing[] = [];
  for (let i = 0; i < borrowedValueExprs.length; i++) {
    const borrowedValueExpr = borrowedValueExprs[i]!;
    const evaluatedBorrowedValueExpr = context.evaluateExpression({
      expr: borrowedValueExpr,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
        borrowings: [...context.borrowings, ...borrowings],
      },
    });
    if (!evaluatedBorrowedValueExpr.$) {
      throw formatErrorMessage({
        token: borrowedValueExpr.token,
        errorMessage: `Failed to evaluate the borrowed value:\n${exprToString(
          borrowedValueExpr
        )}`,
      });
    }

    // Check if it's a reference type
    if (
      !isRefType(evaluatedBorrowedValueExpr.$.type) &&
      !isMutRefType(evaluatedBorrowedValueExpr.$.type) &&
      // Note: Closure types are treated as references, because closures can capture variables by reference
      !isFunctionClosureType(evaluatedBorrowedValueExpr.$.type)
    ) {
      throw formatErrorMessage({
        token: borrowedValueExpr.token,
        errorMessage: `Expected reference type for borrowed value, got:\n${typeToString(
          evaluatedBorrowedValueExpr.$.type
        )}`,
      });
    }

    // For closure types, ensure closureKind is defined
    const borrowedType = evaluatedBorrowedValueExpr.$.type;
    if (isFunctionType(borrowedType) && !borrowedType.closureKind) {
      throw formatErrorMessage({
        token: borrowedValueExpr.token,
        errorMessage: `Cannot borrow regular function type - only closure types (Fn, FnMut, FnOnce) can be borrowed`,
      });
    }

    borrowings.push({
      expr: evaluatedBorrowedValueExpr,
      type: borrowedType as
        | RefType
        | MutRefType
        | (FunctionType & { closureKind: "Fn" | "FnMut" | "FnOnce" }),
      pathCollection: evaluatedBorrowedValueExpr.$.pathCollection,
    });
    checkBorrowings([...context.borrowings, ...borrowings]);
  }

  // Add the borrow bindings to the env
  env = pushEnvFrame(env);
  for (let i = 0; i < borrowBindingExprs.length; i++) {
    const bindingExpr = borrowBindingExprs[i]!;
    if (!exprIsAtom(bindingExpr) || !isValidVariableName(bindingExpr)) {
      throw formatErrorMessage({
        token: bindingExpr.token,
        errorMessage: `Expected identifier for borrow binding, got:\n${exprToString(
          bindingExpr
        )}`,
      });
    }
    const bindingName = bindingExpr.token.value;
    const borrowing = borrowings[i]!;
    // Add the binding to the env
    // console.log("(16) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: bindingName,
        type: borrowing.type,
        isMutable: isMutRefType(borrowing.type),
        isCompileTimeOnly: false,
        isImplicit: false,
        value: undefined, // borrowing.value,
        token: bindingExpr.token,
        initializedAtToken: bindingExpr.token,
        consumedAtToken: undefined,
      },
      skipCheckingFunctionOverloading: true,
    });
    env = nextEnv;

    // Add the info to the bindingExpr
    bindingExpr.$ = {
      env,
      type: borrowing.type,
      isMutable: isMutRefType(borrowing.type),
      pathCollection: borrowing.pathCollection,
      isAccessingProperty: false, // TODO: Set it to true if it's accessing a property
    };
  }

  // Evaluate the borrow block
  const evaluatedBorrowBlock = evaluateBeginExpression({
    expr: borrowBlockExpr,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
      borrowings: [...context.borrowings, ...borrowings],
    },
    variablesToAdd: [],
  });
  if (!evaluatedBorrowBlock.$) {
    throw formatErrorMessage({
      token: borrowBlockExpr.token,
      errorMessage: `Failed to evaluate the borrow block:\n${exprToString(borrowBlockExpr)}`,
    });
  }
  const returnType = evaluatedBorrowBlock.$.type;
  const returnValue = evaluatedBorrowBlock.$.value;
  env = evaluatedBorrowBlock.$.env;

  // Restore the env
  env = popEnvFrame(env);

  expr.$ = {
    env,
    type: returnType,
    value: returnValue,
    isMutable: evaluatedBorrowBlock.$.isMutable,
    pathCollection: evaluatedBorrowBlock.$.pathCollection,
    isAccessingProperty: evaluatedBorrowBlock.$.isAccessingProperty,
  };
  return expr;
}
