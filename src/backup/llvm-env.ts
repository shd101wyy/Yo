import { Expr, FunctionExpr, TraitExpr } from "../ast";
import { TFunction, Type, checkType } from "../type-checker";

export type LlvmValue = {
  variableName?: string;
  type: Type;
  value: llvm.Value;

  // for function
  functionExpr?: FunctionExpr;
  function?: {
    typeArguments: Type[];
    value: llvm.Function;
  };

  // for trait
  /**
   * If traitExpr is not undefined, then it's a trait definition.
   */
  traitExpr?: TraitExpr;
  /**
   * If trait is not undefined, then it's a trait implementation, aka instance.
   */
  trait?: {
    typeArguments: Type[];
    functions: {
      name: string;
      type: TFunction;
      functionExpr: FunctionExpr;
      value: llvm.Function;
    }[];
  };
};

export type LlvmFrame = LlvmValue[];
export type LlvmEnvironment = {
  frames: LlvmFrame[];
};

export function copyLlvmEnvironment(env: LlvmEnvironment): LlvmEnvironment {
  return {
    frames: [...env.frames],
  };
}

export function pushLlvmEnvFrame(
  env: LlvmEnvironment,
  frame: LlvmFrame = []
): LlvmEnvironment {
  return {
    frames: [...env.frames, frame],
  };
}

export function popLlvmEnvFrame(env: LlvmEnvironment): LlvmEnvironment {
  return {
    frames: env.frames.slice(0, -1),
  };
}

export function addLlvmFrameValue(
  frame: LlvmFrame,
  value: LlvmValue
): LlvmFrame {
  return [...frame, value];
}

export function addLlvmEnvValue(
  env: LlvmEnvironment,
  value: LlvmValue,
  deltaFrame = 0
): LlvmEnvironment {
  const frameLevel = env.frames.length - 1 + deltaFrame;
  const frame = env.frames[frameLevel];
  const newFrame = addLlvmFrameValue(frame, value);
  return {
    frames: env.frames.map((frame, index) =>
      index === frameLevel ? newFrame : frame
    ),
  };
}

export function getLlvmEnvValuesByName(
  env: LlvmEnvironment,
  name: string
): LlvmValue[] {
  const values: LlvmValue[] = [];
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const value = frame.find((value) => value.variableName === name);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

export function getLlvmFunctionByNameAndTypeArgumentsAndArguments(
  env: LlvmEnvironment,
  functionName: string,
  typeArguments: Type[],
  functionArguments: Expr[]
): LlvmValue | undefined {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const value = frame.find(
      (value) =>
        value.variableName === functionName &&
        value.function &&
        value.function.typeArguments.length === typeArguments.length &&
        value.function.typeArguments.every((typeArgument, index) =>
          checkType(typeArgument, typeArguments[index], value.functionExpr!.env)
        ) &&
        value.type.type === "Function" &&
        value.type.parameterTypes.length === functionArguments.length &&
        value.type.parameterTypes.every((parameterType, index) => {
          return checkType(
            parameterType.type,
            functionArguments[index].typeValue,
            value.functionExpr!.env
          );
        })
    );
    if (value) {
      return value;
    }
  }
}

export function getLlvmTraitInstanceByNameAndTypeArguments(
  env: LlvmEnvironment,
  className: string,
  typeArguments: Type[]
): LlvmValue | undefined {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const value = frame.find(
      (value) =>
        value.variableName === className &&
        value.type.type === "Class" &&
        value.trait &&
        value.trait.typeArguments.length === typeArguments.length &&
        value.trait.typeArguments.every((typeArgument, index) =>
          checkType(typeArgument, typeArguments[index], value.traitExpr!.env)
        )
    );
    if (value) {
      return value;
    }
  }
}

export function getLlvmFunctionExprByName(
  env: LlvmEnvironment,
  functionName: string,
  typeArguments: Type[],
  functionArguments: Expr[]
): FunctionExpr | undefined {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const value = frame.find(
      (value) =>
        value.variableName === functionName &&
        value.functionExpr &&
        value.functionExpr.typeValue.typeParameters.length ===
          typeArguments.length &&
        value.functionExpr.prototype.typeValue.parameterTypes.length ===
          functionArguments.length &&
        value.functionExpr.prototype.typeValue.parameterTypes.every(
          (parameterType, index) =>
            checkType(
              parameterType.type,
              functionArguments[index].typeValue,
              value.functionExpr!.env
            )
        )
    );
    if (value) {
      return value.functionExpr;
    }
  }
}
