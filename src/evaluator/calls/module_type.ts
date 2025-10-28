import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import {
  areTypesCompatible,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import {
  createModuleValue,
  isFunctionValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext, ModuleTypeCallResult } from "../context";

export function tryToImplementModuleWithArgumentsByModuleType({
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
    throw formatErrorMessage({
      token: moduleExpr.token,
      errorMessage: `Failed to implement the module. Too many fields provided.`,
    });
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
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected identifier for label, got:\n${exprToString(labelExpr)}`,
          });
        }
        label = labelExpr.token.value;
      } else {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected member label, but got:\n${exprToString(argExpr)}`,
        });
      }

      // Check if label exists in the module type
      if (!moduleType.elements.find((e) => e.label === label)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Module member with label "${label}" does not exist in the module type.`,
        });
      }

      if (moduleElement.label === label) {
        foundArgExpr = true;

        if (moduleElement.assignedValue) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Module member "${
              moduleElement.label
            }" already has a assigned value:
${valueToString(moduleElement.assignedValue)}`,
          });
        }

        // evaluate the module member type again.
        // Check evaluateFunctionParameterTypeAgain function
        // They should be similar
        let moduleElementType: Type;
        const typeExpr = moduleElement.exprs.typeExpr;
        const defaultValueExpr = moduleElement.exprs.defaultValueExpr;
        if (typeExpr) {
          const evaluatedModuleMember = context.evaluateExpression({
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
          const evaluatedModuleMemberTypeValue = evaluatedModuleMember.$?.value;
          if (!isTypeValue(evaluatedModuleMemberTypeValue)) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the module member "${label}"`,
            });
          }
          moduleElementType = evaluatedModuleMemberTypeValue.value;
        } else if (defaultValueExpr) {
          const evaluatedValueExpr = context.evaluateExpression({
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
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the module member "${label}"`,
            });
          }
          moduleElementType = value.type;
        } else {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Module member "${label}" has no type or default value or assigned value.`,
          });
        }

        // evaluate the argExpr
        const evaluatedArgExpr = context.evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: moduleElementType, env: callerEnv },
            SelfType: context.SelfType,
          },
        });
        const argType = evaluatedArgExpr.$?.type;
        if (!argType) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the module member "${label}"`,
          });
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
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Type mismatch for the module member "${label}":
Expected: ${typeToString(moduleElementType)}
Got:   ${typeToString(argType)}`,
          });
        }
        const argValue = evaluatedArgExpr.$?.value;

        if (isFunctionValue(argValue)) {
          argValue.funcId += `_${moduleElement.label}`;
        }

        // Save the value to the members
        elements[i] = argValue;
        // Add to the env
        const { env: nextEnv } = addVariableToEnv({
          env: callerEnv,
          variable: {
            name: label,
            type: argType,
            isCompileTimeOnly: true,
            value: argValue,
            token: argExpr.token,
            initializedAtToken: argExpr.token,
            consumedAtToken: undefined,
          },
          skipCheckingFunctionOverloading: true,
        });
        callerEnv = nextEnv;

        // Add the type information to argExpr
        argExpr.$ = {
          env: callerEnv,
          type: argType,
          value: argValue,
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
        throw formatErrorMessage({
          token: moduleExpr.token,
          errorMessage: `Module member "${moduleElement.label}" is not provided and has no required/default value.`,
        });
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
          isCompileTimeOnly: true,
          value: defaultValue ?? assignedValue,
          token: moduleExpr.token,
          initializedAtToken: moduleExpr.token,
          consumedAtToken: undefined,
        },
      });
      callerEnv = nextEnv;
    }
  }

  callerEnv = popEnvFrame(callerEnv);

  // Check if the module value has "Self" element
  // If yes, set the typeValue as the assignedValue.
  const selfElementIndex = moduleType.elements.findIndex(
    (e) => e.label === "Self"
  );
  if (selfElementIndex >= 0) {
    const newModuleType: ModuleType = {
      ...moduleType,
      elements: moduleType.elements.map((e, index) => {
        if (index === selfElementIndex) {
          return {
            ...e,
            assignedValue: elements[index],
          };
        }
        return e;
      }),
    };
    moduleType = newModuleType;
  }

  // Create the module value
  const moduleValue = createModuleValue(moduleType, elements);
  return { moduleValue, callerEnv };
}
