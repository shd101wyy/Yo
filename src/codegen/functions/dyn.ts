import { BuiltinFunctions } from "../../expr";
import type { FunctionType } from "../../types/definitions";
import {
  isBoxedType,
  isFnTraitType,
  isFunctionType,
  isPtrType,
  isSomeType,
  isVoidType,
} from "../../types/guards";
import { isFunctionValue, type Value } from "../../value";
import { getTypeString, sanitizeForCIdentifier } from "../utils";
import type { FunctionGenerationContext } from "./context";

/**
 * Generate dup/drop functions for dyn types
 */
export function generateDynDupDrop(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Track which dyn types we've generated dup/drop for
  const generatedTypes = new Set<string>();

  for (const [, impl] of context.dynImpls) {
    const dynTypeCName =
      context.types[impl.dynType.id]?.cName || `__yo_dyn_${impl.dynType.id}`;

    if (generatedTypes.has(dynTypeCName)) {
      continue;
    }
    generatedTypes.add(dynTypeCName);

    // Dup
    emitter.emitLine(
      `${dynTypeCName} __yo_dup_${dynTypeCName}(${dynTypeCName} dyn) {`
    );
    emitter.emitLine(`  if (dyn.data) {`);
    emitter.emitLine(`    __yo_incr_rc(dyn.data);`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`  return dyn;`);
    emitter.emitLine(`}`);
    emitter.emitLine("");

    // Drop
    emitter.emitLine(`void __yo_drop_${dynTypeCName}(${dynTypeCName} dyn) {`);
    emitter.emitLine(`  if (dyn.data) {`);
    emitter.emitLine(`    __yo_decr_rc(dyn.data);`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    emitter.emitLine("");
  }
}

/**
 * Generate box constructor and dispose functions for dyn implementations
 */
export function generateDynBoxFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  emitter.emitLine("");
  emitter.emitLine("// === Dyn Box Functions ===");
  emitter.emitLine("// Constructor and dispose functions for dyn boxes");
  emitter.emitLine("");

  const generatedBoxFunctions = new Set<string>();

  for (const [, impl] of context.dynImpls) {
    const resolvedConcreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;
    const concreteTypeCName =
      context.types[resolvedConcreteType.id]?.cName ||
      `unknown_${resolvedConcreteType.id}`;
    const boxTypeName = `__yo_dyn_box_${concreteTypeCName}`;

    if (generatedBoxFunctions.has(boxTypeName)) {
      continue;
    }
    generatedBoxFunctions.add(boxTypeName);

    const valueTypeStr = getTypeString(resolvedConcreteType, context);

    // Generate box constructor
    emitter.emitLine(
      `static ${boxTypeName}* __yo_new_${boxTypeName}(${valueTypeStr} value) {`
    );
    emitter.emitLine(
      `  ${boxTypeName}* box = (${boxTypeName}*)__yo_malloc(sizeof(${boxTypeName}));`
    );
    emitter.emitLine(`  box->header.ref_count = 1;`);
    emitter.emitLine(`  box->header.borrow_count = 0;`);
    if (context.needsCycleGC) {
      emitter.emitLine(`  box->header.gc_flags = 0;`);
      emitter.emitLine(`  box->header.gc_mark = __YO_GC_UNMARKED;`);
      emitter.emitLine(`  box->header.gc_next = NULL;`);
      emitter.emitLine(`  box->header.gc_prev = NULL;`);
    }
    const disposeNameDyn = `__yo_dispose_${boxTypeName}`;
    if (context.needsCycleGC) {
      emitter.emitLine(`  box->header.dispose_fn = ${disposeNameDyn};`);
    } else {
      // Type-tag dispatch for Dyn box
      if (!context.disposeTypeIds) {
        context.disposeTypeIds = new Map();
        context.nextDisposeTypeId = 1;
      }
      let typeId = context.disposeTypeIds.get(disposeNameDyn);
      if (typeId === undefined) {
        typeId = context.nextDisposeTypeId!;
        context.nextDisposeTypeId = typeId + 1;
        context.disposeTypeIds.set(disposeNameDyn, typeId);
      }
      emitter.emitLine(`  box->header.type_id = ${typeId};`);
    }
    if (context.needsCycleGC) {
      emitter.emitLine(
        `  box->header.traverse_fn = NULL; // TODO: Set if value contains GC types`
      );
    }
    emitter.emitLine(`  box->value = value;`);
    emitter.emitLine(`  return box;`);
    emitter.emitLine(`}`);
    emitter.emitLine("");

    // Generate box dispose
    emitter.emitLine(`static void __yo_dispose_${boxTypeName}(void* ptr) {`);
    emitter.emitLine(`  ${boxTypeName}* box = (${boxTypeName}*)ptr;`);

    const concreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;

    const dropFn = concreteType.trait?.fields.find(
      (field) => field.label === BuiltinFunctions.___drop[0]
    );
    if (
      dropFn &&
      dropFn.assignedValue &&
      isFunctionValue(dropFn.assignedValue)
    ) {
      const dropFnCName = context.functions[dropFn.assignedValue.funcId]?.cName;
      if (dropFnCName) {
        emitter.emitLine(`  ${dropFnCName}(box->value);`);
      }
    }

    emitter.emitLine(`}`);
    emitter.emitLine("");
  }
}

/**
 * Generate wrapper functions for dyn method dispatch
 */
export function generateDynWrapperFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn Wrapper Functions ===");
  emitter.emitDeclarationLine(
    "// Wrappers that unwrap boxed values and call impl methods"
  );
  emitter.emitDeclarationLine("");

  for (const [implKey, impl] of context.dynImpls) {
    const dataType = impl.dataType;
    const reservedDynMethodLabels = new Set<string>([
      BuiltinFunctions.___dup[0]!,
      BuiltinFunctions.___drop[0]!,
      BuiltinFunctions.___dispose[0]!,
      BuiltinFunctions.dispose[0]!,
    ]);

    // Handle Fn dyn with synthetic call slot
    for (const { traitType: requiredModule } of impl.dynType.requiredTraits) {
      if (!isFnTraitType(requiredModule)) {
        continue;
      }

      const callType = requiredModule.isFn.callType;
      const returnTypeStr = getTypeString(callType.return.type, context);
      const wrapperName = `__yo_wrap_${implKey}_call`;

      const params: string[] = ["void* self_ptr"];
      for (let i = 0; i < callType.parameters.length; i++) {
        const param = callType.parameters[i]!;
        const paramTypeStr = getTypeString(param.type, context);
        params.push(`${paramTypeStr} arg${i + 1}`);
      }

      emitter.emitDeclarationLine(
        `static ${returnTypeStr} ${wrapperName}(${params.join(", ")}) {`
      );

      if (isBoxedType(dataType)) {
        const boxedCName =
          context.types[dataType.id]?.cName || `unknown_${dataType.id}`;
        const fieldName = sanitizeForCIdentifier(dataType.fields[0]!.label);
        emitter.emitDeclarationLine(
          `  ${boxedCName}* box = (${boxedCName}*)self_ptr;`
        );

        const boxedValueType = dataType.fields[0]!.type;
        const captureType =
          isSomeType(boxedValueType) && boxedValueType.resolvedConcreteType
            ? boxedValueType.resolvedConcreteType
            : boxedValueType;
        const closureInfo = context.implClosureCallMap.get(captureType.id);
        const discoveredClosureCName = (() => {
          if (closureInfo) {
            return closureInfo.functionCName;
          }

          for (const [, entry] of Object.entries(context.functions)) {
            const fv = entry.value;
            const ci = fv.closureInfo;
            if (ci?.captureType?.id === captureType.id) {
              return entry.cName;
            }
          }
          return undefined;
        })();

        const callArgs: string[] = [];
        if (discoveredClosureCName) {
          callArgs.push(`(void*)&box->${fieldName}`);
          for (let i = 0; i < callType.parameters.length; i++) {
            callArgs.push(`arg${i + 1}`);
          }

          if (isVoidType(callType.return.type)) {
            emitter.emitDeclarationLine(
              `  ${discoveredClosureCName}(${callArgs.join(", ")});`
            );
          } else {
            emitter.emitDeclarationLine(
              `  return ${discoveredClosureCName}(${callArgs.join(", ")});`
            );
          }
        } else {
          callArgs.push(`box->${fieldName}.data`);
          for (let i = 0; i < callType.parameters.length; i++) {
            callArgs.push(`arg${i + 1}`);
          }

          if (isVoidType(callType.return.type)) {
            emitter.emitDeclarationLine(
              `  box->${fieldName}.call(${callArgs.join(", ")});`
            );
          } else {
            emitter.emitDeclarationLine(
              `  return box->${fieldName}.call(${callArgs.join(", ")});`
            );
          }
        }
      } else {
        emitter.emitDeclarationLine(
          `  (void)self_ptr; /* Dyn(Fn): expected Box(...) data */`
        );
        for (let i = 0; i < callType.parameters.length; i++) {
          emitter.emitDeclarationLine(`  (void)arg${i + 1};`);
        }
        if (isVoidType(callType.return.type)) {
          emitter.emitDeclarationLine(`  return;`);
        } else {
          emitter.emitDeclarationLine(
            `  ${returnTypeStr} zero = (${returnTypeStr})0;`
          );
          emitter.emitDeclarationLine(`  return zero;`);
        }
      }

      emitter.emitDeclarationLine(`}`);
      emitter.emitDeclarationLine("");
    }

    // Regular dyn method wrappers (non-Fn traits)
    for (
      let moduleIndex = 0;
      moduleIndex < impl.dynType.requiredTraits.length;
      moduleIndex++
    ) {
      const { traitType: requiredTraitType } =
        impl.dynType.requiredTraits[moduleIndex]!;

      if (isFnTraitType(requiredTraitType)) {
        continue;
      }

      const moduleValue = impl.traitValues[moduleIndex];
      if (!moduleValue) {
        emitter.emitDeclarationLine(
          `/* Warning: Module value missing for module ${moduleIndex} */`
        );
        continue;
      }

      const sourceNamespaceType = moduleValue.type;
      const recordFields = sourceNamespaceType.fields;

      for (let i = 0; i < recordFields.length; i++) {
        const field = recordFields[i]!;

        if (field.label === "Self") {
          continue;
        }

        if (reservedDynMethodLabels.has(field.label)) {
          continue;
        }

        const fieldValue: Value | undefined = moduleValue.fields[i];

        if (!fieldValue || !isFunctionValue(fieldValue)) {
          emitter.emitDeclarationLine(
            `/* Warning: Module field ${field.label} is not a function value */`
          );
          continue;
        }

        const funcType = field.type;
        if (!isFunctionType(funcType)) {
          emitter.emitDeclarationLine(
            `/* Warning: Module field ${field.label} is not a function type */`
          );
          continue;
        }

        const implFuncId = fieldValue.funcId;
        const implFuncCName = context.functions[implFuncId]?.cName;
        if (!implFuncCName) {
          emitter.emitDeclarationLine(
            `/* Warning: Impl function for ${field.label} not found */`
          );
          continue;
        }

        const wrapperName = `__yo_wrap_${implKey}_${field.label}`;
        const returnTypeStr = getTypeString(funcType.return.type, context);
        const params = ["void* self_ptr"];
        for (let j = 1; j < funcType.parameters.length; j++) {
          const param = funcType.parameters[j]!;
          const paramTypeStr = getTypeString(param.type, context);
          params.push(`${paramTypeStr} arg${j}`);
        }

        emitter.emitDeclarationLine(
          `static ${returnTypeStr} ${wrapperName}(${params.join(", ")}) {`
        );

        const implFirstParam = funcType.parameters[0];
        const implFirstParamType = implFirstParam?.type;
        // The wrapped impl method may take its receiver either as a raw
        // `*(Self)` pointer (PtrType in the AST) or as a `ref(self) :
        // Self` parameter — which the codegen also lowers to `Self*` in
        // C, but is represented in the AST as a non-pointer type with
        // `isRef: true`. Both need the same `&box->field` / `&concrete`
        // address-of treatment; otherwise we'd pass the struct by value
        // to a pointer-typed parameter and the C compiler rejects it.
        const passByPointer =
          (implFirstParamType && isPtrType(implFirstParamType)) ||
          implFirstParam?.isRef === true;
        let firstArg: string;

        if (isBoxedType(dataType)) {
          const boxedCName =
            context.types[dataType.id]?.cName || `unknown_${dataType.id}`;
          const fieldName = sanitizeForCIdentifier(dataType.fields[0]!.label);
          emitter.emitDeclarationLine(
            `  ${boxedCName}* box = (${boxedCName}*)self_ptr;`
          );

          if (passByPointer) {
            firstArg = `&box->${fieldName}`;
          } else {
            firstArg = `box->${fieldName}`;
          }
        } else {
          const concreteTypeStr = getTypeString(impl.concreteType, context);
          emitter.emitDeclarationLine(
            `  ${concreteTypeStr} concrete_value = (${concreteTypeStr})self_ptr;`
          );

          if (passByPointer) {
            firstArg = `&concrete_value`;
          } else {
            firstArg = `concrete_value`;
          }
        }

        const args = [firstArg];
        for (let j = 1; j < funcType.parameters.length; j++) {
          args.push(`arg${j}`);
        }

        if (isVoidType(funcType.return.type)) {
          emitter.emitDeclarationLine(
            `  ${implFuncCName}(${args.join(", ")});`
          );
        } else {
          emitter.emitDeclarationLine(
            `  return ${implFuncCName}(${args.join(", ")});`
          );
        }

        emitter.emitDeclarationLine(`}`);
        emitter.emitDeclarationLine("");
      }
    }
  }
}

/**
 * Generate static vtables for dyn implementations
 */
export function generateDynVtables(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  // Generate unique type-id statics per concrete type
  // Each concrete type gets a unique static variable whose address serves as the TypeId
  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn TypeId Statics ===");
  emitter.emitDeclarationLine(
    "// Unique static per concrete type — address is the runtime TypeId"
  );
  emitter.emitDeclarationLine("");

  const generatedTypeIds = new Set<string>();
  if (!context.typeIdStatics) {
    context.typeIdStatics = new Map();
  }
  for (const [, impl] of context.dynImpls) {
    const resolvedConcreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;
    const concreteTypeCName =
      context.types[resolvedConcreteType.id]?.cName ||
      `unknown_${resolvedConcreteType.id}`;
    const typeIdName = `__yo_typeid_${concreteTypeCName}`;
    if (
      !generatedTypeIds.has(typeIdName) &&
      !context.typeIdStatics.has(resolvedConcreteType.id)
    ) {
      generatedTypeIds.add(typeIdName);
      context.typeIdStatics.set(resolvedConcreteType.id, typeIdName);
      emitter.emitDeclarationLine(
        `static const char ${typeIdName} = 0; // TypeId for ${concreteTypeCName}`
      );
    }
  }

  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn Static Vtables ===");
  emitter.emitDeclarationLine("// Static vtables for dynamic dispatch");
  emitter.emitDeclarationLine("");

  for (const [implKey, impl] of context.dynImpls) {
    const dynTypeCName =
      context.types[impl.dynType.id]?.cName || `__yo_dyn_${impl.dynType.id}`;
    const resolvedConcreteType2 =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;
    const concreteTypeCName =
      context.types[resolvedConcreteType2.id]?.cName ||
      `unknown_${resolvedConcreteType2.id}`;
    const vtableName = `__yo_vtable_${implKey}`;
    const vtableTypeName = `${dynTypeCName}_vtable`;
    const typeIdName = `__yo_typeid_${concreteTypeCName}`;

    emitter.emitDeclarationLine(
      `// Vtable for impl(${concreteTypeCName}, ${impl.dynType.requiredTraits.map(({ traitType }) => traitType.typeName || "?").join(" + ")})`
    );
    emitter.emitDeclarationLine(
      `static const ${vtableTypeName} ${vtableName} = {`
    );

    // TypeId — always first field
    emitter.emitDeclarationLine(`  .__yo_type_id = (uintptr_t)&${typeIdName},`);

    const processedMethods = new Set<string>();
    const reservedDynMethodLabels = new Set<string>([
      BuiltinFunctions.___dup[0]!,
      BuiltinFunctions.___drop[0]!,
      BuiltinFunctions.___dispose[0]!,
      BuiltinFunctions.dispose[0]!,
    ]);

    for (const { traitType } of impl.dynType.requiredTraits) {
      if (isFnTraitType(traitType)) {
        const wrapperName = `__yo_wrap_${implKey}_call`;
        emitter.emitDeclarationLine(`  .call = ${wrapperName},`);
        processedMethods.add("call");
        continue;
      }

      for (const field of traitType.fields) {
        if (field.label === "Self") {
          continue;
        }

        if (reservedDynMethodLabels.has(field.label)) {
          continue;
        }

        if (processedMethods.has(field.label)) {
          continue;
        }
        processedMethods.add(field.label);

        if (isFunctionType(field.type)) {
          const functionType = field.type as FunctionType;
          if (functionType.parameters.length > 0) {
            const firstParam = functionType.parameters[0];
            if (firstParam && firstParam.label === "self") {
              const wrapperName = `__yo_wrap_${implKey}_${field.label}`;
              emitter.emitDeclarationLine(
                `  .${sanitizeForCIdentifier(field.label)} = ${wrapperName},`
              );
            }
          }
        }
      }
    }

    emitter.emitDeclarationLine(`};`);
    emitter.emitDeclarationLine("");
  }
}
