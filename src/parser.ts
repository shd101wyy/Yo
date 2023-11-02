/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AstType,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  getTokenPrecedence,
  synthesizeExprType,
  synthesizeRecordType,
} from "./ast";
import { formatErrorMessage } from "./error";
import { Token, TokenType } from "./token";
import {
  ParameterType,
  Type,
  TypeValues,
  VariableTypes,
  checkType,
  synthesizeTypeFromTokens,
  typeToString,
} from "./type-checker";

type ParserReturn = {
  expr: Expr | null;
  index: number;
  variableTypes: VariableTypes;
};

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
    variableTypes: VariableTypes
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Integer) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.i32,
          value: token.value,
        },
        index: index + 1,
        variableTypes,
      };
    } else if (token.type === TokenType.Float) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.f32,
          value: token.value,
        },
        index: index + 1,
        variableTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected number");
    }
  }

  private parseCharactorExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Char) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.char,
          value: token.value,
        },
        index: index + 1,
        variableTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected charactor");
    }
  }

  private parseStringExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.String) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.string,
          value: token.value,
        },
        index: index + 1,
        variableTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseBooleanExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Boolean) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.boolean,
          value: token.value,
        },
        index: index + 1,
        variableTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected boolean");
    }
  }

  // TODO: Implement curly bracket expression
  // it could be either the RecordExpr or BlockExpr
  private parseCurlyBracketExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    return this.parseRecordExpr(tokens, index, variableTypes);
  }

  private parseRecordExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket || !tokens[index + 1]) {
      throw this.formatErrorMessage(tokens[index], "Expected '{' for record");
    }
    index = index + 1;
    if (tokens[index].type === TokenType.RCurlyBracket) {
      return {
        expr: {
          type: AstType.Value,
          value: "",
          typeValue: { type: "Record", properties: [] },
          properties: [],
        },
        index: index + 1,
        variableTypes,
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
          variableTypes
        );
        if (!expr) {
          return { expr, index: nextIndex, variableTypes };
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
          value: "",
          typeValue: synthesizeRecordType(properties, variableTypes),
          properties,
        },
        index,
        variableTypes,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
    }
  }

  private parseAnonymouseFunction(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      return { expr: null, index, variableTypes };
    }

    // parse prototype
    const {
      prototype,
      index: nextIndex,
      variableTypes: newVariableTypes,
    } = this.parsePrototype({
      tokens,
      index,
      variableTypes,
      requireFunctionName: false,
    });
    if (!prototype) {
      return { expr: null, index, variableTypes };
    }

    // check if current token is `=>`
    if (tokens[nextIndex].type !== TokenType.LambdaArrow) {
      return { expr: null, index, variableTypes };
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
      body,
    };
    return { expr: functionExpr, index: nextNextIndex, variableTypes };
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
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (tokens[index + 1]?.type === TokenType.RParen) {
      // unit type
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.unit,
          value: "()",
        },
        index: index + 2,
        variableTypes,
      };
    }

    // Try parse as anonymouse function
    try {
      const { expr, index: endIndex } = this.parseAnonymouseFunction(
        tokens,
        index,
        variableTypes
      );
      if (expr) {
        return { expr, index: endIndex, variableTypes };
      } else {
        throw new Error("Failed to parse as anonymouse function");
      }
    } catch (error) {
      // Ignore the error
      // This means we failed to parse it as anonymouse function
    }

    const { expr, index: endIndex } = this.parseExpression(
      tokens,
      index + 1,
      variableTypes
    );
    if (!expr) {
      return { expr, index: endIndex, variableTypes };
    }

    if (tokens[endIndex].type !== TokenType.RParen) {
      throw this.formatErrorMessage(tokens[endIndex], "Expected right paren");
    }
    return { expr, index: endIndex + 1, variableTypes };
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
    variableTypes: VariableTypes
  ): ParserReturn {
    const identifier = tokens[index].value;
    if (tokens[index + 1].type !== TokenType.LParen) {
      // Check if variable is defined
      if (!(identifier in variableTypes)) {
        throw this.formatErrorMessage(
          tokens[index],
          `Unbounded variable \`${identifier}\``
        );
      }

      return {
        expr: {
          type: AstType.Variable,
          name: identifier,
        },
        index: index + 1,
        variableTypes,
      };
    } else {
      // call
      const functionName: string = identifier;
      const functionArguments: Expr = [];
      if (tokens[index + 2].type !== TokenType.RParen) {
        index = index + 2;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { expr, index: endIndex } = this.parseExpression(
            tokens,
            index,
            variableTypes
          );
          if (expr) {
            functionArguments.push(expr);
          }
          index = endIndex;

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

        return {
          expr: {
            type: AstType.CallFunction,
            functionName,
            functionArguments,
          },
          index: index + 1,
          variableTypes,
        };
      } else {
        return {
          expr: {
            type: AstType.CallFunction,
            functionName,
            functionArguments,
          },
          index: index + 3,
          variableTypes,
        };
      }
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
    variableTypes: VariableTypes
  ): ParserReturn {
    const token = tokens[index];
    switch (token.type) {
      case TokenType.Identifier:
        return this.parseIdentifierExpr(tokens, index, variableTypes);
      case TokenType.Integer:
      case TokenType.Float:
        return this.parseNumberExpr(tokens, index, variableTypes);
      case TokenType.Char:
        return this.parseCharactorExpr(tokens, index, variableTypes);
      case TokenType.String:
        return this.parseStringExpr(tokens, index, variableTypes);
      case TokenType.Boolean:
        return this.parseBooleanExpr(tokens, index, variableTypes);
      case TokenType.LParen:
        return this.parseParenExpr(tokens, index, variableTypes);
      case TokenType.LCurlyBracket:
        return this.parseCurlyBracketExpr(tokens, index, variableTypes);
      case TokenType.If:
        return this.parseIfExpr(tokens, index, variableTypes);
      case TokenType.Const:
        return this.parseConstAssignment(tokens, index, variableTypes);
      case TokenType.Semicolon:
        return { expr: null, index: index + 1, variableTypes };
      default:
        throw this.formatErrorMessage(
          token,
          `Unknown token: ${JSON.stringify(token)}`
        );
    }
  }

  private parseBinOpRHS(
    tokens: Token[],
    exprPrecedence: number,
    LHS: Expr,
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];
      const tokenPrecedence = getTokenPrecedence(token);

      // If this is a binop that binds at least as tightly as the current binop,
      // consume it, otherwise we are done.
      if (tokenPrecedence < exprPrecedence) {
        return { expr: LHS, index, variableTypes };
      }

      // Okay, we know this is a binop
      const binaryOperator = token;
      index = index + 1; // eat binop

      // eslint-disable-next-line prefer-const
      let { expr: RHS, index: endIndex } = this.parsePrimary(
        tokens,
        index,
        variableTypes
      );
      if (!RHS) {
        return { expr: RHS, index: endIndex, variableTypes };
      }

      // If BinOp binds less tightly with RHS than the operator after RHS, let
      // the pending operator take RHS as its LHS.
      const nextToken = tokens[endIndex];
      const nextTokenPrecedence = getTokenPrecedence(nextToken);
      if (tokenPrecedence < nextTokenPrecedence) {
        const { expr, index: nextIndex } = this.parseBinOpRHS(
          tokens,
          tokenPrecedence + 1,
          RHS,
          endIndex,
          variableTypes
        );
        if (!expr) {
          return { expr, index: nextIndex, variableTypes };
        }
        RHS = expr;
        index = nextIndex;
      } else {
        index = endIndex;
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
      };
    }
  }

  private parsePrototype({
    tokens,
    index,
    variableTypes,
    requireFunctionName,
  }: {
    tokens: Token[];
    index: number;
    variableTypes: VariableTypes;
    requireFunctionName: boolean;
  }): {
    prototype: FunctionPrototype | null;
    index: number;
    variableTypes: VariableTypes;
  } {
    // NOTE: We will mutate variableTypes
    variableTypes = { ...variableTypes };

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

    const token = tokens[index]; // TODO: Check type parameters
    if (token.type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        token,
        "Expected '(' in function declaration"
      );
    }

    // Read the list of parameter names.
    index = index + 1;
    const functionParameters: Expr[] = [];
    const functionParameterTypes: ParameterType[] = [];
    while (true) {
      const token = tokens[index];

      if (!token) {
        throw this.formatErrorMessage(token, "Expected ')'");
      }
      if (token.type === TokenType.Comma) {
        index = index + 1;
        continue;
      }
      if (token.type === TokenType.RParen) {
        break;
      }

      // TODO: There might be the case that only the type is specified
      if (token.type !== TokenType.Identifier) {
        throw this.formatErrorMessage(token, "Expected parameter name");
      }
      const parameterName = token.value;
      functionParameters.push({
        type: AstType.Variable,
        name: parameterName,
      });

      // check type
      if (tokens[index + 1].type !== TokenType.Colon) {
        throw this.formatErrorMessage(
          tokens[index + 1],
          "Expected ':' for parameter type"
        );
      }
      index = index + 2;
      const { typeValue: parameterType, index: nextIndex } =
        synthesizeTypeFromTokens(
          tokens,
          index,
          this.inputString,
          variableTypes
        );
      functionParameterTypes.push({
        type: parameterType,
        name: parameterName,
      });

      if (parameterName) {
        variableTypes[parameterName] = parameterType;
      }

      index = nextIndex;
    }

    // Check if it's return type
    let returnType: Type;
    if (tokens[index + 1].type !== TokenType.Colon) {
      returnType = {
        type: "unknown",
      };
      index = index + 1;
    } else {
      index = index + 2;
      const { typeValue, index: nextIndex } = synthesizeTypeFromTokens(
        tokens,
        index,
        this.inputString,
        variableTypes
      );
      index = nextIndex;
      returnType = typeValue;
    }

    return {
      prototype: {
        type: AstType.FunctionPrototype,
        functionName,
        functionParameters,
        typeValue: {
          type: "Function",
          parameterTypes: functionParameterTypes,
          returnType,
        },
      },
      index,
      variableTypes,
    };
  }

  private parseBlockExpressions(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): { exprs: Expr[]; index: number; variableTypes: VariableTypes } {
    const exprs: Expr[] = [];
    let newVariableTypes = { ...variableTypes };
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for block expressions"
      );
    }
    index = index + 1;

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
        variableTypes: newNamedTypes2,
      } = this.parseExpression(tokens, index, newVariableTypes);
      newVariableTypes = newNamedTypes2;
      if (expr) {
        exprs.push(expr);
      }
      index = nextIndex;
    }

    const lastExpr: Expr | null = exprs[exprs.length - 1] ?? null;
    if (!lastExpr || tokens[index - 2].type === TokenType.Semicolon) {
      exprs.push({
        type: AstType.Value,
        typeValue: TypeValues.unit,
        value: "()",
      });
    }

    return {
      index,
      exprs,
      variableTypes: newVariableTypes,
    };
  }

  private parseFunction(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Function) {
      throw this.formatErrorMessage(tokens[index], "Expected function");
    }

    index = index + 1;
    const {
      prototype,
      index: nextIndex,
      variableTypes: newVariableTypes,
    } = this.parsePrototype({
      tokens,
      index,
      variableTypes,
      requireFunctionName: true,
    });
    if (!prototype) {
      return { expr: null, index: nextIndex, variableTypes };
    } else {
      index = nextIndex;
      variableTypes[prototype.functionName!] = prototype.typeValue;
    }

    // Check function body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for function body"
      );
    }

    const {
      exprs,
      index: endIndex,
      variableTypes: functionBodyVariableTypes,
    } = this.parseBlockExpressions(tokens, index, newVariableTypes);

    // Check function body return type matches
    // prototype.returnType
    const functionReturnType = synthesizeExprType(
      exprs[exprs.length - 1],
      functionBodyVariableTypes
    );
    if (prototype.typeValue.returnType.type === "unknown") {
      prototype.typeValue.returnType = functionReturnType;
    }
    if (!checkType(functionReturnType, prototype.typeValue.returnType)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched return type: ${typeToString(
          prototype.typeValue.returnType
        )} and ${typeToString(functionReturnType)}`
      );
    }

    const functionExpr: FunctionExpr = {
      type: AstType.Function,
      prototype,
      body: exprs,
    };
    return { expr: functionExpr, index: endIndex, variableTypes };
  }

  private parseExtern(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Extern) {
      throw this.formatErrorMessage(tokens[index], "Expected extern");
    }

    index = index + 1;
    const { prototype, index: nextIndex } = this.parsePrototype({
      tokens,
      index,
      variableTypes,
      requireFunctionName: true,
    });
    if (!prototype) {
      return { expr: null, index: nextIndex, variableTypes };
    } else {
      index = nextIndex;
      variableTypes[prototype.functionName!] = prototype.typeValue;
    }

    return {
      expr: {
        type: AstType.Extern,
        prototype,
      },
      index,
      variableTypes,
    };
  }

  private parseIfExpr(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    index = index + 1;

    // parse condition
    const { expr: condition, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      variableTypes
    );
    if (!condition) {
      return { expr: null, index: nextIndex, variableTypes };
    }
    const conditionType = synthesizeExprType(condition, variableTypes);
    if (!checkType(TypeValues.boolean, conditionType)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Expected boolean for condition, but got ${typeToString(conditionType)}`
      );
    }
    index = nextIndex;

    // parse then
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for 'if' body"
      );
    }
    const { exprs: then, index: nextNextIndex } = this.parseBlockExpressions(
      tokens,
      index,
      variableTypes
    );
    index = nextNextIndex;

    // parse else
    const elseExpr: Expr[] = [];
    if (tokens[index].type === TokenType.Else) {
      index = index + 1;

      if (tokens[index].type === TokenType.If) {
        const { expr, index: nextNextNextIndex } = this.parseIfExpr(
          tokens,
          index,
          variableTypes
        );
        if (expr) {
          elseExpr.push(expr);
        }
        index = nextNextNextIndex;
      } else {
        if (tokens[index].type !== TokenType.LCurlyBracket) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '{' for 'else' body"
          );
        }
        const { exprs, index: nextNextNextIndex } = this.parseBlockExpressions(
          tokens,
          index,
          variableTypes
        );
        if (exprs) {
          elseExpr.push(...exprs);
        }
        index = nextNextNextIndex;
      }
    }

    return {
      expr: {
        type: AstType.If,
        condition,
        then,
        else: elseExpr,
      },
      index: index,
      variableTypes,
    };
  }

  private parseConstAssignment(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
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
      const { typeValue, index: nextIndex } = synthesizeTypeFromTokens(
        tokens,
        index,
        this.inputString,
        variableTypes
      );
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
      variableTypes
    );
    if (!value) {
      return { expr: null, index: nextNextIndex, variableTypes };
    }
    index = nextNextIndex;

    let variableType: Type;
    try {
      variableType = synthesizeExprType(value, variableTypes);
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
    }

    // Add variable to variableTypes
    variableTypes[variableName] = variableType;

    return {
      expr: {
        type: AstType.ConstantAssigment,
        variableName,
        variableType: userDefinedVariableType ?? variableType,
        right: value,
      },
      index,
      variableTypes,
    };
  }

  private parseTypeAlias(
    tokens: Token[],
    index: number,
    variableTypes: VariableTypes
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

    const { index: nextIndex, typeValue } = synthesizeTypeFromTokens(
      tokens,
      index,
      this.inputString,
      variableTypes
    );
    variableTypes[typeName] = typeValue;

    return {
      expr: {
        type: AstType.TypeAlias,
        typeName,
        typeType: typeValue,
      },
      index: nextIndex,
      variableTypes,
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
    variableTypes: VariableTypes
  ): ParserReturn {
    const { expr, index: endIndex } = this.parsePrimary(
      tokens,
      index,
      variableTypes
    );
    if (!expr) {
      return { expr, index: endIndex, variableTypes };
    } else {
      return this.parseBinOpRHS(tokens, 0, expr, endIndex, variableTypes);
    }
  }

  public parse(tokens: Token[], variableTypes: VariableTypes = {}): Expr {
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
            variableTypes: newVariableTypes,
          } = this.parseFunction(tokens, index, variableTypes);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          variableTypes = newVariableTypes;
          break;
        }
        case TokenType.Extern: {
          const {
            expr,
            index: nextIndex,
            variableTypes: newVariableTypes,
          } = this.parseExtern(tokens, index, variableTypes);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          variableTypes = newVariableTypes;
          break;
        }
        case TokenType.Type: {
          const {
            expr,
            index: nextIndex,
            variableTypes: newVariableTypes,
          } = this.parseTypeAlias(tokens, index, variableTypes);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          variableTypes = newVariableTypes;
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
    return exprs;
  }
}
