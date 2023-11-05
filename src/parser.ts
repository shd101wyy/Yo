/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AssignmentExpr,
  AstType,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  PrimitiveValueExpr,
  getFunctionArgumentsInOrder,
  getFunctionFromEnv,
  getTokenPrecedence,
  synthesizeExprType,
  synthesizeRecordType,
} from "./ast";
import Environment from "./env";
import { formatErrorMessage } from "./error";
import { Token, TokenType } from "./token";
import {
  ParserReturn,
  TFunction,
  TSlice,
  Type,
  TypeValues,
  checkType,
  synthesizeFunctionTypeFromTokens,
  synthesizeTypeFromTokens,
  typeToString,
} from "./type-checker";

export default class Parser {
  private inputString: string;

  constructor(inputString: string) {
    this.inputString = inputString;
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
      inputString: this.inputString,
    });
  }

  private parseNumberExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Integer) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: {
            type: "i32",
            value: token.value,
            tag: "primitive",
          },
        },
        index: index + 1,
        env,
      };
    } else if (token.type === TokenType.Float) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "f32", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected number");
    }
  }

  private parseCharactorExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Char) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "char", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected charactor");
    }
  }

  private parseStringExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.String) {
      const end: PrimitiveValueExpr = {
        type: AstType.Value,
        tag: "primitive",
        typeValue: { type: "char", value: "\0", tag: "primitive" },
      };
      return {
        expr: {
          type: AstType.Value,
          tag: "slice",
          typeValue: {
            type: "slice",
            elementType: TypeValues.char,
            size: token.value.length + 1,
          },
          values: token.value
            .split("")
            .map((char) => {
              const charValue: PrimitiveValueExpr = {
                type: AstType.Value,
                tag: "primitive",
                typeValue: { type: "char", value: char, tag: "primitive" },
              };
              return charValue;
            })
            .concat(end),
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseSymbolExpr(tokens, index, env): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Symbol) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "symbol", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected symbol");
    }
  }

  private parseBooleanExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Boolean) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "boolean", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected boolean");
    }
  }

  private parseSliceExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type !== TokenType.LBracket) {
      throw this.formatErrorMessage(token, "Expected '[' for slice");
    }
    index = index + 1;
    const values: Expr[] = [];
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']' for slice");
      }
      if (token.type === TokenType.RBracket) {
        index = index + 1;
        break;
      } else {
        const { expr, index: nextIndex } = this.parseExpression(
          tokens,
          index,
          env
        );
        if (!expr) {
          return { expr, index: nextIndex, env };
        }
        values.push(expr);
        index = nextIndex;
        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
    }

    const elementTypes = values.map((value) => synthesizeExprType(value, env));
    // Check if all the element types are the same
    const firstElementType = elementTypes[0];
    if (!elementTypes.every((type) => checkType(firstElementType, type))) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched element types in slice: ${elementTypes
          .map((type) => typeToString(type))
          .join(", ")}`
      );
    }

    return {
      expr: {
        type: AstType.Value,
        typeValue: {
          type: "slice",
          elementType: firstElementType,
          size: values.length,
        },
        values: values,
        tag: "slice",
      },
      index,
      env,
    };
  }

  // TODO: Implement curly bracket expression
  // it could be either the RecordExpr or BlockExpr
  private parseCurlyBracketExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    return this.parseRecordExpr(tokens, index, env);
  }

  private parseRecordExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket || !tokens[index + 1]) {
      throw this.formatErrorMessage(tokens[index], "Expected '{' for record");
    }
    index = index + 1;
    if (tokens[index].type === TokenType.RCurlyBracket) {
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: { type: "Record", properties: [] },
          properties: [],
        },
        index: index + 1,
        env,
      };
    } else if (
      tokens[index].type === TokenType.Identifier &&
      tokens[index + 1].type === TokenType.Colon
    ) {
      const properties: { name: string; value: Expr }[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const token = tokens[index];
        if (!token) {
          throw this.formatErrorMessage(token, "Expected '}' for record");
        }
        if (token.type === TokenType.RCurlyBracket) {
          index = index + 1;
          break;
        }
        if (token.type !== TokenType.Identifier) {
          throw this.formatErrorMessage(
            token,
            "Expected identifier for record property name"
          );
        }
        const propertyName = token.value;
        if (tokens[index + 1].type !== TokenType.Colon) {
          throw this.formatErrorMessage(
            tokens[index + 1],
            "Expected ':' for record property"
          );
        }
        index = index + 2;
        const { expr, index: nextIndex } = this.parseExpression(
          tokens,
          index,
          env
        );
        if (!expr) {
          return { expr, index: nextIndex, env };
        }
        properties.push({ name: propertyName, value: expr });
        index = nextIndex;

        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: synthesizeRecordType(properties, env),
          properties,
        },
        index,
        env,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
    }
  }

  private parsePropertyAccessExpr(
    expr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Dot) {
      throw this.formatErrorMessage(tokens[index], "Expected '.'");
    }
    const properties: string[] = [];
    // parse properties
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected identifier");
      }
      if (token.type !== TokenType.Identifier) {
        throw this.formatErrorMessage(token, "Expected identifier");
      }
      properties.push(token.value);
      index = index + 1;

      if (tokens[index].type === TokenType.Dot) {
        index = index + 1;
      } else {
        break;
      }
    }

    // Check if the properties are valid
    const valueType = synthesizeExprType(expr, env);
    let currentType = valueType;
    for (const accessor of properties) {
      if (currentType.type !== "Record") {
        throw this.formatErrorMessage(
          tokens[index],
          `Invalid access to \`.${properties.join(".")}\``
        );
      }
      const property = currentType.properties.find(
        (property) => property.name === accessor
      );
      if (!property) {
        throw this.formatErrorMessage(
          tokens[index],
          `Invalid access to \`.${properties.join(".")}\``
        );
      }
      currentType = property.type;
    }

    return {
      expr: {
        type: AstType.PropertyAccess,
        properties: properties,
        expr,
        typeValue: currentType,
      },
      index,
      env,
    };
  }

  private parseIndexAccessExpr(
    expr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LBracket) {
      throw this.formatErrorMessage(tokens[index], "Expected '['");
    }
    const indexes: Expr[] = [];
    let valueType = synthesizeExprType(expr, env);
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
      const { expr, index: nextIndex } = this.parseExpression(
        tokens,
        index,
        env
      );
      if (!expr) {
        throw this.formatErrorMessage(token, "Expected expression");
      }
      indexes.push(expr);
      index = nextIndex;

      const indexType = synthesizeExprType(expr, env);
      if (!checkType(TypeValues.i32, indexType)) {
        throw this.formatErrorMessage(
          token,
          `Expected i32 for index, but got ${typeToString(indexType)}`
        );
      }

      if (valueType.type !== "slice") {
        throw this.formatErrorMessage(
          token,
          `Expected slice for index access, but got ${typeToString(valueType)}`
        );
      }
      valueType = valueType.elementType;

      if (tokens[index].type === TokenType.RBracket) {
        index = index + 1;
        if (tokens[index].type === TokenType.LBracket) {
          index = index + 1;
        } else {
          break;
        }
      } else {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
    }

    return {
      expr: {
        type: AstType.IndexAccess,
        expr,
        indexes,
        typeValue: valueType,
      },
      index,
      env,
    };
  }

  private parseAnonymouseFunction(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected left paren for anonymous function"
      );
    }

    // parse prototype
    env.pushFrame();
    try {
      const {
        prototype,
        index: nextIndex,
        env: newVariableTypes,
      } = this.parsePrototype({
        tokens,
        index,
        env,
        requireFunctionName: false,
        withFunctionBody: true,
      });
      if (!prototype) {
        throw new Error("Failed to parse prototype");
      }

      // check if current token is `=>`
      if (tokens[nextIndex].type !== TokenType.LambdaArrow) {
        throw new Error("Expected `=>` for anonymous function");
      }

      // parse body
      const { exprs: body, index: nextNextIndex } = this.parseBlockExpressions(
        tokens,
        nextIndex + 1,
        newVariableTypes
      );

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        typeValue: prototype.typeValue,
        body,
      };
      env.popFrame();
      return { expr: functionExpr, index: nextNextIndex, env };
    } catch (error) {
      env.popFrame();
      throw error;
    }
  }

  /**
   * parenexpr ::= "(" expr ")"
   * @param tokens
   * @param index
   * @returns
   */
  private parseParenExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (tokens[index + 1]?.type === TokenType.RParen) {
      // unit type
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "()", value: "()", tag: "primitive" },
        },
        index: index + 2,
        env,
      };
    }

    // Try parse as anonymouse function
    try {
      const { expr, index: nextIndex } = this.parseAnonymouseFunction(
        tokens,
        index,
        env
      );
      if (expr) {
        return { expr, index: nextIndex, env };
      } else {
        throw new Error("Failed to parse as anonymouse function");
      }
    } catch (error) {
      // Ignore the error
      // This means we failed to parse it as anonymouse function
    }

    const { expr, index: nextIndex } = this.parseExpression(
      tokens,
      index + 1,
      env
    );
    if (!expr) {
      return { expr, index: nextIndex, env };
    }

    if (tokens[nextIndex].type !== TokenType.RParen) {
      throw this.formatErrorMessage(tokens[nextIndex], "Expected right paren");
    }
    return { expr, index: nextIndex + 1, env };
  }

  /**
   * identifierexpr
   *   ::= identifier
   *   ::= identifier "(" expression* ")"
   * @param tokens
   * @param index
   */
  private parseIdentifierExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const identifier = tokens[index].value;

    if (tokens[index + 1].type !== TokenType.LParen) {
      // Check if variable is defined
      const valueTypes = env.getValueTypesByVariableName(identifier);
      if (valueTypes.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Unbounded variable \`${identifier}\``
        );
      }
      const typeValue = valueTypes[valueTypes.length - 1].type;
      return {
        expr: {
          type: AstType.Variable,
          name: identifier,
          typeValue,
        },
        index: index + 1,
        env,
      };
    } else {
      // FIXME: Accessors check here is needed
      // call
      const functionName: string = identifier;
      const functionArguments: Expr = [];
      let nextIndex = index + 3;
      if (tokens[index + 2].type !== TokenType.RParen) {
        index = index + 2;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Check if it's keyword argument
          if (
            tokens[index].type === TokenType.Identifier &&
            tokens[index + 1].type === TokenType.Assign
          ) {
            const variableName = tokens[index].value;
            const { expr: defaultParameterValueExpr, index: nextIndex } =
              this.parseExpression(tokens, index + 2, env);

            if (!defaultParameterValueExpr) {
              throw this.formatErrorMessage(
                tokens[index],
                "Expected expression for default parameter value"
              );
            }

            const parameterAssignmentExpr: AssignmentExpr = {
              type: AstType.ConstantAssigment,
              variableName: variableName,
              right: defaultParameterValueExpr,
              typeValue: TypeValues.unit,
              variableType: synthesizeExprType(defaultParameterValueExpr, env),
            };
            functionArguments.push(parameterAssignmentExpr);
            index = nextIndex;
          } else {
            const { expr, index: nextIndex } = this.parseExpression(
              tokens,
              index,
              env
            );

            if (!expr) {
              throw this.formatErrorMessage(
                tokens[index],
                "Expected expression for function argument"
              );
            }
            functionArguments.push(expr);
            index = nextIndex;
          }

          if (tokens[index].type === TokenType.RParen) {
            break;
          }

          if (tokens[index].type !== TokenType.Comma) {
            throw this.formatErrorMessage(
              tokens[index],
              `Expected comma, but got ${tokens[index].value}`
            );
          }
          index = index + 1;
        }

        nextIndex = index + 1;
      }

      const functionBeingCalled = getFunctionFromEnv(
        functionName,
        functionArguments,
        env
      );
      const functionType = functionBeingCalled.type as TFunction;
      const functionArgumentsInOrder = getFunctionArgumentsInOrder(
        functionArguments,
        functionType
      );

      if (!functionArgumentsInOrder) {
        throw this.formatErrorMessage(
          tokens[index],
          `Mismatched function arguments`
        );
      }

      return {
        expr: {
          type: AstType.CallFunction,
          functionId: functionBeingCalled.id,
          functionName,
          functionArguments: functionArgumentsInOrder,
          typeValue: functionType.returnType,
        },
        index: nextIndex,
        env,
      };
    }
  }

  /**
   * primary
   *   ::= identifierexpr
   *   ::= numberexpr
   *   ::= parenexpr
   *   ::= ifexpr
   * @param tokens
   * @param index
   */
  private parsePrimary(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    let returnValue: ParserReturn | null = null;
    switch (token.type) {
      case TokenType.Identifier: {
        returnValue = this.parseIdentifierExpr(tokens, index, env);
        break;
      }
      case TokenType.Integer:
      case TokenType.Float: {
        returnValue = this.parseNumberExpr(tokens, index, env);
        break;
      }
      case TokenType.Char: {
        returnValue = this.parseCharactorExpr(tokens, index, env);
        break;
      }
      case TokenType.String: {
        returnValue = this.parseStringExpr(tokens, index, env);
        break;
      }
      case TokenType.Symbol: {
        returnValue = this.parseSymbolExpr(tokens, index, env);
        break;
      }
      case TokenType.Boolean: {
        returnValue = this.parseBooleanExpr(tokens, index, env);
        break;
      }
      case TokenType.LBracket: {
        returnValue = this.parseSliceExpr(tokens, index, env);
        break;
      }
      case TokenType.LParen: {
        returnValue = this.parseParenExpr(tokens, index, env);
        break;
      }
      case TokenType.LCurlyBracket: {
        returnValue = this.parseCurlyBracketExpr(tokens, index, env);
        break;
      }
      case TokenType.If: {
        returnValue = this.parseIfExpr(tokens, index, env);
        break;
      }
      case TokenType.Const: {
        return this.parseConstAssignment(tokens, index, env);
      }
      case TokenType.Semicolon: {
        return {
          expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
          index: index + 1,
          env,
        };
      }
      default: {
        throw this.formatErrorMessage(
          token,
          `Unknown token: ${JSON.stringify(token)}`
        );
      }
    }

    {
      while (true) {
        if (
          tokens[returnValue.index].type === TokenType.Dot &&
          returnValue.expr
        ) {
          // parsePropertyAccessExpr
          returnValue = this.parsePropertyAccessExpr(
            returnValue.expr,
            tokens,
            returnValue.index,
            returnValue.env
          );
        } else if (
          tokens[returnValue.index].type === TokenType.LBracket &&
          returnValue.expr
        ) {
          // parseIndexAccessExpr
          returnValue = this.parseIndexAccessExpr(
            returnValue.expr,
            tokens,
            returnValue.index,
            returnValue.env
          );
        } else {
          break;
        }
      }
      return returnValue;
    }
  }

  private parseBinOpRHS(
    tokens: Token[],
    exprPrecedence: number,
    LHS: Expr,
    index: number,
    env: Environment
  ): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];
      const tokenPrecedence = getTokenPrecedence(token);

      // If this is a binop that binds at least as tightly as the current binop,
      // consume it, otherwise we are done.
      if (tokenPrecedence < exprPrecedence) {
        return { expr: LHS, index, env };
      }

      // Okay, we know this is a binop
      const binaryOperator = token;
      index = index + 1; // eat binop

      // eslint-disable-next-line prefer-const
      let { expr: RHS, index: nextIndex } = this.parsePrimary(
        tokens,
        index,
        env
      );
      if (!RHS) {
        return { expr: RHS, index: nextIndex, env };
      }

      // If BinOp binds less tightly with RHS than the operator after RHS, let
      // the pending operator take RHS as its LHS.
      const nextToken = tokens[nextIndex];
      const nextTokenPrecedence = getTokenPrecedence(nextToken);
      if (tokenPrecedence < nextTokenPrecedence) {
        const { expr, index: nextNextIndex } = this.parseBinOpRHS(
          tokens,
          tokenPrecedence + 1,
          RHS,
          nextIndex,
          env
        );
        if (!expr) {
          return { expr, index: nextNextIndex, env };
        }
        RHS = expr;
        index = nextNextIndex;
      } else {
        index = nextIndex;
      }

      // Merge LHS/RHS
      const needsSwap = [
        TokenType.GreaterThan,
        TokenType.GreaterThanOrEqual,
      ].includes(binaryOperator.value as TokenType);
      let operator = binaryOperator.value as TokenType;
      if (needsSwap) {
        if (operator === TokenType.GreaterThan) {
          operator = TokenType.LessThan;
        } else if (operator === TokenType.GreaterThanOrEqual) {
          operator = TokenType.LessThanOrEqual;
        }
      }
      LHS = {
        type: AstType.BinaryOperator,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        operator: operator as any,
        left: needsSwap ? RHS : LHS,
        right: needsSwap ? LHS : RHS,
        typeValue: synthesizeExprType(LHS, env), // FIXME:
      };
    }
  }

  private parsePrototype({
    tokens,
    index,
    env,
    requireFunctionName,
    withFunctionBody,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    requireFunctionName: boolean;
    withFunctionBody: boolean;
  }): {
    prototype: FunctionPrototype | null;
    index: number;
    env: Environment;
  } {
    let functionName: string | undefined = undefined;
    if (requireFunctionName) {
      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function name in prototype"
        );
      } else {
        functionName = tokens[index].value;
        index = index + 1;
      }
    }

    const { index: nextEnd, typeValue: functionType } =
      synthesizeFunctionTypeFromTokens({
        tokens,
        index,
        inputString: this.inputString,
        env,
        parseExpression: this.parseExpression.bind(this),
        withFunctionBody,
      });

    return {
      prototype: {
        type: AstType.FunctionPrototype,
        functionId: env.getId(functionName ?? "lambda"),
        functionName,
        typeValue: functionType,
      },
      index: nextEnd,
      env,
    };
  }

  private parseBlockExpressions(
    tokens: Token[],
    index: number,
    env: Environment
  ): { exprs: Expr[]; index: number; env: Environment; returnType: Type } {
    const exprs: Expr[] = [];
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for block expressions"
      );
    }
    index = index + 1;
    env.pushFrame();
    let newEnv = env;

    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected '}' for function body");
      }
      if (token.type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      const {
        expr,
        index: nextIndex,
        env: newEnv2,
      } = this.parseExpression(tokens, index, newEnv);
      newEnv = newEnv2;
      if (expr) {
        exprs.push(expr);
      }
      index = nextIndex;
    }

    const lastExpr: Expr | null = exprs[exprs.length - 1] ?? null;
    if (!lastExpr || tokens[index - 2].type === TokenType.Semicolon) {
      exprs.push({
        type: AstType.Value,
        tag: "primitive",
        typeValue: { type: "()", value: "()", tag: "primitive" },
      });
    }

    // NOTE: Needs to put this before `env.popFrame` to get `returnType`.
    const returnValue = {
      index,
      exprs,
      env: newEnv,
      returnType: synthesizeExprType(exprs[exprs.length - 1], newEnv),
    };
    env.popFrame();
    return returnValue;
  }

  private parseFunction(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Function) {
      throw this.formatErrorMessage(tokens[index], "Expected function");
    }

    index = index + 1;
    env.pushFrame();
    const {
      prototype,
      index: nextIndex,
      env: newVariableTypes,
    } = this.parsePrototype({
      tokens,
      index,
      env,
      requireFunctionName: true,
      withFunctionBody: true,
    });
    if (!prototype) {
      env.popFrame();
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextIndex,
        env,
      };
    } else {
      index = nextIndex;
      env.addValueType(
        {
          id: prototype.functionId,
          variableName: prototype.functionName!,
          type: prototype.typeValue,
        },
        -1
      );
    }

    // Check function body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for function body"
      );
    } else {
      const {
        exprs,
        index: nextIndex,
        returnType: functionReturnType,
      } = this.parseBlockExpressions(tokens, index, newVariableTypes);

      // Check function body return type matches
      // prototype.returnType
      if (prototype.typeValue.returnType.type === "unknown") {
        prototype.typeValue.returnType = functionReturnType;
      }

      if (!checkType(functionReturnType, prototype.typeValue.returnType)) {
        throw this.formatErrorMessage(
          tokens[index],
          `Mismatched return type: 
Prototype: ${typeToString(prototype.typeValue.returnType)}
Returned:  ${typeToString(functionReturnType)}`
        );
      }

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        typeValue: prototype.typeValue,
        body: exprs,
      };
      env.popFrame();
      return { expr: functionExpr, index: nextIndex, env };
    }
  }

  private parseExtern(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Extern) {
      throw this.formatErrorMessage(tokens[index], "Expected extern");
    }

    index = index + 1;
    env.pushFrame();
    const { prototype, index: nextIndex } = this.parsePrototype({
      tokens,
      index,
      env,
      requireFunctionName: true,
      withFunctionBody: true, // NOTE: We need to set it to `true` even though `extern` function has no function body
    });
    env.popFrame();
    if (!prototype) {
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextIndex,
        env,
      };
    } else {
      index = nextIndex;
      env.addValueType({
        id: prototype.functionId,
        variableName: prototype.functionName!,
        type: prototype.typeValue,
      });
    }

    return {
      expr: {
        type: AstType.Extern,
        prototype,
        typeValue: prototype.typeValue,
      },
      index,
      env,
    };
  }

  private parseIfExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    index = index + 1;

    // parse condition
    const { expr: condition, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env
    );
    if (!condition) {
      throw this.formatErrorMessage(tokens[index], "Expected condition for if");
    }
    const conditionType = synthesizeExprType(condition, env);
    if (!checkType(TypeValues.boolean, conditionType)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Expected boolean for condition, but got ${typeToString(conditionType)}`
      );
    }
    index = nextIndex;

    console.log("- here2: ", JSON.stringify(env));

    // parse then
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for 'if' body"
      );
    }
    const {
      exprs: then,
      index: nextNextIndex,
      returnType: thenReturnType,
    } = this.parseBlockExpressions(tokens, index, env);
    index = nextNextIndex;

    console.log("- here3:", JSON.stringify(env));
    console.log(
      "then returnValue: ",
      JSON.stringify(then),
      typeToString(thenReturnType)
    );

    // parse else
    const elseExpr: Expr[] = [];
    let elseReturnType: Type = TypeValues.unit;
    if (tokens[index].type === TokenType.Else) {
      index = index + 1;

      if (tokens[index].type === TokenType.If) {
        const { expr, index: nextNextNextIndex } = this.parseIfExpr(
          tokens,
          index,
          env
        );
        if (!expr || Array.isArray(expr) || expr.type !== AstType.If) {
          throw "WTF";
        }
        elseExpr.push(expr);
        elseReturnType = expr.typeValue;
        index = nextNextNextIndex;
      } else {
        if (tokens[index].type !== TokenType.LCurlyBracket) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '{' for 'else' body"
          );
        }
        const {
          exprs,
          index: nextNextNextIndex,
          returnType,
        } = this.parseBlockExpressions(tokens, index, env);
        if (exprs) {
          elseExpr.push(...exprs);
        }
        elseReturnType = returnType;
        index = nextNextNextIndex;
      }
    }

    if (!checkType(thenReturnType, elseReturnType)) {
      throw new Error(
        `Mismatched types between \`then\` and \`else\`.
then: ${typeToString(thenReturnType)}
else: ${typeToString(elseReturnType)}  
`
      );
    }

    return {
      expr: {
        type: AstType.If,
        condition,
        then,
        else: elseExpr,
        typeValue: thenReturnType,
      },
      index: index,
      env,
    };
  }

  private parseConstAssignment(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Const) {
      throw this.formatErrorMessage(tokens[index], "Expected const");
    }
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for const assignment"
      );
    }
    const variableName = tokens[index].value;
    index = index + 1;

    const userDefinedVariableTypeTokenIndex = index;
    let userDefinedVariableType: Type | null = null;
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      const { typeValue, index: nextIndex } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString: this.inputString,
        env,
        parseExpression: this.parseExpression.bind(this),
      });
      userDefinedVariableType = typeValue;
      index = nextIndex;
    }

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for const assignment"
      );
    }
    index = index + 1;

    const valueIndex = index;
    const { expr: value, index: nextNextIndex } = this.parseExpression(
      tokens,
      index,
      env
    );
    if (!value) {
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextNextIndex,
        env,
      };
    }
    index = nextNextIndex;

    let variableType: Type;
    try {
      variableType = synthesizeExprType(value, env);
    } catch (error) {
      throw this.formatErrorMessage(tokens[valueIndex], error);
    }

    // Check if type matches
    if (userDefinedVariableType !== null) {
      const typeMatches = checkType(userDefinedVariableType, variableType);
      if (!typeMatches) {
        throw this.formatErrorMessage(
          tokens[userDefinedVariableTypeTokenIndex],
          `Mismatched types:
Expected: ${typeToString(userDefinedVariableType)}
Got:      ${typeToString(variableType)}`
        );
      }

      // QUESTION: I am not sure if this is correct or not
      // narrow Union type if necessary
      /*
      if (userDefinedVariableType.type === "Union") {
        userDefinedVariableType = variableType;
      }
      */

      if (userDefinedVariableType.type === "slice") {
        let userType = userDefinedVariableType;
        let valueType = variableType as TSlice;
        // Assign size to the slice if it's undefined
        while (true) {
          if (userType.size === undefined) {
            userType.size = valueType.size;
          } else if (valueType.size && valueType.size < userType.size) {
            valueType.size = userType.size;
          }

          if (userType.elementType.type === "slice") {
            userType = userType.elementType;
            valueType = valueType.elementType as TSlice;
          } else {
            break;
          }
        }
      }
    }

    // Add variable to env
    env.addValueType({
      variableName,
      type: variableType,
    });

    return {
      expr: {
        type: AstType.ConstantAssigment,
        variableName,
        variableType: userDefinedVariableType ?? variableType,
        right: value,
        typeValue: TypeValues.unit,
      },
      index,
      env,
    };
  }

  private parseTypeAlias(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Type) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "type" for type alias'
      );
    }

    index = index + 1;
    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for type alias"
      );
    }
    const typeName = tokens[index].value;
    index = index + 1;

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for type alias"
      );
    }
    index = index + 1;

    const { index: nextIndex, typeValue } = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString: this.inputString,
      env,
      parseExpression: this.parseExpression.bind(this),
    });
    env.addValueType({
      type: typeValue,
      variableName: typeName,
    });

    return {
      expr: {
        type: AstType.TypeAlias,
        typeName,
        typeValue: typeValue,
      },
      index: nextIndex,
      env,
    };
  }

  /**
   * expression
   *  ::= primary binoprhs
   * @param tokens
   * @param index
   */
  private parseExpression(
    tokens: Token[],
    index = 0,
    env: Environment
  ): ParserReturn {
    const { expr, index: nextIndex } = this.parsePrimary(tokens, index, env);
    if (!expr) {
      return { expr, index: nextIndex, env };
    } else {
      return this.parseBinOpRHS(tokens, 0, expr, nextIndex, env);
    }
  }

  public parse(tokens: Token[], env: Environment = new Environment()): Expr {
    let index = 0;
    const exprs: Expr[] = [];
    while (true) {
      const token = tokens[index];
      if (!token) {
        break;
      }
      // Top level expression
      switch (token.type) {
        case TokenType.Semicolon: {
          // ignore top-level semicolons.
          index = index + 1;
          break;
        }
        case TokenType.Function: {
          const {
            expr,
            index: nextIndex,
            env: newVariableTypes,
          } = this.parseFunction(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = newVariableTypes;
          break;
        }
        case TokenType.Extern: {
          const {
            expr,
            index: nextIndex,
            env: newVariableTypes,
          } = this.parseExtern(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = newVariableTypes;
          break;
        }
        case TokenType.Type: {
          const {
            expr,
            index: nextIndex,
            env: newVariableTypes,
          } = this.parseTypeAlias(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = newVariableTypes;
          break;
        }
        default: {
          /*
          const { expr, index: nextIndex } = this.parseExpression(
            tokens,
            index
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          break;
          */
          throw this.formatErrorMessage(
            tokens[index],
            "Invalid top-level expression"
          );
        }
      }
    }
    return exprs.filter(
      (expr) => !Array.isArray(expr) && expr.type !== AstType.Ignore
    );
  }
}
