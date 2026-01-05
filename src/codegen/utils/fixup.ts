import { DynType, Type } from "../../types";
import { extractFnModuleFromType } from "../../types/utils";
import { ModuleValue } from "../../value";
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
      moduleValues: ModuleValue[];
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
      const fnModule = extractFnModuleFromType(impl.concreteType);
      const fnModuleCName = fnModule
        ? context.types[fnModule.id]?.cName
        : undefined;
      return fnModuleCName || `unknown_${impl.concreteType.id}`;
    })();
    const newKey = `${concreteTypeCName}_${dynTypeCName}`;

    newDynImpls.set(newKey, impl);
  }

  context.dynImpls = newDynImpls;
}
