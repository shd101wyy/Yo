import {
  addVariableToEnv,
  createNewEnv,
  Environment,
  getInterfaceMethodsByNameFromEnv,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
} from "./env";
import { formatErrorMessage } from "./error";
import {
  AtomExpr,
  BuiltinCollections,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "./expr";
import { FunctionValue } from "./function-value";
import Parser from "./parser";
import { stringIsOperator, Token, TokenType } from "./token";
import {
  areTypesCompatible,
  createEnumType,
  createFunctionType,
  createInterfaceType,
  createStructType,
  createTupleType,
  EnumType,
  EnumVariant,
  FunctionParameter,
  FunctionType,
  InterfaceMember,
  InterfaceType,
  isBooleanType,
  isEnumType,
  isFunctionType,
  isFunctionTypeAndIsTypeFunction,
  isInterfaceType,
  isPlaceholderType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
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
import { randomId } from "./utils";
import {
  areValuesEqual,
  createTypeValue,
  isFunctionValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  TupleValue,
  Value,
  valueToString,
  VUnit,
  VUnknown,
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
        type: { ...TI32, isCompileTimeOnly: true },
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
      const value: Value = {
        tag: ValueTag.Boolean,
        type: { ...TBoolean, isCompileTimeOnly: true },
        value: booleanValue,
      };
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

  /**
   * Evaluate the element in tuple rvalue, such as
   * value:
   * 14  in (14, ...)
   * (x: 16) in (x: 16)
   *
   * type:
   * i32 in (i32, ...)
   * (x: i32) in (x: i32, ...)
   */
  private evaluateTupleElement({
    expr,
    tupleElementIndex,
    env,
    context,
  }: {
    expr: Expr;
    tupleElementIndex: number;
    env: Environment;
    context: EvaluatorContext;
  }): { type: TupleElement; value: Value; env: Environment } {
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
      if (!defaultValue || defaultValue === VUnknown) {
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
    const expectedTupleType = context.expectedType;
    let expectedTupleElementType: Type | undefined = undefined;
    if (expectedTupleType) {
      if (!isTupleType(expectedTupleType)) {
        throw this.formatErrorMessage(
          expr.token,
          `Failed to evaluate the tuple elements. Expected type to be:
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
    if (context.isEvaluatingExprAsType) {
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
    } else {
      if (evaluatedRhs.value && isTypeValue(evaluatedRhs.value)) {
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
        // elementType = TPlaceholder;
      } else if (lhsExpr) {
        lhsExpr.type = lhsExpr.type || evaluatedRhs.type;
      }
    }

    let value: Value = VUnknown;
    if (!context.isEvaluatingExprAsType) {
      // Evaluating value.
      value = evaluatedRhs.value ?? VUnknown;
    } else {
      // Evaluating type.
      value = VUnknown; // NOTE: This is necessary
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.value = value;
    }
    expr.env = env;
    return {
      type: {
        label,
        type: elementType,
        expr,
        defaultValue,
      },
      value: value,
      env,
    };
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

    expr.value = tupleValue;
    expr.type = context.isEvaluatingExprAsType
      ? typeOfType(tupleType)
      : tupleType;
    expr.env = env;
    return expr;
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
    const tupleValues: Value[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      const {
        type,
        value,
        env: nextEnv,
      } = this.evaluateTupleElement({
        expr: arg,
        env,
        tupleElementIndex: i,
        context,
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
      value = {
        tag: ValueTag.Type,
        type: typeOfType(tupleType),
        value: tupleType,
      };
    } else {
      value = {
        tag: ValueTag.Tuple,
        type: tupleType,
        elements: tupleValues,
      };
    }
    return {
      type: tupleType,
      value,
      env,
    };
  }

  private isValidVariableName(expr: Expr): boolean {
    return (
      exprIsAtom(expr) && expr.token.type === TokenType.Identifier
      //   || expr.token.type === TokenType.Operator
      // Operator is not a valid variable name anymore.
      // It can only be used in the context of interface method declaration.
    );
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
          context,
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
          context,
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
          context,
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
    else if (expr.type && !isPlaceholderType(expr.type) && type) {
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
        rhsMembers: rhsType.members,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
        context,
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
        rhsMembers: rhsType.elements,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
        context,
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
    rhsMembers,
    rhsValue,
    rhsType,
    lhs,
    env,
    context,
  }: {
    lhsFunc: Expr;
    lhsElements: Expr[];
    rhsMembers: TupleElement[];
    rhsValue: Value | undefined;
    rhsType: Type;
    lhs: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    const isStruct = isStructType(rhsType);
    const structTypeName = isStruct ? lhsFunc.token.value : undefined;

    // Verify the struct type name matches if specified
    if (
      isStructType(rhsType) &&
      rhsType.typeName &&
      structTypeName !== "_" &&
      structTypeName !== rhsType.typeName
    ) {
      throw this.formatErrorMessage(
        lhsFunc.token,
        `Expected struct of type ${rhsType.typeName}, got ${structTypeName}`
      );
    }

    // Check if we have enough elements
    if (lhsElements.length > rhsMembers.length) {
      throw this.formatErrorMessage(
        lhs.token,
        `Too many elements in destructuring pattern. Expected at most ${rhsMembers.length}, got ${lhsElements.length}`
      );
    }

    // Process each lhs element
    for (let i = 0; i < lhsElements.length; i++) {
      const lhsElement = lhsElements[i];
      let elementIndex: number = i;
      // Initialize rhsMember here, before any conditional branches
      let rhsMember = rhsMembers[elementIndex];
      let variableName: string | undefined;
      let variableToken: Token | undefined;
      let labelExpr: Expr | undefined = undefined;
      let renameExpr: Expr | undefined = undefined;

      // Handle nested tuple destructuring pattern like (a, b, (x, y))
      if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, BuiltinCollections.Tuple)
      ) {
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Ensure the member we're destructuring is a tuple or struct
        if (!isTupleType(nestedRhsType) && !isStructType(nestedRhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected tuple or struct for nested destructuring, got ${typeToString(
              nestedRhsType
            )}`
          );
        }

        // Get the nested members
        const nestedMembers = isTupleType(nestedRhsType)
          ? nestedRhsType.elements
          : (nestedRhsType as StructType).members;

        // Recursively process nested destructuring
        env = this.handleMemberDestructuring({
          lhsFunc: lhsElement.func,
          lhsElements: lhsElement.args,
          rhsMembers: nestedMembers,
          rhsValue: nestedValue as TupleValue | undefined,
          rhsType: nestedRhsType,
          lhs: lhsElement,
          env,
          context,
        });

        // Set type and value on the lhs element
        lhsElement.type = nestedRhsType;
        lhsElement.value = nestedValue;
        lhsElement.env = env;

        // Skip to next element since we've already processed this one
        continue;
      }

      // Handle labeled nested destructuring pattern like (c: (x, y))
      else if (
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
        const matchingMemberIndex = rhsMembers.findIndex(
          (member) => member.label === label
        );

        if (matchingMemberIndex === -1) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Label "${label}" not found in the ${
              isStruct ? "struct" : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Check if the right side is a tuple for nested destructuring (c: (x, y))
        if (
          exprIsFunctionCall(rightSide) &&
          exprIsFunctionCallOf(rightSide, BuiltinCollections.Tuple)
        ) {
          // Ensure the member we're destructuring is a tuple or struct
          if (!isTupleType(nestedRhsType) && !isStructType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected tuple or struct for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Get the nested members
          const nestedMembers = isTupleType(nestedRhsType)
            ? nestedRhsType.elements
            : (nestedRhsType as StructType).members;

          // Recursively process nested destructuring
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsMembers: nestedMembers,
            rhsValue: nestedValue as TupleValue | undefined,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
            context,
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

        // Check if the right side is a struct for nested destructuring (c: _(x, y))
        else if (
          exprIsFunctionCall(rightSide) &&
          exprIsFunctionCallOf(rightSide, "_")
        ) {
          if (!isStructType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected struct for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Recursively process nested destructuring
          const nestedMembers = nestedRhsType.members;
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsMembers: nestedMembers,
            rhsValue: nestedValue as TupleValue | undefined,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
            context,
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

      // Handle label-based destructuring like Named(.x, .y) := p or (.a, .b) := x
      else if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ".", 1)
      ) {
        labelExpr = lhsElement.args[0];
        if (!exprIsAtom(labelExpr) || !this.isValidVariableName(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label in destructuring pattern, got ${exprToString(
              labelExpr
            )}`
          );
        }

        const label = labelExpr.token.value;
        // Find the member with matching label
        const matchingMemberIndex = rhsMembers.findIndex(
          (member) => member.label === label
        );

        if (matchingMemberIndex === -1) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Label "${label}" not found in the ${
              isStruct ? "struct" : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsMember = rhsMembers[elementIndex];
        variableName = label;
        variableToken = labelExpr.token;
      }

      // Handle nested struct destructuring pattern like (a, SomeStruct(x, y)) or (a, _(x, y))
      else if (
        exprIsFunctionCall(lhsElement) /* &&
        ((exprIsAtom(lhsElement.func) &&
          this.isValidVariableName(lhsElement.func) &&
          lhsElement.func.token.value !== ":") ||
          exprIsFunctionCallOf(lhsElement.func, "_"))
        */
      ) {
        if (!exprIsFunctionCallOf(lhsElement, "_")) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected "_" for struct destructuring, got ${exprToString(
              lhsElement
            )}`
          );
        }

        const structNameExpr = lhsElement.func;
        const structNameValue = exprIsAtom(structNameExpr)
          ? structNameExpr.token.value
          : "_";

        // Get the right-hand side value at this position
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Ensure the member we're destructuring is a struct
        if (!isStructType(nestedRhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected struct for struct destructuring, got ${typeToString(
              nestedRhsType
            )}`
          );
        }

        // For named struct, verify the struct type name matches
        if (
          structNameValue !== "_" &&
          nestedRhsType.typeName &&
          structNameValue !== nestedRhsType.typeName
        ) {
          throw this.formatErrorMessage(
            lhsElement.func.token,
            `Expected struct of type ${nestedRhsType.typeName}, got ${structNameValue}`
          );
        }

        // Recursively process nested destructuring
        env = this.handleMemberDestructuring({
          lhsFunc: lhsElement.func,
          lhsElements: lhsElement.args,
          rhsMembers: nestedRhsType.members,
          rhsValue: nestedValue as TupleValue | undefined,
          rhsType: nestedRhsType,
          lhs: lhsElement,
          env,
          context,
        });

        // Set type and value on the lhs element
        lhsElement.type = nestedRhsType;
        lhsElement.value = nestedValue;
        lhsElement.env = env;

        // Skip to next element since we've already processed this one
        continue;
      }

      // Handle positional destructuring
      else if (exprIsAtom(lhsElement) && this.isValidVariableName(lhsElement)) {
        variableName = lhsElement.token.value;
        variableToken = lhsElement.token;
      } else {
        throw this.formatErrorMessage(
          lhsElement.token,
          `Unsupported destructuring pattern for ${
            isStruct ? "struct" : "tuple"
          }: ${exprToString(lhsElement)}`
        );
      }

      // After determining variableName and variableToken, add to environment
      if (variableName && variableToken) {
        // Get the value if available
        let elementValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        }

        // Add the variable to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: variableName,
            token: variableToken,
            type: rhsMember.type,
            isMutable: false,
            isNotInitialized: false,
            value: elementValue,
          },
        });

        env = nextEnv;

        // Set the type and value on the lhs element for completeness
        lhsElement.type = rhsMember.type;
        lhsElement.value = elementValue;
        lhsElement.env = env;

        if (labelExpr) {
          labelExpr.type = rhsMember.type;
          if (!renameExpr) {
            labelExpr.value = elementValue;
          }
          labelExpr.env = env;
        }

        if (renameExpr) {
          renameExpr.type = rhsMember.type;
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
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ["compt", "@"])) {
      isCompileTimeOnly = true;
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for "compt" (or "@"), got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
    }
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, "mut")) {
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

    if (isTypeHierarchyType(userDefinedType) && !isCompileTimeOnly) {
      throw this.formatErrorMessage(
        lhs.token,
        `Expected "compt" (or "@") to for compile-time known type value binding.`
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
        value: VUnknown,
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
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, "mut")) {
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
        `Unexpected "mut" for type value:
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
            context,
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
          isInterfaceType(rhs.value.value)) &&
        !rhs.value.value.typeName
      ) {
        rhs.value.value.typeName = lhs.token.value;
      }

      // Set the variable value
      lhs.value = rhs.value;
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
        context,
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
            context,
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
      lhs.value = rhs.value;
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
    if (!exprIsFunctionCallOf(expr, "extern")) {
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
              value: VUnknown,
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
    if (!exprIsFunctionCallOf(expr, "cond")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected cond, got ${expr.tag}`
      );
    }

    const statements = expr.args;
    if (statements.length === 0) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least one statement in cond, got ${statements.length}`
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

    expr.type = valueType;
    // TODO: set .value
    expr.value = VUnknown;
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
    if (!exprIsFunctionCallOf(expr, "match")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected match, got ${expr.tag}`
      );
    }

    const args = expr.args;
    if (args.length < 2) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least 2 arguments for match, got ${args.length}`
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

        if (!variant.params) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" does not have parameters but got pattern with parameters`
          );
        }

        // Push a new environment frame for this pattern
        const patternEnv = pushEnvFrame(env);

        // Check if the pattern arguments match the variant parameters
        const patternParams = patternExpr.args;
        if (patternParams.length > variant.params.length) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Too many parameters in pattern. Expected ${variant.params.length}, got ${patternParams.length}`
          );
        }

        // Add each parameter to environment as local variable
        for (let j = 0; j < patternParams.length; j++) {
          const param = patternParams[j];
          const variantParam = variant.params[j];

          if (!exprIsAtom(param) || !this.isValidVariableName(param)) {
            throw this.formatErrorMessage(
              param.token,
              `Expected identifier for parameter, got ${exprToString(param)}`
            );
          }

          // Assign the proper type from the variant parameter to this variable
          param.type = variantParam.type;

          const { env: updatedEnv } = addVariableToEnv({
            env: patternEnv,
            variable: {
              name: param.token.value,
              token: param.token,
              type: variantParam.type,
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
    // For compile-time evaluation, we'd determine which arm matches and set the value
    // For now, just set it to unknown
    expr.value = VUnknown;
    expr.env = env;

    return expr;
  }

  private evaluateIdentifier({
    expr,
    env, // context,
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
    const expectedFunctionType = context.expectedType;
    if (expectedFunctionType && !isFunctionType(expectedFunctionType)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected a function type, got ${typeToString(expectedFunctionType)}`
      );
    }

    if (!exprIsFunctionCallOf(expr, "->", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected -> for anonymous function, got:\n${exprToString(expr)}`
      );
    }
    let functionDeclarationExpr = expr.args[0];
    const functionBodyExpr = expr.args[1];
    let returnTypeExpr: Expr | undefined = undefined;

    // Check if fnDeclarationExpr is in format of fn(x:i32): i32
    // That declares the function return type;
    let returnType: Type | undefined = undefined;
    if (
      exprIsFunctionCall(functionDeclarationExpr) &&
      exprIsFunctionCallOf(functionDeclarationExpr, ":", 2)
    ) {
      // Get the "i32" part
      returnTypeExpr = functionDeclarationExpr.args[1];

      // Get the "fn(x:i32)" part
      functionDeclarationExpr = functionDeclarationExpr.args[0];
    }

    if (
      !exprIsFunctionCall(functionDeclarationExpr) ||
      !exprIsFunctionCallOf(functionDeclarationExpr, "fn")
    ) {
      throw this.formatErrorMessage(
        functionDeclarationExpr.token,
        `Expected "fn" for anonymous function, got:\n${exprToString(
          functionDeclarationExpr
        )}`
      );
    }

    // Evaluate the parameter list
    // env = pushEnvFrame(env);
    let functionParameters: FunctionParameter[] = [];
    {
      const { parameters, env: nextEnv } = this.evaluateFunctionParameters({
        parameterExprs: functionDeclarationExpr.args,
        expectedParameters: expectedFunctionType?.params,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
        },
      });
      functionParameters = parameters;
      env = nextEnv;
    }

    // Evaluate the return type expression
    if (returnTypeExpr) {
      const functionReturnValue = this.evaluateExpression({
        expr: returnTypeExpr,
        env,
        context: {
          ...context,
          isEvaluatingExprAsType: true,
        },
      }).value;
      if (!isTypeValue(functionReturnValue)) {
        throw this.formatErrorMessage(
          functionDeclarationExpr.token,
          `Expected a type for function return type, got:\n${exprToString(
            functionDeclarationExpr
          )}`
        );
      } else {
        returnType = functionReturnValue.value;
      }
    } else if (expectedFunctionType) {
      returnType = expectedFunctionType.return.type;
      returnTypeExpr = expectedFunctionType.return.expr;
    } else {
      throw this.formatErrorMessage(
        functionDeclarationExpr.token,
        `Expected a function return type, got:\n${exprToString(
          functionDeclarationExpr
        )}`
      );
    }

    const functionType = createFunctionType({
      params: functionParameters,
      return_: {
        type: returnType,
        expr: returnTypeExpr,
      },
      env: popEnvFrame(env),
    });

    // TODO: Check if the functionType matches the expectedFunctionType

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
    if (!exprIsFunctionCallOf(expr, "recur")) {
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
      context,
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

    // Parse the lhs expr
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ":")) {
      rhsExpr = expr.args[1];
      lhsExpr = expr.args[0];

      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, ["compt", "@"])
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
      if (exprIsFunctionCall(lhsExpr) && exprIsFunctionCallOf(lhsExpr, "mut")) {
        isMutable = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for "mut", got ${lhsExpr.args.length}`
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
    } else {
      // Parse the rhs expr which should be a type
      const evaluatedRhs = this.evaluateExpression({
        expr: rhsExpr,
        env,
        context,
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

    if (isTypeHierarchyType(parameterType) && !isCompileTimeOnly) {
      throw this.formatErrorMessage(
        lhsExpr?.token ?? rhsExpr.token,
        `Expected a "compt" (or "@") for parameter to be compile-time only.`
      );
    }

    if (lhsExpr && label) {
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
        },
      });
      env = nextEnv;
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.value = VUnknown;
      lhsExpr.type = parameterType;
    }
    expr.env = env;
    return {
      parameter: {
        label,
        type: parameterType,
        expr,
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
    env = pushEnvFrame(env);
    const { parameters, env: nextEnv } = this.evaluateFunctionParameters({
      parameterExprs: argList,
      env,
      context: {
        ...context,
        isEvaluatingExprAsType: true,
      },
    });
    env = nextEnv;

    let isReturnTypeCompileTimeOnly = false;
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, ["compt", "@"])
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
    if (isTypeHierarchyType(returnType) && !isReturnTypeCompileTimeOnly) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a "compt" (or "@") for return type, like:\n
compt(${exprToString(returnTypeExpr)})`
      );
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
    if (!exprIsFunctionCallOf(expr, "type", 1)) {
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
    if (!exprIsFunctionCallOf(expr, "struct")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected struct, got:\n${exprToString(expr)}`
      );
    }

    const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
      args: expr.args,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    env = nextEnv;

    const structType: StructType = createStructType(tupleType.elements);
    expr.type = typeOfType(structType);
    expr.value = {
      tag: ValueTag.Type,
      type: typeOfType(structType),
      value: structType,
    };
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
    if (!exprIsFunctionCallOf(expr, "enum")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected enum, got:\n${exprToString(expr)}`
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
          params: tupleType.elements,
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
      if (!variant.params) {
        expr.type = newEnumType;
        propertyExpr.type = newEnumType;
        // FIXME: Support expr.value for comptime evaluation.
        // expr.value = createEnumValue()
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
      context,
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
        if (!variant.params) {
          expr.type = newEnumType;
          propertyExpr.type = newEnumType;
          // FIXME: Support expr.value for comptime evaluation.
          // expr.value = createEnumValue()
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
      } else if (
        isTupleType(typeValue.value) ||
        isStructType(typeValue.value)
      ) {
        let elements: TupleElement[] = [];
        if (isTupleType(typeValue.value)) {
          elements = typeValue.value.elements;
        } else if (isStructType(typeValue.value)) {
          elements = typeValue.value.members;
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
                  typeValue.value
                )}`
              );
            }
            const tupleElement = elements[index];
            expr.value = createTypeValue(tupleElement.type);
            expr.type = expr.value.type;
            propertyExpr.type = tupleElement.type;
            return expr;
          } else if (this.isValidVariableName(propertyExpr)) {
            const label = propertyExpr.token.value;
            // Check if the type method exists
            const method = (typeValue.value.methods ?? []).find(
              (method) => method.label === label
            );
            if (method) {
              expr.value = method.value;
              expr.type = method.type;
              propertyExpr.value = method.value;
              propertyExpr.type = method.type;
              return expr;
            } else {
              const tupleElement = elements.find(
                (element) => element.label === label
              );
              if (!tupleElement) {
                throw this.formatErrorMessage(
                  propertyExpr.token,
                  `Element with label "${label}" not found in:\n${typeToString(
                    typeValue.value
                  )}`
                );
              }
              expr.value = createTypeValue(tupleElement.type);
              expr.type = expr.value.type;
              propertyExpr.type = tupleElement.type;
              return expr;
            }
          }
        }
      } else if (isInterfaceType(typeValue.value)) {
        const interfaceType = typeValue.value;
        if (exprIsAtom(propertyExpr)) {
          const label = propertyExpr.token.value;
          const interfaceMember = interfaceType.members.find(
            (member) => member.label === label
          );
          if (!interfaceMember) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Interface member "${label}" not found in:\n${exprToString(
                objectExpr
              )}`
            );
          }
          expr.value = interfaceMember.value;
          expr.type = interfaceMember.type;
          propertyExpr.type = interfaceMember.type;
          propertyExpr.value = interfaceMember.value;
          return expr;
        } else {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Expected identifier for interface method, got:\n${exprToString(
              propertyExpr
            )}`
          );
        }
      }
    }

    if (isTupleType(objectExpr.type) || isStructType(objectExpr.type)) {
      let elements: TupleElement[] = [];
      if (isTupleType(objectExpr.type)) {
        elements = objectExpr.type.elements;
      } else if (isStructType(objectExpr.type)) {
        elements = objectExpr.type.members;
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
          return expr;
        } else if (this.isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;
          // Check if the type method exists
          const method = (objectExpr.type.methods ?? []).find(
            (method) => method.label === label
          );
          if (method) {
            expr.value = method.value;
            expr.type = method.type;
            propertyExpr.value = method.value;
            propertyExpr.type = method.type;
            return expr;
          } else {
            const tupleElement = elements.find(
              (element) => element.label === label
            );
            if (!tupleElement) {
              throw this.formatErrorMessage(
                propertyExpr.token,
                `Element with label "${label}" not found in:\n${typeToString(
                  objectExpr.type
                )}`
              );
            }
            expr.type = tupleElement.type;
            propertyExpr.type = tupleElement.type;
            // TODO: Support comptime value
            // expr.value = ...
            return expr;
          }
        }
      }
    }

    // TODO: Evaluate the interface method call
    // Since we fail to evaluate the property access
    // it could be an ~~uniform function call~~ interface method call.
    expr.type = undefined;
    expr.value = undefined;
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

    let functions: { type: Type; value?: Value }[] = [];
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
            const interfaceMethods = getInterfaceMethodsByNameFromEnv(
              env,
              methodName,
              receiverType
            );
            functions = interfaceMethods.map((method) => ({
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
        const interfaceMethods = getInterfaceMethodsByNameFromEnv(
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
    const functionsWithMatchingTypes = functions.filter((func) => {
      if (isFunctionType(func.type)) {
        return this.tryToCallFunctionWithArguments({
          functionType: func.type,
          argExprs: args,
          env,
          context,
        });
      } else {
        const value = func.value;
        // struct value
        if (isTypeValue(value) && isStructType(value.value)) {
          return this.tryToCallTypeWithArguments({
            memberElements: value.value.members,
            argExprs: args,
            env,
            context,
          });
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
          return this.tryToCallTypeWithArguments({
            memberElements: selectedVariant.params || [],
            argExprs: args,
            env,
            context,
          });
        }
        return false;
      }
    });

    if (functionsWithMatchingTypes.length === 0) {
      throw this.formatErrorMessage(
        func.token,
        `No matching call found with arguments:
${exprToString(expr)}`
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
            context,
          });
        env = nextEnv;
        expr.value = returnValue;
        expr.type = typeOfType(returnValue.type);

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
            functionType,
            argExprs: args,
            env,
            context,
          });
        env = nextEnv;
        expr.type = returnType;
        // TODO: expr.value should be available for comptime function.

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
        // console.log("struct value");
        const structType = value.value;
        expr.type = structType;
        expr.env = env;

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
      // enum value
      else if (isTypeValue(value) && isEnumType(value.value)) {
        // console.log("enum value");
        const enumType = value.value;
        expr.type = enumType;
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

  private tryToCallFunctionWithArguments({
    functionType,
    argExprs,
    env,
    context,
  }: {
    functionType: FunctionType;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): Environment | false {
    if (argExprs.length > functionType.params.length) {
      return false;
    }

    env = pushEnvFrame(env);
    const checkedFunctionParameters: Set<FunctionParameter> = new Set();
    for (let i = 0; i < functionType.params.length; i++) {
      let paramElement = functionType.params[i];
      let argExpr = argExprs[i];
      if (!argExpr) {
        return false;
      }

      // Check if it's a label
      let label: string | undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        const labelExpr = argExpr.args[0];
        argExpr = argExpr.args[1];

        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label, got:\n${exprToString(labelExpr)}`
          );
        }
        label = labelExpr.token.value;
      }

      if (label) {
        // Find the matching label in the expectedType
        const paramElement_ = functionType.params.find(
          (element) => element.label === label
        );
        if (!paramElement_) {
          return false;
        } else {
          paramElement = paramElement_;
        }
      }

      if (checkedFunctionParameters.has(paramElement)) {
        return false; // Already checked this element
        // We cannot have duplicate labels
      }

      // Evaluate the argExpr
      let evaluatedArgExpr: Expr;
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
        return false;
      }
      let argType = evaluatedArgExpr.type;
      if (!argType) {
        return false; // If synthesis fails, the types are not compatible
      }
      if (isPlaceholderType(argType)) {
        // Synthesize the type
        try {
          const { type: nextArgType, env: nextEnv } =
            this.synthesizeExprAndType({
              expr: argExpr,
              type: paramElement.type,
              env,
              context,
            });
          env = nextEnv;
          argType = nextArgType;
          evaluatedArgExpr.type = nextArgType; // QUESTION: Will this cause problem?
        } catch (e) {
          return false; // If synthesis fails, the types are not compatible
        }
      }

      // Pass a type to parameter
      // eg: T: Type
      if (
        isTypeHierarchyType(paramElement.type) &&
        paramElement.type.level === 0
      ) {
        // Check if the type is a subtype of the given type
        // TODO: Check interfaces
        if (!isTypeHierarchyType(argType) || argType.level !== 0) {
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

      // Compare the types
      else if (!areTypesCompatible(paramElement.type, argType, env)) {
        return false;
      }

      checkedFunctionParameters.add(paramElement);
    }
    return env;
  }

  private tryToCallTypeWithArguments({
    memberElements,
    argExprs,
    env,
    context,
  }: {
    memberElements: TupleElement[];
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): boolean {
    if (argExprs.length > memberElements.length) {
      return false;
    }

    env = pushEnvFrame(env);
    const checkedMemberElements: Set<TupleElement> = new Set();
    for (let i = 0; i < memberElements.length; i++) {
      let memberElement = memberElements[i];
      let argExpr = argExprs[i];
      if (!argExpr) {
        break;
      }

      // Check if it's a label
      let label: string | undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        const labelExpr = argExpr.args[0];
        argExpr = argExpr.args[1];

        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label, got:\n${exprToString(labelExpr)}`
          );
        }
        label = labelExpr.token.value;
      }

      if (label) {
        // Find the matching label in the expectedType
        const paramElement_ = memberElements.find(
          (element) => element.label === label
        );
        if (!paramElement_) {
          return false;
        } else {
          memberElement = paramElement_;
        }
      }

      if (checkedMemberElements.has(memberElement)) {
        return false; // Already checked this element
        // We cannot have duplicate labels
      }

      // Evaluate the argExpr
      let evaluatedArgExpr: Expr;
      try {
        evaluatedArgExpr = this.evaluateExpression({
          expr: argExpr,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
            expectedType: memberElement.type,
          },
        });
      } catch (error) {
        return false;
      }
      let argType = evaluatedArgExpr.type;
      if (!argType) {
        return false; // If synthesis fails, the types are not compatible
      }
      if (isPlaceholderType(argType)) {
        // Synthesize the type
        try {
          const { type: nextArgType, env: nextEnv } =
            this.synthesizeExprAndType({
              expr: argExpr,
              type: memberElement.type,
              env,
              context,
            });
          env = nextEnv;
          argType = nextArgType;
          evaluatedArgExpr.type = nextArgType; // QUESTION: Will this cause problem?
        } catch (e) {
          return false; // If synthesis fails, the types are not compatible
        }
      }

      // Compare the types
      if (!areTypesCompatible(memberElement.type, argType, env)) {
        return false;
      }
      checkedMemberElements.add(memberElement);
    }

    // Check if any unchecked member elements have no default value
    for (let i = 0; i < memberElements.length; i++) {
      const memberElement = memberElements[i];
      if (!checkedMemberElements.has(memberElement)) {
        if (!memberElement.defaultValue) {
          return false;
        }
      }
    }

    return true;
  }

  private tryToImplementInterfaceWithArguments({
    interfaceType,
    argExprs,
    env,
    context,
  }: {
    interfaceType: InterfaceType;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    if (argExprs.length > interfaceType.members.length) {
      throw this.formatErrorMessage(
        argExprs[interfaceType.members.length - 1].token,
        `Failed to implement the interface. Too many members provided.`
      );
    }

    env = pushEnvFrame(env);
    const checkedInterfaceMembers: Set<InterfaceMember> = new Set();
    for (let i = 0; i < interfaceType.members.length; i++) {
      let interfaceMember = interfaceType.members[i];
      let argExpr = argExprs[i];
      if (!argExpr) {
        `Failed to implement the interface. Too few members provided.`;
      }

      // Check if it's a label
      let label: string | undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        const labelExpr = argExpr.args[0];
        argExpr = argExpr.args[1];

        if (!exprIsAtom(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label, got:\n${exprToString(labelExpr)}`
          );
        }
        label = labelExpr.token.value;
      }

      if (label) {
        // Find the matching label in the expectedType
        const interfaceMember_ = interfaceType.members.find(
          (element) => element.label === label
        );
        if (!interfaceMember_) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Failed to find "${label}" in the interface.`
          );
        } else {
          interfaceMember = interfaceMember_;
        }
      } else {
        this.formatErrorMessage(
          argExpr.token,
          `Expected member label, but got:\n${exprToString(argExpr)}`
        );
      }

      if (checkedInterfaceMembers.has(interfaceMember)) {
        // Already checked this element
        // We cannot have duplicate labels
        throw this.formatErrorMessage(
          argExpr.token,
          `Interface member "${label}" is already implemented.`
        );
      }

      // Evaluate the argExpr
      let evaluatedArgExpr: Expr;
      try {
        evaluatedArgExpr = this.evaluateExpression({
          expr: argExpr,
          env,
          context: {
            ...context,
            isEvaluatingExprAsType: false,
            expectedType: interfaceMember.type,
          },
        });
      } catch (error) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate the interface member "${label}"`
        );
      }

      const argType = evaluatedArgExpr.type;
      if (!argType) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate the interface member "${label}"`
        );
      }

      // Pass a type to parameter
      // eg: T: Type
      if (
        isTypeHierarchyType(interfaceMember.type) &&
        interfaceMember.type.level === 0
      ) {
        // Check if the type is a subtype of the given type
        // TODO: Check interfaces
        if (!isTypeHierarchyType(argType) || argType.level !== 0) {
          throw this.formatErrorMessage(
            argExpr.token,
            `Failed to evaluate the interface member "${label}"`
          );
        }

        const argValue = evaluatedArgExpr.value;

        // Add the arg to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: interfaceMember.label,
            type: argType,
            isMutable: false,
            isCompileTimeOnly: true,
            token: argExpr.token,
            isNotInitialized: false,
            value: argValue,
          },
        });
        env = nextEnv;
      }

      // Compare the types
      else if (!areTypesCompatible(interfaceMember.type, argType, env)) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Failed to evaluate the interface member "${label}"`
        );
      }

      // Set the interface member value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interfaceMember.value = evaluatedArgExpr.value as any; // FIXME: Update the check

      // Add the type information to argExpr
      argExpr.type = argType;
      argExpr.value = evaluatedArgExpr.value;

      checkedInterfaceMembers.add(interfaceMember);
    }

    // Set the interface as implemented
    interfaceType.isImplemented = true;

    return popEnvFrame(env);
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
      functionType: functionType,
      argExprs: argExprs,
      env,
      context,
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
            return areValuesEqual(argValue, argValues[index], env);
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
      (isStructType(returnType) || isInterfaceType(returnType)) &&
      !returnType.typeName &&
      functionValue.funcName
    ) {
      returnType.typeName =
        functionValue.funcName +
        `(${argValues.map((v) => valueToString(v)).join(", ")})`;
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
    functionType,
    argExprs,
    env,
    context,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { returnType: Type; env: Environment } {
    // This will push a new frame to the env and
    // add the parameters to the env
    const nextEnv = this.tryToCallFunctionWithArguments({
      functionType: functionType,
      argExprs,
      env,
      context,
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

  private evaluateDefExpression({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "def", 2)) {
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
    const functionNameAndParametersExpr = functionDefinitionExpr.args[0];
    let functionReturnTypeExpr = functionDefinitionExpr.args[1];
    if (!exprIsFunctionCall(functionNameAndParametersExpr)) {
      throw this.formatErrorMessage(
        functionNameAndParametersExpr.token,
        `Expected function name and parameters like "add(x: i32, y: i32)", got:\n${exprToString(
          functionNameAndParametersExpr
        )}`
      );
    }
    const functionNameExpr = functionNameAndParametersExpr.func;
    const functionParameterExprList = functionNameAndParametersExpr.args;

    if (
      !exprIsAtom(functionNameExpr) ||
      !this.isValidVariableName(functionNameExpr)
    ) {
      throw this.formatErrorMessage(
        functionNameExpr.token,
        `Expected identifier for function name, got:\n${exprToString(
          functionNameExpr
        )}`
      );
    }

    // Parse the function parameters
    const { parameters, env: nextEnv } = this.evaluateFunctionParameters({
      parameterExprs: functionParameterExprList,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    env = nextEnv;

    // Parse the function return type
    /// Check if it's compile time only
    let isReturnTypeCompileTimeOnly = false;
    if (
      exprIsFunctionCall(functionReturnTypeExpr) &&
      exprIsFunctionCallOf(functionReturnTypeExpr, ["compt", "@"], 1)
    ) {
      isReturnTypeCompileTimeOnly = true;
      functionReturnTypeExpr = functionReturnTypeExpr.args[0];
    }

    const evaluatedReturnTypeExpr = this.evaluateExpression({
      expr: functionReturnTypeExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    const returnTypeValue = evaluatedReturnTypeExpr.value;
    if (!isTypeValue(returnTypeValue)) {
      throw this.formatErrorMessage(
        functionReturnTypeExpr.token,
        `Expected type for function return type, got:\n${exprToString(
          functionReturnTypeExpr
        )}`
      );
    }
    const returnType = returnTypeValue.value;

    if (isTypeHierarchyType(returnType) && !isReturnTypeCompileTimeOnly) {
      throw this.formatErrorMessage(
        functionReturnTypeExpr.token,
        `Expected a "compt" (or "@") for return type, like:\n
compt(${exprToString(functionReturnTypeExpr)})`
      );
    }

    /// Add functionType to the functionNameExpr
    const functionType = createFunctionType({
      params: parameters,
      return_: {
        type: returnType,
        expr: functionReturnTypeExpr,
        isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      },
      env: popEnvFrame(env),
    });
    functionNameExpr.type = functionType;
    /// Add function with name to env;
    const { env: nextNextEnv } = addVariableToEnv({
      env,
      variable: {
        name: functionNameExpr.token.value,
        token: functionNameExpr.token,
        type: functionType,
        isMutable: false,
        isNotInitialized: false,
        value: {
          tag: ValueTag.Function,
          type: functionType,
          body: functionBodyExpr,
          frameLevel: env.frames.length - 1,
          funcName: functionNameExpr.token.value,
          funcId: `fn_${randomId()}`,
          calledTypeFunctionCaches: [],
        },
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;

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
      if (!areTypesCompatible(returnType, evaluatedFunctionBody.type, env)) {
        throw this.formatErrorMessage(
          functionReturnTypeExpr.token,
          `Incompatible function return type:
- Expected: ${typeToString(returnType)}
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
    if (!exprIsFunctionCallOf(expr, "begin")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "begin", got:\n${exprToString(expr)}`
      );
    }
    const exprs = expr.args;

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

  /**
   * NOTE: Calling this function will increase the env frame.
   */
  private evaluateInterfaceMembers({
    memberExprs,
    env,
    context,
  }: {
    memberExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { members: InterfaceMember[]; env: Environment } {
    env = pushEnvFrame(env);
    const members: InterfaceMember[] = [];
    for (let i = 0; i < memberExprs.length; i++) {
      const memberExpr = memberExprs[i];
      if (
        !exprIsFunctionCall(memberExpr) ||
        !exprIsFunctionCallOf(memberExpr, ":", 2)
      ) {
        throw this.formatErrorMessage(
          memberExpr.token,
          `Expected ":", got:\n${exprToString(memberExpr)}`
        );
      }
      const lhsExpr = memberExpr.args[0];
      const rhsExpr = memberExpr.args[1];

      // Get the label of member
      if (
        !exprIsAtom(lhsExpr) ||
        !(
          (
            lhsExpr.token.type === TokenType.Identifier ||
            lhsExpr.token.type === TokenType.Operator
          ) // We allow to define operator as interface member
        )
      ) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for interface member name, got:\n${exprToString(
            lhsExpr
          )}`
        );
      }
      const label = lhsExpr.token.value;

      // Evaluate the member type
      const evaluatedMemberTypeExpr = this.evaluateExpression({
        expr: rhsExpr,
        env,
        context: { ...context, isEvaluatingExprAsType: true },
      });
      if (evaluatedMemberTypeExpr.env) {
        env = evaluatedMemberTypeExpr.env;
      }
      // Expect the member type to be a type
      const typeValue = evaluatedMemberTypeExpr.value;
      if (!isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `Expected type for interface member, got:\n${exprToString(rhsExpr)}`
        );
      }
      // We only accept hierarchy type or function type.
      const memberType = typeValue.value;
      if (!isTypeHierarchyType(memberType) && !isFunctionType(memberType)) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `Expected either Type (Free, Linear) or FunctionType for interface member, got:\n${exprToString(
            rhsExpr
          )}`
        );
      }
      // Check if the label already exists
      if (members.find((m) => m.label === label)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Duplicate label "${label}" in interface member`
        );
      }
      // Add the member to the members list
      members.push({
        label,
        type: memberType,
        value: undefined,
      });

      // Add type info the lhsExpr;
      lhsExpr.type = memberType;

      // Add the member to the env
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: label,
          token: lhsExpr.token,
          type: memberType,
          isMutable: false,
          isNotInitialized: false,
          value: undefined,
        },
      });
      env = nextEnv;
    }
    return {
      members,
      env,
    };
  }

  private evaluateInterface({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "interface")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "interface", got:\n${exprToString(expr)}`
      );
    }

    const interfaceMemberExprs = expr.args;
    // Evaluate the interface members
    const { members, env: nextEnv } = this.evaluateInterfaceMembers({
      memberExprs: interfaceMemberExprs,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    env = nextEnv;

    // Create the interface type
    const interfaceType = createInterfaceType(members);

    // Pop the environment frame
    env = popEnvFrame(env);

    // Set the interface type and value
    expr.type = typeOfType(interfaceType);
    expr.value = createTypeValue(interfaceType);
    expr.env = env;
    return expr;
  }

  private evaluateImplTypeMethods({
    type,
    argExprs,
    env,
    context,
  }: {
    type: Type;
    argExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    for (let i = 0; i < argExprs.length; i++) {
      const argExpr = argExprs[i];
      if (
        !exprIsFunctionCall(argExpr) ||
        !exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        throw this.formatErrorMessage(
          argExpr.token,
          `Expected ":", got:\n${exprToString(argExpr)}`
        );
      }
      const lhsExpr = argExpr.args[0];
      const rhsExpr = argExpr.args[1];

      // Get the label of member
      if (
        !exprIsAtom(lhsExpr) ||
        !(
          (
            lhsExpr.token.type === TokenType.Identifier ||
            lhsExpr.token.type === TokenType.Operator
          ) // We allow to define operator as interface member
        )
      ) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for type method name, got:\n${exprToString(
            lhsExpr
          )}`
        );
      }
      const label = lhsExpr.token.value;

      // Evaluate the member type
      const evaluatedMemberValueExpr = this.evaluateExpression({
        expr: rhsExpr,
        env,
        context: { ...context, isEvaluatingExprAsType: false },
      });
      if (evaluatedMemberValueExpr.env) {
        env = evaluatedMemberValueExpr.env;
      }

      const functionType = evaluatedMemberValueExpr.type;
      const functionValue = evaluatedMemberValueExpr.value;
      if (!isFunctionType(functionType) || !isFunctionValue(functionValue)) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `Expected function for type method, got:\n${exprToString(rhsExpr)}`
        );
      }

      const existingMethods = type.methods ?? [];
      // Check if the method already exists
      if (existingMethods.find((m) => m.label === label)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Duplicate label "${label}" in type method`
        );
      }
      if (isStructType(type)) {
        // Check if the method name conflicts with the struct members
        if (type.members.find((m) => m.label === label)) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Duplicate label "${label}" in struct member`
          );
        }
      } else if (isTupleType(type)) {
        // Check if the method name conflicts with the tuple elements
        if (type.elements.find((m) => m.label === label)) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Duplicate label "${label}" in tuple elements`
          );
        }
      } else if (isEnumType(type)) {
        // Check if the method name conflicts with the enum variants
        if (type.variants.find((m) => m.name === label)) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Enum variant already has the name "${label}"`
          );
        }
      }

      // Add the method to the type
      type.methods = existingMethods.concat({
        label,
        type: functionType,
        value: functionValue,
      });
      // Add type info the lhsExpr;
      lhsExpr.type = functionType;
      lhsExpr.value = functionValue;
    }
    return env;
  }

  private evaluateImpl({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "impl")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "impl", got:\n${exprToString(expr)}`
      );
    }
    if (env.frames.length !== 1) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "impl" to be called in the top level.`
      );
    }

    const typeExpr = expr.args[0];
    const implMemberExprs = expr.args.slice(1);

    if (!typeExpr) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected interface to implement, got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the typeExpr
    const evaluatedTypeExpr = this.evaluateExpression({
      expr: typeExpr,
      env,
      context: { ...context, isEvaluatingExprAsType: true },
    });
    if (evaluatedTypeExpr.env) {
      env = evaluatedTypeExpr.env;
    }

    const typeValue = evaluatedTypeExpr.value;
    if (!isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        typeExpr.token,
        `Expected type (or interface), got:\n${exprToString(typeExpr)}`
      );
    }

    // Implement the interface
    if (isInterfaceType(typeValue.value)) {
      const interfaceType = typeValue.value;
      if (interfaceType.isImplemented) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Interface is already implemented, got:\n${exprToString(typeExpr)}`
        );
      }

      // Evaluate the interface members
      // This should like a function call
      const nextEnv = this.tryToImplementInterfaceWithArguments({
        interfaceType: interfaceType,
        argExprs: implMemberExprs,
        env,
        context: { ...context },
      });
      env = nextEnv;

      expr.env = env;
      expr.value = VUnit;
      expr.type = VUnit.type;
      return expr;
    }
    // Implement the type (struct/enum/etc)
    else {
      const type = typeValue.value;

      // We disallow to implement the methods for function type for now
      if (isFunctionType(type)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Cannot implement methods for function type, got:\n${exprToString(
            typeExpr
          )}`
        );
      }

      // Evaluate the type methods
      const nextEnv = this.evaluateImplTypeMethods({
        type,
        argExprs: implMemberExprs,
        env,
        context: { ...context },
      });
      env = nextEnv;

      expr.env = env;
      expr.value = VUnit;
      expr.type = VUnit.type;
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
        case TokenType.Identifier: {
          return this.evaluateIdentifier({
            expr,
            env,
            context,
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
          // (fn(x: i32) -> x)
          (exprIsFunctionCall(expr.args[0]) &&
            exprIsFunctionCallOf(expr.args[0], "fn")) ||
          // ((fn(x:i32):i32)-> x)
          (exprIsFunctionCall(expr.args[0]) &&
            exprIsFunctionCallOf(expr.args[0], ":", 2) &&
            exprIsFunctionCall(expr.args[0].args[0]) &&
            exprIsFunctionCallOf(expr.args[0].args[0], "fn"))
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
      } else if (exprIsFunctionCallOf(expr, "recur")) {
        // recur
        return this.evaluateRecur({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "extern")) {
        // extern
        return this.evaluateExtern({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "cond")) {
        // cond
        return this.evaluateCond({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "match")) {
        // match
        return this.evaluateMatch({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
        // tuple
        return this.evaluateTuple({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "type")) {
        // type Expr
        return this.evaluateTypeExpression({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "struct")) {
        // struct
        return this.evaluateStruct({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "enum")) {
        // enum
        return this.evaluateEnum({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, ".")) {
        // property access
        return this.evaluatePropertyAccess({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "def")) {
        // def
        return this.evaluateDefExpression({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "begin")) {
        // begin
        return this.evaluateBeginExpression({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "interface")) {
        // interface
        return this.evaluateInterface({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "impl")) {
        // impl
        return this.evaluateImpl({ expr, env, context });
      } else {
        /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      } */
        // Function call
        return this.evaluateFunctionCall({ expr, env, context });
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
