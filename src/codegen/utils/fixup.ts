import { extractFnTraitFromType } from "../../evaluator/trait-checking";
import type { DynType, Type } from "../../types/definitions";
import { isSomeType } from "../../types/guards";
import type { TraitValue } from "../../value";
import type { CodeGenContext } from "./index";

/**
 * Fix up dyn impl keys to use C names instead of IDs.
 * This should be called after type generation when C names are available.
 */
export function fixupDynImplKeys(context: CodeGenContext): void {
  const newDynImpls = new Map<
    string,
    {
      dynType: DynType;
      concreteType: Type;
      dataType: Type;
      traitValues: TraitValue[];
    }
  >();

  for (const [, impl] of context.dynImpls) {
    const dynTypeCName =
      context.types[impl.dynType.id]?.cName || `__yo_dyn_${impl.dynType.id}`;
    // Resolve SomeType to its concrete type for name lookup
    const resolvedConcreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;
    const concreteTypeCName = (() => {
      const direct = context.types[resolvedConcreteType.id]?.cName;
      if (direct) {
        return direct;
      }
      const fnTrait = extractFnTraitFromType(resolvedConcreteType);
      const fnTractCName = fnTrait
        ? context.types[fnTrait.id]?.cName
        : undefined;
      return fnTractCName || `unknown_${resolvedConcreteType.id}`;
    })();
    const newKey = `${concreteTypeCName}_${dynTypeCName}`;

    newDynImpls.set(newKey, impl);
  }

  context.dynImpls = newDynImpls;
}
