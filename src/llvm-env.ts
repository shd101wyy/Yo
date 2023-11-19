import { FunctionExpr } from "./ast";
import { Type } from "./type-checker";

export type LlvmValue = {
  type: Type;
  value: llvm.Value;
  functionExpr?: FunctionExpr;
  function?: {
    typeArguments: Type[];
    value: llvm.Function;
  };
};

export type LlvmNamedValue = {
  id?: string;
  name: string;
  value: LlvmValue;
};
export type LlvmEnvironment = LlvmNamedValue[];

export function copyLlvmEnvironment(env: LlvmEnvironment) {
  return [...env];
}

export function addLlvmEnvironmentNamedValue(
  env: LlvmEnvironment,
  namedValue: LlvmNamedValue
): LlvmEnvironment {
  return [...env, namedValue];
}

export function getLlvmEnvironmentNamedValuesByName(
  env: LlvmEnvironment,
  name: string
): LlvmNamedValue[] {
  return env.filter((namedValue) => namedValue.name === name);
}

export function getLlvmEnvironmentNamedValuesById(
  env: LlvmEnvironment,
  id: string
): LlvmNamedValue[] {
  return env.filter((namedValue) => namedValue.id === id);
}

export function getLlvmFunctionByIdAndTypeArguments(
  env: LlvmEnvironment,
  id: string,
  typeArguments: Type[]
): LlvmNamedValue | undefined {
  return env.find(
    (namedValue) =>
      namedValue.id === id &&
      namedValue.value.function &&
      namedValue.value.function.typeArguments.length === typeArguments.length &&
      namedValue.value.function.typeArguments.length === typeArguments.length &&
      namedValue.value.function.typeArguments.every(
        (typeArgument, index) =>
          JSON.stringify(typeArgument) === JSON.stringify(typeArguments[index])
      )
  );
}

export function getLlvmFunctionById(
  env: LlvmEnvironment,
  id: string
): LlvmNamedValue | undefined {
  return env.find(
    (namedValue) => namedValue.id === id && !!namedValue.value.functionExpr
  );
}
