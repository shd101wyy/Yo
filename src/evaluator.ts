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
  keepComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
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
  exprToString,
  FuncCallExpr,
  PathCollection,
  setExprAsConsumed,
} from "./expr";
import { FunctionValue } from "./function-value";
import * as logger from "./logger";
import Parser from "./parser";
import { PlaceholderToken, stringIsOperator, Token, TokenType } from "./token";
import {
  areTypesCompatible,
  createArrayType,
  createEnumType,
  createFunctionType,
  createLinearPtrType,
  createModuleType,
  createMutLinearPtrType,
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  createStructType,
  createTupleType,
  EnumType,
  EnumVariant,
  FunctionParameter,
  FunctionType,
  getFunctionParameterExprs,
  getFunctionParameterToken,
  getValueOfSomeTypeFromEnv,
  isBooleanType,
  isEnumType,
  isFunctionType,
  isFunctionTypeAndIsTypeFunction,
  isLinearOrType0Type,
  isLinearPtrType,
  isModuleType,
  isMutLinearPtrType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isUnionType,
  ModuleMember,
  ModuleType,
  StructType,
  TBoolean,
  TComptFloat,
  TComptInt,
  TComptString,
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
  typeContainsReference,
  typeOfType,
  typeRequiresComptModifier,
  TypeTag,
  typeToString,
} from "./type-checker";
import { TypeValue } from "./type-value";
import { VUnit } from "./unit-value";
import { generateNewTempVariableName, randomId } from "./utils";
import {
  areValuesEqual,
  createBooleanValue,
  createComptFloatValue,
  createComptIntValue,
  createComptStringValue,
  createEnumValue,
  createModuleValue,
  createStructValue,
  createTypeValue,
  createUnknownValue,
  isComptFloatValue,
  isComptIntValue,
  isComptStringValue,
  isFunctionValue,
  isModuleValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  StructValue,
  TupleValue,
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
  isEvaluatingFunctionBodyOfType?: FunctionType;

  /**
   * The innermost interface, struct, enum, or union that this function call is inside.
   * This can be useful for an anonymous struct that needs to refer to itself
   */
  SelfType?: Type;

  /**
   * The borrowings.
   */
  borrowings: Borrowing[];
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
  private moduleValue: ModuleValue;
  private loadModule: (modulePath: string) => ModuleValue;

  constructor({
    modulePath,
    loadModule,
  }: {
    modulePath: string;
    loadModule: (modulePath: string) => ModuleValue;
  }) {
    this.modulePath = modulePath;
    this.loadModule = loadModule;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }

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

  private evaluateIntegerLiteral(expr: AtomExpr, env: Environment): AtomExpr {
    if (expr.token.type === TokenType.Integer) {
      const integerValue = parseInt(expr.token.value, 10);
      const value = createComptIntValue(integerValue);
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
      const value = createComptFloatValue(floatValue);
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
      if (tupleElement.defaultValue) {
        throw this.formatErrorMessage(
          tupleElement.expr.token,
          `Tuple elements cannot have default value.`
        );
      }

      if (tupleElement.label) {
        throw this.formatErrorMessage(
          tupleElement.expr.token,
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
    let label: string | undefined = undefined;
    let expr_ = expr;
    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    // Check the default value
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
      expr_ = expr.args[0]!;
      const defaultValueExpr = expr.args[1]!;

      // Evaluate the defaultValueExpr
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
      defaultValue = evaluatedDefaultValue.$?.value;
      if (!defaultValue) {
        throw this.formatErrorMessage(
          defaultValueExpr.token,
          `Expect compile-time known value as default value.`
        );
      }
    }

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      rhsExpr = expr_.args[1]!;
      lhsExpr = expr_.args[0]!;

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
    const expectedType = context.expectedType?.type;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedType) {
      if (isTupleType(expectedType)) {
        const tupleElement = expectedType.elements[tupleElementIndex];
        if (!tupleElement) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to get the tuple element at index ${tupleElementIndex}`
          );
        }

        expectedTupleElementType = tupleElement.type;
      } else if (isStructType(expectedType)) {
        const structMember = expectedType.elements[tupleElementIndex];
        if (!structMember) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to get the struct member at index ${tupleElementIndex}`
          );
        }

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
        expectedType: expectedTupleElementType
          ? {
              type: expectedTupleElementType,
              env,
            }
          : undefined,
      },
    });
    if (evaluatedRhs.$?.env) {
      env = evaluatedRhs.$?.env;
    }

    // Expected the evaluatedRhs to be a type
    const typeValue = evaluatedRhs.$?.value;
    if (!isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `(1) Expected type for tuple element, got ${exprToString(rhsExpr)}`
      );
    }
    elementType = typeValue.value;
    if (lhsExpr) {
      lhsExpr.$ = {
        env,
        type: elementType,
        isMutable: false,
        pathCollection: [],
      };
    }

    // Check if defaultValue matches the type
    if (
      defaultValue &&
      !areTypesCompatible(
        { type: elementType, env },
        { type: defaultValue.type, env }
      )
    ) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Default value type mismatch:
Expected type: ${typeToString(elementType)}
Given type: ${typeToString(defaultValue.type)}`
      );
    }

    if (lhsExpr) {
      lhsExpr.$ = {
        env,
        value: typeValue,
        type: typeValue.type,
        isMutable: false,
        pathCollection: [],
      };
    }
    expr.$ = {
      env,
      value: typeValue,
      type: typeValue.type,
      isMutable: false,
      pathCollection: [],
    };
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
    let label: string | undefined = undefined;
    const expr_ = expr;
    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;

    // Parse the lhs expr
    if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
      rhsExpr = expr_.args[1]!;
      lhsExpr = expr_.args[0]!;

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
    if (evaluatedRhs.$?.env) {
      env = evaluatedRhs.$?.env;
    }

    const value = evaluatedRhs.$?.value;
    if (value && isTypeValue(evaluatedRhs.$?.value)) {
      throw this.formatErrorMessage(
        rhsExpr.token,
        `Cannot store a type value in tuple while not in "type" context: 
  ${exprToString(rhsExpr)}`
      );
    }

    // Expected the evaluatedRhs to be a value
    elementType = evaluatedRhs.$?.type;
    if (!elementType) {
      throw this.formatErrorMessage(
        evaluatedRhs.token,
        `Failed to evaluate the tuple element.`
      );
    }

    if (lhsExpr) {
      lhsExpr.$ = {
        env,
        type: elementType,
        value: value,
        isMutable: evaluatedRhs.$?.isMutable ?? false,
        pathCollection: [],
      };
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
        label,
        type: elementType,
        expr,
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
      tupleValues.push(value);
      env = nextEnv;
    }

    const tupleType: TupleType = createTupleType(tupleElements);
    const value: Value | undefined = tupleValues.some((v) => !v)
      ? // ^ Meaning some element value is not compile-time known.
        undefined
      : {
          tag: ValueTag.Tuple,
          type: tupleType,
          elements: tupleValues as Value[],
        };

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
  }: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): {
    type: TupleType;
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
      } = this.evaluateTupleElementType({
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
              ? (arg.args[0]?.token ?? arg.token)
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
    ) {
      for (const member of expected.type.members) {
        const givenMember = given.type.members.find(
          (m) => m.label === member.label
        );
        if (!givenMember) {
          break;
        }
        const { expectedEnv, givenEnv } = this.synthesizeTypes(
          { type: member.type, env: expected.env },
          { type: givenMember.type, env: given.env }
        );
        expected.env = expectedEnv;
        given.env = givenEnv;

        if (
          isTypeValue(member.requiredValue) &&
          isTypeValue(givenMember.requiredValue)
        ) {
          const { expectedEnv, givenEnv } = this.synthesizeTypes(
            { type: member.requiredValue.value, env: expected.env },
            { type: givenMember.requiredValue.value, env: given.env }
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
    const rhsType = rhs.$?.type;
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
        rhsValue: rhs.$?.value,
        rhsType,
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
        rhsValue: rhs.$?.value,
        rhsType,
        lhs,
        env,
        context: { ...context },
        isCompileTimeOnly,
      });
    }
    // Handle module destructuring
    else if (isModuleType(rhsType) && exprIsFunctionCall(lhs)) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsElements: rhsType.members,
        rhsValue: rhs.$?.value,
        rhsType,
        lhs,
        env,
        context: { ...context },
        isCompileTimeOnly,
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
    isCompileTimeOnly,
  }: {
    lhsFunc: Expr;
    lhsElements: Expr[];
    rhsElements: { label?: string; type: Type }[];
    rhsValue: Value | undefined;
    rhsType: Type;
    lhs: Expr;
    env: Environment;
    context: EvaluatorContext;
    isCompileTimeOnly: boolean;
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
        } destructuring, got "${lhsFuncName}"`
      );
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
        // If it's a single _, we destructure all elements
        if (lhsElements.length === 1) {
          // We can destructure all elements
          for (let j = 0; j < rhsElements.length; j++) {
            const member = rhsElements[j]!;
            if (!member.label) {
              continue;
            }
            const memberValue =
              isTupleValue(rhsValue) || isStructValue(rhsValue)
                ? rhsValue.elements[j]
                : isModuleValue(rhsValue)
                  ? rhsValue.members[member.label!]
                  : undefined;

            // Add to environment
            const { env: nextEnv } = addVariableToEnv({
              env,
              variable: {
                name: member.label,
                value: memberValue,
                type: member.type,
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
      // This only works with the module destructuring
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
          const member = rhsElements[j]!;
          if (!member.label) {
            continue;
          }

          const memberType = rhsType.members.find(
            (m) => m.label === member.label
          )!;
          if (!memberType.isImplicit) {
            continue;
          }

          const memberValue = rhsValue.members[member.label!];

          // Add to environment
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: member.label,
              value: memberValue,
              type: member.type,
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

      // Handle labeled nested destructuring pattern like:
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
            `Label "${label}" not found in the ${
              isModule ? "module" : isStruct ? "struct" : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
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
          nestedValue = rhsValue.members[label];
        }
        elementValue = nestedValue;

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
          throw this.formatErrorMessage(
            lhsElement.token,
            "Expected label for module destructuring"
          );
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

        destructuredRhsElementSet.add(rhsElement);

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
              ? BuiltinKeywords.struct
              : isModule
                ? BuiltinKeywords.module
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
    if (evaluatedRhs.$?.env) {
      env = evaluatedRhs.$?.env;
    }

    const typeValue = evaluatedRhs.$?.value;
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

    // If rhs is type value, then it cannot be mutable
    if (isTypeValue(rhs.$?.value) && isMutable) {
      throw this.formatErrorMessage(
        lhs.token,
        `Unexpected "mut" (or "!") for type value:
${exprToString(rhs)}`
      );
    }
    // Check some value that requires compile-time only
    if (!isCompileTimeOnly) {
      // If rhs is type value, then it must be compile-time only
      if (isTypeValue(rhs.$?.value)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for type value assignment:
${exprToString(expr)}`
        );
      }
      // If rhs is module value, then it must be compile-time only
      else if (isModuleValue(rhs.$?.value)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for module value assignment:
${exprToString(expr)}`
        );
      }
      // If rhs is compt_int value, then it must be compile-time only
      else if (isComptIntValue(rhs.$?.value)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for compt_int value assignment:
${exprToString(expr)}

To assign it to a specific runtime integer type, please use:
(${lhs.token.value}: i32) = ${exprToString(rhs)}`
        );
      }
      // If rhs is compt_float value, then it must be compile-time only
      else if (isComptFloatValue(rhs.$?.value)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for compt_float value assignment:
${exprToString(expr)}

To assign it to a specific runtime integer type, please use:
(${lhs.token.value}: f64) = ${exprToString(rhs)}
`
        );
      }
      // If rhs is compt_string value, then it must be compile-time only
      else if (isComptStringValue(rhs.$?.value)) {
        throw this.formatErrorMessage(
          expr.token,
          `Expected "::" instead of ":=" for compt_string value assignment:
${exprToString(expr)}`
        );
      }
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
            `(2) Expected type for right-hand side, got ${exprToString(rhs)}`
          );
        }
        // user didn't specify the type
        lhs.$ = {
          env,
          type: rhsType,
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
      const rhsValue = rhs.$?.value;
      if (
        isTypeValue(rhsValue) &&
        (isStructType(rhsValue.value) ||
          isEnumType(rhsValue.value) ||
          isModuleType(rhsValue.value)) &&
        !rhsValue.value.typeName
      ) {
        rhsValue.value.typeName = lhs.token.value;
      } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
        rhsValue.funcName = lhs.token.value;
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
        type: lhs.$?.type,
        value: isCompileTimeOnly ? rhsValue : undefined,
        isMutable,
        pathCollection: [],
      };
      // Add variable to env
      // Attach the updated env to expr
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: lhs.token.value,
          token: lhs.token,
          type: lhs.$?.type,
          isMutable,
          isCompileTimeOnly,
          isUndefined: false,
          isImplicit,
          value: lhs.$?.value,
        },
      });
      env = nextEnv;

      // Set the rhs as consumed
      env = setExprAsConsumed(rhs, env);

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

      // Set the rhs as consumed
      env = setExprAsConsumed(rhs, env);

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

      if (variable.isUndefined) {
        env = updateExistingVariable(env, variable, {
          ...variable,
          isUndefined: false,
          value: rhs.$?.value,
          // type: rhsType,
        });
      } else if (variable.isMutable) {
        // Update the variable value
        env = updateExistingVariable(env, variable, {
          ...variable,
          value: rhs.$?.value,
          // type: rhsType,
        });
      } else {
        throw this.formatErrorMessage(
          lhs.token,
          `Cannot assign to immutable variable "${variableName}"`
        );
      }

      lhs.$ = {
        env,
        type: variable.type, // NOTE: It shouldn't be the rhsType.
        value: variable.isCompileTimeOnly ? rhs.$?.value : undefined,
        isMutable: variable.isMutable,
        pathCollection: [[variableName]],
      };
      // Check the borrowings
      checkBorrowings(context.borrowings, lhs);

      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: false,
        pathCollection: [],
      };

      return expr;
    } else {
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
        // FIXME: This should return the original value of lhs
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

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i]!;
      if (!exprIsFunctionCall(arg) || !exprIsFunctionCallOf(arg, ":", 2)) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected ":" for extern argument, got ${arg.tag}`
        );
      }
      let lhs = arg.args[0]!;
      const rhs = arg.args[1]!;

      // Check if lhs is implicit
      let isImplicit = false;
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit, 1)
      ) {
        lhs = lhs.args[0]!;
        isImplicit = true;
      }

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
          },
        });
        if (evaluatedRhs.$?.env) {
          env = evaluatedRhs.$?.env;
        }
        if (!isTypeValue(evaluatedRhs.$?.value)) {
          throw this.formatErrorMessage(
            rhs.token,
            `Expected type for extern argument, got ${exprToString(rhs)}`
          );
        } else {
          const typeValue = evaluatedRhs.$?.value;
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
              isUndefined: false,
              isImplicit,
              value: createUnknownValue(userDefinedType),
            },
          });
          env = nextEnv;

          // Attach the user defined type to the lhs
          lhs.$ = {
            env,
            type: userDefinedType,
            isMutable: false,
            pathCollection: [],
          };
        }
      }
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
    // condition -> value.
    // expect each value to be the same type.
    let valueType: Type | undefined = undefined;
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i]!;
      if (
        !exprIsFunctionCall(statement) ||
        !exprIsFunctionCallOf(statement, "->", 2)
      ) {
        throw this.formatErrorMessage(
          statement.token,
          `Expected -> for cond statement, got ${statement.tag}`
        );
      }
      const condExpr = statement.args[0]!;
      const valueExpr = statement.args[1]!;

      // Expect condExpr to be a boolean
      const evaluatedCond = this.evaluateExpression({
        expr: condExpr,
        env,
        context: {
          ...context,
        },
      });

      // TODO: Check comptime value if exists
      if (evaluatedCond.$?.env) {
        env = evaluatedCond.$?.env;
      }
      if (!evaluatedCond.$?.type || !isBooleanType(evaluatedCond.$?.type)) {
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
        },
      });

      // QUESTION: Should we update the env here?
      // if (evaluatedValue.env) {
      //   env = evaluatedValue.env;
      //}
      if (!evaluatedValue.$?.type) {
        throw this.formatErrorMessage(
          valueExpr.token,
          `Expected type for cond statement, got ${exprToString(valueExpr)}`
        );
      }
      if (!valueType) {
        valueType = evaluatedValue.$?.type;
      } else {
        // Check if the type is compatible
        if (
          !areTypesCompatible(
            { type: valueType, env },
            { type: evaluatedValue.$.type, env }
          )
        ) {
          throw this.formatErrorMessage(
            valueExpr.token,
            `Incompatible types:
- Previous: ${typeToString(valueType)}
- Current : ${typeToString(evaluatedValue.$?.type)}`
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

    expr.$ = {
      env,
      type: valueType,
      // TODO: set .value to support compile-time value.
      // Right now the createUnknownValue below is wrong
      value: undefined, // valueType ? createUnknownValue(valueType) : undefined;
      isMutable: false,
      pathCollection: [],
    };

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
    const evaluatedValue = this.evaluateExpression({
      expr: valueExpr,
      env,
      context: {
        ...context,
      },
    });

    if (evaluatedValue.$?.env) {
      env = evaluatedValue.$?.env;
    }

    // Check if the value is an enum type
    if (!evaluatedValue.$?.type || !isEnumType(evaluatedValue.$?.type)) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Expected enum type for match expression, got ${
          evaluatedValue.$?.type
            ? typeToString(evaluatedValue.$?.type)
            : "unknown type"
        }`
      );
    }

    const enumType = evaluatedValue.$?.type;
    const patterns = args.slice(1);
    let resultType: Type | undefined = undefined;

    // Process each pattern
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i]!;

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

      const patternExpr = pattern.args[0]!;
      const resultExpr = pattern.args[1]!;

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

        // Evaluate the result expression
        const tempEnv = pushEnvFrame(env);
        const evaluatedResult = this.evaluateExpression({
          expr: resultExpr,
          env: tempEnv,
          context: {
            ...context,
          },
        });
        // We don't update the original env here since each pattern has its own scope

        if (!evaluatedResult.$?.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.$?.type;
        } else if (
          !areTypesCompatible(
            { type: resultType, env },
            { type: evaluatedResult.$?.type, env }
          )
        ) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current : ${typeToString(evaluatedResult.$?.type)}`
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
          const patternElement = patternElements[j]!;
          const variantElement = variant.elements[j]!;

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
          patternElement.$ = {
            env,
            type: variantElement.type,
            isMutable: false,
            pathCollection: [],
          };

          const { env: updatedEnv } = addVariableToEnv({
            env: patternEnv,
            variable: {
              name: patternElement.token.value,
              token: patternElement.token,
              type: variantElement.type,
              isMutable: false,
              isUndefined: false,
              isImplicit: false,
              isCompileTimeOnly: false,
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
          },
        });

        if (!evaluatedResult.$?.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.$?.type;
        } else if (
          !areTypesCompatible(
            { type: resultType, env },
            { type: evaluatedResult.$?.type, env }
          )
        ) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current: ${typeToString(evaluatedResult.$?.type)}`
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
    expr.$ = {
      env,
      type: resultType,
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
  }: {
    expr: AtomExpr;
    env: Environment;
    context: EvaluatorContext;
  }): AtomExpr {
    const identifier = expr.token.value;
    // Free
    if (identifier === TypeTag.Free) {
      const value = createTypeValue(TFree);
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
      const value = createTypeValue(TLinear);
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
      const value = createTypeValue(TType);
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
      const value = createTypeValue(TUnit);
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
      const value = createTypeValue(TComptInt);
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
      const value = createTypeValue(TComptFloat);
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
      const value = createTypeValue(TComptString);
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
      const value = createTypeValue(TBoolean);
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
      const value = createTypeValue(TUsize);
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
      const value = createTypeValue(TIsize);
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
      const value = createTypeValue(TU8);
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
      const value = createTypeValue(TI8);
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
      const value = createTypeValue(TU16);
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
      const value = createTypeValue(TI16);
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
      const value = createTypeValue(TU32);
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
      const value = createTypeValue(TI32);
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
      const value = createTypeValue(TU64);
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
      const value = createTypeValue(TI64);
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
      const value = createTypeValue(TF32);
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
      const value = createTypeValue(TF64);
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
      // NOTE: If `Self` is used inside struct/enum/union
      // then it means the type itself.
      (isStructType(context.SelfType) ||
        isEnumType(context.SelfType) ||
        isUnionType(context.SelfType))
    ) {
      const value = createTypeValue(context.SelfType);
      expr.$ = {
        env,
        type: value.type,
        value: value,
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
        if (variable.isUndefined) {
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
        isEvaluatingFunctionBodyOfType: functionType,
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
        calledTypeFunctionCaches: [],
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
      context.isEvaluatingFunctionBodyOfType;
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
    let rhsExpr: Expr | undefined = undefined;

    let parameterType: Type | undefined = undefined;
    let defaultValue: Value | undefined = undefined;

    let expr_: Expr = expr;
    let typeExpr: Expr | undefined = undefined;
    let labelExpr: Expr | undefined = undefined;
    let defaultValueExpr: Expr | undefined = undefined;

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
        if (evaluatedRhs.$?.env) {
          env = evaluatedRhs.$?.env;
        }

        // Expected the evaluatedRhs to be a type
        const typeValue = evaluatedRhs.$?.value;
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
        throw this.formatErrorMessage(
          lhsExpr?.token ?? expr.token,
          `Expected a "compt" (or "@") for parameter to be compile-time only.`
        );
      }
    }

    if (!label) {
      label = generateNewTempVariableName(this.modulePath);
    }

    const value = isCompileTimeOnly
      ? createUnknownValue(parameterType, label)
      : undefined;

    // Add the parameter to the env
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

    if (lhsExpr !== expr) {
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
    const returnType = evaluatedReturnType.$?.value.value;
    if (typeRequiresComptModifier(returnType) && !isReturnTypeCompileTimeOnly) {
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

  private evaluateStruct({
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

    const { type: tupleType, env: nextEnv } = this.evaluateTupleElementsType({
      args: expr.args,
      env,
      context: { ...context },
    });
    env = nextEnv;

    const structType: StructType = createStructType(tupleType.elements);
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

  private evaluateEnum({
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

    // Evaluate the variants
    const variants: EnumVariant[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const enumArg = expr.args[i]!;

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

        const { type: tupleType, env: nextEnv } =
          this.evaluateTupleElementsType({
            args: enumArg.args,
            env,
            context: {
              ...context,
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
        return expr;
      } else if (
        isLinearPtrType(objectExpr.$?.type) ||
        isMutLinearPtrType(objectExpr.$?.type)
      ) {
        const linearPtrType = objectExpr.$.type;
        const baseType = linearPtrType.type;
        expr.$ = {
          env,
          type: baseType,
          value: undefined,
          isMutable: isMutLinearPtrType(linearPtrType),
          isAccessingProperty: true,
          pathCollection: [],
        };
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
        return expr;
      }
    }

    if (isTypeValue(objectExpr.$?.value)) {
      const typeValue = objectExpr.$?.value;
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
    }

    if (isTupleType(objectExpr.$?.type) || isStructType(objectExpr.$?.type)) {
      let elements: TupleElement[] = [];
      const objectExprValue = objectExpr.$?.value;
      if (isTupleType(objectExpr.$?.type)) {
        elements = objectExpr.$?.type.elements;
      } else if (isStructType(objectExpr.$?.type)) {
        elements = objectExpr.$?.type.elements;
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
            let values: Value[] | undefined = [];
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
          /*
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
          } else 
          */
          {
            const tupleElementIndex = elements.findIndex(
              (element) => element.label === label
            );
            if (tupleElementIndex < 0) {
              // It could be interface method call
              expr.$ = undefined;
              return expr;
            }
            const tupleElement = elements[tupleElementIndex]!;
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
              let values: Value[] | undefined = [];
              if (isTupleValue(objectExprValue)) {
                values = objectExprValue.elements;
              } else if (isStructValue(objectExprValue)) {
                values = objectExprValue.elements;
              }
              expr.$.value = values?.[tupleElementIndex];
            }
            return expr;
          }
        }
      }
    } else if (isModuleType(objectExpr.$?.type)) {
      // Check if it's accessing the module member by
      // - label name:   my_module.add
      if (exprIsAtom(propertyExpr)) {
        const label = propertyExpr.token.value;
        // Check if the type method exists
        const moduleValue = objectExpr.$?.value;
        const moduleType = objectExpr.$?.type;
        const moduleMember = (moduleType.members ?? []).find(
          (member) => member.label === label
        );
        if (moduleMember) {
          expr.$ = {
            env,
            type: moduleMember.type,
            value: isModuleValue(moduleValue)
              ? moduleValue.members[label]
              : createUnknownValue(moduleMember.type, moduleMember.label),
            isMutable: objectExpr.$.isMutable,
            isAccessingProperty: true,
            pathCollection: [],
          };
          propertyExpr.$ = expr.$;
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
    expr.$ = undefined;
    return expr;
  }

  private createAnonymousStruct({
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

        if (!exprIsAtom(labelExpr) || !this.isValidVariableName(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for anonymous struct element label, got:\n${exprToString(
              labelExpr
            )}`
          );
        }
        label = labelExpr.token.value;
      }

      const evaluatedArg = this.evaluateExpression({
        expr: valueExpr,
        env,
        context: {
          ...context,
        },
      });
      if (evaluatedArg.$?.env) {
        env = evaluatedArg.$?.env;
      }
      const type = evaluatedArg.$?.type;
      if (!type) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected type for anonymous struct element, got:\n${exprToString(
            arg
          )}`
        );
      }

      const element: TupleElement = {
        expr: arg,
        type,
        label,
      };
      elements.push(element);

      if (evaluatedArg.$?.value) {
        values.push(evaluatedArg.$?.value);
      }
    }

    // Create structType
    const structType = createStructType(elements);

    // Check if it's comptime value
    let structValue: StructValue | undefined = undefined;
    if (values.every((value) => !!value)) {
      structValue = createStructValue(structType, values);
    }

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
    givenFunc?: { type: Type; value: TypeValue };
    context: EvaluatorContext;
  }): FuncCallExpr {
    const func = expr.func;
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
    } else if (exprIsFunctionCall(func)) {
      const functionToCall = this.evaluateExpression({
        expr: func,
        env,
        context: {
          ...context,
        },
      });
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
            type: functionToCall.$?.type,
            value: functionToCall.$?.value,
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
          return this.createAnonymousStruct({
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
            callerEnv: env,
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
              callerEnv: env,
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
            functionToCall.error = this.formatErrorMessage(
              expr.token,
              `Enum variant not selected for enum type`
            );
          } else {
            try {
              this.tryToCallTypeWithArguments({
                memberElements: selectedVariant.elements || [],
                functionCallExpr: func,
                argExprs: args,
                callerEnv: env,
                context: { ...context },
              });
            } catch (error) {
              functionToCall.error = error;
            }
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
          } catch (error) {
            functionToCall.error = error;
          }
        }
        // module
        else if (isTypeValue(value) && isModuleType(value.value)) {
          const moduleType = value.value;
          try {
            this.tryToImplementModuleWithArguments({
              moduleExpr: func,
              moduleType: moduleType,
              argExprs: args,
              callerEnv: env,
              context: { ...context },
            });
          } catch (error) {
            functionToCall.error = error;
          }
        } else {
          functionToCall.error = this.formatErrorMessage(
            func.token,
            `Invalid function call on type:
${typeToString(functionToCall.type)}`
          );
        }
        return functionToCall;
      }
    });

    const functionsWithMatchingTypes = functionsToCall.filter(
      (functionToCall) => !functionToCall.error
    );

    if (functionsWithMatchingTypes.length === 0) {
      if (functionsToCall.length === 1) {
        throw functionsToCall[0]!.error!; // NOTE: It should have error here.
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

    const functionToCall = functionsWithMatchingTypes[0]!; // Found the only one function to call
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
        const { value: returnValue, callerEnv: nextEnv } =
          this.evaluateTypeFunctionCall({
            functionCallExpr: expr,
            functionType,
            functionValue,
            argExprs: args,
            callerEnv: env,
            context: {
              ...context,
            },
          });

        env = popEnvFrame(nextEnv);
        expr.$ = {
          env,
          type: returnValue.type,
          value: returnValue,
          isMutable: false,
          pathCollection: [],
        };

        // Attach necessary info to the func
        func.$ = {
          env,
          type: functionToCall.type,
          value: functionToCall.value,
          isMutable: false,
          pathCollection: [],
        };
      } else {
        // It's
        // - Runtime function
        // - Comptime function
        const { returnType, callerEnv, pathCollection } =
          this.tryToCallFunctionWithArguments({
            functionCallExpr: expr,
            functionValue: functionToCall.value as FunctionValue | undefined,
            functionType,
            argExprs: args,
            callerEnv: env,
            context: {
              ...context,
              SelfType: functionType.SelfType,
            },
          });
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
        // FIXME: Support to set value for comptime
        const { values: memberValues, pathCollection } =
          this.tryToCallTypeWithArguments({
            memberElements: value.value.elements,
            functionCallExpr: func,
            argExprs: args,
            callerEnv: env,
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
          expr.$.value = structValue;
        }
        expr.$.pathCollection = pathCollection;

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
        const { values: memberValues, pathCollection } =
          this.tryToCallTypeWithArguments({
            memberElements: selectedVariant.elements || [],
            functionCallExpr: func,
            argExprs: args,
            callerEnv: env,
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
          expr.$.value = enumValue;
        }
        expr.$.pathCollection = pathCollection;

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
        if (!expr.$ || !expr.$.value) {
          throw this.formatErrorMessage(
            func.token,
            `Expected function value for function call, got:\n${exprToString(
              expr
            )}`
          );
        }
        return expr;
      }
      // module
      else if (isTypeValue(value) && isModuleType(value.value)) {
        const moduleValue = this.tryToImplementModuleWithArguments({
          moduleExpr: func,
          moduleType: value.value,
          argExprs: args,
          callerEnv: env,
          context: {
            ...context,
          },
        });

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
    if (!evaluatedArgExpr) {
      throw this.formatErrorMessage(
        argExpr?.token ?? PlaceholderToken,
        `Failed to evaluate argument expression.`
      );
    }

    // Check the borrowings
    if (
      evaluatedArgExpr.$?.type &&
      (isMutRefType(evaluatedArgExpr.$?.type) ||
        isRefType(evaluatedArgExpr.$?.type))
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

    const argType = evaluatedArgExpr.$?.type;
    if (!argType) {
      throw this.formatErrorMessage(
        argExpr?.token ?? PlaceholderToken,
        `Failed to evaluate argument expression.`
      );
      // If synthesis fails, the types are not compatible
    }

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
    const argValue = evaluatedArgExpr.$?.value;
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
    callerEnv = setExprAsConsumed(evaluatedArgExpr, callerEnv);

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
    return { calleeEnv, callerEnv, context: { ...context, borrowings } };
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
  }): {
    calleeEnv: Environment;
    callerEnv: Environment;
    pathCollection: PathCollection;
    returnType: Type;
  } {
    const initialBorrowings = [...context.borrowings];

    let forallArgsExpr: FuncCallExpr | undefined = undefined;
    let implicitArgExprs: Expr[] = [];

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

    /* NOTE: We now support default values
    // ~~NOTE: We don't support default values for function parameters~~
    // So we need to check if the number of arguments is correct
    if (givenArgCount !== functionType.parameters.length) {
      throw this.formatErrorMessage(
        functionCallExpr?.token ?? PlaceholderToken,
        `Expected ${functionType.parameters.length} arguments, got ${argExprs.length}.`
      );
    }
    */

    // Push new frame to env
    callerEnv = pushEnvFrame(callerEnv);
    // Push new frame to function env
    let calleeEnv = pushEnvFrame(functionType.env);

    /* NOTE: We now support default values 
    // Evaluate the forallArgsExpr
    // Add necessary type parameters to the calleeEnv
    if (
      forallArgsExpr &&
      forallArgsExpr.args.length !== functionType.typeParameters.length
    ) {
      throw this.formatErrorMessage(
        forallArgsExpr.token,
        `Expected ${functionType.typeParameters.length} type arguments, got ${forallArgsExpr.args.length}.`
      );
    }
    */

    for (let i = 0; i < functionType.typeParameters.length; i++) {
      // Add typeParameter to calleeEnv
      const typeParameter = functionType.typeParameters[i]!;
      if (typeParameter.exprs.labelExpr && typeParameter.label) {
        const { env: nextEnv } = addVariableToEnv({
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
          // QUESTION: Should we just update the existing variable?
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
    }

    // Synthesize the returnType if context.expectedType is giving
    // The context.expectedType is the expected function return type.
    // QUESTION: Should we run it after evaluating the normal arguments?
    if (context.expectedType) {
      const { expectedEnv } = this.synthesizeTypes(
        { type: functionType.return.type, env: calleeEnv },
        { type: context.expectedType.type, env: context.expectedType.env }
      );
      calleeEnv = expectedEnv;
      // env = givenEnv; // NOTE: No need to update `env` here
    }

    // Check if the parameters match the arguments
    for (let i = 0; i < functionType.parameters.length; i++) {
      const parameter = functionType.parameters[i]!;
      const argExpr: Expr | undefined = argExprs[i];
      const {
        calleeEnv: nextCalleeEnv,
        callerEnv: nextCallerEnv,
        context: nextContext,
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
    return { returnType, calleeEnv, callerEnv, pathCollection };
  }

  private tryToCallTypeWithArguments({
    memberElements,
    functionCallExpr,
    argExprs,
    callerEnv,
    context,
  }: {
    memberElements: TupleElement[];
    functionCallExpr: Expr;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
  }): { values: (Value | undefined)[]; pathCollection: PathCollection } {
    if (argExprs.length > memberElements.length) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Failed to call the type. Too many members provided. Expected ${memberElements.length} arguments, got ${argExprs.length}.`
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

      const argType = evaluatedArgExpr.$?.type;
      if (!argType) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate argument expression:\n${exprToString(argExpr)}`
        );
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
      values[memberElementPositionIndex] = evaluatedArgExpr.$?.value;
      checkedMemberElements.add(memberElement);
    }

    // Check if any unchecked member elements have no default value
    for (let i = 0; i < memberElements.length; i++) {
      const memberElement = memberElements[i]!;
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

    return { values, pathCollection };
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
      keepComptimeVariablesFromEnv(callerEnv),
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
      calledTypeFunctionCaches: [],
      SelfType: context.SelfType, // In theory, this should be undefined.
    };

    // Evaluate the function body
    const evaluatedFunctionBody = this.evaluateBeginExpression({
      expr: functionBodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingFunctionBodyOfType: functionType,
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
  }): ModuleValue {
    if (argExprs.length > moduleType.members.length) {
      throw this.formatErrorMessage(
        moduleExpr.token,
        `Failed to implement the module. Too many members provided.`
      );
    }

    const members: Record<string, Value> = {};
    callerEnv = pushEnvFrame(callerEnv);
    for (let i = 0; i < moduleType.members.length; i++) {
      const moduleMember = moduleType.members[i]!;
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

        if (moduleMember.label === label) {
          foundArgExpr = true;

          if (moduleMember.requiredValue) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Module member "${
                moduleMember.label
              }" already has a required value:
${valueToString(moduleMember.requiredValue)}`
            );
          }

          // evaluate the module member type again.
          /*
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
          */
          const moduleMemberType = moduleMember.type;

          // evaluate the argExpr
          const evaluatedArgExpr = this.evaluateExpression({
            expr: argExpr,
            env: callerEnv,
            context: {
              ...context,
              expectedType: { type: moduleMemberType, env: callerEnv },
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
              { type: moduleMemberType, env: callerEnv },
              { type: argType, env: callerEnv }
            )
          ) {
            throw this.formatErrorMessage(
              argExpr.token,
              `Type mismatch for the module member "${label}":
Expected: ${typeToString(moduleMemberType)}
Got:   ${typeToString(argType)}`
            );
          }
          const argValue = evaluatedArgExpr.$?.value;
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
        const defaultValue = moduleMember.defaultValue;
        const requiredValue = moduleMember.requiredValue;
        // Check if moduleMember has default or required value
        if (!defaultValue && !requiredValue) {
          throw this.formatErrorMessage(
            moduleExpr.token,
            `Module member "${moduleMember.label}" is not provided and has no required/default value.`
          );
        }

        if (defaultValue) {
          members[moduleMember.label] = defaultValue;
        }
        if (requiredValue) {
          members[moduleMember.label] = requiredValue;
        }

        // Add to the env
        const { env: nextEnv } = addVariableToEnv({
          env: callerEnv,
          variable: {
            name: moduleMember.label,
            type: moduleMember.type,
            isMutable: false,
            isCompileTimeOnly: true,
            token: moduleExpr.token,
            isUndefined: false,
            isImplicit: false,
            value: moduleMember.defaultValue,
          },
        });
        callerEnv = nextEnv;
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
    callerEnv,
    context,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    functionValue: FunctionValue;
    argExprs: Expr[];
    callerEnv: Environment;
    context: EvaluatorContext;
  }): { value: TypeValue; callerEnv: Environment } {
    // This will push a new frame to the function env and
    // add the parameters to the env
    const { calleeEnv, callerEnv: nextCallerEnv } =
      this.tryToCallFunctionWithArguments({
        functionValue,
        functionType,
        functionCallExpr,
        argExprs,
        callerEnv,
        context: { ...context },
      });
    callerEnv = nextCallerEnv;

    // FIXME: The argValues below should be returned from this.tryToCallFunctionWithArguments
    // argExprs should be evaluated now
    const argValues: Value[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const argExpr = argExprs[i]!;
      const argValue = argExpr.$?.value;
      if (!argValue || isUnknownValue(argValue)) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Argument for type function is not evaluated correctly`
        );
      }
      argValues.push(argValue);
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

            return areValuesEqual(
              { value: argValue, env: cache.env },
              { value: givenArgValue, env: callerEnv }
            );
          })
        ); // Check if the values are equal
      });
      if (calledTypeFunction) {
        // Find the cache
        return {
          callerEnv: callerEnv,
          value: calledTypeFunction.typeValue,
        };
      }
    }

    // Evaluate functionValue.body with the function env
    const functionBodyExpr = functionValue.body;
    // NOTE: We should use the env from the function, not the current env.
    const evaluatedFunctionBody = this.evaluateBeginExpression({
      expr: functionBodyExpr,
      env: calleeEnv,
      context: { ...context },
    });
    if (!evaluatedFunctionBody.$) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly`
      );
    }

    // Get the return type value
    const returnValue = evaluatedFunctionBody.$.value;
    if (!isTypeValue(returnValue)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly. Expected to return a type.`
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

    // Cache the function call
    const caches = (calledTypeFunctions ?? []).concat({
      funcId,
      argValues,
      typeValue: returnValue,
      env: evaluatedFunctionBody.$.env,
    });
    functionValue.calledTypeFunctionCaches = caches;

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

  private evaluateAnonmousModuleBeginExprs({
    beginExprs,
    env,
    context,
  }: {
    beginExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { moduleValue: ModuleValue; moduleType: ModuleType; env: Environment } {
    // Create module type
    const moduleType = createModuleType([], env);

    // Push new frame to the env
    env = pushEnvFrame(env);

    const moduleMembers: ModuleMember[] = [];
    const memberValues: Record<string, Value> = {};

    // Evaluate each expression in the begin
    for (let i = 0; i < beginExprs.length; i++) {
      const expr = beginExprs[i]!;
      // Export
      if (
        exprIsFunctionCall(expr) &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.export, 1)
      ) {
        const evaluatedExpr = this.evaluateExpression({
          expr: expr.args[0]!,
          env,
          context: {
            ...context,
            expectedType: undefined,
            SelfType: undefined,
          },
        });
        const structValue = evaluatedExpr.$?.value;
        if (!isStructValue(structValue)) {
          throw this.formatErrorMessage(
            expr.token,
            `Expected struct value, got:\n${exprToString(expr)}`
          );
        }
        const structType = structValue.type;

        // Traverse the struct elements to set to module
        for (let i = 0; i < structType.elements.length; i++) {
          const element = structType.elements[i]!;

          // Check if the element has a label
          const label = element.label;
          if (!label) {
            throw this.formatErrorMessage(
              expr.token,
              `Expected label for struct element at position ${i}, got:\n${exprToString(expr)}`
            );
          }

          // Get the variable of label from the env
          const variables = getVariablesFromEnv(env, label);
          if (variables.length === 0) {
            throw this.formatErrorMessage(
              expr.token,
              `Failed to find variable "${label}" in the environment.`
            );
          }
          const variable = variables[variables.length - 1]!;

          const moduleMember: ModuleMember = {
            label,
            type: element.type,
            isImplicit: variable.isImplicit,
            // NOTE: Needs to set the value as requiredValue
            // It is necessary to make it work with `This` the receiver type.
            requiredValue: structValue.elements[i],
            defaultValue: undefined,
            expr: element.expr,
          };
          // Check if the module member already exists
          // If so, override it
          const existingModuleMemberIndex = moduleMembers.findIndex(
            (member) => member.label === label
          );
          if (existingModuleMemberIndex >= 0) {
            moduleMembers[existingModuleMemberIndex] = moduleMember;
          } else {
            moduleMembers.push(moduleMember);
          }

          const value = structValue.elements[i]!;
          memberValues[label] = value;
        }
      } else {
        const evaluatedExpr = this.evaluateExpression({
          expr,
          env,
          context: {
            ...context,
            expectedType: undefined,
            SelfType: moduleType,
          },
        });
        if (evaluatedExpr.$?.env) {
          env = evaluatedExpr.$?.env;
        }
      }
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Update the moduleType
    moduleType.members = moduleMembers;

    // Create the module value
    const moduleValue = createModuleValue(moduleType, memberValues);

    return {
      moduleValue,
      moduleType,
      env,
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
    } = this.evaluateAnonmousModuleBeginExprs({
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
    }

    const moduleMemberExprs = expr.args;
    // Evaluate the module members
    const moduleType = createModuleType([], env);

    // Increase the env frame
    env = pushEnvFrame(env);

    // Evaluate each module member
    for (let i = 0; i < moduleMemberExprs.length; i++) {
      let memberExpr = moduleMemberExprs[i]!;
      let valueExpr: Expr | undefined = undefined;
      let valueKind: "required" | "default" | undefined = undefined;
      let isImplicit = false;
      if (
        exprIsFunctionCall(memberExpr) &&
        (exprIsFunctionCallOf(memberExpr, "?=", 2) ||
          exprIsFunctionCallOf(memberExpr, "=", 2))
      ) {
        valueExpr = memberExpr.args[1]!;
        memberExpr = memberExpr.args[0]!;
        valueKind = exprIsFunctionCallOf(memberExpr, "?=", 2)
          ? "default"
          : "required";
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
      let labelExpr = memberExpr.args[0]!;
      const typeExpr = memberExpr.args[1]!;

      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
      ) {
        isImplicit = true;
        labelExpr = labelExpr.args[0]!;
      }

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

      // Evaluate the member type
      const evaluatedMemberTypeExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
        context: {
          ...context,
          SelfType: undefined, // NOTE: Set it as undefined here.
          // `Self` in a module is used as the received type.
        },
      });
      if (evaluatedMemberTypeExpr.$?.env) {
        env = evaluatedMemberTypeExpr.$.env;
      }

      // Expect the member type to be a type
      const typeValue = evaluatedMemberTypeExpr.$?.value;
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

      if (isTypeHierarchyType(memberType) && valueKind !== "required") {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Module member "${label}" is missing required type value.`
        );
      }

      // Evaluate the default value expr if it exists
      if (valueExpr) {
        const evaluatedValueExpr = this.evaluateExpression({
          expr: valueExpr,
          env,
          context: {
            ...context,
            expectedType: { type: memberType, env },
            SelfType: undefined,
          },
        });
        if (evaluatedValueExpr.$?.env) {
          env = evaluatedValueExpr.$.env;
        }
        const value = evaluatedValueExpr.$?.value;
        if (!value) {
          throw this.formatErrorMessage(
            valueExpr.token,
            `Expected value for module member, got:\n${exprToString(valueExpr)}`
          );
        }

        // Set the default value
        moduleType.members.push({
          label,
          type: memberType,
          isImplicit,
          defaultValue: valueKind === "default" ? value : undefined,
          requiredValue: valueKind === "required" ? value : undefined,
          // typeExpr: evaluatedMemberTypeExpr,
          expr: memberExpr,
        });

        // Add the label to the env
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: label,
            token: labelExpr.token,
            type: memberType,
            isMutable: false,
            isUndefined: false,
            isCompileTimeOnly: true,
            isImplicit: false,
            value:
              valueKind === "required"
                ? value
                : createUnknownValue(memberType, label),
          },
          skipCheckingFunctionOverloading: true,
        });
        env = nextEnv;

        // Add type info the labelExpr;
        labelExpr.$ = {
          env,
          type: memberType,
          isMutable: false,
          pathCollection: [],
        };
      } else {
        // Add the member to the moduleType
        moduleType.members.push({
          label,
          type: memberType,
          isImplicit,
          defaultValue: undefined,
          requiredValue: undefined,
          // typeExpr: evaluatedMemberTypeExpr,
          expr: memberExpr,
        });

        // Add the label to the env
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: label,
            token: labelExpr.token,
            type: memberType,
            isMutable: false,
            isUndefined: false,
            isCompileTimeOnly: true,
            isImplicit: false,
            value: createUnknownValue(memberType, label),
          },
        });
        env = nextEnv;

        // Add type info the labelExpr;
        labelExpr.$ = {
          env,
          type: memberType,
          isMutable: false,
          pathCollection: [],
        };
      }
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Set the module type and value
    expr.$ = {
      env,
      type: typeOfType(moduleType),
      value: createTypeValue(moduleType),
      isMutable: false,
      pathCollection: [],
    };
    expr.func.$ = expr.$;
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

    const argType = evaluatedConsumeArgExpr.$.type;
    if (!isLinearOrType0Type(typeOfType(argType))) {
      throw this.formatErrorMessage(
        consumeArgExpr.token,
        `Expected "Linear" type for consume argument, got:\n${exprToString(consumeArgExpr)}`
      );
    }

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

  private evaluateImport({
    expr,
    env,
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
    /*
    // TODO: Support comptime string
    // Evaluate the moduleArg
    const evaluatedModuleArg = this.evaluateExpression({
      expr: moduleArg,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: false,
        expectedType: undefined,
        SelfType: undefined,
      },
    });
    const value = evaluatedModuleArg.value;
    */
    if (moduleArg.token.type !== TokenType.String) {
      throw this.formatErrorMessage(
        moduleArg.token,
        `Expected string for module path, got:\n${exprToString(moduleArg)}`
      );
    }

    // Import the module
    const modulePath = moduleArg.token.value.slice(1, -1); // Remove the quotes

    if (!modulePath.startsWith("./")) {
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

    // Load the module
    const moduleValue = this.loadModule(moduleAbsolutePath);
    expr.$ = {
      env,
      type: moduleValue.type,
      value: moduleValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  /* 
  eg:
    borrow((borrowed_values), (borrow_bindings)-> {
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
      !exprIsFunctionCallOf(secondExpr, "->", 2)
    ) {
      throw this.formatErrorMessage(
        secondExpr.token,
        `Expected "->" with 2 arguments, got:\n${exprToString(secondExpr)}`
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
      checkBorrowings(borrowings);
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
      // Add the binding to the env
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: bindingName,
          type: borrowings[i]!.type,
          isMutable: isMutRefType(borrowings[i]!.type),
          isCompileTimeOnly: false,
          token: bindingExpr.token,
          isUndefined: false,
          isImplicit: false,
          value: undefined, // borrowings[i]!.value,
        },
        skipCheckingFunctionOverloading: true,
      });
      env = nextEnv;

      // Add the info to the bindingExpr
      bindingExpr.$ = {
        env,
        type: borrowings[i]!.type,
        isMutable: isMutRefType(borrowings[i]!.type),
        pathCollection: borrowings[i]!.pathCollection,
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
  private evaluateExpectCompileError({
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
        expectedType: undefined,
        SelfType: undefined,
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
      const value = createTypeValue(TUnit);
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
    });
    env = nextEnv;

    // We disallow the tuple elements to have defaultValue for the tuple type
    tupleType.elements.forEach((tupleElement) => {
      if (tupleElement.defaultValue) {
        throw this.formatErrorMessage(
          tupleElement.expr.token,
          `Tuple elements cannot have default value.`
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
          type: TUsize,
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
        expectedType: undefined,
        SelfType: undefined,
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

  /**
   * Evaluate a linear pointer call
   * For example:
   *
   *
   */
  private evaluateLinearPointerCall({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const pointerTypeKind: TypeTag.LinearPtr | TypeTag.MutLinearPtr =
      exprIsFunctionCallOf(expr, BuiltinKeywords.LinearPtr)
        ? TypeTag.LinearPtr
        : TypeTag.MutLinearPtr;

    const argExpr = expr.args[0]!;
    const evaluatedArgExpr = this.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: undefined,
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
        pointerTypeKind === TypeTag.LinearPtr
          ? createLinearPtrType(baseType)
          : createMutLinearPtrType(baseType);
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
      throw this.formatErrorMessage(
        argExpr.token,
        `Expected type for linear pointer, got:\n${exprToString(argExpr)}`
      );
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
        case TokenType.Operator: {
          return this.evaluateIdentifierAndOperator({
            expr,
            env,
            context: { ...context },
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
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
        // struct
        return this.evaluateStruct({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
        // enum
        return this.evaluateEnum({ expr, env, context: { ...context } });
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
        exprIsFunctionCallOf(expr, BuiltinKeywords.LinearPtr, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutLinearPtr, 1)
      ) {
        // ^ or ^! linear pointers
        return this.evaluateLinearPointerCall({
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
        exprIsFunctionCallOf(expr, BuiltinFunctions.expect_compile_error)
      ) {
        // expect_compile_error
        return this.evaluateExpectCompileError({
          expr,
          env,
          context: { ...context },
        });
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

    const { moduleValue, env: nextEnv } = this.evaluateAnonmousModuleBeginExprs(
      {
        beginExprs: this.program,
        env,
        context: {
          expectedType: undefined,
          SelfType: undefined,
          borrowings: [],
        },
      }
    );
    env = nextEnv;
    this.moduleValue = moduleValue;
  }

  public getModuleValue(): ModuleValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }
}
