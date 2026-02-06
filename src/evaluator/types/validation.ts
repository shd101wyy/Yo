import { formatErrorMessage } from "../../error";
import { BuiltinFunctions } from "../../expr";
import type { Token } from "../../token";
import type { ModuleField } from "../../types/definitions";
import { isFunctionType, isUnitType } from "../../types/guards";

/**
 * Validate that a dispose function has the correct signature: fn(self : Self) -> unit
 */
export function validateDisposeFunction(
  moduleElement: ModuleField,
  token: Token
): void {
  if (moduleElement.label !== BuiltinFunctions.dispose[0]) {
    return; // Not a dispose function, skip validation
  }

  if (isFunctionType(moduleElement.type)) {
    const funcType = moduleElement.type;
    if (
      funcType.parameters.length !== 1 ||
      funcType.forallParameters.length !== 0
    ) {
      throw formatErrorMessage({
        token,
        errorMessage: `The "dispose" function must have exactly one parameter of type "Self".`,
      });
    }

    // Check if the return type is unit
    if (!isUnitType(funcType.return.type)) {
      throw formatErrorMessage({
        token,
        errorMessage: `The "dispose" function must return "unit".`,
      });
    }
  } else {
    throw formatErrorMessage({
      token,
      errorMessage: `The "dispose" must be a function.`,
    });
  }
}
