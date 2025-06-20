import { readFileSync } from "node:fs";
import path from "node:path";
import { Borrowing, checkBorrowings } from "../borrow";
import {
  addVariableToEnv,
  createNewEnv,
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
} from "../env";
import { formatErrorMessage } from "../error";
import {
  AtomExpr,
  attachTempVariableToExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
  requireExprNotConsumed,
  setExprAsConsumed,
} from "../expr";
import Parser from "../parser";
import { Token, TokenType } from "../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createArrayType,
  createBooleanType,
  createComptIntType,
  createComptStringType,
  createExprListType,
  createExprType,
  createModuleType,
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  createTupleType,
  createUsizeType,
  EnumType,
  isBooleanType,
  isComptIntType,
  isEnumType,
  isExprListType,
  isExprType,
  isFreeType,
  isLinearOrType0Type,
  isLinearType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
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
  TupleType,
  Type,
  typeContainsReference,
  typeOfType,
  TypeTag,
  typeToString,
} from "../type-checker";
import { setTypeValueAsLinear } from "../type-value";
import { VUnit } from "../unit-value";
import { randomId } from "../utils";
import {
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
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  TupleValue,
  UnknownValue,
  Value,
  valueToString,
} from "../value";
import { ValueTag } from "../value-tag";

// Import extracted evaluator functions
import { evaluateFunctionCall } from "./calls/function";
import { evaluateRawPointerCall } from "./calls/pointer";
import { evaluateReferenceCall } from "./calls/reference";
import { EvaluatorContext } from "./context";
import { evaluateBeginExpression } from "./exprs/begin";
import { evaluateBinding } from "./exprs/binding";
import { evaluateIdentifierAndOperator } from "./exprs/identifer_and_operator";
import { evaluateInitializationAssignment } from "./exprs/initialization_assignment";
import { evaluateArrayType } from "./types/array";
import { evaluateEnumType } from "./types/enum";
import { evaluateFunctionType } from "./types/function";
import { evaluateStructType } from "./types/struct";
import { synthesizeExprAndType } from "./types/synthesizer";
import { evaluateTupleType } from "./types/tuple";
import { evaluateUnionType } from "./types/union";
import { isValidVariableName } from "./utils";
import { evaluateAnonymousFunctionImplementation } from "./values/anonymous_function";
import { evaluateBooleanLiteral } from "./values/boolean";
import { evaluateFloatLiteral } from "./values/float";
import { evaluateIntegerLiteral } from "./values/integer";
import { evaluateStringLiteral } from "./values/string";

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

  private expectExprToBeFunctionCallOf(
    expr: Expr,
    expectedFunctionName: string | string[],
    expectedArgCount?: number
  ) {
    if (!exprIsFunctionCall(expr)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected function call, got atom:\n${exprToString(expr)}`,
      });
    }
    if (!exprIsFunctionCallOf(expr, expectedFunctionName)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected function call of ${Array.isArray(expectedFunctionName) ? expectedFunctionName.map((fn) => `"${fn}"`).join(" or ") : `"${expectedFunctionName}"`}, got:\n${exprToString(expr)}`,
      });
    }

    if (
      expectedArgCount !== undefined &&
      expr.args.length !== expectedArgCount
    ) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected ${expectedArgCount} arguments, got ${expr.args.length}:\n${exprToString(
          expr
        )}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected tuple, got ${expr.tag}`,
      });
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
        throw formatErrorMessage({
          token: tupleElement.exprs.defaultValueExpr!.token,
          errorMessage: `Tuple type cannot have default value.`,
        });
      }

      if (tupleElement.exprs.labelExpr) {
        throw formatErrorMessage({
          token: tupleElement.exprs.labelExpr!.token,
          errorMessage: `Tuple value cannot have labels.`,
        });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected at least one element in array, got ${arrayElementExprs.length}`,
      });
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
        throw formatErrorMessage({
          token: arrayElementExpr.token,
          errorMessage: `Failed to evaluate array element: ${exprToString(arrayElementExpr)}`,
        });
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
            throw formatErrorMessage({
              token: arrayElementExpr.token,
              errorMessage: `Array element type mismatch:
Expected type: ${typeToString(arrayElementType)}
Given type: ${typeToString(evaluatedElement.$.type)}`,
            });
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
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Failed to evaluate expr_list element. Expected compile-time known expr value:\n${exprToString(arg)}`,
        });
      }
      env = evaluatedArg.$.env;
      const value = evaluatedArg.$.value;

      if (
        isExprValue(value) ||
        (isUnknownValue(value) && isExprType(value.type))
      ) {
        elements.push(value);
      } else {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time known expr value, got ${valueToString(value)}`,
        });
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
        throw formatErrorMessage({
          token: expr_.token,
          errorMessage: `Cannot use "::" for module element. Use ":=" instead.
All module elements are compile-time only by default.`,
        });
      }

      assignedValueExpr = expr_.args[1]!;
      expr_ = expr_.args[0]!;
    }

    // Cannot have both defaultValueExpr and assignedValueExpr
    if (defaultValueExpr && assignedValueExpr) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot have both default value and required value for tuple element.`,
      });
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
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`,
        });
      }

      // Check isImplicit
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

      if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`,
        });
      }
      label = labelExpr.token.value;
    } else if (
      exprIsFunctionCall(expr_) &&
      exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
    ) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`,
      });
    } else if (!defaultValueExpr && !assignedValueExpr) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected label for module field, got ${exprToString(expr_)}`,
      });
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

      if (!isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`,
        });
      }
      if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for tuple element label, got ${exprToString(
            labelExpr
          )}`,
        });
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
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Failed to get the field at index ${tupleElementIndex}`,
          });
        }

        expectedTupleElementType = tupleElement.type;
      } else {
        /*
        throw formatErrorMessage(
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
        throw formatErrorMessage({
          token: typeExpr.token,
          errorMessage: `(1) Expected type for tuple element, got ${exprToString(typeExpr)}`,
        });
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
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Failed to evaluate required value expression: ${exprToString(
            assignedValueExpr
          )}`,
        });
      }
      env = evaluatedAssignedValueExpr.$?.env;

      assignedValue = evaluatedAssignedValueExpr.$.value;
      if (!assignedValue) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Expected compile-time known value for required value, got ${exprToString(
            assignedValueExpr
          )}`,
        });
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
          throw formatErrorMessage({
            token: assignedValueExpr.token,
            errorMessage: `Assigned value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(assignedValueType)}`,
          });
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
        throw formatErrorMessage({
          token: defaultValueExpr.token,
          errorMessage: `Failed to evaluate default value expression: ${exprToString(
            defaultValueExpr
          )}`,
        });
      }
      env = evaluatedDefaultValueExpr.$.env;

      defaultValue = evaluatedDefaultValueExpr.$?.value;
      if (!defaultValue) {
        throw formatErrorMessage({
          token: defaultValueExpr.token,
          errorMessage: `Expected compile-time known value for default value, got ${exprToString(
            defaultValueExpr
          )}`,
        });
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
          throw formatErrorMessage({
            token: defaultValueExpr.token,
            errorMessage: `Default value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(defaultValueType)}`,
          });
        }
        elementType = expectedType.type;
      } else {
        elementType = defaultValueType;
      }
    }

    if (!elementType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to infer the element type`,
      });
    }

    /*
    if (typeRequiresComptModifier(elementType) && !isCompileTimeOnly) {
      elementType = convertComptTypeToRuntimeType(elementType);
      if (typeRequiresComptModifier(elementType)) {
        throw formatErrorMessage(
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

      throw formatErrorMessage({
        token: lhsExpr.token,
        errorMessage: `Labelled element is not allowed in tuple value.`,
      });
    }

    // Check expectedType
    const expectedTupleType = context.expectedType?.type;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedTupleType) {
      if (!isTupleType(expectedTupleType)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `(2) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedTupleType)}`,
        });
      }
      const tupleElement = expectedTupleType.elements[tupleElementIndex];
      if (!tupleElement) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the tuple element at index ${tupleElementIndex}`,
        });
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
      throw formatErrorMessage({
        token: rhsExpr.token,
        errorMessage: `Failed to evaluate the tuple element: ${exprToString(rhsExpr)}`,
      });
    }
    env = evaluatedRhs.$.env;

    // Set the evaluatedRhs as consumed
    env = setExprAsConsumed(evaluatedRhs, env);

    const value = evaluatedRhs.$.value;
    if (value && isTypeValue(evaluatedRhs.$.value)) {
      throw formatErrorMessage({
        token: rhsExpr.token,
        errorMessage: `Cannot store a type value in tuple, please use module instead:
  ${exprToString(rhsExpr)}`,
      });
    }

    // Expected the evaluatedRhs to be a value
    elementType = evaluatedRhs.$.type;
    if (!elementType) {
      throw formatErrorMessage({
        token: evaluatedRhs.token,
        errorMessage: `Failed to evaluate the tuple element.`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "=" for assignment.`,
      });
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
        const evaluatedLhs = evaluateIdentifierAndOperator({
          expr: lhs,
          env,
          context: { ...context },
          throwErrorOnUndefined: false,
        });
        if (!evaluatedLhs.$) {
          throw formatErrorMessage({
            token: lhs.token,
            errorMessage: `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`,
          });
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
        } = evaluateBinding({
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
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Variable ${variableName} not found in the environment`,
        });
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
          } = synthesizeExprAndType({
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
          throw formatErrorMessage({
            token: rhs.token,
            errorMessage: `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
              rhs
            )}\n${e}`,
          });
        }
      }

      // Check if the type matches
      if (
        !areTypesCompatible(
          { type: variable.type, env },
          { type: rhsType, env }
        )
      ) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`,
        });
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
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Cannot assign to immutable variable "${variableName}"`,
        });
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
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`,
        });
      }
      if (!evaluatedLhs.$.isMutable) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Cannot assign value to the immutable: ${exprToString(lhs)}`,
        });
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
          } = synthesizeExprAndType({
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
          throw formatErrorMessage({
            token: rhs.token,
            errorMessage: `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
              rhs
            )}\n${e}`,
          });
        }
      }

      // Check if the rhsType contains reference
      if (typeContainsReference(rhsType)) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Assigning reference to variable is not allowed.`,
        });
      }

      // Check if the type matches
      if (
        !areTypesCompatible({ type: expectedType, env }, { type: rhsType, env })
      ) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Incompatible types:
- Expected: ${typeToString(expectedType)}
- Given   : ${typeToString(rhsType)}`,
        });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected extern, got ${expr.tag}`,
      });
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
        throw formatErrorMessage({
          token: langArg.token,
          errorMessage: `Failed to evaluate language argument: ${exprToString(langArg)}`,
        });
      }
      env = evaluatedLang.$.env;
      const langValue = evaluatedLang.$.value;
      if (!isComptStringValue(langValue)) {
        throw formatErrorMessage({
          token: langArg.token,
          errorMessage: `Expected string for language argument, got ${exprToString(langArg)}`,
        });
      }
      if (langValue.value.toLocaleLowerCase() === "yo") {
        language = "yo";
      } else if (langValue.value.toLocaleLowerCase() === "c") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        language = "c";
      } else {
        throw formatErrorMessage({
          token: langArg.token,
          errorMessage: `Unsupported language "${langValue.value}" for extern, expected "c" or "yo"`,
        });
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
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label "${element.label}" in module`,
        });
      }

      // Expect element to be compile-time only
      if (!element.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only element for extern module, got ${exprToString(arg)}`,
        });
      }

      elements.push(element);
      env = nextEnv;

      // Prevent having Linear variables in "c" extern modules
      if (language === "c" && isLinearOrType0Type(element.type)) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Cannot have "Linear" or "Type" type in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(element.type)}`,
        });
      }
      if (language === "c" && isLinearOrType0Type(typeOfType(element.type))) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Cannot have "Linear" or "Type" value in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(typeOfType(element.type))}`,
        });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "cond", got ${expr.tag}`,
      });
    }

    const statements = expr.args;
    if (statements.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected at least one statement in "cond", got ${statements.length}`,
      });
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
        throw formatErrorMessage({
          token: statement.token,
          errorMessage: `Expected => for cond statement, got ${statement.tag}`,
        });
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
        throw formatErrorMessage({
          token: condExpr.token,
          errorMessage: `Failed to evaluate condition expression: ${exprToString(condExpr)}`,
        });
      }
      caseEnv = condExpr.$.env;

      if (!isBooleanType(condExpr.$.type)) {
        throw formatErrorMessage({
          token: condExpr.token,
          errorMessage: `Expected boolean for cond statement, got ${exprToString(condExpr)}`,
        });
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
        throw formatErrorMessage({
          token: caseBodyExpr.token,
          errorMessage: `Expected type for cond statement, got ${exprToString(caseBodyExpr)}`,
        });
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
            throw formatErrorMessage({
              token: caseBodyExpr.token,
              errorMessage: `Incompatible types:
- Previous: ${typeToString(valueType.type)}
- Current : ${typeToString(caseBodyExpr.$.type)}`,
            });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to determine the type of value from the cond.`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "match", got ${expr.tag}`,
      });
    }

    const args = expr.args;
    if (args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected at least 2 arguments for "match", got ${args.length}`,
      });
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
      throw formatErrorMessage({
        token: valueExpr.token,
        errorMessage: `Failed to evaluate the match value expression: ${exprToString(valueExpr)}`,
      });
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
      throw formatErrorMessage({
        token: valueExpr.token,
        errorMessage: `Expected enum type for match expression, got ${
          matchValueType ? typeToString(matchValueType) : "unknown type"
        }`,
      });
    }

    // Check if there is already selected variant,
    // If yes, then we disallow to use enum because we already know the selected variant.
    if (enumType.selectedVariantName) {
      throw formatErrorMessage({
        token: valueExpr.token,
        errorMessage:
          `Enum type ${typeToString(enumType)} already has selected variant "${enumType.selectedVariantName}".\n` +
          `You cannot use "match" on it, because it already has a selected variant.`,
      });
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
        throw formatErrorMessage({
          token: pattern.token,
          errorMessage: `Expected ":" for match pattern, got ${exprToString(pattern)}`,
        });
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
          throw formatErrorMessage({
            token: patternExpr.token,
            errorMessage: `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`,
          });
        }

        const variantName = variantNameExpr.token.value;
        // Check if variant exists in enum
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (!variant) {
          throw formatErrorMessage({
            token: patternExpr.token,
            errorMessage: `Enum variant "${variantName}" not found in ${typeToString(
              enumType
            )}`,
          });
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

          if (!isValidVariableName(variableExpr)) {
            throw formatErrorMessage({
              token: variableExpr.token,
              errorMessage: `Invalid variable name in match arm: ${variableExpr.token.value}`,
            });
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

          if (isValidVariableName(evaluatedMatchValue)) {
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
          throw formatErrorMessage({
            token: bodyExpr.token,
            errorMessage: `Expected type for match result expression, got ${exprToString(
              bodyExpr
            )}`,
          });
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
            throw formatErrorMessage({
              token: valueExpr.token,
              errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedResult.$.type)}`,
            });
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
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Destructuring enum variant elements is not supported in match expressions.
Please use .variantName for destructuring enum variants,
then destructure the value in the case body expression.`,
        });
      } else {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Invalid pattern in match expression: ${exprToString(patternExpr)}
Please use .variantName for destructuring enum variants.`,
        });
      }
    }

    if (!resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Could not determine result type for match expression`,
      });
    }

    // Perform exhaustiveness check
    const missingVariants = enumType.variants.filter(
      (variant) => !checkedVariantNames.has(variant.name)
    );
    if (missingVariants.length > 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Match expression is not exhaustive. Missing cases for variants:
        
- ${missingVariants.map((v) => v.name).join("\n- ")}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected a function type for recur, got:\n${exprToString(expr)}`,
      });
    }
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected recur, got:\n${exprToString(expr)}`,
      });
    }

    return evaluateFunctionCall({
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "module", got:\n${exprToString(expr)}`,
      });
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
          throw formatErrorMessage({
            token: extendedStructExpr.token,
            errorMessage: `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`,
          });
        }

        // Check if it's a module type
        const extendedModuleTypeValue = evaluatedExtendedModuleExpr.$.value;
        if (
          !isTypeValue(extendedModuleTypeValue) ||
          !isModuleType(extendedModuleTypeValue.value)
        ) {
          throw formatErrorMessage({
            token: extendedStructExpr.token,
            errorMessage: `Expected a struct type for extending, got ${exprToString(
              extendedStructExpr
            )}`,
          });
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
            throw formatErrorMessage({
              token: extendedStructExpr.token,
              errorMessage: `Duplicate label "${extendedModuleElement.label}" in module`,
            });
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
          throw formatErrorMessage({
            token: exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            errorMessage: `Duplicate label "${element.label}" in module`,
          });
        }

        elements.push(element);
        env = nextEnv;

        // Expect element to be compile-time only
        if (!element.isCompileTimeOnly) {
          throw formatErrorMessage({
            token: arg.token,
            errorMessage: `Expected compile-time only element for extern module, got ${exprToString(arg)}`,
          });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "." for property access, got:\n${exprToString(expr)}`,
      });
    }

    if (exprIsFunctionCallOf(expr, ".", 1)) {
      // Expect the argument to be an identifier
      const propertyExpr = expr.args[0]!;
      if (!exprIsAtom(propertyExpr) && !isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for enum variant access, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      }

      const expectedEnumType = context.expectedType?.type;
      if (!isEnumType(expectedEnumType)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to infer enum variant type.`,
        });
      }
      const variantName = propertyExpr.token.value;
      const enumType = expectedEnumType;

      const variant = enumType.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in enum`,
        });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "." with 2 arguments, got:\n${exprToString(expr)}`,
      });
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
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Expected identifier for enum variant, got:\n${exprToString(
              propertyExpr
            )}`,
          });
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
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Enum variant "${variantName}" not found in enum`,
          });
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
        if (!isValidVariableName(propertyExpr)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Expected identifier for struct type method, got:\n${exprToString(
              propertyExpr
            )}`,
          });
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
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Struct type property "${propertyName}" not found in struct type`,
          });
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
            throw formatErrorMessage({
              token: propertyExpr.token,
              errorMessage: `Accessing tuple element by index is only allowed for tuples.`,
            });
          }

          const index = parseInt(propertyExpr.token.value, 10);
          if (isNaN(index)) {
            throw formatErrorMessage({
              token: propertyExpr.token,
              errorMessage: `Expected integer for tuple index, got:\n${exprToString(
                propertyExpr
              )}`,
            });
          }

          const runtimeElementsCount = elements.filter(
            (element) => !element.isCompileTimeOnly
          ).length;

          if (index < 0 || index >= runtimeElementsCount) {
            throw formatErrorMessage({
              token: propertyExpr.token,
              errorMessage: `Index out of bounds: ${index} for accessing element in:\n${typeToString(
                objectExpr.$?.type
              )}`,
            });
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
        } else if (isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;
          {
            const tupleElementIndex = elements.findIndex(
              // NOTE: To access comptime only field, use the type instead, not the value.
              // The value can only access runtime fields.
              (element) => element.label === label && !element.isCompileTimeOnly
            );
            if (tupleElementIndex < 0) {
              if (isModuleType(objectExpr.$?.type)) {
                throw formatErrorMessage({
                  token: propertyExpr.token,
                  errorMessage: `Module element "${label}" not found in module type`,
                });
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
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Accessomg module field by index is not allowed, got:\n${exprToString(
              propertyExpr
            )}`,
          });
        } else if (isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;

          {
            const tupleElementIndex = elements.findIndex(
              (element) => element.label === label
            );
            if (tupleElementIndex < 0) {
              if (isModuleType(objectExpr.$?.type)) {
                throw formatErrorMessage({
                  token: propertyExpr.token,
                  errorMessage: `Module element "${label}" not found in module type`,
                });
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
        if (!isValidVariableName(propertyExpr)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Expected identifier for enum variant property, got:\n${exprToString(
              propertyExpr
            )}`,
          });
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
            throw formatErrorMessage({
              token: propertyExpr.token,
              errorMessage: `Enum variant property "${propertyName}" not found in enum variant "${objectType.selectedVariantName}"`,
            });
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
                throw formatErrorMessage({
                  token: extendedModuleExpr.token,
                  errorMessage: `Failed to evaluate the extended struct expression:\n${exprToString(extendedModuleExpr)}`,
                });
              }
              const extendedModuleType = evaluatedExtendedModuleExpr.$.type;
              if (!isModuleType(extendedModuleType)) {
                throw formatErrorMessage({
                  token: extendedModuleExpr.token,
                  errorMessage: `Expected struct type for export, got:\n${typeToString(extendedModuleType)}`,
                });
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
                    throw formatErrorMessage({
                      token: excludeMembersExpr.token,
                      errorMessage: `Label "${label}" is not found in the extended module type.`,
                    });
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
                        throw formatErrorMessage({
                          token: memberExpr.token,
                          errorMessage: `Expected identifier for excluded label, got:\n${exprToString(memberExpr)}`,
                        });
                      }
                      const label = memberExpr.token.value;
                      // Check if the label is in the extended module type
                      const existingElement = extendedModuleType.elements.find(
                        (e) => e.label === label
                      );
                      if (!existingElement) {
                        throw formatErrorMessage({
                          token: memberExpr.token,
                          errorMessage: `Label "${label}" is not found in the extended module type.`,
                        });
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
                    throw formatErrorMessage({
                      token: excludeMembersExpr.token,
                      errorMessage: `Expected identifier or tuple for excluded labels, got:\n${exprToString(
                        excludeMembersExpr
                      )}`,
                    });
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
                  throw formatErrorMessage({
                    token: exportExpr.token,
                    errorMessage: `Element "${extendedStructElement.label}" is already exported in the module.`,
                  });
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
              if (!isValidVariableName(exportExpr)) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(exportExpr)}`,
                });
              }

              const variableName = exportExpr.token.value;
              // Get the variable from the env
              const variables = getVariablesFromEnv(env, variableName);
              if (variables.length === 0) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Variable "${variableName}" is not defined in the module.`,
                });
              }
              const variable = variables[variables.length - 1]!;

              // Check if the same variable is already exported
              const existingElementIndex = moduleType.elements.findIndex(
                (e) => e.label === variableName
              );
              if (existingElementIndex >= 0) {
                // Throw error if the variable is already exported
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Variable "${variableName}" is already exported in the module.`,
                });
              } else {
                // Prevent exporting runtime variable
                if (!variable.isCompileTimeOnly) {
                  throw formatErrorMessage({
                    token: exportExpr.token,
                    errorMessage: `Variable "${variableName}" is not a compile-time variable and cannot be exported.`,
                  });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "module", got:\n${exprToString(expr)}`,
      });
    }
    if (expr.args.length !== 1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "module" with 1 argument, got:\n${exprToString(expr)}`,
      });
    }
    const moduleBodyExpr = expr.args[0]!;
    if (
      !exprIsFunctionCall(moduleBodyExpr) ||
      !exprIsFunctionCallOf(moduleBodyExpr, BuiltinKeywords.begin)
    ) {
      throw formatErrorMessage({
        token: moduleBodyExpr.token,
        errorMessage: `Expected "begin", got:\n${exprToString(moduleBodyExpr)}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "module", got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "typeof" with 1 argument, got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: typeExpr.token,
        errorMessage: `Expected type for expression, got:\n${exprToString(typeExpr)}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "consume" with 1 argument, got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: consumeArgExpr.token,
        errorMessage: `Failed to evaluate the consume argument:\n${exprToString(consumeArgExpr)}`,
      });
    }

    /*
    // QUESTION: Should we limit the consume argument to Linear type?
    const argType = evaluatedConsumeArgExpr.$.type;
    if (!isLinearOrType0Type(typeOfType(argType))) {
      throw formatErrorMessage(
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "import" with 1 argument, got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Expected compt_string for module path, got:\n${exprToString(moduleArg)}`,
      });
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
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: "Only local relative path is supported for now",
      });
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
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Failed to import module "${modulePath}":\n${error instanceof Error ? error.message : String(error)}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "using" with 1 argument, got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Failed to evaluate the module argument:\n${exprToString(moduleArg)}`,
      });
    }

    const moduleValue = evaluatedModuleArg.$.value;
    if (!isModuleValue(moduleValue)) {
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Expected module value for "using", got:\n${exprToString(moduleArg)}`,
      });
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
        !isMutRefType(evaluatedBorrowedValueExpr.$.type)
      ) {
        throw formatErrorMessage({
          token: borrowedValueExpr.token,
          errorMessage: `Expected reference type for borrowed value, got:\n${typeToString(
            evaluatedBorrowedValueExpr.$.type
          )}`,
        });
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
    const evaluatedBorrowBlock = evaluateBeginExpression({
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
      throw formatErrorMessage(
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
        throw formatErrorMessage(
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
        throw formatErrorMessage(
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
      throw formatErrorMessage({
        token: expectedTypeArg.token,
        errorMessage: `Expected type, got:\n${exprToString(expectedTypeArg)}`,
      });
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
      throw formatErrorMessage({
        token: givenTypeArg.token,
        errorMessage: `Expected type, got:\n${exprToString(givenTypeArg)}`,
      });
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
        throw formatErrorMessage({
          token: expr.token,

          errorMessage: isComptStringValue(evaluatedMessageExpr.$.value)
            ? evaluatedMessageExpr.$.value.value
            : valueToString(evaluatedMessageExpr.$.value),
        });
      }
    }

    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected compile error, but the expression was evaluated successfully:\n${exprToString(argExpr)}`,
    });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected boolean value for "compt_assert", got:\n${exprToString(argExpr)}`,
      });
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
          throw formatErrorMessage({
            token: expr.token,

            errorMessage: isComptStringValue(evaluatedMessageExpr.$.value)
              ? evaluatedMessageExpr.$.value.value
              : valueToString(evaluatedMessageExpr.$.value),
          });
        }
      }

      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Assertion failed for "compt_assert":\n${exprToString(argExpr)}`,
      });
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
      throw formatErrorMessage({
        token: notArg.token,
        errorMessage: `Expected boolean type for "not" argument, got:\n${exprToString(notArg)}`,
      });
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
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected boolean type for "${kind}" argument, got:\n${exprToString(arg)}`,
        });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "drop":\n${exprToString(
          argExpr
        )}`,
      });
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
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "while" with 2 or 3 arguments, got:\n${exprToString(expr)}`,
      });
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
      throw formatErrorMessage({
        token: conditionExpr.token,
        errorMessage: `Failed to evaluate the condition expression:\n${exprToString(conditionExpr)}`,
      });
    }
    if (!isBooleanType(evaluatedConditionExpr.$.type)) {
      throw formatErrorMessage({
        token: conditionExpr.token,
        errorMessage: `Expected boolean type for condition expression, got:\n${exprToString(
          conditionExpr
        )}`,
      });
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
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`,
      });
    }
    if (!isUnitType(evaluatedBodyExpr.$.type)) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Expected the while loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`,
      });
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
        throw formatErrorMessage({
          token: stepExpr.token,
          errorMessage: `Failed to evaluate the step expression:\n${exprToString(stepExpr)}`,
        });
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
          throw formatErrorMessage({
            token: arg.token,
            errorMessage: `Expected expression type for "unquote" argument, got:\n${exprToString(arg)}`,
          });
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
          throw formatErrorMessage({
            token: arg.token,
            errorMessage: `Expected expression value for "unquote" argument, got:\n${valueToString(exprValue)}`,
          });
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
        throw formatErrorMessage({
          token: expr.args[1]!.token,
          errorMessage: `Expected "gensym" with 0 or 1 argument, got: ${expr.args.length}`,
        });
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
        throw formatErrorMessage({
          token: prefixArg.token,
          errorMessage: `Failed to evaluate the prefix argument for "gensym":\n${exprToString(
            prefixArg
          )}`,
        });
      }
      if (!isComptStringValue(evaluatedPrefixArg.$.value)) {
        throw formatErrorMessage({
          token: prefixArg.token,
          errorMessage: `Expected compt_string for prefix argument, got:\n${exprToString(
            prefixArg
          )}`,
        });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected function call expression for argument, got:\n${exprToString(
            expr
          )}`,
        });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected function call expression for argument, got:\n${exprToString(
            expr
          )}`,
        });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Unexpected empty ExprList for "${expr.func.token.value}" argument`,
        });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprValue = evaluatedArgExpr.$.value;
    if (!exprValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Unexpected empty ExprList for "${expr.func.token.value}" argument`,
        });
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
      throw formatErrorMessage({
        token: carArg.token,
        errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
          carArg
        )}`,
      });
    }
    env = carArg.$.env;
    if (!isExprType(carArg.$.type)) {
      throw formatErrorMessage({
        token: carArg.token,
        errorMessage: `Expected Expr type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          carArg
        )}`,
      });
    }
    const carValue = carArg.$.value;
    if (!carValue) {
      throw formatErrorMessage({
        token: carArg.token,
        errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
          carArg
        )}`,
      });
    }

    const cdrArg = this.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });
    if (!cdrArg.$) {
      throw formatErrorMessage({
        token: cdrArg.token,
        errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
          cdrArg
        )}`,
      });
    }
    env = cdrArg.$.env;
    if (!isExprListType(cdrArg.$.type)) {
      throw formatErrorMessage({
        token: cdrArg.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          cdrArg
        )}`,
      });
    }
    const cdrValue = cdrArg.$.value;
    if (!cdrValue) {
      throw formatErrorMessage({
        token: cdrArg.token,
        errorMessage: `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
          cdrArg
        )}`,
      });
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
      throw formatErrorMessage({
        token: firstListArg.token,
        errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
          firstListArg
        )}`,
      });
    }
    env = firstListArg.$.env;
    if (!isExprListType(firstListArg.$.type)) {
      throw formatErrorMessage({
        token: firstListArg.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          firstListArg
        )}`,
      });
    }
    const firstListValue = firstListArg.$.value;
    if (!firstListValue) {
      throw formatErrorMessage({
        token: firstListArg.token,
        errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
          firstListArg
        )}`,
      });
    }

    const secondListArg = this.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });
    if (!secondListArg.$) {
      throw formatErrorMessage({
        token: secondListArg.token,
        errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
          secondListArg
        )}`,
      });
    }
    env = secondListArg.$.env;
    if (!isExprListType(secondListArg.$.type)) {
      throw formatErrorMessage({
        token: secondListArg.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          secondListArg
        )}`,
      });
    }
    const secondListValue = secondListArg.$.value;
    if (!secondListValue) {
      throw formatErrorMessage({
        token: secondListArg.token,
        errorMessage: `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
          secondListArg
        )}`,
      });
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
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          argExpr
        )}`,
      });
    }
    if (!isExprListType(evaluatedArgExpr.$.type)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
    }
    const exprListValue = evaluatedArgExpr.$.value;
    if (!exprListValue) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
          argExpr
        )}`,
      });
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
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compt_int type for "${expr.func.token.value}" argument, got:\n${exprToString(
            arg
          )}`,
        });
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
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Unexpected function call for "${expr.func.token.value}", expected "__yo_compt_int_neg
          " function`,
        });
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
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Expected compt_int type for "${expr.func.token.value}" first argument, got:\n${exprToString(
            lhs
          )}`,
        });
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
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Expected compt_int type for "${expr.func.token.value}" second argument, got:\n${exprToString(
            rhs
          )}`,
        });
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
            throw formatErrorMessage({
              token: rhs.token,
              errorMessage: `Division by zero in "${expr.func.token.value}" operation`,
            });
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
            throw formatErrorMessage({
              token: rhs.token,
              errorMessage: `Modulo by zero in "${expr.func.token.value}" operation`,
            });
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
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Unexpected function call for compt_int arithmetic: ${exprToString(
            expr
          )}`,
        });
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
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
          arg
        )}`,
      });
    }
    if (!isTypeHierarchyType(arg.$.type)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    const typeValue = arg.$.value;
    if (!typeValue) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
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
          return evaluateIdentifierAndOperator({
            expr,
            env,
            context: { ...context },
            throwErrorOnUndefined: true,
          });
        }
        case TokenType.Integer: {
          return evaluateIntegerLiteral(expr, env);
        }
        case TokenType.Float: {
          return evaluateFloatLiteral(expr, env);
        }
        case TokenType.String: {
          return evaluateStringLiteral(expr, env);
        }
        case TokenType.Boolean: {
          return evaluateBooleanLiteral(expr, env);
        }
        default: {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `(1) Evaluating the expression below is not implemented:
${exprToString(expr)}`,
          });
        }
      }
    } else {
      if (exprIsFunctionCallOf(expr, ":", 2)) {
        // Binding type
        const { expr: nextExpr } = evaluateBinding({ expr, env, context });
        return nextExpr;
      } else if (
        exprIsFunctionCallOf(expr, ":=", 2) ||
        exprIsFunctionCallOf(expr, "::", 2)
      ) {
        // Initialize assignment
        return evaluateInitializationAssignment({ expr, env, context });
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
          return evaluateAnonymousFunctionImplementation({
            expr,
            env,
            context: { ...context },
          });
        }

        // Function type
        return evaluateFunctionType({
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
        return evaluateStructType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
        // enum
        return evaluateEnumType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
        // union
        return evaluateUnionType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, ".")) {
        // property access
        return this.evaluatePropertyAccess({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
        // begin
        return evaluateBeginExpression({
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
        return evaluateRawPointerCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.Ref, 1)
      ) {
        // & or &! references
        return evaluateReferenceCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Tuple)) {
        // Tuple type
        return evaluateTupleType({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Array)) {
        // Array type
        return evaluateArrayType({
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
        return evaluateFunctionCall({
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
        evaluateExpression: this.evaluateExpression.bind(this),
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
