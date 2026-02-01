/**
 * Functions for looking up types from the environment.
 *
 * This file is separate from utils.ts to break circular dependencies.
 * These functions are used by both types/utils.ts and evaluator/trait-checking.ts.
 */

import { Environment, getVariablesFromEnv } from "../env";
import { TypeValue } from "../type-value";
import { isTypeValue } from "../value";
import { ValueTag } from "../value-tag";
import { SomeType, TraitType, Type } from "./definitions";
import { isSomeType, isTraitType } from "./guards";

/**
 * Get a trait type from the environment by name (e.g., "Comptime", "Runtime", "Send").
 * Returns undefined if not found.
 */
export function getTraitTypeFromEnv(
  env: Environment,
  traitName: string
): TraitType | undefined {
  const variables = getVariablesFromEnv(env, traitName);
  if (variables.length === 0) {
    return undefined;
  }
  const variable = variables[variables.length - 1]!;
  if (variable.value && isTypeValue(variable.value[0])) {
    const typeValue = variable.value[0] as TypeValue;
    if (isTraitType(typeValue.value)) {
      return typeValue.value;
    }
  }
  return undefined;
}

/**
 * Get the value of a SomeType from the environment.
 * Follows the chain of SomeType -> Type resolution.
 */
export function getValueOfSomeTypeFromEnv(
  env: Environment,
  someType: SomeType
): Type {
  let someTypeValue: TypeValue | undefined = undefined;
  // Track visited SomeTypes to detect cycles (e.g., A -> B -> A)
  const visited = new Set<SomeType>();

  do {
    // If we've already visited this SomeType, we have a cycle - return it as-is
    if (visited.has(someType)) {
      return someType;
    }
    visited.add(someType);

    const variables = getVariablesFromEnv(env, someType.name, (variable) => {
      return variable.value?.[0]?.tag === ValueTag.Type;
      // cannot use "isTypeValue" function here due to circular dependency
    });
    if (!variables.length) {
      // NOTE: This might be SomeType defined from "forall"
      // So it doesn't exist in the env.
      return someType; // Return itself
    }

    someTypeValue = variables[variables.length - 1]!.value![0] as TypeValue;

    // If the resolved value is the same object as current someType, return it
    if (someTypeValue.value === someType) {
      return someType;
    }
    if (isSomeType(someTypeValue.value)) {
      someType = someTypeValue.value;
    } else {
      break;
    }
  } while (isSomeType(someType));
  return someTypeValue.value;
}
