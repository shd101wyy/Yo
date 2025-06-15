/* eslint-disable no-constant-condition */
import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
  Variable,
} from "./env";
import { formatErrorMessages } from "./error";
import { Token, TokenType } from "./token";
import {
  isFreeType,
  isLinearOrType0Type,
  Type,
  typeOfType,
} from "./type-checker";
import { generateNewTempVariableName } from "./utils";
import { Value } from "./value";

/**
 * Eg:
 *
 * x      has path ["x"]
 * x.a    has path ["x", "a"]
 * &(x.a) has path ["x", "a"]
 * arr(some_index) has path ["arr"] as `some_index` is runtime known.
 *
 */
export type Path = string[];
export type PathCollection = Path[];

/*
 * Check if `path1` contains `path2`.
 * For example:
 *   pathContainsPath(["x"], ["x", "a"]) => false
 *   pathContainsPath(["x", "a"], ["x"]) => true
 *   pathContainsPath(["x", "a"], ["x", "a"]) => true
 *   pathContainsPath(["x", "a"], ["y"]) => false
 */
export function pathContainsPath(path1: Path, path2: Path): boolean {
  if (path1.length < path2.length) {
    return false;
  }
  for (let i = 0; i < path2.length; i++) {
    if (path1[i] !== path2[i]) {
      return false;
    }
  }
  return true;
}

export function pathCollectionConflictsWithPathCollection(
  collection1: PathCollection,
  collection2: PathCollection
): boolean {
  // If any path in collection1 conflicts with any path in collection2, then they conflict.
  for (const path1 of collection1) {
    for (const path2 of collection2) {
      if (pathConflictsWithPath(path1, path2)) {
        return true;
      }
    }
  }
  return false;
}

export function pathConflictsWithPath(path1: Path, path2: Path): boolean {
  // If the first path is a prefix of the second path, then they conflict.
  if (pathContainsPath(path2, path1)) {
    return true;
  }
  // If the second path is a prefix of the first path, then they conflict.
  if (pathContainsPath(path1, path2)) {
    return true;
  }
  return false;
}

export enum ExprTag {
  Atom = "Atom",
  FuncCall = "FuncCall",
}

export interface EvaluatedExprData {
  /**
   * The environment after the expression has been evaluated.
   */
  env: Environment;
  /**
   * The type of the expression after the evaluation.
   */
  type: Type;
  /**
   * The value of the expression.
   * If it's undefined, then it means it's a runtime value.
   */
  value?: Value;
  /**
   * If this is given, then it means there is a temporary variable holding the value in the `env` above.
   */
  variableName?: string;
  /**
   * Check if the value returned from the expression is mutable.
   * For exampe:
   * mut(x) := 12;
   * y = x; // Expression `x` here is mutable.
   */
  isMutable: boolean;

  /**
   * For example, the expression below is accessing property:
   *   p.*
   * `p.*` is an expression whose `isAccessingProperty` is true.
   */
  isAccessingProperty?: boolean;

  /**
   * The path collection of the expression.
   */
  pathCollection: PathCollection;
}

export type AtomExpr = {
  // Parser stage
  tag: ExprTag.Atom;
  token: Token;

  // Evaluator stage
  /**
   * If it's undefined, then the expression has not been evaluated yet.
   */
  $?: EvaluatedExprData | undefined;
};

export type FuncCallExpr = {
  // Parser stage
  tag: ExprTag.FuncCall;
  func: Expr;
  args: Expr[];
  isInfix?: boolean;
  token: Token;

  // Evaluator stage
  /**
   * If it's undefined, then the expression has not been evaluated yet.
   */
  $?: EvaluatedExprData | undefined;
};

export function cloneExpr(expr: Expr): Expr {
  switch (expr.tag) {
    case ExprTag.Atom:
      return { ...expr, $: expr.$ ? { ...expr.$ } : undefined };
    case ExprTag.FuncCall:
      return {
        ...expr,
        func: cloneExpr(expr.func),
        args: expr.args.map(cloneExpr),
        $: expr.$ ? { ...expr.$ } : undefined,
      };
  }
}

export type Expr = AtomExpr | FuncCallExpr;

export function exprIsFunctionCall(
  expr: Expr | undefined
): expr is FuncCallExpr {
  return expr?.tag === ExprTag.FuncCall;
}
export function exprIsAtom(expr: Expr | undefined): expr is AtomExpr {
  return expr?.tag === ExprTag.Atom;
}

export function exprIsAtomOf(expr: Expr, values: string | string[]): boolean {
  return (
    expr.tag === ExprTag.Atom &&
    (typeof values === "string"
      ? expr.token.value === values
      : values.includes(expr.token.value))
  );
}

export function exprIsAtomAndOperator(expr: Expr): boolean {
  return expr.tag === ExprTag.Atom && expr.token.type === TokenType.Operator;
}

export function exprIsFunctionCallOf(
  expr: Expr,
  funcNames: string | string[],
  argumentCount?: number
): boolean {
  return (
    expr.tag === ExprTag.FuncCall &&
    expr.func.tag === ExprTag.Atom &&
    (typeof funcNames === "string"
      ? expr.func.token.value === funcNames
      : funcNames.includes(expr.func.token.value)) &&
    (argumentCount === undefined || expr.args.length === argumentCount)
  );
}

export const BuiltinKeywords = {
  compt: ["compt", "@"],
  mut: ["mut", "!"],
  implicit: ["implicit", "?"],

  forall: ["forall", "∀"],
  // Exists: ["exists", "∃"],
  // Where: ["where", "∋"],
  // In: ["in", "∈"],

  quote: ["quote", ":"],
  unquote: ["unquote", "#"],

  recur: ["recur"],
  fn: ["fn"],
  extern: ["extern"],
  cond: ["cond"],
  type: ["type"],
  match: ["match"],
  struct: ["struct"],
  enum: ["enum"],
  union: ["union"],
  module: ["module"],
  begin: ["begin"],
  module_begin: ["module_begin"],
  import: ["import"],
  export: ["export"],
  borrow: ["borrow"],
  open: ["open"],

  // values
  undefined: ["undefined"],
  null: ["null"],
  true: ["true"],
  false: ["false"],

  // data types
  LinearPtr: ["^"],
  MutLinearPtr: ["^!"],
  Ptr: ["*"],
  MutPtr: ["*!"],
  Ref: ["&"],
  MutRef: ["&!"],
  Rc: ["$"], // Everthing comes with a cost.
  Tuple: ["Tuple"],
  Array: ["Array"],

  // data values
  tuple: "tuple",
  array: "array",
};

export const BuiltinFunctions = {
  are_types_compatible: ["are_types_compatible"],
  compt_expect_error: ["compt_expect_error"],
  typeof: ["typeof"],
  consume: ["consume"],
  compt_assert: ["compt_assert"],
};

export function exprIsInfixOperatorFunctionCall(expr: Expr): boolean {
  return Boolean(
    expr.tag === "FuncCall" &&
      expr.isInfix &&
      expr.func.tag === "Atom" &&
      (expr.func.token.type === TokenType.Operator ||
        expr.func.token.type === TokenType.BacktickIdentifier) &&
      expr.args.length === 2
  );
}

export function exprToString(expr: Expr): string {
  let printed = "";
  switch (expr.tag) {
    case "Atom": {
      printed = expr.token.value;
      break;
    }
    case "FuncCall": {
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot ||
          expr.func.token.type === TokenType.BacktickIdentifier)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            printed = `${expr.func.token.value}${exprToString(expr.args[0]!)}`;
          } else {
            printed = `${expr.func.token.value}(${exprToString(expr.args[0]!)})`;
          }
          break;
        } else if (expr.args.length === 2 && expr.isInfix) {
          let lhs = exprToString(expr.args[0]!);
          let rhs = exprToString(expr.args[1]!);
          lhs =
            exprIsInfixOperatorFunctionCall(expr.args[0]!) ||
            exprIsAtomAndOperator(expr.args[0]!)
              ? `(${lhs})`
              : lhs;
          rhs =
            exprIsInfixOperatorFunctionCall(expr.args[1]!) ||
            exprIsAtomAndOperator(expr.args[1]!)
              ? `(${rhs})`
              : rhs;
          if (expr.func.token.value === ".") {
            printed = `(${lhs}.${rhs})`;
          } else {
            printed = `${lhs} ${expr.func.token.value} ${rhs}`;
          }
          break;
        }
      }
      if (
        expr.func.tag === "Atom" &&
        expr.func.token.type === TokenType.Identifier &&
        expr.func.token.value === BuiltinKeywords.tuple
      ) {
        if (expr.args.length === 1) {
          printed = `(${exprToString(expr.args[0]!)},)`;
        } else {
          printed = `(${expr.args
            .map((arg) => {
              return exprToString(arg);
            })
            .join(", ")
            .trim()})`;
        }
        break;
      }

      let func = exprToString(expr.func);
      func =
        exprIsInfixOperatorFunctionCall(expr.func) ||
        exprIsAtomAndOperator(expr.func)
          ? `(${func})`
          : func;
      const args = expr.args
        .map((arg) => {
          return exprToString(arg);
        })
        .join(", ")
        .trim();
      printed = `${func}(${args})`;
      break;
    }
  }

  return printed;
}

export function attachTempVariableToExpr(expr: Expr): void {
  if (!expr.$) {
    throw new Error(`Expected expression to be evaluated, but it is not:
${exprToString(expr)}`);
  }
  const { env, type, value, isMutable } = expr.$;
  const modulePath = env.modulePath;
  const tempVariableName = generateNewTempVariableName(modulePath);

  // Add temp variable to the environment
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: tempVariableName,
      type,
      value,
      isMutable,
      isCompileTimeOnly: Boolean(value),
      isImplicit: false,
      isUndefined: false,
      token: expr.token,
    },
  });

  expr.$.variableName = tempVariableName;
  expr.$.env = nextEnv;
}

export function setExprAsConsumed(expr: Expr, env: Environment): Environment {
  // Check if it's dereferencing a pointer/reference to linear type value.
  if (
    expr.$?.isAccessingProperty &&
    isLinearOrType0Type(typeOfType(expr.$.type))
  ) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Cannot consume a property of a "Linear" value.`,
        },
      ],
    });
  }

  const nameOfVariableToConsume = expr.$?.variableName;
  if (!nameOfVariableToConsume) {
    return env;
    /*
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Failed to consume the expression as it is not a variable or does not have a temporary variable name.`,
        },
      ],
    });
    */
  }

  const variables = getVariablesFromEnv(env, nameOfVariableToConsume);
  if (variables.length === 0) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
        },
      ],
    });
  }

  const variableToConsume = variables[variables.length - 1]!;
  if (isLinearOrType0Type(typeOfType(variableToConsume.type))) {
    // Check if the variable is already consumed
    if (variableToConsume.consumedAtToken) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: expr.token,
            errorMessage: `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again.`,
          },
          {
            token: variableToConsume.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }

    // Set the variable as consumed
    env = updateExistingVariable(env, variableToConsume, {
      ...variableToConsume,
      consumedAtToken: expr.token,
    });
  }
  return env;
}

/**
 *
 * Require the given "expr" is not consumed,
 * if it is consumed, then throw an error.
 */
export function requireExprNotConsumed(expr: Expr, env: Environment): void {
  const nameOfVariableToConsume = expr.$?.variableName;
  if (!nameOfVariableToConsume) {
    return;
  }

  const variables = getVariablesFromEnv(env, nameOfVariableToConsume);
  if (variables.length === 0) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
        },
      ],
    });
  }

  const variableToConsume = variables[variables.length - 1]!;
  if (isLinearOrType0Type(typeOfType(variableToConsume.type))) {
    // Check if the variable is already consumed
    if (variableToConsume.consumedAtToken) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: expr.token,
            errorMessage: `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again.`,
          },
          {
            token: variableToConsume.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }
  }
}

/**
 * Update `env` based on multiple envs in different cases.
 * @param env the base env, before entering cond/match cases.
 * @param bodies the bodies of the cases, not including the condition/case.
 */
export function mergeAndCheckEnvs(
  env: Environment,
  bodies: Expr[]
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // tempVariableName: string
): Environment {
  const maxFrameLevel = env.frames.length - 1;
  const caseEnvs: Environment[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    if (!body.$) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: body.token,
            errorMessage: `Expected the body of the case to be evaluated, but it is not.`,
          },
        ],
      });
    }

    const caseEnv = body.$.env;
    caseEnvs.push(caseEnv);
  }

  // Check if the frame level is the same for all cases
  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i]!;
    if (caseEnv.frames.length - 1 !== maxFrameLevel) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: bodies[i]!.token,
            errorMessage: `Frame level is different for different cases.`,
          },
        ],
      });
    }
  }

  // Check each frame
  for (let i = 0; i <= maxFrameLevel; i++) {
    const frame = env.frames[i]!;
    const frameVariables = frame.variables;

    // Build the consumedAtToken matrix
    // that has 1 + caseEnvs.length rows
    // and frameVariables.length columns
    // each cell is consumedAtToken of the value
    const matrix: (Token | undefined)[][] = [[]];
    frameVariables.forEach((value) => {
      matrix[0]!.push(value.consumedAtToken);
    });

    for (let j = 0; j < caseEnvs.length; j++) {
      const caseEnv = caseEnvs[j]!;
      const caseEnvFrame = caseEnv.frames[i]!;
      const caseEnvFrameVariables = caseEnvFrame.variables;

      // Check if the number of variables is the same
      if (
        i !== maxFrameLevel &&
        frameVariables.length !== caseEnvFrameVariables.length
      ) {
        throw formatErrorMessages({
          tokenAndErrorList: [
            {
              token: bodies[j]!.token,
              errorMessage: `Frame level ${i} has different number of values for different cases.`,
            },
          ],
        });
      }

      // Check if the variable names are the same
      for (let k = 0; k < frameVariables.length; k++) {
        const frameVariable = frameVariables[k]!;
        const caseEnvFrameValue = caseEnvFrameVariables[k]!;
        if (frameVariable.name !== caseEnvFrameValue.name) {
          throw formatErrorMessages({
            tokenAndErrorList: [
              {
                token: bodies[j]!.token,
                errorMessage: `Frame level ${i} has different variable names for different cases.`,
              },
            ],
          });
        }
      }

      // TODO: Check type, but I think it's unnecessary here.

      // Check the consumedAtToken
      matrix.push([]);
      caseEnvFrameVariables.forEach((value) => {
        matrix[matrix.length - 1]!.push(value.consumedAtToken);
      });
    }

    // Check the matrix column to make sure that
    // for each variable:
    // 1. If there is only one case, and it's not consumed in env, but consumed in the case, then throw error.
    // 2. If have consumed in all cases, then set it as consumed in env.
    // 3. If some are consumed in some cases, then throw error.
    const rows = matrix.length;
    const cols = matrix[0]!.length;
    for (let i = 0; i < cols; i++) {
      const variableName = frameVariables[i]!.name;
      const tokens: (Token | undefined)[] = [];
      for (let j = 1; j < rows; j++) {
        tokens.push(matrix[j]![i]);
      }

      // Check the "Free" values.
      // If any case consumed (used) the "Free" value, then we set it as consumed in env.
      if (isFreeType(typeOfType(frameVariables[i]!.type))) {
        const consumed = tokens.filter((t) => !!t) as Token[];
        if (consumed.length > 0) {
          const newVariableValue: Variable = {
            ...frameVariables[i]!,
            consumedAtToken: tokens[0],
          };
          env = updateExistingVariable(
            env,
            frameVariables[i]!,
            newVariableValue
          );
        }
        continue;
      }

      // case 1
      if (tokens.length === 1) {
        if (!!tokens[0] && !frameVariables[i]!.consumedAtToken) {
          throw formatErrorMessages({
            tokenAndErrorList: [
              {
                token: frameVariables[i]!.token,
                errorMessage: `Variable "${variableName}" might not be consumed in all cases:`,
              },
              {
                token: tokens[0],
                errorMessage: `Might be consumed here:`,
              },
            ],
          });
        }
      }
      // case 2
      else if (tokens.every((t) => !!t)) {
        const newVariableValue: Variable = {
          ...frameVariables[i]!,
          consumedAtToken: tokens[0],
        };
        env = updateExistingVariable(env, frameVariables[i]!, newVariableValue);
      } else {
        // case 3
        const consumed = tokens.filter((t) => !!t) as Token[];
        const notConsumed = tokens.filter((t) => !t);
        if (consumed.length > 0 && notConsumed.length > 0) {
          throw formatErrorMessages({
            errorMessage: `Variable "${variableName}" might be consumed in some cases but not consumed in other cases:\n`,
            tokenAndErrorList: tokens.map((token, index) => {
              return {
                errorMessage: token
                  ? "Might be consumed here:"
                  : "Not consumed here:",
                token: token ?? bodies[index]!.token,
              };
            }),
          });
        }
      }
    }
  }

  // FIXME: This part of code is not correct.
  /*
  // Update the tempVariable to host the shortest lifetime
  const tempVariables = getEnvVariableValueByVariableName(
    env,
    tempVariableName
  );
  let tempVariable = tempVariables[0];
  // console.log("tempVariable: ", tempVariable);


  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i];
    const caseTempVariables = getEnvVariableValueByVariableName(
      caseEnv,
      tempVariableName
    );
    const caseTempVariable = caseTempVariables[0];
    if (caseTempVariable.referedVariable) {
      if (
        !tempVariable.referedVariable ||
        tempVariable.order < caseTempVariable.order
      ) {
        const newTempVariable: VariableValue = {
          ...tempVariable,
          referedVariable: caseTempVariable.referedVariable,
          order: caseTempVariable.order,
        };
        env = updateExistingVariableValue(env, tempVariable, newTempVariable);
        tempVariable = newTempVariable;
      }
    }
    // console.log("caseTempVariable: ", caseTempVariable);
  }
  */

  return env;
}
