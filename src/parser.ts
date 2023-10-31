/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AstType,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  NamedTypes,
  checkType,
  getTokenPrecedence,
  synthesizeExprType,
  synthesizeRecordType,
} from "./ast";
import { Token, TokenType } from "./token";
import { Type, TypeValues, synthesizeTypeFromTokens } from "./type-checker";

type ParserReturn = {
  expr: Expr | null;
  index: number;
  namedTypes: NamedTypes;
};

export default class Parser {
  public ast: Expr[];
  private inputString: string;

  constructor(inputString: string) {
    this.inputString = inputString;
    this.ast = [];
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    const { position } = token;
    const { character, line } = position;

    const lines = this.inputString.split("\n");
    const lineString = lines[line];
    const errorMessages = `${errorMessage}
Line ${line + 1}, column ${character + 1}:

${lineString}
${" ".repeat(character)}^`;
    return new Error(errorMessages);
  }

  private parseNumberExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        namedTypes,
      };
    } else if (token.type === TokenType.Float) {
      return {
        expr: {
          type: AstType.Value,
          typeValue: TypeValues.f32,
          value: token.value,
        },
        index: index + 1,
        namedTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected number");
    }
  }

  private parseCharactorExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        namedTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected charactor");
    }
  }

  private parseStringExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        namedTypes,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseBooleanExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        namedTypes,
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
    namedTypes: NamedTypes
  ): ParserReturn {
    return this.parseRecordExpr(tokens, index, namedTypes);
  }

  private parseRecordExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        namedTypes,
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
          namedTypes
        );
        if (!expr) {
          return { expr, index: nextIndex, namedTypes };
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
          typeValue: synthesizeRecordType(properties, namedTypes),
          properties,
        },
        index,
        namedTypes,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
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
    namedTypes: NamedTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    const { expr, index: endIndex } = this.parseExpression(
      tokens,
      index + 1,
      namedTypes
    );
    if (!expr) {
      return { expr, index: endIndex, namedTypes };
    }

    if (tokens[endIndex].type !== TokenType.RParen) {
      throw this.formatErrorMessage(tokens[endIndex], "Expected right paren");
    }
    return { expr, index: endIndex + 1, namedTypes };
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
    namedTypes: NamedTypes
  ): ParserReturn {
    const identifier = tokens[index].value;
    if (tokens[index + 1].type !== TokenType.LParen) {
      // Check if variable is defined
      if (!(identifier in namedTypes)) {
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
        namedTypes,
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
            namedTypes
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
              `Expected comma, but got ${JSON.stringify(tokens[index])}`
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
          namedTypes,
        };
      } else {
        return {
          expr: {
            type: AstType.CallFunction,
            functionName,
            functionArguments,
          },
          index: index + 3,
          namedTypes,
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
    namedTypes: NamedTypes
  ): ParserReturn {
    const token = tokens[index];
    switch (token.type) {
      case TokenType.Identifier:
        return this.parseIdentifierExpr(tokens, index, namedTypes);
      case TokenType.Integer:
      case TokenType.Float:
        return this.parseNumberExpr(tokens, index, namedTypes);
      case TokenType.Char:
        return this.parseCharactorExpr(tokens, index, namedTypes);
      case TokenType.String:
        return this.parseStringExpr(tokens, index, namedTypes);
      case TokenType.Boolean:
        return this.parseBooleanExpr(tokens, index, namedTypes);
      case TokenType.LParen:
        return this.parseParenExpr(tokens, index, namedTypes);
      case TokenType.LCurlyBracket:
        return this.parseCurlyBracketExpr(tokens, index, namedTypes);
      case TokenType.If:
        return this.parseIfExpr(tokens, index, namedTypes);
      case TokenType.Const:
        return this.parseConstAssignment(tokens, index, namedTypes);
      case TokenType.Semicolon:
        return { expr: null, index: index + 1, namedTypes };
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
    namedTypes: NamedTypes
  ): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];
      const tokenPrecedence = getTokenPrecedence(token);

      // If this is a binop that binds at least as tightly as the current binop,
      // consume it, otherwise we are done.
      if (tokenPrecedence < exprPrecedence) {
        return { expr: LHS, index, namedTypes };
      }

      // Okay, we know this is a binop
      const binaryOperator = token;
      index = index + 1; // eat binop

      // eslint-disable-next-line prefer-const
      let { expr: RHS, index: endIndex } = this.parsePrimary(
        tokens,
        index,
        namedTypes
      );
      if (!RHS) {
        return { expr: RHS, index: endIndex, namedTypes };
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
          namedTypes
        );
        if (!expr) {
          return { expr, index: nextIndex, namedTypes };
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

  private parsePrototype(
    tokens: Token[],
    index: number,
    namedTypes
  ): {
    prototype: FunctionPrototype | null;
    index: number;
    namedTypes: NamedTypes;
  } {
    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected function name in prototype"
      );
    }
    let token = tokens[index];

    const functionName = token.value;

    index = index + 1;
    token = tokens[index]; // TODO: Check type parameters
    if (token.type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        token,
        "Expected '(' in function declaration"
      );
    }

    // Read the list of parameter names.
    index = index + 1;
    const functionParameters: Expr[] = [];
    const functionParameterTypes: Type[] = [];
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

      if (token.type !== TokenType.Identifier) {
        throw this.formatErrorMessage(token, "Expected parameter name");
      }
      functionParameters.push({
        type: AstType.Variable,
        name: token.value,
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
        synthesizeTypeFromTokens(tokens, index);
      functionParameterTypes.push(parameterType);

      index = nextIndex;
    }

    // Check if it's return type
    if (tokens[index + 1].type !== TokenType.Colon) {
      throw this.formatErrorMessage(
        tokens[index + 1],
        "Expected ':' for return type"
      );
    }
    index = index + 2;
    const { typeValue: returnType, index: nextIndex } =
      synthesizeTypeFromTokens(tokens, index);
    index = nextIndex;

    return {
      prototype: {
        type: AstType.FunctionPrototype,
        functionName,
        functionParameters,
        typeValue: {
          type: "function",
          parameters: functionParameterTypes,
          returnType,
        },
      },
      index,
      namedTypes,
    };
  }

  private parseBlockExpressions(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
  ): { exprs: Expr[]; index: number } {
    const exprs: Expr[] = [];
    let newNamedTypes = { ...namedTypes };
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
        namedTypes: newNamedTypes2,
      } = this.parseExpression(tokens, index, newNamedTypes);
      newNamedTypes = newNamedTypes2;
      if (expr) {
        exprs.push(expr);
      }
      index = nextIndex;
    }

    return {
      index,
      exprs,
    };
  }

  private parseFunction(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Function) {
      throw this.formatErrorMessage(tokens[index], "Expected function");
    }

    index = index + 1;
    const { prototype, index: nextIndex } = this.parsePrototype(
      tokens,
      index,
      namedTypes
    );
    if (!prototype) {
      return { expr: null, index: nextIndex, namedTypes };
    } else {
      index = nextIndex;
      namedTypes[prototype.functionName] = prototype.typeValue;
    }

    // Check function body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for function body"
      );
    }

    const newNamedTypes = { ...namedTypes };
    // Add parameters to newNamedTypes
    prototype.functionParameters.forEach((parameter, index) => {
      if (parameter instanceof Array || parameter.type !== AstType.Variable) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected variable for function parameter"
        );
      }

      if (prototype.typeValue.type !== "function") {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function type for prototype"
        );
      }

      newNamedTypes[parameter.name] = prototype.typeValue.parameters[index];
    });

    const { exprs, index: endIndex } = this.parseBlockExpressions(
      tokens,
      index,
      newNamedTypes
    );

    const functionExpr: FunctionExpr = {
      type: AstType.Function,
      prototype,
      body: exprs,
    };
    return { expr: functionExpr, index: endIndex, namedTypes };
  }

  private parseExtern(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Extern) {
      throw this.formatErrorMessage(tokens[index], "Expected extern");
    }

    index = index + 1;
    const { prototype, index: nextIndex } = this.parsePrototype(
      tokens,
      index,
      namedTypes
    );
    if (!prototype) {
      return { expr: null, index: nextIndex, namedTypes };
    } else {
      index = nextIndex;
      namedTypes[prototype.functionName] = prototype.typeValue;
    }

    return {
      expr: {
        type: AstType.Extern,
        prototype,
      },
      index,
      namedTypes,
    };
  }

  private parseIfExpr(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
  ): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    index = index + 1;

    // parse condition
    const { expr: condition, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      namedTypes
    );
    if (!condition) {
      return { expr: null, index: nextIndex, namedTypes };
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
      namedTypes
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
          namedTypes
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
          namedTypes
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
      namedTypes,
    };
  }

  private parseConstAssignment(
    tokens: Token[],
    index: number,
    namedTypes: NamedTypes
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
        index
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
      namedTypes
    );
    if (!value) {
      return { expr: null, index: nextNextIndex, namedTypes };
    }
    index = nextNextIndex;

    let variableType: Type;
    try {
      variableType = synthesizeExprType(value, namedTypes);
    } catch (error) {
      throw this.formatErrorMessage(tokens[valueIndex], error);
    }

    // Check if type matches
    if (userDefinedVariableType !== null) {
      const typeMatches = checkType(value, userDefinedVariableType, namedTypes);
      if (!typeMatches) {
        throw this.formatErrorMessage(
          tokens[userDefinedVariableTypeTokenIndex],
          `Type mismatch: ${JSON.stringify(
            userDefinedVariableType
          )} and ${JSON.stringify(variableType)}`
        );
      }
    }

    // Add variable to namedTypes
    namedTypes[variableName] = variableType;

    return {
      expr: {
        type: AstType.ConstantAssigment,
        variableName,
        variableType,
        right: value,
      },
      index,
      namedTypes,
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
    namedTypes: NamedTypes
  ): ParserReturn {
    const { expr, index: endIndex } = this.parsePrimary(
      tokens,
      index,
      namedTypes
    );
    if (!expr) {
      return { expr, index: endIndex, namedTypes };
    } else {
      return this.parseBinOpRHS(tokens, 0, expr, endIndex, namedTypes);
    }
  }

  public parse(tokens: Token[], namedTypes: NamedTypes = {}): Expr {
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
            namedTypes: newNamedTypes,
          } = this.parseFunction(tokens, index, namedTypes);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          namedTypes = newNamedTypes;
          break;
        }
        case TokenType.Extern: {
          const {
            expr,
            index: nextIndex,
            namedTypes: newNamedTypes,
          } = this.parseExtern(tokens, index, namedTypes);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          namedTypes = newNamedTypes;
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
