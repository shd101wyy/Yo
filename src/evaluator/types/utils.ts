import { Environment, isEvaluatingPreludeModule } from "../../env";
import {
  BuiltinFunctions,
  Expr,
  exprIsFunctionCall,
  exprToString,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  ClosureType,
  DynType,
  EnumType,
  FutureType,
  isFunctionType,
  isRcType,
  ModuleField,
  StructType,
  typeContainsRcType,
  typeOfType,
  typeToString,
} from "../../types";
import { isFunctionValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Helper function to parse and evaluate a Yo code string in the context of a SelfType
 */
function parseAndEvaluateExprCode(
  code: string,
  SelfType: StructType | EnumType | DynType | ClosureType | FutureType,
  env: Environment,
  context: EvaluatorContext
): { expr: Expr; env: Environment } {
  const expr = generateExprFromCode(code);

  // Evaluate the expression with the struct as the SelfType
  const evaluatedExpr = evaluateExpression({
    expr,
    env,
    context: {
      ...context,
      SelfType: SelfType,
    },
  });

  if (!evaluatedExpr.$) {
    throw new Error(
      `Failed to evaluate auto-generated expression: ${exprToString(expr)}`
    );
  }

  return { expr: evaluatedExpr, env: evaluatedExpr.$.env };
}

export function addFunctionSignatureToSelfTypeModule({
  label,
  functionSignature,
  SelfType,
  env,
  context,
}: {
  /**
   * eg, ___dup, ___drop, ___dispose
   */
  label: string;
  /**
   * Function code string, like (fn()-> unit)
   */
  functionSignature: string;
  SelfType: StructType | EnumType | DynType | ClosureType | FutureType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  const { expr: functionExpr, env: nextEnv } = parseAndEvaluateExprCode(
    functionSignature,
    SelfType,
    env,
    context
  );
  if (exprIsFunctionCall(functionExpr)) {
    if (
      functionExpr.$ &&
      functionExpr.$.value &&
      isTypeValue(functionExpr.$.value) &&
      isFunctionType(functionExpr.$.value.value)
    ) {
      const functionType = functionExpr.$.value.value;

      // Add the drop function to the struct's module fields
      const moduleField: ModuleField = {
        label: label,
        type: functionType,
        assignedValue: undefined, // NOTE: We have to use the `undefined` here.
        isCompileTimeOnly: true,
        exprs: {
          expr: functionExpr,
          labelExpr: functionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: undefined,
        },
      };
      const index = SelfType.module.fields.findIndex(
        (el) => el.label === label
      );
      if (index >= 0) {
        SelfType.module.fields[index] = moduleField;
        // return env; // No need to update. Don't throw error.
      } else {
        // Add new field
        SelfType.module.fields.push(moduleField);
      }
    }
  }

  return nextEnv;
}

export function addFunctionCodeToSelfTypeModule({
  label,
  functionCode,
  SelfType,
  env,
  context,
}: {
  /**
   * eg, ___dup, ___drop, ___dispose
   */
  label: string;
  /**
   * Function code string, like ((fn()-> unit) { return (); })
   */
  functionCode: string;
  SelfType: StructType | EnumType | DynType | ClosureType | FutureType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  const { expr: functionExpr, env: nextEnv } = parseAndEvaluateExprCode(
    functionCode,
    SelfType,
    env,
    context
  );
  if (exprIsFunctionCall(functionExpr)) {
    if (
      functionExpr.$ &&
      functionExpr.$.value &&
      isFunctionValue(functionExpr.$.value)
    ) {
      // The code below is necessary for the C code generator to make the ___drop like function to have a more descriptive name.
      functionExpr.$.value.funcId += label;

      // Add the drop function to the struct's module fields
      const moduleField: ModuleField = {
        label: label,
        type: functionExpr.$.type,
        assignedValue: functionExpr.$.value,
        isCompileTimeOnly: true,
        exprs: {
          expr: functionExpr,
          labelExpr: functionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: functionExpr,
        },
      };
      const index = SelfType.module.fields.findIndex(
        (el) => el.label === label
      );
      if (index >= 0) {
        // Replace existing field
        SelfType.module.fields[index] = moduleField;
      } else {
        // Add new field
        SelfType.module.fields.push(moduleField);
      }
    }
  }

  return nextEnv;
}

export const DisposeFnSignature = "(fn(self : Self) -> unit)";
export const DropFnSignature = "(fn(self : Self) -> unit)";
export const DupFnSignature = "(fn(self : Self) -> Self)";

/**
 * Generate ___dispose function code for a struct type
 */
function generateDisposeFunctionCodeForStructType(structType: StructType): {
  signature: string;
  code: string;
} {
  const signature = DisposeFnSignature;
  if (!isRcType(structType)) {
    // return null; // no need to generate ___dispose function
    return { signature, code: `(${signature} ())` };
  }
  const destructurings = structType.fields
    .filter(
      (field) => !field.isCompileTimeOnly && typeContainsRcType(field.type)
    )
    .map((field) => field.label);

  const hasDisposeFunction = structType.module.fields.some(
    (field) => field.label === BuiltinFunctions.dispose[0]
  );

  if (!destructurings.length && !hasDisposeFunction) {
    // return null; // no need to generate ___dispose function
    return { signature, code: `(${signature} ())` };
  }

  const dropDestructuringsExpr = destructurings.length
    ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___drop[0]!})(${label});`).join("\n")}
`
    : "";

  return {
    signature,
    code: `(${signature} { // ___dispose
      ${hasDisposeFunction ? "Self.dispose(self);" : ""}
      ${dropDestructuringsExpr}
      return ();
  })`,
  };
}

/**
 * Generate ___drop function code for a struct type
 */
function generateDropFunctionCodeForStructType(structType: StructType): {
  signature: string;
  code: string;
} {
  const signature = DropFnSignature;
  const destructurings = structType.fields
    .filter(
      (field) => !field.isCompileTimeOnly && typeContainsRcType(field.type)
    )
    .map((field) => field.label);

  const decrRcExpr = isRcType(structType)
    ? `
  ${BuiltinFunctions.__yo_decr_rc[0]!}(self);`
    : "";

  const dropDestructuringsExpr = isRcType(structType)
    ? ""
    : destructurings.length
      ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___drop[0]!})(${label});`).join("\n")}
`
      : "";

  return {
    signature,
    code: `(${signature} { // ___drop
  ${dropDestructuringsExpr}
  ${decrRcExpr}
  return ();
})`,
  };
}

/**
 * Generate ___dup function code for a struct type
 */
function generateDupFunctionCodeForStructType(structType: StructType): {
  signature: string;
  code: string;
} {
  const signature = DupFnSignature;
  const destructurings = structType.fields
    .filter(
      (field) => !field.isCompileTimeOnly && typeContainsRcType(field.type)
    )
    .map((field) => field.label);

  const incrRcExpr = isRcType(structType)
    ? `
  ${BuiltinFunctions.__yo_incr_rc[0]!}(self);`
    : "";

  const dupDestructuringsExpr = isRcType(structType)
    ? ""
    : destructurings.length
      ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___dup[0]!})(${label});`).join("\n")}
`
      : "";

  return {
    signature,
    code: `(${signature} {  // ___dup
  ${dupDestructuringsExpr}
  ${incrRcExpr}
  return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
})`,
  };
}

/**
 * Helper function to add ARC-related functions (___drop, ___dup, ___dispose) to a struct type
 * This should be called after all struct fields are processed and the struct type is complete
 */
export function addARCFunctionsToStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  typeOfType(structType); // Ensure no invalid recursive type

  // Auto-generate ___drop and ___dup function if it's needed
  const { code: disposeFunctionCode } =
    generateDisposeFunctionCodeForStructType(structType);
  const { code: dropFunctionCode } =
    generateDropFunctionCodeForStructType(structType);
  const { code: dupFunctionCode } =
    generateDupFunctionCodeForStructType(structType);

  /// console.log("struct dispose: ", disposeFunctionCode);
  /// console.log("struct drop: ", dropFunctionCode);
  /// console.log("struct dup: ", dupFunctionCode);

  addARCFunctionSignaturesToStructType({ structType, env, context });

  // Add ___dispose function
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dispose[0]!,
    functionCode: disposeFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  // Add ___drop function to the struct type module fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  // Add ___dup function to the struct type module fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  return env;
}

export function addARCFunctionSignaturesToStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}) {
  // NOTE: We need to add signature to the struct module first, to support recursive calls
  // Like
  //    List :: object
  //      head : i32,
  //      tail : Self // ___dispose will need to call tail.___drop()
  //    ;
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___dispose[0]!,
    functionSignature: DisposeFnSignature,
    SelfType: structType,
    env,
    context,
  });
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionSignature: DropFnSignature,
    SelfType: structType,
    env,
    context,
  });
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionSignature: DupFnSignature,
    SelfType: structType,
    env,
    context,
  });
}

/**
 * Generate ___dispose function code for an enum type
 */
/*
function generateDisposeFunctionCodeForEnumType(enumType: EnumType): {
  signature: string;
  code: string;
} {
  const signature = DisposeFnSignature;
  if (!isRcType(enumType)) {
    return { signature, code: `(${signature} ())` };
  }

  const hasDisposeFunction = enumType.module.fields.some(
    (field) => field.label === BuiltinFunctions.dispose[0]
  );

  const variantsWithARCTypes = enumType.variants.filter(
    (variant) =>
      variant.fields &&
      variant.fields.some((field) => typeContainsRcType(field.type))
  );

  if (!variantsWithARCTypes.length && !hasDisposeFunction) {
    return { signature, code: `(${signature} ())` };
  }

  const matchCases = variantsWithARCTypes
    .map((variant) => {
      const destructurings = variant
        .fields!.filter(
          (field) =>
            !field.isCompileTimeOnly && typeContainsRcType(field.type)
        )
        .map((field) => field.label);

      const paramList = variant
        .fields!.map((field) => field.label)
        .join(", ");
      const dropStatements = destructurings
        .map((label) => `      (${BuiltinFunctions.___drop[0]!})(${label});`)
        .join("\n");

      return `.${variant.name}(${paramList}) => {
${dropStatements}
    }`;
    })
    .join(",\n    ");

  const defaultCase =
    variantsWithARCTypes.length === enumType.variants.length
      ? ""
      : ",\n    _ => ()";

  return {
    signature,
    code: `(${signature} { // ___dispose
      ${hasDisposeFunction ? "Self.dispose(self);" : ""}
      match(self,
        ${matchCases}${defaultCase}
      );
      return ();
  })`,
  };
}
*/

/**
 * Generate ___drop function code for an enum type
 */
function generateDropFunctionCodeForEnumType(enumType: EnumType): {
  signature: string;
  code: string;
} {
  const signature = DropFnSignature;

  const variantsWithARCTypes = enumType.variants.filter(
    (variant) =>
      variant.fields &&
      variant.fields.some((field) => typeContainsRcType(field.type))
  );

  const decrRcExpr = isRcType(enumType)
    ? `
  ${BuiltinFunctions.__yo_decr_rc[0]!}(self);`
    : "";

  const dropVariantsExpr = isRcType(enumType)
    ? ""
    : variantsWithARCTypes.length
      ? `
  match(self,
    ${variantsWithARCTypes
      .map((variant) => {
        const destructurings = variant
          .fields!.filter(
            (field) =>
              !field.isCompileTimeOnly && typeContainsRcType(field.type)
          )
          .map((field) => field.label);

        const paramList = variant
          .fields!.map((field) => field.label)
          .join(", ");
        const dropStatements = destructurings
          .map((label) => `      (${BuiltinFunctions.___drop[0]!})(${label});`)
          .join("\n");

        return `.${variant.name}(${paramList}) => {
${dropStatements}
    }`;
      })
      .join(",\n    ")}${
      variantsWithARCTypes.length === enumType.variants.length
        ? ""
        : ",\n    _ => ()"
    }
  );`
      : "";

  return {
    signature,
    code: `(${signature} { // ___drop
  ${dropVariantsExpr}
  ${decrRcExpr}
  return ();
})`,
  };
}

/**
 * Generate ___dup function code for an enum type
 */
function generateDupFunctionCodeForEnumType(enumType: EnumType): {
  signature: string;
  code: string;
} {
  const signature = DupFnSignature;

  const variantsWithARCTypes = enumType.variants.filter(
    (variant) =>
      variant.fields &&
      variant.fields.some((field) => typeContainsRcType(field.type))
  );

  const incrRcExpr = isRcType(enumType)
    ? `
  ${BuiltinFunctions.__yo_incr_rc[0]!}(self);`
    : "";

  const dupVariantsExpr = isRcType(enumType)
    ? ""
    : variantsWithARCTypes.length
      ? `
  match(self,
    ${variantsWithARCTypes
      .map((variant) => {
        const destructurings = variant
          .fields!.filter(
            (field) =>
              !field.isCompileTimeOnly && typeContainsRcType(field.type)
          )
          .map((field) => field.label);

        const paramList = variant
          .fields!.map((field) => field.label)
          .join(", ");
        const dupStatements = destructurings
          .map((label) => `      (${BuiltinFunctions.___dup[0]!})(${label});`)
          .join("\n");

        return `.${variant.name}(${paramList}) => {
${dupStatements}
    }`;
      })
      .join(",\n    ")}${
      variantsWithARCTypes.length === enumType.variants.length
        ? ""
        : ",\n    _ => ()"
    }
  );`
      : "";

  return {
    signature,
    code: `(${signature} {  // ___dup
  ${dupVariantsExpr}
  ${incrRcExpr}
  return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
})`,
  };
}

/**
 * Helper function to add ARC-related functions (___drop, ___dup, ___dispose) to an enum type
 * This should be called after all enum variants are processed and the enum type is complete
 */
export function addARCFunctionsToEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  typeOfType(enumType); // Ensure no invalid recursive type

  // Auto-generate ___drop, ___dup, and ___dispose functions if needed
  // const { code: disposeFunctionCode } =
  //   generateDisposeFunctionCodeForEnumType(enumType);
  const { code: dropFunctionCode } =
    generateDropFunctionCodeForEnumType(enumType);
  const { code: dupFunctionCode } =
    generateDupFunctionCodeForEnumType(enumType);

  /// console.log("enum dispose: ", disposeFunctionCode);
  /// console.log("enum drop: ", dropFunctionCode);
  /// console.log("enum dup: ", dupFunctionCode);

  addARCFunctionSignaturesToEnumType({ enumType, env, context });

  // Add ___dispose function
  // env = addFunctionCodeToSelfTypeModule({
  //   label: BuiltinFunctions.___dispose[0]!,
  //   functionCode: disposeFunctionCode,
  //   SelfType: enumType,
  //   env,
  //   context,
  // });

  // Add ___drop function to the enum type module fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: enumType,
    env,
    context,
  });

  // Add ___dup function to the enum type module fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: enumType,
    env,
    context,
  });

  return env;
}

export function addARCFunctionSignaturesToEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}) {
  // Add function signatures to the enum module first, to support recursive calls
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___dispose[0]!,
    functionSignature: DisposeFnSignature,
    SelfType: enumType,
    env,
    context,
  });
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionSignature: DropFnSignature,
    SelfType: enumType,
    env,
    context,
  });
  addFunctionSignatureToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionSignature: DupFnSignature,
    SelfType: enumType,
    env,
    context,
  });
}

/**
 * Add ARC functions (___dup, ___drop) to a dyn type's module.
 * These functions operate on the dyn wrapper itself, not the wrapped object.
 */
export function addARCFunctionsToDynType({
  dynType,
  env,
  context,
}: {
  dynType: DynType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate ARC functions for the dyn wrapper
  const dropFunctionCode = generateDropFunctionCodeForDynType(dynType);
  const dupFunctionCode = generateDupFunctionCodeForDynType(dynType);

  // Add ___dup function to the dyn type module fields
  if (dupFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: dynType,
      env,
      context,
    });
  }

  // Add ___drop function to the dyn type module fields
  if (dropFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___drop[0]!,
      functionCode: dropFunctionCode,
      SelfType: dynType,
      env,
      context,
    });
  }

  return env;
}

/**
 * Generate ___drop function code for a dyn type
 */
function generateDropFunctionCodeForDynType(_dynType: DynType): string {
  // For dyn types, drop should use __yo_dyn_drop
  // This builtin function handles both the wrapped object cleanup and reference counting
  return `((fn(self : Self) -> unit) { // ___drop for ${typeToString(_dynType)}
    ${BuiltinFunctions.__yo_dyn_drop[0]!}(self);
  })`;
}

/**
 * Generate ___dup function code for a dyn type
 */
function generateDupFunctionCodeForDynType(_dynType: DynType): string {
  // For dyn types, dup should use __yo_dyn_dup
  // This builtin function handles the dyn reference counting properly
  return `((fn(self : Self) -> Self) {  // ___dup for ${typeToString(_dynType)}
    ${BuiltinFunctions.__yo_dyn_dup[0]!}(self);
    return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
  })`;
}

/**
 * Add ARC functions (___dup, ___drop) to a closure type's module.
 * These functions operate on the closure itself and its captured data.
 */
export function addARCFunctionsToClosureType({
  closureType,
  env,
  context,
}: {
  closureType: ClosureType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate ARC functions for the closure
  const dropFunctionCode = generateDropFunctionCodeForClosureType(closureType);
  const dupFunctionCode = generateDupFunctionCodeForClosureType(closureType);

  // Add ___dup function to the closure type module fields
  if (dupFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: closureType,
      env,
      context,
    });
  }

  // Add ___drop function to the closure type module fields
  if (dropFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___drop[0]!,
      functionCode: dropFunctionCode,
      SelfType: closureType,
      env,
      context,
    });
  }

  return env;
}

/**
 * Generate ___drop function code for a closure type
 */
function generateDropFunctionCodeForClosureType(
  _closureType: ClosureType
): string {
  // For closure types, drop should use __yo_closure_drop
  // This builtin function handles both the captured data cleanup and reference counting
  return `((fn(self : Self) -> unit) { // ___drop for ${typeToString(_closureType)}
    ${BuiltinFunctions.__yo_closure_drop[0]!}(self);
  })`;
}

/**
 * Generate ___dup function code for a closure type
 */
function generateDupFunctionCodeForClosureType(
  _closureType: ClosureType
): string {
  // For closure types, dup should use __yo_closure_dup
  // This builtin function handles the closure reference counting properly
  return `((fn(self : Self) -> Self) {  // ___dup for ${typeToString(_closureType)}
    ${BuiltinFunctions.__yo_closure_dup[0]!}(self);
    return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
  })`;
}

/**
 * Add ARC functions (___dup, ___drop) to a future type's module.
 * These functions operate on the future object itself.
 */
export function addARCFunctionsToFutureType({
  futureType,
  env,
  context,
}: {
  futureType: FutureType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate ARC functions for the future
  const dropFunctionCode = generateDropFunctionCodeForFutureType(futureType);
  const dupFunctionCode = generateDupFunctionCodeForFutureType(futureType);

  // Add ___dup function to the future type module fields
  if (dupFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: futureType,
      env,
      context,
    });
  }

  // Add ___drop function to the future type module fields
  if (dropFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___drop[0]!,
      functionCode: dropFunctionCode,
      SelfType: futureType,
      env,
      context,
    });
  }

  return env;
}

/**
 * Generate ___drop function code for a future type
 */
function generateDropFunctionCodeForFutureType(futureType: FutureType): string {
  // For future types, drop should use __yo_future_drop
  // This builtin function handles future cleanup and reference counting
  return `((fn(self : Self) -> unit) { // ___drop for ${typeToString(futureType)}
    ${BuiltinFunctions.__yo_future_drop[0]!}(self);
  })`;
}

/**
 * Generate ___dup function code for a future type
 */
function generateDupFunctionCodeForFutureType(futureType: FutureType): string {
  // For future types, dup should use __yo_future_dup
  // This builtin function handles the future reference counting properly
  return `((fn(self : Self) -> Self) {  // ___dup for ${typeToString(futureType)}
    ${BuiltinFunctions.__yo_future_dup[0]!}(self);
    return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
  })`;
}

/**
 * Auto-derive Copy and Send marker modules for a struct type.
 *
 * For struct (value semantics):
 * - Auto-derive Copy if all fields implement Copy
 * - Auto-derive Send if all fields implement Send
 *
 * For object (reference semantics):
 * - Never auto-derive Copy (Rc types are move-only)
 * - Auto-derive Send if all fields implement Send
 */
export function autoDeriveCopySendForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Skip auto-derive during prelude evaluation (Copy/Send not yet defined)
  if (isEvaluatingPreludeModule()) {
    return env;
  }

  const { typeImplementsCopy, typeImplementsSend } = require("../../types");

  // Check if Copy/Send are already explicitly defined
  const hasCopy = structType.module.fields.some(
    (field) => field.label === "Copy"
  );
  const hasSend = structType.module.fields.some(
    (field) => field.label === "Send"
  );

  // For object (reference semantics), never auto-derive Copy
  const canDeriveCopy = !structType.isReferenceSemantics && !hasCopy;
  const canDeriveSend = !hasSend;

  // Check if all fields implement Copy
  if (canDeriveCopy) {
    const allFieldsImplementCopy = structType.fields
      .filter((field) => !field.isCompileTimeOnly)
      .every((field) => typeImplementsCopy(field.type));

    if (allFieldsImplementCopy) {
      // Use a locally defined Copy module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Copy",
        code: `{
          Copy :: module(id := "Copy");
          impl(Self, Copy())
        }`,
        SelfType: structType,
        env,
        context,
      });
    }
  }

  // Check if all fields implement Send
  if (canDeriveSend) {
    const allFieldsImplementSend = structType.fields
      .filter((field) => !field.isCompileTimeOnly)
      .every((field) => typeImplementsSend(field.type));

    if (allFieldsImplementSend) {
      // Use a locally defined Send module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Send",
        code: `{
          Send :: module(id := "Send");
          impl(Self, Send())
        }`,
        SelfType: structType,
        env,
        context,
      });
    }
  }

  return env;
}

/**
 * Auto-derive Copy and Send marker modules for an enum type.
 *
 * - Auto-derive Copy if all variant fields implement Copy
 * - Auto-derive Send if all variant fields implement Send
 */
export function autoDeriveCopySendForEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Skip auto-derive during prelude evaluation (Copy/Send not yet defined)
  if (isEvaluatingPreludeModule()) {
    return env;
  }

  const { typeImplementsCopy, typeImplementsSend } = require("../../types");

  // Check if Copy/Send are already explicitly defined
  const hasCopy = enumType.module.fields.some(
    (field) => field.label === "Copy"
  );
  const hasSend = enumType.module.fields.some(
    (field) => field.label === "Send"
  );

  // Check if all variant fields implement Copy
  if (!hasCopy) {
    const allFieldsImplementCopy = enumType.variants.every((variant) => {
      if (!variant.fields || variant.fields.length === 0) {
        return true; // Variants without fields are trivially Copy
      }
      return variant.fields.every((field) => typeImplementsCopy(field.type));
    });

    if (allFieldsImplementCopy) {
      // Use a locally defined Copy module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Copy",
        code: `{
          Copy :: module(id := "Copy");
          impl(Self, Copy())
        }`,
        SelfType: enumType,
        env,
        context,
      });
    }
  }

  // Check if all variant fields implement Send
  if (!hasSend) {
    const allFieldsImplementSend = enumType.variants.every((variant) => {
      if (!variant.fields || variant.fields.length === 0) {
        return true; // Variants without fields are trivially Send
      }
      return variant.fields.every((field) => typeImplementsSend(field.type));
    });

    if (allFieldsImplementSend) {
      // Use a locally defined Send module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Send",
        code: `{
          Send :: module(id := "Send");
          impl(Self, Send())
        }`,
        SelfType: enumType,
        env,
        context,
      });
    }
  }

  return env;
}

/**
 * Auto-derive Copy and Send marker modules for a union type.
 *
 * - Auto-derive Copy if all fields implement Copy
 * - Auto-derive Send if all fields implement Send
 */
export function autoDeriveCopySendForUnionType({
  unionType,
  env,
  context,
}: {
  unionType: import("../../types").UnionType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Skip auto-derive during prelude evaluation (Copy/Send not yet defined)
  if (isEvaluatingPreludeModule()) {
    return env;
  }

  const { typeImplementsCopy, typeImplementsSend } = require("../../types");

  // Check if Copy/Send are already explicitly defined
  const hasCopy = unionType.module.fields.some(
    (field) => field.label === "Copy"
  );
  const hasSend = unionType.module.fields.some(
    (field) => field.label === "Send"
  );

  // Check if all fields implement Copy
  if (!hasCopy) {
    const allFieldsImplementCopy = unionType.fields
      .filter((field) => !field.isCompileTimeOnly)
      .every((field) => typeImplementsCopy(field.type));

    if (allFieldsImplementCopy) {
      // Use a locally defined Copy module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Copy",
        code: `{
          Copy :: module(id := "Copy");
          impl(Self, Copy())
        }`,
        SelfType: unionType,
        env,
        context,
      });
    }
  }

  // Check if all fields implement Send
  if (!hasSend) {
    const allFieldsImplementSend = unionType.fields
      .filter((field) => !field.isCompileTimeOnly)
      .every((field) => typeImplementsSend(field.type));

    if (allFieldsImplementSend) {
      // Use a locally defined Send module that structurally matches the prelude one
      env = addModuleFieldByCode({
        label: "Send",
        code: `{
          Send :: module(id := "Send");
          impl(Self, Send())
        }`,
        SelfType: unionType,
        env,
        context,
      });
    }
  }

  return env;
}

/**
 * Helper function to add a module field by evaluating code
 */
function addModuleFieldByCode({
  label,
  code,
  SelfType,
  env,
  context,
}: {
  label: string;
  code: string;
  SelfType: StructType | EnumType | import("../../types").UnionType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  const { expr: fieldExpr, env: nextEnv } = parseAndEvaluateExprCode(
    code,
    SelfType as StructType | EnumType,
    env,
    context
  );

  if (fieldExpr.$ && fieldExpr.$.value) {
    const moduleField: ModuleField = {
      label,
      type: fieldExpr.$.type,
      assignedValue: fieldExpr.$.value,
      isCompileTimeOnly: true,
      exprs: {
        expr: fieldExpr,
        labelExpr: undefined,
        typeExpr: undefined,
        defaultValueExpr: undefined,
        assignedValueExpr: fieldExpr,
      },
    };

    // Add to module fields
    SelfType.module.fields.push(moduleField);
  }

  return nextEnv;
}
