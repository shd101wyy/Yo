import { Expr, FunctionExpr } from "./ast";
import { Type, checkType } from "./type-checker";

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

export function getLlvmFunctionByNameAndTypeArgumentsAndArguments(
  env: LlvmEnvironment,
  functionName: string,
  typeArguments: Type[],
  functionArguments: Expr[]
): LlvmNamedValue | undefined {
  return env.find(
    (namedValue) =>
      namedValue.name === functionName &&
      namedValue.value.type.type === "Function" &&
      namedValue.value.functionExpr &&
      namedValue.value.function &&
      namedValue.value.function.typeArguments.length === typeArguments.length &&
      namedValue.value.function.typeArguments.length === typeArguments.length &&
      namedValue.value.function.typeArguments.every(
        (typeArgument, index) =>
          JSON.stringify(typeArgument) === JSON.stringify(typeArguments[index])
      ) &&
      namedValue.value.type.parameterTypes.length ===
        functionArguments.length &&
      namedValue.value.type.parameterTypes.every((parameterType, index) => {
        return checkType(
          parameterType.type,
          functionArguments[index].typeValue,
          namedValue.value.functionExpr!.env
        );
      })
  );
}

export function getLlvmFunctionTemplateByName(
  env: LlvmEnvironment,
  functionName: string,
  typeArguments: Type[],
  functionArguments: Expr[]
) {
  return env.find(
    (namedValue) =>
      namedValue.name === functionName &&
      namedValue.value.functionExpr &&
      !namedValue.value.function &&
      namedValue.value.functionExpr.typeValue.typeParameters.length ===
        typeArguments.length &&
      namedValue.value.functionExpr.prototype.typeValue.parameterTypes
        .length === functionArguments.length &&
      namedValue.value.functionExpr.prototype.typeValue.parameterTypes.every(
        (parameterType, index) =>
          checkType(
            parameterType.type,
            functionArguments[index].typeValue,
            namedValue.value.functionExpr!.env
          )
      )
  );
}
