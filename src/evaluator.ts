import {
  addVariableToEnv,
  createNewEnv,
  Environment,
  getMethodsByNameFromEnv,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
} from "./env";
import { formatErrorMessage } from "./error";
import {
  AtomExpr,
  BuiltinCollections,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "./expr";
import { FunctionValue } from "./function-value";
import * as logger from "./logger";
import Parser from "./parser";
import { stringIsOperator, Token, TokenType } from "./token";
import {
  areTypesCompatible,
  createEnumType,
  createFunctionType,
  createModuleType,
  createStructType,
  createTupleType,
  EnumType,
  EnumVariant,
  FunctionParameter,
  FunctionType,
  getValueOfSomeTypeFromEnv,
  isBooleanType,
  isEnumType,
  isFunctionType,
  isFunctionTypeAndIsTypeFunction,
  isModuleType,
  isPrimitiveType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  ModuleType,
  StructType,
  TBoolean,
  TF32,
  TF64,
  TFree,
  TI16,
  TI32,
  TI64,
  TI8,
  TIsize,
  TLinear,
  TType,
  TU16,
  TU32,
  TU64,
  TU8,
  TUnit,
  TupleElement,
  TupleType,
  TUsize,
  Type,
  typeOfType,
  TypeTag,
  typeToString,
} from "./type-checker";
import { TypeValue } from "./type-value";
import { VUnit } from "./unit-value";
import { randomId } from "./utils";
import {
  areValuesEqual,
  createBooleanValue,
  createEnumValue,
  createModuleValue,
  createStructValue,
  createTypeValue,
  createUnknownValue,
  isFunctionValue,
  isModuleValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  TupleValue,
  Value,
  valueToString,
} from "./value";
import { ValueTag } from "./value-tag";

interface EvaluatorContext {
  /**
   * Check if it's evaluating expr as type
   */
  isEvaluatingExprAsType?: boolean;

  /**
   *
   */
  expectedType?: Type;

  /**
   * This is used for calling the `recur` function.
   */
  isEvaluatingFunctionBodyOfType?: FunctionType;

  /**
   * The innermost interface, struct, enum, or union that this function call is inside.
   * This can be useful for an anonymous struct that needs to refer to itself
   */
  SelfType?: Type;
}

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private parser: Parser;
  private program: Expr[];
  private tokens: Token[];

  constructor({
    modulePath,
    inputString,
  }: {
    modulePath: string;
    inputString: string;
  }) {
    this.modulePath = modulePath;
    this.inputString = inputString;

    // Parse the module
    this.parser = new Parser({ modulePath, inputString });
    this.program = this.parser.getProgram();
    this.tokens = this.parser.getTokens();

    // Evaluate the program
    this.evaluateProgram();
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
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
  }

  private evaluateIntegerLiteral(expr: AtomExpr): AtomExpr {
    if (expr.token.type === TokenType.Integer) {
      const integerValue = parseInt(expr.token.value, 10);
      const value: Value = {
        tag: ValueTag.I32,
        type: TI32,
        value: integerValue,
      };
      expr.value = value;
      expr.type = value.type;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected integer literal, got ${expr.tag}`
      );
    }
  }

  private evaluateBooleanLiteral(expr: AtomExpr): AtomExpr {
    if (expr.token.type === TokenType.Boolean) {
      const booleanValue = expr.token.value === "true";
      const value: Value = createBooleanValue(booleanValue);
      expr.value = value;
      expr.type = value.type;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected boolean literal, got ${expr.tag}`
      );
    }
  }

  private evaluateTuple({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected tuple, got ${expr.tag}`
      );
    }

    if (expr.args.length === 0) {
      // Unit
      if (context.isEvaluatingExprAsType) {
        expr.value = createTypeValue(TUnit);
        expr.type = typeOfType(TUnit);
        return expr;
      } else {
        expr.value = VUnit;
        expr.type = VUnit.type;
        return expr;
      }
    }

    const {
      type: tupleType,
      value: tupleValue,
      env: nextEnv,
    } = this.evaluateTupleElements({ args: expr.args, env, context });
    env = nextEnv;

    // We disallow the tuple elements to have defaultValue for the tuple type
    // We disallow the tuple value to have labels. Only the tuple type can have labels.
    for (let i = 0; i < tupleType.elements.length; i++) {
      const tupleElement = tupleType.elements[i];
      if (tupleElement.defaultValue) {
        throw this.formatErrorMessage(
          tupleElement.expr.token,
          `Tuple elements cannot have default value.`
        );
      }

      if (!context.isEvaluatingExprAsType && tupleElement.label) {
        throw this.formatErrorMessage(
          tupleElement.expr.token,
          `Tuple value cannot have labels.`
        );
      }
    }

    expr.value = tupleValue;
    expr.type = context.isEvaluatingExprAsType
      ? typeOfType(tupleType)
      : tupleType;
    expr.env = env;
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
  }: {
    expr: Expr;
    tupleElementIndex: number;
    env: Environment;
    context: EvaluatorContext;
  }): { type: TupleElement; value: TypeValue; env: Environment } {
    if (!context.isEvaluatingExprAsType) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected context.isEvaluatingExprAsType == true`
      );
    }

    let label: string | undefined = undefined;
    let expr_ = expr;
    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    // Check the default value
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "=", 2)) {
      expr_ = expr.args[0];
      const defaultValueExpr = expr.args[1];

      // Evaluate the defaultValueExpr
      const evaluatedDefaultValue = this.evaluateExpression({
        expr: defaultValueExpr,
        env,
        context: {
          ...context,
        },
      });
      if (evaluatedDefaultValue.env) {
        env = evaluatedDefaultValue.env;
      }
      defaultValue = evaluatedDefaultValue.value;
      if (!defaultValue) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Expect compile-time known value as default value.`
        );
      }
    }

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":")) {
      rhsExpr = expr_.args[1];
      lhsExpr = expr_.args[0];

      if (!exprIsAtom(lhsExpr) && !this.isValidVariableName(lhsExpr)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            lhsExpr
          )}`
        );
      }
      label = lhsExpr.token.value;
    }

    // Check expectedType
    const expectedType = context.expectedType;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedType) {
      if (isTupleType(expectedType)) {
        const tupleElement = expectedType.elements[tupleElementIndex];
        expectedTupleElementType = tupleElement.type;
      } else if (isStructType(expectedType)) {
        const structMember = expectedType.elements[tupleElementIndex];
        expectedTupleElementType = structMember.type;
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

    // Parse the rhs expr
    const evaluatedRhs = this.evaluateExpression({
      expr: rhsExpr,
      env,
      context: {
        ...context,
        expectedType: expectedTupleElementType,
      },
    });
    if (evaluatedRhs.env) {
      env = evaluatedRhs.env;
    }

    // Expected the evaluatedRhs to be a type
    const typeValue = evaluatedRhs.value;
    if (!isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `(1) Expected type for tuple element, got ${exprToString(rhsExpr)}`
      );
    }
    elementType = typeValue.value;
    if (lhsExpr) {
      lhsExpr.type = elementType;
    }

    // Check if defaultValue matches the type
    if (
      defaultValue &&
      !areTypesCompatible(elementType, defaultValue.type, env)
    ) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Default value type mismatch:
Expected type: ${typeToString(elementType)}
Given type: ${typeToString(defaultValue.type)}`
      );
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.type = typeValue.type;
      lhsExpr.value = typeValue;
    }
    expr.env = env;
    return {
      type: {
        label,
        type: elementType,
        expr,
        defaultValue,
      },
      value: typeValue,
      env,
    };
  }

  /**
   * Evaluate the element in tuple rvalue, such as
   * value:
   * 14  in (14, ...)
   * (x: 16) in (x: 16)
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
    if (context.isEvaluatingExprAsType) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected context.isEvaluatingExprAsType == false`
      );
    }

    let label: string | undefined = undefined;
    const expr_ = expr;
    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":")) {
      rhsExpr = expr_.args[1];
      lhsExpr = expr_.args[0];

      if (!exprIsAtom(lhsExpr) && !this.isValidVariableName(lhsExpr)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            lhsExpr
          )}`
        );
      }
      label = lhsExpr.token.value;
    }

    // Check expectedType
    const expectedTupleType = context.expectedType;
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
      expectedTupleElementType = tupleElement.type;
    }

    // Parse the rhs expr
    const evaluatedRhs = this.evaluateExpression({
      expr: rhsExpr,
      env,
      context: {
        ...context,
        expectedType: expectedTupleElementType,
      },
    });
    if (evaluatedRhs.env) {
      env = evaluatedRhs.env;
    }

    const value = evaluatedRhs.value;
    if (value && isTypeValue(evaluatedRhs.value)) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Cannot store a type value in tuple while not in "type" context: 
  ${exprToString(rhsExpr)}`
      );
    }

    // Expected the evaluatedRhs to be a value
    elementType = evaluatedRhs.type;
    if (!elementType) {
      throw this.formatErrorMessage(
        evaluatedRhs.token,
        `Failed to evaluate the tuple element.`
      );
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.type = elementType;
      lhsExpr.value = value;
    }
    expr.env = env;
    expr.type = elementType;
    expr.value = value;
    return {
      type: {
        label,
        type: elementType,
        expr,
      },
      value,
      env,
    };
  }

  /**
   * @returns
   */
  private evaluateTupleElements({
    args,
    env,
    context,
  }: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): {
    type: TupleType;
    value: TupleValue | TypeValue | undefined;
    env: Environment;
  } {
    const tupleElements: TupleElement[] = [];
    const tupleValues: (Value | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      const {
        type,
        value,
        env: nextEnv,
      } = context.isEvaluatingExprAsType
        ? this.evaluateTupleElementType({
            expr: arg,
            env,
            tupleElementIndex: i,
            context: { ...context },
          })
        : this.evaluateTupleElementValue({
            expr: arg,
            env,
            tupleElementIndex: i,
            context: { ...context },
          });

      // Check if there is duplicate labels
      if (type.label) {
        const duplicateLabel = tupleElements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(arg)
              ? arg.args[0]?.token ?? arg.token
              : arg.token,
            `Duplicate label "${type.label}" in tuple`
          );
        }
      }

      tupleElements.push(type);
      tupleValues.push(value);
      env = nextEnv;
    }

    const tupleType: TupleType = createTupleType(tupleElements);
    let value: Value | undefined = undefined;
    if (context.isEvaluatingExprAsType) {
      value = createTypeValue(tupleType);
    } else {
      value = tupleValues.some((v) => !v)
        ? // ^ Meaning some element value is not compile-time known.
          undefined
        : {
            tag: ValueTag.Tuple,
            type: tupleType,
            elements: tupleValues as Value[],
          };
    }
    return {
      type: tupleType,
      value,
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
    expectedType: Type,
    givenType: Type,
    env: Environment,
    token: Token
  ): Environment {
    if (isSomeType(expectedType)) {
      // Check if the env has
      const type = getValueOfSomeTypeFromEnv(env, expectedType);
      if (!type || type === expectedType) {
        // Update the env to set givenType to expectedType.name
        const value = createTypeValue(givenType);
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: expectedType.name,
            value: value,
            type: value.type,
            token: token, // FIXME: What should be `token` here?
            isMutable: false,
            isCompileTimeOnly: true,
            isNotInitialized: false,
          },
        });
        env = nextEnv;
      }
    } else if (
      isTupleType(expectedType) &&
      isTupleType(givenType) &&
      expectedType.elements.length === givenType.elements.length
    ) {
      for (let i = 0; i < expectedType.elements.length; i++) {
        env = this.synthesizeTypes(
          expectedType.elements[i].type,
          givenType.elements[i].type,
          env,
          expectedType.elements[i].expr.token
        );
      }
    } else if (
      isStructType(expectedType) &&
      isStructType(givenType) &&
      (expectedType.typeId === givenType.typeId ||
        (expectedType.functionValue &&
          givenType.functionValue &&
          expectedType.functionValue === givenType.functionValue))
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
    ) {
      for (let i = 0; i < expectedType.elements.length; i++) {
        const expectedElement = expectedType.elements[i];
        const givenElement = givenType.elements[i];
        env = this.synthesizeTypes(
          expectedElement.type,
          givenElement.type,
          env,
          expectedElement.expr.token
        );
      }
    } else if (
      isEnumType(expectedType) &&
      isEnumType(givenType) &&
      (expectedType.typeId === givenType.typeId ||
        (expectedType.functionValue &&
          givenType.functionValue &&
          expectedType.functionValue === givenType.functionValue))
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
    ) {
      for (let i = 0; i < expectedType.variants.length; i++) {
        const expectedTypeVariant = expectedType.variants[i];
        const givenTypeVariant = givenType.variants[i];

        const expectedTypeVariantElements = expectedTypeVariant.elements ?? [];
        const givenTypeVariantElements = givenTypeVariant.elements ?? [];

        for (let j = 0; j < expectedTypeVariantElements.length; j++) {
          env = this.synthesizeTypes(
            expectedTypeVariantElements[j].type,
            givenTypeVariantElements[j].type,
            env,
            expectedTypeVariantElements[j].expr.token
          );
        }
      }
    }
    return env;
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
      exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)
    ) {
      if (type.elements.length !== expr.args.length) {
        throw this.formatErrorMessage(
          expr.token,
          `Tuple size mismatch: expected ${type.elements.length} elements, got ${expr.args.length}`
        );
      }

      // Recursively synthesize each tuple element
      for (let i = 0; i < type.elements.length; i++) {
        const elementType = type.elements[i].type;
        const elementExpr = expr.args[i];

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
      expr.type = type;
      return { expr, type, env };
    }
    // Handle the _ case
    else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "_")) {
      // Check if type is a struct type
      if (isStructType(type)) {
        const funcCallExpr = this.evaluateFunctionCall({
          expr,
          env,
          givenFunc: {
            type: typeOfType(type),
            value: createTypeValue(type),
          },
          context: { ...context },
        });

        if (!funcCallExpr.type || !funcCallExpr.env) {
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
          type: funcCallExpr.type,
          env: funcCallExpr.env,
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
        const variantNameExpr = expr.args[0];
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
        expr.type = newEnumType;
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
        const variantNameExpr = variantExpr.args[0];
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
        if (!funcCallExpr.type || !funcCallExpr.env) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to evaluate expr and type for enum variant:\n${exprToString(
              expr
            )}`
          );
        }

        return {
          expr: funcCallExpr,
          type: funcCallExpr.type,
          env: funcCallExpr.env,
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
    else if (expr.type && type) {
      return {
        expr,
        type: expr.type, // NOTE: Here we should return the type of expr, not `type`
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
    context,
  }: {
    lhs: Expr;
    rhs: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    const rhsType = rhs.type;
    if (!rhsType) {
      throw this.formatErrorMessage(
        rhs.token,
        `(1) Expected type for right-hand side, got ${exprToString(rhs)}`
      );
    }

    // Handle struct destructuring
    if (isStructType(rhsType) && exprIsFunctionCall(lhs)) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.elements,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
        context: { ...context },
      });
    }
    // Handle tuple destructuring
    else if (
      isTupleType(rhsType) &&
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinCollections.Tuple)
    ) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.elements,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
        context: { ...context },
      });
    }
    // Handle module destructuring
    else if (isModuleType(rhsType) && exprIsFunctionCall(lhs)) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.members,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
        context: { ...context },
      });
    }

    throw this.formatErrorMessage(
      lhs.token,
      `Destructuring assignment not supported for this pattern: ${exprToString(
        lhs
      )}`
    );
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
    context,
  }: {
    lhsFunc: Expr;
    lhsElements: Expr[];
    rhsElements: { label?: string; type: Type }[];
    rhsValue: Value | undefined;
    rhsType: Type;
    lhs: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    const isStruct = isStructType(rhsType);
    const isModule = isModuleType(rhsType);
    const lhsFuncName = lhsFunc.token.value;

    // ~~Verify the struct type name matches if specified~~
    // We force to use _ for destructuring
    if ((isStruct || isModule) && lhsFuncName !== "_") {
      throw this.formatErrorMessage(
        lhsFunc.token,
        `Expected "_" for ${isStruct ? "struct" : ""}${
          isModule ? "module" : ""
        } destructuring, got ${lhsFuncName}`
      );
    }

    // Check if we have enough elements
    if (lhsElements.length > rhsElements.length) {
      throw this.formatErrorMessage(
        lhs.token,
        `Too many elements in destructuring pattern. Expected at most ${rhsElements.length}, got ${lhsElements.length}`
      );
    }

    // Process each lhs element
    for (let i = 0; i < lhsElements.length; i++) {
      const lhsElement = lhsElements[i];
      let elementIndex: number = i;
      let elementValue: Value | undefined = undefined;
      // Initialize rhsElement here, before any conditional branches
      let rhsElement = rhsElements[elementIndex];
      let variableName: string | undefined;
      let variableToken: Token | undefined;
      let labelExpr: Expr | undefined = undefined;
      let renameExpr: Expr | undefined = undefined;

      // Handle labeled nested destructuring pattern like:
      // - (c: (x, y))
      // - (c: _(x, y))
      if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ":", 2)
      ) {
        const leftSide = lhsElement.args[0]; // The label (c)
        const rightSide = lhsElement.args[1]; // Could be (x, y) or could be a variable

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
            `Label "${label}" not found in the ${
              isStruct ? BuiltinKeywords.Struct : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsElement = rhsElements[elementIndex];
        const nestedRhsType = rhsElement.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isModuleValue(rhsValue)) {
          nestedValue = rhsValue.members[label];
        }
        elementValue = nestedValue;

        // Check if the right side is a tuple for nested destructuring (c: (x, y))
        if (
          exprIsFunctionCall(rightSide) &&
          exprIsFunctionCallOf(rightSide, BuiltinCollections.Tuple)
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
          });

          // Set type and value on expressions
          rightSide.type = nestedRhsType;
          rightSide.value = nestedValue;
          rightSide.env = env;

          labelExpr.type = nestedRhsType;
          lhsElement.type = nestedRhsType;
          lhsElement.value = nestedValue;
          lhsElement.env = env;

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
          const nestedElements = isStructType(nestedRhsType)
            ? nestedRhsType.elements
            : nestedRhsType.members;
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsElements: nestedElements,
            rhsValue: nestedValue,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
            context: { ...context },
          });

          // Set type and value on expressions
          rightSide.type = nestedRhsType;
          rightSide.value = nestedValue;
          rightSide.env = env;

          labelExpr.type = nestedRhsType;
          lhsElement.type = nestedRhsType;
          lhsElement.value = nestedValue;
          lhsElement.env = env;

          // Skip to next element since we've already processed this one
          continue;
        }

        // Variable rename case like (a: m)
        else if (exprIsAtom(rightSide) && this.isValidVariableName(rightSide)) {
          renameExpr = rightSide;
          variableName = rightSide.token.value;
          variableToken = rightSide.token;
        }
        // Other patterns that don't match previous conditions
        else {
          throw this.formatErrorMessage(
            rightSide.token,
            `Expected tuple or variable name for destructuring pattern, got ${exprToString(
              rightSide
            )}`
          );
        }
      }

      // Handle nested struct/module destructuring pattern like:
      // - (a, (x, y))
      // - (a, _(x, y))
      else if (exprIsFunctionCall(lhsElement)) {
        // Get the right-hand side value at this position
        rhsElement = rhsElements[elementIndex];
        const nestedRhsType = rhsElement.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        } else if (isModuleValue(rhsValue)) {
          throw new Error(`Expected label for module destructuring`);
        }
        elementValue = nestedValue;

        // Check if the right side is a tuple for nested destructuring (a, (x, y))
        if (
          exprIsFunctionCall(lhsElement) &&
          exprIsFunctionCallOf(lhsElement, BuiltinCollections.Tuple)
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
          });

          // Set type and value on expressions
          lhsElement.type = nestedRhsType;
          lhsElement.value = nestedValue;
          lhsElement.env = env;

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
          if (!isStructType(nestedRhsType)) {
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
          });
          // Set type and value on expressions
          lhsElement.type = nestedRhsType;
          lhsElement.value = nestedValue;
          lhsElement.env = env;
          continue;
        }
      }

      // Handle positional destructuring
      else if (exprIsAtom(lhsElement) && this.isValidVariableName(lhsElement)) {
        if (isModuleType(rhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected label for module destructuring.
Please consider to write it as:
(${lhs.token.value} : ${lhs.token.value})`
          );
        }

        if (isTupleValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        } else if (isStructValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        }

        variableName = lhsElement.token.value;
        variableToken = lhsElement.token;
      }

      // Throw error
      else {
        throw this.formatErrorMessage(
          lhsElement.token,
          `Unsupported destructuring pattern for ${
            isStruct
              ? BuiltinKeywords.Struct
              : isModule
              ? BuiltinKeywords.Module
              : "tuple"
          }: ${exprToString(lhsElement)}`
        );
      }

      // After determining variableName and variableToken, add to environment
      if (variableName && variableToken) {
        // Add the variable to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: variableName,
            token: variableToken,
            type: rhsElement.type,
            isMutable: false,
            isNotInitialized: false,
            value: elementValue,
          },
        });

        env = nextEnv;

        // Set the type and value on the lhs element for completeness
        lhsElement.type = rhsElement.type;
        lhsElement.value = elementValue;
        lhsElement.env = env;

        if (labelExpr) {
          labelExpr.type = rhsElement.type;
          if (!renameExpr) {
            labelExpr.value = elementValue;
          }
          labelExpr.env = env;
        }

        if (renameExpr) {
          renameExpr.type = rhsElement.type;
          renameExpr.value = elementValue;
          renameExpr.env = env;
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
    let lhs = expr.args[0];
    const rhs = expr.args[1];

    // Evaluate the rhs expression
    const evaluatedRhs = this.evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: true,
      },
    });
    if (evaluatedRhs.env) {
      env = evaluatedRhs.env;
    }
    if (!isTypeValue(evaluatedRhs.value)) {
      throw this.formatErrorMessage(
        rhs.token,
        `Expected type for rhs, got ${exprToString(rhs)}`
      );
    }
    const typeValue = evaluatedRhs.value;
    const userDefinedType = typeValue.value;

    // Evaluate the lhs expression
    let isCompileTimeOnly = false;
    let isMutable = false;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.Compt)
    ) {
      isCompileTimeOnly = true;
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for "compt" (or "@"), got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.Mut)
    ) {
      isMutable = true;
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
    }
    if (!this.isValidVariableName(lhs)) {
      throw this.formatErrorMessage(
        lhs.token,
        `Invalid binding to ${lhs.token.value}, expected identifier or operator`
      );
    }

    if (
      (isTypeHierarchyType(userDefinedType) || isModuleType(userDefinedType)) &&
      !isCompileTimeOnly
    ) {
      throw this.formatErrorMessage(
        lhs.token,
        `Expected "compt" (or "@") to for compile-time known ${
          isTypeHierarchyType(userDefinedType) ? "type" : "module"
        } value binding.`
      );
    }

    const variableName = lhs.token.value;
    // Add the variable to the env
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: variableName,
        token: lhs.token,
        type: userDefinedType,
        isMutable,
        isNotInitialized: true,
        value: isCompileTimeOnly
          ? createUnknownValue(userDefinedType)
          : undefined,
        isCompileTimeOnly,
      },
    });
    env = nextEnv;

    // Attach the user defined type to the lhs
    lhs.type = userDefinedType;
    lhs.env = env;

    expr.env = env;
    expr.value = VUnit;
    expr.type = VUnit.type;
    return { expr, variableExpr: lhs, variableName };
  }

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

    let lhs = expr.args[0];
    let rhs = expr.args[1];

    // Check if the variable is mutable
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.Mut)
    ) {
      isMutable = true;
      // Check if the lhs is a variable
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
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
        isEvaluatingExprAsType: false,
        expectedType: undefined,
      },
    });
    if (rhs.env) {
      env = rhs.env;
    }

    // If rhs is type value, then it cannot be mutable
    if (isTypeValue(rhs.value) && isMutable) {
      throw this.formatErrorMessage(
        lhs.token,
        `Unexpected "mut" (or "!") for type value:
${exprToString(rhs)}`
      );
    }
    if (isTypeValue(rhs.value) && !isCompileTimeOnly) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "::" instead of ":=" for type value assignment:
${exprToString(expr)}`
      );
    }
    if (isModuleValue(rhs.value) && !isCompileTimeOnly) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "::" instead of ":=" for module value assignment:
${exprToString(expr)}`
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
      let rhsType = rhs.type;
      if (!lhs.type) {
        if (!rhsType) {
          throw this.formatErrorMessage(
            rhs.token,
            `(2) Expected type for right-hand side, got ${exprToString(rhs)}`
          );
        }
        // user didn't specify the type
        lhs.type = rhsType;
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
            type: lhs.type,
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
        if (!areTypesCompatible(lhs.type, rhsType, env)) {
          throw this.formatErrorMessage(
            lhs.token,
            `Incompatible types:
- Defined: ${typeToString(lhs.type)}
- Given  : ${typeToString(rhsType)}`
          );
        }
      }

      // Add .typeName info if necessary
      if (
        isTypeValue(rhs.value) &&
        (isStructType(rhs.value.value) ||
          isEnumType(rhs.value.value) ||
          isModuleType(rhs.value.value)) &&
        !rhs.value.value.typeName
      ) {
        rhs.value.value.typeName = lhs.token.value;
      }

      // Prohibit assigning runtime value to comptime-only variable
      if (!rhs.value && isCompileTimeOnly) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected compile-time value for "${lhs.token.value}".
Got runtime value. Please consider using ":=" instead of "::":
${exprToString(rhs)}`
        );
      }

      // Set the variable value
      lhs.value = isCompileTimeOnly ? rhs.value : undefined;
      // Add variable to env
      // Attach the updated env to expr
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: lhs.token.value,
          token: lhs.token,
          type: lhs.type,
          isMutable,
          isCompileTimeOnly,
          isNotInitialized: false,
          value: lhs.value,
        },
      });
      env = nextEnv;
      expr.env = env;
      lhs.env = env;
      expr.value = VUnit;
      expr.type = VUnit.type;
      return expr;
    } else {
      // Evaluate the destructuring assignment
      if (!rhs.type) {
        throw this.formatErrorMessage(
          rhs.token,
          `(3) Expected type for right-hand side, got ${exprToString(rhs)}`
        );
      }

      env = this.evaluateDestructuringAssignment({
        lhs,
        rhs,
        env,
        context: { ...context },
      });
      expr.value = VUnit;
      expr.type = VUnit.type;
      expr.env = env;
      return expr;
    }
  }

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

    let lhs = expr.args[0];
    let rhs = expr.args[1];

    if (
      exprIsAtom(lhs) ||
      (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2))
    ) {
      let variableName: string;
      if (exprIsAtom(lhs)) {
        // x = 12;
        if (!this.isValidVariableName(lhs)) {
          throw this.formatErrorMessage(
            lhs.token,
            `Invalid assignment to ${lhs.token.value}, expected identifier or operator`
          );
        }

        // Check if the variable exists in the environment
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
        if (bindingExpr.env) {
          env = bindingExpr.env;
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
      const variable = variables[variables.length - 1];

      // Evaluate the rhs expression
      rhs = this.evaluateExpression({
        expr: rhs,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
          expectedType: variable.type,
        },
      });
      if (rhs.env) {
        env = rhs.env;
      }

      let rhsType = rhs.type;
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
      if (!areTypesCompatible(variable.type, rhsType, env)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`
        );
      }

      if (variable.isNotInitialized) {
        env = updateExistingVariable(env, variable, {
          ...variable,
          isNotInitialized: false,
          value: rhs.value,
        });
      } else if (variable.isMutable) {
        // Update the variable value
        env = updateExistingVariable(env, variable, {
          ...variable,
          value: rhs.value,
        });
      } else {
        throw this.formatErrorMessage(
          lhs.token,
          `Cannot assign to immutable variable "${variableName}"`
        );
      }
      if (variable.isCompileTimeOnly) {
        lhs.value = rhs.value;
      } else {
        // runtime variable
        lhs.value = undefined;
      }

      lhs.type = rhsType;
      lhs.env = env;
      expr.value = VUnit;
      expr.type = VUnit.type;
      expr.env = env;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Invalid assignment is not supported for:
${exprToString(expr)}`
      );
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
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Extern)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected extern, got ${expr.tag}`
      );
    }

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (!exprIsFunctionCall(arg) || !exprIsFunctionCallOf(arg, ":", 2)) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected ":" for extern argument, got ${arg.tag}`
        );
      }
      const lhs = arg.args[0];
      const rhs = arg.args[1];

      if (!this.isValidVariableName(lhs)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Invalid extern argument name "${lhs.token.value}", expected identifier`
        );
      } else {
        const variableName = lhs.token.value;

        // Evaluate rhs type
        const evaluatedRhs = this.evaluateExpression({
          expr: rhs,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: true,
          },
        });
        if (evaluatedRhs.env) {
          env = evaluatedRhs.env;
        }
        if (!isTypeValue(evaluatedRhs.value)) {
          throw this.formatErrorMessage(
            rhs.token,
            `Expected type for extern argument, got ${exprToString(rhs)}`
          );
        } else {
          const typeValue = evaluatedRhs.value;
          const userDefinedType = typeValue.value;

          // Add the variable to the env
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: variableName,
              token: lhs.token,
              type: userDefinedType,
              isMutable: false,
              isCompileTimeOnly: true,
              isNotInitialized: false,
              value: createUnknownValue(userDefinedType),
            },
          });
          env = nextEnv;

          // Attach the user defined type to the lhs
          lhs.type = userDefinedType;
        }
      }
    }

    expr.value = VUnit;
    expr.type = VUnit.type;
    expr.env = env;

    // "extern" token
    expr.func.value = VUnit;
    expr.func.type = VUnit.type;
    expr.func.env = env;

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
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Cond)) {
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
    // condition -> value.
    // expect each value to be the same type.
    let valueType: Type | undefined = undefined;
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (
        !exprIsFunctionCall(statement) ||
        !exprIsFunctionCallOf(statement, "->", 2)
      ) {
        throw this.formatErrorMessage(
          statement.token,
          `Expected -> for cond statement, got ${statement.tag}`
        );
      }
      const condExpr = statement.args[0];
      const valueExpr = statement.args[1];

      // Expect condExpr to be a boolean
      const evaluatedCond = this.evaluateExpression({
        expr: condExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
        },
      });

      // TODO: Check comptime value if exists
      if (evaluatedCond.env) {
        env = evaluatedCond.env;
      }
      if (!evaluatedCond.type || !isBooleanType(evaluatedCond.type)) {
        throw this.formatErrorMessage(
          condExpr.token,
          `Expected boolean for cond statement, got ${exprToString(condExpr)}`
        );
      }

      // Evaluate the valueExpr
      const evaluatedValue = this.evaluateExpression({
        expr: valueExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
        },
      });

      // QUESTION: Should we update the env here?
      // if (evaluatedValue.env) {
      //   env = evaluatedValue.env;
      //}
      if (!evaluatedValue.type) {
        throw this.formatErrorMessage(
          valueExpr.token,
          `Expected type for cond statement, got ${exprToString(valueExpr)}`
        );
      }
      if (!valueType) {
        valueType = evaluatedValue.type;
      } else {
        // Check if the type is compatible
        if (!areTypesCompatible(valueType, evaluatedValue.type, env)) {
          throw this.formatErrorMessage(
            valueExpr.token,
            `Incompatible types:
- Previous: ${typeToString(valueType)}
- Current : ${typeToString(evaluatedValue.type)}`
          );
        }
      }
    }

    if (!valueType) {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to determine the type of value from the cond.`
      );
    }

    expr.type = valueType;
    // TODO: set .value to support compile-time value.
    // Right now the createUnknownValue below is wrong
    expr.value = undefined; // valueType ? createUnknownValue(valueType) : undefined;
    return expr;
  }

  private evaluateMatch({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Match)) {
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
    const valueExpr = args[0];
    const evaluatedValue = this.evaluateExpression({
      expr: valueExpr,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: false,
      },
    });

    if (evaluatedValue.env) {
      env = evaluatedValue.env;
    }

    // Check if the value is an enum type
    if (!evaluatedValue.type || !isEnumType(evaluatedValue.type)) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Expected enum type for match expression, got ${
          evaluatedValue.type
            ? typeToString(evaluatedValue.type)
            : "unknown type"
        }`
      );
    }

    const enumType = evaluatedValue.type;
    const patterns = args.slice(1);
    let resultType: Type | undefined = undefined;

    // Process each pattern
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];

      // Check if the pattern is a valid match arm
      if (
        !exprIsFunctionCall(pattern) ||
        !exprIsFunctionCallOf(pattern, "->", 2)
      ) {
        throw this.formatErrorMessage(
          pattern.token,
          `Expected -> for match pattern, got ${exprToString(pattern)}`
        );
      }

      const patternExpr = pattern.args[0];
      const resultExpr = pattern.args[1];

      // Check if the pattern is a valid enum variant
      if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCallOf(patternExpr, ".", 1)
      ) {
        // For patterns like .Red
        const variantNameExpr = patternExpr.args[0];
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

        // Evaluate the result expression
        const tempEnv = pushEnvFrame(env);
        const evaluatedResult = this.evaluateExpression({
          expr: resultExpr,
          env: tempEnv,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
          },
        });
        // We don't update the original env here since each pattern has its own scope

        if (!evaluatedResult.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.type;
        } else if (!areTypesCompatible(resultType, evaluatedResult.type, env)) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current : ${typeToString(evaluatedResult.type)}`
          );
        }
      }
      // For patterns with destructuring like Shape.Circle(r)
      else if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCall(patternExpr.func) &&
        exprIsFunctionCallOf(patternExpr.func, ".", 1)
      ) {
        const variantExpr = patternExpr.func;
        const variantNameExpr = variantExpr.args[0];
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            variantExpr.token,
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

        if (!variant.elements) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" does not have elements but got pattern with elements`
          );
        }

        // Push a new environment frame for this pattern
        const patternEnv = pushEnvFrame(env);

        // Check if the pattern arguments match the variant parameters
        const patternElements = patternExpr.args;
        if (patternElements.length > variant.elements.length) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Too many parameters in pattern. Expected ${variant.elements.length}, got ${patternElements.length}`
          );
        }

        // Add each element to environment as local variable
        for (let j = 0; j < patternElements.length; j++) {
          const patternElement = patternElements[j];
          const variantElement = variant.elements[j];

          if (
            !exprIsAtom(patternElement) ||
            !this.isValidVariableName(patternElement)
          ) {
            throw this.formatErrorMessage(
              patternElement.token,
              `Expected identifier for parameter, got ${exprToString(
                patternElement
              )}`
            );
          }

          // Assign the proper type from the variant parameter to this variable
          patternElement.type = variantElement.type;

          const { env: updatedEnv } = addVariableToEnv({
            env: patternEnv,
            variable: {
              name: patternElement.token.value,
              token: patternElement.token,
              type: variantElement.type,
              isMutable: false,
              isNotInitialized: false,
            },
          });

          // Update our local environment
          Object.assign(patternEnv, updatedEnv);
        }

        // Evaluate the result expression in the pattern's environment
        const evaluatedResult = this.evaluateExpression({
          expr: resultExpr,
          env: patternEnv,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
          },
        });

        if (!evaluatedResult.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.type;
        } else if (!areTypesCompatible(resultType, evaluatedResult.type, env)) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current: ${typeToString(evaluatedResult.type)}`
          );
        }
      } else {
        throw this.formatErrorMessage(
          patternExpr.token,
          `Invalid pattern in match expression: ${exprToString(patternExpr)}
Please use .variantName or .variantName(args) for destructuring enum variants.`
        );
      }
    }

    if (!resultType) {
      throw this.formatErrorMessage(
        expr.token,
        `Could not determine result type for match expression`
      );
    }

    // Set the type and value of the match expression
    expr.type = resultType;
    // TODO: Support the compile-time value.
    // For compile-time evaluation, we'd determine which arm matches and set the value
    expr.value = undefined; // createUnknownValue(resultType);
    expr.env = env;

    return expr;
  }

  private evaluateIdentifier({
    expr,
    env,
    context,
  }: {
    expr: AtomExpr;
    env: Environment;
    context: EvaluatorContext;
  }): AtomExpr {
    const identifier = expr.token.value;
    // Free
    if (identifier === TypeTag.Free) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TFree),
        value: TFree,
      };
      expr.type = typeOfType(TFree);
      expr.env = env;
      return expr;
    }
    // Linear
    else if (identifier === TypeTag.Linear) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TLinear),
        value: TLinear,
      };
      expr.type = typeOfType(TLinear);
      expr.env = env;
      return expr;
    }
    // Type
    else if (identifier === TypeTag.Type) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TType),
        value: TType,
      };
      expr.type = typeOfType(TType);
      expr.env = env;
      return expr;
    }
    // boolean
    else if (identifier === TypeTag.Boolean) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TBoolean),
        value: TBoolean,
      };
      expr.type = typeOfType(TBoolean);
      expr.env = env;
      return expr;
    }
    // usize
    else if (identifier === TypeTag.Usize) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TUsize),
        value: TUsize,
      };
      expr.type = typeOfType(TUsize);
      expr.env = env;
      return expr;
    }
    // isize
    else if (identifier === TypeTag.Isize) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TIsize),
        value: TIsize,
      };
      expr.type = typeOfType(TIsize);
      expr.env = env;
      return expr;
    }
    // u8
    else if (identifier === TypeTag.U8) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU8),
        value: TU8,
      };
      expr.type = typeOfType(TU8);
      expr.env = env;
      return expr;
    }
    // i8
    else if (identifier === TypeTag.I8) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI8),
        value: TI8,
      };
      expr.type = typeOfType(TI8);
      expr.env = env;
      return expr;
    }
    // u16
    else if (identifier === TypeTag.U16) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU16),
        value: TU16,
      };
      expr.type = typeOfType(TU16);
      expr.env = env;
      return expr;
    }
    // i16
    else if (identifier === TypeTag.I16) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI16),
        value: TI16,
      };
      expr.type = typeOfType(TI16);
      expr.env = env;
      return expr;
    }
    // u32
    else if (identifier === TypeTag.U32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU32),
        value: TU32,
      };
      expr.type = typeOfType(TU32);
      expr.env = env;
      return expr;
    }
    // i32
    else if (identifier === TypeTag.I32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI32),
        value: TI32,
      };
      expr.type = typeOfType(TI32);
      expr.env = env;
      return expr;
    }
    // u64
    else if (identifier === TypeTag.U64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU64),
        value: TU64,
      };
      expr.type = typeOfType(TU64);
      expr.env = env;
      return expr;
    }
    // i64
    else if (identifier === TypeTag.I64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI64),
        value: TI64,
      };
      expr.type = typeOfType(TI64);
      expr.env = env;
      return expr;
    }
    // f32
    else if (identifier === TypeTag.F32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TF32),
        value: TF32,
      };
      expr.type = typeOfType(TF32);
      expr.env = env;
      return expr;
    }
    // f64
    else if (identifier === TypeTag.F64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TF64),
        value: TF64,
      };
      expr.type = typeOfType(TF64);
      expr.env = env;
      return expr;
    }
    // Self
    else if (identifier === "Self") {
      if (!context.SelfType) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected to use "Self" in the interface/struct/enum/union context.`
        );
      }
      expr.value = createTypeValue(context.SelfType);
      expr.type = expr.value.type;
      expr.env = env;
      return expr;
    }
    /*
    // This
    // refers to Self.This in the interface context
    else if (identifier === "This") {
      if (!context.SelfType || !isModuleType(context.SelfType)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected to use "This" in the interface context.`
        );
      }

      const moduleType = context.SelfType;
      const ThisType = moduleType.members.find(
        (member) => member.label === "This"
      );
      if (!ThisType) {
        throw this.formatErrorMessage(
          expr.token,
          `"This" type not found in the interface.`
        );
      }

      expr.value =
        ThisType.value ?? createUnknownValue(ThisType.type, ThisType.label);
      expr.type = expr.value.type;
      expr.env = env;
      return expr;
    }
    */
    // variable
    else {
      const variables = getVariablesFromEnv(env, identifier);
      if (!variables.length) {
        throw this.formatErrorMessage(
          expr.token,
          `Variable "${identifier}" not found`
        );
      } else {
        const variable = variables[variables.length - 1];
        if (variable.isNotInitialized) {
          throw this.formatErrorMessage(
            expr.token,
            `Variable "${identifier}" not initialized`
          );
        }
        expr.value = variable.value;
        expr.type = variable.type;
        expr.env = env;
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
    const functionType = context.expectedType;
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
    const functionDeclarationExpr = expr.args[0];
    const functionBodyExpr = expr.args[1];

    if (
      !exprIsFunctionCall(functionDeclarationExpr) ||
      !exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.Fn)
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
    // env = pushEnvFrame(env);
    {
      const { env: nextEnv } = this.evaluateFunctionParameters({
        parameterExprs: functionDeclarationExpr.args,
        expectedParameters: functionType.params,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
        },
      });
      env = nextEnv;
    }

    // Evaluate the function body
    const evaluatedBody = this.evaluateExpression({
      expr: functionBodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: false,
        isEvaluatingFunctionBodyOfType: functionType,
      },
    });

    // Check if the return type is compatible
    const evaluatedBodyReturnType = evaluatedBody.type;
    if (
      evaluatedBodyReturnType &&
      !areTypesCompatible(
        functionType.return.type,
        evaluatedBodyReturnType,
        env
      )
    ) {
      throw this.formatErrorMessage(
        functionBodyExpr.token,
        `Incompatible return type:
- Expected: ${typeToString(functionType.return.type)}
- Got     : ${typeToString(evaluatedBodyReturnType)}`
      );
    }

    if (evaluatedBody.env) {
      env = evaluatedBody.env;
    }
    // Restore the env frame
    env = popEnvFrame(env);

    // Set the type and value of the expression
    expr.type = functionType;
    expr.value = {
      tag: ValueTag.Function,
      type: functionType,
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcId: `fn_${randomId()}`,
      calledTypeFunctionCaches: [],
      SelfType: context.SelfType,
    };
    expr.env = env;
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
      context.isEvaluatingFunctionBodyOfType;
    if (!isEvaluatingFunctionBodyOfType) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a function type for recur, got:\n${exprToString(expr)}`
      );
    }
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Recur)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected recur, got:\n${exprToString(expr)}`
      );
    }
    return this.evaluateFunctionCall({
      expr,
      env,
      givenFunc: {
        type: isEvaluatingFunctionBodyOfType,
        value: createTypeValue(isEvaluatingFunctionBodyOfType),
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
    let rhsExpr: Expr = expr;
    let parameterType: Type | undefined = undefined;

    let typeExpr: Expr = expr;
    let labelExpr: Expr | undefined = undefined;

    // Parse the lhs expr
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ":")) {
      if (expectedParameter) {
        throw this.formatErrorMessage(
          expr.token,
          `Not allowed to define parameter type for anonymous function implementation.`
        );
      }

      rhsExpr = expr.args[1];
      lhsExpr = expr.args[0];
      typeExpr = rhsExpr;

      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.Compt)
      ) {
        isCompileTimeOnly = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for "compt" (or "@"), got ${lhsExpr.args.length}`
          );
        }
        lhsExpr = lhsExpr.args[0];
      }
      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.Mut)
      ) {
        isMutable = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for "mut" (or "!"), got ${lhsExpr.args.length}`
          );
        }
        lhsExpr = lhsExpr.args[0];
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
      lhsExpr = rhsExpr;

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
      // Parse the rhs expr which should be a type
      const evaluatedRhs = this.evaluateExpression({
        expr: rhsExpr,
        env,
        context: { ...context },
      });
      if (evaluatedRhs.env) {
        env = evaluatedRhs.env;
      }

      // Expected the evaluatedRhs to be a type
      const typeValue = evaluatedRhs.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `(1) Expected type for function parameter, got ${exprToString(
            rhsExpr
          )}`
        );
      }
      parameterType = typeValue.value;
    }

    if (
      (isTypeHierarchyType(parameterType) || isModuleType(parameterType)) &&
      !isCompileTimeOnly
    ) {
      throw this.formatErrorMessage(
        lhsExpr?.token ?? rhsExpr.token,
        `Expected a "compt" (or "@") for parameter to be compile-time only.`
      );
    }

    if (lhsExpr) {
      const value = isCompileTimeOnly
        ? createUnknownValue(parameterType, label)
        : undefined;

      if (label) {
        // Add the parameter to the env
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: label,
            token: lhsExpr.token,
            type: parameterType,
            isMutable: isMutable,
            isCompileTimeOnly: isCompileTimeOnly,
            isNotInitialized: false, // Set as initialized
            value: isCompileTimeOnly
              ? createUnknownValue(parameterType, label)
              : undefined,
          },
        });
        env = nextEnv;
      }
      lhsExpr.env = env;
      lhsExpr.value = value;
      lhsExpr.type = parameterType;
    }

    expr.env = env;
    return {
      parameter: {
        label,
        type: parameterType,
        labelExpr,
        typeExpr,
        isMutable,
        isCompileTimeOnly,
        // defaultValue: undefined,
      },
      env,
    };
  }

  /**
   * NOTE: Calling this function will increase the env frame.
   */
  private evaluateFunctionParameters({
    parameterExprs,
    expectedParameters,
    env,
    context,
  }: {
    parameterExprs: Expr[];
    expectedParameters?: FunctionParameter[];
    env: Environment;
    context: EvaluatorContext;
  }): { parameters: FunctionParameter[]; env: Environment } {
    env = pushEnvFrame(env);
    const parameters: FunctionParameter[] = [];
    for (let i = 0; i < parameterExprs.length; i++) {
      const parameterExpr = parameterExprs[i];
      const { parameter, env: nextEnv } = this.evaluateFunctionParameter({
        expr: parameterExpr,
        expectedParameter: expectedParameters?.[i],
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
        },
      });

      // Check if there is duplicate labels
      if (parameter.label) {
        const duplicateLabel = parameters.find(
          (element) => element.label === parameter.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(parameterExpr)
              ? parameterExpr.args[0]?.token ?? parameterExpr.token
              : parameterExpr.token,
            `Duplicate label "${parameter.label}" in function parameter`
          );
        }
      }

      parameters.push(parameter);
      env = nextEnv;
    }
    return {
      parameters,
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
    //   exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)
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

    const argListExpr = expr.args[0];
    let returnTypeExpr = expr.args[1];

    // Handle different forms of parameter lists
    let argList: Expr[] = [];
    if (
      exprIsFunctionCall(argListExpr) &&
      exprIsFunctionCallOf(argListExpr, BuiltinCollections.Tuple)
    ) {
      // Handle tuple-style parameter list: (param1: Type1, param2: Type2)
      argList = argListExpr.args;
    } else if (
      exprIsAtom(argListExpr) ||
      (exprIsFunctionCall(argListExpr) &&
        exprIsFunctionCallOf(argListExpr, ":"))
    ) {
      argList = [argListExpr];
    } else {
      throw this.formatErrorMessage(
        argListExpr.token,
        `Expected tuple for function parameters, got:\n${exprToString(
          argListExpr
        )}`
      );
    }

    // Evaluate the parameter list
    const { parameters, env: nextEnv } = this.evaluateFunctionParameters({
      parameterExprs: argList,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: true,
      },
    });
    env = nextEnv;

    // Analysize the return type expression
    /// Evaluate the proofs
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, "=>", 2)
    ) {
      // const lhsExpr = returnTypeExpr.args[0];
      returnTypeExpr = returnTypeExpr.args[1];

      /*
      const evaluatedProofAssumptionsExpr = this.evaluateProofAssumptions({
        expr: lhsExpr,
        env,
        context: {
          ...context,
        },
      });
      */
    }
    /// Check if the function is returning compile-time only value.
    let isReturnTypeCompileTimeOnly = false;
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.Compt)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnTypeExpr.args.length !== 1) {
        throw this.formatErrorMessage(
          returnTypeExpr.token,
          `Expected one argument for "compt" (or "@"), got ${returnTypeExpr.args.length}`
        );
      }
      returnTypeExpr = returnTypeExpr.args[0];
    }

    // Evaluate the return type expression
    const evaluatedReturnType = this.evaluateExpression({
      expr: returnTypeExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });

    // Check that the return type is indeed a type
    if (!isTypeValue(evaluatedReturnType.value)) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a type for function return type, got:\n${exprToString(
          returnTypeExpr
        )}`
      );
    }
    const returnType = evaluatedReturnType.value.value;
    if (
      (isTypeHierarchyType(returnType) || isModuleType(returnType)) &&
      !isReturnTypeCompileTimeOnly
    ) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a "compt" (or "@") for return type, like:\n
compt(${exprToString(returnTypeExpr)})`
      );
    }

    // If the returnType is compile time only, then
    // we need to make sure all the parameters are compile time only
    if (isReturnTypeCompileTimeOnly) {
      for (const parameter of parameters) {
        if (!parameter.isCompileTimeOnly) {
          throw this.formatErrorMessage(
            parameter.labelExpr?.token ?? parameter.typeExpr.token,
            `Expected all parameters to be compile time only given the return type is compile time only.`
          );
        }
      }
    }

    // Create the function type
    const functionType = createFunctionType({
      params: parameters,
      return_: {
        type: returnType,
        expr: returnTypeExpr,
        isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      },
      env: popEnvFrame(env),
      SelfType: context.SelfType,
    });

    // Pop the environment frame
    env = popEnvFrame(env);

    // Set the type and value of the expression
    expr.type = typeOfType(functionType);
    expr.value = createTypeValue(functionType);
    return expr;
  }

  private evaluateTypeExpression({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Type, 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected type with 1 argument, got:\n${exprToString(expr)}`
      );
    }

    const typeExpr = expr.args[0];
    const evaluatedType = this.evaluateExpression({
      expr: typeExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    if (evaluatedType.env) {
      env = evaluatedType.env;
    }
    const typeValue = evaluatedType.value;
    if (!isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        typeExpr.token,
        `Expected a type for type expression, got:\n${exprToString(typeExpr)}`
      );
    }
    expr.type = typeValue.type;
    expr.value = typeValue;
    expr.env = env;

    // Add information to the `type` token
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

    return expr;
  }

  private evaluateStruct({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Struct)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "struct", got:\n${exprToString(expr)}`
      );
    }

    const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
      args: expr.args,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    env = nextEnv;

    const structType: StructType = createStructType(tupleType.elements);
    expr.value = createTypeValue(structType);
    expr.type = expr.value.type;
    expr.env = env;

    // Append more information to "struct" token.
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

    return expr;
  }

  private evaluateEnum({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Enum)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "enum", got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the variants
    const variants: EnumVariant[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const enumArg = expr.args[i];

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

        const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
          args: enumArg.args,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: true,
          },
        });
        env = nextEnv;

        variants.push({
          name: variantName,
          elements: tupleType.elements,
        });
      }
    }

    const enumType: EnumType = createEnumType(variants);
    expr.type = typeOfType(enumType);
    expr.value = createTypeValue(enumType);
    expr.env = env;

    // Append more information to "enum" token.
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

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
      const propertyExpr = expr.args[0];
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

      const expectedEnumType = context.expectedType;
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
        expr.type = newEnumType;
        propertyExpr.type = newEnumType;
        // FIXME: Support expr.value for comptime evaluation.
        expr.value = createEnumValue(newEnumType, variantName, []);
      } else {
        /**
         * This is for case like
         * Shape := enum Circle(i32), Square(i32, i32);
         * c := Shape.Circle(3);
         */
        expr.value = createTypeValue(newEnumType);
        expr.type = expr.value.type;
        propertyExpr.value = expr.value;
        propertyExpr.type = expr.type;
      }
      expr.env = env;
      return expr;
    }

    if (!exprIsFunctionCallOf(expr, ".", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    let objectExpr = expr.args[0];
    const propertyExpr = expr.args[1];

    // Evaluate object
    objectExpr = this.evaluateExpression({
      expr: objectExpr,
      env,
      context: { ...context },
    });
    if (objectExpr.env) {
      env = objectExpr.env;
    }

    if (isTypeValue(objectExpr.value)) {
      const typeValue = objectExpr.value;
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
         * r := Color.Red;
         */
        if (!variant.elements) {
          expr.type = newEnumType;
          propertyExpr.type = newEnumType;
          // FIXME: Support expr.value for comptime evaluation.
          expr.value = createEnumValue(newEnumType, variantName, []);
        } else {
          /**
           * This is for case like
           * Shape := enum Circle(i32), Square(i32, i32);
           * c := Shape.Circle(3);
           */
          expr.value = createTypeValue(newEnumType);
          expr.type = expr.value.type;
          propertyExpr.value = expr.value;
          propertyExpr.type = expr.type;
        }
        expr.env = env;
        return expr;
      }
    }

    if (isTupleType(objectExpr.type) || isStructType(objectExpr.type)) {
      let elements: TupleElement[] = [];
      const objectExprValue = objectExpr.value;
      if (isTupleType(objectExpr.type)) {
        elements = objectExpr.type.elements;
      } else if (isStructType(objectExpr.type)) {
        elements = objectExpr.type.elements;
      }
      // Check if it's accessing the tuple element by
      // - number index: point.0
      // - label name:   point.x
      if (exprIsAtom(propertyExpr)) {
        if (propertyExpr.token.type === TokenType.Integer) {
          const index = parseInt(propertyExpr.token.value, 10);
          if (isNaN(index)) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Expected integer for tuple index, got:\n${exprToString(
                propertyExpr
              )}`
            );
          }
          if (index < 0 || index >= elements.length) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Index out of bounds: ${index} for accessing element in:\n${typeToString(
                objectExpr.type
              )}`
            );
          }
          const tupleElement = elements[index];
          expr.type = tupleElement.type;
          propertyExpr.type = tupleElement.type;
          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            let values: Value[] | undefined = [];
            if (isTupleValue(objectExprValue)) {
              values = objectExprValue.elements;
            } else if (isStructValue(objectExprValue)) {
              values = objectExprValue.elements;
            }
            expr.value = values?.[index];
          }
          return expr;
        } else if (this.isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;
          // Check if the type method exists
          const method = (objectExpr.type.methods ?? []).find(
            (method) => method.label === label
          );
          if (method) {
            expr.value = undefined; // NOTE: Set it to `undefined` so the `evaluateFunctionCall` will handle this.
            expr.type = undefined; // NOTE: Set it to `undefined` so the `evaluateFunctionCall` will handle this.
            propertyExpr.value = method.value;
            propertyExpr.type = method.type;
            return expr;
          } else {
            const tupleElementIndex = elements.findIndex(
              (element) => element.label === label
            );
            if (tupleElementIndex < 0) {
              // It could be interface method call
              expr.type = undefined;
              expr.value = undefined;
              return expr;
            }
            const tupleElement = elements[tupleElementIndex];
            expr.type = tupleElement.type;
            propertyExpr.type = tupleElement.type;
            // TODO: Support comptime value
            // expr.value = ...
            if (objectExprValue) {
              let values: Value[] | undefined = [];
              if (isTupleValue(objectExprValue)) {
                values = objectExprValue.elements;
              } else if (isStructValue(objectExprValue)) {
                values = objectExprValue.elements;
              }
              expr.value = values?.[tupleElementIndex];
            }
            return expr;
          }
        }
      }
    } else if (isModuleValue(objectExpr.value)) {
      // Check if it's accessing the module member by
      // - label name:   my_module.add
      if (exprIsAtom(propertyExpr)) {
        const label = propertyExpr.token.value;
        // Check if the type method exists
        const moduleValue = objectExpr.value;
        const moduleType = moduleValue.type;
        const moduleMember = (moduleType.members ?? []).find(
          (member) => member.label === label
        );
        if (moduleMember) {
          expr.value = moduleValue.members[label];
          expr.type = moduleMember.type;
          propertyExpr.value = expr.value;
          propertyExpr.type = expr.type;
          return expr;
        } else {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Module member "${label}" not found in module`
          );
        }
      } else {
        throw this.formatErrorMessage(
          propertyExpr.token,
          `Expected identifier for module member, got:\n${exprToString(
            propertyExpr
          )}`
        );
      }
    }

    // TODO: Evaluate the interface method call
    // Since we fail to evaluate the property access
    // it could be an ~~uniform function call~~ interface method call.
    expr.type = undefined;
    expr.value = undefined;
    return expr;
  }

  /**
   * Evaluate expression such as:
   *
   * def id_func:
   *   forall(compt(T): Type) .
   *     (x: T)-> T,
   * {
   *   return x;
   * }
   *
   */
  private evaluateForall({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const forallExpr = expr.args[0];
    const typeExpr = expr.args[1];

    if (!typeExpr) {
      throw this.formatErrorMessage(
        forallExpr.token,
        `Expected type expression for "forall", got:\n${exprToString(
          forallExpr
        )}`
      );
    }
    if (
      !exprIsFunctionCall(forallExpr) ||
      !exprIsFunctionCallOf(forallExpr, BuiltinKeywords.Forall)
    ) {
      throw this.formatErrorMessage(
        forallExpr.token,
        `Expected "forall", got:\n${exprToString(forallExpr)}`
      );
    }

    // Add new frame to hold the type variables.
    env = pushEnvFrame(env);

    // Evaluate type variables:
    const forallArgExprs = forallExpr.args;
    for (let i = 0; i < forallArgExprs.length; i++) {
      const colonExpr = forallArgExprs[i];
      if (
        !exprIsFunctionCall(colonExpr) ||
        !exprIsFunctionCallOf(colonExpr, ":", 2)
      ) {
        throw this.formatErrorMessage(
          colonExpr.token,
          `Expected ":" to define type variable, got:\n${exprToString(
            colonExpr
          )}`
        );
      }

      const comptExpr = colonExpr.args[0];
      const typeExpr = colonExpr.args[1];
      if (
        !exprIsFunctionCall(comptExpr) ||
        !exprIsFunctionCallOf(comptExpr, BuiltinKeywords.Compt)
      ) {
        throw this.formatErrorMessage(
          comptExpr.token,
          `Expected "compt" (or "@") for type variable, got:\n${exprToString(
            comptExpr
          )}`
        );
      }

      const labelExpr = comptExpr.args[0];
      if (!exprIsAtom(labelExpr) || !this.isValidVariableName(labelExpr)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for type variable, got:\n${exprToString(
            labelExpr
          )}`
        );
      }
      const label = labelExpr.token.value;
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
        },
      });
      if (evaluatedTypeExpr.env) {
        env = evaluatedTypeExpr.env;
      }
      const typeValue = evaluatedTypeExpr.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for "any" expression, got:\n${exprToString(typeExpr)}`
        );
      }
      const type = typeValue.value;
      if (!isTypeHierarchyType(type) || type.level !== 0) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected "Type" (or "Free" or "Linear"), got:\n${exprToString(
            typeExpr
          )}`
        );
      }

      const value = createUnknownValue(type, label);

      // Add value to env
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: label,
          token: labelExpr.token,
          type,
          isMutable: false,
          isCompileTimeOnly: true,
          isNotInitialized: false, // Set as initialized
          value,
        },
      });
      env = nextEnv;

      // Attach necessary information
      labelExpr.value = value;
      labelExpr.type = value.type;
      labelExpr.env = env;
    }

    // Evaluate the type expression
    const evaluatedTypeExpr = this.evaluateExpression({
      expr: typeExpr,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: true,
      },
    });

    if (evaluatedTypeExpr.env) {
      env = evaluatedTypeExpr.env;
    }
    const value = evaluatedTypeExpr.value;

    // `forall` can only work with FunctionType or ModuleType.
    // Supporting other types means to support Rank N Types.
    if (
      !isTypeValue(value) ||
      !(isFunctionType(value.value) || isModuleType(value.value))
    ) {
      throw this.formatErrorMessage(
        typeExpr.token,
        `Expected either function or interface type for "forall" expression, got:\n${exprToString(
          typeExpr
        )}`
      );
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Attach necessary informations
    expr.value = value;
    expr.type = value.type;
    expr.env = env;

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
    givenFunc?: { type: Type; value: TypeValue };
    context: EvaluatorContext;
  }): FuncCallExpr {
    const func = expr.func;
    let args = expr.args;

    // For interface method call
    let methodExpr: Expr | undefined = undefined;

    let functions: { type: Type; value?: Value; error?: Error }[] = [];
    if (givenFunc) {
      functions = [givenFunc];
    } else if (exprIsFunctionCall(func)) {
      const functionToCall = this.evaluateExpression({
        expr: func,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
        },
      });
      // Check if . property access for interface method call
      if (!functionToCall.type) {
        if (
          exprIsFunctionCall(functionToCall) &&
          exprIsFunctionCallOf(functionToCall, ".", 2)
        ) {
          const receiverArg = functionToCall.args[0];
          methodExpr = functionToCall.args[1];

          // The receiverArg should already be evaluated in the previous step
          // so it should have a type
          const receiverType = receiverArg.type;
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
                isEvaluatingExprAsType: false,
              },
            });
            if (nextExpr.env) {
              env = nextExpr.env;
            }
            methodExpr = nextExpr;

            const methodType = methodExpr.type;
            const methodValue = methodExpr.value;
            if (!methodType || !methodValue) {
              throw this.formatErrorMessage(
                methodExpr.token,
                `Expected to be an interface method.`
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
            type: functionToCall.type,
            value: functionToCall.value,
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
          throw this.formatErrorMessage(
            func.token,
            `Failed to infer type for _ function`
          );
        }
        functions = [
          {
            type: typeOfType(expectedType),
            value: createTypeValue(expectedType),
          },
        ];
      }
      // Operator is taken as an interface method call
      else if (stringIsOperator(functionName)) {
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
            isEvaluatingExprAsType: false,
          },
        });
        const receiverType = evaluatedFirstArg.type;
        if (!receiverType) {
          throw this.formatErrorMessage(
            firstArg.token,
            `Expected to be evaluated.`
          );
        }
        const methodName = functionName;
        methodExpr = func;
        // Get the method with the same name in the interface in the env
        const interfaceMethods = getMethodsByNameFromEnv(
          env,
          methodName,
          receiverType
        );
        functions = interfaceMethods.map((method) => ({
          type: method.type,
          value: method.value,
        }));
        // No need to change the args
      } else {
        /**
         * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
         */
        const functionVariables = getVariablesFromEnv(env, functionName);
        functions = functionVariables.map((variable) => ({
          type: variable.type,
          value: variable.value,
        }));
      }
    }

    // Find the functions whose parameters match the arguments
    const functionsToCall = functions.map((functionToCall) => {
      if (isFunctionType(functionToCall.type)) {
        try {
          this.tryToCallFunctionWithArguments({
            functionValue: functionToCall.value as FunctionValue | undefined,
            functionType: functionToCall.type,
            functionCallExpr: func,
            argExprs: args,
            env,
            context: { ...context },
          });
        } catch (error) {
          functionToCall.error = error;
        }
        return functionToCall;
      } else {
        const value = functionToCall.value;
        // struct value
        if (isTypeValue(value) && isStructType(value.value)) {
          try {
            this.tryToCallTypeWithArguments({
              memberElements: value.value.elements,
              functionCallExpr: func,
              argExprs: args,
              env,
              context: { ...context },
            });
          } catch (error) {
            functionToCall.error = error;
          }
        }
        // enum value
        else if (isTypeValue(value) && isEnumType(value.value)) {
          const enumType = value.value;
          const selectedVariant = enumType.variants.find(
            (variant) => variant.name === enumType.selectedVariantName
          );
          if (!selectedVariant) {
            throw this.formatErrorMessage(
              expr.token,
              `Enum variant not selected for enum type`
            );
          }
          try {
            this.tryToCallTypeWithArguments({
              memberElements: selectedVariant.elements || [],
              functionCallExpr: func,
              argExprs: args,
              env,
              context: { ...context },
            });
          } catch (error) {
            functionToCall.error = error;
          }
        }
        // interface
        else if (isTypeValue(value) && isModuleType(value.value)) {
          const moduleType = value.value;
          try {
            this.tryToImplementModuleWithArguments({
              moduleExpr: func,
              moduleType: moduleType,
              argExprs: args,
              env,
              context: { ...context },
            });
          } catch (error) {
            functionToCall.error = error;
          }
        } else {
          functionToCall.error = new Error(`Invalid function call`);
        }
        return functionToCall;
      }
    });

    const functionsWithMatchingTypes = functionsToCall.filter(
      (functionToCall) => !functionToCall.error
    );

    if (functionsWithMatchingTypes.length === 0) {
      if (functionsToCall.length === 1) {
        throw functionsToCall[0].error!;
      }

      throw this.formatErrorMessage(
        func.token,
        `No matching call found with arguments:
${exprToString(expr)}

${functionsToCall.length ? "Available functions:\n" : ""}${functionsToCall
          .map((func) => {
            const error = func.error;
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

    const functionToCall = functionsWithMatchingTypes[0];

    if (isFunctionType(functionToCall.type)) {
      const functionType = functionToCall.type;

      // It is type function
      if (isFunctionTypeAndIsTypeFunction(functionType)) {
        const functionValue = functionToCall.value;
        if (!isFunctionValue(functionValue)) {
          throw this.formatErrorMessage(
            expr.token,
            `Function value is not defined`
          );
        }
        const { value: returnValue, env: nextEnv } =
          this.evaluateTypeFunctionCall({
            functionCallExpr: expr,
            functionType,
            functionValue,
            argExprs: args,
            env,
            context: {
              ...context,
            },
          });
        env = nextEnv;
        expr.value = returnValue;
        expr.type = returnValue.type;

        // Attach necessary info to the func
        func.type = functionToCall.type;
        func.value = functionToCall.value;
      } else {
        // It's
        // - Runtime function
        // - Comptime function
        const { returnType, env: nextEnv } =
          this.evaluateFunctionCallReturnType({
            functionCallExpr: expr,
            functionValue: functionToCall.value as FunctionValue | undefined,
            functionType,
            argExprs: args,
            env,
            context: {
              ...context,
              SelfType: functionType.SelfType,
            },
          });
        env = nextEnv;
        expr.type = returnType;

        if (functionType.return.isCompileTimeOnly) {
          // TODO: expr.value should be available for comptime function.
          // We should evaluate its body.
          expr.value = createUnknownValue(returnType);
        }

        // Attach necessary info to the func
        func.type = functionToCall.type;
        func.value = functionToCall.value;
        if (methodExpr) {
          methodExpr.type = functionToCall.type;
          methodExpr.value = functionToCall.value;
        }
      }
      return expr;
    } else {
      const value = functionToCall.value;
      // struct value
      if (isTypeValue(value) && isStructType(value.value)) {
        const structType = value.value;
        expr.type = structType;
        expr.env = env;
        // FIXME: Support to set value for comptime
        const memberValues = this.tryToCallTypeWithArguments({
          memberElements: value.value.elements,
          functionCallExpr: func,
          argExprs: args,
          env,
          context: {
            ...context,
          },
        });
        if (!memberValues) {
          throw this.formatErrorMessage(
            func.token,
            `Error evaluating struct call.`
          );
        }
        if (memberValues.every((v) => !!v)) {
          const structValue = createStructValue(
            structType,
            memberValues as Value[]
          );
          expr.value = structValue;
        }

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
      // enum value
      else if (isTypeValue(value) && isEnumType(value.value)) {
        const enumType = value.value;
        expr.type = enumType;
        expr.env = env;
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
        const memberValues = this.tryToCallTypeWithArguments({
          memberElements: selectedVariant.elements || [],
          functionCallExpr: func,
          argExprs: args,
          env,
          context: { ...context },
        });
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
          expr.value = enumValue;
        }

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
      // interface
      else if (isTypeValue(value) && isModuleType(value.value)) {
        const moduleValue = this.tryToImplementModuleWithArguments({
          moduleExpr: func,
          moduleType: value.value,
          argExprs: args,
          env,
          context: {
            ...context,
          },
        });

        expr.value = moduleValue;
        expr.type = moduleValue.type;
        expr.env = env;

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Function call is not implemented yet:
${exprToString(expr)}`
    );
  }

  /**
   * NOTE: This function will push new frame to env, but will not pop frame.
   */
  private tryToCallFunctionWithArguments({
    functionValue,
    functionType,
    functionCallExpr,
    argExprs,
    env,
    context,
  }: {
    functionValue?: FunctionValue;
    functionType: FunctionType;
    functionCallExpr: Expr;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    // NOTE: We disallow to have default values for function parameters
    if (argExprs.length !== functionType.params.length) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Expected ${functionType.params.length} arguments, got ${argExprs.length}.`
      );
    }

    env = pushEnvFrame(env);
    for (let i = 0; i < functionType.params.length; i++) {
      const paramElement = functionType.params[i];
      let argExpr = argExprs[i];

      // NOTE: We don't support named argument.
      // But we support to use label for readibility.
      // eg: add(1, 2) vs add(x: 1, y: 2)
      let labelExpr: Expr | undefined = undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        labelExpr = argExpr.args[0];
        argExpr = argExpr.args[1];

        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label, got:\n${exprToString(labelExpr)}`
          );
        }
        const label = labelExpr.token.value;

        if (paramElement.label !== label) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Named argument is not supported. Label is only used for readibility. 
Expected ${
              paramElement ? `label "${paramElement.label}"` : `no label`
            } at the argument position, but got "${label}".`
          );
        }
      }

      // Evaluate the argExpr
      let evaluatedArgExpr: Expr | undefined = undefined;
      try {
        evaluatedArgExpr = this.evaluateExpression({
          expr: argExpr,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
            expectedType: paramElement.type,
          },
        });
      } catch (error) {
        logger.debug(error);
        throw error;
      }
      if (!evaluatedArgExpr) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
        );
      }

      const argType = evaluatedArgExpr.type;
      if (!argType) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
        );
        // If synthesis fails, the types are not compatible
      }

      // Pass a type to parameter
      // eg: compt(T): Type
      /*
      if (
        isTypeHierarchyType(paramElement.type) &&
        paramElement.type.level === 0
      ) {
        // Check if the type is a subtype of the given type
        // TODO: Check interfaces
        if (!isTypeHierarchyType(argType) || argType.level !== 0) {
          logger.debug("return false(3)");
          return false;
        }
        if (paramElement.label) {
          const argValue = evaluatedArgExpr.value;

          // Add the arg to the environment
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: paramElement.label,
              type: argType,
              isMutable: paramElement.isMutable,
              isCompileTimeOnly: paramElement.isCompileTimeOnly,
              token: argExpr.token,
              isNotInitialized: false,
              value: argValue,
            },
          });
          env = nextEnv;
        }
      }
      */

      // Cannot assign runtime parameter to compt parameter
      if (!evaluatedArgExpr.value && paramElement.isCompileTimeOnly) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Cannot assign runtime parameter to compile-time parameter:\n${exprToString(
            argExpr
          )}`
        );
      }

      // Add the arg to the environment
      if (paramElement.label) {
        const argValue = evaluatedArgExpr.value;
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: paramElement.label,
            type: argType,
            isMutable: paramElement.isMutable,
            isCompileTimeOnly: paramElement.isCompileTimeOnly,
            token: argExpr.token,
            isNotInitialized: false,
            value: argValue,
          },
        });
        env = nextEnv;
      }

      // Synthesize the types
      const nextEnv = this.synthesizeTypes(
        paramElement.type,
        argType,
        env,
        paramElement.typeExpr.token
      );
      env = nextEnv;

      // Evaluate the parameter type again
      const evaluatedParameterType = this.evaluateExpression({
        expr: paramElement.typeExpr,
        env: pushEnvFrame(functionType.env, env.frames[env.frames.length - 1]),
        context: {
          ...context,
          isEvaluatingExprAsType: true,
          expectedType: undefined,
          SelfType: functionValue?.SelfType,
        },
      });
      const evaluatedParameterTypeValue = evaluatedParameterType.value;
      if (!isTypeValue(evaluatedParameterTypeValue)) {
        throw this.formatErrorMessage(
          paramElement.typeExpr.token,
          `Expected type for parameter, got:\n${exprToString(
            evaluatedParameterType
          )}`
        );
      }
      const paramElementType = evaluatedParameterTypeValue.value;

      // Compare the types
      if (!areTypesCompatible(paramElementType, argType, env)) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Type mismatch for parameter "${paramElement.label}":
Expected: ${typeToString(paramElementType)}
Got:   ${typeToString(argType)}`
        );
      }
    }

    return env;
  }

  private tryToCallTypeWithArguments({
    memberElements,
    functionCallExpr,
    argExprs,
    env,
    context,
  }: {
    memberElements: TupleElement[];
    functionCallExpr: Expr;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): (Value | undefined)[] {
    if (argExprs.length > memberElements.length) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Failed to call the type. Too many members provided. Expected ${memberElements.length} arguments, got ${argExprs.length}.`
      );
    }

    const checkedMemberElements: Set<TupleElement> = new Set();
    const values: (Value | undefined)[] = Array(memberElements.length).fill(
      undefined
    );
    for (let i = 0; i < memberElements.length; i++) {
      let memberElement = memberElements[i];
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
        labelExpr = argExpr.args[0];
        argExpr = argExpr.args[1];

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
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
          expectedType: memberElement.type,
        },
      });

      const argType = evaluatedArgExpr.type;
      if (!argType) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
        );
      }

      // Compare the types
      if (!areTypesCompatible(memberElement.type, argType, env)) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Type mismatch for type member "${memberElement.label}":
Expected: ${typeToString(memberElement.type)}
Got:   ${typeToString(argType)}`
        );
      }

      // Set the values
      values[memberElementPositionIndex] = evaluatedArgExpr.value;
      checkedMemberElements.add(memberElement);
    }

    // Check if any unchecked member elements have no default value
    for (let i = 0; i < memberElements.length; i++) {
      const memberElement = memberElements[i];
      if (!checkedMemberElements.has(memberElement)) {
        if (!memberElement.defaultValue) {
          throw this.formatErrorMessage(
            functionCallExpr.token,
            `Type member "${memberElement.label}" is not provided and has no default value.`
          );
        } else {
          // Set the default value to values
          values[i] = memberElement.defaultValue;
        }
      }
    }

    return values;
  }

  private tryToImplementModuleWithArguments({
    moduleExpr,
    moduleType,
    argExprs,
    env,
    context,
  }: {
    moduleExpr: Expr;
    moduleType: ModuleType;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): ModuleValue {
    if (argExprs.length > moduleType.members.length) {
      throw this.formatErrorMessage(
        moduleExpr.token,
        `Failed to implement the module. Too many members provided.`
      );
    }

    const members: Record<string, Value> = {};
    env = pushEnvFrame(env);
    for (let i = 0; i < moduleType.members.length; i++) {
      const moduleMember = moduleType.members[i];
      let foundArgExpr = false;
      let label: string | undefined = undefined;
      // Traverse over argExprs to see if there is label for the member
      for (let j = 0; j < argExprs.length; j++) {
        let argExpr = argExprs[j];

        // Check if it's a label
        let labelExpr: Expr | undefined;
        if (
          exprIsFunctionCall(argExpr) &&
          exprIsFunctionCallOf(argExpr, ":", 2)
        ) {
          labelExpr = argExpr.args[0];
          argExpr = argExpr.args[1];

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

        if (moduleMember.label === label) {
          foundArgExpr = true;

          // evaluate the module member type again.
          const evaluatedModuleMember = this.evaluateExpression({
            expr: moduleMember.typeExpr,
            env: pushEnvFrame(
              moduleType.env,
              env.frames[env.frames.length - 1]
            ),
            context: {
              ...context,
              isEvaluatingExprAsType: true,
              expectedType: undefined,
              SelfType: moduleType,
            },
          });
          const evaluatedModuleMemberTypeValue = evaluatedModuleMember.value;
          if (!isTypeValue(evaluatedModuleMemberTypeValue)) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Failed to evaluate the module member "${label}"`
            );
          }
          const moduleMemberType = evaluatedModuleMemberTypeValue.value;

          // evaluate the argExpr
          const evaluatedArgExpr = this.evaluateExpression({
            expr: argExpr,
            env,
            context: {
              ...context,
              isEvaluatingExprAsType: false,
              expectedType: moduleMemberType,
              SelfType: moduleType,
            },
          });
          const argType = evaluatedArgExpr.type;
          if (!argType) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Failed to evaluate the module member "${label}"`
            );
          }
          if (evaluatedArgExpr.env) {
            env = evaluatedArgExpr.env;
          }

          // Compare the types
          if (!areTypesCompatible(moduleMemberType, argType, env)) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Type mismatch for the module member "${label}":
Expected: ${typeToString(moduleMemberType)}
Got:   ${typeToString(argType)}`
            );
          }
          const argValue = evaluatedArgExpr.value;
          if (!argValue) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Failed to evaluate the module member "${label}"`
            );
          }

          // Save the value to the members
          members[label] = argValue;
          // Add to the env
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: label,
              type: argType,
              isMutable: false,
              isCompileTimeOnly: true,
              token: argExpr.token,
              isNotInitialized: false,
              value: argValue,
            },
          });
          env = nextEnv;

          // Add the type information to argExpr
          argExpr.type = argType;
          argExpr.value = argValue;
          argExpr.env = env;
          if (labelExpr) {
            labelExpr.type = argType;
            labelExpr.value = argValue;
            labelExpr.env = env;
          }
          break;
        }
      }

      if (!foundArgExpr) {
        // Check if moduleMember has default value
        if (!moduleMember.defaultValue) {
          throw this.formatErrorMessage(
            moduleExpr.token,
            `Module member "${moduleMember.label}" is not provided and has no default value.`
          );
        }

        // Add the value to the members
        members[moduleMember.label] = moduleMember.defaultValue;
        // Add to the env
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: moduleMember.label,
            type: moduleMember.type,
            isMutable: false,
            isCompileTimeOnly: true,
            token: moduleExpr.token,
            isNotInitialized: false,
            value: moduleMember.defaultValue,
          },
        });
        env = nextEnv;
      }
    }

    // Create the module value
    const moduleValue = createModuleValue(moduleType, members);
    return moduleValue;
  }

  private evaluateTypeFunctionCall({
    functionCallExpr,
    functionType,
    functionValue,
    argExprs,
    env,
    context,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    functionValue: FunctionValue;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { value: TypeValue; env: Environment } {
    // This will push a new frame to the env and
    // add the parameters to the env
    const nextEnv = this.tryToCallFunctionWithArguments({
      functionValue,
      functionType,
      functionCallExpr,
      argExprs,
      env,
      context: { ...context },
    });

    if (!nextEnv) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Incompatible types for function call:
Expected: ${typeToString(functionType)}`
      );
    }
    env = nextEnv;

    // argExprs should be evaluated now
    const argValues: Value[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const argValue = argExprs[i].value;
      if (!argValue || isUnknownValue(argValue)) {
        throw this.formatErrorMessage(
          argExprs[i].token,
          `Argument is not evaluated correctly`
        );
      }
      argValues.push(argValue);
    }

    // For type function, argValues cannot be undefined
    if (!argValues) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Type function call is not evaluated correctly`
      );
    }

    // Check if it's in calledTypeFunctions
    const funcId = functionValue.funcId;
    const calledTypeFunctions = functionValue.calledTypeFunctionCaches;
    if (calledTypeFunctions) {
      // Check if the function is already called.
      const calledTypeFunction = calledTypeFunctions.find((cache) => {
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

            return areValuesEqual(argValue, givenArgValue, env);
          })
        ); // Check if the values are equal
      });
      if (calledTypeFunction) {
        // Find the cache
        env = popEnvFrame(env);
        return {
          env,
          value: calledTypeFunction.typeValue,
        };
      }
    }

    // Evaluate functionValue.body with the function env
    const functionBodyExpr = functionValue.body;
    // NOTE: We should use the env from the function, not the current env.
    const functionEnv = pushEnvFrame(
      functionType.env,
      env.frames[env.frames.length - 1]
    ); // Add the env last frame which contains evaluated args
    const evaluatedFunctionBody = this.evaluateExpression({
      expr: functionBodyExpr,
      env: functionEnv,
      context: { ...context, isEvaluatingExprAsType: false },
    });
    if (!evaluatedFunctionBody.env) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `(evaluateTypeFunctionCall) Function body is not evaluated correctly`
      );
    }

    // Get the return type value
    const returnValue = evaluatedFunctionBody.value;
    if (!isTypeValue(returnValue)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `(evaluateTypeFunctionCall) Function body is not evaluated correctly. Expected to return a type.`
      );
    }
    const returnType = returnValue.value;
    if (
      isStructType(returnType) ||
      isEnumType(returnType) ||
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

    // Restore the environment frames
    env = popEnvFrame(env);

    // Cache the function call
    const caches = (calledTypeFunctions ?? []).concat({
      funcId,
      argValues,
      typeValue: returnValue,
    });
    functionValue.calledTypeFunctionCaches = caches;

    return {
      value: returnValue,
      env,
    };
  }

  private evaluateFunctionCallReturnType({
    functionCallExpr,
    functionValue,
    functionType,
    argExprs,
    env,
    context,
  }: {
    functionCallExpr: Expr;
    functionValue?: FunctionValue;
    functionType: FunctionType;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { returnType: Type; env: Environment } {
    // This will push a new frame to the env and
    // add the parameters to the env
    const nextEnv = this.tryToCallFunctionWithArguments({
      functionValue,
      functionType,
      functionCallExpr,
      argExprs,
      env,
      context: { ...context },
    });
    if (!nextEnv) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Incompatible types for function call:
Expected: ${typeToString(functionType)}`
      );
    }
    env = nextEnv;

    // Evaluate the function return expr again
    // NOTE: We should use the env from the function, not the current env.
    const functionTypeEnv = pushEnvFrame(
      functionType.env,
      env.frames[env.frames.length - 1]
    ); // Add the env last frame which contains evaluated args
    const evaluatedFunctionReturnExpr = this.evaluateExpression({
      expr: functionType.return.expr,
      env: functionTypeEnv,
      context: { ...context, isEvaluatingExprAsType: true },
    });

    // Get the return type
    const functionReturnTypeValue = evaluatedFunctionReturnExpr.value;
    if (!isTypeValue(functionReturnTypeValue)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `(evaluateFunctionCallReturnType) Function body is not evaluated correctly. Expected to return a type.`
      );
    }
    const returnType = functionReturnTypeValue.value;

    // Restore the environment frames
    env = popEnvFrame(env);

    return {
      returnType: returnType,
      env,
    };
  }

  /**
   * def function_name : function_type, function body
   */
  private evaluateDefExpression({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Def, 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "def" with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    const functionDefinitionExpr = expr.args[0];
    const functionBodyExpr = expr.args[1];

    if (
      !exprIsFunctionCall(functionDefinitionExpr) ||
      !exprIsFunctionCallOf(functionDefinitionExpr, ":", 2)
    ) {
      throw this.formatErrorMessage(
        functionDefinitionExpr.token,
        `Expected ":" for defining the function parameters and return type, got:\n${exprToString(
          functionDefinitionExpr
        )}`
      );
    }

    let functionName: string;
    let functionNameExpr = functionDefinitionExpr.args[0];
    const functionTypeExpr = functionDefinitionExpr.args[1];
    let typeMethodInfo: { type: Type; methodName: string } | undefined =
      undefined;

    // Check if it's a type method, such as:
    //
    // def Point.add:
    //   (self: Point, other: Point)-> Point,
    //   ...
    if (
      exprIsFunctionCall(functionNameExpr) &&
      exprIsFunctionCallOf(functionNameExpr, ".", 2)
    ) {
      const typeExpr = functionNameExpr.args[0];
      const methodExpr = functionNameExpr.args[1];
      functionNameExpr = methodExpr;

      // Evaluate the typeExpr;
      const evaluatedTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: { ...context },
      });
      const evaluatedTypeValue = evaluatedTypeExpr.value;
      if (!isTypeValue(evaluatedTypeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type, got:\n${exprToString(typeExpr)}`
        );
      }
      const type = evaluatedTypeValue.value;

      // Get the method name
      if (
        !exprIsAtom(methodExpr) ||
        !(
          methodExpr.token.type === TokenType.Identifier ||
          methodExpr.token.type === TokenType.Operator
        )
      ) {
        throw this.formatErrorMessage(
          methodExpr.token,
          `Expected identifier or operator for type method name, got:\n${exprToString(
            methodExpr
          )}`
        );
      }
      const methodName = methodExpr.token.value;

      // Disallow to define type method for primitive and tuple types
      if (isPrimitiveType(type) || isTupleType(type)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Cannot define type method for primitive and tuple types`
        );
      }

      // Check if the method already exists
      const existingMethods = type.methods ?? [];
      if (existingMethods.find((m) => m.label === methodName)) {
        throw this.formatErrorMessage(
          methodExpr.token,
          `Duplicate label "${methodName}" in type method`
        );
      }
      if (isStructType(type)) {
        // Check if the method name conflicts with the struct members
        if (type.elements.find((m) => m.label === methodName)) {
          throw this.formatErrorMessage(
            methodExpr.token,
            `Duplicate label "${methodName}" in struct member`
          );
        }
      } else if (isTupleType(type)) {
        // Check if the method name conflicts with the tuple elements
        if (type.elements.find((m) => m.label === methodName)) {
          throw this.formatErrorMessage(
            methodExpr.token,
            `Duplicate label "${methodName}" in tuple elements`
          );
        }
      } else if (isEnumType(type)) {
        // Check if the method name conflicts with the enum variants
        if (type.variants.find((m) => m.name === methodName)) {
          throw this.formatErrorMessage(
            methodExpr.token,
            `Enum variant already has the name "${methodName}"`
          );
        }
      }

      /*
      // Add the method to the type
      type.methods = existingMethods.concat({
        label: methodName,
        type: functionType,
        value: functionValue,
      });
      */

      typeMethodInfo = {
        type,
        methodName,
      };
      functionName = methodName;
    }
    // It's not the type method, but the normal function
    else {
      // Get the function name
      if (
        !exprIsAtom(functionNameExpr) &&
        !this.isValidVariableName(functionNameExpr)
      ) {
        throw this.formatErrorMessage(
          functionNameExpr.token,
          `Expected identifier for function name, got:\n${exprToString(
            functionNameExpr
          )}`
        );
      }
      functionName = functionNameExpr.token.value;
    }

    // Evaluate the function type
    const evaluatedFunctionTypeExpr = this.evaluateExpression({
      expr: functionTypeExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    const evaluatedFunctionTypeValue = evaluatedFunctionTypeExpr.value;
    if (!isTypeValue(evaluatedFunctionTypeValue)) {
      throw this.formatErrorMessage(
        functionTypeExpr.token,
        `Expected function type, got:\n${exprToString(functionTypeExpr)}`
      );
    }
    const functionType = evaluatedFunctionTypeValue.value;
    if (!isFunctionType(functionType)) {
      throw this.formatErrorMessage(
        functionTypeExpr.token,
        `Expected function type, got:\n${exprToString(functionTypeExpr)}`
      );
    }
    if (evaluatedFunctionTypeExpr.env) {
      env = evaluatedFunctionTypeExpr.env;
    }

    // Add parameters to the env new frame
    env = pushEnvFrame(env);
    const functionParameters = functionType.params;
    for (let i = 0; i < functionParameters.length; i++) {
      const parameter = functionParameters[i];
      if (parameter.label && parameter.labelExpr) {
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: parameter.label,
            token: parameter.labelExpr.token,
            type: parameter.type,
            isMutable: parameter.isMutable,
            isCompileTimeOnly: parameter.isCompileTimeOnly,
            isNotInitialized: false, // Set as initialized
            value: parameter.isCompileTimeOnly
              ? createUnknownValue(parameter.type, parameter.label)
              : undefined,
          },
        });
        env = nextEnv;
      }
    }

    // Create the function value
    const functionValue: FunctionValue = {
      tag: ValueTag.Function,
      type: functionType,
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcName: functionName,
      funcId: `fn_${randomId()}`,
      calledTypeFunctionCaches: [],
      SelfType: context.SelfType, // In theory, this should be undefined
    };

    // It's a type method
    if (typeMethodInfo) {
      // Add the method to the type
      const existingMethods = typeMethodInfo.type.methods ?? [];
      const methodName = typeMethodInfo.methodName;
      typeMethodInfo.type.methods = existingMethods.concat({
        label: methodName,
        type: functionType,
        value: functionValue,
      });
    }
    // It's a normal method
    else {
      /// Add function with name to env;
      const { env: nextNextEnv } = addVariableToEnv({
        env,
        variable: {
          name: functionName,
          token: functionNameExpr.token,
          type: functionType,
          isMutable: false,
          isNotInitialized: false,
          value: functionValue,
        },
        deltaFrame: -1,
      });
      env = nextNextEnv;
    }

    // Attach some information
    functionNameExpr.type = functionType;
    functionNameExpr.value = functionValue;

    // Parse the function body
    const evaluatedFunctionBody = this.evaluateExpression({
      expr: functionBodyExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: false },
    });
    if (evaluatedFunctionBody.env) {
      env = evaluatedFunctionBody.env;
    }

    // Check if the function body type matches the function return type
    if (evaluatedFunctionBody.type) {
      if (
        !areTypesCompatible(
          functionType.return.type,
          evaluatedFunctionBody.type,
          env
        )
      ) {
        throw this.formatErrorMessage(
          functionType.return.expr.token,
          `Incompatible function return type:
- Expected: ${typeToString(functionType.return.type)}
- Given  : ${typeToString(evaluatedFunctionBody.type)}`
        );
      }
    } else {
      throw this.formatErrorMessage(
        functionBodyExpr.token,
        `Function body is not evaluated correctly`
      );
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Set the function type and value
    expr.type = functionType;
    expr.env = env;

    // "def" token
    expr.func.value = VUnit;
    expr.func.type = VUnit.type;
    expr.func.env = env;

    return expr;
  }

  private evaluateBeginExpression({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Begin)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "begin", got:\n${exprToString(expr)}`
      );
    }
    const exprs = expr.args;
    const expectedType = context.expectedType;

    // Empty begin
    // return unit
    if (exprs.length === 0) {
      expr.type = VUnit.type;
      expr.value = VUnit;
      return expr;
    }

    // Push a new environment frame
    env = pushEnvFrame(env);

    // Evaluate expressions
    for (let i = 0; i < exprs.length; i++) {
      const evaluatedExpr = this.evaluateExpression({
        expr: exprs[i],
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: false,
          expectedType: i === exprs.length - 1 ? expectedType : undefined,
        },
      });
      if (evaluatedExpr.env) {
        env = evaluatedExpr.env;
      }
    }
    const lastExpr = exprs[exprs.length - 1];
    expr.type = lastExpr.type;
    expr.value = lastExpr.value;

    // Pop the environment frame
    env = popEnvFrame(env);
    expr.env = env;
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
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Module)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "module", got:\n${exprToString(expr)}`
      );
    }

    const moduleMemberExprs = expr.args;
    // Evaluate the module members
    const moduleType = createModuleType([], env);

    // Increase the env frame
    env = pushEnvFrame(env);

    // Evaluate each module member
    for (let i = 0; i < moduleMemberExprs.length; i++) {
      let memberExpr = moduleMemberExprs[i];
      let defaultValueExpr: Expr | undefined = undefined;
      if (
        exprIsFunctionCall(memberExpr) &&
        exprIsFunctionCallOf(memberExpr, "=", 2)
      ) {
        defaultValueExpr = memberExpr.args[1];
        memberExpr = memberExpr.args[0];
      }

      if (
        !exprIsFunctionCall(memberExpr) ||
        !exprIsFunctionCallOf(memberExpr, ":", 2)
      ) {
        throw this.formatErrorMessage(
          memberExpr.token,
          `Expected ":", got:\n${exprToString(memberExpr)}`
        );
      }
      const labelExpr = memberExpr.args[0];
      const typeExpr = memberExpr.args[1];

      // Get the label of member
      if (
        !exprIsAtom(labelExpr) ||
        !(
          (
            labelExpr.token.type === TokenType.Identifier ||
            labelExpr.token.type === TokenType.Operator
          ) // We allow to define operator as module member
        )
      ) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Expected identifier for module member name, got:\n${exprToString(
            labelExpr
          )}`
        );
      }
      const label = labelExpr.token.value;

      if (label === "Self") {
        // Self is a reserved keyword
        throw this.formatErrorMessage(
          labelExpr.token,
          `Cannot use "Self" as interface member name.
If you want to define the receiver type, please use "This" instead.`
        );
      }

      // Evaluate the member type
      const evaluatedMemberTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
          SelfType: moduleType,
        },
      });
      if (evaluatedMemberTypeExpr.env) {
        env = evaluatedMemberTypeExpr.env;
      }

      // Expect the member type to be a type
      const typeValue = evaluatedMemberTypeExpr.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for module member, got:\n${exprToString(typeExpr)}`
        );
      }

      const memberType = typeValue.value;
      /*
      NOTE: This is no longer true.
      // We only accept hierarchy type or function type.
      if (!isTypeHierarchyType(memberType) && !isFunctionType(memberType)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected either Type (Free, Linear) or FunctionType for module member, got:\n${exprToString(
            typeExpr
          )}`
        );
      }
      */

      // Check if the label already exists
      const members = moduleType.members;
      if (members.find((m) => m.label === label)) {
        throw this.formatErrorMessage(
          labelExpr.token,
          `Duplicate label "${label}" in module member`
        );
      }

      // Add the label to the env
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: label,
          token: labelExpr.token,
          type: memberType,
          isMutable: false,
          isNotInitialized: false,
          isCompileTimeOnly: true,
          value: createUnknownValue(memberType, label),
        },
      });
      env = nextEnv;

      // Add type info the labelExpr;
      labelExpr.type = memberType;

      // Evaluate the default value expr if it exists
      if (defaultValueExpr) {
        const evaluatedDefaultValueExpr = this.evaluateExpression({
          expr: defaultValueExpr,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
            expectedType: memberType,
            SelfType: moduleType,
          },
        });
        if (evaluatedDefaultValueExpr.env) {
          env = evaluatedDefaultValueExpr.env;
        }
        const defaultValue = evaluatedDefaultValueExpr.value;
        if (
          !defaultValue ||
          !(isTypeValue(defaultValue) || isFunctionValue(defaultValue))
        ) {
          throw this.formatErrorMessage(
            defaultValueExpr.token,
            `Expected value for module member, got:\n${exprToString(
              defaultValueExpr
            )}`
          );
        }

        // Set the default value
        moduleType.members.push({
          label,
          type: memberType,
          defaultValue,
          typeExpr: evaluatedMemberTypeExpr,
        });
      } else {
        // Add the member to the moduleType
        moduleType.members.push({
          label,
          type: memberType,
          defaultValue: undefined,
          typeExpr: evaluatedMemberTypeExpr,
        });
      }
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Set the module type and value
    expr.type = typeOfType(moduleType);
    expr.value = createTypeValue(moduleType);
    expr.env = env;

    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

    return expr;
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
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.TypeOf, 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "typeof" with 1 argument, got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the expression
    const evaluatedExpr = this.evaluateExpression({
      expr: expr.args[0],
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: true,
      },
    });
    if (evaluatedExpr.env) {
      env = evaluatedExpr.env;
    }

    // Check if the expression has a type
    if (!evaluatedExpr.type) {
      throw this.formatErrorMessage(
        expr.args[0].token,
        `Expected type for expression, got:\n${exprToString(expr.args[0])}`
      );
    }
    const type = evaluatedExpr.type;

    expr.value = createTypeValue(type);
    expr.type = expr.value.type;
    expr.env = env;
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
        case TokenType.Identifier: {
          return this.evaluateIdentifier({
            expr,
            env,
            context: { ...context },
          });
        }
        case TokenType.Integer: {
          return this.evaluateIntegerLiteral(expr);
        }
        case TokenType.Boolean: {
          return this.evaluateBooleanLiteral(expr);
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
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.Fn)
        ) {
          return this.evaluateAnonymousFunctionImplementation({
            expr,
            env,
            context: { ...context, isEvaluatingExprAsType: false },
          });
        }

        // Function type
        return this.evaluateFunctionType({
          expr,
          env,
          context: { ...context, isEvaluatingExprAsType: true },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Recur)) {
        // recur
        return this.evaluateRecur({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Extern)) {
        // extern
        return this.evaluateExtern({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Cond)) {
        // cond
        return this.evaluateCond({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Match)) {
        // match
        return this.evaluateMatch({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
        // tuple
        return this.evaluateTuple({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Type)) {
        // type Expr
        return this.evaluateTypeExpression({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Struct)) {
        // struct
        return this.evaluateStruct({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Enum)) {
        // enum
        return this.evaluateEnum({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, ".")) {
        // forall
        if (
          // forall(compt(T): Type) . ((x: T) -> T)
          exprIsFunctionCall(expr.args[0]) &&
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.Forall)
        ) {
          return this.evaluateForall({
            expr,
            env,
            context: { ...context },
          });
        }

        // property access
        return this.evaluatePropertyAccess({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Def)) {
        // def
        return this.evaluateDefExpression({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Begin)) {
        // begin
        return this.evaluateBeginExpression({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Module)) {
        // module
        return this.evaluateModule({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.TypeOf)) {
        // typeof
        return this.evaluateTypeOf({ expr, env, context: { ...context } });
      } else {
        /* 
      else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Exists)) {
        // exists
        return this.evaluateExists({ expr, env, context: { ...context } });
      }
      */
        /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      } */
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
    for (let i = 0; i < this.program.length; i++) {
      const expr = this.program[i];
      const nextExpr = this.evaluateExpression({
        expr,
        env,
        context: {
          isEvaluatingExprAsType: false,
        },
      });
      env = nextExpr.env || env;
    }
  }
}
