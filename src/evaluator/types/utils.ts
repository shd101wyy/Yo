import { Environment } from "../../env";
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
  isARCType,
  ModuleElement,
  StructType,
  typeContainsARCType,
  typeOfType,
  typeToString,
} from "../../types";
import { isFunctionValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Helper function to parse and evaluate a Yo code string in the context of a SelfType
 */
function parseAndEvaluateExprCode(
  code: string,
  SelfType: StructType | EnumType | DynType | ClosureType,
  env: Environment,
  context: EvaluatorContext
): { expr: Expr; env: Environment } {
  const expr = generateExprFromCode(code);

  // Evaluate the expression with the struct as the SelfType
  const evaluatedExpr = context.evaluateExpression({
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

export function addFunctionToSelfTypeModule({
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
  SelfType: StructType | EnumType | DynType | ClosureType;
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

      // Add the drop function to the struct's module elements
      const moduleElement: ModuleElement = {
        label: label,
        type: functionExpr.$.type,
        assignedValue: functionExpr.$.value,
        isCompileTimeOnly: true,
        isImplicit: false,
        exprs: {
          expr: functionExpr,
          labelExpr: functionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: functionExpr,
        },
      };
      SelfType.module.elements.push(moduleElement);
    }
  }

  return nextEnv;
}

/**
 * Generate ___dispose function code for a struct type
 */
function generateDisposeFunctionCodeForStructType(
  structType: StructType
): string | null {
  if (!isARCType(structType)) {
    // return null; // no need to generate ___dispose function
    return `((fn(self : Self) -> unit) ())`;
  }
  const destructurings = structType.elements
    .filter(
      (element) =>
        !element.isCompileTimeOnly && typeContainsARCType(element.type)
    )
    .map((element) => element.label);

  const hasDisposeFunction = structType.module.elements.some(
    (element) => element.label === BuiltinFunctions.dispose[0]
  );

  if (!destructurings.length && !hasDisposeFunction) {
    // return null; // no need to generate ___dispose function
    return `((fn(self : Self) -> unit) ())`;
  }

  const dropDestructuringsExpr = destructurings.length
    ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___drop[0]!})(${label});`).join("\n")}
`
    : "";

  return `((fn(self : Self) -> unit) { // ___dispose
      ${hasDisposeFunction ? "Self.dispose(self);" : ""}
      ${dropDestructuringsExpr}
      return ();
    })`;
}

/**
 * Generate ___drop function code for a struct type
 */
function generateDropFunctionCodeForStructType(structType: StructType): string {
  const destructurings = structType.elements
    .filter(
      (element) =>
        !element.isCompileTimeOnly && typeContainsARCType(element.type)
    )
    .map((element) => element.label);

  const decrRcExpr = isARCType(structType)
    ? `
  ${BuiltinFunctions.__yo_decr_rc[0]!}(self${generateDisposeFunctionCodeForStructType(structType) ? ", Self.___dispose" : ""});`
    : "";

  const dropDestructuringsExpr = isARCType(structType)
    ? ""
    : destructurings.length
      ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___drop[0]!})(${label});`).join("\n")}
`
      : "";

  return `((fn(self : Self) -> unit) { // ___drop
  ${dropDestructuringsExpr}
  ${decrRcExpr}
  return ();
})`;
}

/**
 * Generate ___dup function code for a struct type
 */
function generateDupFunctionCodeForStructType(structType: StructType): string {
  const destructurings = structType.elements
    .filter(
      (element) =>
        !element.isCompileTimeOnly && typeContainsARCType(element.type)
    )
    .map((element) => element.label);

  const incrRcExpr = isARCType(structType)
    ? `
  ${BuiltinFunctions.__yo_incr_rc[0]!}(self);`
    : "";

  const dupDestructuringsExpr = isARCType(structType)
    ? ""
    : destructurings.length
      ? `
  { ${destructurings.join(", ")} } := self;
  ${destructurings.map((label) => `(${BuiltinFunctions.___dup[0]!})(${label});`).join("\n")}
`
      : "";

  return `((fn(self : Self) -> Self) {  // ___dup
  ${dupDestructuringsExpr}
  ${incrRcExpr}
  return ${BuiltinFunctions.__yo_rc_own[0]!}(self);
})`;
}

/**
 * Helper function to add ARC-related functions (___drop, ___dup, ___dispose) to a struct type
 * This should be called after all struct elements are processed and the struct type is complete
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
  // if (typeContainsARCType(structType)) {
  const disposeFunctionCode =
    generateDisposeFunctionCodeForStructType(structType);
  const dropFunctionCode = generateDropFunctionCodeForStructType(structType);
  const dupFunctionCode = generateDupFunctionCodeForStructType(structType);

  /// console.log("dispose: ", disposeFunctionCode);
  /// console.log("drop: ", dropFunctionCode);
  /// console.log("dup: ", dupFunctionCode);

  // Add ___dispose function
  if (disposeFunctionCode) {
    env = addFunctionToSelfTypeModule({
      label: BuiltinFunctions.___dispose[0]!,
      functionCode: disposeFunctionCode,
      SelfType: structType,
      env,
      context,
    });
  }

  // Add ___dup function to the struct type module elements
  if (dupFunctionCode) {
    env = addFunctionToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: structType,
      env,
      context,
    });
  }

  // Add ___drop function to the struct type module elements
  if (dropFunctionCode) {
    env = addFunctionToSelfTypeModule({
      label: BuiltinFunctions.___drop[0]!,
      functionCode: dropFunctionCode,
      SelfType: structType,
      env,
      context,
    });
  }
  // }

  return env;
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

  // Add ___dup function to the dyn type module elements
  if (dupFunctionCode) {
    env = addFunctionToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: dynType,
      env,
      context,
    });
  }

  // Add ___drop function to the dyn type module elements
  if (dropFunctionCode) {
    env = addFunctionToSelfTypeModule({
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
 * Add ARC functions (___dup, ___drop, ___dispose) to a closure type's module.
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

  // Add ___dup function to the closure type module elements
  if (dupFunctionCode) {
    env = addFunctionToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: closureType,
      env,
      context,
    });
  }

  // Add ___drop function to the closure type module elements
  if (dropFunctionCode) {
    env = addFunctionToSelfTypeModule({
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
