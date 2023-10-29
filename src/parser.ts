/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AstType,
  Expr,
  FunctionExpr,
  FunctionParameterExpr,
  FunctionPrototype,
  TypeValueExpr,
  getTokenPrecedence,
} from "./ast";
import { Token, TokenType } from "./token";

type ParserReturn = { expr: Expr | null; index: number };

function parseNumberExpr(tokens: Token[], index: number): ParserReturn {
  const token = tokens[index];
  if (token.type === TokenType.Integer) {
    return {
      expr: {
        type: AstType.Integer,
        value: token.value,
      },
      index: index + 1,
    };
  } else if (token.type === TokenType.Float) {
    return {
      expr: {
        type: AstType.Float,
        value: token.value,
      },
      index: index + 1,
    };
  } else {
    throw new Error("Expected number");
  }
}

function parseBooleanExpr(tokens: Token[], index: number): ParserReturn {
  const token = tokens[index];
  if (token.type === TokenType.Boolean) {
    return {
      expr: {
        type: AstType.Boolean,
        value: token.value === "true" ? true : false,
      },
      index: index + 1,
    };
  } else {
    throw new Error("Expected boolean");
  }
}

/**
 * parenexpr ::= "(" expr ")"
 * @param tokens
 * @param index
 * @returns
 */
function parseParenExpr(tokens: Token[], index: number): ParserReturn {
  if (tokens[index].type !== TokenType.LParen) {
    throw new Error("Expected left paren");
  }
  const { expr, index: endIndex } = parseExpression(tokens, index + 1);
  if (!expr) {
    return { expr, index: endIndex };
  }

  if (tokens[endIndex].type !== TokenType.RParen) {
    throw new Error("Expected right paren");
  }
  return { expr, index: endIndex + 1 };
}

/**
 * identifierexpr
 *   ::= identifier
 *   ::= identifier "(" expression* ")"
 * @param tokens
 * @param index
 */
function parseIdentifierExpr(tokens: Token[], index: number): ParserReturn {
  const identifier = tokens[index].value;
  if (tokens[index + 1].type !== TokenType.LParen) {
    return {
      expr: {
        type: AstType.Variable,
        name: identifier,
      },
      index: index + 1,
    };
  } else {
    // call
    const functionName: string = identifier;
    const functionArguments: Expr = [];
    if (tokens[index + 2].type !== TokenType.RParen) {
      index = index + 2;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { expr, index: endIndex } = parseExpression(tokens, index);
        if (expr) {
          functionArguments.push(expr);
        }
        index = endIndex;

        if (tokens[index].type === TokenType.RParen) {
          break;
        }

        if (tokens[index].type !== TokenType.Comma) {
          throw new Error(
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
      };
    } else {
      return {
        expr: {
          type: AstType.CallFunction,
          functionName,
          functionArguments,
        },
        index: index + 3,
      };
    }
  }
}

/**
 * primary
 *   ::= identifierexpr
 *   ::= numberexpr
 *   ::= parenexpr
 * @param tokens
 * @param index
 */
function parsePrimary(tokens: Token[], index: number): ParserReturn {
  const token = tokens[index];
  switch (token.type) {
    case TokenType.Identifier:
      return parseIdentifierExpr(tokens, index);
    case TokenType.Integer:
    case TokenType.Float:
      return parseNumberExpr(tokens, index);
    case TokenType.Boolean:
      return parseBooleanExpr(tokens, index);
    case TokenType.LParen:
      return parseParenExpr(tokens, index);
    case TokenType.Semicolon:
      return { expr: null, index: index + 1 };
    default:
      throw new Error(`Unknown token: ${JSON.stringify(token)}`);
  }
}

function parseBinOpRHS(
  tokens: Token[],
  exprPrecedence: number,
  LHS: Expr,
  index: number
): ParserReturn {
  // if it's binop, find its precedence
  while (true) {
    const token = tokens[index];
    const tokenPrecedence = getTokenPrecedence(token);

    // If this is a binop that binds at least as tightly as the current binop,
    // consume it, otherwise we are done.
    if (tokenPrecedence < exprPrecedence) {
      return { expr: LHS, index };
    }

    // Okay, we know this is a binop
    const binaryOperator = token;
    index = index + 1; // eat binop

    // eslint-disable-next-line prefer-const
    let { expr: RHS, index: endIndex } = parsePrimary(tokens, index);
    if (!RHS) {
      return { expr: RHS, index: endIndex };
    }

    // If BinOp binds less tightly with RHS than the operator after RHS, let
    // the pending operator take RHS as its LHS.
    const nextToken = tokens[endIndex];
    const nextTokenPrecedence = getTokenPrecedence(nextToken);
    if (tokenPrecedence < nextTokenPrecedence) {
      const { expr, index: nextIndex } = parseBinOpRHS(
        tokens,
        tokenPrecedence + 1,
        RHS,
        endIndex
      );
      if (!expr) {
        return { expr, index: nextIndex };
      }
      RHS = expr;
      index = nextIndex;
    } else {
      index = endIndex;
    }

    // Merge LHS/RHS
    LHS = {
      type: AstType.BinaryOperator,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      operator: binaryOperator.value as any,
      left: LHS,
      right: RHS,
    };
  }
}

function parsePrototype(
  tokens: Token[],
  index: number
): {
  prototype: FunctionPrototype | null;
  index: number;
} {
  if (tokens[index].type !== TokenType.Identifier) {
    throw new Error("Expected function name in prototype");
  }
  let token = tokens[index];

  const functionName = token.value;

  index = index + 1;
  token = tokens[index]; // TODO: Check type parameters
  if (token.type !== TokenType.LParen) {
    throw new Error("Expected '(' in function declaration");
  }

  // Read the list of parameter names.
  index = index + 1;
  const functionParameters: FunctionParameterExpr[] = [];
  while (true) {
    const token = tokens[index];

    if (!token) {
      throw new Error("Expected ')'");
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (token.type === TokenType.RParen) {
      break;
    }

    if (token.type !== TokenType.Identifier) {
      throw new Error("Expected parameter name");
    }
    const parameterName = token.value;

    // check type
    if (tokens[index + 1].type !== TokenType.Colon) {
      throw new Error("Expected ':' for parameter type");
    }
    index = index + 2;
    const { typeValue: parameterType, index: nextIndex } = parseTypeValue(
      tokens,
      index
    );
    functionParameters.push({
      parameterName,
      parameterType,
      type: AstType.FunctionParameter,
    });

    index = nextIndex;
  }

  // Check if it's return type
  if (tokens[index + 1].type !== TokenType.Colon) {
    throw new Error("Expected ':' for return type");
  }
  index = index + 2;
  const { typeValue: returnType, index: nextIndex } = parseTypeValue(
    tokens,
    index
  );
  index = nextIndex;

  return {
    prototype: {
      type: AstType.FunctionPrototype,
      functionName,
      typeParameters: [],
      functionParameters,
      returnType,
    },
    index,
  };
}

function parseFunction(tokens: Token[], index: number): ParserReturn {
  if (tokens[index].type !== TokenType.Function) {
    throw new Error("Expected function");
  }

  index = index + 1;
  const { prototype, index: nextIndex } = parsePrototype(tokens, index);
  if (!prototype) {
    return { expr: null, index: nextIndex };
  } else {
    index = nextIndex;
  }

  // Check function body
  if (tokens[index].type !== TokenType.LCurlyBracket) {
    throw new Error("Expected '{' for function body");
  }
  index = index + 1;
  const body: Expr[] = [];
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw new Error("Expected '}' for function body");
    }
    if (token.type === TokenType.RCurlyBracket) {
      break;
    }
    const { expr, index: nextIndex } = parseExpression(tokens, index);
    if (expr) {
      body.push(expr);
    }
    index = nextIndex;
  }

  const functionExpr: FunctionExpr = {
    type: AstType.Function,
    prototype,
    body,
  };
  return { expr: functionExpr, index: index + 1 };
}

function parseExtern(tokens: Token[], index: number): ParserReturn {
  if (tokens[index].type !== TokenType.Extern) {
    throw new Error("Expected extern");
  }

  index = index + 1;
  const { prototype, index: nextIndex } = parsePrototype(tokens, index);
  if (!prototype) {
    return { expr: null, index: nextIndex };
  } else {
    index = nextIndex;
  }
  return {
    expr: {
      type: AstType.Extern,
      prototype,
    },
    index,
  };
}

function parseTypeValue(
  tokens: Token[],
  index: number
): { index: number; typeValue: TypeValueExpr } {
  // TODO: Handle complex type value
  const token = tokens[index];
  return {
    typeValue: {
      type: AstType.TypeValue,
      value: token.value,
    },
    index: index + 1,
  };
}

/**
 * expression
 *  ::= primary binoprhs
 * @param tokens
 * @param index
 */
function parseExpression(tokens: Token[], index = 0): ParserReturn {
  const { expr, index: endIndex } = parsePrimary(tokens, index);
  if (!expr) {
    return { expr, index: endIndex };
  } else {
    return parseBinOpRHS(tokens, 0, expr, endIndex);
  }
}

export function parse(tokens: Token[]): Expr {
  let index = 0;
  const exprs: Expr[] = [];
  while (true) {
    const token = tokens[index];
    if (!token) {
      break;
    }
    switch (token.type) {
      case TokenType.Semicolon: {
        // ignore top-level semicolons.
        index = index + 1;
        break;
      }
      case TokenType.Function: {
        const { expr, index: nextIndex } = parseFunction(tokens, index);
        if (expr) {
          exprs.push(expr);
        }
        index = nextIndex;
        break;
      }
      case TokenType.Extern: {
        const { expr, index: nextIndex } = parseExtern(tokens, index);
        if (expr) {
          exprs.push(expr);
        }
        index = nextIndex;
        break;
      }
      default: {
        const { expr, index: nextIndex } = parseExpression(tokens, index);
        if (expr) {
          exprs.push(expr);
        }
        index = nextIndex;
        break;
      }
    }
  }
  return exprs;
}
