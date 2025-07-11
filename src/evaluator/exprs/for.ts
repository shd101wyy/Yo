import { Environment, Variable } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import {
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  createUsizeType,
  isArrayType,
  isLinearOrType0Type,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isSliceType,
  isUnitType,
  TypeTag,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  createNumberValue,
  createUnknownValue,
  isArrayValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import { evaluateBeginExpression } from "./begin";

/**
 * For loop works for Array or Slice
 *
 * for <Array value>, <element value> => body
 * for <Array value>, (<element value>,) => body
 * for <Array value>, (<element value>, <element index>) => body
 */
export function evaluateFor({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.for, 2);
  expectExprToBeFunctionCallOf(expr.args[1]!, "=>", 2);

  const itemsExpr: Expr = expr.args[0]!;
  const arrowExpr: Expr = expr.args[1]!;
  if (!exprIsFunctionCall(arrowExpr)) {
    throw formatErrorMessage({
      token: arrowExpr.token,
      errorMessage: `Expected the second argument of 'for' to be =>, got:\n${exprToString(arrowExpr)}`,
    });
  }
  const bindingExpr: Expr = arrowExpr.args[0]!;
  const bodyExpr: Expr = arrowExpr.args[1]!;

  // Evaluate the itemsValue expression
  const evaluatedItemsExpr = context.evaluateExpression({
    expr: itemsExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedItemsExpr.$) {
    throw formatErrorMessage({
      token: evaluatedItemsExpr.token,
      errorMessage: `Failed to evaluate the Array value expression:\n${exprToString(evaluatedItemsExpr)}`,
    });
  }
  env = evaluatedItemsExpr.$.env;

  let itemsType = evaluatedItemsExpr.$.type;

  // Check if it's a pointer/reference type
  // If yes, then automatically dereference one-level of it.
  let itemsPtrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | undefined = undefined;
  let isItemsMutable = true;

  if (
    isPtrType(itemsType) ||
    isMutPtrType(itemsType) ||
    isRefType(itemsType) ||
    isMutRefType(itemsType)
  ) {
    itemsPtrOrRefType = itemsType.tag;
    itemsType = itemsType.type; // Dereference one level

    if (
      itemsPtrOrRefType === TypeTag.Ptr ||
      itemsPtrOrRefType === TypeTag.Ref
    ) {
      isItemsMutable = false;
    }
  }

  if (!isArrayType(itemsType) && !isSliceType(itemsType)) {
    throw formatErrorMessage({
      token: evaluatedItemsExpr.token,
      errorMessage: `Expected Array or Slice type for expression, got:\n${exprToString(
        evaluatedItemsExpr
      )}`,
    });
  }

  // Set the array value as consumed
  setExprAsConsumed(evaluatedItemsExpr, env, context);

  let elementVariableExpr: Expr | undefined;
  let elementIndexExpr: Expr | undefined;
  let isElementVariableMutable = false;
  let itemPtrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | undefined = undefined;

  if (exprIsAtom(bindingExpr)) {
    elementVariableExpr = bindingExpr;
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.mut)
  ) {
    isElementVariableMutable = true;
    elementVariableExpr = bindingExpr.args[0];
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.Ptr) ||
      exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutPtr) ||
      exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.Ref) ||
      exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutRef))
  ) {
    elementVariableExpr = bindingExpr.args[0];
    if (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.Ptr)) {
      itemPtrOrRefType = TypeTag.Ptr;
    } else if (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutPtr)) {
      itemPtrOrRefType = TypeTag.MutPtr;
    } else if (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.Ref)) {
      itemPtrOrRefType = TypeTag.Ref;
    } else if (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutRef)) {
      itemPtrOrRefType = TypeTag.MutRef;
    }

    if (
      !isItemsMutable &&
      (exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutPtr) ||
        exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.MutRef))
    ) {
      // If the items are not mutable, we cannot use MutPtr or MutRef
      throw formatErrorMessage({
        token: bindingExpr.token,
        errorMessage: `Cannot use &! or *! for immutable items, got:\n${exprToString(bindingExpr)}`,
      });
    }
  } else {
    if (!exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.tuple)) {
      throw formatErrorMessage({
        token: bindingExpr.token,
        errorMessage: `Expected the binding expression to be a variable or a tuple, got:\n${exprToString(bindingExpr)}`,
      });
    }
    elementVariableExpr = bindingExpr.args[0];
    elementIndexExpr = bindingExpr.args[1];

    if (
      exprIsFunctionCall(elementVariableExpr) &&
      exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.mut)
    ) {
      isElementVariableMutable = true;
      elementVariableExpr = elementVariableExpr.args[0];
    } else if (
      exprIsFunctionCall(elementVariableExpr) &&
      (exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.Ptr) ||
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutPtr) ||
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.Ref) ||
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutRef))
    ) {
      if (exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.Ptr)) {
        itemPtrOrRefType = TypeTag.Ptr;
      } else if (
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutPtr)
      ) {
        itemPtrOrRefType = TypeTag.MutPtr;
      } else if (
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.Ref)
      ) {
        itemPtrOrRefType = TypeTag.Ref;
      } else if (
        exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutRef)
      ) {
        itemPtrOrRefType = TypeTag.MutRef;
      }

      if (
        !isItemsMutable &&
        (exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutPtr) ||
          exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.MutRef))
      ) {
        // If the items are not mutable, we cannot use MutPtr or MutRef
        throw formatErrorMessage({
          token: elementVariableExpr.token,
          errorMessage: `Cannot use &! or *! for immutable items, got:\n${exprToString(
            elementVariableExpr
          )}`,
        });
      }

      elementVariableExpr = elementVariableExpr.args[0];
    }
  }
  if (!elementVariableExpr) {
    throw formatErrorMessage({
      token: bindingExpr.token,
      errorMessage: `Expected the binding expression to have at least one element, got:\n${exprToString(bindingExpr)}`,
    });
  }

  // Expect the elementValueExpr to be a variable
  if (!isValidVariableName(elementVariableExpr)) {
    throw formatErrorMessage({
      token: elementVariableExpr.token,
      errorMessage: `Invalid variable name, got:\n${exprToString(
        elementVariableExpr
      )}`,
    });
  }
  // Expect the elementIndexExpr to be a variable or undefined
  if (elementIndexExpr && !isValidVariableName(elementIndexExpr)) {
    throw formatErrorMessage({
      token: elementIndexExpr.token,
      errorMessage: `Invalid variable name for element index, got:\n${exprToString(
        elementIndexExpr
      )}`,
    });
  }

  // Add the elementVariable and index to the environment
  const elementVariableName = elementVariableExpr.token.value;
  const elementIndexName = elementIndexExpr
    ? elementIndexExpr.token.value
    : undefined;

  let itemType = itemsType.elementType;
  if (itemPtrOrRefType) {
    if (itemPtrOrRefType === TypeTag.Ptr) {
      itemType = createPtrType(itemType);
    } else if (itemPtrOrRefType === TypeTag.MutPtr) {
      itemType = createMutPtrType(itemType);
    } else if (itemPtrOrRefType === TypeTag.Ref) {
      itemType = createRefType(itemType);
    } else if (itemPtrOrRefType === TypeTag.MutRef) {
      itemType = createMutRefType(itemType);
    }
  } else {
    // Check if we are extracting linear value from slice
    // If yes then report error
    if (itemsPtrOrRefType && isLinearOrType0Type(itemType)) {
      throw formatErrorMessage({
        token: elementVariableExpr.token,
        errorMessage: `Cannot extract linear or type0 value from a slice, got:\n${exprToString(
          elementVariableExpr
        )}`,
      });
    }
  }

  // Add type information to the element variable expr
  elementVariableExpr.$ = {
    type: itemType,
    isMutable: isElementVariableMutable,
    env,
    value: evaluatedItemsExpr.$.value
      ? createUnknownValue(itemType, elementVariableName)
      : undefined,
    pathCollection: [],
  };

  if (elementIndexName) {
    /// Add type information to the element index variable expr
    elementIndexExpr!.$ = {
      type: createUsizeType(),
      isMutable: false, // The index variable is immutable
      env,
      value: evaluatedItemsExpr.$.value
        ? createUnknownValue(createUsizeType(), elementIndexName) // Initialize it to 0
        : undefined,
      pathCollection: [],
    };
  }

  // Get the array value
  const itemsValue = evaluatedItemsExpr.$.value;
  let index = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isArrayValue(itemsValue)) {
      if (index >= itemsValue.elements.length) {
        break; // Exit the loop if we have iterated through all elements
      }
    } else if (index === 1) {
      break; // We need to evaluate the body at least once
    }

    const variables: Omit<Variable, "frameLevel" | "id">[] = [];
    // Add item to variables
    variables.push({
      name: elementVariableName,
      type: itemType,
      isMutable: isElementVariableMutable,
      consumedAtToken: undefined,
      initializedAtToken: elementVariableExpr.token,
      isCompileTimeOnly: Boolean(evaluatedItemsExpr.$.value),
      isImplicit: false, // Not an implicit variable
      token: elementVariableExpr.token,

      // TODO: Support reference value
      value: isArrayValue(itemsValue) ? itemsValue.elements[index]! : undefined, // Set the value to the current element
    });
    // Add index to variables if it exists
    if (elementIndexExpr && elementIndexName) {
      variables.push({
        name: elementIndexName,
        type: createUsizeType(),
        isMutable: false, // The index variable is immutable
        consumedAtToken: undefined,
        initializedAtToken: elementIndexExpr!.token,
        isCompileTimeOnly: Boolean(evaluatedItemsExpr.$.value), // Not a compile-time only variable
        isImplicit: false, // Not an implicit variable
        token: elementIndexExpr!.token,
        value: createNumberValue(ValueTag.Usize, index), // Set the value to the current index
      });
    }

    // Evaluate the body
    const evaluatedBodyExpr = evaluateBeginExpression({
      expr: bodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingLoopBody: { kind: "for", env }, // Indicate that we are evaluating a for loop
      },
      variablesToAdd: variables,
    });
    if (!evaluatedBodyExpr.$) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`,
      });
    }
    env = evaluatedBodyExpr.$.env;

    // Check if it has control flow (return, break, continue)
    const controlFlow = evaluatedBodyExpr.$.controlFlow;
    if (controlFlow) {
      if (controlFlow === "return") {
        // Guaranteed that we meet "return"
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          isMutable: evaluatedBodyExpr.$.isMutable,
          pathCollection: evaluatedBodyExpr.$.pathCollection,
          type: evaluatedBodyExpr.$.type,
          value: evaluatedBodyExpr.$.value,
          controlFlow: controlFlow,
        };
        return expr; // Return the result of the for loop
      } else if (controlFlow === "break") {
        // Break exits the loop, return unit
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          isMutable: false,
          pathCollection: [],
          type: VUnit.type,
          value: VUnit,
        };
        return expr; // Return the result of the for loop
      } else if (controlFlow === "continue") {
        index = index + 1;
        continue;
      }
    } else {
      // The for loop body should return unit
      if (!isUnitType(evaluatedBodyExpr.$.type)) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected the for loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`,
        });
      }
    }
    index = index + 1;
  }

  // Finish the loop
  expr.$ = {
    env: env,
    isMutable: false,
    pathCollection: [],
    type: VUnit.type,
    value: VUnit,
  };
  return expr;
}
