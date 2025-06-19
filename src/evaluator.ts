import { readFileSync } from "node:fs";
import path from "node:path";
import { Borrowing, checkBorrowings } from "./borrow";
import {
  addVariableToEnv,
  createNewEnv,
  Environment,
  getMethodsByNameFromEnv,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
  Variable,
} from "./env";
import { formatErrorMessage, MoParserError } from "./error";
import {
  AtomExpr,
  attachTempVariableToExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
  PathCollection,
  requireExprNotConsumed,
  setExprAsConsumed,
} from "./expr";
import { CalledComptFunctionCache, FunctionValue } from "./function-value";
import * as logger from "./logger";
import Parser from "./parser";
import { PlaceholderToken, stringIsOperator, Token, TokenType } from "./token";
import {
  areTypesCompatible,
  ArrayType,
  convertComptTypeToRuntimeType,
  createArrayType,
  createBooleanType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createEnumType,
  createExprListType,
  createExprType,
  createF32Type,
  createF64Type,
  createFreeType,
  createFunctionType,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIsizeType,
  createLinearType,
  createModuleType,
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  createStructType,
  createTupleType,
  createTypeType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUnionType,
  createUnitType,
  createUsizeType,
  EnumType,
  EnumVariant,
  FunctionParameter,
  FunctionType,
  getFunctionParameterExprs,
  getFunctionParameterToken,
  getValueOfSomeTypeFromEnv,
  isArrayType,
  isBooleanType,
  isComptIntType,
  isEnumType,
  isExprListType,
  isExprType,
  isFreeType,
  isFunctionType,
  isLinearOrType0Type,
  isLinearType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isUnionType,
  isUnitType,
  ModuleType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
  TupleElement,
  tupleElementToString,
  TupleType,
  Type,
  typeContainsReference,
  typeOfType,
  typeRequiresComptModifier,
  TypeTag,
  typeToString,
} from "./type-checker";
import { setTypeValueAsLinear, TypeValue } from "./type-value";
import { VUnit } from "./unit-value";
import { randomId } from "./utils";
import {
  areValuesEqual,
  ArrayValue,
  BooleanValue,
  createArrayValue,
  createBooleanValue,
  createComptIntValue,
  createComptStringValue,
  createEnumValue,
  createExprListValue,
  createExprValue,
  createModuleValue,
  createNumberValue,
  createStructValue,
  createTupleValue,
  createTypeValue,
  createUnknownValue,
  ExprValue,
  isBooleanValue,
  isComptIntValue,
  isComptStringValue,
  isEnumValue,
  isExprListValue,
  isExprValue,
  isFunctionValue,
  isModuleValue,
  isNumberValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  StructValue,
  TupleValue,
  UnknownValue,
  Value,
  valueToString,
} from "./value";
import { ValueTag } from "./value-tag";

interface EvaluatorContext {
  /**
   *
   */
  expectedType?: {
    type: Type;
    env: Environment;
  };

  /**
   * This is used for calling the `recur` function.
   */
  isEvaluatingFunctionBody?: {
    type: FunctionType;
    value?: FunctionValue;
  };

  /**
   * The innermost struct, enum, or union that this function call is inside.
   * This can be useful for an anonymous struct that needs to refer to itself
   */
  SelfType?: Type;

  /**
   * The innermost module that this function call is inside.
   */
  ModuleType?: ModuleType;

  /**
   * The borrowings.
   */
  borrowings: Borrowing[];
}

interface ArgValues {
  forallArgs: Value[];
  args: (Value | undefined)[];
  implicitArgs: (Value | undefined)[];
}

interface FunctionCallResult {
  calleeEnv: Environment;
  callerEnv: Environment;
  pathCollection: PathCollection;
  returnType: Type;
  argValues: ArgValues;
}

interface TypeCallResult {
  values: (Value | undefined)[];
  pathCollection: PathCollection;
  callerEnv: Environment;
}

interface ModuleTypeCallResult {
  moduleValue: ModuleValue;
  callerEnv: Environment;
}

interface ArrayCallResult {
  value: Value | undefined;
}

interface FunctionToCall {
  type: Type;
  value?: Value;
  result:
    | {
        /**
         * This is the result from calling:
         *
         *   this.tryToCallFunctionWithArguments
         */
        kind: "function";
        result: FunctionCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   this.tryToCallTypeWithArguments
         */
        kind: "type";
        result: TypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   this.tryToImplementFunctionByFunctionType
         */
        kind: "function-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   this.tryToImplementModuleWithArguments
         */
        kind: "module-type";
        result: ModuleTypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   this.tryToCallArrayWithArguments
         */
        kind: "array";
        result: ArrayCallResult;
      }
    | {
        kind: "error";
        error: Error | MoParserError;
      };
}

function getFunctionCallResult(
  functionToCall: FunctionToCall
): FunctionCallResult {
  if (functionToCall.result.kind !== "function") {
    throw new Error(
      `Expected function call result, got ${functionToCall.result.kind}`
    );
  }
  return functionToCall.result.result;
}

function getTypeCallResult(functionToCall: FunctionToCall): TypeCallResult {
  if (functionToCall.result.kind !== "type") {
    throw new Error(
      `Expected type call result, got ${functionToCall.result.kind}`
    );
  }
  return functionToCall.result.result;
}

function getModuleTypeCallResult(
  functionToCall: FunctionToCall
): ModuleTypeCallResult {
  if (functionToCall.result.kind !== "module-type") {
    throw new Error(
      `Expected module type call result, got ${functionToCall.result.kind}`
    );
  }
  return functionToCall.result.result;
}

function getArrayCallResult(functionToCall: FunctionToCall): ArrayCallResult {
  if (functionToCall.result.kind !== "array") {
    throw new Error(
      `Expected array call result, got ${functionToCall.result.kind}`
    );
  }
  return functionToCall.result.result;
}

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private stdPath: string;
  private parser: Parser;
  private program: Expr[];
  private tokens: Token[];
  private moduleValue: ModuleValue;
  private moduleError: Error | undefined;
  private loadModule: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };

  constructor({
    modulePath,
    stdPath,
    loadModule,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: (modulePath: string) => {
      moduleValue: ModuleValue;
      moduleError: Error | undefined;
    };
  }) {
    this.modulePath = modulePath;
    this.stdPath = stdPath;
    this.loadModule = loadModule;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }
    try {
      this.inputString = readFileSync(
        modulePath.replace(/^file:\/\//, ""), // NOTE: We only support local file for now
        "utf-8"
      );

      // Parse the module
      this.parser = new Parser({ modulePath, inputString: this.inputString });
      this.program = this.parser.getProgram();
      this.tokens = this.parser.getTokens();

      // Evaluate the program
      this.evaluateProgram();
    } catch (error) {
      throw new Error(
        `Failed to import module "${modulePath}":\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
  }

  // Add a public method to get the tokens
  public getTokens(): Token[] {
    return this.tokens;
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
    });
  }

  private expectExprToBeFunctionCallOf(
    expr: Expr,
    expectedFunctionName: string | string[],
    expectedArgCount?: number
  ) {
    if (!exprIsFunctionCall(expr)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected function call, got atom:\n${exprToString(expr)}`
      );
    }
    if (!exprIsFunctionCallOf(expr, expectedFunctionName)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected function call of ${Array.isArray(expectedFunctionName) ? expectedFunctionName.map((fn) => `"${fn}"`).join(" or ") : `"${expectedFunctionName}"`}, got:\n${exprToString(expr)}`
      );
    }

    if (
      expectedArgCount !== undefined &&
      expr.args.length !== expectedArgCount
    ) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected ${expectedArgCount} arguments, got ${expr.args.length}:\n${exprToString(
          expr
        )}`
      );
    }
  }

  private evaluateIntegerLiteral(expr: AtomExpr, env: Environment): AtomExpr {
    if (expr.token.type === TokenType.Integer) {
      const integerValue = parseInt(expr.token.value, 10);
      const value = createNumberValue(ValueTag.ComptInt, integerValue);
      expr.$ = {
        env,
        value,
        type: value.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected integer literal, got ${expr.tag}`
      );
    }
  }

  private evaluateFloatLiteral(expr: AtomExpr, env: Environment): AtomExpr {
    if (expr.token.type === TokenType.Float) {
      const floatValue = parseFloat(expr.token.value);
      const value = createNumberValue(ValueTag.ComptFloat, floatValue);
      expr.$ = {
        env,
        value,
        type: value.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected float literal, got ${expr.tag}`
      );
    }
  }

  private evaluateStringLiteral(expr: AtomExpr, env: Environment): AtomExpr {
    if (expr.token.type === TokenType.String) {
      const value = createComptStringValue(JSON.parse(expr.token.value));
      expr.$ = {
        env,
        value,
        type: value.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected string literal, got ${expr.tag}`
      );
    }
  }

  private evaluateBooleanLiteral(expr: AtomExpr, env: Environment): AtomExpr {
    if (expr.token.type === TokenType.Boolean) {
      const booleanValue = expr.token.value === "true";
      const value: Value = createBooleanValue(booleanValue);
      expr.$ = {
        env,
        value,
        type: value.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected boolean literal, got ${expr.tag}`
      );
    }
  }

  private evaluateTupleValue({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected tuple, got ${expr.tag}`
      );
    }

    if (expr.args.length === 0) {
      // Unit
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }

    const {
      type: tupleType,
      value: tupleValue,
      env: nextEnv,
    } = this.evaluateTupleElementsValue({ args: expr.args, env, context });
    env = nextEnv;

    // We disallow the tuple elements to have defaultValue for the tuple type
    // We disallow the tuple value to have labels. Only the tuple type can have labels.
    tupleType.elements.forEach((tupleElement) => {
      if (tupleElement.exprs.defaultValueExpr) {
        throw this.formatErrorMessage(
          tupleElement.exprs.defaultValueExpr!.token,
          `Tuple type cannot have default value.`
        );
      }

      if (tupleElement.exprs.labelExpr) {
        throw this.formatErrorMessage(
          tupleElement.exprs.labelExpr!.token,
          `Tuple value cannot have labels.`
        );
      }
    });

    expr.$ = {
      env,
      value: tupleValue,
      type: tupleType,
      isMutable: true,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateArrayValue({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const arrayElementExprs = expr.args;

    // NOTE: We disallow the empty array for now.
    if (arrayElementExprs.length === 0) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least one element in array, got ${arrayElementExprs.length}`
      );
    }

    const arrayLength = arrayElementExprs.length;
    let arrayElementType: Type | undefined = undefined;
    const arrayElementValues: (Value | undefined)[] = [];
    for (let i = 0; i < arrayElementExprs.length; i++) {
      const arrayElementExpr = arrayElementExprs[i]!;
      const evaluatedElement = this.evaluateExpression({
        expr: arrayElementExpr,
        env,
        context: {
          ...context,
        },
      });

      if (!evaluatedElement.$) {
        throw this.formatErrorMessage(
          arrayElementExpr.token,
          `Failed to evaluate array element: ${exprToString(arrayElementExpr)}`
        );
      }
      env = evaluatedElement.$.env;

      // Set the evaluatedElement as consumed
      env = setExprAsConsumed(evaluatedElement, env);

      // Save value
      arrayElementValues.push(evaluatedElement.$.value);

      // Check type
      if (!arrayElementType) {
        arrayElementType = evaluatedElement.$.type;
      } else {
        // Check if the type of the element matches the first element type
        if (
          !areTypesCompatible(
            { type: arrayElementType, env },
            { type: evaluatedElement.$.type, env }
          )
        ) {
          // Check if types match when converting to runtime type.
          // For example:
          //    x := 12; // x: i32
          //    arr := [1, x, 3];
          //    -  1: compt_int
          //    -  x: i32
          //    Here we convert compt_int to i32 to check compatibility.
          if (
            areTypesCompatible(
              {
                type: convertComptTypeToRuntimeType(arrayElementType),
                env,
              },
              {
                type: evaluatedElement.$.type,
                env,
              }
            )
          ) {
            arrayElementType = evaluatedElement.$.type;
          } else {
            throw this.formatErrorMessage(
              arrayElementExpr.token,
              `Array element type mismatch:
Expected type: ${typeToString(arrayElementType)}
Given type: ${typeToString(evaluatedElement.$.type)}`
            );
          }
        }
      }
    }

    const arrayType = createArrayType(
      arrayElementType!,
      createNumberValue(ValueTag.Usize, arrayLength)
    );

    const arrayValue = arrayElementValues.every((val) => !!val)
      ? createArrayValue(arrayType, arrayElementValues as Value[])
      : undefined;

    expr.$ = {
      env,
      type: arrayType,
      value: arrayValue,
      isMutable: true,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateExprListValue({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const elements: (ExprValue | UnknownValue)[] = [];
    const args = expr.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const evaluatedArg = this.evaluateExpression({
        expr: arg,
        env,
        context: {
          ...context,
        },
      });
      if (
        !evaluatedArg.$ ||
        !isExprType(evaluatedArg.$.type) ||
        !evaluatedArg.$.value
      ) {
        throw this.formatErrorMessage(
          arg.token,
          `Failed to evaluate expr_list element. Expected compile-time known expr value:\n${exprToString(arg)}`
        );
      }
      env = evaluatedArg.$.env;
      const value = evaluatedArg.$.value;

      if (
        isExprValue(value) ||
        (isUnknownValue(value) && isExprType(value.type))
      ) {
        elements.push(value);
      } else {
        throw this.formatErrorMessage(
          arg.token,
          `Expected compile-time known expr value, got ${valueToString(value)}`
        );
      }
    }

    const exprListValue = createExprListValue(elements);
    expr.$ = {
      env,
      type: exprListValue.type,
      value: exprListValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /**
   * Evaluate the element in tuple rvalue
   *
   * type:
   * i32 in (i32, ...)
   * (x: i32) in (x: i32, ...)
   */
  private evaluateTupleElementType({
    expr,
    tupleElementIndex,
    env,
    context,
    forType,
  }: {
    expr: Expr;
    tupleElementIndex: number;
    env: Environment;
    context: EvaluatorContext;
    forType: "tuple" | "struct" | "enum" | "union";
  }): { type: TupleElement; env: Environment } {
    let label: string | undefined = undefined;
    let expr_ = expr;

    let labelExpr: Expr | undefined = undefined;
    let typeExpr: Expr | undefined = undefined;

    let defaultValueExpr: Expr | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    let assignedValueExpr: Expr | undefined = undefined;
    let assignedValue: Value | undefined = undefined;

    let isCompileTimeOnly = false;
    let isImplicit = false;

    let elementType: Type | undefined = undefined;

    // Check the default value
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
      defaultValueExpr = expr.args[1]!;
      expr_ = expr.args[0]!;
    }

    // Check the assigned value
    if (
      exprIsFunctionCall(expr_) &&
      (exprIsFunctionCallOf(expr_, "=", 2) ||
        exprIsFunctionCallOf(expr_, "::", 2))
    ) {
      if (exprIsFunctionCallOf(expr_, "::", 2)) {
        isCompileTimeOnly = true;

        labelExpr = expr_.args[0]!;

        // Check isImplicit
        if (
          exprIsFunctionCall(labelExpr) &&
          exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
        ) {
          isImplicit = true;
          labelExpr = labelExpr.args[0]!;
        }

        if (!this.isValidVariableName(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for tuple element label, got ${exprToString(
              labelExpr
            )}`
          );
        }
        label = labelExpr.token.value;
      }

      assignedValueExpr = expr_.args[1]!;
      expr_ = expr_.args[0]!;
    }

    // Cannot have both defaultValueExpr and assignedValueExpr
    if (defaultValueExpr && assignedValueExpr) {
      throw this.formatErrorMessage(
        expr.token,
        `Cannot have both default value and required value for tuple element.`
      );
    }

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      labelExpr = expr_.args[0]!;
      typeExpr = expr_.args[1]!;

      // Check if it's compile-time only
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.compt, 1)
      ) {
        if (isCompileTimeOnly) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Cannot combine the use of "compt" (or "@") with ::`
          );
        }
        isCompileTimeOnly = true;
        labelExpr = labelExpr.args[0]!;
      }

      // Check isImplicit
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

      if (!exprIsAtom(labelExpr) && !this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`
        );
      }
      label = labelExpr.token.value;
    } else if (
      exprIsFunctionCall(expr_) &&
      exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
    ) {
      if (isCompileTimeOnly) {
        throw this.formatErrorMessage(
          expr_.token,
          `Cannot combine the use of "compt" (or "@") with "::"`
        );
      }

      isCompileTimeOnly = true;
      labelExpr = expr_.args[0]!;

      // Check isImplicit
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

      // Check if labelExpr is an atom
      if (!exprIsAtom(labelExpr) && !this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`
        );
      }
      label = labelExpr.token.value;
    } else if (!defaultValueExpr && !assignedValueExpr) {
      // Prevent the case such as:
      //   Self :: i32
      // typeExpr shouldn't be "Self"
      typeExpr = expr_;
    }

    // Check expectedType
    const expectedType = context.expectedType?.type;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedType) {
      if (
        isTupleType(expectedType) ||
        isStructType(expectedType) ||
        isModuleType(expectedType)
      ) {
        const tupleElement = expectedType.elements[tupleElementIndex];
        if (!tupleElement) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to get the field at index ${tupleElementIndex}`
          );
        }

        expectedTupleElementType = tupleElement.type;
      } else {
        /*
        throw this.formatErrorMessage(
          expr.token,
          `(1) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedType)}`
        );
        */
        // NOTE: Don't throw error here
      }
    }

    // Parse the type expr
    if (typeExpr) {
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          expectedType: expectedTupleElementType
            ? {
                type: expectedTupleElementType,
                env,
              }
            : undefined,
        },
      });
      if (evaluatedTypeExpr.$?.env) {
        env = evaluatedTypeExpr.$?.env;
      }

      // Expected the evaluatedTypeExpr to be a type
      const typeValue = evaluatedTypeExpr.$?.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `(1) Expected type for tuple element, got ${exprToString(typeExpr)}`
        );
      }
      elementType = typeValue.value;
    }

    // Evaluate assignedValueExpr if it exists
    if (assignedValueExpr) {
      // Assigned value only works for compile-time only
      if (!isCompileTimeOnly) {
        throw this.formatErrorMessage(
          assignedValueExpr.token,
          `Assigned value expression is only allowed for compile-time only.
Please consider adding "compt" (or "@") modifier to the field label.`
        );
      }

      const expectedType = elementType
        ? { type: elementType, env }
        : expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined;
      const evaluatedAssignedValueExpr = this.evaluateExpression({
        expr: assignedValueExpr,
        env,
        context: {
          ...context,
          expectedType: expectedType,
        },
      });
      if (!evaluatedAssignedValueExpr.$) {
        throw this.formatErrorMessage(
          assignedValueExpr.token,
          `Failed to evaluate required value expression: ${exprToString(
            assignedValueExpr
          )}`
        );
      }
      env = evaluatedAssignedValueExpr.$?.env;

      assignedValue = evaluatedAssignedValueExpr.$.value;
      if (!assignedValue) {
        throw this.formatErrorMessage(
          assignedValueExpr.token,
          `Expected compile-time known value for required value, got ${exprToString(
            assignedValueExpr
          )}`
        );
      }

      const assignedValueType = evaluatedAssignedValueExpr.$.type;

      // Check if assignedValueType matches expectedType
      if (expectedType) {
        if (
          !areTypesCompatible(
            { type: expectedType.type, env },
            { type: assignedValueType, env }
          )
        ) {
          throw this.formatErrorMessage(
            assignedValueExpr.token,
            `Assigned value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(assignedValueType)}`
          );
        }
        elementType = expectedType.type;
      } else {
        elementType = assignedValueType;
      }
    }

    // Evaluate defaultValueExpr if it exists
    if (defaultValueExpr) {
      const expectedType = elementType
        ? { type: elementType, env }
        : expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined;
      const evaluatedDefaultValueExpr = this.evaluateExpression({
        expr: defaultValueExpr,
        env,
        context: {
          ...context,
          expectedType: expectedType,
        },
      });
      if (!evaluatedDefaultValueExpr.$) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Failed to evaluate default value expression: ${exprToString(
            defaultValueExpr
          )}`
        );
      }
      env = evaluatedDefaultValueExpr.$.env;

      defaultValue = evaluatedDefaultValueExpr.$?.value;
      if (!defaultValue) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Expected compile-time known value for default value, got ${exprToString(
            defaultValueExpr
          )}`
        );
      }

      const defaultValueType = evaluatedDefaultValueExpr.$.type;

      // Check if defaultValueType matches expectedType
      if (expectedType) {
        if (
          !areTypesCompatible(
            { type: expectedType.type, env },
            { type: defaultValueType, env }
          )
        ) {
          throw this.formatErrorMessage(
            defaultValueExpr.token,
            `Default value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(defaultValueType)}`
          );
        }
        elementType = expectedType.type;
      } else {
        elementType = defaultValueType;
      }
    }

    if (!elementType) {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to infer the element type`
      );
    }

    if (typeRequiresComptModifier(elementType) && !isCompileTimeOnly) {
      elementType = convertComptTypeToRuntimeType(elementType);
      if (typeRequiresComptModifier(elementType)) {
        throw this.formatErrorMessage(
          labelExpr?.token ?? expr.token,
          `Expected "compt" (or "@") modifier for compile-time known value binding.`
        );
      }
    }

    if (forType !== "tuple" && !labelExpr) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected label for ${forType} field, got ${exprToString(expr_)}`
      );
    }

    if (labelExpr) {
      labelExpr.$ = {
        env,
        type: elementType,
        isMutable: false,
        pathCollection: [],
      };
    }

    if (expr !== typeExpr) {
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };
    }

    return {
      type: {
        label: label ?? `$element_${randomId()}`,
        type: elementType,
        exprs: {
          expr,
          labelExpr,
          typeExpr,
          defaultValueExpr,
          assignedValueExpr,
        },
        isCompileTimeOnly,
        isImplicit,
        defaultValue,
        assignedValue,
      },
      env,
    };
  }

  /**
   * Evaluate the element in module rvalue
   *
   * type:
   * (x: i32) in module(x: i32, ...)
   *
   * All fields in module are compile-time only by default.
   */
  private evaluateModuleElementType({
    expr,
    tupleElementIndex,
    env,
    context,
  }: {
    expr: Expr;
    tupleElementIndex: number;
    env: Environment;
    context: EvaluatorContext;
  }): { type: TupleElement; env: Environment } {
    let label: string | undefined = undefined;
    let expr_ = expr;

    let labelExpr: Expr | undefined = undefined;
    let typeExpr: Expr | undefined = undefined;

    let defaultValueExpr: Expr | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    let assignedValueExpr: Expr | undefined = undefined;
    let assignedValue: Value | undefined = undefined;

    let isImplicit = false;

    let elementType: Type | undefined = undefined;

    // Check the default value
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
      defaultValueExpr = expr.args[1]!;
      expr_ = expr.args[0]!;
    }

    // Check the assigned value
    if (
      exprIsFunctionCall(expr_) &&
      (exprIsFunctionCallOf(expr_, "=", 2) ||
        exprIsFunctionCallOf(expr_, "::", 2) ||
        exprIsFunctionCallOf(expr_, ":=", 2))
    ) {
      if (exprIsFunctionCallOf(expr_, "::", 2)) {
        throw this.formatErrorMessage(
          expr_.token,
          `Cannot use "::" for module element. Use ":=" instead.
All module elements are compile-time only by default.`
        );
      }

      assignedValueExpr = expr_.args[1]!;
      expr_ = expr_.args[0]!;
    }

    // Cannot have both defaultValueExpr and assignedValueExpr
    if (defaultValueExpr && assignedValueExpr) {
      throw this.formatErrorMessage(
        expr.token,
        `Cannot have both default value and required value for tuple element.`
      );
    }

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      labelExpr = expr_.args[0]!;
      typeExpr = expr_.args[1]!;

      // Check if it's compile-time only
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.compt, 1)
      ) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`
        );
      }

      // Check isImplicit
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

      if (!exprIsAtom(labelExpr) && !this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`
        );
      }
      label = labelExpr.token.value;
    } else if (
      exprIsFunctionCall(expr_) &&
      exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
    ) {
      throw this.formatErrorMessage(
        expr_.token,
        `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`
      );
    } else if (!defaultValueExpr && !assignedValueExpr) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected label for module field, got ${exprToString(expr_)}`
      );
    } else {
      //  eg:
      //    Output ?= Self
      labelExpr = expr_;

      // Check isImplicit
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

      if (!this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`
        );
      }
      if (!exprIsAtom(labelExpr) && !this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`
        );
      }
      label = labelExpr.token.value;
    }

    // Check expectedType
    const expectedType = context.expectedType?.type;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedType) {
      if (isModuleType(expectedType)) {
        const tupleElement = expectedType.elements[tupleElementIndex];
        if (!tupleElement) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to get the field at index ${tupleElementIndex}`
          );
        }

        expectedTupleElementType = tupleElement.type;
      } else {
        /*
        throw this.formatErrorMessage(
          expr.token,
          `(1) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedType)}`
        );
        */
        // NOTE: Don't throw error here
      }
    }

    // Parse the type expr
    if (typeExpr) {
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          expectedType: expectedTupleElementType
            ? {
                type: expectedTupleElementType,
                env,
              }
            : undefined,
        },
      });
      if (evaluatedTypeExpr.$?.env) {
        env = evaluatedTypeExpr.$?.env;
      }

      // Expected the evaluatedTypeExpr to be a type
      const typeValue = evaluatedTypeExpr.$?.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `(1) Expected type for tuple element, got ${exprToString(typeExpr)}`
        );
      }
      elementType = typeValue.value;
    }

    // Evaluate assignedValueExpr if it exists
    if (assignedValueExpr) {
      const expectedType = elementType
        ? { type: elementType, env }
        : expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined;
      const evaluatedAssignedValueExpr = this.evaluateExpression({
        expr: assignedValueExpr,
        env,
        context: {
          ...context,
          expectedType: expectedType,
        },
      });
      if (!evaluatedAssignedValueExpr.$) {
        throw this.formatErrorMessage(
          assignedValueExpr.token,
          `Failed to evaluate required value expression: ${exprToString(
            assignedValueExpr
          )}`
        );
      }
      env = evaluatedAssignedValueExpr.$?.env;

      assignedValue = evaluatedAssignedValueExpr.$.value;
      if (!assignedValue) {
        throw this.formatErrorMessage(
          assignedValueExpr.token,
          `Expected compile-time known value for required value, got ${exprToString(
            assignedValueExpr
          )}`
        );
      }

      const assignedValueType = evaluatedAssignedValueExpr.$.type;

      // Check if assignedValueType matches expectedType
      if (expectedType) {
        if (
          !areTypesCompatible(
            { type: expectedType.type, env },
            { type: assignedValueType, env }
          )
        ) {
          throw this.formatErrorMessage(
            assignedValueExpr.token,
            `Assigned value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(assignedValueType)}`
          );
        }
        elementType = expectedType.type;
      } else {
        elementType = assignedValueType;
      }
    }

    // Evaluate defaultValueExpr if it exists
    if (defaultValueExpr) {
      const expectedType = elementType
        ? { type: elementType, env }
        : expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined;
      const evaluatedDefaultValueExpr = this.evaluateExpression({
        expr: defaultValueExpr,
        env,
        context: {
          ...context,
          expectedType: expectedType,
        },
      });
      if (!evaluatedDefaultValueExpr.$) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Failed to evaluate default value expression: ${exprToString(
            defaultValueExpr
          )}`
        );
      }
      env = evaluatedDefaultValueExpr.$.env;

      defaultValue = evaluatedDefaultValueExpr.$?.value;
      if (!defaultValue) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Expected compile-time known value for default value, got ${exprToString(
            defaultValueExpr
          )}`
        );
      }

      const defaultValueType = evaluatedDefaultValueExpr.$.type;

      // Check if defaultValueType matches expectedType
      if (expectedType) {
        if (
          !areTypesCompatible(
            { type: expectedType.type, env },
            { type: defaultValueType, env }
          )
        ) {
          throw this.formatErrorMessage(
            defaultValueExpr.token,
            `Default value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(defaultValueType)}`
          );
        }
        elementType = expectedType.type;
      } else {
        elementType = defaultValueType;
      }
    }

    if (!elementType) {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to infer the element type`
      );
    }

    /*
    if (typeRequiresComptModifier(elementType) && !isCompileTimeOnly) {
      elementType = convertComptTypeToRuntimeType(elementType);
      if (typeRequiresComptModifier(elementType)) {
        throw this.formatErrorMessage(
          labelExpr?.token ?? expr.token,
          `Expected "compt" (or "@") modifier for compile-time known value binding.`
        );
      }
    }
    */

    if (labelExpr) {
      labelExpr.$ = {
        env,
        type: elementType,
        isMutable: false,
        pathCollection: [],
      };
    }

    if (expr !== typeExpr) {
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };
    }

    return {
      type: {
        label: label ?? `$element_${randomId()}`,
        type: elementType,
        exprs: {
          expr,
          labelExpr,
          typeExpr,
          defaultValueExpr,
          assignedValueExpr,
        },
        isCompileTimeOnly: true,
        isImplicit,
        defaultValue,
        assignedValue,
      },
      env,
    };
  }

  /**
   * Evaluate the element in tuple rvalue, such as
   * value:
   * 14  in (14, ...)
   * (x: 16) in (x: 16, ...)
   *
   */
  private evaluateTupleElementValue({
    expr,
    tupleElementIndex,
    env,
    context,
  }: {
    expr: Expr;
    tupleElementIndex: number;
    env: Environment;
    context: EvaluatorContext;
  }): {
    type: TupleElement;
    value: Value | undefined;
    env: Environment;
  } {
    const expr_ = expr;
    const rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      const lhsExpr = expr_.args[0]!;

      throw this.formatErrorMessage(
        lhsExpr.token,
        `Labelled element is not allowed in tuple value.`
      );
    }

    // Check expectedType
    const expectedTupleType = context.expectedType?.type;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedTupleType) {
      if (!isTupleType(expectedTupleType)) {
        throw this.formatErrorMessage(
          expr.token,
          `(2) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedTupleType)}`
        );
      }
      const tupleElement = expectedTupleType.elements[tupleElementIndex];
      if (!tupleElement) {
        throw this.formatErrorMessage(
          expr.token,
          `Failed to get the tuple element at index ${tupleElementIndex}`
        );
      }
      expectedTupleElementType = tupleElement.type;
    }

    // Parse the rhs expr
    const evaluatedRhs = this.evaluateExpression({
      expr: rhsExpr,
      env,
      context: {
        ...context,
        expectedType: expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined,
      },
    });

    if (!evaluatedRhs.$) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Failed to evaluate the tuple element: ${exprToString(rhsExpr)}`
      );
    }
    env = evaluatedRhs.$.env;

    // Set the evaluatedRhs as consumed
    env = setExprAsConsumed(evaluatedRhs, env);

    const value = evaluatedRhs.$.value;
    if (value && isTypeValue(evaluatedRhs.$.value)) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Cannot store a type value in tuple, please use module instead:
  ${exprToString(rhsExpr)}`
      );
    }

    // Expected the evaluatedRhs to be a value
    elementType = evaluatedRhs.$.type;
    if (!elementType) {
      throw this.formatErrorMessage(
        evaluatedRhs.token,
        `Failed to evaluate the tuple element.`
      );
    }

    expr.$ = {
      env,
      type: elementType,
      value: value,
      isMutable: evaluatedRhs.$?.isMutable ?? false,
      pathCollection: [],
    };
    return {
      type: {
        exprs: {
          expr: expr,
          labelExpr: undefined,
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: undefined,
        },
        isCompileTimeOnly: false,
        isImplicit: false,
        type: elementType,
        label: `$element_${randomId()}`,
      },
      value,
      env,
    };
  }

  /**
   */
  private evaluateTupleElementsValue({
    args,
    env,
    context,
  }: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): {
    type: TupleType;
    value: TupleValue | undefined;
    env: Environment;
  } {
    const tupleElements: TupleElement[] = [];
    const tupleValues: (Value | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      const {
        type,
        value,
        env: nextEnv,
      } = this.evaluateTupleElementValue({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context },
      });

      tupleElements.push(type);
      tupleValues.push(value);
      env = nextEnv;
    }

    const tupleType: TupleType = createTupleType(tupleElements);
    const value: Value | undefined = tupleValues.some((v) => !v)
      ? // ^ Meaning some element value is not compile-time known.
        undefined
      : createTupleValue(tupleType, tupleValues as Value[]);

    return {
      type: tupleType,
      value,
      env,
    };
  }

  private evaluateTupleElementsType({
    args,
    env,
    context,
    forType,
  }: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
    forType: "tuple" | "struct" | "enum" | "union";
  }): {
    type: TupleType;
    env: Environment;
  } {
    const tupleElements: TupleElement[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      const { type, env: nextEnv } = this.evaluateTupleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context },
        forType,
      });

      // Check if there is duplicate labels
      if (type.label) {
        const duplicateLabel = tupleElements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            `Duplicate label "${type.label}" in tuple`
          );
        }
      }

      tupleElements.push(type);
      env = nextEnv;
    }

    const tupleType: TupleType = createTupleType(tupleElements);
    return {
      type: tupleType,
      env,
    };
  }

  /**
   * Check if the expr is either an identifier or an operator
   * @param expr
   * @returns
   */
  private isValidVariableName(expr: Expr): boolean {
    return (
      (exprIsAtom(expr) && expr.token.type === TokenType.Identifier) ||
      expr.token.type === TokenType.Operator
    );
  }

  /**
   * Synthesize the types, such as
   * compt(T): Type, i32  => T = i32
   */
  private synthesizeTypes(
    expected: {
      type: Type;
      env: Environment;
    },
    given: {
      type: Type;
      env: Environment;
    }
  ): { expectedEnv: Environment; givenEnv: Environment } {
    if (isSomeType(expected.type)) {
      // Check if the env has
      const type = getValueOfSomeTypeFromEnv(expected.env, expected.type);
      if (
        //type === expected.type
        isSomeType(type) &&
        type.name === expected.type.name
      ) {
        // Update the env to set givenType to expectedType.name
        const value = createTypeValue(given.type);
        // console.log("(1) addVariableToEnv");

        // Check if the same variable already exists in the env
        const existingVariables = getVariablesFromEnv(
          expected.env,
          expected.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: expected.env,
            variable: {
              name: expected.type.name,
              value: value,
              type: value.type,
              token: PlaceholderToken, // FIXME: What should be `token` here?
              isMutable: false,
              isCompileTimeOnly: true,
              isUndefined: false,
              isImplicit: false,
            },
          });
          expected.env = nextEnv;
        } else if (variable) {
          // Update existing
          expected.env = updateExistingVariable(expected.env, variable, {
            ...variable,
            value,
          });
        }
      }
    } else if (
      isTupleType(expected.type) &&
      isTupleType(given.type) &&
      expected.type.elements.length === given.type.elements.length
    ) {
      for (let i = 0; i < expected.type.elements.length; i++) {
        const { expectedEnv, givenEnv } = this.synthesizeTypes(
          { type: expected.type.elements[i]!.type, env: expected.env },
          { type: given.type.elements[i]!.type, env: given.env }
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    } else if (
      isStructType(expected.type) &&
      isStructType(given.type) &&
      (expected.type.typeId === given.type.typeId ||
        (expected.type.functionValue &&
          given.type.functionValue &&
          expected.type.functionValue === given.type.functionValue))
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
    ) {
      for (let i = 0; i < expected.type.elements.length; i++) {
        const expectedElement = expected.type.elements[i]!;
        const givenElement = given.type.elements[i]!;
        const { expectedEnv, givenEnv } = this.synthesizeTypes(
          { type: expectedElement.type, env: expected.env },
          { type: givenElement.type, env: given.env }
        );
        expected.env = expectedEnv;
        given.env = givenEnv;

        if (
          expectedElement.assignedValue &&
          givenElement.assignedValue &&
          isTypeValue(expectedElement.assignedValue) &&
          isTypeValue(givenElement.assignedValue)
        ) {
          const { expectedEnv, givenEnv } = this.synthesizeTypes(
            {
              type: expectedElement.assignedValue.value,
              env: expected.env,
            },
            {
              type: givenElement.assignedValue.value,
              env: given.env,
            }
          );
          expected.env = expectedEnv;
          given.env = givenEnv;
        }
      }
    } else if (
      isEnumType(expected.type) &&
      isEnumType(given.type) &&
      (expected.type.typeId === given.type.typeId ||
        (expected.type.functionValue &&
          given.type.functionValue &&
          expected.type.functionValue === given.type.functionValue))
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
    ) {
      for (let i = 0; i < expected.type.variants.length; i++) {
        const expectedTypeVariant = expected.type.variants[i]!;
        const givenTypeVariant = given.type.variants[i]!;

        const expectedTypeVariantElements = expectedTypeVariant.elements ?? [];
        const givenTypeVariantElements = givenTypeVariant.elements ?? [];

        for (let j = 0; j < expectedTypeVariantElements.length; j++) {
          const { expectedEnv, givenEnv } = this.synthesizeTypes(
            { type: expectedTypeVariantElements[j]!.type, env: expected.env },
            { type: givenTypeVariantElements[j]!.type, env: given.env }
          );
          expected.env = expectedEnv;
          given.env = givenEnv;
        }
      }
    } else if (
      isModuleType(expected.type) &&
      isModuleType(given.type) &&
      (expected.type.typeId === given.type.typeId ||
        (expected.type.functionValue &&
          given.type.functionValue &&
          expected.type.functionValue === given.type.functionValue))
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
    ) {
      for (let i = 0; i < expected.type.elements.length; i++) {
        const expectedElement = expected.type.elements[i]!;
        const givenElement = given.type.elements[i]!;
        const { expectedEnv, givenEnv } = this.synthesizeTypes(
          { type: expectedElement.type, env: expected.env },
          { type: givenElement.type, env: given.env }
        );
        expected.env = expectedEnv;
        given.env = givenEnv;

        if (
          expectedElement.assignedValue &&
          givenElement.assignedValue &&
          isTypeValue(expectedElement.assignedValue) &&
          isTypeValue(givenElement.assignedValue)
        ) {
          const { expectedEnv, givenEnv } = this.synthesizeTypes(
            {
              type: expectedElement.assignedValue.value,
              env: expected.env,
            },
            {
              type: givenElement.assignedValue.value,
              env: given.env,
            }
          );
          expected.env = expectedEnv;
          given.env = givenEnv;
        }
      }
    } else {
      /*
      console.log(
        "Failed to synthesize: ",
        typeToString(expected.type),
        typeToString(givenType),
        areTypesCompatible(expected.type, given.type, env)
      );
      */
    }
    return { expectedEnv: expected.env, givenEnv: given.env };
  }

  /**
   * Synthesize the expression and type, such as:
   * - (p: Point) := _(3, 4);   // here _ becomes Point
   * - (p: Color) := .Red;      // here (.) becomes (Color.)
   * - (p: Shape) := .Circle(3) // here (.) becomes (Shape.)
   * - (c: Complex) := (_(3, true),) // here (_) becomes struct in tuple
   */
  private synthesizeExprAndType({
    expr,
    type,
    env,
    context,
  }: {
    expr: Expr;
    type: Type;
    env: Environment;
    context: EvaluatorContext;
  }): { expr: Expr; type: Type; env: Environment } {
    // Handle tuples (including tuples with placeholders)
    if (
      isTupleType(type) &&
      exprIsFunctionCall(expr) &&
      exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)
    ) {
      if (type.elements.length !== expr.args.length) {
        throw this.formatErrorMessage(
          expr.token,
          `Tuple size mismatch: expected ${type.elements.length} elements, got ${expr.args.length}`
        );
      }

      // Recursively synthesize each tuple element
      for (let i = 0; i < type.elements.length; i++) {
        const elementType = type.elements[i]!.type;
        const elementExpr = expr.args[i]!;

        const {
          // expr: synthesizedExpr,
          // type: synthesizedType,
          env: nextEnv,
        } = this.synthesizeExprAndType({
          expr: elementExpr,
          type: elementType,
          env,
          context: { ...context },
        });

        env = nextEnv;
      }

      // The entire tuple is now synthesized
      expr.$ = {
        env,
        type,
        isMutable: false,
        pathCollection: [],
      };
      return { expr, type, env };
    }
    // Handle the _ case
    else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "_")) {
      // Check if type is a struct type
      if (isStructType(type) || isUnionType(type) || isModuleType(type)) {
        const funcCallExpr = this.evaluateFunctionCall({
          expr,
          env,
          givenFunc: {
            type: typeOfType(type),
            value: createTypeValue(type),
          },
          context: { ...context },
        });

        if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to evaluate expr and type for struct:\n${exprToString(
              expr
            )}`
          );
        }

        // Attach information to the "_"
        // expr.func.value = createTypeValue(type);
        // expr.func.type = typeOfType(type);

        return {
          expr: funcCallExpr,
          type: funcCallExpr.$?.type,
          env: funcCallExpr.$?.env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use _ with type ${typeToString(
            type
          )}. Only supported with struct types.`
        );
      }
    }
    // Handle the . case for enum variant
    else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ".", 1)) {
      // Check if type is an enum type
      if (isEnumType(type)) {
        const variantNameExpr = expr.args[0]!;
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            expr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }
        const variantName = variantNameExpr.token.value;
        const variant = type.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            expr.token,
            `Enum variant "${variantName}" not found in ${typeToString(type)}`
          );
        }

        const newEnumType = { ...type, selectedVariantName: variantName };
        expr.$ = {
          type: newEnumType,
          env,
          isMutable: false,
          pathCollection: [],
        };
        // TODO: comptime value

        return {
          expr: expr,
          type: newEnumType,
          env: env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use . with type ${typeToString(
            type
          )}. Only supported with enum types.`
        );
      }
    }
    // Handle the . case for enum variant call
    else if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCall(expr.func) &&
      exprIsFunctionCallOf(expr.func, ".", 1)
    ) {
      if (isEnumType(type)) {
        const variantExpr = expr.func;
        const variantNameExpr = variantExpr.args[0]!;
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            variantExpr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }

        const variantName = variantNameExpr.token.value;
        const variant = type.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            expr.token,
            `Enum variant "${variantName}" not found in ${typeToString(type)}`
          );
        }

        const newEnumType = { ...type, selectedVariantName: variantName };
        const funcCallExpr = this.evaluateFunctionCall({
          expr,
          env,
          givenFunc: {
            type: typeOfType(newEnumType),
            value: createTypeValue(newEnumType),
          },
          context: { ...context },
        });
        if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to evaluate expr and type for enum variant:\n${exprToString(
              expr
            )}`
          );
        }

        return {
          expr: funcCallExpr,
          type: funcCallExpr.$?.type,
          env: funcCallExpr.$?.env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use . with type ${typeToString(
            type
          )}. Only supported with enum types.`
        );
      }
    }
    // If both expr and type are already set, return them
    // No need to synthesize again
    else if (expr.$?.type && type) {
      return {
        expr,
        type: expr.$?.type, // NOTE: Here we should return the type of expr, not `type`
        env,
      };
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to synthesize the type and expr: ${exprToString(expr)}`
      );
    }
  }

  /**
   * rhs should be already evaluated
   */
  private evaluateDestructuringAssignment({
    lhs,
    rhs,
    env,
    isCompileTimeOnly,
    context,
  }: {
    lhs: Expr;
    rhs: Expr;
    env: Environment;
    isCompileTimeOnly: boolean;
    context: EvaluatorContext;
  }): Environment {
    if (!rhs.$?.type) {
      throw this.formatErrorMessage(
        rhs.token,
        `(1) Expected type for right-hand side, got ${exprToString(rhs)}`
      );
    }
    const rhsType = rhs.$.type;
    const rhsValue = rhs.$.value;

    // Handle struct destructuring
    if (
      (isStructType(rhsType) ||
        isUnionType(rhsType) ||
        isModuleType(rhsType)) &&
      exprIsFunctionCall(lhs)
    ) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.elements,
        rhsValue: rhsValue,
        rhsType: rhsType,
        lhs,
        env,
        context: { ...context },
        isCompileTimeOnly,
      });
    }
    // Handle tuple destructuring
    else if (
      isTupleType(rhsType) &&
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.tuple)
    ) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.elements,
        rhsValue: rhsValue,
        rhsType: rhsType,
        lhs,
        env,
        context: { ...context },
        isCompileTimeOnly,
      });
    }
    // Handle enum variant destructuring
    else if (isEnumType(rhsType) && exprIsFunctionCall(lhs)) {
      const selectedVariantName = rhsType.selectedVariantName;
      if (!selectedVariantName) {
        throw this.formatErrorMessage(
          rhs.token,
          `Expected enum variant name to be determined, got ${typeToString(rhsType)}`
        );
      }

      const selectedVariant = rhsType.variants.find(
        (variant) => variant.name === selectedVariantName
      );
      if (!selectedVariant) {
        throw this.formatErrorMessage(
          rhs.token,
          `Expected enum variant "${selectedVariantName}" to be defined, got ${typeToString(rhsType)}`
        );
      }
      if (!selectedVariant.elements) {
        throw this.formatErrorMessage(
          rhs.token,
          `Cannot destructure enum variant "${selectedVariantName}" without elements, got ${typeToString(rhsType)}`
        );
      }

      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: selectedVariant.elements,
        rhsValue: rhsValue,
        rhsType: rhsType,
        lhs,
        env,
        context: { ...context },
        isCompileTimeOnly,
      });
    }

    // Error:
    if (
      !(
        isTupleType(rhsType) ||
        isStructType(rhsType) ||
        isUnionType(rhsType) ||
        isModuleType(rhsType)
      )
    ) {
      throw this.formatErrorMessage(
        rhs.token,
        `Destructuring assignment not supported for the right-hand type:

  ${typeToString(rhsType)}`
      );
    } else {
      throw this.formatErrorMessage(
        lhs.token,
        `Destructuring assignment not supported for the left-hand pattern:
  
      ${exprToString(lhs)}`
      );
    }
  }

  // Modified to handle member destructuring directly
  private handleMemberDestructuring({
    lhsFunc,
    lhsElements,
    rhsElements,
    rhsValue,
    rhsType,
    lhs,
    env,
    // context,
    isCompileTimeOnly,
  }: {
    lhsFunc: Expr;
    lhsElements: Expr[];
    rhsElements: { label?: string; type: Type }[];
    rhsValue: Value | undefined;
    /**
     * The rhsType might be pointer or reference,
     * in this case, the rhsElements are the dereferenced elements.
     */
    rhsType: Type;
    lhs: Expr;
    env: Environment;
    context: EvaluatorContext;
    isCompileTimeOnly: boolean;
  }): Environment {
    const requireUnderscore = !isTupleType(rhsType);
    const lhsFuncName = lhsFunc.token.value;

    // ~~Verify the struct type name matches if specified~~
    // We force to use _ for destructuring
    if (requireUnderscore && lhsFuncName !== "_") {
      throw this.formatErrorMessage(
        lhsFunc.token,
        `Expected "_" for non-tuple destructuring, got "${lhsFuncName}"`
      );
    }

    // Check if it's destructuring a union type
    if (isUnionType(rhsType)) {
      // Expect lhsElements to be a single element
      if (lhsElements.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Destructuring union type requires a single element, got ${lhsElements.length}`
        );
      }
    }

    // Check if we have enough elements
    if (lhsElements.length > rhsElements.length) {
      throw this.formatErrorMessage(
        lhs.token,
        `Too many elements in destructuring pattern. Expected at most ${rhsElements.length}, got ${lhsElements.length}`
      );
    }

    const destructuredRhsElementSet = new Set<{ label?: string; type: Type }>();
    // Process each lhs element
    for (let i = 0; i < lhsElements.length; i++) {
      const lhsElement = lhsElements[i]!;
      let elementIndex: number = i;
      let elementValue: Value | undefined = undefined;
      // Initialize rhsElement here, before any conditional branches
      let rhsElement = rhsElements[elementIndex]!;
      let variableName: string | undefined;
      let variableToken: Token | undefined;
      let labelExpr: Expr | undefined = undefined;
      let renameExpr: Expr | undefined = undefined;

      // Handle destructuring all elements with _
      // - (_ : _)
      // - ( _ )
      if (
        (exprIsFunctionCall(lhsElement) &&
          exprIsFunctionCallOf(lhsElement, ":", 2) &&
          lhsElement.args[0]!.token.value === "_" &&
          lhsElement.args[1]!.token.value === "_") ||
        (exprIsAtom(lhsElement) && lhsElement.token.value === "_")
      ) {
        if (isUnionType(rhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Cannot destructure union type with _, got ${typeToString(rhsType)}`
          );
        }

        // If it's a single _, we destructure all elements
        if (lhsElements.length === 1) {
          // We can destructure all elements
          for (let j = 0; j < rhsElements.length; j++) {
            const element = rhsElements[j]!;
            if (!element.label) {
              continue;
            }
            const elementValue =
              isTupleValue(rhsValue) ||
              isStructValue(rhsValue) ||
              isModuleValue(rhsValue) ||
              isEnumValue(rhsValue)
                ? rhsValue.elements[j]
                : undefined;

            // Add to environment
            // console.log("(2) addVariableToEnv");
            const { env: nextEnv } = addVariableToEnv({
              env,
              variable: {
                name: element.label,
                value: elementValue,
                type: element.type,
                token: lhsElement.token,
                isMutable: false,
                isCompileTimeOnly,
                isUndefined: false,
                isImplicit: false,
              },
            });
            env = nextEnv;
          }

          // Set the type and value of the lhsElement
          lhsElement.$ = {
            env,
            type: rhsType,
            value: rhsValue,
            isMutable: false,
            pathCollection: [],
          };

          // Done with destructuring, return the environment
          return env;
        } else {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Destructuring with _ requires a single element, got ${lhsElements.length}`
          );
        }
      }

      // Handle destructuring with implicit members
      // This only works with the struct (module) destructuring
      // - ( _(?) )
      else if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, "_", 1) &&
        lhsElement.args.length === 1 &&
        exprIsAtomOf(lhsElement.args[0]!, BuiltinKeywords.implicit)
      ) {
        if (!isModuleType(rhsType) || !isModuleValue(rhsValue)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected module value for destructuring with implicit members, got ${typeToString(
              rhsType
            )}`
          );
        }

        // We can destructure all elements
        for (let j = 0; j < rhsElements.length; j++) {
          const element = rhsElements[j]!;
          if (!element.label) {
            continue;
          }

          const memberTypeIndex = rhsType.elements.findIndex(
            (m) => m.label === element.label
          )!;
          const memberType = rhsType.elements[memberTypeIndex]!;
          if (!memberType.isImplicit) {
            continue;
          }

          const memberValue = rhsValue.elements[memberTypeIndex];

          // Add to environment
          // console.log("(3) addVariableToEnv");
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: element.label,
              value: memberValue,
              type: element.type,
              token: lhsElement.token,
              isMutable: false,
              isCompileTimeOnly,
              isUndefined: false,
              isImplicit: false,
            },
          });
          env = nextEnv;
        }

        // Set the type and value of the lhsElement
        lhsElement.$ = {
          env,
          type: rhsType,
          value: rhsValue,
          isMutable: false,
          pathCollection: [],
        };

        // Done with destructuring, return the environment
        return env;
      }

      // Handle labeled destructuring pattern like:
      // - (c : x)
      // - (c: (x, y))
      // - (c: _(x, y))
      else if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ":", 2)
      ) {
        const leftSide = lhsElement.args[0]!; // The label (c)
        const rightSide = lhsElement.args[1]!; // Could be (x, y) or could be a variable

        // The left side should be an identifier
        if (!exprIsAtom(leftSide) || !this.isValidVariableName(leftSide)) {
          throw this.formatErrorMessage(
            leftSide.token,
            `Expected identifier for label in destructuring pattern, got ${exprToString(
              leftSide
            )}`
          );
        }

        labelExpr = leftSide;
        const label = labelExpr.token.value;

        // Find the member with matching label
        const matchingMemberIndex = rhsElements.findIndex(
          (member) => member.label === label
        );

        if (matchingMemberIndex === -1) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Label "${label}" being destructured not found.`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsElement = rhsElements[elementIndex]!;
        destructuredRhsElementSet.add(rhsElement);
        // const nestedRhsType = rhsElement.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isModuleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isEnumValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }
        elementValue = nestedValue;

        // NOTE: Let's disable the nested destructuring for now
        /*
        // Check if the right side is a tuple for nested destructuring (c: (x, y))
        if (
          exprIsFunctionCall(rightSide) &&
          exprIsFunctionCallOf(rightSide, BuiltinKeywords.tuple)
        ) {
          // Ensure the member we're destructuring is a tuple or struct
          if (!isTupleType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected tuple for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Get the nested members
          const nestedElements = isTupleType(nestedRhsType)
            ? nestedRhsType.elements
            : (nestedRhsType as StructType).elements;

          // Recursively process nested destructuring
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsElements: nestedElements,
            rhsValue: nestedValue,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
            context: { ...context },
            isCompileTimeOnly,
          });

          // Set type and value on expressions
          rightSide.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          labelExpr.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          lhsElement.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          // Skip to next element since we've already processed this one
          continue;
        }

        // Check if the right side is a struct/module for nested destructuring (c: _(x, y))
        else if (exprIsFunctionCall(rightSide)) {
          if (!exprIsFunctionCallOf(rightSide, "_")) {
            throw this.formatErrorMessage(
              rightSide.token,
              `Expected "_" for nested destructuring, got ${exprToString(
                rightSide
              )}`
            );
          }

          if (!isStructType(nestedRhsType) && !isModuleType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected struct/module for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Recursively process nested destructuring
          const nestedElements = nestedRhsType.elements;
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsElements: nestedElements,
            rhsValue: nestedValue,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
            context: { ...context },
            isCompileTimeOnly,
          });

          // Set type and value on expressions
          rightSide.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          labelExpr.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          lhsElement.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          // Skip to next element since we've already processed this one
          continue;
        }

        // Variable rename case like (a: m)
        else 
        */
        if (exprIsAtom(rightSide) && this.isValidVariableName(rightSide)) {
          renameExpr = rightSide;
          variableName = rightSide.token.value;
          variableToken = rightSide.token;
        }
        // Other patterns that don't match previous conditions
        else {
          throw this.formatErrorMessage(
            rightSide.token,
            `Nested destructuring is not supported:

  ${exprToString(rightSide)}`
          );
        }
      }

      // Handle nested struct/module destructuring pattern like:
      // - ((x, y), )
      // - (_(x, y) )
      else if (exprIsFunctionCall(lhsElement)) {
        // NOTE: Let's disable the nested destructuring for now
        throw this.formatErrorMessage(
          lhsElement.token,
          `Nested destructuring is not supported:
  
  ${exprToString(lhsElement)}`
        );

        /*
        // Get the right-hand side value at this position
        rhsElement = rhsElements[elementIndex]!;
        destructuredRhsElementSet.add(rhsElement);
        const nestedRhsType = rhsElement.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isModuleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }
        elementValue = nestedValue;

        // Check if the right side is a tuple for nested destructuring (a, (x, y))
        if (
          exprIsFunctionCall(lhsElement) &&
          exprIsFunctionCallOf(lhsElement, BuiltinKeywords.tuple)
        ) {
          // Ensure the member we're destructuring is a tuple or struct
          if (!isTupleType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected tuple for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Get the nested members
          const nestedElements = nestedRhsType.elements;

          // Recursively process nested destructuring
          env = this.handleMemberDestructuring({
            lhsFunc: lhsElement.func,
            lhsElements: lhsElement.args,
            rhsElements: nestedElements,
            rhsValue: nestedValue,
            rhsType: nestedRhsType,
            lhs: lhsElement,
            env,
            context: { ...context },
            isCompileTimeOnly,
          });

          // Set type and value on expressions
          lhsElement.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };

          continue;
        }
        // Check if the right side is a struct/module for nested destructuring (a, _(x, y))
        else {
          if (!exprIsFunctionCallOf(lhsElement, "_")) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected "_" for nested destructuring, got ${exprToString(
                lhsElement
              )}`
            );
          }
          if (!isStructType(nestedRhsType) && !isModuleType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected struct/module for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Get the nested members
          const nestedElements = nestedRhsType.elements;

          // Recursively process nested destructuring
          env = this.handleMemberDestructuring({
            lhsFunc: lhsElement.func,
            lhsElements: lhsElement.args,
            rhsElements: nestedElements,
            rhsValue: nestedValue,
            rhsType: nestedRhsType,
            lhs: lhsElement,
            env,
            context: { ...context },
            isCompileTimeOnly,
          });
          // Set type and value on expressions
          lhsElement.$ = {
            env,
            type: nestedRhsType,
            value: nestedValue,
            isMutable: false,
            pathCollection: [],
          };
          continue;
        }
        */
      }

      // Handle positional destructuring
      else if (exprIsAtom(lhsElement) && this.isValidVariableName(lhsElement)) {
        if (isUnionType(rhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Cannot destructure union type with positional destructuring, got ${typeToString(
              rhsType
            )}`
          );
        }

        destructuredRhsElementSet.add(rhsElement);

        if (isTupleValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        } else if (isEnumValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        } else if (isModuleValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        }

        variableName = lhsElement.token.value;
        variableToken = lhsElement.token;
      }

      // Throw error
      else {
        throw this.formatErrorMessage(
          lhsElement.token,
          `Unsupported destructuring pattern for: ${exprToString(lhsElement)}`
        );
      }

      // After determining variableName and variableToken, add to environment
      if (variableName && variableToken) {
        // Add the variable to the environment
        // console.log("(4) addVariableToEnv");
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: variableName,
            token: variableToken,
            type: rhsElement.type,
            isMutable: false,
            isUndefined: false,
            isImplicit: false,
            isCompileTimeOnly: isCompileTimeOnly,
            value: elementValue,
          },
        });

        env = nextEnv;

        // Set the type and value on the lhs element for completeness
        lhsElement.$ = {
          env,
          type: rhsElement.type,
          value: elementValue,
          isMutable: false,
          pathCollection: [],
        };

        if (labelExpr) {
          labelExpr.$ = {
            env,
            type: rhsElement.type,
            value: elementValue, // !renameExpr ? elementValue : undefined,
            isMutable: false,
            pathCollection: [],
          };
        }

        if (renameExpr) {
          renameExpr.$ = {
            env,
            type: rhsElement.type,
            value: elementValue,
            isMutable: false,
            pathCollection: [],
          };
        }
      }
    }

    // Iterate the rhsElements to check if there is any
    // "Linear" value that is not destructured
    for (const rhsElement of rhsElements) {
      if (!destructuredRhsElementSet.has(rhsElement)) {
        if (isLinearOrType0Type(typeOfType(rhsElement.type))) {
          // If it's a linear type, we should throw an error
          throw this.formatErrorMessage(
            lhs.token,
            `Linear value ${rhsElement.label ? `"${rhsElement.label}" ` : ""}of type ${typeToString(
              rhsElement.type
            )} is not destructured.`
          );
        }
      }
    }

    return env;
  }

  private evaluateBinding({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): { expr: FuncCallExpr; variableExpr: Expr; variableName: string } {
    if (!exprIsFunctionCallOf(expr, ":", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected ":" for variable binding.`
      );
    }
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    // Evaluate the rhs expression
    const evaluatedRhs = this.evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedRhs.$) {
      throw this.formatErrorMessage(
        rhs.token,
        `Failed to evaluate rhs expression:
${exprToString(rhs)}`
      );
    }
    env = evaluatedRhs.$.env;

    const typeValue = evaluatedRhs.$.value;
    if (!isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        rhs.token,
        `Expected type for rhs, got ${exprToString(rhs)}`
      );
    }
    const userDefinedType = typeValue.value;

    // Evaluate the lhs expression
    let isCompileTimeOnly = false;
    let isMutable = false;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
    ) {
      isCompileTimeOnly = true;
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for "compt" (or "@"), got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0]!;
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.mut)
    ) {
      isMutable = true;
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0]!;
    }
    if (!this.isValidVariableName(lhs)) {
      throw this.formatErrorMessage(
        lhs.token,
        `Invalid binding to ${lhs.token.value}, expected identifier or operator`
      );
    }

    if (typeRequiresComptModifier(userDefinedType) && !isCompileTimeOnly) {
      throw this.formatErrorMessage(
        lhs.token,
        `Expected "compt" (or "@") for compile-time known ${
          isTypeHierarchyType(userDefinedType) ? "type" : "module"
        } value binding.`
      );
    }

    if (isTypeHierarchyType(userDefinedType) && isMutable) {
      throw this.formatErrorMessage(
        lhs.token,
        `Unexpected "mut" (or "!") for type hierarchy value binding. Type hierarchy values are immutable.`
      );
    }

    const variableName = lhs.token.value;
    // Add the variable to the env
    // console.log("(5) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: variableName,
        token: lhs.token,
        type: userDefinedType,
        isMutable,
        isUndefined: true,
        isCompileTimeOnly,
        isImplicit: false,
        value: isCompileTimeOnly
          ? createUnknownValue(userDefinedType)
          : undefined,
      },
    });
    env = nextEnv;

    // Attach the user defined type to the lhs
    lhs.$ = {
      env,
      type: userDefinedType,
      isMutable,
      pathCollection: [[variableName]],
    };

    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };

    return { expr, variableExpr: lhs, variableName };
  }

  /**
   * Evaluate the initialization assignment
   * - ::
   * - :=
   */
  private evaluateInitializationAssignment({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (
      !exprIsFunctionCallOf(expr, ":=", 2) &&
      !exprIsFunctionCallOf(expr, "::", 2)
    ) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected ":=" or "::" for initialization assignment.`
      );
    }
    const isCompileTimeOnly = exprIsFunctionCallOf(expr, "::");
    let isMutable = false;
    let isImplicit = false;

    let lhs = expr.args[0]!;
    let rhs = expr.args[1]!;

    // Check if the variale is implicit
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit)
    ) {
      isImplicit = true;
      // Check if the lhs is a variable
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for implicit, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0]!;
    }

    // Check if the variable is mutable
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.mut)
    ) {
      isMutable = true;
      // Check if the lhs is a variable
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0]!;
    }

    // Prevent declaring variable type using :: or :=
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":")) {
      throw this.formatErrorMessage(
        lhs.token,
        `Unexpected use of ":" in type declaration with "${
          expr.token.value
        }". Please consider using "=":
(${exprToString(lhs)}) = ${exprToString(rhs)}`
      );
    }

    // Evaluate the rhs expression
    rhs = this.evaluateExpression({
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

    // Set the rhs as consumed
    env = setExprAsConsumed(rhs, env);

    // If rhs is type value, then it cannot be mutable
    if (isTypeValue(rhs.$?.value) && isMutable) {
      throw this.formatErrorMessage(
        lhs.token,
        `Unexpected "mut" (or "!") for type value:
${exprToString(rhs)}`
      );
    }

    if (exprIsAtom(lhs)) {
      if (!this.isValidVariableName(lhs)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Invalid assignment to ${lhs.token.value}, expected identifier or operator`
        );
      }

      // Set the variable type
      let rhsType = rhs.$?.type;
      if (!lhs.$?.type) {
        if (!rhsType) {
          throw this.formatErrorMessage(
            rhs.token,
            `Failed to evaluate, got ${exprToString(rhs)}`
          );
        }

        // If it's runtime, then we convert
        // compt_int -> i32
        // compt_float -> f64
        // etc...
        let lhsType = rhsType;
        if (!isCompileTimeOnly) {
          lhsType = convertComptTypeToRuntimeType(rhsType);
        }

        // user didn't specify the type
        lhs.$ = {
          env,
          type: lhsType,
          isMutable,
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
          } = this.synthesizeExprAndType({
            expr: rhs,
            type: lhs.$?.type,
            env: env,
            context: { ...context },
          });
          rhs = nextRhs;
          rhsType = nextRhsType;
          // as it is actually lhs.type if not synthesized.
          env = nextEnv;
        } catch (e) {
          throw this.formatErrorMessage(
            rhs.token,
            `(evaluateInitializationAssignment) Failed to synthesize type for expression: ${exprToString(
              rhs
            )}\n${e}`
          );
        }

        // Check if the type is compatible
        if (
          !areTypesCompatible(
            { type: lhs.$?.type, env },
            { type: rhsType, env }
          )
        ) {
          throw this.formatErrorMessage(
            lhs.token,
            `Incompatible types:
- Defined: ${typeToString(lhs.$?.type)}
- Given  : ${typeToString(rhsType)}`
          );
        }
      }

      // Check some value that requires compile-time only
      if (!isCompileTimeOnly && typeRequiresComptModifier(lhs.$.type)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for compile-time known value assignment:
${exprToString(expr)}`
        );
      }

      // Check if the rhsType contains reference
      if (typeContainsReference(rhsType)) {
        throw this.formatErrorMessage(
          rhs.token,
          `Assigning reference to variable is not allowed.`
        );
      }

      // Check the borrowings
      checkBorrowings(context.borrowings, rhs);

      // Add .typeName info if necessary
      let rhsValue = rhs.$?.value;
      if (
        isTypeValue(rhsValue) &&
        /*
        (isStructType(rhsValue.value) ||
          isEnumType(rhsValue.value) ||
          isUnionType(rhsValue.value) ||
          isModuleType(rhsValue.value)) &&
        */
        !rhsValue.value.typeName
      ) {
        rhsValue.value.typeName = lhs.token.value;
      } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
        rhsValue.funcName = lhs.token.value;
      } else if (isModuleValue(rhsValue) && !rhsValue.type.typeName) {
        rhsValue.type.typeName = lhs.token.value;
      }

      // Check if it's assigning Free to Linear
      if (
        isTypeValue(rhsValue) &&
        isFreeType(typeOfType(rhsValue.value)) &&
        isLinearType(lhs.$.type)
      ) {
        rhsValue = setTypeValueAsLinear(rhsValue);
      }

      // Prohibit assigning runtime value to comptime-only variable
      if (!rhsValue && isCompileTimeOnly) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected compile-time value for "${lhs.token.value}".
Got runtime value. Please consider using ":=" instead of "::":
${exprToString(rhs)}`
        );
      }

      // Set the variable value
      lhs.$ = {
        env,
        type: lhs.$.type,
        value: isCompileTimeOnly
          ? (rhsValue ?? createUnknownValue(lhs.$.type, lhs.token.value))
          : undefined,
        isMutable,
        pathCollection: [],
      };

      // Add variable to env
      // Attach the updated env to expr
      // console.log("(6) addVariableToEnv");
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: lhs.token.value,
          token: lhs.token,
          type: lhs.$.type,
          isMutable,
          isCompileTimeOnly,
          isUndefined: false,
          isImplicit,
          value: lhs.$.value,
        },
      });
      env = nextEnv;

      lhs.$.env = env;
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      // Evaluate the destructuring assignment
      if (!rhs.$) {
        throw this.formatErrorMessage(
          rhs.token,
          `Failed to evaluate the right-hand side expression:
${exprToString(rhs)}`
        );
      }
      env = this.evaluateDestructuringAssignment({
        lhs,
        rhs,
        env,
        isCompileTimeOnly,
        context: { ...context },
      });

      // NOTE: rhs is already set as consumed above

      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
  }

  /**
   * Evaluate assignment like
   * (x : i32) = 12;
   * x = 13;
   */
  private evaluateAssignment({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "=", 2)) {
      throw this.formatErrorMessage(expr.token, `Expected "=" for assignment.`);
    }

    let lhs = expr.args[0]!;
    let rhs = expr.args[1]!;

    // Something like
    // - (x : i32) = 12;
    // - x = 12;
    if (
      exprIsAtom(lhs) ||
      (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2))
    ) {
      let variableName: string;
      if (exprIsAtom(lhs)) {
        // x = 12;
        const evaluatedLhs = this.evaluateIdentifierAndOperator({
          expr: lhs,
          env,
          context: { ...context },
          throwErrorOnUndefined: false,
        });
        if (!evaluatedLhs.$) {
          throw this.formatErrorMessage(
            lhs.token,
            `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`
          );
        }
        env = evaluatedLhs.$.env;

        requireExprNotConsumed(evaluatedLhs, env);

        // Check if the variable exists in the environment
        lhs = evaluatedLhs;
        variableName = lhs.token.value;
      } else {
        // (x: i32) = 12;
        const {
          expr: bindingExpr,
          variableExpr,
          variableName: nextVariableName,
        } = this.evaluateBinding({
          expr: lhs,
          env,
          context: {
            ...context,
          },
        });
        if (bindingExpr.$?.env) {
          env = bindingExpr.$?.env;
        }
        lhs = variableExpr;
        variableName = nextVariableName;
      }

      const variables = getVariablesFromEnv(env, variableName);
      if (!variables.length) {
        throw this.formatErrorMessage(
          lhs.token,
          `Variable ${variableName} not found in the environment`
        );
      }
      const variable = variables[variables.length - 1]!;

      // Evaluate the rhs expression
      rhs = this.evaluateExpression({
        expr: rhs,
        env,
        context: {
          ...context,
          expectedType: { type: variable.type, env },
        },
      });
      if (rhs.$?.env) {
        env = rhs.$?.env;
      }

      // Set rhs as consumed
      env = setExprAsConsumed(rhs, env);

      let rhsType = rhs.$?.type;
      if (!rhsType) {
        // Try synthesize the type
        try {
          // Infer the type
          const {
            expr: nextRhs,
            type: nextRhsType,
            env: nextEnv,
          } = this.synthesizeExprAndType({
            expr: rhs,
            type: variable.type,
            env: env,
            context: { ...context },
          });
          rhs = nextRhs;
          rhsType = nextRhsType;
          // as it is actually lhs.type if not synthesized.
          env = nextEnv;
        } catch (e) {
          throw this.formatErrorMessage(
            rhs.token,
            `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
              rhs
            )}\n${e}`
          );
        }
      }

      // Check if the type matches
      if (
        !areTypesCompatible(
          { type: variable.type, env },
          { type: rhsType, env }
        )
      ) {
        throw this.formatErrorMessage(
          lhs.token,
          `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`
        );
      }

      // Add .typeName info if necessary
      let rhsValue = rhs.$?.value;
      if (isTypeValue(rhsValue) && !rhsValue.value.typeName) {
        rhsValue.value.typeName = variableName;
      } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
        rhsValue.funcName = variableName;
      } else if (isModuleValue(rhsValue) && !rhsValue.type.typeName) {
        rhsValue.type.typeName = variableName;
      }

      // Check if it's assigning Free to Linear
      if (
        isTypeValue(rhsValue) &&
        isFreeType(typeOfType(rhsValue.value)) &&
        isLinearType(variable.type)
      ) {
        rhsValue = setTypeValueAsLinear(rhsValue);
      }

      let isMutatingDefinedVariable = false;
      if (variable.isUndefined) {
        env = updateExistingVariable(env, variable, {
          ...variable,
          isUndefined: false,
          value: variable.isCompileTimeOnly ? rhsValue : undefined,
          // type: rhsType,
        });
      } else if (variable.isMutable) {
        // Update the variable value
        env = updateExistingVariable(env, variable, {
          ...variable,
          value: variable.isCompileTimeOnly ? rhsValue : undefined,
          // type: rhsType,
        });
        isMutatingDefinedVariable = true;
      } else {
        throw this.formatErrorMessage(
          lhs.token,
          `Cannot assign to immutable variable "${variableName}"`
        );
      }

      lhs.$ = {
        env,
        type: variable.type, // NOTE: It shouldn't be the rhsType.
        value: variable.isCompileTimeOnly ? rhsValue : undefined,
        isMutable: variable.isMutable,
        pathCollection: [[variableName]],
      };
      // Check the borrowings
      checkBorrowings(context.borrowings, lhs);

      if (!isMutatingDefinedVariable) {
        expr.$ = {
          env,
          value: VUnit,
          type: VUnit.type,
          isMutable: variable.isMutable,
          pathCollection: [],
        };
      } else {
        expr.$ = {
          // NOTE: This should return the original value of lhs
          env,
          value: variable.value,
          type: variable.type,
          isMutable: variable.isMutable,
          pathCollection: [],
        };

        // This temp variable is used to hold the old value of lhs
        attachTempVariableToExpr(expr);
      }

      return expr;
    }
    // Something like
    // x.a = 12;
    else {
      // Evaluate the lhs
      const evaluatedLhs = this.evaluateExpression({
        expr: lhs,
        env,
        context: {
          ...context,
          expectedType: undefined,
        },
      });
      if (!evaluatedLhs.$) {
        throw this.formatErrorMessage(
          lhs.token,
          `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`
        );
      }
      if (!evaluatedLhs.$.isMutable) {
        throw this.formatErrorMessage(
          lhs.token,
          `Cannot assign value to the immutable: ${exprToString(lhs)}`
        );
      }

      // Check the borrowings
      checkBorrowings(context.borrowings, evaluatedLhs);

      const expectedType = evaluatedLhs.$.type;

      // Evaluate the rhs expression
      rhs = this.evaluateExpression({
        expr: rhs,
        env,
        context: {
          ...context,
          expectedType: { type: expectedType, env },
        },
      });
      if (rhs.$?.env) {
        env = rhs.$?.env;
      }

      // Set rhs as consumed
      env = setExprAsConsumed(rhs, env);

      let rhsType = rhs.$?.type;
      if (!rhsType) {
        // Try synthesize the type
        try {
          // Infer the type
          const {
            expr: nextRhs,
            type: nextRhsType,
            env: nextEnv,
          } = this.synthesizeExprAndType({
            expr: rhs,
            type: expectedType,
            env: env,
            context: { ...context },
          });
          rhs = nextRhs;
          rhsType = nextRhsType;
          // as it is actually lhs.type if not synthesized.
          env = nextEnv;
        } catch (e) {
          throw this.formatErrorMessage(
            rhs.token,
            `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
              rhs
            )}\n${e}`
          );
        }
      }

      // Check if the rhsType contains reference
      if (typeContainsReference(rhsType)) {
        throw this.formatErrorMessage(
          rhs.token,
          `Assigning reference to variable is not allowed.`
        );
      }

      // Check if the type matches
      if (
        !areTypesCompatible({ type: expectedType, env }, { type: rhsType, env })
      ) {
        throw this.formatErrorMessage(
          lhs.token,
          `Incompatible types:
- Expected: ${typeToString(expectedType)}
- Given   : ${typeToString(rhsType)}`
        );
      }

      // Attach the updated env to expr
      expr.$ = {
        // NOTE: This should return the original value of lhs
        env,
        value: evaluatedLhs.$.value,
        type: evaluatedLhs.$.type,
        isMutable: evaluatedLhs.$.isMutable,
        pathCollection: [],
      };

      // This temp variable is used to hold the old value of lhs
      attachTempVariableToExpr(expr);

      // Update the lhs with the new value
      evaluatedLhs.$ = {
        env,
        type: expectedType, // NOTE: It shouldn't be the rhsType.
        value: rhs.$?.value,
        isMutable: evaluatedLhs.$.isMutable,
        pathCollection: evaluatedLhs.$.pathCollection,
      };
      // Return the updated expression
      return expr;
    }
  }

  private evaluateExtern({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.extern)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected extern, got ${expr.tag}`
      );
    }

    let language: "c" | "yo" = "c";
    let args = expr.args;
    if (expr.args[0] && exprIsAtom(expr.args[0])) {
      // Evaluate the language argument
      const langArg = expr.args[0]!;
      args = expr.args.slice(1);

      const evaluatedLang = this.evaluateExpression({
        expr: langArg,
        env,
        context: {
          ...context,
        },
      });
      if (!evaluatedLang.$ || !evaluatedLang.$.value) {
        throw this.formatErrorMessage(
          langArg.token,
          `Failed to evaluate language argument: ${exprToString(langArg)}`
        );
      }
      env = evaluatedLang.$.env;
      const langValue = evaluatedLang.$.value;
      if (!isComptStringValue(langValue)) {
        throw this.formatErrorMessage(
          langArg.token,
          `Expected string for language argument, got ${exprToString(langArg)}`
        );
      }
      if (langValue.value.toLocaleLowerCase() === "yo") {
        language = "yo";
      } else if (langValue.value.toLocaleLowerCase() === "c") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        language = "c";
      } else {
        throw this.formatErrorMessage(
          langArg.token,
          `Unsupported language "${langValue.value}" for extern, expected "c" or "yo"`
        );
      }
    }

    const elements: TupleElement[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const { type: element, env: nextEnv } = this.evaluateModuleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: {
          ...context,
          SelfType: undefined, // No SelfType in module context
        },
      });

      // Check if there is duplicate labels
      const duplicateLabel = elements.find(
        (elem) => elem.label === element.label
      );
      if (duplicateLabel) {
        throw this.formatErrorMessage(
          exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          `Duplicate label "${element.label}" in module`
        );
      }

      // Expect element to be compile-time only
      if (!element.isCompileTimeOnly) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected compile-time only element for extern module, got ${exprToString(arg)}`
        );
      }

      elements.push(element);
      env = nextEnv;

      // Prevent having Linear variables in "c" extern modules
      if (language === "c" && isLinearOrType0Type(element.type)) {
        throw this.formatErrorMessage(
          arg.token,
          `Cannot have "Linear" or "Type" type in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(element.type)}`
        );
      }
      if (language === "c" && isLinearOrType0Type(typeOfType(element.type))) {
        throw this.formatErrorMessage(
          arg.token,
          `Cannot have "Linear" or "Type" value in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(typeOfType(element.type))}`
        );
      }

      // Add element to env
      const { env: nextNextEnv } = addVariableToEnv({
        env,
        variable: {
          name: element.label,
          type: element.type,
          value:
            element.assignedValue ??
            createUnknownValue(element.type, element.label),
          isCompileTimeOnly: element.isCompileTimeOnly,
          isImplicit: element.isImplicit,
          isMutable: false,
          isUndefined: false,
          token: element.exprs.expr.token,
        },
      });
      env = nextNextEnv;
    }

    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };

    // "extern" token
    expr.func.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  private evaluateCond({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "cond", got ${expr.tag}`
      );
    }

    const statements = expr.args;
    if (statements.length === 0) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least one statement in "cond", got ${statements.length}`
      );
    }

    // Evaluate each statement
    // condition => value.
    // expect each value to be the same type.
    const bodies: Expr[] = [];
    let valueType: { type: Type; env: Environment } | undefined = undefined;

    /**
     * BooleanValue means the condition could be evaluated at compile-time and we got a concrete boolean value.
     * UnknownValue means the condition could be evaluated at compile-time, but we don't know the value yet.
     * undefined means the condition could not be evaluated at compile-time, and it's runtime only.
     */
    const condValues: (BooleanValue | UnknownValue | undefined)[] = [];
    const caseBodyValues: (Value | undefined)[] = [];

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i]!;

      // NOTE: We shouldn't use the parent `env` here
      // instead, we should create new env.
      let caseEnv = pushEnvFrame(env);

      if (
        !exprIsFunctionCall(statement) ||
        !exprIsFunctionCallOf(statement, "=>", 2)
      ) {
        throw this.formatErrorMessage(
          statement.token,
          `Expected => for cond statement, got ${statement.tag}`
        );
      }
      let condExpr = statement.args[0]!;
      let caseBodyExpr = statement.args[1]!;

      // Expect condExpr to be a boolean
      condExpr = this.evaluateExpression({
        expr: condExpr,
        env: caseEnv,
        context: {
          ...context,
        },
      });

      // TODO: Check comptime value if exists
      if (!condExpr.$) {
        throw this.formatErrorMessage(
          condExpr.token,
          `Failed to evaluate condition expression: ${exprToString(condExpr)}`
        );
      }
      caseEnv = condExpr.$.env;

      if (!isBooleanType(condExpr.$.type)) {
        throw this.formatErrorMessage(
          condExpr.token,
          `Expected boolean for cond statement, got ${exprToString(condExpr)}`
        );
      }

      // Check if it's comptime false
      const condValue = condExpr.$.value;
      if (isBooleanValue(condValue) && condValue.value === false) {
        continue; // No need to evaluate the case body
      }

      // Evaluate the caseBodyExpr
      caseBodyExpr = this.evaluateExpression({
        expr: caseBodyExpr,
        env: caseEnv,
        context: {
          ...context,
        },
      });

      if (!caseBodyExpr.$?.type) {
        throw this.formatErrorMessage(
          caseBodyExpr.token,
          `Expected type for cond statement, got ${exprToString(caseBodyExpr)}`
        );
      }
      caseEnv = caseBodyExpr.$.env;
      bodies.push(caseBodyExpr);

      if (!valueType) {
        valueType = { type: caseBodyExpr.$.type, env: caseEnv };
      } else {
        // Check if the types are compatible
        if (
          !areTypesCompatible(
            { type: valueType.type, env: valueType.env },
            { type: caseBodyExpr.$.type, env: caseEnv }
          )
        ) {
          // Check if the types match when converting to runtime type
          if (
            areTypesCompatible(
              {
                type: convertComptTypeToRuntimeType(valueType.type),
                env: valueType.env,
              },
              {
                type: caseBodyExpr.$.type,
                env: caseEnv,
              }
            )
          ) {
            valueType = { type: caseBodyExpr.$.type, env: caseEnv };
          } else {
            throw this.formatErrorMessage(
              caseBodyExpr.token,
              `Incompatible types:
- Previous: ${typeToString(valueType.type)}
- Current : ${typeToString(caseBodyExpr.$.type)}`
            );
          }
        }
      }

      // Check if the condValue is true
      condValues.push(condValue as BooleanValue | UnknownValue | undefined);
      caseBodyValues.push(caseBodyExpr.$.value);
      if (isBooleanValue(condValue) && condValue.value === true) {
        break; // We found the first true condition, no need to evaluate further
      }
    }

    if (!valueType) {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to determine the type of value from the cond.`
      );
    }

    // Merge and check all environments
    env = mergeAndCheckEnvs(env, bodies);

    let value: Value | undefined = undefined;
    if (caseBodyValues.some((val) => val === undefined)) {
      // contains runtime value
      value = undefined;
    } else {
      const lastCondValue = condValues[condValues.length - 1]!;
      if (isBooleanValue(lastCondValue) && lastCondValue.value === true) {
        value = caseBodyValues[caseBodyValues.length - 1]!;
      } else {
        value = createUnknownValue(valueType.type);
      }
    }

    expr.$ = {
      env,
      type: valueType.type,
      // TODO: set .value to support compile-time value.
      // Right now the createUnknownValue below is wrong
      value: value, // valueType ? createUnknownValue(valueType) : undefined;
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  /**
   *
   *
   * match shape // shape will be consumed here and moved to `s` in each condition.
   *   .Circle => ((s) => s.radius),
   *   .Square => ((s) => s.side),
   *   .Rectangle => ((s) => s.width + s.height)
   * ;
   */
  private evaluateMatch({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "match", got ${expr.tag}`
      );
    }

    const args = expr.args;
    if (args.length < 2) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least 2 arguments for "match", got ${args.length}`
      );
    }

    // Evaluate the value to be matched
    const valueExpr = args[0]!;
    const evaluatedMatchValue = this.evaluateExpression({
      expr: valueExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedMatchValue.$) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Failed to evaluate the match value expression: ${exprToString(valueExpr)}`
      );
    }
    env = evaluatedMatchValue.$.env;

    // Consume the value expression
    env = setExprAsConsumed(evaluatedMatchValue, env);

    const matchValueType = evaluatedMatchValue.$.type;

    // Check if it's a pointer/reference type
    // If yes, then automatically dereference one-level of it.
    let ptrOrRefType:
      | TypeTag.Ptr
      | TypeTag.MutPtr
      | TypeTag.Ref
      | TypeTag.MutRef
      | undefined = undefined;

    let enumType: Type;

    if (
      isPtrType(matchValueType) ||
      isMutPtrType(matchValueType) ||
      isRefType(matchValueType) ||
      isMutRefType(matchValueType)
    ) {
      enumType = matchValueType.type;
      ptrOrRefType = matchValueType.tag;
    } else {
      enumType = matchValueType;
    }

    // Check if the value is an enum type
    if (!isEnumType(enumType)) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Expected enum type for match expression, got ${
          matchValueType ? typeToString(matchValueType) : "unknown type"
        }`
      );
    }

    // Check if there is already selected variant,
    // If yes, then we disallow to use enum because we already know the selected variant.
    if (enumType.selectedVariantName) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Enum type ${typeToString(enumType)} already has selected variant "${enumType.selectedVariantName}".\n` +
          `You cannot use "match" on it, because it already has a selected variant.`
      );
    }

    const patterns = args.slice(1);

    // Evaluate each statement
    // expect each value to be the same type.
    const bodies: Expr[] = [];
    let resultType: { type: Type; env: Environment } | undefined = undefined;
    const checkedVariantNames: Set<string> = new Set();

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i]!;

      // NOTE: We shouldn't use the parent `env` here
      // instead, we should create new env.
      let caseEnv = pushEnvFrame(env);

      // Check if the pattern is a valid match arm
      if (
        !exprIsFunctionCall(pattern) ||
        !exprIsFunctionCallOf(pattern, "=>", 2)
      ) {
        throw this.formatErrorMessage(
          pattern.token,
          `Expected ":" for match pattern, got ${exprToString(pattern)}`
        );
      }

      const patternExpr = pattern.args[0]!;
      const rhsExpr = pattern.args[1]!;

      // Check if the pattern is a valid enum variant
      if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCallOf(patternExpr, ".", 1)
      ) {
        // For patterns like .Red
        const variantNameExpr = patternExpr.args[0]!;
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }

        const variantName = variantNameExpr.token.value;
        // Check if variant exists in enum
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (!variant) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" not found in ${typeToString(
              enumType
            )}`
          );
        }
        checkedVariantNames.add(variantName);

        let bodyExpr: Expr;
        // Update the enum type to set the selectedVariantName
        const newEnumType = {
          ...enumType,
          selectedVariantName: variantName,
        };
        let variableType:
          | EnumType
          | PtrType
          | MutPtrType
          | RefType
          | MutRefType = newEnumType;
        if (ptrOrRefType) {
          if (ptrOrRefType === TypeTag.Ptr) {
            variableType = createPtrType(newEnumType);
          } else if (ptrOrRefType === TypeTag.MutPtr) {
            variableType = createMutPtrType(newEnumType);
          } else if (ptrOrRefType === TypeTag.Ref) {
            variableType = createRefType(newEnumType);
          } else if (ptrOrRefType === TypeTag.MutRef) {
            variableType = createMutRefType(newEnumType);
          }
        }

        // Create a new environment for the case
        //   .VariantName => ((variable) => body)
        if (
          exprIsFunctionCall(rhsExpr) &&
          exprIsFunctionCallOf(rhsExpr, "=>", 2)
        ) {
          const variableExpr = rhsExpr.args[0]!;
          bodyExpr = rhsExpr.args[1]!;

          if (!this.isValidVariableName(variableExpr)) {
            throw this.formatErrorMessage(
              variableExpr.token,
              `Invalid variable name in match arm: ${variableExpr.token.value}`
            );
          }

          const variableName = variableExpr.token.value;

          // Add the new variable to env
          const { env: nextEnv } = addVariableToEnv({
            env: caseEnv,
            variable: {
              name: variableName,
              token: variableExpr.token,
              type: variableType,
              isMutable: evaluatedMatchValue.$.isMutable,
              isUndefined: false, // Set as initialized
              isCompileTimeOnly: false,
              isImplicit: false,
              value: evaluatedMatchValue.$.value,
            },
          });
          caseEnv = nextEnv;

          // Add information to variableExpr
          variableExpr.$ = {
            env: caseEnv,
            type: variableType,
            value: evaluatedMatchValue.$.value,
            isMutable: evaluatedMatchValue.$.isMutable,
            pathCollection: [[variableName]],
          };
        }
        //   .VariantName => body;
        //  this is for case like:
        //
        //  match color // < color here is a valid variable name
        //    .Red => {
        //       another_color := color; // we can use the "new" `color` here.
        //    },
        else {
          bodyExpr = rhsExpr;

          if (this.isValidVariableName(evaluatedMatchValue)) {
            const variableName = evaluatedMatchValue.token.value;

            // Add the new variable to env
            const { env: nextEnv } = addVariableToEnv({
              env: caseEnv,
              variable: {
                name: variableName,
                token: evaluatedMatchValue.token,
                type: variableType,
                isMutable: evaluatedMatchValue.$.isMutable,
                isUndefined: false, // Set as initialized
                isCompileTimeOnly: false,
                isImplicit: false,
                value: evaluatedMatchValue.$.value,
              },
            });
            caseEnv = nextEnv;
          }
        }

        // Evaluate the result expression
        const evaluatedResult = this.evaluateExpression({
          expr: bodyExpr,
          env: caseEnv,
          context: {
            ...context,
          },
        });
        // We don't update the original env here since each pattern has its own scope

        if (!evaluatedResult.$?.type) {
          throw this.formatErrorMessage(
            bodyExpr.token,
            `Expected type for match result expression, got ${exprToString(
              bodyExpr
            )}`
          );
        }
        caseEnv = evaluatedResult.$.env;
        bodies.push(evaluatedResult);

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = { type: evaluatedResult.$?.type, env: caseEnv };
        } else if (
          !areTypesCompatible(
            { type: resultType.type, env: caseEnv },
            { type: evaluatedResult.$?.type, env }
          )
        ) {
          // Check if the types match when converting to runtime type
          if (
            areTypesCompatible(
              {
                type: convertComptTypeToRuntimeType(resultType.type),
                env: resultType.env,
              },
              {
                type: evaluatedResult.$.type,
                env: caseEnv,
              }
            )
          ) {
            resultType = { type: evaluatedResult.$.type, env: caseEnv };
          } else {
            throw this.formatErrorMessage(
              valueExpr.token,
              `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedResult.$.type)}`
            );
          }
        }
      }
      // For patterns with destructuring like Shape.Circle(r)
      // NOTE: This is no longer supported
      else if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCall(patternExpr.func) &&
        exprIsFunctionCallOf(patternExpr.func, ".", 1)
      ) {
        throw this.formatErrorMessage(
          patternExpr.token,
          `Destructuring enum variant elements is not supported in match expressions.
Please use .variantName for destructuring enum variants,
then destructure the value in the case body expression.`
        );
      } else {
        throw this.formatErrorMessage(
          patternExpr.token,
          `Invalid pattern in match expression: ${exprToString(patternExpr)}
Please use .variantName for destructuring enum variants.`
        );
      }
    }

    if (!resultType) {
      throw this.formatErrorMessage(
        expr.token,
        `Could not determine result type for match expression`
      );
    }

    // Perform exhaustiveness check
    const missingVariants = enumType.variants.filter(
      (variant) => !checkedVariantNames.has(variant.name)
    );
    if (missingVariants.length > 0) {
      throw this.formatErrorMessage(
        expr.token,
        `Match expression is not exhaustive. Missing cases for variants:
        
- ${missingVariants.map((v) => v.name).join("\n- ")}`
      );
    }

    // Merge and check all environments
    env = mergeAndCheckEnvs(env, bodies);

    // Set the type and value of the match expression
    expr.$ = {
      env,
      type: resultType.type,
      // TODO: Support the compile-time value.
      // For compile-time evaluation, we'd determine which arm matches and set the value
      value: undefined, // createUnknownValue(resultType),
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  private evaluateIdentifierAndOperator({
    expr,
    env,
    context,
    throwErrorOnUndefined,
  }: {
    expr: AtomExpr;
    env: Environment;
    context: EvaluatorContext;
    throwErrorOnUndefined: boolean;
  }): AtomExpr {
    const identifier =
      expr.token.type === TokenType.BacktickIdentifier
        ? expr.token.value.slice(1, -1) // Remove backticks
        : expr.token.value;

    // Free
    if (identifier === TypeTag.Free) {
      const value = createTypeValue(createFreeType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // Linear
    else if (identifier === TypeTag.Linear) {
      const value = createTypeValue(createLinearType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // Type
    else if (identifier === TypeTag.Type) {
      const value = createTypeValue(createTypeType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // unit
    else if (identifier === TypeTag.Unit) {
      const value = createTypeValue(createUnitType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // compt_int
    else if (identifier === TypeTag.ComptInt) {
      const value = createTypeValue(createComptIntType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // compt_float
    else if (identifier === TypeTag.ComptFloat) {
      const value = createTypeValue(createComptFloatType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // compt_string
    else if (identifier === TypeTag.ComptString) {
      const value = createTypeValue(createComptStringType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // boolean
    else if (identifier === TypeTag.Boolean) {
      const value = createTypeValue(createBooleanType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // usize
    else if (identifier === TypeTag.Usize) {
      const value = createTypeValue(createUsizeType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // isize
    else if (identifier === TypeTag.Isize) {
      const value = createTypeValue(createIsizeType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // u8
    else if (identifier === TypeTag.U8) {
      const value = createTypeValue(createU8Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // i8
    else if (identifier === TypeTag.I8) {
      const value = createTypeValue(createI8Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // u16
    else if (identifier === TypeTag.U16) {
      const value = createTypeValue(createU16Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // i16
    else if (identifier === TypeTag.I16) {
      const value = createTypeValue(createI16Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // u32
    else if (identifier === TypeTag.U32) {
      const value = createTypeValue(createU32Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // i32
    else if (identifier === TypeTag.I32) {
      const value = createTypeValue(createI32Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // u64
    else if (identifier === TypeTag.U64) {
      const value = createTypeValue(createU64Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // i64
    else if (identifier === TypeTag.I64) {
      const value = createTypeValue(createI64Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // f32
    else if (identifier === TypeTag.F32) {
      const value = createTypeValue(createF32Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // f64
    else if (identifier === TypeTag.F64) {
      const value = createTypeValue(createF64Type());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // Expr
    else if (identifier === TypeTag.Expr) {
      const value = createTypeValue(createExprType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // ExprList
    else if (identifier === TypeTag.ExprList) {
      const value = createTypeValue(createExprListType());
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // Self
    else if (
      identifier === "Self" &&
      context.SelfType &&
      (isStructType(context.SelfType) ||
        isEnumType(context.SelfType) ||
        isUnionType(context.SelfType))
    ) {
      const typeValue = createTypeValue(context.SelfType);

      expr.$ = {
        env,
        type: typeValue.type,
        value: typeValue,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // variable
    else {
      const variables = getVariablesFromEnv(env, identifier);
      if (!variables.length) {
        throw this.formatErrorMessage(
          expr.token,
          `Variable "${identifier}" not found`
        );
      } else {
        const variable = variables[variables.length - 1]!;
        if (variable.isUndefined && throwErrorOnUndefined) {
          throw this.formatErrorMessage(
            expr.token,
            `Variable "${identifier}" is undefined`
          );
        }
        expr.$ = {
          env,
          type: variable.type,
          value: variable.value,
          isMutable: variable.isMutable,
          variableName: variable.name, // NOTE: The tempVariableName here is the variable name itself.
          pathCollection: [[variable.name]],
        };
        return expr;
      }
    }
  }

  private evaluateAnonymousFunctionImplementation({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const functionType = context.expectedType?.type;
    if (!functionType) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a function type, got:\n${exprToString(expr)}`
      );
    }
    if (!isFunctionType(functionType)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a function type, got:\n${typeToString(functionType)}`
      );
    }

    if (!exprIsFunctionCallOf(expr, "->", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected -> for anonymous function, got:\n${exprToString(expr)}`
      );
    }
    const functionDeclarationExpr = expr.args[0]!;
    const functionBodyExpr = expr.args[1]!;

    if (
      !exprIsFunctionCall(functionDeclarationExpr) ||
      !exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.fn)
    ) {
      throw this.formatErrorMessage(
        functionDeclarationExpr.token,
        `Expected "fn" for anonymous function, got:\n${exprToString(
          functionDeclarationExpr
        )}`
      );
    }

    // NOTE: We disallow to define function signature for anonymous function anymore.
    // Evaluate the parameter list
    // env = pushEnvFrame(env); // < this is done in evaluateFunctionParameters function.
    {
      const { env: nextEnv } = this.evaluateFunctionParameters({
        parameterExprs: functionDeclarationExpr.args,
        expectedFunctionType: functionType,
        env,
        context: {
          ...context,
        },
      });
      env = nextEnv;
    }

    // Evaluate the function body
    const evaluatedBody = this.evaluateBeginExpression({
      expr: functionBodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingFunctionBody: { type: functionType },
      },
    });

    // Check if the return type is compatible
    const evaluatedBodyReturnType = evaluatedBody.$?.type;
    if (
      evaluatedBodyReturnType &&
      !areTypesCompatible(
        { type: functionType.return.type, env },
        { type: evaluatedBodyReturnType, env }
      )
    ) {
      throw this.formatErrorMessage(
        functionBodyExpr.token,
        `Incompatible return type:
- Expected: ${typeToString(functionType.return.type)}
- Got     : ${typeToString(evaluatedBodyReturnType)}`
      );
    }

    if (evaluatedBody.$?.env) {
      env = evaluatedBody.$?.env;
    }
    // Restore the env frame
    env = popEnvFrame(env);

    // Set the type and value of the expression
    expr.$ = {
      env,
      type: functionType,
      value: {
        tag: ValueTag.Function,
        type: functionType,
        body: functionBodyExpr,
        frameLevel: env.frames.length - 1,
        funcId: `fn_${randomId()}`,
        calledComptFunctionCaches: [],
        SelfType: context.SelfType,
      },
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateRecur({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const isEvaluatingFunctionBodyOfType =
      context.isEvaluatingFunctionBody?.type;
    if (!isEvaluatingFunctionBodyOfType) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a function type for recur, got:\n${exprToString(expr)}`
      );
    }
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected recur, got:\n${exprToString(expr)}`
      );
    }

    return this.evaluateFunctionCall({
      expr: expr,
      env,
      givenFunc: {
        type: isEvaluatingFunctionBodyOfType,
        value: context.isEvaluatingFunctionBody?.value ?? undefined,
        // createTypeValue(isEvaluatingFunctionBodyOfType),
      },
      context: { ...context },
    });
  }

  /**
   * type:
   * i32 in (i32, ...)
   * (x: i32) in (x: i32, ...)
   * (mut(x): i32) in (mut(x): i32, ...)
   */
  private evaluateFunctionParameter({
    expr,
    expectedParameter,
    env,
    context,
  }: {
    expr: Expr;
    expectedParameter?: FunctionParameter;
    env: Environment;
    context: EvaluatorContext;
  }): { parameter: FunctionParameter; env: Environment } {
    let label: string | undefined = undefined;
    let isMutable: boolean = false;
    let isCompileTimeOnly: boolean = false;

    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr | undefined = undefined;

    let parameterType: Type | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    let expr_: Expr = expr;
    let typeExpr: Expr | undefined = undefined;
    let labelExpr: Expr | undefined = undefined;
    let defaultValueExpr: Expr | undefined = undefined;

    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "=")) {
      throw this.formatErrorMessage(
        expr_.func.token,
        `Please use "?=" for default parameter value, not "=".`
      );
    }

    // Check if there is defaultValue
    // eg:
    //   (x = 12)
    //   ((x: i32) ?= 13)
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "?=", 2)) {
      if (expectedParameter) {
        throw this.formatErrorMessage(
          expr_.token,
          `Not allowed to define default parameter value for anonymous function implementation.`
        );
      }

      rhsExpr = expr_.args[1]!;
      lhsExpr = expr_.args[0]!;
      defaultValueExpr = rhsExpr;
      expr_ = lhsExpr; // NOTE: Don't change the original `expr`
    }

    // Parse the lhs expr
    // eg:
    //   (x: i32)
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      if (expectedParameter) {
        throw this.formatErrorMessage(
          expr_.token,
          `Not allowed to define parameter type for anonymous function implementation.`
        );
      }

      rhsExpr = expr_.args[1]!;
      lhsExpr = expr_.args[0]!;
      typeExpr = rhsExpr;
    } else {
      // eg:
      //   (i32)
      if (!defaultValueExpr) {
        typeExpr = expr_;
      }
      // eg:
      //   (x = 13)
      else {
        typeExpr = undefined;
        lhsExpr = expr_;
      }
    }

    if (lhsExpr) {
      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.compt)
      ) {
        isCompileTimeOnly = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for "compt" (or "@"), got ${lhsExpr.args.length}`
          );
        }
        lhsExpr = lhsExpr.args[0]!;
      }
      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.mut)
      ) {
        isMutable = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for "mut" (or "!"), got ${lhsExpr.args.length}`
          );
        }
        lhsExpr = lhsExpr.args[0]!;
      }
      if (!exprIsAtom(lhsExpr) && !this.isValidVariableName(lhsExpr)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for parameter label, got ${exprToString(
            lhsExpr
          )}`
        );
      }
      label = lhsExpr.token.value;
      labelExpr = lhsExpr;
    }

    if (!lhsExpr && expectedParameter) {
      // ^ This is for anonymous function implementation
      // where the parameter type is given
      // such as:
      // fn(a, b) -> a + b;
      parameterType = expectedParameter.type;
      lhsExpr = expr; // Use the original expr

      if (!exprIsAtom(lhsExpr) && !this.isValidVariableName(lhsExpr)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for parameter label, got ${exprToString(
            lhsExpr
          )}`
        );
      }
      label = lhsExpr.token.value;
      labelExpr = lhsExpr;
    } else {
      // Evaluate the typeExpr if exists
      if (typeExpr) {
        // Parse the rhs expr which should be a type
        const evaluatedRhs = this.evaluateExpression({
          expr: typeExpr,
          env,
          context: { ...context },
        });
        if (!evaluatedRhs.$) {
          throw this.formatErrorMessage(
            typeExpr.token,
            `Failed to evaluate type expression: ${exprToString(typeExpr)}`
          );
        }
        env = evaluatedRhs.$.env;

        // Expected the evaluatedRhs to be a type
        const typeValue = evaluatedRhs.$.value;
        if (!isTypeValue(typeValue)) {
          throw this.formatErrorMessage(
            typeExpr.token,
            `Expected type for function parameter, got ${exprToString(
              typeExpr
            )}`
          );
        }
        parameterType = typeValue.value;
      }

      // Evaluate the defaultValueExpr if exists
      if (defaultValueExpr) {
        const evaluatedDefaultValue = this.evaluateExpression({
          expr: defaultValueExpr,
          env,
          context: {
            ...context,
          },
        });
        if (evaluatedDefaultValue.$?.env) {
          env = evaluatedDefaultValue.$?.env;
        }

        // Check the compile-time known value which has to exist
        defaultValue = evaluatedDefaultValue.$?.value;
        if (!defaultValue) {
          throw this.formatErrorMessage(
            defaultValueExpr.token,
            `Expected a compile-time known value for default parameter, got ${exprToString(
              defaultValueExpr
            )}`
          );
        }

        if (!parameterType) {
          parameterType = defaultValue.type;
        } else {
          // Check if the default value type is compatible with the parameter type
          if (
            !areTypesCompatible(
              { type: parameterType, env },
              { type: defaultValue.type, env }
            )
          ) {
            throw this.formatErrorMessage(
              defaultValueExpr.token,
              `Incompatible default value type:
- Expected: ${typeToString(parameterType)}
- Got     : ${typeToString(defaultValue.type)}`
            );
          }
        }
      }

      // Check the parameterType
      if (!parameterType) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected type for function parameter}`
        );
      }
      if (typeRequiresComptModifier(parameterType) && !isCompileTimeOnly) {
        // Try converting to runtime type first
        parameterType = convertComptTypeToRuntimeType(parameterType);

        // If it still requires compt modifier,
        // then throw an error
        if (typeRequiresComptModifier(parameterType)) {
          throw this.formatErrorMessage(
            lhsExpr?.token ?? expr.token,
            `Expected a "compt" (or "@") for parameter to be compile-time only. Given type:
${typeToString(parameterType)}`
          );
        }
      }
    }

    // We require to have label for function parameters
    if (!label) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a label for function parameter, got ${exprToString(expr)}`
      );
      // label = generateNewTempVariableName(this.modulePath);
    }

    const value = isCompileTimeOnly
      ? createUnknownValue(parameterType, label)
      : undefined;

    // Add the parameter to the env
    // console.log("(9) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: label,
        token: lhsExpr?.token ?? expr.token,
        type: parameterType,
        isMutable: isMutable,
        isCompileTimeOnly: isCompileTimeOnly,
        isUndefined: false, // Set as initialized
        isImplicit: false,
        value:
          // defaultValue ?? // NOTE: No need to use the default value here.
          isCompileTimeOnly
            ? createUnknownValue(parameterType, label)
            : undefined,
      },
      skipCheckingFunctionOverloading: true,
    });
    env = nextEnv;

    if (lhsExpr) {
      lhsExpr.$ = {
        env,
        type: parameterType,
        value: value,
        isMutable,
        pathCollection: [],
      };
    }

    if (lhsExpr !== expr && typeExpr !== expr) {
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
      };
    }
    return {
      parameter: {
        label: label,
        type: parameterType,
        exprs: getFunctionParameterExprs({
          labelExpr,
          typeExpr,
          defaultValueExpr,
        }),
        isMutable,
        isCompileTimeOnly,
      },
      env,
    };
  }

  /**
   * NOTE: Calling this function will increase the env frame.
   */
  private evaluateFunctionParameters({
    parameterExprs,
    expectedFunctionType,
    env,
    context,
  }: {
    parameterExprs: Expr[];
    expectedFunctionType?: FunctionType;
    env: Environment;
    context: EvaluatorContext;
  }): {
    parameters: FunctionParameter[];
    typeParameters: FunctionParameter[];
    implicitParameters: FunctionParameter[];
    env: Environment;
  } {
    env = pushEnvFrame(env);

    const parameters: FunctionParameter[] = [];
    const typeParameters: FunctionParameter[] = [];
    const implicitParameters: FunctionParameter[] = [];

    for (let i = 0; i < parameterExprs.length; i++) {
      const parameterExpr = parameterExprs[i]!;

      // Check if it's the type parameters
      if (
        exprIsFunctionCall(parameterExpr) &&
        exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.forall)
      ) {
        if (i !== 0) {
          throw this.formatErrorMessage(
            parameterExpr.token,
            `Expected type parameters to be the first argument, got ${i + 1}`
          );
        }
        const typeParameterExprs = parameterExpr.args;

        // Check if enough type parameters are provided
        // given the expected function type
        if (
          expectedFunctionType &&
          expectedFunctionType.typeParameters.length !==
            typeParameterExprs.length
        ) {
          throw this.formatErrorMessage(
            parameterExpr.token,
            `Expected ${expectedFunctionType.typeParameters.length} type parameters, got ${typeParameterExprs.length}`
          );
        }

        for (let j = 0; j < typeParameterExprs.length; j++) {
          const typeParameterExpr = typeParameterExprs[j]!;
          const { parameter, env: nextEnv } = this.evaluateFunctionParameter({
            expr: typeParameterExpr,
            env,
            expectedParameter: expectedFunctionType?.typeParameters?.[j],
            context: {
              ...context,
            },
          });

          // Check if there is duplicate labels
          const duplicateLabel = typeParameters.find(
            (element) => element.label === parameter.label
          );
          if (duplicateLabel) {
            throw this.formatErrorMessage(
              typeParameterExpr.token,
              `Duplicate label "${parameter.label}" in type parameter`
            );
          }

          // Require parameter to be compile-time only
          if (!parameter.isCompileTimeOnly) {
            throw this.formatErrorMessage(
              parameter.exprs.labelExpr?.token ?? typeParameterExpr.token,
              `Expected type parameter to be compile-time only, got ${exprToString(
                typeParameterExpr
              )}`
            );
          }

          typeParameters.push(parameter);
          env = nextEnv;
        }
      }
      // Check if it's the implicit parameters
      else if (
        exprIsFunctionCall(parameterExpr) &&
        exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.implicit)
      ) {
        if (i !== parameterExprs.length - 1) {
          throw this.formatErrorMessage(
            parameterExpr.token,
            `Expected implicit parameters to be the last argument, got ${i + 1}`
          );
        }

        const implicitParameterExprs = parameterExpr.args;

        // Check if enough implicit parameters are provided
        // given the expected function type
        if (
          expectedFunctionType &&
          expectedFunctionType.implicitParameters.length !==
            implicitParameterExprs.length
        ) {
          throw this.formatErrorMessage(
            parameterExpr.token,
            `Expected ${expectedFunctionType.implicitParameters.length} implicit parameters, got ${implicitParameterExprs.length}`
          );
        }

        for (let j = 0; j < implicitParameterExprs.length; j++) {
          const implicitParameterExpr = implicitParameterExprs[j]!;
          const { parameter, env: nextEnv } = this.evaluateFunctionParameter({
            expr: implicitParameterExpr,
            env,
            expectedParameter: expectedFunctionType?.implicitParameters?.[j],
            context: {
              ...context,
            },
          });

          // Implicit parameter cannot have default value
          if (parameter.exprs.defaultValueExpr) {
            throw this.formatErrorMessage(
              implicitParameterExpr.token,
              `Implicit parameter cannot have default value, got ${exprToString(
                implicitParameterExpr
              )}`
            );
          }

          // Check if there is duplicate labels
          const duplicateLabel = implicitParameters.find(
            (element) => element.label === parameter.label
          );
          if (duplicateLabel) {
            throw this.formatErrorMessage(
              implicitParameterExpr.token,
              `Duplicate label "${parameter.label}" in implicit parameter`
            );
          }

          // If parameter is compile-time only, then
          // require there is no runtime implicitParameters before it
          if (parameter.isCompileTimeOnly) {
            const runtimeImplicitParameters = implicitParameters.filter(
              (p) => !p.isCompileTimeOnly
            );
            if (runtimeImplicitParameters.length > 0) {
              throw this.formatErrorMessage(
                implicitParameterExpr.token,
                `Compile-time parameters must appear first in the implicit parameter list.`
              );
            }
          }

          implicitParameters.push(parameter);
          env = nextEnv;
        }
      }
      // Normal function parameters
      else {
        const { parameter, env: nextEnv } = this.evaluateFunctionParameter({
          expr: parameterExpr,
          expectedParameter: expectedFunctionType?.parameters?.[i],
          env,
          context: {
            ...context,
          },
        });

        // Check if there is duplicate labels
        const duplicateLabel = parameters.find(
          (element) => element.label === parameter.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(parameterExpr)
              ? (parameterExpr.args[0]?.token ?? parameterExpr.token)
              : parameterExpr.token,
            `Duplicate label "${parameter.label}" in function parameter`
          );
        }

        // If parameter is compile-time only, then
        // require there is no runtime parameters before it
        if (parameter.isCompileTimeOnly) {
          const runtimeParameters = parameters.filter(
            (p) => !p.isCompileTimeOnly
          );
          if (runtimeParameters.length > 0) {
            throw this.formatErrorMessage(
              parameterExpr.token,
              `Compile-time parameters must appear first in the parameter list.`
            );
          }
        }

        parameters.push(parameter);
        env = nextEnv;
      }
    }
    return {
      parameters,
      typeParameters,
      implicitParameters,
      env,
    };
  }

  /**
   * For example:
   * (exists(add: ((i32, i32) -> i32))) => SomeType
   *
   * here "expr" is the expression on the left side of the "=>":
   *
   *   (exists(add: ((i32, i32) -> i32)))
   */
  /*
  private evaluateProofAssumptions({
    expr, // env,
    // context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Expr {

    // let proofExprs: Expr[] = [];
    // if (
    //   exprIsFunctionCall(expr) &&
    //   exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)
    // ) {
    //   proofExprs = expr.args;
    // } else {
    //   proofExprs = [expr];
    // }


    return expr;
  }
  */

  private evaluateFunctionType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "->", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected -> for function type, got:\n${exprToString(expr)}`
      );
    }

    const argListExpr = expr.args[0]!;
    let returnTypeExpr = expr.args[1]!;

    // Handle different forms of parameter lists
    let argList: Expr[] = [];
    if (
      exprIsFunctionCall(argListExpr) &&
      exprIsFunctionCallOf(argListExpr, BuiltinKeywords.tuple)
    ) {
      // Handle tuple-style parameter list: (param1: Type1, param2: Type2)
      argList = argListExpr.args;
    } else {
      argList = [argListExpr];
    } /* else {
      throw this.formatErrorMessage(
        argListExpr.token,
        `Expected tuple for function parameters, got:\n${exprToString(
          argListExpr
        )}`
      );
    }*/

    // Evaluate the parameter list
    const {
      parameters,
      typeParameters,
      implicitParameters,
      env: nextEnv,
    } = this.evaluateFunctionParameters({
      parameterExprs: argList,
      env,
      context: {
        ...context,
      },
    });
    env = nextEnv;

    /// Check if the function is returning compile-time only value.
    let isReturnTypeCompileTimeOnly = false;
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.compt)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnTypeExpr.args.length !== 1) {
        throw this.formatErrorMessage(
          returnTypeExpr.token,
          `Expected one argument for "compt" (or "@"), got ${returnTypeExpr.args.length}`
        );
      }
      returnTypeExpr = returnTypeExpr.args[0]!;
    }

    // Evaluate the return type expression
    const evaluatedReturnType = this.evaluateExpression({
      expr: returnTypeExpr,
      env,
      context: { ...context },
    });

    // Check that the return type is indeed a type
    if (!isTypeValue(evaluatedReturnType.$?.value)) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a type for function return type, got:\n${exprToString(
          returnTypeExpr
        )}`
      );
    }

    let returnType = evaluatedReturnType.$?.value.value;
    if (typeRequiresComptModifier(returnType) && !isReturnTypeCompileTimeOnly) {
      // Try converting to runtime type first
      returnType = convertComptTypeToRuntimeType(returnType);
      // If it still requires compt modifier,
      // then throw an error
      if (typeRequiresComptModifier(returnType)) {
        throw this.formatErrorMessage(
          returnTypeExpr.token,
          `Expected a "compt" (or "@") for return type, like:\n
compt(${exprToString(returnTypeExpr)})

Given type:
${typeToString(returnType)}`
        );
      }
    }

    // If the returnType is compile time only, then
    // we need to make sure all the parameters are compile time only
    if (isReturnTypeCompileTimeOnly) {
      for (const parameter of parameters) {
        if (!parameter.isCompileTimeOnly) {
          throw this.formatErrorMessage(
            getFunctionParameterToken(parameter),
            `Expected all parameters to be compile time only given the return type is compile time only.`
          );
        }
      }

      // Check if all implicitParameters are compile time only
      for (const parameter of implicitParameters) {
        if (!parameter.isCompileTimeOnly) {
          throw this.formatErrorMessage(
            getFunctionParameterToken(parameter),
            `Expected all implicit parameters to be compile time only given the return type is compile time only.`
          );
        }
      }
    }

    // Create the function type
    const functionType = createFunctionType({
      parameters,
      typeParameters,
      implicitParameters,
      return_: {
        type: returnType,
        expr: returnTypeExpr,
        isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      },
      env: popEnvFrame(env, true),
      parametersFrame: env.frames[env.frames.length - 1]!,
      SelfType: context.SelfType,
      ModuleType: context.ModuleType,
    });

    // Pop the environment frame
    env = popEnvFrame(env, true);

    // Set the type and value of the expression
    expr.$ = {
      env,
      value: createTypeValue(functionType),
      type: typeOfType(functionType),
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateStructType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "struct", got:\n${exprToString(expr)}`
      );
    }

    // Create structType with empty elements
    // This is used as the SelfType for the following evaluations.
    const structType = createStructType([]);
    const elements = structType.elements;

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i]!;

      // spread operator for extending another struct type
      // NOTE: Let's disable this for now.
      //       Maybe the spread operator should only work with struct value, not struct type.
      //       It also causes confusion. Like should we extend the type methods there?
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
        const extendedStructExpr = arg.args[0]!;
        // Evaluate the extended struct expression
        const evaluatedExtendedStruct = this.evaluateExpression({
          expr: extendedStructExpr,
          env,
          context: {
            ...context,
            SelfType: structType,
          },
        });
        if (!evaluatedExtendedStruct.$) {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`
          );
        }

        // Check if it's a struct type
        const extendedStructTypeValue = evaluatedExtendedStruct.$.value;
        if (
          !isTypeValue(extendedStructTypeValue) ||
          !isStructType(extendedStructTypeValue.value)
        ) {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Expected a struct type for extending, got ${exprToString(
              extendedStructExpr
            )}`
          );
        }
        const extendedStructType = extendedStructTypeValue.value;

        // Iterate over the elements of the extended struct
        for (const extendedStructElement of extendedStructType.elements) {
          // Check if there is duplicate labels
          // If yes, then override the element
          const duplicateLabelIndex = elements.findIndex(
            (e) => e.label === extendedStructElement.label
          );
          if (duplicateLabelIndex >= 0) {
            // Override the existing one.
            elements[duplicateLabelIndex] = extendedStructElement;
          } else {
            // Add the element to the struct
            elements.push(extendedStructElement);
          }
        }
      }
      // tuple element
      else {
        const { type, env: nextEnv } = this.evaluateTupleElementType({
          expr: arg,
          env,
          tupleElementIndex: i,
          context: { ...context, SelfType: structType },
          forType: "struct",
        });

        // Check if there is duplicate labels
        const duplicateLabel = elements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            `Duplicate label "${type.label}" in struct`
          );
        }

        // Compile-time field must have an assigned value
        if (type.isCompileTimeOnly && !type.assignedValue) {
          throw this.formatErrorMessage(
            type.exprs.expr.token,
            `Compile-time only field "${type.label}" must have an assigned value.`
          );
        }

        elements.push(type);
        env = nextEnv;
      }
    }

    const structTypeValue = createTypeValue(structType);
    expr.$ = {
      env,
      type: structTypeValue.type,
      value: structTypeValue,
      isMutable: false,
      pathCollection: [],
    };

    // Append more information to "struct" token.
    expr.func.$ = expr.$;
    return expr;
  }

  private evaluateEnumType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "enum", got:\n${exprToString(expr)}`
      );
    }

    // Create enumType with empty variants
    const enumType = createEnumType([]);

    // Evaluate the variants
    const variants: EnumVariant[] = enumType.variants;
    const comptElements: TupleElement[] = enumType.elements;

    for (let i = 0; i < expr.args.length; i++) {
      const enumArg = expr.args[i]!;

      // comptime fields
      // eg:
      //   ~~Self.new = (((lhs: Self, rhs: i32) -> i32) {})~~
      //   new :: (((lhs: Self, rhs: i32) -> i32) {})
      if (
        exprIsFunctionCall(enumArg) &&
        (exprIsFunctionCallOf(enumArg, "::", 2) ||
          exprIsFunctionCallOf(enumArg, "=", 2) ||
          exprIsFunctionCallOf(enumArg, "?=", 2))
      ) {
        const arg = enumArg;
        const { type, env: nextEnv } = this.evaluateTupleElementType({
          expr: arg,
          env,
          tupleElementIndex: i,
          context: { ...context, SelfType: enumType },
          forType: "enum",
        });

        // Check if there is duplicate labels
        const duplicateLabel = comptElements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            arg.token,
            `Duplicate label "${type.label}" in enum`
          );
        }

        // Check if it duplicates with the existing variant names
        if (variants.some((v) => v.name === type.label)) {
          throw this.formatErrorMessage(
            arg.token,
            `Duplicate label "${type.label}" in enum variants`
          );
        }

        if (!type.isCompileTimeOnly) {
          throw this.formatErrorMessage(
            arg.token,
            `Expected compile-time only field, got:\n${exprToString(
              type.exprs.expr
            )}`
          );
        }

        // Compile-time field must have an assigned value
        if (type.isCompileTimeOnly && !type.assignedValue) {
          throw this.formatErrorMessage(
            type.exprs.expr.token,
            `Compile-time only field "${type.label}" must have an assigned value.`
          );
        }

        // Disallow to have the default value for union type fields.
        if (type.defaultValue) {
          throw this.formatErrorMessage(
            type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
            `Union type cannot have default value for its elements.`
          );
        }

        comptElements.push(type);
        env = nextEnv;
      }

      // Enum variant
      else {
        if (exprIsAtom(enumArg)) {
          const variantName = enumArg.token.value;
          if (!this.isValidVariableName(enumArg)) {
            throw this.formatErrorMessage(
              enumArg.token,
              `Expected identifier for enum variant, got:\n${exprToString(
                enumArg
              )}`
            );
          }
          variants.push({
            name: variantName,
          });

          // TODO: Check duplicates
        } else {
          if (exprIsFunctionCallOf(enumArg, ":")) {
            throw this.formatErrorMessage(
              enumArg.token,
              `Enum variant with : is not implemented yet`
            );
          }
          if (!this.isValidVariableName(enumArg.func)) {
            throw this.formatErrorMessage(
              enumArg.func.token,
              `Expected identifier for enum variant, got:\n${exprToString(
                enumArg.func
              )}`
            );
          }
          const variantName = enumArg.func.token.value;

          const { type: tupleType, env: nextEnv } =
            this.evaluateTupleElementsType({
              args: enumArg.args,
              env,
              context: {
                ...context,
                SelfType: enumType,
              },
              forType: "enum",
            });
          env = nextEnv;

          // We disallow to have isCompileTimeOnly for enum variant elements.
          // Because enum variant fields cannot be marked as compile-time only.
          for (let i = 0; i < tupleType.elements.length; i++) {
            const element = tupleType.elements[i]!;
            // QUESTION: Should we allow compile-time only field in enum variant?
            // If yes, should we require it to have assignedValue?
            if (element.isCompileTimeOnly) {
              throw this.formatErrorMessage(
                element.exprs.expr.token,
                `Enum variant element cannot be compile-time only, got:\n${exprToString(
                  element.exprs.expr
                )}`
              );
            }
          }

          variants.push({
            name: variantName,
            elements: tupleType.elements,
          });
        }
      }
    }

    const enumTypeValue = createTypeValue(enumType);
    expr.$ = {
      env,
      value: enumTypeValue,
      type: enumTypeValue.type,
      isMutable: false,
      pathCollection: [],
    };

    // Append more information to "enum" token.
    expr.func.$ = expr.$;
    return expr;
  }

  private evaluateUnionType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "union", got:\n${exprToString(expr)}`
      );
    }

    // Create unionType with empty elements
    const unionType = createUnionType([]);

    const elements: TupleElement[] = [];
    unionType.elements = elements;

    const args = expr.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      const { type, env: nextEnv } = this.evaluateTupleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: unionType },
        forType: "union",
      });

      // Check if there is duplicate labels
      const duplicateLabel = elements.find(
        (element) => element.label === type.label
      );
      if (duplicateLabel) {
        throw this.formatErrorMessage(
          exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          `Duplicate label "${type.label}" in tuple`
        );
      }

      // Compile-time field must have an assigned value
      if (type.isCompileTimeOnly && !type.assignedValue) {
        throw this.formatErrorMessage(
          type.exprs.expr.token,
          `Compile-time only field "${type.label}" must have an assigned value.`
        );
      }

      // Disallow to have the default value for union type fields.
      if (type.defaultValue) {
        throw this.formatErrorMessage(
          type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
          `Union type cannot have default value for its elements.`
        );
      }

      elements.push(type);
      env = nextEnv;
    }

    const unionTypeValue = createTypeValue(unionType);
    expr.$ = {
      env,
      value: unionTypeValue,
      type: unionTypeValue.type,
      isMutable: false,
      pathCollection: [],
    };

    // Append more information to "union" token.
    expr.func.$ = expr.$;
    return expr;
  }

  private evaluateModuleType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "module", got:\n${exprToString(expr)}`
      );
    }

    // Create moduleType with empty elements
    const moduleType = createModuleType([], env);
    const elements: TupleElement[] = [];
    moduleType.elements = elements;

    // Push env frame
    env = pushEnvFrame(env);

    const args = expr.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      // NOTE: Type methods are not allowed in module types.
      // spread operator for extending another module
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
        const extendedStructExpr = arg.args[0]!;
        // Evaluate the extended struct expression
        const evaluatedExtendedModuleExpr = this.evaluateExpression({
          expr: extendedStructExpr,
          env,
          context: {
            ...context,
            SelfType: undefined, // No SelfType in module context
            ModuleType: moduleType,
          },
        });
        if (!evaluatedExtendedModuleExpr.$) {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`
          );
        }

        // Check if it's a module type
        const extendedModuleTypeValue = evaluatedExtendedModuleExpr.$.value;
        if (
          !isTypeValue(extendedModuleTypeValue) ||
          !isModuleType(extendedModuleTypeValue.value)
        ) {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Expected a struct type for extending, got ${exprToString(
              extendedStructExpr
            )}`
          );
        }
        const extendedModuleType = extendedModuleTypeValue.value;

        // Iterate over the elements of the extended struct
        for (const extendedModuleElement of extendedModuleType.elements) {
          // Check if there is duplicate labels
          // If yes, then override the element
          const duplicateLabelIndex = elements.findIndex(
            (e) => e.label === extendedModuleElement.label
          );
          if (duplicateLabelIndex >= 0) {
            throw this.formatErrorMessage(
              extendedStructExpr.token,
              `Duplicate label "${extendedModuleElement.label}" in module`
            );
          } else {
            // Add the element to the struct
            elements.push(extendedModuleElement);

            // Add the element to the environment
            const { env: nextEnv } = addVariableToEnv({
              env,
              variable: {
                name: extendedModuleElement.label,
                type: extendedModuleElement.type,
                value: extendedModuleElement.isCompileTimeOnly
                  ? (extendedModuleElement.assignedValue ??
                    createUnknownValue(
                      extendedModuleElement.type,
                      extendedModuleElement.label
                    ))
                  : undefined,
                isCompileTimeOnly: extendedModuleElement.isCompileTimeOnly,
                isImplicit: extendedModuleElement.isImplicit,
                isMutable: false,
                isUndefined: false,
                token: extendedModuleElement.exprs.expr.token,
              },
            });
            env = nextEnv;
          }
        }
      }
      // tuple element
      else {
        const { type: element, env: nextEnv } = this.evaluateModuleElementType({
          expr: arg,
          env,
          tupleElementIndex: i,
          context: {
            ...context,
            SelfType: undefined, // No SelfType in module context
            ModuleType: moduleType,
          },
        });

        // Check if there is duplicate labels
        const duplicateLabel = elements.find(
          (elem) => elem.label === element.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            `Duplicate label "${element.label}" in module`
          );
        }

        elements.push(element);
        env = nextEnv;

        // Expect element to be compile-time only
        if (!element.isCompileTimeOnly) {
          throw this.formatErrorMessage(
            arg.token,
            `Expected compile-time only element for extern module, got ${exprToString(arg)}`
          );
        }

        // Add element to env
        const { env: nextNextEnv } = addVariableToEnv({
          env,
          variable: {
            name: element.label,
            type: element.type,
            value:
              element.assignedValue ??
              createUnknownValue(element.type, element.label),
            isCompileTimeOnly: element.isCompileTimeOnly,
            isImplicit: element.isImplicit,
            isMutable: false,
            isUndefined: false,
            token: element.exprs.expr.token,
          },
        });
        env = nextNextEnv;
      }
    }

    // Pop env frame
    env = popEnvFrame(env);

    const moduleTypeValue = createTypeValue(moduleType);
    expr.$ = {
      env,
      value: moduleTypeValue,
      type: moduleTypeValue.type,
      isMutable: false,
      pathCollection: [],
    };

    // Append more information to "module" token.
    expr.func.$ = expr.$;
    return expr;
  }

  private evaluatePropertyAccess({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, ".")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." for property access, got:\n${exprToString(expr)}`
      );
    }

    if (exprIsFunctionCallOf(expr, ".", 1)) {
      // Expect the argument to be an identifier
      const propertyExpr = expr.args[0]!;
      if (
        !exprIsAtom(propertyExpr) &&
        !this.isValidVariableName(propertyExpr)
      ) {
        throw this.formatErrorMessage(
          propertyExpr.token,
          `Expected identifier for enum variant access, got:\n${exprToString(
            propertyExpr
          )}`
        );
      }

      const expectedEnumType = context.expectedType?.type;
      if (!isEnumType(expectedEnumType)) {
        throw this.formatErrorMessage(
          expr.token,
          `Failed to infer enum variant type.`
        );
      }
      const variantName = propertyExpr.token.value;
      const enumType = expectedEnumType;

      const variant = enumType.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw this.formatErrorMessage(
          propertyExpr.token,
          `Enum variant "${variantName}" not found in enum`
        );
      }
      const newEnumType: EnumType = {
        ...enumType,
        selectedVariantName: variantName,
      };

      /**
       * This is for case like
       * Color :: enum Red, Green, Blue;
       * r := Color.Red;
       */
      if (!variant.elements) {
        expr.$ = {
          env,
          type: newEnumType,
          // FIXME: Support expr.value for comptime evaluation.
          value: createEnumValue(newEnumType, variantName, []),
          isMutable: false,
          pathCollection: [],
        };

        propertyExpr.$ = {
          env,
          type: newEnumType,
          isMutable: false,
          pathCollection: [],
        };
      } else {
        /**
         * This is for case like
         * Shape := enum Circle(i32), Square(i32, i32);
         * c := Shape.Circle(3);
         */
        const enumTypeValue = createTypeValue(newEnumType);
        expr.$ = {
          env,
          value: enumTypeValue,
          type: enumTypeValue.type,
          isMutable: false,
          pathCollection: [],
        };

        propertyExpr.$ = expr.$;
      }
      return expr;
    }

    if (!exprIsFunctionCallOf(expr, ".", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    let objectExpr = expr.args[0]!;
    const propertyExpr = expr.args[1]!;

    // Evaluate object
    objectExpr = this.evaluateExpression({
      expr: objectExpr,
      env,
      context: { ...context },
    });
    if (objectExpr.$?.env) {
      env = objectExpr.$?.env;
    }

    // Check if the object expression is already consumed
    // If yes, then throw an error due to using a consumed expression.
    requireExprNotConsumed(objectExpr, env);

    // NOTE: We shouldn't check borrowings here,
    // because it might be like:
    //   &(point.x); // point.x is borrowed
    //
    //   &(point.y) here objectExpr is Point, if we check borrowing here it will throw error.
    //
    // Check borrowings
    // checkBorrowings(context.borrowings, objectExpr);

    // Check if it's .* for dereference
    if (exprIsAtom(propertyExpr) && propertyExpr.token.value === "*") {
      if (isPtrType(objectExpr.$?.type) || isMutPtrType(objectExpr.$?.type)) {
        const pointerType = objectExpr.$.type;
        const baseType = pointerType.type;
        expr.$ = {
          env,
          type: baseType,
          value: undefined,
          isMutable: isMutPtrType(pointerType),
          isAccessingProperty: true,
          pathCollection: [],
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else if (
        isRefType(objectExpr.$?.type) ||
        isMutRefType(objectExpr.$?.type)
      ) {
        const refType = objectExpr.$.type;
        const baseType = refType.type;
        expr.$ = {
          env,
          type: baseType,
          value: undefined,
          isMutable: isMutRefType(refType),
          isAccessingProperty: true,
          pathCollection: [],
        };
        propertyExpr.$ = expr.$;
        return expr;
      }
    }

    if (isTypeValue(objectExpr.$?.value)) {
      const typeValue = objectExpr.$.value;
      if (isEnumType(typeValue.value)) {
        // Expect propertyExpr to be a symbol atom
        if (!exprIsAtom(propertyExpr)) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Expected identifier for enum variant, got:\n${exprToString(
              propertyExpr
            )}`
          );
        }

        // Check if it's accessing comptime field
        {
          const propertyName = propertyExpr.token.value;
          const field = typeValue.value.elements.find(
            (method) => method.label === propertyName
          );
          if (field) {
            expr.$ = {
              env,
              type: field.type,
              value: field.assignedValue!,
              isMutable: false,
              pathCollection: [],
              isAccessingProperty: true,
            };
            propertyExpr.$ = expr.$;
            return expr;
          }
        }

        const variantName = propertyExpr.token.value;
        // Check if variantName is a valid enum variant
        const enumType = typeValue.value;
        const variant = enumType.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Enum variant "${variantName}" not found in enum`
          );
        }
        const newEnumType: EnumType = {
          ...enumType,
          selectedVariantName: variantName,
        };

        /**
         * This is for case like
         * Color :: enum Red, Green, Blue;
         * Red :: Color.Red;
         */
        if (!variant.elements) {
          expr.$ = {
            env,
            type: newEnumType,
            // FIXME: Support expr.value for comptime evaluation.
            value: createEnumValue(newEnumType, variantName, []),
            isMutable: objectExpr.$.isMutable,
            isAccessingProperty: true,
            pathCollection: [],
          };

          propertyExpr.$ = expr.$;
        } else {
          /**
           * This is for case like
           * Shape := enum Circle(i32), Square(i32, i32);
           * c := Shape.Circle(3);
           */
          const enumTypeValue = createTypeValue(newEnumType);
          expr.$ = {
            env,
            type: enumTypeValue.type,
            value: enumTypeValue,
            isMutable: objectExpr.$.isMutable,
            isAccessingProperty: true,
            pathCollection: [],
          };

          propertyExpr.$ = expr.$;
        }
        return expr;
      }
      // Accessing compt fields of a struct/union type.
      else if (isStructType(typeValue.value) || isUnionType(typeValue.value)) {
        if (!this.isValidVariableName(propertyExpr)) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Expected identifier for struct type method, got:\n${exprToString(
              propertyExpr
            )}`
          );
        }
        const propertyName = propertyExpr.token.value;
        // Check if the type method exists
        const field = typeValue.value.elements.find(
          (property) =>
            property.isCompileTimeOnly && property.label === propertyName
        );
        if (field) {
          expr.$ = {
            env,
            type: field.type,
            value: field.assignedValue!,
            isMutable: false,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        } else {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Struct type property "${propertyName}" not found in struct type`
          );
        }
      }
    }

    let objectType = objectExpr.$?.type;
    // QUESTION: Should we allow only one round here? Like zig.
    while (
      objectType &&
      (isPtrType(objectType) ||
        isMutPtrType(objectType) ||
        isRefType(objectType) ||
        isMutPtrType(objectType))
    ) {
      // Dereference the pointer or reference type
      objectType = objectType.type;
    }

    if (
      isTupleType(objectType) ||
      isStructType(objectType) ||
      isUnionType(objectType)
    ) {
      const elements: TupleElement[] = objectType.elements;
      const objectExprValue = objectExpr.$!.value;

      // Check if it's accessing the tuple element by
      // - number index: point.0
      // - label name:   point.x
      if (exprIsAtom(propertyExpr)) {
        if (propertyExpr.token.type === TokenType.Integer) {
          // Accessing by index is only allowed for tuples.
          if (!isTupleType(objectExpr.$?.type)) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Accessing tuple element by index is only allowed for tuples.`
            );
          }

          const index = parseInt(propertyExpr.token.value, 10);
          if (isNaN(index)) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Expected integer for tuple index, got:\n${exprToString(
                propertyExpr
              )}`
            );
          }

          const runtimeElementsCount = elements.filter(
            (element) => !element.isCompileTimeOnly
          ).length;

          if (index < 0 || index >= runtimeElementsCount) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Index out of bounds: ${index} for accessing element in:\n${typeToString(
                objectExpr.$?.type
              )}`
            );
          }
          const tupleElement = elements[index]!;
          expr.$ = {
            env,
            type: tupleElement.type,
            isMutable: objectExpr.$.isMutable,
            isAccessingProperty: true,
            pathCollection: [
              [
                objectExpr.$.variableName ?? "?", // FIXME
                propertyExpr.token.value,
              ],
            ],
          };
          propertyExpr.$ = expr.$;

          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            let values: (Value | undefined)[] = [];
            if (isTupleValue(objectExprValue)) {
              values = objectExprValue.elements;
            } else if (isStructValue(objectExprValue)) {
              values = objectExprValue.elements;
            }
            expr.$.value = values?.[index];
          }
          return expr;
        } else if (this.isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;
          {
            const tupleElementIndex = elements.findIndex(
              // NOTE: To access comptime only field, use the type instead, not the value.
              // The value can only access runtime fields.
              (element) => element.label === label && !element.isCompileTimeOnly
            );
            if (tupleElementIndex < 0) {
              if (isModuleType(objectExpr.$?.type)) {
                throw this.formatErrorMessage(
                  propertyExpr.token,
                  `Module element "${label}" not found in module type`
                );
              }

              // It could be method call
              expr.$ = undefined;
              return expr;
            }
            const tupleElement = elements[tupleElementIndex]!;
            expr.$ = {
              env,
              type: tupleElement.type,
              isMutable: objectExpr.$!.isMutable,
              isAccessingProperty: true,
              pathCollection: [
                [
                  objectExpr.$!.variableName ?? "?", // FIXME
                  propertyExpr.token.value,
                ],
              ],
            };
            propertyExpr.$ = expr.$;

            // TODO: Support comptime value
            // expr.value = ...
            if (objectExprValue) {
              if (isUnknownValue(objectExprValue)) {
                expr.$.value = createUnknownValue(tupleElement.type);
              } else {
                let values: (Value | undefined)[] = [];
                if (isTupleValue(objectExprValue)) {
                  values = objectExprValue.elements;
                } else if (isStructValue(objectExprValue)) {
                  values = objectExprValue.elements;
                }

                let value = values?.[tupleElementIndex];
                if (!value && tupleElement.isCompileTimeOnly) {
                  value = createUnknownValue(tupleElement.type);
                }

                expr.$.value = value;
              }
            }
            return expr;
          }
        }
      }
    } else if (isModuleType(objectType)) {
      const elements: TupleElement[] = objectType.elements;
      const objectExprValue = objectExpr.$!.value;

      // Check if it's accessing the tuple element by
      // - label name:   SomeModule.some_function
      if (exprIsAtom(propertyExpr)) {
        if (propertyExpr.token.type === TokenType.Integer) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Accessomg module field by index is not allowed, got:\n${exprToString(
              propertyExpr
            )}`
          );
        } else if (this.isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;

          {
            const tupleElementIndex = elements.findIndex(
              (element) => element.label === label
            );
            if (tupleElementIndex < 0) {
              if (isModuleType(objectExpr.$?.type)) {
                throw this.formatErrorMessage(
                  propertyExpr.token,
                  `Module element "${label}" not found in module type`
                );
              }

              // It could be method call
              expr.$ = undefined;
              return expr;
            }
            const tupleElement = elements[tupleElementIndex]!;
            expr.$ = {
              env,
              type: tupleElement.type,
              isMutable: objectExpr.$!.isMutable,
              isAccessingProperty: true,
              pathCollection: [
                [
                  objectExpr.$!.variableName ?? "?", // FIXME
                  propertyExpr.token.value,
                ],
              ],
            };
            propertyExpr.$ = expr.$;

            // TODO: Support comptime value
            // expr.value = ...
            if (objectExprValue) {
              if (isUnknownValue(objectExprValue)) {
                expr.$.value = createUnknownValue(tupleElement.type);
              } else {
                let values: (Value | undefined)[] = [];
                if (isModuleValue(objectExprValue)) {
                  values = objectExprValue.elements;
                }

                let value = values?.[tupleElementIndex];
                if (!value && tupleElement.isCompileTimeOnly) {
                  value = createUnknownValue(tupleElement.type);
                }

                expr.$.value = value;
              }
            }
            return expr;
          }
        }
      }
    } else if (isEnumType(objectType)) {
      if (exprIsAtom(propertyExpr)) {
        if (!this.isValidVariableName(propertyExpr)) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Expected identifier for enum variant property, got:\n${exprToString(
              propertyExpr
            )}`
          );
        }

        const propertyName = propertyExpr.token.value;
        const selectedVariant = objectType.variants.find(
          (variant) => variant.name === objectType.selectedVariantName
        );
        if (selectedVariant) {
          // Check if the property exists in the selected variant
          const fieldIndex = (selectedVariant.elements ?? []).findIndex(
            (property) => property.label === propertyName
          );
          if (fieldIndex < 0) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Enum variant property "${propertyName}" not found in enum variant "${objectType.selectedVariantName}"`
            );
          }
          const field = (selectedVariant.elements ?? [])[fieldIndex]!;

          expr.$ = {
            env,
            type: field.type,
            value: undefined,
            isMutable: objectExpr.$!.isMutable,
            pathCollection: [
              [
                objectExpr.$!.variableName ?? "?", // FIXME
                propertyExpr.token.value,
              ],
            ],
            isAccessingProperty: true,
          };

          // handle comptime value
          const variantValue = objectExpr.$?.value;
          if (
            variantValue &&
            isEnumValue(variantValue) &&
            variantValue.variantName === selectedVariant.name
          ) {
            expr.$.value = variantValue.elements[fieldIndex];
          }

          propertyExpr.$ = expr.$;
          return expr;
        } else {
          // It could be enum method call, so we ignore here.
        }
      }
    }

    // TODO: Evaluate the module method call
    // Since we fail to evaluate the property access
    // it could be an ~~uniform function call~~ module method call.
    expr.$ = undefined;
    return expr;
  }

  private evaluateAnonymousStructValue({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const func = expr.func;
    const args = expr.args;

    // func should be "_"
    if (!exprIsAtom(func) || func.token.value !== "_") {
      throw this.formatErrorMessage(
        func.token,
        `Expected "_" for anonymous struct, got:\n${exprToString(func)}`
      );
    }

    const elements: TupleElement[] = [];
    const values: (Value | undefined)[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      let labelExpr: Expr | undefined = undefined;
      let valueExpr: Expr = arg;
      let label: string | undefined = undefined;

      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
        labelExpr = arg.args[0]!;
        valueExpr = arg.args[1]!;

        if (!this.isValidVariableName(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for anonymous struct element label, got:\n${exprToString(
              labelExpr
            )}`
          );
        }
        label = labelExpr.token.value;
      }

      // Check if it's spread operator
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
        const extendedStructExpr = arg.args[0]!;
        // Evaluate the extended struct expression
        const evaluatedExtendedStruct = this.evaluateExpression({
          expr: extendedStructExpr,
          env,
          context: {
            ...context,
          },
        });
        if (!evaluatedExtendedStruct.$) {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`
          );
        }
        const extendedDataType = evaluatedExtendedStruct.$.type;
        if (isStructType(extendedDataType)) {
          const extendedStructType = extendedDataType;
          const extendedStructValue = evaluatedExtendedStruct.$.value as
            | StructValue
            | undefined;

          // Iterate over the elements of the extended struct
          for (let i = 0; i < extendedStructType.elements.length; i++) {
            const extendedStructElement = extendedStructType.elements[i]!;
            // Check if there is duplicate labels
            // If yes, then override the element
            const duplicateLabelIndex = elements.findIndex(
              (e) => e.label === extendedStructElement.label
            );
            if (duplicateLabelIndex >= 0) {
              // Override the existing one.
              elements[duplicateLabelIndex] = extendedStructElement;

              if (extendedStructValue) {
                // Override the existing value
                values[duplicateLabelIndex] =
                  extendedStructValue.elements[duplicateLabelIndex];
              } else {
                values[duplicateLabelIndex] = undefined;
              }
            } else {
              // Add the element to the struct
              elements.push(extendedStructElement);

              if (extendedStructValue) {
                // Add the value to the struct
                values.push(extendedStructValue.elements[i]!);
              } else {
                values.push(undefined);
              }
            }
          }
        } else {
          throw this.formatErrorMessage(
            extendedStructExpr.token,
            `Expected a struct value for extending, got ${exprToString(
              extendedStructExpr
            )}`
          );
        }
      }
      // Normal element
      else {
        const evaluatedArg = this.evaluateExpression({
          expr: valueExpr,
          env,
          context: {
            ...context,
          },
        });
        if (!evaluatedArg.$) {
          throw this.formatErrorMessage(
            valueExpr.token,
            `Failed to evaluate the anonymous struct element expression: ${exprToString(
              valueExpr
            )}`
          );
        }
        env = evaluatedArg.$.env;
        const type = evaluatedArg.$.type;
        const element: TupleElement = {
          exprs: {
            expr: valueExpr,
            labelExpr: undefined,
            typeExpr: undefined,
            defaultValueExpr: undefined,
            assignedValueExpr: valueExpr,
          },
          type,
          label: label ?? `$element_${randomId()}`,
          isCompileTimeOnly: false, // TODO: Fix this
          isImplicit: false,
        };
        elements.push(element);

        if (evaluatedArg.$.value) {
          values.push(evaluatedArg.$?.value);
        } else {
          values.push(undefined);
        }

        if (labelExpr) {
          labelExpr.$ = evaluatedArg.$;
        }
      }
    }

    // Create structType
    const structType = createStructType(elements);

    // Check if it's comptime value
    let structValue: StructValue | undefined = undefined;
    structValue = values.some((value) => !value)
      ? undefined
      : createStructValue(structType, values as Value[]);

    expr.$ = {
      env,
      type: structType,
      value: structValue,
      isMutable: false,
      pathCollection: [],
    };

    func.$ = {
      env,
      type: typeOfType(structType),
      value: createTypeValue(structType),
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  private evaluateFunctionCall({
    expr,
    env,
    context,
    givenFunc,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    givenFunc?: { type: Type; value: TypeValue | FunctionValue | undefined };
    context: EvaluatorContext;
  }): FuncCallExpr {
    let func = expr.func;
    let args = expr.args;

    // For module method call
    let methodExpr: Expr | undefined = undefined;

    let functions: {
      type: Type;
      value?: Value;
      error?: Error | MoParserError;
    }[] = [];
    if (givenFunc) {
      functions = [givenFunc];
    } else {
      if (exprIsFunctionCall(func)) {
        const functionToCall = this.evaluateExpression({
          expr: func,
          env,
          context: {
            ...context,
          },
        });
        func = functionToCall;

        // Check borrowings
        // NOTE: This is necessary for function like array accessing element by index
        // for example:
        //   mut(xs) := [1, 2, 3];
        //   borrow &!(xs), xs_ref => {
        //     first_element := xs(0); // here `xs` is already borrowed, so we cannot use it.
        //   }
        checkBorrowings(context.borrowings, functionToCall);

        // Check if . property access for module method call
        if (!functionToCall.$?.type) {
          if (
            exprIsFunctionCall(functionToCall) &&
            exprIsFunctionCallOf(functionToCall, ".", 2)
          ) {
            const receiverArg = functionToCall.args[0]!;
            methodExpr = functionToCall.args[1]!;

            // The receiverArg should already be evaluated in the previous step
            // so it should have a type
            const receiverType = receiverArg.$?.type;
            if (!receiverType) {
              throw this.formatErrorMessage(
                receiverArg.token,
                `Expected to be evaluated.`
              );
            }

            // The methodExpr should also be evaluated already
            // so it should have a type
            if (exprIsAtom(methodExpr)) {
              // 1.add(3);
              const methodName = methodExpr.token.value;
              // Get the method with the same name in the interface in the env
              const methods = getMethodsByNameFromEnv(
                env,
                methodName,
                receiverType
              );
              functions = methods.map((method) => ({
                type: method.type,
                value: method.value,
              }));
              // TODO: Autocase to reference/immutable reference
              args = [receiverArg, ...args];
            } else {
              // 1.(Add.add)(3);
              // Try to evaluate the methodExpr
              const nextExpr = this.evaluateExpression({
                expr: methodExpr,
                env,
                context: {
                  ...context,
                },
              });
              if (nextExpr.$?.env) {
                env = nextExpr.$?.env;
              }
              methodExpr = nextExpr;

              const methodType = methodExpr.$?.type;
              const methodValue = methodExpr.$?.value;
              if (!methodType) {
                throw this.formatErrorMessage(
                  methodExpr.token,
                  `Expected to be a function.`
                );
              }
              functions = [
                {
                  type: methodType,
                  value: methodValue,
                },
              ];
              // TODO: Autocase to reference/immutable reference
              args = [receiverArg, ...args];
            }
          } else {
            throw this.formatErrorMessage(
              func.token,
              `Expected type for function call, got ${exprToString(
                functionToCall
              )}`
            );
          }

          /*
      // Check uniform function call syntax
        functionToCall = this.evaluateExpression({
          expr: functionToCall.args[1],
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
          },
        });
        args = [receiverArg, ...args];
        */
        } else {
          functions = [
            {
              type: functionToCall.$.type,
              value: functionToCall.$.value,
            },
          ];
        }
      } else {
        const functionName =
          func.token.type === TokenType.BacktickIdentifier
            ? func.token.value.slice(1, -1) // Convert `add` to add
            : func.token.value;

        // Check _ function
        if (functionName === "_") {
          const expectedType = context.expectedType;
          if (!expectedType) {
            // throw this.formatErrorMessage(
            //   func.token,
            //   `Failed to infer type for _ function`
            // );

            // Make it as an anonymous struct
            return this.evaluateAnonymousStructValue({
              expr,
              env,
              context,
            });
          }
          functions = [
            {
              type: typeOfType(expectedType.type),
              value: createTypeValue(expectedType.type),
            },
          ];

          // Add info to the func token
          func.$ = {
            env,
            type: functions[0]!.type,
            value: functions[0]!.value,
            isMutable: false,
            pathCollection: [],
          };
        }
        // Infix operator is taken as an interface method call
        else if (stringIsOperator(functionName) && expr.isInfix) {
          const firstArg = args[0];
          if (!firstArg) {
            throw this.formatErrorMessage(
              func.token,
              `Expected first argument for operator, got:\n${exprToString(func)}`
            );
          }
          // Evaluate the first argument to get its type
          const evaluatedFirstArg = this.evaluateExpression({
            expr: firstArg,
            env,
            context: {
              ...context,
            },
          });
          const receiverType = evaluatedFirstArg.$?.type;
          if (!receiverType) {
            throw this.formatErrorMessage(
              firstArg.token,
              `Expected to be evaluated.`
            );
          }
          const methodName = functionName;
          methodExpr = func;
          // Get the method with the same name in the interface in the env
          const moduleMethods = getMethodsByNameFromEnv(
            env,
            methodName,
            receiverType
          );
          functions = moduleMethods.map((method) => ({
            type: method.type,
            value: method.value,
          }));
          // No need to change the args
        }
        // Self function call
        else if (functionName === "Self" && context.SelfType) {
          const value = createTypeValue(context.SelfType);
          functions = [
            {
              type: value.type,
              value: value,
            },
          ];
        }
        // Normal function call
        else {
          const functionToCall = this.evaluateExpression({
            expr: func,
            env,
            context: {
              ...context,
            },
          });
          func = functionToCall;

          // Check borrowings
          // NOTE: This is necessary for function like array accessing element by index
          // for example:
          //   mut(xs) := [1, 2, 3];
          //   borrow &!(xs), xs_ref => {
          //     first_element := xs(0); // here `xs` is already borrowed, so we cannot use it.
          //   }
          checkBorrowings(context.borrowings, functionToCall);

          /**
           * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
           */
          const functionVariables = getVariablesFromEnv(env, functionName);
          functions = functionVariables.map((variable) => ({
            type: variable.type,
            value: variable.value,
            isMutable: variable.isMutable,
          }));
        }
      }
    }

    // Find the functions whose parameters match the arguments
    const functionsToCall: FunctionToCall[] = functions.map(
      (functionToCall) => {
        if (isFunctionType(functionToCall.type)) {
          try {
            const result = this.tryToCallFunctionWithArguments({
              functionValue: functionToCall.value as FunctionValue | undefined,
              functionType: functionToCall.type,
              functionCallExpr: func,
              argExprs: args,
              callerEnv: env,
              context: { ...context },
            });
            return {
              ...functionToCall,
              result: {
                kind: "function",
                result,
              },
            };
          } catch (error) {
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: error,
              },
            };
          }
        } else {
          const value = functionToCall.value;

          // struct value
          if (isTypeValue(value) && isStructType(value.value)) {
            try {
              const result = this.tryToCallTypeWithArguments({
                memberElements: value.value.elements,
                functionCallExpr: func,
                argExprs: args,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error,
                },
              };
            }
          }
          // enum value
          else if (isTypeValue(value) && isEnumType(value.value)) {
            const enumType = value.value;
            const selectedVariant = enumType.variants.find(
              (variant) => variant.name === enumType.selectedVariantName
            );
            if (!selectedVariant) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: this.formatErrorMessage(
                    expr.token,
                    `Enum variant not selected for enum type`
                  ),
                },
              };
            } else {
              try {
                const result = this.tryToCallTypeWithArguments({
                  memberElements: selectedVariant.elements || [],
                  functionCallExpr: func,
                  argExprs: args,
                  callerEnv: env,
                  context: { ...context },
                });
                return {
                  ...functionToCall,
                  result: {
                    kind: "type",
                    result,
                  },
                };
              } catch (error) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: error,
                  },
                };
              }
            }
          }
          // union value
          else if (isTypeValue(value) && isUnionType(value.value)) {
            try {
              const result = this.tryToCallTypeWithArguments({
                memberElements: value.value.elements,
                functionCallExpr: func,
                argExprs: args,
                callerEnv: env,
                context: { ...context },
                isUnionType: true,
              });
              return {
                ...functionToCall,
                result: {
                  kind: "type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error,
                },
              };
            }
          }
          // module value
          else if (isTypeValue(value) && isModuleType(value.value)) {
            const moduleType = value.value;
            try {
              const result = this.tryToImplementModuleWithArguments({
                moduleExpr: func,
                moduleType: moduleType,
                argExprs: args,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "module-type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error,
                },
              };
            }
          }
          // function
          else if (isTypeValue(value) && isFunctionType(value.value)) {
            const functionType = value.value;
            try {
              this.tryToImplementFunctionByFunctionType({
                expr: expr,
                functionType: functionType,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "function-type",
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error,
                },
              };
            }
          }
          // array
          else if (isArrayType(functionToCall.type)) {
            try {
              const result = this.tryToCallArrayWithArguments({
                expr,
                arrayType: functionToCall.type,
                arrayValue: functionToCall.value as ArrayValue | undefined,
                argExprs: args,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "array",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error,
                },
              };
            }
          } else {
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: this.formatErrorMessage(
                  func.token,
                  `Invalid function call on type:
${isTypeValue(value) ? typeToString(value.value) : typeToString(functionToCall.type)}`
                ),
              },
            };
          }
        }
      }
    );

    const functionsWithMatchingTypes = functionsToCall.filter(
      (functionToCall) => functionToCall.result.kind !== "error"
    );

    if (functionsWithMatchingTypes.length === 0) {
      if (
        functionsToCall.length === 1 &&
        functionsToCall[0]!.result.kind === "error"
      ) {
        throw functionsToCall[0]!.result.error!; // NOTE: It should have error here.
      }

      throw this.formatErrorMessage(
        func.token,
        `No matching call found with arguments:
${exprToString(expr)}

${functionsToCall.length ? "Available functions:\n" : ""}${functionsToCall
          .map((func) => {
            const error =
              func.result.kind === "error" ? func.result.error : undefined;
            if (error) {
              const errorMessage = error.message;
              // Append 2 spaces ahead each line of the errorMessage
              const errorMessageWithIndent = errorMessage
                .split("\n")
                .map((line) => `  ${line}`)
                .join("\n");

              return `
- ${typeToString(func.type)}
${errorMessageWithIndent}`;
            } else {
              return `${typeToString(func.type)}`;
            }
          })
          .join("\n")}
`
      );
    }
    if (functionsWithMatchingTypes.length > 1) {
      throw this.formatErrorMessage(
        func.token,
        `Ambiguous call with arguments:
${exprToString(expr)}

Found ${functionsWithMatchingTypes.length} matching calls:
${functionsWithMatchingTypes
  .map((func) => `${typeToString(func.type)}`)
  .join("\n")}
`
      );
    }

    const functionToCall = functionsWithMatchingTypes[0]!; // Found the only one function to call
    if (isFunctionType(functionToCall.type)) {
      const functionType = functionToCall.type;

      {
        // It's
        // - Function returns runtime value
        // - Function returns comptime value
        // For function returns comptime value, we can evaluate the function body.
        const { returnType, callerEnv, calleeEnv, argValues, pathCollection } =
          getFunctionCallResult(functionToCall);

        const functionValue = functionToCall.value;
        if (
          functionType.return.isCompileTimeOnly &&
          isFunctionValue(functionValue)
        ) {
          // if (!isFunctionValue(functionValue)) {
          //   throw this.formatErrorMessage(
          //     func.token,
          //     `Expected function value for function call, got:\n${exprToString(
          //       func
          //     )}`
          //   );
          // }

          const { value: returnValue, callerEnv: nextEnv } =
            this.evaluateComptFunctionCall({
              functionCallExpr: expr,
              functionType,
              functionValue,
              argValues,
              callerEnv: callerEnv,
              calleeEnv: calleeEnv,
              context: {
                ...context,
              },
            });

          env = popEnvFrame(nextEnv);
          expr.$ = {
            env,
            type: returnType,
            value: returnValue,
            isMutable: false,
            pathCollection: pathCollection,
          };
        } else {
          env = popEnvFrame(callerEnv);
          expr.$ = {
            env,
            type: returnType,
            isMutable: false,
            pathCollection: pathCollection,
          };

          if (functionType.return.isCompileTimeOnly) {
            // TODO: expr.value should be available for comptime function.
            // We should evaluate its body.
            expr.$.value = createUnknownValue(returnType);
          } else {
            expr.$.value = undefined;
          }
        }

        // Set temp variable which holds the result of the function call
        attachTempVariableToExpr(expr);

        // Attach necessary info to the func
        func.$ = {
          env,
          type: functionToCall.type,
          value: functionToCall.value,
          isMutable: false,
          pathCollection: [],
        };
        if (methodExpr) {
          methodExpr.$ = {
            env,
            type: functionToCall.type,
            value: functionToCall.value,
            isMutable: false,
            pathCollection: [],
          };
        }
      }
      return expr;
    } else {
      const value = functionToCall.value;
      // struct value
      if (isTypeValue(value) && isStructType(value.value)) {
        const structType = value.value;
        expr.$ = {
          env,
          type: structType,
          isMutable: false,
          pathCollection: [],
        };

        const {
          values: memberValues,
          pathCollection,
          callerEnv,
        } = getTypeCallResult(functionToCall);
        env = callerEnv;
        if (!memberValues) {
          throw this.formatErrorMessage(
            func.token,
            `Error evaluating struct call.`
          );
        }
        const structValue = memberValues.some((value) => !value)
          ? undefined
          : createStructValue(structType, memberValues as Value[]);
        expr.$.value = structValue;
        expr.$.pathCollection = pathCollection;
        expr.$.env = env;

        // Attach necessary info to the func
        func.$ = {
          env,
          type: value.type,
          value: value,
          isMutable: false,
          pathCollection: [],
        };
        return expr;
      }
      // enum value
      else if (isTypeValue(value) && isEnumType(value.value)) {
        const enumType = value.value;
        expr.$ = {
          env,
          type: enumType,
          isMutable: false,
          pathCollection: [],
        };
        // FIXME: Support to set value for comptime
        const selectedVariant = enumType.variants.find(
          (variant) => variant.name === enumType.selectedVariantName
        );
        if (!selectedVariant) {
          throw this.formatErrorMessage(
            expr.token,
            `Enum variant not selected for enum type`
          );
        }
        const {
          values: memberValues,
          pathCollection,
          callerEnv,
        } = getTypeCallResult(functionToCall);
        env = callerEnv;

        if (!memberValues) {
          throw this.formatErrorMessage(
            func.token,
            `Error evaluating enum call.`
          );
        }
        if (memberValues.every((v) => !!v)) {
          const enumValue = createEnumValue(
            enumType,
            selectedVariant.name,
            memberValues as Value[]
          );
          expr.$.value = enumValue;
        }
        expr.$.pathCollection = pathCollection;
        expr.$.env = env;

        // Attach necessary info to the func
        func.$ = {
          env,
          type: value.type,
          value: value,
          isMutable: false,
          pathCollection: [],
        };
        return expr;
      }
      // union value
      else if (isTypeValue(value) && isUnionType(value.value)) {
        const unionType = value.value;
        expr.$ = {
          env,
          type: unionType,
          isMutable: false,
          pathCollection: [],
        };
        const { pathCollection, callerEnv } = getTypeCallResult(functionToCall);
        env = callerEnv;
        expr.$.value = undefined;
        expr.$.pathCollection = pathCollection;
        expr.$.env = env;

        // Attach necessary info to the func
        func.$ = {
          env,
          type: value.type,
          value: value,
          isMutable: false,
          pathCollection: [],
        };
        return expr;
      }
      // module value
      else if (isTypeValue(value) && isModuleType(value.value)) {
        const { moduleValue, callerEnv } =
          getModuleTypeCallResult(functionToCall);
        env = callerEnv;

        expr.$ = {
          env,
          type: moduleValue.type,
          value: moduleValue,
          isMutable: false,
          pathCollection: [],
        };

        // Attach necessary info to the func
        func.$ = {
          env,
          type: value.type,
          value: value,
          isMutable: false,
          pathCollection: [],
        };
        return expr;
      }
      // function value
      else if (isTypeValue(value) && isFunctionType(value.value)) {
        // This should already be evaluated.
        /*
        if (!expr.$ || !expr.$.value) {
          throw this.formatErrorMessage(
            func.token,
            `Expected function value for function call, got:\n${exprToString(
              expr
            )}`
          );
        }
        */
        return expr;
      }
      // array
      else if (isArrayType(functionToCall.type)) {
        const arrayType = functionToCall.type;
        const { value } = getArrayCallResult(functionToCall);

        expr.$ = {
          env,
          type: arrayType.elementType,
          value: value,
          /**
           * NOTE: Here func is the array value itself.
           * We read the isMutable and pathCollection from it.
           * This is mainly used for array, for example:
           *   mut(xs) := [1, 2, 3];
           *   borrow &!(xs(0)), xs_ref => {
           *     //      ^ calling here, it is mutable.
           *   }
           */
          isMutable: Boolean(func.$?.isMutable),
          pathCollection: func.$?.pathCollection ?? [],
          /**
           * NOTE: We need to set isAccessingProperty to true here
           * to prevent getting an array element of Linear type.
           */
          isAccessingProperty: true,
        };

        // Attach necessary info to the func
        func.$ = {
          env,
          type: functionToCall.type,
          value: functionToCall.value,
          isMutable: Boolean(func.$?.isMutable),
          pathCollection: func.$?.pathCollection ?? [],
          isAccessingProperty: true,
        };
        return expr;
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Function call is not implemented yet:
${exprToString(expr)}`
    );
  }

  private evaluateFunctionParameterType({
    parameter,
    calleeEnv,
    context,
    functionValue,
  }: {
    parameter: FunctionParameter;
    calleeEnv: Environment;
    context: EvaluatorContext;
    functionValue: FunctionValue | undefined;
  }): { parameterType: Type; calleeEnv: Environment } {
    const typeExpr = parameter.exprs.typeExpr;
    const defaultValueExpr = parameter.exprs.defaultValueExpr;
    if (typeExpr) {
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: cloneExpr(typeExpr),
        env: calleeEnv,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: functionValue?.SelfType,
        },
      });
      if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for parameter, got:\n${exprToString(evaluatedTypeExpr)}`
        );
      }
      if (evaluatedTypeExpr.$?.env) {
        calleeEnv = evaluatedTypeExpr.$?.env;
      }
      const parameterType = evaluatedTypeExpr.$?.value.value;
      return {
        parameterType,
        calleeEnv,
      };
    } else if (defaultValueExpr) {
      const evaluatedDefaultValueExpr = this.evaluateExpression({
        expr: cloneExpr(defaultValueExpr),
        env: calleeEnv,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: functionValue?.SelfType,
        },
      });
      const value = evaluatedDefaultValueExpr.$?.value;
      if (!value) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Expected value for parameter, got:\n${exprToString(defaultValueExpr)}`
        );
      }
      if (evaluatedDefaultValueExpr.$?.env) {
        calleeEnv = evaluatedDefaultValueExpr.$?.env;
      }
      const parameterType = value.type;
      return {
        parameterType,
        calleeEnv,
      };
    } else {
      throw new Error(`Expected either type expr or default value expr`);
    }
  }

  private checkIfFunctionParameterMatchesArgument({
    functionValue,
    parameter,
    argExpr,
    calleeEnv,
    callerEnv,
    context,
  }: {
    functionValue?: FunctionValue;
    /**
     * It could be typeParameters, parameters, or implicitParameters
     */
    parameter: FunctionParameter;
    argExpr: Expr | undefined;
    calleeEnv: Environment;
    callerEnv: Environment;
    context: EvaluatorContext;
  }): {
    calleeEnv: Environment;
    callerEnv: Environment;
    context: EvaluatorContext;
    argValue: Value | undefined;
  } {
    // NOTE: We don't support named argument.
    // But we support to use label for readibility.
    // eg: add(1, 2) vs add(x: 1, y: 2)
    let labelExpr: Expr | undefined = undefined;
    if (
      argExpr &&
      exprIsFunctionCall(argExpr) &&
      exprIsFunctionCallOf(argExpr, ":", 2)
    ) {
      labelExpr = argExpr.args[0]!;
      argExpr = argExpr.args[1]!;

      if (!exprIsAtom(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for label, got:\n${exprToString(labelExpr)}`
        );
      }

      const label = labelExpr.token.value;
      if (parameter.label !== label) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Named argument is not supported. Label is only used for readibility.
    Expected ${
      parameter ? `label "${parameter.label}"` : `no label`
    } at the argument position, but got "${label}".`
        );
      }
    }

    let parameterType = parameter.type;
    if (isFunctionType(parameterType)) {
      // Evaluate the parameter type again.
      // This is for anonymous function type that contains type parameter
      // for example:
      //    (forall(@(T): Type), x: T, callback: ((v: T)-> T))-> T
      // and we call it:
      //    generic_fn(1, fn(x)-> add(x, 1));
      // We can infer `T` is `i32`,
      // But when we evaluate `callback`, we need to evaluate its type again
      // before we evluate the arg

      const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
        this.evaluateFunctionParameterType({
          parameter,
          calleeEnv,
          context: {
            ...context,
          },
          functionValue,
        });
      parameterType = newParameterType;
      calleeEnv = nextCalleeEnv;
    }

    // Evaluate the argExpr
    let evaluatedArgExpr: Expr | undefined = undefined;
    let borrowings = context.borrowings;
    let evaluatedDefaultValueExpr: Expr | undefined = undefined;
    try {
      if (
        !argExpr ||
        (exprIsAtom(argExpr) &&
          exprIsAtomOf(argExpr, BuiltinKeywords.undefined))
      ) {
        // Use the default value
        if (parameter.exprs.defaultValueExpr) {
          evaluatedArgExpr = this.evaluateExpression({
            expr: cloneExpr(parameter.exprs.defaultValueExpr),
            env: calleeEnv,
            context: {
              ...context,
            },
          });
          evaluatedDefaultValueExpr = evaluatedArgExpr;
          if (evaluatedArgExpr.$?.env) {
            calleeEnv = evaluatedArgExpr.$?.env;
          }
          if (argExpr) {
            argExpr.$ = evaluatedArgExpr.$;
          }
        } else {
          throw this.formatErrorMessage(
            argExpr?.token ?? PlaceholderToken,
            `Expected default value for parameter "${parameter.label}"`
          );
        }
      } else {
        evaluatedArgExpr = this.evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
            // isEvaluatingExprAsType: false,
            expectedType: { type: parameterType, env: calleeEnv },
          },
        });
        if (evaluatedArgExpr.$?.env) {
          callerEnv = evaluatedArgExpr.$?.env;
        }
      }
    } catch (error) {
      logger.debug(error);
      throw error;
    }
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr?.token ?? PlaceholderToken,
        `Failed to evaluate argument expression.`
      );
    }

    // Check the borrowings
    if (
      evaluatedArgExpr.$.type &&
      (isMutRefType(evaluatedArgExpr.$.type) ||
        isRefType(evaluatedArgExpr.$.type))
    ) {
      checkBorrowings(context.borrowings, evaluatedArgExpr);

      // Add evaluated arg expr to the borrowings
      borrowings = borrowings.concat([
        {
          expr: evaluatedArgExpr,
          type: evaluatedArgExpr.$.type,
          pathCollection: evaluatedArgExpr.$.pathCollection,
        },
      ]);
    }

    const argType = evaluatedArgExpr.$.type;

    // Cannot assign runtime parameter to compt parameter
    if (!evaluatedArgExpr.$?.value && parameter.isCompileTimeOnly) {
      throw this.formatErrorMessage(
        argExpr?.token ?? PlaceholderToken,
        `Cannot assign runtime argument to compile-time parameter:\n${
          argExpr ? exprToString(argExpr) : ""
        }`
      );
    }

    // Add the arg to the environment
    // console.log("(10) addVariableToEnv");
    const argValue = evaluatedArgExpr.$.value;
    const { env: nextEnv } = addVariableToEnv({
      env: calleeEnv,
      variable: {
        name: parameter.label,
        type: argType,
        isMutable: parameter.isMutable,
        isCompileTimeOnly: parameter.isCompileTimeOnly,
        token: argExpr?.token ?? PlaceholderToken,
        isUndefined: false,
        isImplicit: false,
        value: argValue,
      },
    });
    calleeEnv = nextEnv;

    // Set the arg expr as consumed
    // NOTE: If we evaluated the default value expression,
    // then we don't set the arg expr as consumed,
    // because that's the expression from parameter.exprs.defaultValueExpr
    if (!evaluatedDefaultValueExpr) {
      callerEnv = setExprAsConsumed(evaluatedArgExpr, callerEnv);
    }

    // Synthesize the types
    const { expectedEnv, givenEnv } = this.synthesizeTypes(
      { type: parameterType, env: calleeEnv },
      { type: argType, env: callerEnv }
    );
    calleeEnv = expectedEnv;
    callerEnv = givenEnv;

    // Evaluate the parameter type again
    const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
      this.evaluateFunctionParameterType({
        parameter,
        calleeEnv,
        context: {
          ...context,
        },
        functionValue,
      });
    parameterType = newParameterType;
    calleeEnv = nextCalleeEnv;

    // Compare the types
    if (
      !areTypesCompatible(
        { type: parameterType, env: calleeEnv },
        { type: argType, env: callerEnv }
      )
    ) {
      throw this.formatErrorMessage(
        argExpr?.token ?? PlaceholderToken,
        `Type mismatch for parameter "${parameter.label}":
    Expected: ${typeToString(parameterType)}
    Got:   ${typeToString(argType)}`
      );
    }
    return {
      calleeEnv,
      callerEnv,
      context: { ...context, borrowings },
      argValue,
    };
  }

  /**
   * NOTE: This function will push new frame to the function env,
   * but will not pop frame.
   */
  private tryToCallFunctionWithArguments({
    functionValue,
    functionType,
    functionCallExpr,
    argExprs,
    callerEnv,
    context,
  }: {
    functionValue?: FunctionValue;
    functionType: FunctionType;
    functionCallExpr?: Expr;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
  }): FunctionCallResult {
    const initialBorrowings = [...context.borrowings];

    let forallArgsExpr: FuncCallExpr | undefined = undefined;
    let implicitArgExprs: Expr[] = [];

    const forallArgValues: Value[] = [];
    const argValues: (Value | undefined)[] = [];
    const implicitArgValues: (Value | undefined)[] = [];

    // Check if there is `forall(...)` argument zone.
    // If yes, then it should be the first argument
    //
    // Check if there is `implicit(...)` argument zone.
    // If yes, then it should be the last argument
    const newArgExprs: Expr[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const argExpr = argExprs[i]!;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, BuiltinKeywords.forall)
      ) {
        if (i !== 0) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Expected forall argument to be the first argument, got:\n${exprToString(
              argExpr
            )}`
          );
        }
        forallArgsExpr = argExpr;
        continue;
      }

      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, BuiltinKeywords.implicit)
      ) {
        if (i !== argExprs.length - 1) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Expected implicit argument to be the last argument, got:\n${exprToString(argExpr)}`
          );
        }
        implicitArgExprs = argExpr.args;
        break;
      }

      newArgExprs.push(argExpr);
    }
    argExprs = newArgExprs;

    // Push new frame to env
    callerEnv = pushEnvFrame(callerEnv);
    // Push new frame to function env
    let calleeEnv = pushEnvFrame(functionType.env);

    if (functionType.SelfType) {
      /*
      let typeValue: TypeValue;
      if (isModuleType(functionType.SelfType)) {
        const existingSelfElement = functionType.SelfType.elements.find(
          (e) => e.label === "Self" && isTypeValue(e.assignedValue)
        );
        if (existingSelfElement) {
          typeValue = existingSelfElement.assignedValue as TypeValue;
        } else {
          typeValue = createTypeValue(functionType.SelfType);
        }
      } else {
        typeValue = createTypeValue(functionType.SelfType);
      }
      */
      const typeValue = createTypeValue(functionType.SelfType);

      // Add "Self" to the calleeEnv
      // console.log("(11) addVariableToEnv");
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: "Self",
          token: PlaceholderToken,
          type: typeValue.type,
          isMutable: false,
          isCompileTimeOnly: true,
          isUndefined: false, // Set as initialized
          isImplicit: false,
          value: typeValue,
        },
      });
      calleeEnv = nextEnv;
    }

    for (let i = 0; i < functionType.typeParameters.length; i++) {
      // Add typeParameter to calleeEnv
      const typeParameter = functionType.typeParameters[i]!;
      let typeParameterVariable: Variable | undefined = undefined;
      // NOTE: No need to add typeParameter to env
      //       It will cause the variable shadowing problem.
      if (typeParameter.exprs.labelExpr && typeParameter.label) {
        // console.log("(12) addVariableToEnv");
        const { env: nextEnv, variable } = addVariableToEnv({
          env: calleeEnv,
          variable: {
            name: typeParameter.label,
            token: typeParameter.exprs.labelExpr.token,
            type: typeParameter.type,
            isMutable: false,
            isCompileTimeOnly: true,
            isUndefined: false, // Set as initialized
            isImplicit: false,
            value: createUnknownValue(typeParameter.type, typeParameter.label),
          },
        });
        calleeEnv = nextEnv;
        typeParameterVariable = variable;
      }

      if (forallArgsExpr) {
        let forallArgExpr: Expr | undefined = forallArgsExpr.args[i];
        let labelExpr: Expr | undefined = undefined;

        // Check if it's calling the named argument
        if (
          exprIsFunctionCall(forallArgExpr) &&
          exprIsFunctionCallOf(forallArgExpr, ":", 2)
        ) {
          labelExpr = forallArgExpr.args[0]!;
          forallArgExpr = forallArgExpr.args[1]!;

          // Check if the label is valid
          if (!exprIsAtom(labelExpr)) {
            throw this.formatErrorMessage(
              labelExpr.token,
              `Expected identifier for type parameter label, got:\n${exprToString(labelExpr)}`
            );
          }

          // Check if the label matches the type parameter label
          if (typeParameter.label !== labelExpr.token.value) {
            throw this.formatErrorMessage(
              labelExpr.token,
              `Expected type parameter label "${typeParameter.label}", got "${labelExpr.token.value}".`
            );
          }
        }

        // Check if it's undefined
        let typeValue: Value;
        // Check if it's '_'
        if (exprIsAtom(forallArgExpr) && forallArgExpr.token.value === "_") {
          // _ is a special case, it means to use the inferred type
          // So we don't need to check the type
          continue;
        }
        // Check the default value
        else if (
          !forallArgExpr ||
          (exprIsAtom(forallArgExpr) &&
            exprIsAtomOf(forallArgExpr, BuiltinKeywords.undefined))
        ) {
          // Check if typeParameter has default value
          if (typeParameter.exprs.defaultValueExpr) {
            const evaluatedArgExpr = this.evaluateExpression({
              expr: cloneExpr(typeParameter.exprs.defaultValueExpr),
              env: calleeEnv,
              context: {
                ...context,
              },
            });
            if (evaluatedArgExpr.$?.env) {
              callerEnv = evaluatedArgExpr.$.env;
            }
            if (forallArgExpr) {
              forallArgExpr.$ = evaluatedArgExpr.$;
            }

            if (!isTypeValue(evaluatedArgExpr.$?.value)) {
              throw this.formatErrorMessage(
                forallArgExpr?.token ??
                  functionCallExpr?.token ??
                  PlaceholderToken,
                forallArgExpr
                  ? `Expected type for default value, got:\n${exprToString(forallArgExpr)}`
                  : `Expected type for default value.`
              );
            }
            typeValue = evaluatedArgExpr.$?.value;
          } else {
            throw this.formatErrorMessage(
              forallArgExpr?.token ??
                functionCallExpr?.token ??
                PlaceholderToken,
              `Type parameter does not have default value.`
            );
          }
        } else {
          // Evaluate forallArgExpr
          const evaluatedTypeExpr = this.evaluateExpression({
            expr: forallArgExpr,
            env: callerEnv,
            context: {
              ...context,
              expectedType: { type: typeParameter.type, env: calleeEnv },
            },
          });
          if (evaluatedTypeExpr.$?.env) {
            callerEnv = evaluatedTypeExpr.$.env;
          }
          if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
            throw this.formatErrorMessage(
              forallArgExpr.token,
              `Expected type for argument, got:\n${exprToString(forallArgExpr)}`
            );
          }
          typeValue = evaluatedTypeExpr.$?.value;
        }

        if (labelExpr) {
          labelExpr.$ = {
            env: calleeEnv, // QUESTION: Which env should we use?
            type: typeValue.type,
            value: typeValue,
            isMutable: false,
            pathCollection: [],
          };
        }

        // Compare the types
        if (
          !areTypesCompatible(
            { type: typeParameter.type, env: calleeEnv },
            { type: typeValue.type, env: callerEnv }
          )
        ) {
          throw this.formatErrorMessage(
            forallArgExpr?.token ?? functionCallExpr?.token ?? PlaceholderToken,
            `Type mismatch for type parameter "${typeParameter.label}":
Expected: ${typeToString(typeParameter.type)}
Got:   ${typeToString(typeValue.type)}`
          );
        }

        // Add the type to the env
        if (typeParameter.label) {
          // console.log("(13) addVariableToEnv");
          if (typeParameterVariable) {
            calleeEnv = updateExistingVariable(
              calleeEnv,
              typeParameterVariable,
              {
                ...typeParameterVariable,
                value: typeValue,
              }
            );
          } else {
            const { env: nextEnv } = addVariableToEnv({
              env: calleeEnv,
              variable: {
                name: typeParameter.label,
                token:
                  forallArgExpr?.token ??
                  functionCallExpr?.token ??
                  PlaceholderToken,
                type: typeValue.type,
                isMutable: false,
                isCompileTimeOnly: true,
                isUndefined: false, // Set as initialized
                isImplicit: false,
                value: typeValue,
              },
            });
            calleeEnv = nextEnv;
          }
        }

        // Save to forallArgValues
        forallArgValues.push(typeValue);
      }
    }

    // Check if the parameters match the arguments
    for (let i = 0; i < functionType.parameters.length; i++) {
      const parameter = functionType.parameters[i]!;
      const argExpr: Expr | undefined = argExprs[i];
      const {
        calleeEnv: nextCalleeEnv,
        callerEnv: nextCallerEnv,
        context: nextContext,
        argValue,
      } = this.checkIfFunctionParameterMatchesArgument({
        functionValue,
        parameter,
        argExpr,
        callerEnv,
        calleeEnv,
        context,
      });
      calleeEnv = nextCalleeEnv;
      callerEnv = nextCallerEnv;
      context = nextContext;

      argValues.push(argValue);
    }

    // Synthesize the returnType if context.expectedType is giving
    // The context.expectedType is the expected function return type.
    // QUESTION: Should we run it after evaluating the normal arguments?
    // YES We should do it after evaluating the normal arguments
    // Otherwise it might cause the variable shadowing problem.
    // See example in compt_runtime.yo.
    if (context.expectedType) {
      const { expectedEnv } = this.synthesizeTypes(
        { type: functionType.return.type, env: calleeEnv },
        { type: context.expectedType.type, env: context.expectedType.env }
      );
      calleeEnv = expectedEnv;
      // env = givenEnv; // NOTE: No need to update `env` here
    }

    // Check if the implicit parameters are provided
    for (let i = 0; i < functionType.implicitParameters.length; i++) {
      const implicitParameter = functionType.implicitParameters[i]!;

      // Evaluate its type again
      const {
        parameterType: newImplicitParameterType,
        calleeEnv: nextCalleeEnv,
      } = this.evaluateFunctionParameterType({
        parameter: implicitParameter,
        calleeEnv,
        context: {
          ...context,
        },
        functionValue,
      });
      calleeEnv = nextCalleeEnv;
      let implicitParameterType = newImplicitParameterType;

      // Check if it's provided in implicitArgsExpr
      let implicitArgExpr: Expr | undefined = implicitArgExprs[i];
      let labelExpr: Expr | undefined = undefined;

      // Check if it's calling the named argument
      if (
        exprIsFunctionCall(implicitArgExpr) &&
        exprIsFunctionCallOf(implicitArgExpr, ":", 2)
      ) {
        labelExpr = implicitArgExpr.args[0]!;
        implicitArgExpr = implicitArgExpr.args[1]!;

        // Check if the label is valid
        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for type parameter label, got:\n${exprToString(labelExpr)}`
          );
        }

        // Check if the label matches the type parameter label
        if (implicitParameter.label !== labelExpr.token.value) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected type parameter label "${implicitParameter.label}", got "${labelExpr.token.value}".`
          );
        }
      }

      // Check if it's '_'
      if (
        !implicitArgExpr ||
        (exprIsAtom(implicitArgExpr) && implicitArgExpr.token.value === "_")
      ) {
        // _ is a special case, it means to use the inferred value.
        // So we don't need to check the type
      }
      // NOTE: Default value is not supported for implicit parameters
      else {
        // Evaluate the given implicit argument
        const evaluatedImplicitArg = this.evaluateExpression({
          expr: implicitArgExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: implicitParameterType, env: calleeEnv },
          },
        });
        if (evaluatedImplicitArg.$?.env) {
          callerEnv = evaluatedImplicitArg.$.env;
        }
        const argType = evaluatedImplicitArg.$?.type;
        if (!argType) {
          throw this.formatErrorMessage(
            implicitArgExpr.token,
            `Failed to evaluate implicit argument expression:\n${exprToString(implicitArgExpr)}`
          );
        }

        // Add the arg to the environment
        if (implicitParameter.label) {
          const argValue = evaluatedImplicitArg.$?.value;
          // console.log("(14) addVariableToEnv");
          const { env: nextEnv } = addVariableToEnv({
            env: calleeEnv,
            variable: {
              name: implicitParameter.label,
              type: argType,
              isMutable: implicitParameter.isMutable,
              isCompileTimeOnly: implicitParameter.isCompileTimeOnly,
              token: implicitArgExpr.token,
              isUndefined: false,
              isImplicit: false,
              value: argValue,
            },
          });
          calleeEnv = nextEnv;
        }

        // Synthesize the types
        const { expectedEnv, givenEnv } = this.synthesizeTypes(
          { type: implicitParameterType, env: calleeEnv },
          { type: argType, env: callerEnv }
        );
        calleeEnv = expectedEnv;
        callerEnv = givenEnv;

        // Evaluate the parameter type again
        const {
          parameterType: newImplicitParameterType,
          calleeEnv: nextCalleeEnv,
        } = this.evaluateFunctionParameterType({
          parameter: implicitParameter,
          calleeEnv,
          context: {
            ...context,
          },
          functionValue,
        });
        implicitParameterType = newImplicitParameterType;
        calleeEnv = nextCalleeEnv;

        // Compare the types
        if (
          !areTypesCompatible(
            { type: implicitParameterType, env: calleeEnv },
            { type: argType, env: callerEnv }
          )
        ) {
          throw this.formatErrorMessage(
            implicitArgExpr.token,
            `Type mismatch for implicit parameter "${implicitParameter.label}":
Expected: ${typeToString(implicitParameterType)}
Got:   ${typeToString(argType)}`
          );
        }
        continue; // Found the correct implicit argument
      }

      // =====

      // Check in the env if implicit variable of such type exists
      let implicitVariables = getVariablesFromEnvByFilter(
        callerEnv,
        (variable) => {
          if (
            !(
              Boolean(variable.isImplicit) &&
              Boolean(variable.isCompileTimeOnly) ===
                Boolean(implicitParameter.isCompileTimeOnly)
            )
          ) {
            return false;
          }

          // Check if type matches
          if (
            areTypesCompatible(
              { type: implicitParameterType, env: calleeEnv },
              { type: variable.type, env: callerEnv }
            )
          ) {
            return true;
          }

          // Check if it's a function that has no parameters.
          // (can have type parameters, and implicit parameters).
          // Then try to call that function to check if its return type can
          // match the implicit parameter type
          if (isFunctionType(variable.type)) {
            const funcType = variable.type;
            if (funcType.parameters.length === 0) {
              const funcValue = variable.value;

              if (
                !!funcValue &&
                !!functionValue &&
                funcValue === functionValue
              ) {
                // Prevent infinite loop
                return false;
              }

              try {
                // FIXME: Prevent circular call
                const {
                  returnType,
                  calleeEnv: nextCalleeEnv,
                  callerEnv: nextCallerEnv,
                } = this.tryToCallFunctionWithArguments({
                  argExprs: [],
                  callerEnv,
                  functionType: funcType,
                  functionValue: funcValue as FunctionValue | undefined,
                  functionCallExpr: undefined, // FIXME: <- this is the wrong expr
                  context: {
                    ...context,
                    expectedType: {
                      type: implicitParameterType,
                      env: calleeEnv,
                    },
                  },
                });
                return areTypesCompatible(
                  { type: returnType, env: nextCallerEnv },
                  { type: implicitParameterType, env: nextCalleeEnv }
                );
              } catch {
                // Failed
              }
            }
          }

          return false;
        }
      );
      // Get the max frame level of the implicit variables
      // This is to ensure that we get the most recent implicit variable
      const maxImplicitVariableFrameLevel = Math.max(
        ...implicitVariables.map((variable) => variable.frameLevel)
      );
      implicitVariables = implicitVariables.filter(
        (variable) => variable.frameLevel === maxImplicitVariableFrameLevel
      );

      if (implicitVariables.length === 0) {
        throw this.formatErrorMessage(
          functionCallExpr?.token ?? PlaceholderToken,
          `Implicit parameter is not provided. Expected:
${implicitParameter.label ? `implicit(${implicitParameter.label}) :\n  ${typeToString(implicitParameterType)}` : `implicit ${typeToString(implicitParameterType)}`}`
        );
      }

      if (implicitVariables.length > 1) {
        throw this.formatErrorMessage(
          functionCallExpr?.token ?? PlaceholderToken,
          `Ambiguous implicit parameter:
${implicitParameter.label ? `(${implicitParameter.label} : ${typeToString(implicitParameterType)})` : typeToString(implicitParameterType)}

Found:
${implicitVariables
  .map((variable) => {
    return `- ${variable.name} : ${typeToString(variable.type)}`;
  })
  .join("\n")}
`
        );
      }

      // Add the implicit variable to the function env
      const implicitVariable = implicitVariables[0]!;
      // console.log("(15) addVariableToEnv");
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: implicitVariable.name,
          type: implicitVariable.type,
          isMutable: implicitVariable.isMutable,
          isCompileTimeOnly: implicitVariable.isCompileTimeOnly,
          token: functionCallExpr?.token ?? PlaceholderToken,
          isUndefined: false,
          isImplicit: false,
          value: implicitVariable.value,
        },
        skipCheckingFunctionOverloading: true,
      });
      calleeEnv = nextEnv;

      // Add the implicit variable value to the implicitArgValues
      implicitArgValues.push(implicitVariable.value);
    }

    // Evaluate the function return type again
    const evaluatedFunctionReturnExpr = this.evaluateExpression({
      expr: cloneExpr(functionType.return.expr),
      env: calleeEnv,
      context: { ...context },
    });

    const functionReturnTypeValue = evaluatedFunctionReturnExpr.$?.value;
    if (!isTypeValue(functionReturnTypeValue)) {
      throw this.formatErrorMessage(
        functionCallExpr?.token ?? PlaceholderToken,
        `Function body is not evaluated correctly. Expected to return a type.`
      );
    }
    const returnType = functionReturnTypeValue.value;

    const pathCollection: PathCollection = [];
    if (context.borrowings.length !== initialBorrowings.length) {
      const newBorrowings = context.borrowings.slice(initialBorrowings.length);
      newBorrowings.forEach((borrowing) => {
        const pc = borrowing.pathCollection;
        pc.forEach((path) => {
          pathCollection.push(path);
        });
      });
    }
    return {
      returnType,
      calleeEnv,
      callerEnv,
      pathCollection,
      argValues: {
        args: argValues,
        forallArgs: forallArgValues,
        implicitArgs: implicitArgValues,
      },
    };
  }

  private tryToCallTypeWithArguments({
    memberElements,
    functionCallExpr,
    argExprs,
    callerEnv,
    context,
    isUnionType,
  }: {
    memberElements: TupleElement[];
    functionCallExpr: Expr;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
    isUnionType?: boolean;
  }): TypeCallResult {
    if (argExprs.length > memberElements.length) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Failed to call the type. Too many members provided. Expected ${memberElements.length} arguments, got ${argExprs.length}.`
      );
    }
    if (isUnionType && argExprs.length !== 1) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Failed to call the union type. Expected exactly one argument, got ${argExprs.length}.`
      );
    }

    const initialBorrowings: Borrowing[] = [...context.borrowings];
    let borrowings: Borrowing[] = [...context.borrowings];

    const checkedMemberElements: Set<TupleElement> = new Set();
    const values: (Value | undefined)[] = Array(memberElements.length).fill(
      undefined
    );
    for (let i = 0; i < memberElements.length; i++) {
      let memberElement = memberElements[i]!;
      let argExpr = argExprs[i];
      if (!argExpr) {
        break;
      }

      // Check if it's a label
      let labelExpr: Expr | undefined = undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        labelExpr = argExpr.args[0]!;
        argExpr = argExpr.args[1]!;

        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label, got:\n${exprToString(labelExpr)}`
          );
        }
      }

      if (labelExpr) {
        const label = labelExpr.token.value;
        // Find the matching label in the expectedType
        const paramElement_ = memberElements.find(
          (element) => element.label === label
        );
        if (!paramElement_) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Failed to find "${label}" in the type.`
          );
        } else if (paramElement_.assignedValue) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Cannot use label "${label}" for already assigned value:
${tupleElementToString(paramElement_)}`
          );
        } else {
          memberElement = paramElement_;
        }
      }

      if (checkedMemberElements.has(memberElement)) {
        // Already checked this element
        // We cannot have duplicate labels
        throw this.formatErrorMessage(
          argExpr.token,
          `Type member "${memberElement.label}" is already implemented.`
        );
      }
      const memberElementPositionIndex = memberElements.indexOf(memberElement);

      // Evaluate the argExpr
      const evaluatedArgExpr = this.evaluateExpression({
        expr: argExpr,
        env: callerEnv,
        context: {
          ...context,
          expectedType: { type: memberElement.type, env: callerEnv },
          borrowings,
        },
      });

      if (!evaluatedArgExpr.$) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
        );
      }
      // Set the argExpr as consumed
      callerEnv = setExprAsConsumed(evaluatedArgExpr, evaluatedArgExpr.$.env);

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
        throw this.formatErrorMessage(
          argExpr.token,
          `Type mismatch for type member "${memberElement.label}":
Expected: ${typeToString(memberElement.type)}
Got:   ${typeToString(argType)}`
        );
      }

      // Set the values
      // if (memberElement.isCompileTimeOnly) {
      values[memberElementPositionIndex] = evaluatedArgExpr.$?.value;
      // }
      checkedMemberElements.add(memberElement);
    }

    if (!isUnionType) {
      // Check if any unchecked member elements have no default value
      for (let i = 0; i < memberElements.length; i++) {
        const memberElement = memberElements[i]!;
        if (!checkedMemberElements.has(memberElement)) {
          if (!memberElement.defaultValue && !memberElement.assignedValue) {
            throw this.formatErrorMessage(
              functionCallExpr.token,
              `Type member "${memberElement.label}" is not provided and has no default value or assigned value.`
            );
          } else {
            // Set the default value to values
            // if (memberElement.isCompileTimeOnly) {
            values[i] =
              memberElement.defaultValue ?? memberElement.assignedValue;
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

    return { values, pathCollection, callerEnv };
  }

  private tryToCallArrayWithArguments({
    expr,
    arrayType,
    arrayValue,
    argExprs,
    callerEnv,
    context,
  }: {
    expr: FuncCallExpr;
    arrayType: ArrayType;
    arrayValue: ArrayValue | undefined;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
  }): ArrayCallResult {
    if (argExprs.length !== 1) {
      throw this.formatErrorMessage(
        expr.func.token,
        `Expect 1 argument for accessing array element, got ${argExprs.length}.`
      );
    }

    // Evaluate the first argument
    const argExpr = argExprs[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env: callerEnv,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
      );
    }

    // Check if the argType matches the usize
    const argType = evaluatedArgExpr.$.type;
    if (
      !areTypesCompatible(
        {
          type: createUsizeType(),
          env: callerEnv,
        },
        {
          type: argType,
          env: callerEnv,
        }
      )
    ) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected usize for array index, got:\n${typeToString(argType)}`
      );
    }

    // It's compile time known value
    if (arrayValue) {
      if (isNumberValue(evaluatedArgExpr.$.value)) {
        const index = evaluatedArgExpr.$.value.value;
        if (index < 0 || index >= arrayValue.elements.length) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`
          );
        }
        const value = arrayValue.elements[index]!;
        return { value };
      } else {
        // TODO: Check the index bound?
        const value = createUnknownValue(arrayType.elementType);
        return { value };
      }
    }
    // It's runtime known value
    else {
      return { value: undefined };
    }
  }

  /**
   * expr should be the:
   * functionType(functionBody);
   */
  private tryToImplementFunctionByFunctionType({
    expr,
    functionType,
    callerEnv,
    context,
  }: {
    expr: FuncCallExpr;
    functionType: FunctionType;
    callerEnv: Environment;
    context: EvaluatorContext;
  }): Expr {
    const functionTypeExpr = expr.func;
    const argExprs = expr.args;
    if (argExprs.length !== 1) {
      throw this.formatErrorMessage(
        functionTypeExpr.token,
        `Failed to implement the function. Expected 1 argument for the function body, got ${argExprs.length}.`
      );
    }
    const functionBodyExpr = argExprs[0]!;

    // Add parameters to the env new frame
    let env = pushEnvFrame(
      // QUESTION: Allow to keep the comptime variables, but not the runtime ones?
      // We should also keep the very top (the first) frame, including comptime and runtime variables.
      keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv),
      functionType.parametersFrame
    );

    // Create the function value
    const functionValue: FunctionValue = {
      tag: ValueTag.Function,
      type: functionType,
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcName: undefined,
      funcId: `fn_${randomId()}`,
      calledComptFunctionCaches: [],
      SelfType: context.SelfType, // In theory, this should be undefined.
    };

    // Evaluate the function body
    const evaluatedFunctionBody = this.evaluateBeginExpression({
      expr: functionBodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingFunctionBody: { type: functionType },
        expectedType: {
          type: functionType.return.type,
          env: env, // QUESTION: What should be the env here?
        },
      },
    });
    if (!evaluatedFunctionBody.$) {
      throw this.formatErrorMessage(
        functionBodyExpr.token,
        `Failed to evaluate the function body.`
      );
    }
    env = evaluatedFunctionBody.$.env;

    // Check if the function body type matches the function return type
    const functionBodyReturnType = evaluatedFunctionBody.$.type;
    if (
      !areTypesCompatible(
        { type: functionType.return.type, env },
        { type: functionBodyReturnType, env }
      )
    ) {
      throw this.formatErrorMessage(
        functionType.return.expr.token,
        `Incompatible function return type:
- Expected: ${typeToString(functionType.return.type)}
- Given  : ${typeToString(functionBodyReturnType)}`
      );
    }
    if (
      functionType.return.isCompileTimeOnly &&
      !evaluatedFunctionBody.$.value
    ) {
      throw this.formatErrorMessage(
        functionType.return.expr.token,
        `Expected to return a compile-time value, but got runtime value.`
      );
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Set the function type and value
    expr.$ = {
      env: callerEnv,
      value: functionValue,
      type: functionType,
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  private tryToImplementModuleWithArguments({
    moduleExpr,
    moduleType,
    argExprs,
    callerEnv,
    context,
  }: {
    moduleExpr: Expr;
    moduleType: ModuleType;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
  }): ModuleTypeCallResult {
    if (argExprs.length > moduleType.elements.length) {
      throw this.formatErrorMessage(
        moduleExpr.token,
        `Failed to implement the module. Too many fields provided.`
      );
    }

    callerEnv = pushEnvFrame(callerEnv);

    const elements: (Value | undefined)[] = Array(
      moduleType.elements.length
    ).fill(undefined);
    for (let i = 0; i < moduleType.elements.length; i++) {
      const moduleElement = moduleType.elements[i]!;
      let foundArgExpr = false;
      let label: string | undefined = undefined;
      // Traverse over argExprs to see if there is label for the member
      for (let j = 0; j < argExprs.length; j++) {
        let argExpr = argExprs[j]!;

        // Check if it's a label
        let labelExpr: Expr | undefined;
        if (
          exprIsFunctionCall(argExpr) &&
          exprIsFunctionCallOf(argExpr, ":", 2)
        ) {
          labelExpr = argExpr.args[0]!;
          argExpr = argExpr.args[1]!;

          if (!exprIsAtom(labelExpr)) {
            throw this.formatErrorMessage(
              labelExpr.token,
              `Expected identifier for label, got:\n${exprToString(labelExpr)}`
            );
          }
          label = labelExpr.token.value;
        } else {
          throw this.formatErrorMessage(
            argExpr.token,
            `Expected member label, but got:\n${exprToString(argExpr)}`
          );
        }

        // Check if label exists in the module type
        if (!moduleType.elements.find((e) => e.label === label)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Module member with label "${label}" does not exist in the module type.`
          );
        }

        if (moduleElement.label === label) {
          foundArgExpr = true;

          if (moduleElement.assignedValue) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Module member "${
                moduleElement.label
              }" already has a assigned value:
${valueToString(moduleElement.assignedValue)}`
            );
          }

          // evaluate the module member type again.
          // Check evaluateFunctionParameterType function
          // They should be similar
          let moduleElementType: Type;
          const typeExpr = moduleElement.exprs.typeExpr;
          const defaultValueExpr = moduleElement.exprs.defaultValueExpr;
          if (typeExpr) {
            const evaluatedModuleMember = this.evaluateExpression({
              expr: cloneExpr(typeExpr),
              env: pushEnvFrame(
                moduleType.env,
                callerEnv.frames[callerEnv.frames.length - 1]
              ),
              context: {
                ...context,
                expectedType: undefined,
                SelfType: undefined,
              },
            });
            const evaluatedModuleMemberTypeValue =
              evaluatedModuleMember.$?.value;
            if (!isTypeValue(evaluatedModuleMemberTypeValue)) {
              throw this.formatErrorMessage(
                argExpr.token,
                `Failed to evaluate the module member "${label}"`
              );
            }
            moduleElementType = evaluatedModuleMemberTypeValue.value;
          } else if (defaultValueExpr) {
            const evaluatedValueExpr = this.evaluateExpression({
              expr: cloneExpr(defaultValueExpr),
              env: pushEnvFrame(
                moduleType.env,
                callerEnv.frames[callerEnv.frames.length - 1]
              ),
              context: {
                ...context,
                expectedType: undefined,
                SelfType: undefined,
              },
            });
            const value = evaluatedValueExpr.$?.value;
            if (!value) {
              throw this.formatErrorMessage(
                argExpr.token,
                `Failed to evaluate the module member "${label}"`
              );
            }
            moduleElementType = value.type;
          } else {
            throw this.formatErrorMessage(
              argExpr.token,
              `Module member "${label}" has no type or default value or assigned value.`
            );
          }

          // evaluate the argExpr
          const evaluatedArgExpr = this.evaluateExpression({
            expr: argExpr,
            env: callerEnv,
            context: {
              ...context,
              expectedType: { type: moduleElementType, env: callerEnv },
              SelfType: moduleType,
            },
          });
          const argType = evaluatedArgExpr.$?.type;
          if (!argType) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Failed to evaluate the module member "${label}"`
            );
          }
          if (evaluatedArgExpr.$?.env) {
            callerEnv = evaluatedArgExpr.$.env;
          }

          // Compare the types
          if (
            !areTypesCompatible(
              { type: moduleElementType, env: callerEnv },
              { type: argType, env: callerEnv }
            )
          ) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Type mismatch for the module member "${label}":
Expected: ${typeToString(moduleElementType)}
Got:   ${typeToString(argType)}`
            );
          }
          const argValue = evaluatedArgExpr.$?.value;

          // Save the value to the members
          elements[i] = argValue;
          // Add to the env
          const { env: nextEnv } = addVariableToEnv({
            env: callerEnv,
            variable: {
              name: label,
              type: argType,
              isMutable: false,
              isCompileTimeOnly: true,
              token: argExpr.token,
              isUndefined: false,
              isImplicit: false,
              value: argValue,
            },
            skipCheckingFunctionOverloading: true,
          });
          callerEnv = nextEnv;

          // Add the type information to argExpr
          argExpr.$ = {
            env: callerEnv,
            type: argType,
            value: argValue,
            isMutable: false,
            pathCollection: [],
          };
          if (labelExpr) {
            labelExpr.$ = argExpr.$;
          }
          break;
        }
      }

      if (!foundArgExpr) {
        const defaultValue = moduleElement.defaultValue;
        const assignedValue = moduleElement.assignedValue;
        // Check if moduleMember has default or required value
        if (!defaultValue && !assignedValue) {
          throw this.formatErrorMessage(
            moduleExpr.token,
            `Module member "${moduleElement.label}" is not provided and has no required/default value.`
          );
        }

        if (defaultValue) {
          elements[i] = defaultValue;
        }
        if (assignedValue) {
          elements[i] = assignedValue;
        }

        // Add to the env
        const { env: nextEnv } = addVariableToEnv({
          env: callerEnv,
          variable: {
            name: moduleElement.label,
            type: moduleElement.type,
            isMutable: false,
            isCompileTimeOnly: true,
            token: moduleExpr.token,
            isUndefined: false,
            isImplicit: false,
            value: defaultValue ?? assignedValue,
          },
        });
        callerEnv = nextEnv;
      }
    }

    callerEnv = popEnvFrame(callerEnv);

    // Create the module value
    const moduleValue = createModuleValue(moduleType, elements);
    return { moduleValue, callerEnv };
  }

  /**
   * Calling function that returns compile-time known value.
   * The return value will be cached.
   */
  private evaluateComptFunctionCall({
    functionCallExpr,
    functionType,
    functionValue,
    argValues: argValues_,
    callerEnv,
    calleeEnv,
    context,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    functionValue: FunctionValue;
    argValues: ArgValues;
    callerEnv: Environment;
    calleeEnv: Environment;
    context: EvaluatorContext;
  }): { value: Value; callerEnv: Environment } {
    const unfilteredArgValues: (Value | undefined)[] = [
      ...argValues_.forallArgs,
      ...argValues_.args,
      ...argValues_.implicitArgs,
    ];
    if (unfilteredArgValues.some((val) => !val)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Failed to call the type function. Some arguments are not compile-time evaluated correctly.`
      );
    }
    const argValues: Value[] = unfilteredArgValues as Value[];

    // Check if it's in the cache
    const funcId = functionValue.funcId;
    const calledComptFunctions = functionValue.calledComptFunctionCaches;
    // Check if the function is already called.
    const calledComptFunction = calledComptFunctions.find((cache) => {
      return (
        cache.argValues.length === argValues.length &&
        cache.argValues.every((argValue, index) => {
          const givenArgValue = argValues[index];

          // If argValue is some type, and givenArgValue is not some type,
          // we return false.
          // For example:
          // - Point(T)
          // - Point(i32)
          // given T = i32 in env, areValuesEqual returns true.
          // We don't want to use the cache there.
          if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
            if (
              isSomeType(argValue.value) &&
              !isSomeType(givenArgValue.value)
            ) {
              return false;
            }
          }

          return areValuesEqual(
            { value: argValue, env: cache.env },
            { value: givenArgValue, env: callerEnv }
          );
        })
      ); // Check if the values are equal
    });
    if (calledComptFunction) {
      // Find the cache
      return {
        callerEnv: callerEnv,
        value: calledComptFunction.value,
      };
    }

    // Evaluate functionValue.body with the function env
    const functionBodyExpr = functionValue.body;

    // Create a temporary environment for the function call
    // This is to prevent the infinite loop of calling the same function
    const tempCache: CalledComptFunctionCache = {
      funcId,
      argValues,
      value: createUnknownValue(functionType.return.type),
      env: calleeEnv,
    };
    const caches = [...calledComptFunctions, tempCache];
    const tempCacheIndex = caches.length - 1;
    functionValue.calledComptFunctionCaches = caches;

    // NOTE: We should use the env from the function, not the current env.
    const evaluatedFunctionBody = this.evaluateBeginExpression({
      expr: cloneExpr(functionBodyExpr), // NOTE: Clone here is necessary
      env: calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionBody: {
          type: functionType,
          value: functionValue,
        },
      },
    });
    if (!evaluatedFunctionBody.$) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly`
      );
    }

    // Get the return type value
    const returnValue = evaluatedFunctionBody.$.value;
    if (!returnValue) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly. Expected to return a compile-time known value.`
      );
    }
    if (isTypeValue(returnValue)) {
      const returnType = returnValue.value;
      if (
        isStructType(returnType) ||
        isEnumType(returnType) ||
        isUnionType(returnType) ||
        isModuleType(returnType)
      ) {
        if (!returnType.typeName && functionValue.funcName) {
          returnType.typeName =
            functionValue.funcName +
            `(${argValues.map((v) => valueToString(v)).join(", ")})`;
        }

        if (!returnType.functionValue) {
          returnType.functionValue = functionValue;
        }
      }
    }

    // Update the cache
    caches[tempCacheIndex] = {
      funcId,
      argValues,
      value: returnValue,
      env: evaluatedFunctionBody.$.env,
    };

    return {
      value: returnValue,
      callerEnv: callerEnv,
    };
  }

  private evaluateBeginExpression({
    expr,
    env,
    context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Expr {
    let beginExpressions: Expr[] = [];
    if (
      !exprIsFunctionCall(expr) ||
      !exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
    ) {
      beginExpressions = [expr];
    } else {
      beginExpressions = expr.args;
    }
    const expectedType = context.expectedType;

    // Empty begin
    // return unit
    if (beginExpressions.length === 0) {
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }

    // Push a new environment frame
    env = pushEnvFrame(env);

    // Evaluate expressions
    for (let i = 0; i < beginExpressions.length; i++) {
      const evaluatedExpr = this.evaluateExpression({
        expr: beginExpressions[i]!,
        env,
        context: {
          ...context,
          expectedType:
            i === beginExpressions.length - 1 ? expectedType : undefined,
        },
      });
      if (evaluatedExpr.$?.env) {
        env = evaluatedExpr.$?.env;
      }
    }
    const lastExpr = beginExpressions[beginExpressions.length - 1]!;
    if (!lastExpr.$) {
      throw this.formatErrorMessage(
        lastExpr.token,
        `Last expression in "begin" is not evaluated correctly:\n${exprToString(lastExpr)}`
      );
    }

    // Prevent return reference to the local variable.
    const returnType = lastExpr.$.type;
    if (typeContainsReference(returnType)) {
      // Check the path
      const pathCollection = lastExpr.$.pathCollection;
      for (let i = 0; i < pathCollection.length; i++) {
        const path = pathCollection[i]!;
        const variableName = path[0]!;
        if (variableName) {
          const variables = getVariablesFromEnv(env, variableName);
          if (!variables.length) {
            throw this.formatErrorMessage(
              lastExpr.token,
              `Invalid path detected. It could be a bug of the compiler.`
            );
          }
          const variable = variables[variables.length - 1]!;
          if (
            // Check if the variable name is a local variable
            variable.frameLevel ===
            env.frames.length - 1
          ) {
            // If the variable is a local variable, we cannot return a reference to it
            throw this.formatErrorMessage(
              lastExpr.token,
              `Cannot return value containing reference to the local variable "${variableName}".`
            );
          } else if (
            // Otherwise, expect it to be reference type.
            !(isMutRefType(variable.type) || isRefType(variable.type))
          ) {
            // If the variable is not a reference type, we cannot return a reference to it
            throw this.formatErrorMessage(
              lastExpr.token,
              `Cannot return value containing reference to the variable "${variableName}" of type "${typeToString(
                variable.type
              )}". Expected reference type.`
            );
          }
        }
      }
    }

    // Set the last expression as the return value
    // and mark it as consumed.
    env = setExprAsConsumed(lastExpr, env);

    // Pop the environment frame
    env = popEnvFrame(env);

    expr.$ = {
      env,
      type: lastExpr.$.type,
      value: lastExpr.$.value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateAnonymousModuleBeginExprs({
    beginExprs,
    env,
    context,
    allowPartialModule = false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  }: {
    beginExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
    /**
     * This is mainly used for the vscode extension
     * Even though the module failed to evaluate completely,
     * we still want to return the moduleValue so the hoverProvider and completionProvider can work.
     */
    allowPartialModule?: boolean;
  }): {
    moduleValue: ModuleValue;
    moduleType: ModuleType;
    env: Environment;
    partialModuleError?: Error;
  } {
    // Create module type
    const moduleType = createModuleType([], env);
    const moduleElementValues: (Value | undefined)[] = [];

    let partialModuleError: Error | undefined = undefined;

    // Push new frame to the env
    env = pushEnvFrame(env);

    // Evaluate each expression in the begin
    for (let i = 0; i < beginExprs.length; i++) {
      const expr = beginExprs[i]!;
      try {
        // Export
        if (
          exprIsFunctionCall(expr) &&
          exprIsFunctionCallOf(expr, BuiltinKeywords.export)
        ) {
          const exportExprs = expr.args;
          for (let i = 0; i < exportExprs.length; i++) {
            const exportExpr = exportExprs[i]!;

            // spread operator for export all elements in another module
            if (
              exprIsFunctionCall(exportExpr) &&
              exprIsFunctionCallOf(exportExpr, "...")
            ) {
              const extendedModuleExpr = exportExpr.args[0]!;
              let excludeMembersExpr = exportExpr.args[1];
              // Evaluate the extended struct expression
              const evaluatedExtendedModuleExpr = this.evaluateExpression({
                expr: extendedModuleExpr,
                env,
                context: {
                  ...context,
                  SelfType: undefined, // NOTE: Module doesn't have SelfType
                  ModuleType: moduleType,
                },
              });
              if (!evaluatedExtendedModuleExpr.$) {
                throw this.formatErrorMessage(
                  extendedModuleExpr.token,
                  `Failed to evaluate the extended struct expression:\n${exprToString(extendedModuleExpr)}`
                );
              }
              const extendedModuleType = evaluatedExtendedModuleExpr.$.type;
              if (!isModuleType(extendedModuleType)) {
                throw this.formatErrorMessage(
                  extendedModuleExpr.token,
                  `Expected struct type for export, got:\n${typeToString(extendedModuleType)}`
                );
              }
              const extendedModuleValue = evaluatedExtendedModuleExpr.$
                .value as ModuleValue | undefined;

              const excludedLabels: Set<string> = new Set();
              if (excludeMembersExpr) {
                if (
                  exprIsFunctionCall(excludeMembersExpr) &&
                  exprIsFunctionCallOf(excludeMembersExpr, ":", 2) &&
                  exprIsAtomOf(excludeMembersExpr.args[0]!, "exclude")
                ) {
                  excludeMembersExpr = excludeMembersExpr.args[1]!;
                }
                if (exprIsAtom(excludeMembersExpr)) {
                  const label = excludeMembersExpr.token.value;
                  // Check if the label is in the extended module type
                  const existingElement = extendedModuleType.elements.find(
                    (e) => e.label === label
                  );
                  if (!existingElement) {
                    throw this.formatErrorMessage(
                      excludeMembersExpr.token,
                      `Label "${label}" is not found in the extended module type.`
                    );
                  }
                  // Add the label to the excluded labels
                  excludedLabels.add(label);
                  excludeMembersExpr.$ = {
                    env,
                    type: existingElement.type,
                    value: existingElement.assignedValue,
                    isMutable: false,
                    pathCollection: [],
                  };
                } else {
                  // Check if it's a tuple
                  if (
                    exprIsFunctionCall(excludeMembersExpr) &&
                    exprIsFunctionCallOf(
                      excludeMembersExpr,
                      BuiltinKeywords.tuple
                    )
                  ) {
                    // Iterate over the elements of the tuple
                    for (const memberExpr of excludeMembersExpr.args) {
                      if (!exprIsAtom(memberExpr)) {
                        throw this.formatErrorMessage(
                          memberExpr.token,
                          `Expected identifier for excluded label, got:\n${exprToString(memberExpr)}`
                        );
                      }
                      const label = memberExpr.token.value;
                      // Check if the label is in the extended module type
                      const existingElement = extendedModuleType.elements.find(
                        (e) => e.label === label
                      );
                      if (!existingElement) {
                        throw this.formatErrorMessage(
                          memberExpr.token,
                          `Label "${label}" is not found in the extended module type.`
                        );
                      }
                      // Add the label to the excluded labels
                      excludedLabels.add(label);
                      memberExpr.$ = {
                        env,
                        type: existingElement.type,
                        value: existingElement.assignedValue,
                        isMutable: false,
                        pathCollection: [],
                      };
                    }
                  } else {
                    throw this.formatErrorMessage(
                      excludeMembersExpr.token,
                      `Expected identifier or tuple for excluded labels, got:\n${exprToString(
                        excludeMembersExpr
                      )}`
                    );
                  }
                }
              }

              // Iterate over the elements of the extended struct
              for (let i = 0; i < extendedModuleType.elements.length; i++) {
                const extendedStructElement = extendedModuleType.elements[i]!;
                // Check if the element is excluded
                if (excludedLabels.has(extendedStructElement.label)) {
                  // Skip the element if it's excluded
                  continue;
                }

                // Check if there is duplicate labels
                // If yes, then throw an error
                const existingElementIndex = moduleType.elements.findIndex(
                  (e) => e.label === extendedStructElement.label
                );
                if (existingElementIndex >= 0) {
                  throw this.formatErrorMessage(
                    exportExpr.token,
                    `Element "${extendedStructElement.label}" is already exported in the module.`
                  );
                } else {
                  // Add the element to the module type
                  moduleType.elements.push({
                    label: extendedStructElement.label,
                    type: extendedStructElement.type,
                    isCompileTimeOnly: extendedStructElement.isCompileTimeOnly,
                    isImplicit: extendedStructElement.isImplicit,
                    assignedValue: extendedStructElement.isCompileTimeOnly
                      ? extendedStructElement.assignedValue
                      : undefined,
                    defaultValue: extendedStructElement.defaultValue,
                    exprs: {
                      expr: exportExpr,
                      labelExpr: undefined,
                      typeExpr: undefined,
                      assignedValueExpr: undefined,
                      defaultValueExpr: undefined,
                    },
                  });

                  // Add the value to the module element values
                  if (extendedModuleValue) {
                    moduleElementValues.push(extendedModuleValue.elements[i]);
                  } else {
                    moduleElementValues.push(undefined);
                  }

                  // Add information to exportExpr
                  exportExpr.$ = {
                    env,
                    type: extendedStructElement.type,
                    value: extendedModuleValue
                      ? extendedModuleValue.elements[i]
                      : undefined,
                    isMutable: false, // TODO: Check if the element is mutable
                    pathCollection: [],
                  };
                }
              }
            } else {
              if (!this.isValidVariableName(exportExpr)) {
                throw this.formatErrorMessage(
                  exportExpr.token,
                  `Expected identifier for export, got:\n${exprToString(exportExpr)}`
                );
              }

              const variableName = exportExpr.token.value;
              // Get the variable from the env
              const variables = getVariablesFromEnv(env, variableName);
              if (variables.length === 0) {
                throw this.formatErrorMessage(
                  exportExpr.token,
                  `Variable "${variableName}" is not defined in the module.`
                );
              }
              const variable = variables[variables.length - 1]!;

              // Check if the same variable is already exported
              const existingElementIndex = moduleType.elements.findIndex(
                (e) => e.label === variableName
              );
              if (existingElementIndex >= 0) {
                // Throw error if the variable is already exported
                throw this.formatErrorMessage(
                  exportExpr.token,
                  `Variable "${variableName}" is already exported in the module.`
                );
              } else {
                // Prevent exporting runtime variable
                if (!variable.isCompileTimeOnly) {
                  throw this.formatErrorMessage(
                    exportExpr.token,
                    `Variable "${variableName}" is not a compile-time variable and cannot be exported.`
                  );
                }

                // Add the variable to the module type
                moduleType.elements.push({
                  label: variableName,
                  type: variable.type,
                  isCompileTimeOnly: variable.isCompileTimeOnly,
                  isImplicit: variable.isImplicit,
                  assignedValue: variable.isCompileTimeOnly
                    ? variable.value
                    : undefined,
                  defaultValue: undefined,
                  exprs: {
                    expr: exportExpr,
                    labelExpr: undefined,
                    typeExpr: undefined,
                    assignedValueExpr: undefined,
                    defaultValueExpr: undefined,
                  },
                });
                moduleElementValues.push(variable.value);

                // Add information to exportExpr
                exportExpr.$ = {
                  env,
                  type: variable.type,
                  value: variable.value,
                  isMutable: variable.isMutable,
                  pathCollection: [],
                };
              }
            }
          }
        } else {
          const evaluatedExpr = this.evaluateExpression({
            expr,
            env,
            context: {
              ...context,
              expectedType: undefined,
              SelfType: undefined, // NOTE: Module doesn't have SelfType
              ModuleType: moduleType,
            },
          });
          if (evaluatedExpr.$?.env) {
            env = evaluatedExpr.$?.env;
          }
        }
      } catch (error) {
        if (allowPartialModule) {
          partialModuleError = error;
          break;
        } else {
          throw error;
        }
      }
    }

    // Pop the env frame
    try {
      // NOTE: Pop the env frame here might fail,
      // For example, for any uninitialized variable, or unconsumed linear variables.
      env = popEnvFrame(env);
    } catch (error) {
      if (allowPartialModule) {
        partialModuleError = error;
      } else {
        throw error;
      }
    }

    // Create the module value
    const moduleValue = createModuleValue(moduleType, moduleElementValues);

    return {
      moduleValue,
      moduleType,
      env,
      partialModuleError,
    };
  }

  private evaluateAnonymousModule({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "module", got:\n${exprToString(expr)}`
      );
    }
    if (expr.args.length !== 1) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "module" with 1 argument, got:\n${exprToString(expr)}`
      );
    }
    const moduleBodyExpr = expr.args[0]!;
    if (
      !exprIsFunctionCall(moduleBodyExpr) ||
      !exprIsFunctionCallOf(moduleBodyExpr, BuiltinKeywords.begin)
    ) {
      throw this.formatErrorMessage(
        moduleBodyExpr.token,
        `Expected "begin", got:\n${exprToString(moduleBodyExpr)}`
      );
    }

    const beginExprs = moduleBodyExpr.args;

    const {
      moduleType,
      moduleValue,
      env: nextEnv,
    } = this.evaluateAnonymousModuleBeginExprs({
      beginExprs,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
      },
    });
    env = nextEnv;

    // Set the module value to the expr
    expr.$ = {
      env,
      type: moduleType,
      value: moduleValue,
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  private evaluateModule({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "module", got:\n${exprToString(expr)}`
      );
    }

    if (
      expr.args.length === 1 &&
      exprIsFunctionCall(expr.args[0]) &&
      exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.begin)
    ) {
      return this.evaluateAnonymousModule({ expr, env, context });
    } else {
      return this.evaluateModuleType({ expr, env, context });
    }
  }

  private evaluateTypeOf({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinFunctions.typeof, 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "typeof" with 1 argument, got:\n${exprToString(expr)}`
      );
    }
    const typeExpr = expr.args[0]!;

    // Evaluate the expression
    const evaluatedExpr = this.evaluateExpression({
      expr: typeExpr,
      env,
      context: {
        ...context,
      },
    });
    if (evaluatedExpr.$?.env) {
      env = evaluatedExpr.$.env;
    }

    // Check if the expression has a type
    if (!evaluatedExpr.$?.type) {
      throw this.formatErrorMessage(
        typeExpr.token,
        `Expected type for expression, got:\n${exprToString(typeExpr)}`
      );
    }
    const type = evaluatedExpr.$.type;
    const value = createTypeValue(type);
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateConsume({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinFunctions.consume, 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "consume" with 1 argument, got:\n${exprToString(expr)}`
      );
    }
    const consumeArgExpr = expr.args[0]!;

    // Evaluate the consume argument
    const evaluatedConsumeArgExpr = this.evaluateExpression({
      expr: consumeArgExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedConsumeArgExpr.$) {
      throw this.formatErrorMessage(
        consumeArgExpr.token,
        `Failed to evaluate the consume argument:\n${exprToString(consumeArgExpr)}`
      );
    }

    /*
    // QUESTION: Should we limit the consume argument to Linear type?
    const argType = evaluatedConsumeArgExpr.$.type;
    if (!isLinearOrType0Type(typeOfType(argType))) {
      throw this.formatErrorMessage(
        consumeArgExpr.token,
        `Expected "Linear" type for consume argument, got:\n${exprToString(consumeArgExpr)}`
      );
    }
    */
    // Check if the consume argument is already borrowed
    checkBorrowings(context.borrowings, evaluatedConsumeArgExpr);

    // Set the consume argument as consumed
    env = evaluatedConsumeArgExpr.$.env;
    env = setExprAsConsumed(evaluatedConsumeArgExpr, env);

    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /**
   *
   * Import a module
   *
   */
  private evaluateImport({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.import, 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "import" with 1 argument, got:\n${exprToString(expr)}`
      );
    }

    const moduleArg = expr.args[0]!;
    // TODO: Support comptime string
    // Evaluate the moduleArg
    const evaluatedModuleArg = this.evaluateExpression({
      expr: moduleArg,
      env,
      context: {
        ...context,
      },
    });
    const value = evaluatedModuleArg.$?.value;

    if (!isComptStringValue(value)) {
      throw this.formatErrorMessage(
        moduleArg.token,
        `Expected compt_string for module path, got:\n${exprToString(moduleArg)}`
      );
    }

    // Import the module
    let modulePath = value.value; // Remove the quotes

    // Handle the std library path
    if (modulePath.startsWith("std/")) {
      // std library
      modulePath = path.relative(
        path.dirname(this.modulePath.replace(/^file:\/\//, "")),
        path.resolve(this.stdPath, modulePath.replace("std/", "./"))
      );
    } else if (modulePath === "std") {
      // std library
      modulePath = path.relative(
        path.dirname(this.modulePath.replace(/^file:\/\//, "")),
        path.resolve(this.stdPath, "./prelude.yo")
      ); // Let's set prelude.yo as the default for now
    }

    if (!modulePath.startsWith(".")) {
      throw this.formatErrorMessage(
        moduleArg.token,
        "Only local relative path is supported for now"
      );
    }
    // FIXME: Support other protocol like https://
    let moduleAbsolutePath =
      "file://" +
      path.resolve(
        path.dirname(this.modulePath.replace(/^file:\/\//, "")),
        modulePath
      );
    const extname = path.extname(moduleAbsolutePath);
    if (!extname) {
      moduleAbsolutePath = moduleAbsolutePath + ".yo";
    } else if (extname !== ".yo") {
      throw new Error("Only .yo file is supported for now");
    }

    try {
      // Load the module
      const { moduleValue } = this.loadModule(moduleAbsolutePath);
      expr.$ = {
        env,
        type: moduleValue.type,
        value: moduleValue,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } catch (error) {
      // Failed to load the module
      throw this.formatErrorMessage(
        moduleArg.token,
        `Failed to import module "${modulePath}":\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   *
   * Import everything from a module
   *
   */
  private evaluateOpen({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const moduleArg = expr.args[0];
    if (!moduleArg) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "using" with 1 argument, got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the module
    const evaluatedModuleArg = this.evaluateExpression({
      expr: moduleArg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedModuleArg.$) {
      throw this.formatErrorMessage(
        moduleArg.token,
        `Failed to evaluate the module argument:\n${exprToString(moduleArg)}`
      );
    }

    const moduleValue = evaluatedModuleArg.$.value;
    if (!isModuleValue(moduleValue)) {
      throw this.formatErrorMessage(
        moduleArg.token,
        `Expected module value for "using", got:\n${exprToString(moduleArg)}`
      );
    }

    const moduleType = moduleValue.type;

    // Import everything from the module
    for (let i = 0; i < moduleType.elements.length; i++) {
      const value = moduleValue.elements[i]!;
      const element = moduleType.elements[i]!;
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: element.label,
          type: element.type,
          isMutable: false,
          isCompileTimeOnly: element.isCompileTimeOnly,
          isImplicit: element.isImplicit,
          token: element.exprs.labelExpr?.token ?? element.exprs.expr.token,
          isUndefined: false,
          value: value,
        },
      });
      env = nextEnv;
    }

    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

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
  private evaluateBorrow({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.borrow, 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "borrow" with 2 arguments, got:\n${exprToString(expr)}`
      );
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
      throw this.formatErrorMessage(
        secondExpr.token,
        `Expected "=>" with 2 arguments, got:\n${exprToString(secondExpr)}`
      );
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
      throw this.formatErrorMessage(
        expr.token,
        `Borrowed ${borrowedValueExprs.length} references, but used ${borrowBindingExprs.length}.`
      );
    }

    // Evaluate each borrow arguments
    const borrowings: Borrowing[] = [];
    for (let i = 0; i < borrowedValueExprs.length; i++) {
      const borrowedValueExpr = borrowedValueExprs[i]!;
      const evaluatedBorrowedValueExpr = this.evaluateExpression({
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
        throw this.formatErrorMessage(
          borrowedValueExpr.token,
          `Failed to evaluate the borrowed value:\n${exprToString(
            borrowedValueExpr
          )}`
        );
      }

      // Check if it's a reference type
      if (
        !isRefType(evaluatedBorrowedValueExpr.$.type) &&
        !isMutRefType(evaluatedBorrowedValueExpr.$.type)
      ) {
        throw this.formatErrorMessage(
          borrowedValueExpr.token,
          `Expected reference type for borrowed value, got:\n${typeToString(
            evaluatedBorrowedValueExpr.$.type
          )}`
        );
      }

      borrowings.push({
        expr: evaluatedBorrowedValueExpr,
        type: evaluatedBorrowedValueExpr.$.type,
        pathCollection: evaluatedBorrowedValueExpr.$.pathCollection,
      });
      checkBorrowings([...context.borrowings, ...borrowings]);
    }

    // Add the borrow bindings to the env
    env = pushEnvFrame(env);
    for (let i = 0; i < borrowBindingExprs.length; i++) {
      const bindingExpr = borrowBindingExprs[i]!;
      if (!exprIsAtom(bindingExpr) || !this.isValidVariableName(bindingExpr)) {
        throw this.formatErrorMessage(
          bindingExpr.token,
          `Expected identifier for borrow binding, got:\n${exprToString(
            bindingExpr
          )}`
        );
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
          token: bindingExpr.token,
          isUndefined: false,
          isImplicit: false,
          value: undefined, // borrowing.value,
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
    const evaluatedBorrowBlock = this.evaluateBeginExpression({
      expr: borrowBlockExpr,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
        borrowings: [...context.borrowings, ...borrowings],
      },
    });
    if (!evaluatedBorrowBlock.$) {
      throw this.formatErrorMessage(
        borrowBlockExpr.token,
        `Failed to evaluate the borrow block:\n${exprToString(borrowBlockExpr)}`
      );
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

  /*
  private evaluateExists({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Exists)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "exists" (or "∃"), got:\n${exprToString(expr)}`
      );
    }

    const args = expr.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let labelExpr: Expr | undefined = undefined;
      let typeExpr: Expr = arg;
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
        labelExpr = arg.args[0];
        typeExpr = arg.args[1];
      }

      if (labelExpr && !exprIsAtom(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for label, got:\n${exprToString(labelExpr)}`
        );
      }

      // Evaluate the typeExpr
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
          expectedType: undefined,
          SelfType: undefined,
        },
      });
      if (evaluatedTypeExpr.env) {
        env = evaluatedTypeExpr.env;
      }

      const typeValue = evaluatedTypeExpr.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type, got:\n${exprToString(typeExpr)}`
        );
      }
      const type = typeValue.value;

      if (isModuleType(type)) {
        // Check if the interface is implemented
        if (!type.isImplemented) {
          expr.value = createBooleanValue(false);
          expr.type = expr.value.type;
          expr.env = env;
          return expr;
        }
      } else {
        // Check if the variable of label with type exists in the current env.
        // Check if the variable of type exists in the current env.
        const variables = getVariablesFromEnvByFilter(env, (variable) => {
          // We only check the compile time variables
          if (!variable.isCompileTimeOnly) {
            return false;
          }
          if (labelExpr && variable.name !== labelExpr.token.value) {
            return false;
          }
          return areTypesCompatible(variable.type, type, env);
        });
        // Not found
        if (variables.length === 0) {
          expr.value = createBooleanValue(false);
          expr.type = expr.value.type;
          expr.env = env;
          return expr;
        }
      }
    }

    expr.value = createBooleanValue(true);
    expr.type = expr.value.type;
    expr.env = env;
    return expr;
  }
  */

  /**
   * Check if two types are compatible
   */
  private evaluateAreTypesCompatible({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const args = expr.args;
    const expectedTypeArg = args[0]!;
    const givenTypeArg = args[1]!;

    const evaluatedExpectedTypeArg = this.evaluateExpression({
      expr: expectedTypeArg,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
      },
    });
    if (!isTypeValue(evaluatedExpectedTypeArg.$?.value)) {
      throw this.formatErrorMessage(
        expectedTypeArg.token,
        `Expected type, got:\n${exprToString(expectedTypeArg)}`
      );
    }
    const expectedType = evaluatedExpectedTypeArg.$.value.value;
    env = evaluatedExpectedTypeArg.$.env;

    const evaluatedGivenTypeArg = this.evaluateExpression({
      expr: givenTypeArg,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
      },
    });
    if (!isTypeValue(evaluatedGivenTypeArg.$?.value)) {
      throw this.formatErrorMessage(
        givenTypeArg.token,
        `Expected type, got:\n${exprToString(givenTypeArg)}`
      );
    }
    const givenType = evaluatedGivenTypeArg.$.value.value;
    env = evaluatedGivenTypeArg.$.env;

    // Check if the types are compatible
    const compatible = areTypesCompatible(
      { type: expectedType, env },
      { type: givenType, env }
    );

    // Attach info to the expr
    const booleanValue = createBooleanValue(compatible);
    expr.$ = {
      env,
      type: booleanValue.type,
      value: booleanValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /**
   * Expect having compile error
   */
  private evaluateComptExpectError({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const argExpr = expr.args[0]!;
    const messageExpr = expr.args[1];

    try {
      // Evaluate the expression
      this.evaluateExpression({
        expr: argExpr,
        env,
        context: {
          ...context,
        },
      });
    } catch (error) {
      // The error is expected, so we do nothing
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }

    if (messageExpr) {
      const evaluatedMessageExpr = this.evaluateExpression({
        expr: messageExpr,
        env,
        context: {
          ...context,
        },
      });
      if (evaluatedMessageExpr.$?.value) {
        throw this.formatErrorMessage(
          expr.token,

          isComptStringValue(evaluatedMessageExpr.$.value)
            ? evaluatedMessageExpr.$.value.value
            : valueToString(evaluatedMessageExpr.$.value)
        );
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Expected compile error, but the expression was evaluated successfully:\n${exprToString(argExpr)}`
    );
  }

  private evaluateComptAssert({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const argExpr = expr.args[0]!;
    const messageExpr = expr.args[1];

    // Evaluate the expression
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$ || !isBooleanValue(evaluatedArgExpr.$.value)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected boolean value for "compt_assert", got:\n${exprToString(argExpr)}`
      );
    }
    const booleanValue = evaluatedArgExpr.$.value;
    if (booleanValue.value) {
      // The assertion passed, return unit
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      if (messageExpr) {
        const evaluatedMessageExpr = this.evaluateExpression({
          expr: messageExpr,
          env,
          context: {
            ...context,
          },
        });
        if (evaluatedMessageExpr.$?.value) {
          throw this.formatErrorMessage(
            expr.token,

            isComptStringValue(evaluatedMessageExpr.$.value)
              ? evaluatedMessageExpr.$.value.value
              : valueToString(evaluatedMessageExpr.$.value)
          );
        }
      }

      throw this.formatErrorMessage(
        expr.token,
        `Assertion failed for "compt_assert":\n${exprToString(argExpr)}`
      );
    }
  }

  private evaluateNot({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const notArg = expr.args[0]!;

    // Evaluate the argument expression
    const evaluatedNotArg = this.evaluateExpression({
      expr: notArg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedNotArg.$ || !isBooleanType(evaluatedNotArg.$.type)) {
      throw this.formatErrorMessage(
        notArg.token,
        `Expected boolean type for "not" argument, got:\n${exprToString(notArg)}`
      );
    }

    let value = evaluatedNotArg.$.value;
    if (isBooleanValue(value)) {
      value = createBooleanValue(!value.value);
    }

    expr.$ = {
      env: evaluatedNotArg.$.env,
      type: createBooleanType(),
      value,
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  private evaluateAndOr({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const kind = expr.func.token.value === "and" ? "and" : "or";
    const args = expr.args;

    // Evaluate all args
    const values: (Value | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      const evaluatedArg = this.evaluateExpression({
        expr: arg,
        env,
        context: {
          ...context,
        },
      });
      if (!evaluatedArg.$ || !isBooleanType(evaluatedArg.$.type)) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected boolean type for "${kind}" argument, got:\n${exprToString(arg)}`
        );
      }
      values.push(evaluatedArg.$.value);
      env = evaluatedArg.$.env;
    }

    let value: Value | undefined = undefined;
    if (values.every((val) => isBooleanValue(val))) {
      value = createBooleanValue(
        kind === "and"
          ? values.reduce(
              (acc, val) => acc && (val as BooleanValue).value,
              true
            )
          : values.reduce(
              (acc, val) => acc || (val as BooleanValue).value,
              false
            )
      );
    } else if (values.some((val) => isUnknownValue(val))) {
      value = createUnknownValue(createBooleanType());
    } else {
      value = undefined; // runtime value
    }

    expr.$ = {
      env: env,
      type: createBooleanType(),
      value,
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  /**
   * Explicitly drop a value.
   * This function is related with RAII.
   */
  private evaluateDrop({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "drop":\n${exprToString(
          argExpr
        )}`
      );
    }
    env = evaluatedArgExpr.$.env;

    // Set the expression as consumed
    env = setExprAsConsumed(evaluatedArgExpr, env);

    // TODO: Handle calling drop function.
    // In theory, the Free values will be ignored.

    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /**
   * While loop
   *
   * while condition, step, body
   * while condition, body
   */
  private evaluateWhile({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    let conditionExpr: Expr | undefined;
    let stepExpr: Expr | undefined;
    let bodyExpr: Expr | undefined;

    if (expr.args.length === 2) {
      // while condition, body
      conditionExpr = expr.args[0]!;
      bodyExpr = expr.args[1]!;
    } else if (expr.args.length === 3) {
      // while condition, step, body
      conditionExpr = expr.args[0]!;
      stepExpr = expr.args[1]!;
      bodyExpr = expr.args[2]!;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "while" with 2 or 3 arguments, got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the condition expression
    const evaluatedConditionExpr = this.evaluateExpression({
      expr: conditionExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedConditionExpr.$) {
      throw this.formatErrorMessage(
        conditionExpr.token,
        `Failed to evaluate the condition expression:\n${exprToString(conditionExpr)}`
      );
    }
    if (!isBooleanType(evaluatedConditionExpr.$.type)) {
      throw this.formatErrorMessage(
        conditionExpr.token,
        `Expected boolean type for condition expression, got:\n${exprToString(
          conditionExpr
        )}`
      );
    }

    // Evaluate the body
    const evaluatedBodyExpr = this.evaluateExpression({
      expr: bodyExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedBodyExpr.$) {
      throw this.formatErrorMessage(
        bodyExpr.token,
        `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`
      );
    }
    if (!isUnitType(evaluatedBodyExpr.$.type)) {
      throw this.formatErrorMessage(
        bodyExpr.token,
        `Expected the while loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`
      );
    }

    // Evaluate the step
    if (stepExpr) {
      const evaluatedStepExpr = this.evaluateExpression({
        expr: stepExpr,
        env,
        context: {
          ...context,
        },
      });
      if (!evaluatedStepExpr.$) {
        throw this.formatErrorMessage(
          stepExpr.token,
          `Failed to evaluate the step expression:\n${exprToString(stepExpr)}`
        );
      }
    }

    // return the expr
    expr.$ = {
      env: env,
      isMutable: false,
      pathCollection: [],
      type: VUnit.type,
      value: VUnit,
    };
    return expr;
  }

  private processUnquotesInExpr({
    expr,
    env,
    context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Expr {
    if (exprIsAtom(expr)) {
      return expr;
    } else {
      // If it's a function call, we need to check the args and func
      const func = expr.func;
      const args = expr.args;

      if (
        exprIsAtom(func) &&
        exprIsAtomOf(func, BuiltinKeywords.unquote) &&
        args.length === 1
      ) {
        // If the function is `unquote`, we need to evaluate the first argument
        const arg = args[0]!;
        const evaluatedArg = this.evaluateExpression({
          expr: arg,
          env,
          context: {
            ...context,
          },
        });
        if (
          !evaluatedArg.$ ||
          !isExprType(evaluatedArg.$.type) ||
          !evaluatedArg.$.value
        ) {
          throw this.formatErrorMessage(
            arg.token,
            `Expected expression type for "unquote" argument, got:\n${exprToString(arg)}`
          );
        }
        const exprValue = evaluatedArg.$.value;
        if (isUnknownValue(exprValue)) {
          // If the value is unknown, we return the original expr
          return expr;
        } else if (isExprValue(exprValue)) {
          // If the value is an expression, we return the expression
          return exprValue.value;
        } else {
          // If the value is not an expression, we throw an error
          throw this.formatErrorMessage(
            arg.token,
            `Expected expression value for "unquote" argument, got:\n${valueToString(exprValue)}`
          );
        }
      } else {
        // If it's not a function call of `unquote`, we need to process the func and args
        const newFunc = this.processUnquotesInExpr({
          expr: func,
          env,
          context: {
            ...context,
          },
        });
        const newArgs = args.map((arg) =>
          this.processUnquotesInExpr({
            expr: arg,
            env,
            context: {
              ...context,
            },
          })
        );
        const newExpr = {
          ...expr,
          func: newFunc,
          args: newArgs,
        };
        return newExpr;
      }
    }
  }

  private evaluateQuote({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const quotedExpr = this.processUnquotesInExpr({
      expr: expr.args[0]!,
      env: env,
      context: {
        ...context,
      },
    });

    const exprValue = createExprValue(quotedExpr);
    expr.$ = {
      env,
      type: exprValue.type,
      value: exprValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateGensym({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const prefixArg = expr.args[0];
    let prefix: string = "";
    if (prefixArg) {
      if (expr.args.length > 1) {
        throw this.formatErrorMessage(
          expr.args[1]!.token,
          `Expected "gensym" with 0 or 1 argument, got: ${expr.args.length}`
        );
      }

      // evaluate the prefix argument
      const evaluatedPrefixArg = this.evaluateExpression({
        expr: prefixArg,
        env,
        context: {
          ...context,
        },
      });
      if (!evaluatedPrefixArg.$) {
        throw this.formatErrorMessage(
          prefixArg.token,
          `Failed to evaluate the prefix argument for "gensym":\n${exprToString(
            prefixArg
          )}`
        );
      }
      if (!isComptStringValue(evaluatedPrefixArg.$.value)) {
        throw this.formatErrorMessage(
          prefixArg.token,
          `Expected compt_string for prefix argument, got:\n${exprToString(
            prefixArg
          )}`
        );
      }
      const prefixArgValue = evaluatedPrefixArg.$.value;
      prefix = prefixArgValue.value;
    }

    const symbol = prefix + randomId();
    const atomExpr: AtomExpr = {
      tag: ExprTag.Atom,
      token: {
        modulePath: this.modulePath,
        inputString: this.inputString,
        type: TokenType.Identifier,
        position: expr.func.token.position,
        value: symbol,
      },
    };
    const atomExprValue = createExprValue(atomExpr);

    expr.$ = {
      env,
      isMutable: false,
      pathCollection: [],
      type: atomExprValue.type,
      value: atomExprValue,
    };
    return expr;
  }

  private evaluateYoExprIsAtom({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_is_atom,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    const booleanValue = isExprValue(exprValue)
      ? createBooleanValue(exprIsAtom(exprValue.value))
      : createUnknownValue(createBooleanType());

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: booleanValue.type,
      value: booleanValue,
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  private evaluateYoExprIsFnCall({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_is_fn_call,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    const booleanValue = isExprValue(exprValue)
      ? createBooleanValue(exprIsFunctionCall(exprValue.value))
      : createUnknownValue(createBooleanType());

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: booleanValue.type,
      value: booleanValue,
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  private evaluateYoExprGetFn({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_get_callee,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: createExprType(),
      value: createUnknownValue(createExprType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprValue(exprValue)) {
      if (exprIsFunctionCall(exprValue.value)) {
        const fn = exprValue.value.func;
        const fnExprValue = createExprValue(fn);
        expr.$.value = fnExprValue;
      } else {
        throw this.formatErrorMessage(
          argExpr.token,
          `Expected function call expression for argument, got:\n${exprToString(
            expr
          )}`
        );
      }
    }

    return expr;
  }

  private evaluateYoExprGetArgs({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_get_args,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: createExprListType(),
      value: createUnknownValue(createExprListType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprValue(exprValue)) {
      if (exprIsFunctionCall(exprValue.value)) {
        const fnArgs = exprValue.value.args;
        const fnArgsValue = createExprListValue(
          fnArgs.map((arg) => createExprValue(arg))
        );
        expr.$.value = fnArgsValue;
      } else {
        throw this.formatErrorMessage(
          argExpr.token,
          `Expected function call expression for argument, got:\n${exprToString(
            expr
          )}`
        );
      }
    }

    return expr;
  }

  private evaluateYoExprListCar({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_list_car,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: createExprType(),
      value: createUnknownValue(createExprType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprListValue(exprValue)) {
      const elements = exprValue.elements;
      if (elements.length > 0) {
        expr.$.value = elements[0]!;
      } else {
        throw this.formatErrorMessage(
          argExpr.token,
          `Unexpected empty ExprList for "${expr.func.token.value}" argument`
        );
      }
    }

    return expr;
  }

  private evaluateYoExprListCdr({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_list_cdr,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: createExprListType(),
      value: createUnknownValue(createExprListType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprListValue(exprValue)) {
      const elements = exprValue.elements;
      if (elements.length > 0) {
        expr.$.value = createExprListValue([...elements.slice(1)]);
      } else {
        throw this.formatErrorMessage(
          argExpr.token,
          `Unexpected empty ExprList for "${expr.func.token.value}" argument`
        );
      }
    }

    return expr;
  }

  private evaluateYoExprListCons({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_list_cons,
      2
    );

    const carArg = this.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    // car
    if (!carArg.$) {
      throw this.formatErrorMessage(
        carArg.token,
        `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
          carArg
        )}`
      );
    }
    env = carArg.$.env;
    if (!isExprType(carArg.$.type)) {
      throw this.formatErrorMessage(
        carArg.token,
        `Expected Expr type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          carArg
        )}`
      );
    }
    const carValue = carArg.$.value;
    if (!carValue) {
      throw this.formatErrorMessage(
        carArg.token,
        `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
          carArg
        )}`
      );
    }

    const cdrArg = this.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });
    if (!cdrArg.$) {
      throw this.formatErrorMessage(
        cdrArg.token,
        `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
          cdrArg
        )}`
      );
    }
    env = cdrArg.$.env;
    if (!isExprListType(cdrArg.$.type)) {
      throw this.formatErrorMessage(
        cdrArg.token,
        `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          cdrArg
        )}`
      );
    }
    const cdrValue = cdrArg.$.value;
    if (!cdrValue) {
      throw this.formatErrorMessage(
        cdrArg.token,
        `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
          cdrArg
        )}`
      );
    }

    expr.$ = {
      env: env,
      type: createExprListType(),
      value: createUnknownValue(createExprListType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprValue(carValue)) {
      if (isExprListValue(cdrValue)) {
        // Create a new ExprListValue with the car as the first element
        const newElements = [carValue, ...cdrValue.elements];
        expr.$.value = createExprListValue(newElements);
      } else {
        // cdrValue is unknown
      }
    } else {
      // unknown value;
    }

    return expr;
  }

  private evaluateYoExprListAppend({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_list_append,
      2
    );

    const firstListArg = this.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    // car
    if (!firstListArg.$) {
      throw this.formatErrorMessage(
        firstListArg.token,
        `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
          firstListArg
        )}`
      );
    }
    env = firstListArg.$.env;
    if (!isExprListType(firstListArg.$.type)) {
      throw this.formatErrorMessage(
        firstListArg.token,
        `Expected ExprList type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          firstListArg
        )}`
      );
    }
    const firstListValue = firstListArg.$.value;
    if (!firstListValue) {
      throw this.formatErrorMessage(
        firstListArg.token,
        `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
          firstListArg
        )}`
      );
    }

    const secondListArg = this.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });
    if (!secondListArg.$) {
      throw this.formatErrorMessage(
        secondListArg.token,
        `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
          secondListArg
        )}`
      );
    }
    env = secondListArg.$.env;
    if (!isExprListType(secondListArg.$.type)) {
      throw this.formatErrorMessage(
        secondListArg.token,
        `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          secondListArg
        )}`
      );
    }
    const secondListValue = secondListArg.$.value;
    if (!secondListValue) {
      throw this.formatErrorMessage(
        secondListArg.token,
        `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
          secondListArg
        )}`
      );
    }

    expr.$ = {
      env: env,
      type: createExprListType(),
      value: createUnknownValue(createExprListType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprListValue(firstListValue)) {
      if (isExprListValue(secondListValue)) {
        // merge two ExprList values
        const newElements = [
          ...firstListValue.elements,
          ...secondListValue.elements,
        ];
        expr.$.value = createExprListValue(newElements);
      } else {
        // cdrValue is unknown
      }
    } else {
      // unknown value;
    }

    return expr;
  }

  private evaluateYoExprListLength({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_expr_list_length,
      1
    );

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`
      );
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }
    const exprListValue = evaluatedArgExpr.$.value;
    if (!exprListValue) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`
      );
    }

    expr.$ = {
      env: evaluatedArgExpr.$.env,
      type: createUsizeType(),
      value: createUnknownValue(createUsizeType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isExprListValue(exprListValue)) {
      const length = exprListValue.elements.length;
      const lengthValue = createNumberValue(ValueTag.Usize, length);
      expr.$.value = lengthValue;
    }

    return expr;
  }

  private evaluateYoComptIntArithmetic({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg)) {
      const arg = this.evaluateExpression({
        expr: expr.args[0]!,
        env,
        context: {
          ...context,
        },
      });

      if (!arg.$ || !isComptIntType(arg.$.type) || !arg.$.value) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected compt_int type for "${expr.func.token.value}" argument, got:\n${exprToString(
            arg
          )}`
        );
      }
      env = arg.$.env;

      let value: Value;
      // -(x)
      if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg)) {
        if (isComptIntValue(arg.$.value)) {
          value = createComptIntValue(-arg.$.value.value);
        } else {
          value = createUnknownValue(createComptIntType());
        }
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Unexpected function call for "${expr.func.token.value}", expected "__yo_compt_int_neg
          " function`
        );
      }
      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
    } else {
      const lhs = this.evaluateExpression({
        expr: expr.args[0]!,
        env,
        context: {
          ...context,
        },
      });

      if (!lhs.$ || !isComptIntType(lhs.$.type) || !lhs.$.value) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected compt_int type for "${expr.func.token.value}" first argument, got:\n${exprToString(
            lhs
          )}`
        );
      }
      env = lhs.$.env;

      const rhs = this.evaluateExpression({
        expr: expr.args[1]!,
        env,
        context: {
          ...context,
        },
      });

      if (!rhs.$ || !isComptIntType(rhs.$.type) || !rhs.$.value) {
        throw this.formatErrorMessage(
          rhs.token,
          `Expected compt_int type for "${expr.func.token.value}" second argument, got:\n${exprToString(
            rhs
          )}`
        );
      }
      env = rhs.$.env;

      const lhsValue = lhs.$.value;
      const rhsValue = rhs.$.value;

      let value: Value;

      // x + y
      if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_add)) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createComptIntValue(lhsValue.value + rhsValue.value);
        } else {
          value = createUnknownValue(createComptIntType());
        }
      }
      // x - y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_sub)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createComptIntValue(lhsValue.value - rhsValue.value);
        } else {
          value = createUnknownValue(createComptIntType());
        }
      }
      // x * y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mul)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createComptIntValue(lhsValue.value * rhsValue.value);
        } else {
          value = createUnknownValue(createComptIntType());
        }
      }
      // x / y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_div)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          if (rhsValue.value === 0) {
            throw this.formatErrorMessage(
              rhs.token,
              `Division by zero in "${expr.func.token.value}" operation`
            );
          }

          value = createComptIntValue(
            Math.floor(lhsValue.value / rhsValue.value)
          );
        } else {
          value = createUnknownValue(createComptIntType());
        }
      }
      // x % y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mod)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          if (rhsValue.value === 0) {
            throw this.formatErrorMessage(
              rhs.token,
              `Modulo by zero in "${expr.func.token.value}" operation`
            );
          }

          value = createComptIntValue(
            Math.floor(lhsValue.value % rhsValue.value)
          );
        } else {
          value = createUnknownValue(createComptIntType());
        }
      }
      // x == y
      else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_eq)) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value == rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      }
      // x != y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neq)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value != rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      }
      // x < y
      else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lt)) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value < rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      }
      // x <= y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lte)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value <= rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      }
      // x > y
      else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gt)) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value > rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      }
      // x >= y
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gte)
      ) {
        if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
          value = createBooleanValue(lhsValue.value >= rhsValue.value);
        } else {
          value = createUnknownValue(createBooleanType());
        }
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Unexpected function call for compt_int arithmetic: ${exprToString(
            expr
          )}`
        );
      }

      expr.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
    }

    return expr;
  }

  private evaluateYoTypeToString({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    this.expectExprToBeFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_type_to_string,
      1
    );

    const arg = this.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });
    if (!arg.$) {
      throw this.formatErrorMessage(
        arg.token,
        `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          arg
        )}`
      );
    }
    if (!isTypeHierarchyType(arg.$.type)) {
      throw this.formatErrorMessage(
        arg.token,
        `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`
      );
    }
    const typeValue = arg.$.value;
    if (!typeValue) {
      throw this.formatErrorMessage(
        arg.token,
        `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`
      );
    }

    expr.$ = {
      env: arg.$.env,
      type: createComptStringType(),
      value: createUnknownValue(createComptStringType()), // Will be updated later
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };

    if (isTypeValue(typeValue)) {
      expr.$.value = createComptStringValue(typeToString(typeValue.value));
    }
    return expr;
  }

  private evaluateReferenceCall({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const referenceTypeKind: TypeTag.Ref | TypeTag.MutRef =
      exprIsFunctionCallOf(expr, BuiltinKeywords.Ref)
        ? TypeTag.Ref
        : TypeTag.MutRef;

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for reference:\n${exprToString(
          argExpr
        )}`
      );
    }
    env = evaluatedArgExpr.$.env;

    // Check if the argExpr is a type
    if (isTypeValue(evaluatedArgExpr.$.value)) {
      const typeValue = evaluatedArgExpr.$.value;
      const baseType = typeValue.value;
      // Create the pointer type
      const referenceType =
        referenceTypeKind === TypeTag.Ref
          ? createRefType(baseType)
          : createMutRefType(baseType);
      const typeValueForPointer = createTypeValue(referenceType);
      expr.$ = {
        env,
        type: typeValueForPointer.type,
        value: typeValueForPointer,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      // The arg cannot be consumed.
      requireExprNotConsumed(evaluatedArgExpr, env);

      const argType = evaluatedArgExpr.$.type;
      const referenceType =
        referenceTypeKind === TypeTag.Ref
          ? createRefType(argType)
          : createMutRefType(argType);

      // Check if we are creating a mutable pointer to an immutable value
      if (
        referenceTypeKind === TypeTag.MutRef &&
        !evaluatedArgExpr.$.isMutable
      ) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Cannot create a mutable reference to the immutable:\n${exprToString(
            argExpr
          )}`
        );
      }

      expr.$ = {
        env,
        type: referenceType,
        value: undefined, // reference is only available for runtime
        isMutable: referenceTypeKind === TypeTag.MutRef,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
      attachTempVariableToExpr(expr);
      return expr;
    }
  }

  private evaluateTupleType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (expr.args.length === 0) {
      const value = createTypeValue(createUnitType());
      expr.$ = {
        env,
        value,
        type: value.type,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }

    const { type: tupleType, env: nextEnv } = this.evaluateTupleElementsType({
      args: expr.args,
      env,
      context: { ...context },
      forType: "tuple",
    });
    env = nextEnv;

    // We disallow the tuple elements to have defaultValue for the tuple type
    tupleType.elements.forEach((tupleElement) => {
      if (tupleElement.exprs.defaultValueExpr) {
        throw this.formatErrorMessage(
          tupleElement.exprs.defaultValueExpr!.token,
          `Tuple type cannot have default value.`
        );
      }
    });

    expr.$ = {
      env,
      value: createTypeValue(tupleType),
      type: typeOfType(tupleType),
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  private evaluateArrayType({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Array, 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "Array(@(Type), @(usize))" with 2 arguments, like "Array(i32, 10)"
Got:\n${exprToString(expr)}`
      );
    }

    const elementTypeExpr = expr.args[0]!;
    const lengthExpr = expr.args[1]!;

    // Evaluate the element type expression
    const evaluatedElementTypeExpr = this.evaluateExpression({
      expr: elementTypeExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedElementTypeExpr.$) {
      throw this.formatErrorMessage(
        elementTypeExpr.token,
        `Failed to evaluate the element type expression:\n${exprToString(
          elementTypeExpr
        )}`
      );
    }
    if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
      throw this.formatErrorMessage(
        elementTypeExpr.token,
        `Expected type for element type, got:\n${exprToString(elementTypeExpr)}`
      );
    }
    const elementType = evaluatedElementTypeExpr.$.value.value;

    // Evaluate the length expression
    const evaluatedLengthExpr = this.evaluateExpression({
      expr: lengthExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedLengthExpr.$) {
      throw this.formatErrorMessage(
        lengthExpr.token,
        `Failed to evaluate the length expression:\n${exprToString(lengthExpr)}`
      );
    }
    if (
      !areTypesCompatible(
        {
          type: createUsizeType(),
          env,
        },
        {
          type: evaluatedLengthExpr.$.type,
          env,
        }
      )
    ) {
      throw this.formatErrorMessage(
        lengthExpr.token,
        `Expected usize for length, got:\n${exprToString(lengthExpr)}`
      );
    }

    const lengthValue = evaluatedLengthExpr.$.value;
    if (!lengthValue) {
      throw this.formatErrorMessage(
        lengthExpr.token,
        `Expected compile-time known value for length, got:\n${exprToString(lengthExpr)}`
      );
    }
    if (isUnknownValue(lengthValue)) {
      // QUESTION: Should we do it this way?
      // Change its type to usize
      lengthValue.type = createUsizeType();
    }

    const arrayType = createArrayType(elementType, lengthValue);
    const arrayValue = createTypeValue(arrayType);

    expr.$ = {
      env: evaluatedLengthExpr.$.env,
      type: arrayValue.type,
      value: arrayValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /**
   * Evaluate a raw pointer call
   * For example:
   *
   * I32Ptr :: *(i32);
   * x := 1;
   * p := *(x); // p: *(i32)
   */
  private evaluateRawPointerCall({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const pointerTypeKind: TypeTag.Ptr | TypeTag.MutPtr = exprIsFunctionCallOf(
      expr,
      BuiltinKeywords.Ptr
    )
      ? TypeTag.Ptr
      : TypeTag.MutPtr;

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedArgExpr.$) {
      throw this.formatErrorMessage(
        argExpr.token,
        `Failed to evaluate the argument expression for pointer:\n${exprToString(
          argExpr
        )}`
      );
    }
    env = evaluatedArgExpr.$.env;

    // Check if the argExpr is a type
    if (isTypeValue(evaluatedArgExpr.$.value)) {
      const typeValue = evaluatedArgExpr.$.value;
      const baseType = typeValue.value;
      // Create the pointer type
      const pointerType =
        pointerTypeKind === TypeTag.Ptr
          ? createPtrType(baseType)
          : createMutPtrType(baseType);
      const typeValueForPointer = createTypeValue(pointerType);
      expr.$ = {
        env,
        type: typeValueForPointer.type,
        value: typeValueForPointer,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    } else {
      // The arg cannot be consumed.
      requireExprNotConsumed(evaluatedArgExpr, env);

      // Check borrowings
      checkBorrowings(context.borrowings, evaluatedArgExpr);

      const argType = evaluatedArgExpr.$.type;
      const pointerType =
        pointerTypeKind === TypeTag.Ptr
          ? createPtrType(argType)
          : createMutPtrType(argType);

      // Check if we are creating a mutable pointer to an immutable value
      if (pointerTypeKind === TypeTag.MutPtr && !evaluatedArgExpr.$.isMutable) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Cannot create a mutable pointer to the immutable:\n${exprToString(
            argExpr
          )}`
        );
      }

      expr.$ = {
        env,
        type: pointerType,
        value: undefined, // pointer is only available for runtime
        isMutable: pointerTypeKind === TypeTag.MutPtr,
        pathCollection: [],
      };
      attachTempVariableToExpr(expr);
      return expr;
    }
  }

  private evaluateExpression({
    expr,
    env,
    context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Expr {
    if (exprIsAtom(expr)) {
      switch (expr.token.type) {
        case TokenType.Identifier:
        case TokenType.Operator:
        case TokenType.BacktickIdentifier: {
          return this.evaluateIdentifierAndOperator({
            expr,
            env,
            context: { ...context },
            throwErrorOnUndefined: true,
          });
        }
        case TokenType.Integer: {
          return this.evaluateIntegerLiteral(expr, env);
        }
        case TokenType.Float: {
          return this.evaluateFloatLiteral(expr, env);
        }
        case TokenType.String: {
          return this.evaluateStringLiteral(expr, env);
        }
        case TokenType.Boolean: {
          return this.evaluateBooleanLiteral(expr, env);
        }
        default: {
          throw this.formatErrorMessage(
            expr.token,
            `(1) Evaluating the expression below is not implemented:
${exprToString(expr)}`
          );
        }
      }
    } else {
      if (exprIsFunctionCallOf(expr, ":", 2)) {
        // Binding type
        const { expr: nextExpr } = this.evaluateBinding({ expr, env, context });
        return nextExpr;
      } else if (
        exprIsFunctionCallOf(expr, ":=", 2) ||
        exprIsFunctionCallOf(expr, "::", 2)
      ) {
        // Initialize assignment
        return this.evaluateInitializationAssignment({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "=", 2)) {
        // Assignment
        return this.evaluateAssignment({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "->", 2)) {
        // Function implementation
        if (
          // (fn(x) -> x)
          exprIsFunctionCall(expr.args[0]) &&
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
        ) {
          return this.evaluateAnonymousFunctionImplementation({
            expr,
            env,
            context: { ...context },
          });
        }

        // Function type
        return this.evaluateFunctionType({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
        // recur
        return this.evaluateRecur({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.extern)) {
        // extern
        return this.evaluateExtern({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
        // cond
        return this.evaluateCond({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
        // match
        return this.evaluateMatch({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
        // tuple
        return this.evaluateTupleValue({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
        // array
        return this.evaluateArrayValue({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.expr_list)) {
        // expr_list
        return this.evaluateExprListValue({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
        // struct
        return this.evaluateStructType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
        // enum
        return this.evaluateEnumType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
        // union
        return this.evaluateUnionType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, ".")) {
        // property access
        return this.evaluatePropertyAccess({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
        // begin
        return this.evaluateBeginExpression({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
        // module
        return this.evaluateModule({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeof)) {
        // typeof
        return this.evaluateTypeOf({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
        // consume
        return this.evaluateConsume({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.import)) {
        // import
        return this.evaluateImport({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
        // open
        return this.evaluateOpen({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.borrow)) {
        // borrow
        return this.evaluateBorrow({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.Ptr, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutPtr, 1)
      ) {
        // * or *! raw pointers
        return this.evaluateRawPointerCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.Ref, 1)
      ) {
        // & or &! references
        return this.evaluateReferenceCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Tuple)) {
        // Tuple type
        return this.evaluateTupleType({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Array)) {
        // Array type
        return this.evaluateArrayType({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.are_types_compatible, 2)
      ) {
        // are_types_compatible
        return this.evaluateAreTypesCompatible({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error)
      ) {
        // compt_expect_error
        return this.evaluateComptExpectError({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.compt_assert)) {
        // compt_assert
        return this.evaluateComptAssert({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.not, 1)) {
        // not
        return this.evaluateNot({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.and) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.or)
      ) {
        // and/or
        return this.evaluateAndOr({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.drop, 1)) {
        // drop
        return this.evaluateDrop({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.quote, 1)) {
        // metaprogramming
        // quote
        return this.evaluateQuote({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.gensym)) {
        return this.evaluateGensym({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_atom)
      ) {
        return this.evaluateYoExprIsAtom({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_fn_call)
      ) {
        // __yo_expr_is_fn_call
        return this.evaluateYoExprIsFnCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_callee)
      ) {
        // __yo_expr_get_callee
        return this.evaluateYoExprGetFn({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_args)
      ) {
        // __yo_expr_get_args
        return this.evaluateYoExprGetArgs({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_car)
      ) {
        // __yo_expr_list_car
        return this.evaluateYoExprListCar({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cdr)
      ) {
        // __yo_expr_list_cdr
        return this.evaluateYoExprListCdr({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cons)
      ) {
        // __yo_expr_list_cons
        return this.evaluateYoExprListCons({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_append)
      ) {
        // __yo_expr_list_append
        return this.evaluateYoExprListAppend({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_length)
      ) {
        // __yo_expr_list_length
        return this.evaluateYoExprListLength({
          expr,
          env,
          context: { ...context },
        });
      }
      // compt_int related arithmetic functions
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_add, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_sub, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mul, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_div, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mod, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg, 1) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_eq, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neq, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lt, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lte, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gt, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gte, 2)
      ) {
        return this.evaluateYoComptIntArithmetic({
          expr,
          env,
          context: { ...context },
        });
      }
      // Type related functions
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_to_string, 1)
      ) {
        // __yo_type_to_string
        return this.evaluateYoTypeToString({
          expr,
          env,
          context: { ...context },
        });
      } else {
        /* else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        // while
        return this.evaluateWhile({ expr, env, context: { ...context } });
      }
      */
        /*
      else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Exists)) {
        // exists
        return this.evaluateExists({ expr, env, context: { ...context } });
      }
      */
        /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      } 
      */
        // Function call
        return this.evaluateFunctionCall({
          expr,
          env,
          context: { ...context },
        });
      }
    }
  }

  private evaluateProgram(): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });

    const {
      moduleValue,
      env: nextEnv,
      partialModuleError,
    } = this.evaluateAnonymousModuleBeginExprs({
      beginExprs: this.program,
      env,
      context: {
        expectedType: undefined,
        SelfType: undefined,
        borrowings: [],
      },
      allowPartialModule: true,
    });
    env = nextEnv;
    this.moduleValue = moduleValue;
    this.moduleError = partialModuleError;
  }

  public getModuleValue(): ModuleValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.parser.getParserError() ?? this.moduleError;
  }
}
