/**
 * Functions for looking up types from the environment.
 *
 * This file is separate from utils.ts to break circular dependencies.
 * These functions are used by both types/utils.ts and evaluator/trait-checking.ts.
 */

import { type Environment, getVariablesFromEnv } from "../env";
import type { TypeValue } from "../type-value";
import { isTypeValue } from "../value";
import { ValueTag } from "../value-tag";
import type { SomeType, TraitType, Type } from "./definitions";
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
  const definitionFrameLevel = someType.definitionFrameLevel;
  if (definitionFrameLevel !== undefined && definitionFrameLevel >= 0) {
    const frame = env.frames[definitionFrameLevel];
    if (frame) {
      const variable = frame.variables.find((value) => {
        return (
          value.name === someType.name &&
          value.value?.[0]?.tag === ValueTag.Type
        );
      });
      if (variable && variable.value) {
        const typeVal = variable.value[0] as TypeValue;
        // If found value is exactly THIS SomeType object, it's unbound
        if (typeVal.value === someType) {
          return someType;
        }
        // If found value is a SomeType with the same ID, it's unbound
        if (isSomeType(typeVal.value) && typeVal.value.id === someType.id) {
          return someType;
        }
        // If found value is a DIFFERENT SomeType (different ID), we have shadowing.
        // Fall through to normal search - there may be a newer binding in a higher frame.
        // Also fall through for concrete types — the normal search has ownership verification.
      }
    }
  }

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
      // NOTE: This might be SomeType defined from "generic"
      // So it doesn't exist in the env.
      return someType; // Return itself
    }

    someTypeValue = variables[variables.length - 1]!.value![0] as TypeValue;

    // If the resolved value is the same object as current someType, return it
    if (someTypeValue.value === someType) {
      return someType;
    }

    // If the resolved value is a different SomeType with the same name,
    // check if it's actually binding THIS SomeType or a different one.
    // This happens when we have shadowed variables with the same name but different SomeTypes.
    // In this case, we need to find the variable that was specifically bound to this SomeType.
    if (isSomeType(someTypeValue.value)) {
      // If the found SomeType has the same name but a different ID, this is a name collision
      // (e.g., parameter's Impl(Fn(...)) vs return type's Impl(Future(T)) both named "Impl").
      // Don't follow the chain — treat it like finding a concrete type and verify ownership.
      if (
        someTypeValue.value.name === someType.name &&
        someTypeValue.value.id !== someType.id
      ) {
        // Check if our SomeType was actually defined (self-bound) in the env.
        // If not, it's a freshly-created SomeType that shouldn't be resolved.
        let thisSomeTypeWasBound = false;
        for (let i = env.frames.length - 1; i >= 0; i--) {
          const frame = env.frames[i];
          if (!frame) continue;
          for (const variable of frame.variables) {
            if (variable.name === someType.name && variable.value) {
              const val = variable.value[0];
              if (val?.tag === ValueTag.Type) {
                const typeVal = val as TypeValue;
                if (typeVal.value === someType) {
                  thisSomeTypeWasBound = true;
                  break;
                }
              }
            }
          }
          if (thisSomeTypeWasBound) break;
        }
        if (!thisSomeTypeWasBound) {
          return someType;
        }
      }
      // The variable is bound to another SomeType - follow the chain
      someType = someTypeValue.value;
    } else {
      // The variable is bound to a concrete type (not a SomeType).
      // We need to verify this binding is actually FOR this specific SomeType.
      let thisSomeTypeWasBound = false;
      for (let i = env.frames.length - 1; i >= 0; i--) {
        const frame = env.frames[i];
        if (!frame) continue;
        for (const variable of frame.variables) {
          if (variable.name === someType.name && variable.value) {
            const val = variable.value[0];
            if (val?.tag === ValueTag.Type) {
              const typeVal = val as TypeValue;
              // Check if this variable's value IS this SomeType (self-referential binding)
              if (typeVal.value === someType) {
                thisSomeTypeWasBound = true;
                break;
              }
              // If we found a binding that is NOT for this SomeType (different ID),
              // and the bound value IS a SomeType, then this is a different SomeType
              // shadowing ours. Return our SomeType as unbound.
              if (
                isSomeType(typeVal.value) &&
                typeVal.value.id !== someType.id
              ) {
                return someType;
              }
            }
          }
        }
        if (thisSomeTypeWasBound) break;
      }

      // Fallback: if no self-referential binding was found, check definitionFrameLevel.
      // After synthesizeTypes, the self-referential binding (T=SomeType(T)) is replaced
      // with T=ConcreteType. Use definitionFrameLevel to verify the concrete binding
      // at the SomeType's original definition frame matches what the normal search found.
      if (
        !thisSomeTypeWasBound &&
        definitionFrameLevel !== undefined &&
        definitionFrameLevel >= 0 &&
        definitionFrameLevel < env.frames.length
      ) {
        const defFrame = env.frames[definitionFrameLevel];
        if (defFrame) {
          for (const variable of defFrame.variables) {
            if (variable.name === someType.name && variable.value) {
              const val = variable.value[0];
              if (val?.tag === ValueTag.Type) {
                const defTypeVal = val as TypeValue;
                // The variable at definitionFrameLevel has a concrete type that matches
                // what the normal search found. This confirms synthesizeTypes updated
                // the binding for THIS SomeType (definitionFrameLevel + name is unique).
                if (
                  !isSomeType(defTypeVal.value) &&
                  defTypeVal.value === someTypeValue!.value
                ) {
                  thisSomeTypeWasBound = true;
                }
              }
            }
          }
        }
      }

      // If THIS SomeType was never bound to itself anywhere in the env,
      // the concrete value we found must be for a different SomeType with the same name.
      // Return this SomeType as unbound.
      if (!thisSomeTypeWasBound) {
        return someType;
      }

      // This SomeType was bound, and we found its concrete binding. Use it.
      break;
    }
  } while (isSomeType(someType));
  return someTypeValue.value;
}
