import type { Environment } from "../../env";
import {
  BuiltinFunctions,
  type Expr,
  exprIsFunctionCall,
  exprToString,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import type { Token } from "../../token";
import { createTypeHierarchy } from "../../types/creators";
import type {
  DynType,
  EnumType,
  IsoType,
  TypeField,
  SomeType,
  StructType,
  TraitField,
  TupleType,
  Type,
  UnionType,
} from "../../types/definitions";
import {
  isArrayType,
  isEnumType,
  isFunctionType,
  isPtrType,
  isRcType,
  isStructType,
  isTupleType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import {
  bufferElementType,
  canTypeFormRcCycle,
  typeContainsRcType,
  typeContainsSomeType,
  typeToString,
} from "../../types/utils";
import { randomId } from "../../utils";
import { isFunctionValue, isTraitValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import {
  typeImplementsAcyclic,
  typeImplementsComptime,
  typeImplementsRuntime,
  typeImplementsSend,
  typeIsComptimeOnly,
  validateTypeAvailability,
} from "../trait-checking";

const YoSelf = "__yo_self";

function typeDerivesComptime(
  type: Type,
  env: Environment,
  visiting: Set<string>
): boolean {
  if (isStructType(type)) {
    if (type.isReferenceSemantics) return false;
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const result = type.fields
      .filter((field) => isRuntimeDataField(field, env))
      .every((field) => typeDerivesComptime(field.type, env, visiting));
    visiting.delete(type.id);
    return result;
  }

  if (isTupleType(type)) {
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const result = type.fields.every((field) =>
      typeDerivesComptime(field.type, env, visiting)
    );
    visiting.delete(type.id);
    return result;
  }

  if (isEnumType(type)) {
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const result = type.variants.every((variant) =>
      (variant.fields ?? []).every((field) =>
        typeDerivesComptime(field.type, env, visiting)
      )
    );
    visiting.delete(type.id);
    return result;
  }

  if (isArrayType(type) || isPtrType(type)) {
    return typeDerivesComptime(type.childType, env, visiting);
  }

  return typeImplementsComptime(type, env);
}

function typeDerivesRuntime(
  type: Type,
  env: Environment,
  visiting: Set<string>
): boolean {
  if (isStructType(type)) {
    if (type.isReferenceSemantics) return true;
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const runtimeFields = getRuntimeDataFields(type.fields, env);
    const result =
      (type.fields.length === 0 || runtimeFields.length > 0) &&
      runtimeFields.every((field) =>
        typeDerivesRuntime(field.type, env, visiting)
      );
    visiting.delete(type.id);
    return result;
  }

  if (isTupleType(type)) {
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const result = type.fields.every((field) =>
      typeDerivesRuntime(field.type, env, visiting)
    );
    visiting.delete(type.id);
    return result;
  }

  if (isEnumType(type)) {
    if (visiting.has(type.id)) return true;
    visiting.add(type.id);
    const result = type.variants.every((variant) =>
      (variant.fields ?? []).every((field) =>
        typeDerivesRuntime(field.type, env, visiting)
      )
    );
    visiting.delete(type.id);
    return result;
  }

  if (isArrayType(type) || isPtrType(type)) {
    return typeDerivesRuntime(type.childType, env, visiting);
  }

  return typeImplementsRuntime(type, env);
}

function isRuntimeDataField(
  field: { type: Type; isCompileTimeOnly?: boolean },
  _env: Environment
): boolean {
  return field.isCompileTimeOnly !== true;
}

function getRuntimeDataFields<
  T extends { type: Type; isCompileTimeOnly?: boolean },
>(fields: T[], env: Environment): T[] {
  return fields.filter((field) => isRuntimeDataField(field, env));
}

/**
 * Helper function to parse and evaluate a Yo code string in the context of a SelfType
 */
function parseAndEvaluateExprCode(
  code: string,
  SelfType: StructType | EnumType | DynType | SomeType | IsoType,
  env: Environment,
  context: EvaluatorContext
): { expr: Expr; env: Environment } {
  const expr = generateExprFromCode(code);

  // Evaluate the expression with the struct as the SelfType
  // Clear isEvaluatingFunctionBodyOrAsyncBlock because we're defining new functions,
  // not continuing the evaluation of an outer function body
  // Set isValidatingFunctionDefinition=true to prevent full evaluation of function bodies
  // during recursive type construction (avoids infinite loops for recursive types)
  // Clear forceCompileTimeBindings because the auto-generated RC functions (___drop, ___dup, etc.)
  // contain runtime code that should not be treated as compile-time bindings
  const evaluatedExpr = evaluateExpression({
    expr,
    env,
    context: {
      ...context,
      SelfType: SelfType,
      forceCompileTimeBindings: false,
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
  SelfType: StructType | EnumType | DynType | SomeType | IsoType;
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

      // Add the drop function to the struct's trait fields
      const recordField: TypeField = {
        label: label,
        type: functionType,
        assignedValue: undefined, // NOTE: We have to use the `undefined` here.
        exprs: {
          expr: functionExpr,
          labelExpr: functionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: undefined,
        },
      };
      if (SelfType.trait) {
        const index = SelfType.trait.fields.findIndex(
          (el) => el.label === label
        );
        if (index >= 0) {
          SelfType.trait.fields[index] = recordField;
          // return env; // No need to update. Don't throw error.
        } else {
          // Add new field
          SelfType.trait.fields.push(recordField);
        }
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
   * Function code string, like ((fn()-> unit)({ return(()); }))
   */
  functionCode: string;
  SelfType: StructType | EnumType | DynType | SomeType | IsoType;
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
      // Set the funcName so codegen can identify this function (e.g., ___dispose)
      functionExpr.$.value.funcName = label;

      // Add the drop function to the struct's trait fields
      const recordField: TypeField = {
        label: label,
        type: functionExpr.$.type,
        assignedValue: functionExpr.$.value,
        exprs: {
          expr: functionExpr,
          labelExpr: functionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: functionExpr,
        },
      };
      if (SelfType.trait) {
        const index = SelfType.trait.fields.findIndex(
          (el) => el.label === label
        );
        if (index >= 0) {
          // Replace existing field
          SelfType.trait.fields[index] = recordField;
        } else {
          // Add new field
          SelfType.trait.fields.push(recordField);
        }
      }
    }
  }

  return nextEnv;
}

export const DisposeFnSignature = `(fn(${YoSelf} : Self) -> unit)`;
export const DropFnSignature = `(fn(${YoSelf} : Self) -> unit)`;
export const DupFnSignature = `(fn(${YoSelf} : Self) -> Self)`;

/**
 * Sanitize a field label to be a valid Yo identifier.
 * Similar to sanitizeForCIdentifier but for Yo variable names.
 */
function sanitizeFieldLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, (char) => {
    return `_u${char.charCodeAt(0)}_`;
  });
}

/**
 * Check if a label is a valid Yo identifier (alphanumeric + underscore, not starting with digit)
 */
function isValidIdentifier(label: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label);
}

/**
 * Generate destructuring and drop/dup expressions for Rc functions.
 * Handles special field names like `*` by using aliased destructuring.
 */
function generateDestructuringAndCalls(
  labels: string[],
  callFn: string
): { destructuringExpr: string; callsExpr: string } {
  if (labels.length === 0) {
    return { destructuringExpr: "", callsExpr: "" };
  }

  const destructurings: string[] = [];
  const calls: string[] = [];

  for (const label of labels) {
    if (isValidIdentifier(label)) {
      const alias = randomId("field_" + label);
      destructurings.push(`${label} : ${alias}`);
      calls.push(`(${callFn})(${alias});`);
    } else {
      // Need aliased destructuring: { (label) : alias }
      const alias = randomId("field_" + sanitizeFieldLabel(label));
      destructurings.push(`(${label}) : ${alias}`);
      // Use method call syntax for aliased fields too
      calls.push(`(${callFn})(${alias});`);
    }
  }

  return {
    destructuringExpr: `{ ${destructurings.join(", ")} } := ${YoSelf};`,
    callsExpr: calls.join("\n  "),
  };
}

/**
 * Generate ___dispose function code for a struct type
 */
function generateDisposeFunctionCodeForStructType(structType: StructType): {
  signature: string;
  code: string;
} {
  const signature = DisposeFnSignature;
  if (!isRcType(structType)) {
    return { signature, code: `(${signature})(())` };
  }

  const destructuringLabels = structType.fields
    .filter((field) => isRuntimeDataField(field, structType.env))
    .filter((field) => typeContainsRcType(field.type))
    .map((field) => field.label);

  // Note: User's dispose() method from Dispose trait is handled in C codegen,
  // not here. This function only generates the field dropping logic.
  // The C codegen will check for Dispose trait and emit the call before this code runs.

  if (!destructuringLabels.length) {
    return { signature, code: `(${signature})(())` };
  }

  const { destructuringExpr, callsExpr } = generateDestructuringAndCalls(
    destructuringLabels,
    BuiltinFunctions.___drop[0]!
  );

  const dropDestructuringsExpr = `
  ${destructuringExpr}
  ${callsExpr}
`;

  return {
    signature,
    code: `(${signature})({ // ___dispose
      ${dropDestructuringsExpr}
      return(());
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
  const destructuringLabels = structType.fields
    .filter((field) => isRuntimeDataField(field, structType.env))
    .filter((field) => typeContainsRcType(field.type))
    .map((field) => field.label);

  const decrRcFn = structType.isAtomicRc
    ? BuiltinFunctions.__yo_decr_rc_atomic[0]!
    : BuiltinFunctions.__yo_decr_rc[0]!;
  const decrRcExpr = isRcType(structType)
    ? `
  ${decrRcFn}(${YoSelf});`
    : "";

  let dropDestructuringsExpr = "";
  if (!isRcType(structType) && destructuringLabels.length) {
    const { destructuringExpr, callsExpr } = generateDestructuringAndCalls(
      destructuringLabels,
      BuiltinFunctions.___drop[0]!
    );
    dropDestructuringsExpr = `
  ${destructuringExpr}
  ${callsExpr}
`;
  }

  const finalCode = `(${signature})({ // ___drop
  ${dropDestructuringsExpr}
  ${decrRcExpr}
  return(());
})`;

  return {
    signature,
    code: finalCode,
  };
}

/**
 * Generate ___dup function code for a struct type.
 *
 * For RC types (heap-allocated with ref-count header), dup just increments
 * the ref-count and returns the same pointer.  For value types that contain
 * RC-managed fields, dup must destructure every field, call ___dup on each
 * RC-containing field, and construct a **new** struct with the dup'd values.
 * The old code discarded the ___dup return values and returned the original
 * `__yo_self`, which meant RC-managed fields inside the struct were never
 * actually duplicated — the caller received a bitwise copy with the same
 * reference counts as the source.
 */
function generateDupFunctionCodeForStructType(structType: StructType): {
  signature: string;
  code: string;
} {
  const signature = DupFnSignature;

  // RC types: just increment the ref-count and return the same pointer.
  if (isRcType(structType)) {
    const incrRcFn = structType.isAtomicRc
      ? BuiltinFunctions.__yo_incr_rc_atomic[0]!
      : BuiltinFunctions.__yo_incr_rc[0]!;
    return {
      signature,
      code: `(${signature})({  // ___dup (RC type)
  ${incrRcFn}(${YoSelf});
  return(${BuiltinFunctions.__yo_rc_own[0]!}(${YoSelf}));
})`,
    };
  }

  const rcFieldLabels = new Set(
    structType.fields
      .filter((field) => isRuntimeDataField(field, structType.env))
      .filter((field) => typeContainsRcType(field.type))
      .map((field) => field.label)
  );

  // No RC fields: plain value type, return a copy.
  if (rcFieldLabels.size === 0) {
    return {
      signature,
      code: `(${signature})({  // ___dup (plain value type)
  return(${YoSelf});
})`,
    };
  }

  // Value type with RC fields: destructure every field, dup the RC ones,
  // then construct a new struct with the dup'd values.
  const runtimeFields = structType.fields.filter((field) =>
    isRuntimeDataField(field, structType.env)
  );
  const allLabels = runtimeFields.map((f) => f.label);
  const aliasMap: Record<string, string> = {};
  const destructurings: string[] = [];

  for (const label of allLabels) {
    const alias = randomId("f_" + sanitizeFieldLabel(label));
    aliasMap[label] = alias;
    if (isValidIdentifier(label)) {
      destructurings.push(`${label} : ${alias}`);
    } else {
      destructurings.push(`(${label}) : ${alias}`);
    }
  }

  const destructuringExpr = `{ ${destructurings.join(", ")} } := ${YoSelf};`;

  // Build the field arguments for constructing the new struct.
  // For RC fields we inline the ___dup call directly; for non-RC fields
  // we reference the destructured alias.  This avoids intermediate
  // let-bindings that may lack the metadata the C codegen expects.
  const dupFn = BuiltinFunctions.___dup[0]!;
  const fieldArgs = runtimeFields
    .map((f) => {
      const alias = aliasMap[f.label]!;
      return rcFieldLabels.has(f.label)
        ? `${f.label}: ${alias}.${dupFn}()`
        : `${f.label}: ${alias}`;
    })
    .join(", ");
  const constructExpr = `Self(${fieldArgs})`;

  return {
    signature,
    code: `(${signature})({  // ___dup (value type with RC fields)
  ${destructuringExpr}
  return(${constructExpr});
})`,
  };
}

/**
 * Helper function to add Rc-related functions (___drop, ___dup, ___dispose) to a struct type
 * This should be called after all struct fields are processed and the struct type is complete
 */
export function addRcFunctionsToStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Skip RC functions for comptime-only types - they don't exist at runtime
  if (typeIsComptimeOnly(structType, env)) {
    return env;
  }

  typeOfType(structType); // Ensure no invalid recursive type

  // Check if struct contains SomeType fields - if so, skip full evaluation to avoid
  // infinite recursion during recursive type construction
  const containsSomeType = typeContainsSomeType(structType);

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

  addRcFunctionSignaturesToStructType({ structType, env, context });

  // For structs containing SomeType fields, skip full function body evaluation
  // to avoid infinite recursion during recursive type construction.
  // The signatures are already added, and codegen will handle the implementation.
  if (containsSomeType) {
    return env;
  }

  // Add ___dispose function
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dispose[0]!,
    functionCode: disposeFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  // Add ___drop function to the struct type trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  // Add ___dup function to the struct type trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: structType,
    env,
    context,
  });

  return env;
}

export function addRcFunctionSignaturesToStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}) {
  // Skip RC functions for comptime-only types - they don't exist at runtime
  if (typeIsComptimeOnly(structType, env)) {
    return;
  }

  // NOTE: We need to add signature to the struct trait first, to support recursive calls
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
    return { signature, code: `(${signature})(())` };
  }

  const hasDisposeFunction = enumType.trait.fields.some(
    (field) => field.label === BuiltinFunctions.dispose[0]
  );

  const variantsWithRcTypes = enumType.variants.filter(
    (variant) =>
      variant.fields &&
      variant.fields.some((field) => typeContainsRcType(field.type))
  );

  if (!variantsWithRcTypes.length && !hasDisposeFunction) {
    return { signature, code: `(${signature})(())` };
  }

  const matchCases = variantsWithRcTypes
    .map((variant) => {
      const destructurings = variant
        .fields!.filter((field) => typeContainsRcType(field.type))
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
    variantsWithRcTypes.length === enumType.variants.length
      ? ""
      : ",\n    _ => ()";

  return {
    signature,
    code: `(${signature} { // ___dispose
      ${hasDisposeFunction ? `Self.dispose(${YoSelf});` : ""}
      match(${YoSelf},
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

  const variantsWithRcTypes = enumType.variants.filter(
    (variant) =>
      variant.fields &&
      variant.fields.some((field) => typeContainsRcType(field.type))
  );

  const decrRcExpr = isRcType(enumType)
    ? `
  ${BuiltinFunctions.__yo_decr_rc[0]!}(${YoSelf});`
    : "";

  const dropVariantsExpr = isRcType(enumType)
    ? ""
    : variantsWithRcTypes.length
      ? `
  match(${YoSelf},
    ${variantsWithRcTypes
      .map((variant) => {
        const destructurings = variant
          .fields!.filter((field) => typeContainsRcType(field.type))
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
      variantsWithRcTypes.length === enumType.variants.length
        ? ""
        : ",\n    _ => ()"
    }
  );`
      : "";

  return {
    signature,
    code: `(${signature})({ // ___drop
  ${dropVariantsExpr}
  ${decrRcExpr}
  return(());
})`,
  };
}

/**
 * Generate ___dup function code for an enum type.
 *
 * For RC types the ref-count is simply incremented and the same pointer
 * returned.  For value types that carry RC-managed fields, each variant
 * arm must destructure its fields, call ___dup on every RC-containing
 * field, and construct a **new** variant value with the dup'd fields.
 * The old code discarded the ___dup return values and returned the
 * original `__yo_self`, so RC-managed fields inside variants were never
 * actually duplicated.
 */
function generateDupFunctionCodeForEnumType(enumType: EnumType): {
  signature: string;
  code: string;
} {
  const signature = DupFnSignature;

  // RC types: just increment the ref-count and return the same pointer.
  if (isRcType(enumType)) {
    return {
      signature,
      code: `(${signature})({  // ___dup (RC type)
  ${BuiltinFunctions.__yo_incr_rc[0]!}(${YoSelf});
  return(${BuiltinFunctions.__yo_rc_own[0]!}(${YoSelf}));
})`,
    };
  }

  const dupFn = BuiltinFunctions.___dup[0]!;

  // Build a match block where each variant with RC fields dup's them
  // and constructs a new variant value.  Variants without RC fields
  // are returned as-is (their fields are plain data – no RC needed).
  const variantArms = enumType.variants.map((variant) => {
    const fields = variant.fields ?? [];
    const hasFields = fields.length > 0;
    const paramList = fields.map((f) => f.label).join(", ");
    const pat = hasFields
      ? `.${variant.name}(${paramList})`
      : `.${variant.name}`;

    // No RC fields in this variant → plain copy.
    if (!fields.some((f) => typeContainsRcType(f.type))) {
      return `${pat} => ${pat}`;
    }

    // Build the constructor expression for the new variant value.
    // For RC fields we inline the ___dup call; non-RC fields use the
    // match-bound variable directly.
    const fieldExprs: string[] = [];
    for (const field of fields) {
      if (typeContainsRcType(field.type)) {
        fieldExprs.push(`${field.label}.${dupFn}()`);
      } else {
        fieldExprs.push(field.label);
      }
    }

    const fieldsStr = fieldExprs.join(", ");
    const ctor = hasFields
      ? `.${variant.name}(${fieldsStr})`
      : `.${variant.name}`;
    return `${pat} => ${ctor}`;
  });

  const matchExpr = `match(${YoSelf},
    ${variantArms.join(",\n    ")}
  )`;

  return {
    signature,
    code: `(${signature})({  // ___dup (value type with RC fields)
  return(${matchExpr});
})`,
  };
}

/**
 * Helper function to add Rc-related functions (___drop, ___dup, ___dispose) to an enum type
 * This should be called after all enum variants are processed and the enum type is complete
 */
export function addRcFunctionsToEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Skip RC functions for comptime-only types - they don't exist at runtime
  if (typeIsComptimeOnly(enumType, env)) {
    return env;
  }

  typeOfType(enumType); // Ensure no invalid recursive type

  // Check if struct contains SomeType fields - if so, skip full evaluation to avoid
  // infinite recursion during recursive type construction
  const containsSomeType = typeContainsSomeType(enumType);

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

  addRcFunctionSignaturesToEnumType({ enumType, env, context });

  // Add ___dispose function
  // env = addFunctionCodeToSelfTypeModule({
  //   label: BuiltinFunctions.___dispose[0]!,
  //   functionCode: disposeFunctionCode,
  //   SelfType: enumType,
  //   env,
  //   context,
  // });

  // For structs containing SomeType fields, skip full function body evaluation
  // to avoid infinite recursion during recursive type construction.
  // The signatures are already added, and codegen will handle the implementation.
  if (containsSomeType) {
    return env;
  }

  // Add ___drop function to the enum type trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: enumType,
    env,
    context,
  });

  // Add ___dup function to the enum type trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: enumType,
    env,
    context,
  });

  return env;
}

export function addRcFunctionSignaturesToEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}) {
  // Skip RC functions for comptime-only types - they don't exist at runtime
  if (typeIsComptimeOnly(enumType, env)) {
    return env;
  }

  // Add function signatures to the enum trait first, to support recursive calls
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
 * Add Rc functions (___dup, ___drop) to a dyn type's trait.
 * These functions operate on the dyn wrapper itself, not the wrapped object.
 */
export function addRcFunctionsToDynType({
  dynType,
  env,
  context,
}: {
  dynType: DynType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate Rc functions for the dyn wrapper
  const dropFunctionCode = generateDropFunctionCodeForDynType(dynType);
  const dupFunctionCode = generateDupFunctionCodeForDynType(dynType);

  // Add ___dup function to the dyn type trait fields
  if (dupFunctionCode) {
    env = addFunctionCodeToSelfTypeModule({
      label: BuiltinFunctions.___dup[0]!,
      functionCode: dupFunctionCode,
      SelfType: dynType,
      env,
      context,
    });
  }

  // Add ___drop function to the dyn type trait fields
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
  return `((fn(${YoSelf} : Self) -> unit)({ // ___drop for ${typeToString(_dynType)}
    ${BuiltinFunctions.__yo_dyn_drop[0]!}(${YoSelf});
  }))`;
}

/**
 * Generate ___dup function code for a dyn type
 */
function generateDupFunctionCodeForDynType(_dynType: DynType): string {
  // For dyn types, dup should use __yo_dyn_dup
  // This builtin function handles the dyn reference counting properly
  return `((fn(${YoSelf} : Self) -> Self)({  // ___dup for ${typeToString(_dynType)}
    ${BuiltinFunctions.__yo_dyn_dup[0]!}(${YoSelf});
    return(${BuiltinFunctions.__yo_rc_own[0]!}(${YoSelf}));
  }))`;
}

/**
 * Generate ___drop function code for a SomeType
 */
function generateDropFunctionCodeForSomeType(someType: SomeType): string {
  // For SomeType, drop should use __yo_sometype_drop
  // This builtin function dispatches to resolvedConcreteType if available
  return `((fn(${YoSelf} : Self) -> unit)({ // ___drop for ${typeToString(someType)}
    ${BuiltinFunctions.__yo_sometype_drop[0]!}(${YoSelf});
  }))`;
}

/**
 * Generate ___dup function code for a SomeType
 */
function generateDupFunctionCodeForSomeType(someType: SomeType): string {
  // For SomeType, dup should use __yo_sometype_dup
  // This builtin function dispatches to resolvedConcreteType if available
  return `((fn(${YoSelf} : Self) -> Self)({  // ___dup for ${typeToString(someType)}
    ${BuiltinFunctions.__yo_sometype_dup[0]!}(${YoSelf});
    return(${BuiltinFunctions.__yo_rc_own[0]!}(${YoSelf}));
  }))`;
}

/**
 * Add Rc functions (___drop, ___dup) to a SomeType's trait.
 * These functions dispatch to resolvedConcreteType's methods in codegen.
 */
export function addRcFunctionsToSomeType({
  someType,
  env,
  context,
}: {
  someType: SomeType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate Rc functions for SomeType
  const dropFunctionCode = generateDropFunctionCodeForSomeType(someType);
  const dupFunctionCode = generateDupFunctionCodeForSomeType(someType);

  // Add ___drop function to the SomeType trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: someType,
    env,
    context,
  });

  // Add ___dup function to the SomeType trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: someType,
    env,
    context,
  });

  return env;
}

/**
 * Generate ___dispose function code for an IsoType
 * This is called when the Iso's ref count hits 0.
 * It drops the inner value if it hasn't been extracted.
 */
function generateDisposeFunctionCodeForIsoType(_isoType: IsoType): string {
  // The inner value needs to be dropped if not extracted
  // We use __yo_iso_dispose which checks the extracted flag and drops the inner value
  return `((fn(${YoSelf} : Self) -> unit)({ // ___dispose for Iso
  ${BuiltinFunctions.__yo_iso_dispose[0]!}(${YoSelf});
  return(());
}))`;
}

/**
 * Generate ___drop function code for an IsoType
 * Uses atomic operations for thread-safe reference counting
 */
function generateDropFunctionCodeForIsoType(_isoType: IsoType): string {
  return `((fn(${YoSelf} : Self) -> unit)({ // ___drop for Iso
  ${BuiltinFunctions.__yo_decr_rc_atomic[0]!}(${YoSelf});
  return(());
}))`;
}

/**
 * Generate ___dup function code for an IsoType
 * Uses atomic operations for thread-safe reference counting
 */
function generateDupFunctionCodeForIsoType(_isoType: IsoType): string {
  return `((fn(${YoSelf} : Self) -> Self)({  // ___dup for Iso
  ${BuiltinFunctions.__yo_incr_rc_atomic[0]!}(${YoSelf});
  return(${BuiltinFunctions.__yo_rc_own[0]!}(${YoSelf}));
}))`;
}

/**
 * Add Rc functions (___drop, ___dup, ___dispose) to an IsoType's trait.
 * These functions use atomic operations for thread-safe reference counting.
 */
export function addRcFunctionsToIsoType({
  isoType,
  env,
  context,
}: {
  isoType: IsoType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Generate Rc functions for IsoType using atomic operations
  const disposeFunctionCode = generateDisposeFunctionCodeForIsoType(isoType);
  const dropFunctionCode = generateDropFunctionCodeForIsoType(isoType);
  const dupFunctionCode = generateDupFunctionCodeForIsoType(isoType);

  // Add ___dispose function to the IsoType trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dispose[0]!,
    functionCode: disposeFunctionCode,
    SelfType: isoType,
    env,
    context,
  });

  // Add ___drop function to the IsoType trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___drop[0]!,
    functionCode: dropFunctionCode,
    SelfType: isoType,
    env,
    context,
  });

  // Add ___dup function to the IsoType trait fields
  env = addFunctionCodeToSelfTypeModule({
    label: BuiltinFunctions.___dup[0]!,
    functionCode: dupFunctionCode,
    SelfType: isoType,
    env,
    context,
  });

  return env;
}

/**
 * Helper function to attach a trait to a receiver type.
 * This follows the same pattern as evaluateImplBlock for impl(type, Trait()).
 */
export function attachTraitToReceiverType(
  moduleName: string,
  receiverType: StructType | EnumType | UnionType | TupleType | SomeType,
  env: Environment,
  context: EvaluatorContext
): Environment {
  // Evaluate the trait call (e.g., Copy() or Send())
  const traitCallCode = `${moduleName}()`;
  const traitCallExpr = generateExprFromCode(traitCallCode);

  let evaluatedTraitCall;
  try {
    evaluatedTraitCall = evaluateExpression({
      expr: traitCallExpr,
      env,
      context: {
        ...context,
        expectedType: undefined,
        ReceiverType: receiverType,
      },
    });
  } catch {
    // The trait module is not in scope in this evaluation environment.
    // This can happen when a generic struct type (e.g. ArrayList(Token)) is
    // re-instantiated as a return type annotation inside a method body, where
    // prelude-derived traits like Runtime/Send/Rc are not in scope.
    // The trait was already attached during first instantiation; skip silently.
    return env;
  }

  if (!evaluatedTraitCall.$ || !isTraitValue(evaluatedTraitCall.$.value)) {
    return env;
  }

  env = evaluatedTraitCall.$.env;
  const traitValue = evaluatedTraitCall.$.value;

  // Set the receiver type on the trait value's type
  traitValue.type.receiverType = receiverType;

  // Attach the trait to the receiver type's trait (same as attachTraitToReceiverType in trait.ts)
  // Named trait - attach with empty label for method lookup
  const field: TraitField = {
    label: "", // Empty label prevents direct access, only method calls work
    type: createTypeHierarchy(1), // Trait type
    assignedValue: traitValue,
    sourceModulePath: context.currentModulePath,
    exprs: {
      expr: traitCallExpr,
    },
  };

  // Add the field to the receiver type's trait
  receiverType.trait.fields.push(field);

  return env;
}

/**
 * Auto-derive Copy and Send marker traits for a struct type.
 *
 * For struct (value semantics):
 * - Auto-derive Send if all fields implement Send.
 *
 * For object (reference semantics):
 * - Never auto-derive Send.
 */
export function autoDeriveSendForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  if (structType.isReferenceSemantics && !structType.isAtomicRc) {
    return env; // No auto-derive Send for non-atomic object types
  }

  // Check if all fields implement Send
  const allFieldsImplementSend = structType.fields.every((field) =>
    typeImplementsSend(field.type, env)
  );

  if (allFieldsImplementSend) {
    env = attachTraitToReceiverType("Send", structType, env, context);
  }

  return env;
}

/**
 * Auto-derive Rc marker trait for a struct type.
 *
 * For object (reference semantics):
 * - Always auto-derive Rc.
 *
 * For struct (value semantics):
 * - Never auto-derive Rc.
 */
export function autoDeriveRcForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  if (structType.isReferenceSemantics) {
    env = attachTraitToReceiverType("Rc", structType, env, context);
  }

  return env;
}

/**
 * Auto-derive Copy and Send marker traits for an enum type.
 *
 * - Auto-derive Send if all variant fields implement Send
 */
export function autoDeriveSendForEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all variant fields implement Send
  const allFieldsImplementSend = enumType.variants.every((variant) => {
    if (!variant.fields || variant.fields.length === 0) {
      return true; // Variants without fields are trivially Send
    }
    return variant.fields.every((field) => typeImplementsSend(field.type, env));
  });

  if (allFieldsImplementSend) {
    env = attachTraitToReceiverType("Send", enumType, env, context);
  }

  return env;
}

/**
 * Auto-derive Send marker traits for a union type.
 *
 * - Auto-derive Send if all fields implement Send
 */
export function autoDeriveSendForUnionType({
  unionType,
  env,
  context,
}: {
  unionType: UnionType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all fields implement Send
  const allFieldsImplementSend = unionType.fields.every((field) =>
    typeImplementsSend(field.type, env)
  );

  if (allFieldsImplementSend) {
    env = attachTraitToReceiverType("Send", unionType, env, context);
  }

  return env;
}

/**
 * Auto-derive Acyclic marker trait for a struct type.
 *
 * For struct (value semantics):
 * - Auto-derive Acyclic if all fields implement Acyclic.
 *
 * For object (reference semantics):
 * - Auto-derive Acyclic if the type cannot form RC cycles (checked via canTypeFormRcCycle).
 */
export function autoDeriveAcyclicForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  if (structType.isReferenceSemantics) {
    // A container holds its elements behind a raw `?*(E)` buffer that
    // canTypeFormRcCycle's field walk cannot see — and worse, this derive runs when
    // the container is first instantiated, which for a self-referential element
    // (`ArrayList(Self)` inside the type being defined) is BEFORE that element's own
    // cycle status is known. So a container is Acyclic only if every buffer element
    // type is itself Acyclic; for `ArrayList(Node)` the element `Node` is not (yet)
    // Acyclic, so the container is correctly withheld from Acyclic and remains
    // visible to cycle collection. (`ArrayList(i32)` stays Acyclic — i32 is Acyclic.)
    const allBufferElementsAcyclic = structType.fields.every((field) => {
      const elem = bufferElementType(field.type);
      return !elem || typeImplementsAcyclic(elem, env);
    });
    // For object types, check if they can form cycles (pass env for SomeType Acyclic checking)
    if (
      allBufferElementsAcyclic &&
      !canTypeFormRcCycle(structType, new Set(), env)
    ) {
      env = attachTraitToReceiverType("Acyclic", structType, env, context);
    }
  } else {
    // For value types, check if all fields implement Acyclic
    const allFieldsImplementAcyclic = structType.fields.every((field) =>
      typeImplementsAcyclic(field.type, env)
    );

    if (allFieldsImplementAcyclic) {
      env = attachTraitToReceiverType("Acyclic", structType, env, context);
    }
  }

  return env;
}

/**
 * Auto-derive Acyclic marker trait for an enum type.
 *
 * - Auto-derive Acyclic if all variant fields implement Acyclic
 */
export function autoDeriveAcyclicForEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all variant fields implement Acyclic
  const allFieldsImplementAcyclic = enumType.variants.every((variant) => {
    if (!variant.fields || variant.fields.length === 0) {
      return true; // Variants without fields are trivially Acyclic
    }
    return variant.fields.every((field) =>
      typeImplementsAcyclic(field.type, env)
    );
  });

  if (allFieldsImplementAcyclic) {
    env = attachTraitToReceiverType("Acyclic", enumType, env, context);
  }

  return env;
}

/**
 * Auto-derive Acyclic marker trait for a union type.
 *
 * - Auto-derive Acyclic if all fields implement Acyclic
 */
export function autoDeriveAcyclicForUnionType({
  unionType,
  env,
  context,
}: {
  unionType: UnionType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all fields implement Acyclic
  const allFieldsImplementAcyclic = unionType.fields.every((field) =>
    typeImplementsAcyclic(field.type, env)
  );

  if (allFieldsImplementAcyclic) {
    env = attachTraitToReceiverType("Acyclic", unionType, env, context);
  }

  return env;
}

/**
 * Auto-derive Comptime marker trait for a struct type.
 *
 * For struct (value semantics):
 * - Auto-derive Comptime if all fields implement Comptime.
 *
 * For object (reference semantics):
 * - Auto-derive Comptime if all fields implement Comptime.
 */
export function autoDeriveComptimeForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // `object` types are always runtime, so skip auto-derive Comptime
  if (structType.isReferenceSemantics) {
    return env;
  }

  // Check if all non-comptime-only fields implement Comptime
  // (isCompileTimeOnly fields are methods/statics, not data fields)
  const allFieldsImplementComptime = getRuntimeDataFields(
    structType.fields,
    env
  ).every((field) =>
    typeDerivesComptime(field.type, env, new Set([structType.id]))
  );

  if (allFieldsImplementComptime) {
    env = attachTraitToReceiverType("Comptime", structType, env, context);
  }

  return env;
}

/**
 * Auto-derive Comptime marker trait for an enum type.
 *
 * - Auto-derive Comptime if all variant fields implement Comptime
 */
export function autoDeriveComptimeForEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all variant fields implement Comptime
  // (isCompileTimeOnly fields are methods/statics, not data fields)
  const allFieldsImplementComptime = enumType.variants.every((variant) => {
    if (!variant.fields || variant.fields.length === 0) {
      return true; // Variants without fields are trivially Comptime
    }
    return variant.fields.every((field) =>
      typeDerivesComptime(field.type, env, new Set([enumType.id]))
    );
  });

  if (allFieldsImplementComptime) {
    env = attachTraitToReceiverType("Comptime", enumType, env, context);
  }

  return env;
}

/**
 * Auto-derive Runtime marker trait for a struct type.
 *
 * For struct (value semantics):
 * - Auto-derive Runtime if all fields implement Runtime.
 *
 * For object (reference semantics):
 * - Auto-derive Runtime if all fields implement Runtime.
 */
export function autoDeriveRuntimeForStructType({
  structType,
  env,
  context,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  if (structType.isReferenceSemantics) {
    env = attachTraitToReceiverType("Runtime", structType, env, context);
    return env;
  }

  // Check if all non-comptime-only fields implement Runtime
  // (isCompileTimeOnly fields are methods/statics, not data fields)
  const runtimeFields = getRuntimeDataFields(structType.fields, env);
  const allFieldsImplementRuntime =
    (structType.fields.length === 0 || runtimeFields.length > 0) &&
    runtimeFields.every((field) =>
      typeDerivesRuntime(field.type, env, new Set([structType.id]))
    );

  if (allFieldsImplementRuntime) {
    env = attachTraitToReceiverType("Runtime", structType, env, context);
  }

  return env;
}

/**
 * Auto-derive Runtime marker trait for an enum type.
 *
 * - Auto-derive Runtime if all variant fields implement Runtime
 */
export function autoDeriveRuntimeForEnumType({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all variant fields implement Runtime
  // (isCompileTimeOnly fields are methods/statics, not data fields)
  const allFieldsImplementRuntime = enumType.variants.every((variant) => {
    if (!variant.fields || variant.fields.length === 0) {
      return true; // Variants without fields are trivially Runtime
    }
    return variant.fields.every((field) =>
      typeDerivesRuntime(field.type, env, new Set([enumType.id]))
    );
  });

  if (allFieldsImplementRuntime) {
    env = attachTraitToReceiverType("Runtime", enumType, env, context);
  }

  return env;
}

/**
 * Auto-derive Runtime marker trait for a union type.
 *
 * Union types are always runtime-only (comptime-only fields are forbidden),
 * so we always attach the Runtime trait.
 */
export function autoDeriveRuntimeForUnionType({
  unionType,
  env,
  context,
}: {
  unionType: UnionType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Union types are always runtime (comptime-only fields are forbidden)
  env = attachTraitToReceiverType("Runtime", unionType, env, context);
  return env;
}

/**
 * Auto-derive Send marker trait for a tuple type.
 *
 * - Auto-derive Send if all fields implement Send
 */
export function autoDeriveSendForTupleType({
  tupleType,
  env,
  context,
}: {
  tupleType: TupleType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all fields implement Send
  const allFieldsImplementSend = tupleType.fields.every((field) =>
    typeImplementsSend(field.type, env)
  );

  if (allFieldsImplementSend) {
    env = attachTraitToReceiverType("Send", tupleType, env, context);
  }

  return env;
}

/**
 * Auto-derive Comptime marker trait for a tuple type.
 *
 * - Auto-derive Comptime if all fields implement Comptime
 */
export function autoDeriveComptimeForTupleType({
  tupleType,
  env,
  context,
}: {
  tupleType: TupleType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all non-comptime-only fields implement Comptime
  const allFieldsImplementComptime = tupleType.fields.every((field) =>
    typeDerivesComptime(field.type, env, new Set([tupleType.id]))
  );

  if (allFieldsImplementComptime) {
    env = attachTraitToReceiverType("Comptime", tupleType, env, context);
  }

  return env;
}

/**
 * Auto-derive Runtime marker trait for a tuple type.
 *
 * - Auto-derive Runtime if all fields implement Runtime
 */
export function autoDeriveRuntimeForTupleType({
  tupleType,
  env,
  context,
}: {
  tupleType: TupleType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  // Check if all non-comptime-only fields implement Runtime
  const allFieldsImplementRuntime = tupleType.fields.every((field) =>
    typeDerivesRuntime(field.type, env, new Set([tupleType.id]))
  );

  if (allFieldsImplementRuntime) {
    env = attachTraitToReceiverType("Runtime", tupleType, env, context);
  }

  return env;
}

/**
 * Auto-derive all applicable traits for a struct type.
 * This should be called after all fields are added but before RC functions are generated.
 * Order matters: Send → Rc → Acyclic → Comptime → Runtime
 *
 * Auto-generate ___drop, ___dup, and ___dispose functions if needed
 */
export function autoDeriveTraitsAndAddRcFunctionsForStructType({
  structType,
  env,
  context,
  errorToken,
}: {
  structType: StructType;
  env: Environment;
  context: EvaluatorContext;
  errorToken: Token;
}): Environment {
  // Auto-derive Send trait if applicable
  env = autoDeriveSendForStructType({
    structType,
    env,
    context,
  });

  // Auto-derive Rc trait for object types
  env = autoDeriveRcForStructType({
    structType,
    env,
    context,
  });

  // Auto-derive Acyclic trait if applicable
  env = autoDeriveAcyclicForStructType({
    structType,
    env,
    context,
  });

  // Auto-derive Comptime trait if applicable
  env = autoDeriveComptimeForStructType({
    structType,
    env,
    context,
  });

  // Auto-derive Runtime trait if applicable
  env = autoDeriveRuntimeForStructType({
    structType,
    env,
    context,
  });

  env = addRcFunctionsToStructType({
    structType,
    env,
    context,
  });

  validateTypeAvailability(structType, env, errorToken, context);

  return env;
}

/**
 * Auto-derive all applicable traits for a enum type.
 * This should be called after all fields are added but before RC functions are generated.
 * Order matters: Send → Acyclic → Comptime → Runtime
 *
 * Auto-generate ___drop, ___dup, and ___dispose functions if needed
 */
export function autoDeriveTraitsAndAddRcFunctionsForEnumType({
  enumType,
  env,
  context,
  errorToken,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
  errorToken: Token;
}): Environment {
  // Auto-derive Send trait if applicable
  env = autoDeriveSendForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Acyclic trait
  env = autoDeriveAcyclicForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Comptime trait
  env = autoDeriveComptimeForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Runtime trait
  env = autoDeriveRuntimeForEnumType({
    enumType,
    env,
    context,
  });

  // Auto-generate ARC functions using the systematic approach
  env = addRcFunctionsToEnumType({
    enumType,
    env,
    context,
  });

  // Fix recursive Box(Self) / object((*) : Self) etc.: when a struct (typically
  // Box) was instantiated with `Self` mid-enum-body, its ___dispose was
  // generated against a partial enum (some variants missing) and may have
  // ended up with an empty body, causing leaks.  Walk all variant field
  // types, find StructTypes that transitively reference this enumType, and
  // regenerate their RC functions now that the enum is complete.
  env = regenerateRcFunctionsForRecursiveStructs({
    enumType,
    env,
    context,
  });

  validateTypeAvailability(enumType, env, errorToken, context);

  return env;
}

/**
 * After an enum is fully built, find all StructTypes reachable from its
 * variant fields whose own field types reference the enumType (directly or
 * transitively), and regenerate their RC (___dispose, ___drop, ___dup)
 * functions.
 *
 * This fixes a bug where `Box(Self)` (or any struct containing `Self`)
 * generated dispose code while the enum was still partially built — at that
 * point `typeContainsRcType(Self)` returned false because only some variants
 * existed, producing an empty dispose body that leaks owned children.
 */
function regenerateRcFunctionsForRecursiveStructs({
  enumType,
  env,
  context,
}: {
  enumType: EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  const visited = new Set<string>();
  const structsToRegenerate: StructType[] = [];

  function walk(type: Type | undefined): void {
    if (!type) return;
    if (visited.has(type.id)) return;
    visited.add(type.id);

    if (isStructType(type)) {
      // If this struct has any field whose type contains the enum, its RC
      // code may have been generated against a partial enum.
      const referencesEnum = type.fields.some((f) =>
        typeReferencesType(f.type, enumType, new Set())
      );
      if (referencesEnum && !typeIsComptimeOnly(type, env)) {
        structsToRegenerate.push(type);
      }
      for (const f of type.fields) walk(f.type);
      return;
    }

    if (isTupleType(type)) {
      for (const f of type.fields) walk(f.type);
      return;
    }

    if (isEnumType(type)) {
      // Don't recurse into the enum being built (avoid cycles); but do
      // recurse into other enums encountered via fields.
      if (type === enumType) return;
      for (const v of type.variants) {
        for (const f of v.fields ?? []) walk(f.type);
      }
      return;
    }

    if (isArrayType(type) || isPtrType(type)) {
      walk(type.childType);
      return;
    }
  }

  for (const variant of enumType.variants) {
    for (const field of variant.fields ?? []) {
      walk(field.type);
    }
  }

  for (const structType of structsToRegenerate) {
    env = addRcFunctionsToStructType({ structType, env, context });
  }

  return env;
}

/**
 * Returns true if `type` contains `target` (by reference) anywhere in its
 * structure, walking through structs, tuples, enums, arrays, and
 * pointers.
 */
function typeReferencesType(
  type: Type | undefined,
  target: Type,
  seen: Set<string>
): boolean {
  if (!type) return false;
  if (type === target) return true;
  if (seen.has(type.id)) return false;
  seen.add(type.id);

  if (isStructType(type) || isTupleType(type)) {
    return type.fields.some((f) => typeReferencesType(f.type, target, seen));
  }
  if (isEnumType(type)) {
    return type.variants.some((v) =>
      (v.fields ?? []).some((f) => typeReferencesType(f.type, target, seen))
    );
  }
  if (isArrayType(type) || isPtrType(type)) {
    return typeReferencesType(type.childType, target, seen);
  }
  return false;
}

/**
 * Auto-derive all applicable traits for a enum type.
 * This should be called after all fields are added but before RC functions are generated.
 * Order matters: Send → Acyclic → Comptime → Runtime
 *
 * Auto-generate ___drop, ___dup, and ___dispose functions if needed
 */
export function autoDeriveTraitsAndAddRcFunctionsForTupleType({
  tupleType,
  env,
  context,
  errorToken,
}: {
  tupleType: TupleType;
  env: Environment;
  context: EvaluatorContext;
  errorToken: Token;
}): Environment {
  // Auto-derive Send trait if applicable
  env = autoDeriveSendForTupleType({
    tupleType,
    env,
    context,
  });

  // Auto-derive Comptime trait if applicable
  env = autoDeriveComptimeForTupleType({
    tupleType,
    env,
    context,
  });

  // Auto-derive Runtime trait if applicable
  env = autoDeriveRuntimeForTupleType({
    tupleType,
    env,
    context,
  });

  validateTypeAvailability(tupleType, env, errorToken, context);

  return env;
}
