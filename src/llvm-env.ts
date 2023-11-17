import { FunctionExpr } from "./ast";
import { Type } from "./type-checker";

export type LlvmValue = {
  type: Type;
  value: llvm.Value;
  typeArguments?: Type[];
};

export type LlvmNamedValue = {
  id?: string;
  name: string;
  value: LlvmValue;
  functionExpr?: FunctionExpr;
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
