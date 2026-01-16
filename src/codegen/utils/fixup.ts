import { DynType, Type } from "../../types";
import { extractFnTraitFromType } from "../../types/utils";
import { TraitValue } from "../../value";
import { CodeGenContext } from "./index";

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
      context.types[impl.dynType.id]?.cName || `yo_dyn_${impl.dynType.id}`;
    const concreteTypeCName = (() => {
      const direct = context.types[impl.concreteType.id]?.cName;
      if (direct) {
        return direct;
      }
      const fnTrait = extractFnTraitFromType(impl.concreteType);
      const fnTractCName = fnTrait
        ? context.types[fnTrait.id]?.cName
        : undefined;
      return fnTractCName || `unknown_${impl.concreteType.id}`;
    })();
    const newKey = `${concreteTypeCName}_${dynTypeCName}`;

    newDynImpls.set(newKey, impl);
  }

  context.dynImpls = newDynImpls;
}
