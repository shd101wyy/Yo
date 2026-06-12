import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  getWhereClauseConstraintsForSomeType,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import { PlaceholderToken, type Token } from "../../token";
import type { TypeValue } from "../../type-value";
import {
  createPtrType,
  createTraitType,
  createType0,
  createTypeHierarchy,
} from "../../types/creators";
import type {
  FunctionParameter,
  FunctionType,
  SomeType,
  TraitField,
  TraitType,
  Type,
} from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isArrayType,
  isFnTraitType,
  isFunctionType,
  isSomeType,
  isStructType,
  isTraitType,
  isType0,
} from "../../types/guards";
import { typeContainsUnknownValue, typeToString } from "../../types/utils";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createTraitValue,
  createTypeValue,
  createUnknownValue,
  isFunctionValue,
  isTraitValue,
  isTypeValue,
  isUnknownValue,
  type TraitValue,
  type UnknownValue,
  type Value,
  valueToString,
} from "../../value";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateExpression } from "../exprs/expr";
import {
  checkTypeImplementsSelfConstraints,
  typeImplementsSend,
  typeImplementsTrait,
  typeImplementsTraitBool,
} from "../trait-checking";
import { synthesizeTypes } from "../types/synthesizer";
import { isValidVariableName } from "../utils";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import { evaluateAnonymousModuleBeginExprs } from "./anonymous-module";

/**
 * Re-evaluate a FunctionType's type expressions with substitutions bound in the environment.
 * This is used for specializing generic methods - instead of structurally substituting types,
 * we re-evaluate the original type expressions (e.g., `Option(T)`) with concrete type bindings
 * to get properly constructed nominal types with correct funcIds.
 *
 * @param functionType The original function type with type expressions to re-evaluate
 * @param specializedEnv Environment with type/value substitutions already bound
 * @param SelfType The concrete Self type for method specialization
 * @returns A new FunctionType with re-evaluated types
 */
function reEvaluateFunctionType({
  functionType,
  specializedEnv,
  SelfType,
}: {
  functionType: FunctionType;
  specializedEnv: Environment;
  SelfType: Type | undefined;
}): FunctionType {
  // Build re-evaluation env by merging the function type's definition env
  // (which captures scope variables like `F` from HKT trait constructors)
  // with the substitution frame from specializedEnv (which has concrete bindings
  // like A=i32 from the generic impl's forall parameters).
  const substitutionFrame =
    specializedEnv.frames[specializedEnv.frames.length - 1]!;
  const substitutionNames = new Set(
    substitutionFrame.variables.map((v) => v.name)
  );

  // The functionType.env does NOT include forall params (they were popped into
  // parametersFrame). We need to re-add unresolved forall params so that nested
  // type expressions like `(fn(a: A) -> B)` can reference them.
  const baseEnv = pushEnvFrame(functionType.env, substitutionFrame);

  // Add forall parameter variables that are NOT resolved by substitutions
  // (e.g., B in Functor's map when only A is resolved from impl's forall)
  // These are added to a separate env used only for re-evaluation, NOT stored
  // in the returned function type's env (otherwise they'd conflict with forall
  // arg processing at the call site).
  let reEvalEnv = baseEnv;
  const forallParamVars = functionType.parametersFrame.variables.filter(
    (v) =>
      functionType.forallParameters.some((fp) => fp.label === v.name) &&
      !substitutionNames.has(v.name)
  );
  if (forallParamVars.length > 0) {
    reEvalEnv = pushEnvFrame(baseEnv);
    for (const v of forallParamVars) {
      const { env: nextEnv } = addVariableToEnv({
        env: reEvalEnv,
        variable: { ...v },
        allowVariableShadowing: true,
      });
      reEvalEnv = nextEnv;
    }
  }

  // Re-evaluate each parameter's type expression
  const newParameters: FunctionParameter[] = functionType.parameters.map(
    (param) => {
      if (!param.exprs.typeExpr) {
        // No type expression to re-evaluate - keep the original type
        // This shouldn't happen for trait methods due to validation in evaluateTraitField
        return param;
      }

      const typeExprClone = cloneExpr(param.exprs.typeExpr);
      const evaluatedTypeExpr = evaluateExpression({
        expr: typeExprClone,
        env: reEvalEnv,
        context: {
          isEvaluatingGenericImplSpecialization: true,
          stdPath: "",
          isEvaluatingFunctionType: true,
          SelfType,
        } as EvaluatorContext,
      });

      if (isTypeValue(evaluatedTypeExpr.$?.value)) {
        // Keep typeExpr so defaulted parameters can re-evaluate with concrete bindings
        return {
          ...param,
          type: evaluatedTypeExpr.$.value.value,
          exprs: { ...param.exprs },
        };
      }

      // Fallback to original type if re-evaluation doesn't produce a type
      return param;
    }
  );

  // Re-evaluate the return type expression
  let newReturnType = functionType.return.type;
  const returnTypeExprClone = cloneExpr(functionType.return.typeExpr);
  const evaluatedReturnTypeExpr = evaluateExpression({
    expr: returnTypeExprClone,
    env: reEvalEnv,
    context: {
      isEvaluatingGenericImplSpecialization: true,
      stdPath: "",
      isEvaluatingFunctionType: true,
      SelfType,
    } as EvaluatorContext,
  });

  if (isTypeValue(evaluatedReturnTypeExpr.$?.value)) {
    newReturnType = evaluatedReturnTypeExpr.$.value.value;
  }

  // Re-evaluate SelfType if present (it's likely already concrete from substitutions)
  let newSelfType = functionType.SelfType;
  if (SelfType) {
    newSelfType = SelfType;
  }

  // Determine which forall parameters have been resolved by the substitutions.
  // Only clear forall parameters whose names exist in the substitution frame;
  // method-level forall params (like B in Functor's map) may remain unresolved.
  const remainingForallParams = functionType.forallParameters.filter(
    (fp) => !substitutionNames.has(fp.label)
  );

  // Create the new parametersFrame with re-evaluated types
  const newParametersFrame = {
    ...functionType.parametersFrame,
    variables: functionType.parametersFrame.variables.map((v) => {
      // Find the corresponding parameter in newParameters
      const newParam = newParameters.find((p) => p.label === v.name);
      const newType = newParam ? newParam.type : v.type;

      if (newType !== v.type) {
        return { ...v, type: newType };
      }
      return v;
    }),
  };

  // Use specializedEnv as the base for the returned env, NOT baseEnv.
  // baseEnv is built from functionType.env (which includes extra frames from
  // impl field list evaluation) and causes frame-level mismatches — the
  // assignment.ts check compares variable.frameLevel against env.frames.length.
  //
  // However, functionType.env may contain variables not in specializedEnv
  // (e.g., F from HKT trait scopes). The returned function type's
  // exprs.typeExpr still references original expressions (e.g., F(A)), so
  // subsequent re-evaluations at call sites need those variables available.
  // Merge them into specializedEnv's top frame to preserve the frame count.
  let returnEnv = specializedEnv;
  const existingVarNames = new Set<string>();
  for (const frame of specializedEnv.frames) {
    for (const v of frame.variables) {
      existingVarNames.add(v.name);
    }
  }
  for (const frame of functionType.env.frames) {
    for (const v of frame.variables) {
      if (!existingVarNames.has(v.name)) {
        const { env: updatedEnv } = addVariableToEnv({
          env: returnEnv,
          variable: { ...v },
          allowVariableShadowing: true,
        });
        returnEnv = updatedEnv;
        existingVarNames.add(v.name);
      }
    }
  }

  return {
    ...functionType,
    env: returnEnv,
    forallParameters: remainingForallParams,
    parameters: newParameters,
    parametersFrame: newParametersFrame,
    return: { ...functionType.return, type: newReturnType },
    SelfType: newSelfType,
  };
}

/**
 * Registry of types that have impl fields from a specific module path.
 * This allows cleanup when a module is re-evaluated or deleted.
 */
const implRegistry: Map<string, Set<TraitType>> = new Map();

// ============================================================================
// Phase N (THREAD_SAFETY): Negative-impl registry.
// A negative impl `impl(T, !(Send))` declares that T does NOT implement Send,
// overriding any auto-derive. Keyed by "typeId:traitTypeId".
// ============================================================================
const negativeImplRegistry: Set<string> = new Set();

interface NegativeGenericImpl {
  forallParameters: ForallParameter[];
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  receiverTypePattern: Type;
  traitType: TraitType;
  sourceModulePath?: string;
}
const negativeGenericImplRegistry: NegativeGenericImpl[] = [];

function registerNegativeImpl(typeId: string, traitTypeId: string): void {
  negativeImplRegistry.add(`${typeId}:${traitTypeId}`);
}

export function hasNegativeImpl(typeId: string, traitTypeId: string): boolean {
  return negativeImplRegistry.has(`${typeId}:${traitTypeId}`);
}

export function findMatchingNegativeGenericImpl(
  concreteType: Type,
  traitType: TraitType,
  env: Environment
): NegativeGenericImpl | undefined {
  for (const negImpl of negativeGenericImplRegistry) {
    if (negImpl.traitType.id !== traitType.id) continue;
    const match = tryMatchGenericImpl({
      concreteType,
      impl: {
        forallParameters: negImpl.forallParameters,
        whereConstraints: negImpl.whereConstraints,
        receiverTypePattern: negImpl.receiverTypePattern,
        traitType: negImpl.traitType,
        traitValue: undefined as unknown as TraitValue,
        expr: undefined as unknown as Expr,
        sourceModulePath: negImpl.sourceModulePath,
        definitionEnv: env,
      },
      env,
    });
    if (match.matched) return negImpl;
  }
  return undefined;
}

/** Negative trait entry from an impl block (before registration). */
type NegativeImplEntry = {
  traitType: TraitType;
  sourceExpr: Expr;
};

/**
 * Generic impl that uses forall type parameters.
 * For example: impl(forall(T : Type), Data(T), Copy())
 */
/** A forall parameter can be either a type parameter (SomeType) or a value parameter (unknown value) */
export type ForallParameter =
  | { kind: "type"; name: string; someType: SomeType }
  | { kind: "value"; name: string; type: Type; unknownValue: UnknownValue };

export interface GenericImpl {
  /** The type parameters (e.g., T, Size) */
  forallParameters: ForallParameter[];
  /** The constraints from where clause (e.g., T <: Copy) */
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  /** The receiver type pattern containing SomeTypes (e.g., Data(T)) */
  receiverTypePattern: Type;
  /** The trait type being implemented (e.g., Copy) */
  traitType: TraitType;
  /** The trait value */
  traitValue: TraitValue;
  /** The expr that created this impl */
  expr: Expr;
  /** The source module path for cleanup on re-evaluation */
  sourceModulePath?: string;
  /** The environment where the impl was defined (for accessing non-exported variables like extern functions) */
  definitionEnv: Environment;
  /**
   * The trait type argument expressions (e.g., [Box(T)] for Eq(Box(T)))
   * These need to be re-evaluated with substitutions to get concrete trait type parameters like Rhs
   */
  traitTypeArgExprs?: Expr[];
  /**
   * The trait function's parameter names (e.g., ["Rhs"] for Eq(Rhs))
   * Paired with traitTypeArgExprs to bind parameters during specialization
   */
  traitFunctionParamNames?: string[];
}

type ImplTraitEntry = {
  traitValue: TraitValue;
  sourceExpr?: Expr;
  isAnonymousTrait: boolean;
};

function extractTraitTypeArgsFromImplExpr({
  traitExpr,
  traitType,
}: {
  traitExpr: Expr | undefined;
  traitType: TraitType;
}): {
  traitTypeArgExprs?: Expr[];
  traitFunctionParamNames?: string[];
} {
  if (!traitExpr || !exprIsFunctionCall(traitExpr)) {
    return {};
  }

  // For function-based traits: traitExpr is like Add(i32)(...) - the func is Add(i32)
  const traitTypeCallExpr = traitExpr.func;
  if (exprIsFunctionCall(traitTypeCallExpr)) {
    const traitTypeArgExprs = traitTypeCallExpr.args.map((arg) =>
      cloneExpr(arg)
    );

    let traitFunctionParamNames: string[] | undefined;
    if (
      traitType.functionValue &&
      isFunctionType(traitType.functionValue.type)
    ) {
      const funcType = traitType.functionValue.type;
      if (funcType.parameters.length > 0) {
        traitFunctionParamNames = funcType.parameters.map((p) => p.label);
      } else if (funcType.forallParameters.length > 0) {
        traitFunctionParamNames = funcType.forallParameters.map((p) => p.label);
      }
    }

    // Also extract associated type field expressions from the impl body.
    // For Index(usize)(Output : T, index : ...), the impl body args are
    // traitExpr.args = [Output : T, index : ...]. We extract labeled
    // non-function fields (associated types like Output) so they can be
    // re-evaluated with concrete substitutions alongside the trait's
    // function parameter args.
    if (traitFunctionParamNames) {
      for (const arg of traitExpr.args) {
        if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
          const labelExpr = arg.args[0]!;
          const valueExpr = arg.args[1]!;

          if (exprIsAtom(labelExpr)) {
            const label = labelExpr.token.value;
            const field = traitType.fields.find((f) => f.label === label);
            if (field && !isFunctionType(field.type)) {
              traitTypeArgExprs.push(cloneExpr(valueExpr));
              traitFunctionParamNames.push(label);
            }
          }
        }
      }
    }

    return { traitTypeArgExprs, traitFunctionParamNames };
  }

  // For direct trait types: traitExpr is like Iter(Item: T, IntoIterType: MyIter(T), next: ...)
  // Extract labeled arguments for non-function fields (associated types)
  if (!traitType.functionValue) {
    const argExprs: Expr[] = [];
    const paramNames: string[] = [];

    for (const arg of traitExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
        const labelExpr = arg.args[0]!;
        const valueExpr = arg.args[1]!;

        if (exprIsAtom(labelExpr)) {
          const label = labelExpr.token.value;
          // Only include non-function fields (associated types)
          const field = traitType.fields.find((f) => f.label === label);
          if (field && !isFunctionType(field.type)) {
            argExprs.push(cloneExpr(valueExpr));
            paramNames.push(label);
          }
        }
      }
    }

    if (argExprs.length > 0) {
      return {
        traitTypeArgExprs: argExprs,
        traitFunctionParamNames: paramNames,
      };
    }
  }

  return {};
}

/**
 * Pre-pass helper: try to forward-declare a function-typed impl field as a
 * shell so that sibling fields in the same impl block can reference it
 * (mutual recursion). Returns null for non-function-shaped fields, leaving
 * them to the main pass.
 *
 * The shell is a real FunctionValue with the unevaluated body attached. The
 * main pass evaluates the body and mutates the same shell in place, keeping
 * funcId / identity stable for siblings that already resolved this name.
 */
function tryCreateForwardShell({
  fieldExpr,
  env,
  context,
  receiverType,
}: {
  fieldExpr: Expr;
  env: Environment;
  context: EvaluatorContext;
  receiverType: Type;
}): { shell: FunctionValue; env: Environment } | null {
  // Must be `name : value`
  if (
    !exprIsFunctionCall(fieldExpr) ||
    !exprIsFunctionCallOf(fieldExpr, ":", 2)
  ) {
    return null;
  }
  const labelExpr = fieldExpr.args[0]!;
  const valueExpr = fieldExpr.args[1]!;
  if (!exprIsAtom(labelExpr) || !isValidVariableName(labelExpr)) {
    return null;
  }

  // value must be `(fn(...) -> R)(body)` — i.e. a call whose func is `->`
  // applied to (fn(...), R). Other shapes (lambdas, Impl(Fn(...))(...) etc.)
  // are not currently forward-declarable; fall through to the main pass.
  if (!exprIsFunctionCall(valueExpr)) return null;
  if (valueExpr.args.length !== 1) return null;
  const fnTypeExpr = valueExpr.func;
  if (
    !exprIsFunctionCall(fnTypeExpr) ||
    !exprIsFunctionCallOf(fnTypeExpr, "->", 2)
  ) {
    return null;
  }
  const fnHeadExpr = fnTypeExpr.args[0]!;
  if (
    !exprIsFunctionCall(fnHeadExpr) ||
    !(
      exprIsFunctionCallOf(fnHeadExpr, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(fnHeadExpr, BuiltinKeywords.ctl) ||
      exprIsFunctionCallOf(fnHeadExpr, BuiltinKeywords.unsafe_fn)
    )
  ) {
    return null;
  }

  const label = labelExpr.token.value;

  // Evaluate the function-type head only (best-effort). If the signature
  // depends on something not yet defined, fall through and let the main pass
  // produce a proper error.
  let typeResult: Expr;
  try {
    typeResult = evaluateExpression({
      expr: cloneExpr(fnTypeExpr),
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: receiverType,
      },
    });
  } catch {
    return null;
  }

  const typeValue = typeResult.$?.value;
  if (
    !typeValue ||
    !isTypeValue(typeValue) ||
    !isFunctionType(typeValue.value)
  ) {
    return null;
  }
  const fnType = typeValue.value;
  const bodyExpr = valueExpr.args[0]!;

  const shell: FunctionValue = {
    tag: ValueTag.Function,
    type: fnType,
    body: bodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: label,
    funcId: `fn_${randomId(env.modulePath)}_${label}`,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Add to receiver trait so Self.method dispatch (`self.X(...)`) can
  // resolve forward references. We deliberately do NOT bind the shell as a
  // local variable in the impl env: doing so would shadow names inside the
  // method bodies (e.g. a method body declaring `let len := ...` would
  // collide with a sibling field also named `len`). Forward refs via bare
  // names are not supported in v1; use `self.X` instead.
  if (receiverType?.trait) {
    receiverType.trait.fields.push({
      label,
      type: fnType,
      assignedValue: shell,
      defaultValue: undefined,
      exprs: { expr: fieldExpr },
      docComment: undefined,
    });
  }

  return { shell, env: typeResult.$!.env };
}

function evaluateImplFieldList({
  fieldExprs,
  env,
  context,
  receiverType,
}: {
  fieldExprs: Expr[];
  env: Environment;
  context: EvaluatorContext;
  receiverType: Type;
}): {
  env: Environment;
  traitEntries: ImplTraitEntry[];
  negativeTraitEntries: NegativeImplEntry[];
} {
  const traitEntries: ImplTraitEntry[] = [];
  const negativeTraitEntries: NegativeImplEntry[] = [];

  const traitType = createTraitType(env);
  const traitElementValues: (Value | undefined)[] = [];
  let hasAnonymousFields = false;

  // Temporarily extend receiver type trait so Self.X resolves within the impl list
  const receiverTypeOriginalTrait = receiverType?.trait;
  if (receiverType?.trait) {
    receiverType.trait = {
      ...receiverType.trait,
      fields: [...receiverType.trait.fields],
    };
  }

  // Push new frame to the env so impl fields don't leak
  env = pushEnvFrame(env);

  // ============================================================
  // Pre-pass: forward-declare function-typed fields as shells.
  //
  // For each field of the form `name : (fn(<sig>) -> R)(<body>)`, we
  // evaluate just the `fn(...) -> R` head to get the FunctionType, allocate
  // a real FunctionValue shell with the unevaluated body attached, and bind
  // the name in the local env. Subsequent fields can then forward-reference
  // these shells (mutual recursion). The main pass below evaluates the body
  // and mutates the same shell IN PLACE, preserving funcId / identity for
  // any sibling references already resolved.
  // ============================================================
  const fieldShells = new Map<number, FunctionValue>();
  for (let fieldIndex = 0; fieldIndex < fieldExprs.length; fieldIndex++) {
    const fieldExpr = fieldExprs[fieldIndex]!;
    const shellResult = tryCreateForwardShell({
      fieldExpr,
      env,
      context,
      receiverType,
    });
    if (!shellResult) continue;
    fieldShells.set(fieldIndex, shellResult.shell);
    env = shellResult.env;
  }

  for (let fieldIndex = 0; fieldIndex < fieldExprs.length; fieldIndex++) {
    const expr = fieldExprs[fieldIndex]!;
    // Disallow begin blocks in new impl field syntax
    if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
    ) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `impl receiverType, ... no longer accepts begin blocks. Use "impl { ... }" for anonymous traits.`,
      });
    }

    // Reject unsupported field assignment syntax
    if (
      exprIsFunctionCall(expr) &&
      (exprIsFunctionCallOf(expr, "::", 2) ||
        exprIsFunctionCallOf(expr, ":=", 2))
    ) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `impl fields must use ":". "::" and ":=" are not allowed here.`,
      });
    }

    // Field definition: name : value
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ":", 2)) {
      const labelExpr = expr.args[0]!;
      const valueExpr = expr.args[1]!;

      if (!exprIsAtom(labelExpr) || !isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for impl field name, got:\n${exprToString(labelExpr)}`,
        });
      }

      const label = labelExpr.token.value;

      // Evaluate the value expression with Self in context
      const evaluatedValueExpr = evaluateExpression({
        expr: valueExpr,
        env,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: receiverType,
        },
      });

      if (!evaluatedValueExpr.$?.type) {
        throw formatErrorMessage({
          token: valueExpr.token,
          errorMessage: `Failed to evaluate impl field value for "${label}".`,
        });
      }

      env = evaluatedValueExpr.$.env;
      const fieldType = evaluatedValueExpr.$.type;
      let fieldValue = evaluatedValueExpr.$.value;

      if (!fieldValue) {
        throw formatErrorMessage({
          token: valueExpr.token,
          errorMessage: `impl field "${label}" must be a compile-time value.`,
        });
      }

      // If a forward-decl shell was created in the pre-pass for this field,
      // mutate the shell IN PLACE with the analyzed FunctionValue's fields,
      // preserving the shell's funcId so any sibling references already
      // resolved to the shell remain valid. Then use the shell as the
      // canonical FunctionValue for this field.
      const shell = fieldShells.get(fieldIndex);
      if (shell && isFunctionValue(fieldValue) && fieldValue !== shell) {
        const stableFuncId = shell.funcId;
        const stableFuncName = shell.funcName;
        const preservedSpecs = shell.specializedFunctionCaches;
        const preservedComptimeCaches = shell.calledComptimeFunctionCaches;
        // Copy analyzed metadata onto the shell.
        shell.type = fieldValue.type;
        shell.body = fieldValue.body;
        shell.specializedType = fieldValue.specializedType;
        shell.cpsTransformedBody = fieldValue.cpsTransformedBody;
        shell.isControlFunction = fieldValue.isControlFunction;
        shell.definitionSiteEnclosingFunctionType =
          fieldValue.definitionSiteEnclosingFunctionType;
        shell.closureInfo = fieldValue.closureInfo;
        shell.isEffectRecordMember = fieldValue.isEffectRecordMember;
        shell.isIoAsyncStateMachineClosure =
          fieldValue.isIoAsyncStateMachineClosure;
        shell.deriveRule = fieldValue.deriveRule;
        // Preserve funcId, funcName, and any specializations already created
        // through forward references during sibling body evaluation.
        shell.funcId = stableFuncId;
        shell.funcName = stableFuncName ?? label;
        shell.specializedFunctionCaches = preservedSpecs;
        shell.calledComptimeFunctionCaches = preservedComptimeCaches;
        // Redirect the orphan FunctionValue (the one created by
        // evaluateExpression on the inner valueExpr) to the shell's funcId
        // and funcName. AST nodes inside the body that were evaluated against
        // the orphan (e.g. `recur`, or `valueExpr.$.value` itself referenced
        // by codegen's findFunctionCallsInExpr walk) will then collapse into
        // the shell's codegen entry instead of being emitted as a duplicate
        // function definition that re-uses temp-variable names without
        // declaring them.
        fieldValue.funcId = stableFuncId;
        fieldValue.funcName = stableFuncName ?? label;
        fieldValue = shell;
      } else if (isFunctionValue(fieldValue) && !fieldValue.funcName) {
        fieldValue.funcName = label;
        fieldValue.funcId += `_${label}`;
      }

      const fieldDocComment = context.docCommentLookup?.get(
        getDocCommentLookupKey(labelExpr.token)
      );

      // Add to env for subsequent fields to reference. We bind even when a
      // shell exists in the pre-pass (the pre-pass deliberately did NOT
      // bind, see tryCreateForwardShell — to avoid shadowing local vars in
      // sibling method bodies). The binding here only takes effect for
      // fields evaluated AFTER this one, matching pre-shell semantics.
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: label,
          type: fieldType,
          isCompileTimeOnly: true,
          value: [fieldValue],
          token: labelExpr.token,
          initializedAtToken: labelExpr.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      env = nextEnv;

      // Add to anonymous trait fields
      traitType.fields.push({
        label,
        type: fieldType,
        assignedValue: fieldValue,
        defaultValue: undefined,
        exprs: { expr },
        docComment: fieldDocComment,
      });
      traitElementValues.push(fieldValue);
      hasAnonymousFields = true;

      // Also add to receiver trait for Self.method resolution within this
      // impl list. Skip when a shell already added an entry in the pre-pass
      // (the shell entry's assignedValue refers to the same object we just
      // mutated, so it already reflects the analyzed body).
      if (receiverType?.trait && !shell) {
        receiverType.trait.fields.push({
          label,
          type: fieldType,
          assignedValue: fieldValue,
          defaultValue: undefined,
          exprs: { expr },
          docComment: fieldDocComment,
        });
      } else if (receiverType?.trait && shell) {
        // Update doc comment on the pre-pass entry (we didn't have it then).
        const existingField = receiverType.trait.fields.find(
          (f) => f.label === label && f.assignedValue === shell
        );
        if (existingField) {
          existingField.docComment = fieldDocComment;
          existingField.type = fieldType;
        }
      }

      continue;
    }

    // Phase N: Negative trait impl — !(Trait)
    if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCallOf(expr, "!") &&
      expr.args.length === 1
    ) {
      const negatedTraitExpr = expr.args[0]!;
      const evaluatedNegatedTrait = evaluateExpression({
        expr: negatedTraitExpr,
        env,
        context: {
          ...context,
          expectedType: undefined,
          ReceiverType: receiverType,
        },
      });
      let negatedTraitType: TraitType | undefined;
      if (
        evaluatedNegatedTrait.$ &&
        isTraitValue(evaluatedNegatedTrait.$.value)
      ) {
        negatedTraitType = evaluatedNegatedTrait.$.value.type;
      } else if (
        evaluatedNegatedTrait.$ &&
        isTypeValue(evaluatedNegatedTrait.$.value) &&
        isTraitType(evaluatedNegatedTrait.$.value.value)
      ) {
        negatedTraitType = evaluatedNegatedTrait.$.value.value;
      }
      if (!negatedTraitType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Expected trait type after '!', got:\n${exprToString(negatedTraitExpr)}`,
        });
      }
      negativeTraitEntries.push({
        traitType: negatedTraitType,
        sourceExpr: expr,
      });
      continue;
    }

    // Trait value implementation
    const evaluatedTraitExpr = evaluateExpression({
      expr,
      env,
      context: {
        ...context,
        expectedType: undefined,
        ReceiverType: receiverType,
      },
    });

    if (!evaluatedTraitExpr.$ || !isTraitValue(evaluatedTraitExpr.$.value)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected trait value in impl field list, got:\n${exprToString(expr)}`,
      });
    }

    env = evaluatedTraitExpr.$.env;
    traitEntries.push({
      traitValue: evaluatedTraitExpr.$.value,
      sourceExpr: expr,
      isAnonymousTrait: false,
    });
  }

  // Pop the env frame
  env = popEnvFrame(env);

  // Restore receiver trait to avoid duplication
  if (receiverType) {
    receiverType.trait = receiverTypeOriginalTrait;
  }

  if (hasAnonymousFields) {
    const anonymousTraitValue = createTraitValue(
      { ...traitType, receiverType },
      traitElementValues
    );
    traitEntries.unshift({
      traitValue: anonymousTraitValue,
      sourceExpr: undefined,
      isAnonymousTrait: true,
    });
  }

  return { env, traitEntries, negativeTraitEntries };
}

/**
 * Registry of generic impls keyed by trait type name.
 * This allows lookup when checking if a concrete type implements a trait.
 */
const genericImplRegistry: Map<string, GenericImpl[]> = new Map();

/**
 * Set of "receiverTypeId:traitTypeId" pairs that are currently mid-registration
 * in evaluateImplBlock (non-generic impls only). Used to handle recursive types
 * such as `TreeNode :: enum(Branch(left: Box(Self), ...))` with `derive(TreeNode, Clone)`:
 * when the clone body validates `Box(TreeNode) <: Clone`, it checks `TreeNode <: Clone`,
 * which would fail because the impl hasn't been registered yet.
 */
const currentlyRegisteringConcreteImpls: Set<string> = new Set();

/**
 * Check if a concrete impl (receiverTypeId : traitTypeId) is currently being
 * registered. Called from typeImplementsTrait to handle recursive trait impls.
 */
export function isConcreteImplBeingRegistered(
  receiverTypeId: string,
  traitTypeId: string
): boolean {
  return currentlyRegisteringConcreteImpls.has(
    `${receiverTypeId}:${traitTypeId}`
  );
}

/**
 * Version counter for the generic impl registry. Incremented whenever a new
 * generic impl is registered or the registry is mutated. Used to invalidate
 * the method lookup cache.
 */
let genericImplRegistryVersion = 0;

/**
 * Cache for findMethodsFromGenericImpls results.
 * Key: `typeToString(concreteType) + "\0" + methodName`
 * Value: { result, version } where version is the registry version at cache time.
 */
const genericImplMethodCache = new Map<
  string,
  {
    result: { type: FunctionType; value: Value | undefined }[];
    version: number;
  }
>();

/**
 * Registry tracking which trait are implemented for which types.
 * Maps from type id to an array of impl records.
 * Used for duplicate impl detection.
 */
interface ImplRecord {
  traitTypeId: string;
  traitTypeName?: string;
  modulePath: string;
  expr: Expr;
}
const typeImplRegistry: Map<string, ImplRecord[]> = new Map();

/**
 * Clear all generic impls from the registry that were added by the specified module.
 * Call this before re-evaluating a trait to prevent duplicate impls.
 */
export function clearGenericImplsFromModule(modulePath: string): void {
  for (const [traitTypeName, impls] of genericImplRegistry.entries()) {
    const filteredImpls = impls.filter(
      (impl) => impl.sourceModulePath !== modulePath
    );
    if (filteredImpls.length === 0) {
      genericImplRegistry.delete(traitTypeName);
    } else {
      genericImplRegistry.set(traitTypeName, filteredImpls);
    }
  }
  genericImplRegistryVersion++;
  genericImplMethodCache.clear();
}

/**
 * Clear impl records from the type impl registry for a specific module.
 * Call this before re-evaluating a trait to prevent duplicate impl detection.
 */
function clearImplRecordsFromModule(modulePath: string): void {
  for (const [typeId, impls] of typeImplRegistry.entries()) {
    const filteredImpls = impls.filter(
      (impl) => impl.modulePath !== modulePath
    );
    if (filteredImpls.length === 0) {
      typeImplRegistry.delete(typeId);
    } else {
      typeImplRegistry.set(typeId, filteredImpls);
    }
  }
}

/**
 * Clear ALL global impl registries.
 * Use this to completely reset global state between independent compilation runs.
 */
export function clearAllGlobalImplState(): void {
  // Strip module-sourced fields from every trait the registry touched BEFORE
  // dropping the tracking. Builtin type singletons (str, i32, …) are cached
  // process-wide; without this their traits keep the previous session's impl
  // fields and the next prelude evaluation sees stale duplicates.
  for (const typesWithImpls of implRegistry.values()) {
    for (const traitType of typesWithImpls) {
      traitType.fields = traitType.fields.filter(
        (field) => !field.sourceModulePath
      );
    }
  }
  implRegistry.clear();
  genericImplRegistry.clear();
  typeImplRegistry.clear();
  genericImplMethodCache.clear();
  genericImplRegistryVersion = 0;
}

/**
 * Get the base trait key for registry lookup.
 * For parameterized traits like Eq(Box(T)) or Eq(i32), this returns the funcId of the base trait function (Eq).
 * This ensures that all instantiations of the same trait share the same registry key.
 */
function getBaseTraitKey(traitType: TraitType): string {
  // Use the funcId of the trait's function value if available
  // This is the most reliable way to identify the base trait
  if (traitType.functionValue) {
    return traitType.functionValue.funcId;
  }
  // Fall back to typeName or id for non-parameterized traits
  return traitType.typeName || traitType.id;
}

/**
 * Get a stable identifier for a receiver type's base constructor.
 * For generic types like Option(T), this returns the constructor function's funcId.
 * For non-generic types, returns the type's own id.
 */
function getReceiverBaseTypeId(type: Type): string | undefined {
  if ("functionValue" in type) {
    const funcVal = (type as { functionValue?: FunctionValue }).functionValue;
    if (funcVal) {
      return funcVal.funcId;
    }
  }
  return type.id;
}

/**
 * Register a generic impl in the registry.
 */
function registerGenericImpl(
  traitTypeName: string,
  genericImpl: GenericImpl
): void {
  // Check for duplicate method names across anonymous impl blocks for the same receiver type
  if (!genericImpl.traitType.typeName) {
    const newMethodNames = genericImpl.traitType.fields
      .filter((f) => f.label && isFunctionType(f.type))
      .map((f) => f.label);

    if (newMethodNames.length > 0) {
      const receiverBaseId = getReceiverBaseTypeId(
        genericImpl.receiverTypePattern
      );
      if (receiverBaseId) {
        for (const [_key, existingImpls] of genericImplRegistry.entries()) {
          for (const existingImpl of existingImpls) {
            // Only check anonymous traits (method definitions)
            if (existingImpl.traitType.typeName) continue;

            const existingBaseId = getReceiverBaseTypeId(
              existingImpl.receiverTypePattern
            );
            if (existingBaseId !== receiverBaseId) continue;

            for (const existingField of existingImpl.traitType.fields) {
              if (
                existingField.label &&
                isFunctionType(existingField.type) &&
                newMethodNames.includes(existingField.label)
              ) {
                throw formatErrorMessage({
                  token: genericImpl.expr.token,
                  errorMessage:
                    `Method "${existingField.label}" is already defined for type "${typeToString(genericImpl.receiverTypePattern)}".\n` +
                    `Cannot define duplicate method names across impl blocks. ` +
                    `Use a different name (e.g., "comptime_${existingField.label}") for the comptime variant.`,
                });
              }
            }
          }
        }
      }
    }
  }

  let impls = genericImplRegistry.get(traitTypeName);
  if (!impls) {
    impls = [];
    genericImplRegistry.set(traitTypeName, impls);
  }
  impls.push(genericImpl);
  genericImplRegistryVersion++;
}

/**
 * Check if a trait is already implemented for a type.
 * Throws an error if duplicate impl is detected.
 */
function checkDuplicateImpl({
  receiverType,
  traitType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  const typeId = receiverType.id;
  const impls = typeImplRegistry.get(typeId) || [];

  const existing = impls.find((impl) => impl.traitTypeId === traitType.id);
  if (existing) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Trait "${traitType.typeName ?? traitType.id}" is already implemented for type "${typeToString(receiverType)}".\n` +
        `First implementation was in: ${existing.modulePath || "unknown"}`,
    });
  }
}

/**
 * Register that a trait has been implemented for a type.
 */
function registerImplForType({
  receiverType,
  traitType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  const typeId = receiverType.id;
  let impls = typeImplRegistry.get(typeId);
  if (!impls) {
    impls = [];
    typeImplRegistry.set(typeId, impls);
  }

  impls.push({
    traitTypeId: traitType.id,
    traitTypeName: traitType.typeName,
    modulePath: currentModulePath || "unknown",
    expr,
  });
}

/**
 * Check orphan rule: at least one of the trait or the type must be defined in the current module.
 * Throws an error if the orphan rule is violated.
 */
function checkOrphanRule({
  receiverType,
  traitType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  // If we don't have a current module path, we can't check the orphan rule
  // This happens for top-level code or tests - allow it
  if (!currentModulePath) {
    return;
  }

  const moduleDefinedHere = traitType.definedInModulePath === currentModulePath;
  const typeDefinedHere =
    receiverType.definedInModulePath === currentModulePath;

  // Prelude is special - allow prelude to impl any module for any type
  // This is necessary for built-in impls
  // Use both "/" and "\" separators for cross-platform compatibility (Windows paths use "\")
  const normalizedModulePath = currentModulePath.replace(/\\/g, "/");
  if (
    normalizedModulePath.includes("prelude.yo") ||
    normalizedModulePath.includes("std/")
  ) {
    return;
  }

  if (!moduleDefinedHere && !typeDefinedHere) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Orphan impl: Cannot implement foreign trait "${traitType.typeName ?? traitType.id}" for foreign type "${typeToString(receiverType)}".\n` +
        `At least one of the trait or the type must be defined in this module.\n` +
        `Trait defined in: ${traitType.definedInModulePath || "unknown"}\n` +
        `Type defined in: ${receiverType.definedInModulePath || "unknown"}\n` +
        `Current module: ${currentModulePath}`,
    });
  }
}

/**
 * Find a matching generic impl for a concrete type and trait type.
 * Returns the matched impl if found, or undefined if no match.
 */
export function findMatchingGenericImpl({
  concreteType,
  traitType,
  env,
}: {
  concreteType: Type;
  traitType: TraitType;
  env: Environment;
}): GenericImpl | undefined {
  // Use the base trait key (funcId) for lookup
  const traitTypeKey = getBaseTraitKey(traitType);

  const impls = genericImplRegistry.get(traitTypeKey);
  if (!impls || impls.length === 0) {
    return undefined;
  }

  for (const impl of impls) {
    const match = tryMatchGenericImpl({
      concreteType,
      impl,
      env,
    });
    if (match.matched) {
      return impl;
    }
  }

  return undefined;
}

/**
 * Find methods from generic impls for a concrete type.
 * Searches all generic impls to find ones that match the type and have the method.
 * Returns an array of matching methods' type and value.
 */
export function findMethodsFromGenericImpls({
  concreteType,
  methodName,
  env,
}: {
  concreteType: Type;
  methodName: string;
  env: Environment;
}): { type: FunctionType; value: Value | undefined }[] {
  // CRITICAL: If concreteType is a SomeType, resolve it from the environment
  // to get the actual concrete type. This is necessary when checking trait
  // constraints like `K <: Hash` where `K = Box(i32)`. Without this resolution,
  // the impl matching would try to match `Box(T)` against `K` instead of `Box(i32)`,
  // resulting in incorrect type parameter bindings.
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (!isSomeType(resolvedType)) {
      concreteType = resolvedType;
    }
  }

  // Check cache: if we've already resolved this concrete type + method name
  // with the same registry version, return the cached result
  if (!isSomeType(concreteType)) {
    const cacheKey = concreteType.id + "\0" + methodName;
    const cached = genericImplMethodCache.get(cacheKey);
    if (cached && cached.version === genericImplRegistryVersion) {
      return cached.result;
    }
  }

  const methods: { type: FunctionType; value: Value | undefined }[] = [];
  // Track whether each method comes from an inherent (anonymous) impl.
  // Inherent methods take priority over trait impl methods (like Rust).
  const methodIsInherent: boolean[] = [];

  // Search through all trait types in the registry
  for (const [_traitTypeName, impls] of genericImplRegistry.entries()) {
    for (const impl of impls) {
      // Check if this impl matches the concrete type
      const match = tryMatchGenericImpl({
        concreteType,
        impl,
        env,
      });
      if (!match.matched) {
        continue;
      }

      // Found a matching impl - look for the method
      const traitType = impl.traitType;
      const traitValue = impl.traitValue;
      const isInherentImpl = !traitType.typeName;

      const methodIndex = traitType.fields.findIndex(
        (f) => f.label === methodName && isFunctionType(f.type)
      );

      if (methodIndex >= 0) {
        const method = traitType.fields[methodIndex]!;
        if (isFunctionType(method.type)) {
          // Get the actual function value from the trait value
          const originalValue = traitValue.fields[methodIndex];

          // Check if we should create a specialized function value
          // IMPORTANT: We should NOT create specialized function values when the concreteType
          // contains Unknown values. This happens during initial function definition when
          // parameters are still Unknown. In this case, just return the original type
          // with undefined value - no specialized function body is created.
          // The proper specialization will happen later when called with concrete values.
          const hasUnknownTypes = typeContainsUnknownValue(concreteType);

          // When any forall type parameter is bound to a SomeType (e.g., T→U
          // inside a forall(U) method), we can't fully specialize the body.
          // The type-only specialization path handles this correctly.
          // EXCEPTION: SomeTypes with resolvedConcreteType (e.g., closure
          // wrappers `__impl_fn` carrying their concrete struct type) are
          // effectively resolved — treat them as concrete here so the body
          // can be specialized.
          const hasUnresolvedTypeParams = [...match.substitutions].some(
            ([key, type]) =>
              key !== "Self" && isSomeType(type) && !type.resolvedConcreteType
          );

          // When any forall type parameter is NOT in substitutions, the concrete
          // type is the impl's own receiver pattern (template type, e.g.,
          // MapBranch(K, V) where K, V are the forall SomeTypes themselves).
          // We can't specialize the body because the forall params won't be in scope.
          const hasMissingForallParams = impl.forallParameters.some(
            (p) => p.kind === "type" && !match.substitutions.has(p.name)
          );

          // When the method itself has its own forall parameters (inner
          // forall, e.g., `map :: fn(forall(A, B), ...)` inside a blanket
          // `impl(forall(I), I, map: ...)`), those A/B params are NOT in
          // `match.substitutions` — they are resolved at the call site from
          // argument types. We must NOT pre-evaluate the body here, because
          // doing so would leave A/B as unresolved SomeTypes baked into any
          // returned struct/enum types (e.g., `IterMap(Self, A, B)` would
          // contain `SomeType(A)`, `SomeType(B)` forever).
          //
          // Instead, do the type-only specialization (re-evaluate the
          // function type so Self/I are concrete) and let the call site's
          // `createSpecializedFunctionInline` evaluate the body once A/B are
          // bound from argument types.
          const methodHasUnresolvedInnerForall =
            isFunctionType(method.type) &&
            method.type.forallParameters.some(
              (fp) => !match.substitutions.has(fp.label)
            );

          const shouldCreateSpecializedValue =
            isFunctionValue(originalValue) &&
            (match.valueSubstitutions.size > 0 ||
              match.substitutions.size > 0) &&
            !hasUnknownTypes &&
            !hasUnresolvedTypeParams &&
            !hasMissingForallParams &&
            !methodHasUnresolvedInnerForall;

          // When forall type parameters are missing from substitutions, the
          // concrete type is the impl's own unspecialized template (e.g.,
          // MapBranch(K, V) where K, V are the forall SomeTypes themselves).
          // We cannot specialize or use this method — skip it entirely.
          if (hasMissingForallParams) {
            continue;
          }

          if (shouldCreateSpecializedValue) {
            // Use the environment where the impl was originally defined
            // This ensures access to non-exported variables (like extern "Yo" functions)
            // that were available when the impl was created
            const baseEnv = impl.definitionEnv;

            // Create a specialized environment with type/value substitutions bound
            // Start with a fresh frame
            let specializedEnv = pushEnvFrame(baseEnv);

            // Add type substitutions to the environment first (like T=i32, U=usize, Self=[i32; 5])
            // These must come BEFORE re-evaluating trait type args so that expressions like Box(T) become Box(i32)
            for (const [paramName, paramType] of match.substitutions) {
              // Include Self - it's needed for method bodies that reference it
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: [createTypeValue(paramType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Add value substitutions (compile-time values like n=3)
            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: [paramValue],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // IMPORTANT: Re-evaluate trait type argument expressions to get concrete trait type parameters
            // For Eq(Box(T)) with T=i32, we re-evaluate Box(T) to get Box(i32), then bind Rhs=Box(i32)
            // This is necessary because types in Yo are nominal, so we can't just substitute structurally
            if (
              impl.traitTypeArgExprs &&
              impl.traitFunctionParamNames &&
              impl.traitTypeArgExprs.length ===
                impl.traitFunctionParamNames.length
            ) {
              for (let i = 0; i < impl.traitTypeArgExprs.length; i++) {
                const argExpr = impl.traitTypeArgExprs[i]!;
                const paramName = impl.traitFunctionParamNames[i]!;

                // Re-evaluate the argument expression with substitutions bound
                const evaluatedArg = evaluateExpression({
                  expr: cloneExpr(argExpr),
                  env: specializedEnv,
                  context: {
                    isEvaluatingGenericImplSpecialization: true,
                    stdPath: "",
                  } as EvaluatorContext,
                });

                if (evaluatedArg.$ && isTypeValue(evaluatedArg.$.value)) {
                  const { env: nextEnv } = addVariableToEnv({
                    env: specializedEnv,
                    variable: {
                      name: paramName,
                      type: createType0(),
                      isCompileTimeOnly: true,
                      value: [evaluatedArg.$.value],
                      token: PlaceholderToken,
                      initializedAtToken: PlaceholderToken,
                      consumedAtToken: undefined,
                      isOwningTheRcValue: false,
                    },
                    allowVariableShadowing: true,
                  });
                  specializedEnv = nextEnv;
                }
              }
            }

            // Re-evaluate the function type to get specialized types
            // This properly handles nominal types like Option(T) -> Option(Box(i32))
            const specializedType = reEvaluateFunctionType({
              functionType: method.type,
              specializedEnv,
              SelfType: match.substitutions.get("Self"),
            });

            // Now add the parametersFrame with the specialized parameter types
            specializedEnv = pushEnvFrame(
              specializedEnv,
              specializedType.parametersFrame
            );

            // Clone the function body for re-evaluation
            const clonedBody = cloneExpr(originalValue.body);

            // Re-evaluate the function body with the concrete values.
            // Phase B/C of plans/ITERATOR_REDESIGN.md — for `-> ref(T)`
            // functions, the body produces `*(T)` (the C-ABI pointer),
            // so we set the expected body type to `*(T)` here, matching
            // the parallel logic in `createFunctionBodyEvaluationContext`.
            // Without this, evaluating the body of e.g. `Array.project`
            // wrongly expects the body to produce `T` (the unwrapped
            // return type), and `__yo_array_index(&(self), pos)` which
            // legitimately returns `*(T)` fails type unification.
            const _specBodyExpectedType = specializedType.return.isRef
              ? createPtrType(specializedType.return.type)
              : specializedType.return.type;
            const specializedBody = evaluateBeginExpression({
              expr: clonedBody,
              env: specializedEnv,
              context: {
                isEvaluatingGenericImplSpecialization: true,
                expectedType: {
                  type: _specBodyExpectedType,
                  env: specializedEnv,
                },
                stdPath: "",
                isEvaluatingFunctionBodyOrAsyncBlock: {
                  kind: "function-body",
                  type: specializedType,
                  value: originalValue,
                  evaluationEnv: specializedEnv,
                },
                functionReturnImplConcreteType: [], // Fresh array for each specialization
                // Set SelfType to the concrete type from substitutions
                SelfType: match.substitutions.get("Self"),
              } as EvaluatorContext,
              variablesToAdd: [],
              isEvaluatingFunctionBodyBeginBlock: true,
            });

            // Create a specialized function value with the re-evaluated body
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: specializedType,
              body: specializedBody,
              // Create a unique funcId for this specialization (include both type and value substitutions)
              funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
              funcName: originalValue.funcName
                ? `${originalValue.funcName}_specialized`
                : undefined,
            };

            methods.push({
              type: specializedType,
              value: specializedFunctionValue,
            });
            methodIsInherent.push(isInherentImpl);
          } else if (
            hasUnknownTypes ||
            hasUnresolvedTypeParams ||
            methodHasUnresolvedInnerForall
          ) {
            // We have unknown types (like unknown array length), unresolved type
            // parameters (like T→U inside a forall(U) method), or the method
            // has its own inner forall params not yet bound by the impl's
            // substitutions. We can't fully specialize the function body here.
            //
            // For the inner-forall case, we still produce a FunctionValue
            // (carrying the original body and the partially specialized type)
            // so that the call site's `createSpecializedFunctionInline` can
            // finish specialization once argument-driven inference resolves
            // the inner forall params (e.g., A, B in `IterMap(Self, A, B)`).

            // Use the environment where the impl was originally defined
            const baseEnv = impl.definitionEnv;

            // Create a specialized environment with type/value substitutions bound
            let specializedEnv = pushEnvFrame(baseEnv);

            // Add type substitutions to the environment (like T=i32, U=usize, Self=[i32; N])
            for (const [paramName, paramType] of match.substitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: [createTypeValue(paramType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Add value substitutions (compile-time values like n=3)
            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: [paramValue],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Re-evaluate the function TYPE to properly substitute known type
            // parameters (like T = i32) while keeping the body unevaluated.
            const specializedType = reEvaluateFunctionType({
              functionType: method.type,
              specializedEnv,
              SelfType: match.substitutions.get("Self"),
            });

            // For the inner-forall case, attach the original FunctionValue
            // (with original body) so the call site can re-specialize via
            // createSpecializedFunctionInline once inner forall params are
            // bound from arguments. Without a FunctionValue, the call site
            // has no body to evaluate.
            let typeOnlyValue: FunctionValue | undefined = undefined;
            if (
              methodHasUnresolvedInnerForall &&
              isFunctionValue(originalValue)
            ) {
              typeOnlyValue = {
                ...originalValue,
                specializedType,
              };
            }

            methods.push({ type: specializedType, value: typeOnlyValue });
            methodIsInherent.push(isInherentImpl);
          } else if (isFunctionValue(originalValue)) {
            // No substitutions needed, just set the specialized type
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: method.type,
            };
            methods.push({
              type: method.type,
              value: specializedFunctionValue,
            });
            methodIsInherent.push(isInherentImpl);
          } else if (
            !isFunctionValue(originalValue) &&
            (match.substitutions.size > 0 || match.valueSubstitutions.size > 0)
          ) {
            // The value is not a FunctionValue (e.g., UnknownValue for extern functions),
            // but we have type substitutions. We can't specialize the body, but we should
            // still specialize the TYPE so that return types like Option(T) become Option(unit).
            const baseEnv = impl.definitionEnv;
            let specializedEnv = pushEnvFrame(baseEnv);

            for (const [paramName, paramType] of match.substitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: [createTypeValue(paramType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: [paramValue],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            const specializedType = reEvaluateFunctionType({
              functionType: method.type,
              specializedEnv,
              SelfType: match.substitutions.get("Self"),
            });

            methods.push({ type: specializedType, value: originalValue });
            methodIsInherent.push(isInherentImpl);
          } else {
            methods.push({ type: method.type, value: originalValue });
            methodIsInherent.push(isInherentImpl);
          }
        }
      }
    }
  }

  // Inherent (non-trait) impl methods take priority over trait impl methods.
  // If we found the same method name from both inherent impls and trait impls,
  // keep only the inherent impl versions to avoid ambiguity.
  const hasInherent = methodIsInherent.some((v) => v);
  const hasTraitImpl = methodIsInherent.some((v) => !v);
  let filteredMethods = methods;
  if (hasInherent && hasTraitImpl) {
    filteredMethods = methods.filter((_, i) => methodIsInherent[i]);
  }

  // Store result in cache for non-SomeType concrete types
  if (!isSomeType(concreteType)) {
    const cacheKey = concreteType.id + "\0" + methodName;
    genericImplMethodCache.set(cacheKey, {
      result: filteredMethods,
      version: genericImplRegistryVersion,
    });
  }

  return filteredMethods;
}

/**
 * Enumerate all method names available on a concrete type through generic impls.
 * Used by the LSP for dot-completion — collects method names without performing
 * full specialization (which is expensive and may fail on incomplete code).
 */
export function enumerateMethodNamesFromGenericImpls({
  concreteType,
  env,
}: {
  concreteType: Type;
  env: Environment;
}): { name: string; type: FunctionType }[] {
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (!isSomeType(resolvedType)) {
      concreteType = resolvedType;
    }
  }

  const results: { name: string; type: FunctionType }[] = [];
  const seenNames = new Set<string>();

  for (const [_traitTypeName, impls] of genericImplRegistry.entries()) {
    for (const impl of impls) {
      let match: GenericImplMatchResult;
      try {
        match = tryMatchGenericImpl({ concreteType, impl, env });
      } catch {
        continue;
      }
      if (!match.matched) continue;

      for (const field of impl.traitType.fields) {
        if (
          field.label &&
          isFunctionType(field.type) &&
          !seenNames.has(field.label)
        ) {
          seenNames.add(field.label);
          results.push({ name: field.label, type: field.type });
        }
      }
    }
  }

  return results;
}

export interface GenericImplDocEntry {
  signature: string;
  traitName?: string;
  methodNames: string[];
  methods: { name: string; type: FunctionType }[];
}

function formatGenericImplSignature(impl: GenericImpl): string {
  const parts: string[] = [];

  if (impl.forallParameters.length > 0) {
    parts.push(
      `forall(${impl.forallParameters
        .map((param) =>
          param.kind === "type"
            ? `${param.name} : ${typeToString(param.someType.parentType)}`
            : `${param.name} : ${typeToString(param.type)}`
        )
        .join(", ")})`
    );
  }

  if (impl.whereConstraints.length > 0) {
    parts.push(
      `where(${impl.whereConstraints
        .map(
          ({ someType, traitType, traitExpr }) =>
            `${someType.name} <: ${traitExpr ? exprToString(traitExpr) : typeToString(traitType)}`
        )
        .join(", ")})`
    );
  }

  parts.push(typeToString(impl.receiverTypePattern));

  if (impl.traitType.typeName) {
    parts.push(typeToString(impl.traitType));
  }

  return `impl(${parts.join(", ")})`;
}

export function getGenericImplDocEntries({
  concreteType,
  env,
  receiverTypeName,
}: {
  concreteType: Type;
  env: Environment;
  receiverTypeName?: string;
}): GenericImplDocEntry[] {
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (!isSomeType(resolvedType)) {
      concreteType = resolvedType;
    }
  }

  const results: GenericImplDocEntry[] = [];
  const seen = new Set<string>();
  const concreteBaseTypeId = getReceiverBaseTypeId(concreteType);
  const concreteTypeName =
    "typeName" in concreteType ? concreteType.typeName : undefined;

  for (const [_traitTypeName, impls] of genericImplRegistry.entries()) {
    for (const impl of impls) {
      let matched = false;
      try {
        matched = tryMatchGenericImpl({ concreteType, impl, env }).matched;
      } catch {
        matched = false;
      }

      if (
        !matched &&
        concreteBaseTypeId &&
        getReceiverBaseTypeId(impl.receiverTypePattern) === concreteBaseTypeId
      ) {
        matched = true;
      }

      if (
        !matched &&
        (receiverTypeName ?? concreteTypeName) &&
        "typeName" in impl.receiverTypePattern &&
        impl.receiverTypePattern.typeName ===
          (receiverTypeName ?? concreteTypeName)
      ) {
        matched = true;
      }

      if (!matched) continue;

      const methods = impl.traitType.fields.flatMap((field) => {
        if (!field.label || !isFunctionType(field.type)) {
          return [];
        }
        return [{ name: field.label, type: field.type }];
      });
      const methodNames = methods.map((field) => field.name);
      const signature = formatGenericImplSignature(impl);
      const key = `${signature}\0${methodNames.join("\0")}`;

      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        signature,
        traitName: impl.traitType.typeName,
        methodNames,
        methods,
      });
    }
  }

  return results;
}

/**
 * Find an associated type from generic impls for a concrete type.
 * This handles cases like `Self.Item` where `Self` is a type with a generic impl
 * of `Iterator(T)` — the `Item` associated type needs to be resolved through
 * the generic impl's trait type arguments.
 */
export function findAssociatedTypeFromGenericImpls({
  concreteType,
  propertyName,
  env,
}: {
  concreteType: Type;
  propertyName: string;
  env: Environment;
}): { type: Type; value: Value } | undefined {
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (!isSomeType(resolvedType)) {
      concreteType = resolvedType;
    }
  }

  for (const [_traitKey, impls] of genericImplRegistry.entries()) {
    for (const impl of impls) {
      let match;
      try {
        match = tryMatchGenericImpl({ concreteType, impl, env });
      } catch (e) {
        continue; // Skip impls that fail to match (e.g., due to re-evaluation context issues)
      }
      if (!match.matched) {
        continue;
      }
      const traitType = impl.traitType;

      // Look for a non-function field with the given name
      const fieldIndex = traitType.fields.findIndex(
        (f) => f.label === propertyName && !isFunctionType(f.type)
      );
      if (fieldIndex < 0) continue;

      // Re-evaluate trait type args to get concrete associated types
      // This is necessary because the associated type value may contain SomeTypes
      // (e.g., *(T) in Iterator(*(T))) that need to be resolved with concrete substitutions
      if (
        impl.traitTypeArgExprs &&
        impl.traitFunctionParamNames &&
        impl.traitTypeArgExprs.length === impl.traitFunctionParamNames.length
      ) {
        const baseEnv = impl.definitionEnv;
        let specializedEnv = pushEnvFrame(baseEnv);

        for (const [paramName, paramType] of match.substitutions) {
          const { env: nextEnv } = addVariableToEnv({
            env: specializedEnv,
            variable: {
              name: paramName,
              type: createType0(),
              isCompileTimeOnly: true,
              value: [createTypeValue(paramType)],
              token: PlaceholderToken,
              initializedAtToken: PlaceholderToken,
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
            },
          });
          specializedEnv = nextEnv;
        }

        for (let i = 0; i < impl.traitTypeArgExprs.length; i++) {
          const argExpr = impl.traitTypeArgExprs[i]!;
          const paramName = impl.traitFunctionParamNames[i]!;

          if (paramName === propertyName) {
            try {
              const exprClone = cloneExpr(argExpr);
              const evaluated = evaluateExpression({
                expr: exprClone,
                env: specializedEnv,
                context: {
                  stdPath: "",
                  isEvaluatingGenericImplSpecialization: true,
                } as EvaluatorContext,
              });
              if (evaluated.$ && isTypeValue(evaluated.$.value)) {
                return {
                  type: evaluated.$.value.type,
                  value: evaluated.$.value,
                };
              }
            } catch {
              // If re-evaluation fails, continue to the next impl
            }
          }
        }
      }

      // Fallback for non-parameterized traits: use the field value directly
      const field = traitType.fields[fieldIndex]!;
      const fieldValue =
        impl.traitValue.fields[fieldIndex] ?? field.assignedValue;
      if (!fieldValue || !isTypeValue(fieldValue)) continue;

      if (!isSomeType(fieldValue.value)) {
        return { type: fieldValue.type, value: fieldValue };
      }

      // The value is a SomeType — resolve through match substitutions
      for (const param of impl.forallParameters) {
        if (param.kind === "type" && param.someType === fieldValue.value) {
          const concreteResolvedType = match.substitutions.get(param.name);
          if (concreteResolvedType) {
            const resolvedTypeValue = createTypeValue(concreteResolvedType);
            return { type: resolvedTypeValue.type, value: resolvedTypeValue };
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Find a method from a generic impl for a specific trait type and concrete receiver type.
 * This is used when accessing methods on a `<:` expression like `(Box(i32) <: Isolation).can_isolate`.
 * Returns the specialized method type and value if found.
 */
export function findMethodFromGenericImplForTrait({
  concreteType,
  traitType,
  methodName,
  env,
}: {
  concreteType: Type;
  traitType: TraitType;
  methodName: string;
  env: Environment;
}): { type: FunctionType; value: Value | undefined } | undefined {
  // Use the base trait key (funcId) for lookup
  const traitTypeKey = getBaseTraitKey(traitType);

  const impls = genericImplRegistry.get(traitTypeKey);
  if (!impls || impls.length === 0) {
    return undefined;
  }

  for (const impl of impls) {
    // Check if this impl matches the concrete type
    const match = tryMatchGenericImpl({
      concreteType,
      impl,
      env,
    });
    if (!match.matched) {
      continue;
    }

    // Found a matching impl - look for the method
    const implTraitType = impl.traitType;
    const implTraitValue = impl.traitValue;

    const methodIndex = implTraitType.fields.findIndex(
      (f) => f.label === methodName && isFunctionType(f.type)
    );

    if (methodIndex >= 0) {
      const method = implTraitType.fields[methodIndex]!;
      if (isFunctionType(method.type)) {
        // Get the actual function value from the trait value
        const originalValue = implTraitValue.fields[methodIndex];

        // If it's a function value, we need to re-evaluate with concrete substitutions
        if (
          isFunctionValue(originalValue) &&
          (match.valueSubstitutions.size > 0 || match.substitutions.size > 0)
        ) {
          // Use the environment where the impl was originally defined
          const baseEnv = impl.definitionEnv;

          // Create a specialized environment with type/value substitutions bound
          let specializedEnv = pushEnvFrame(baseEnv);

          // Add type substitutions to the environment (like T=Box(i32), Self=...)
          for (const [paramName, paramType] of match.substitutions) {
            const { env: nextEnv } = addVariableToEnv({
              env: specializedEnv,
              variable: {
                name: paramName,
                type: createType0(),
                isCompileTimeOnly: true,
                value: [createTypeValue(paramType)],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
            });
            specializedEnv = nextEnv;
          }

          // Add value substitutions (compile-time values like U=3)
          for (const [paramName, paramValue] of match.valueSubstitutions) {
            const { env: nextEnv } = addVariableToEnv({
              env: specializedEnv,
              variable: {
                name: paramName,
                type: paramValue.type,
                isCompileTimeOnly: true,
                value: [paramValue],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
            });
            specializedEnv = nextEnv;
          }

          // Re-evaluate the function type to get specialized types
          const specializedType = reEvaluateFunctionType({
            functionType: method.type,
            specializedEnv,
            SelfType: match.substitutions.get("Self"),
          });

          // Now add the parametersFrame with the specialized parameter types
          specializedEnv = pushEnvFrame(
            specializedEnv,
            specializedType.parametersFrame
          );

          // Clone the function body for re-evaluation
          const clonedBody = cloneExpr(originalValue.body);

          // Re-evaluate the function body with the concrete values.
          // See parallel comment above for the `-> ref(T)` body-typing
          // rationale (Phase B/C of plans/ITERATOR_REDESIGN.md).
          const _specBodyExpectedType2 = specializedType.return.isRef
            ? createPtrType(specializedType.return.type)
            : specializedType.return.type;
          const specializedBody = evaluateBeginExpression({
            expr: clonedBody,
            env: specializedEnv,
            context: {
              isEvaluatingGenericImplSpecialization: true,
              expectedType: {
                type: _specBodyExpectedType2,
                env: specializedEnv,
              },
              stdPath: "",
              isEvaluatingFunctionBodyOrAsyncBlock: {
                kind: "function-body",
                type: specializedType,
                value: originalValue,
                evaluationEnv: specializedEnv,
              },
              functionReturnImplConcreteType: [], // Fresh array for each specialization
              // Set SelfType to the concrete type from substitutions
              SelfType: match.substitutions.get("Self"),
            } as EvaluatorContext,
            variablesToAdd: [],
            isEvaluatingFunctionBodyBeginBlock: true,
          });

          // Create a specialized function value with the re-evaluated body
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: specializedType,
            body: specializedBody,
            funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
            funcName: originalValue.funcName
              ? `${originalValue.funcName}_specialized`
              : undefined,
          };

          return { type: specializedType, value: specializedFunctionValue };
        } else if (isFunctionValue(originalValue)) {
          // No substitutions needed, just set the specialized type
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: method.type,
          };
          return { type: method.type, value: specializedFunctionValue };
        } else {
          return { type: method.type, value: originalValue };
        }
      }
    }
  }

  return undefined;
}

/** Result from tryMatchGenericImpl */
interface GenericImplMatchResult {
  matched: boolean;
  /** Map from SomeType name to the concrete type it was bound to */
  substitutions: Map<string, Type>;
  /** Map from value parameter name to the concrete value it was bound to */
  valueSubstitutions: Map<string, Value>;
}

/**
 * Try to match a concrete type against a generic impl's receiver type pattern.
 * Returns match result with substitutions if matched, or matched=false otherwise.
 */
function tryMatchGenericImpl({
  concreteType,
  impl,
  env,
}: {
  concreteType: Type;
  impl: GenericImpl;
  env: Environment;
}): GenericImplMatchResult {
  const noMatch: GenericImplMatchResult = {
    matched: false,
    substitutions: new Map(),
    valueSubstitutions: new Map(),
  };

  // CRITICAL: If concreteType is an unresolved SomeType (type parameter like K),
  // we cannot match it against a concrete pattern like Box(T).
  // The SomeType represents any type that satisfies certain constraints,
  // not a specific concrete type. Matching should only succeed when
  // concreteType is a concrete type or a SomeType that is already bound.
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (isSomeType(resolvedType)) {
      // concreteType is an unresolved type parameter, cannot match against a pattern
      return noMatch;
    }
    // Otherwise use the resolved type
    concreteType = resolvedType;
  }

  // Create a fresh env with the forall parameters in scope for unification
  let unifyEnv = pushEnvFrame(env);

  // Add the parameters from forall to the environment
  for (const param of impl.forallParameters) {
    if (param.kind === "type") {
      const { env: nextEnv } = addVariableToEnv({
        env: unifyEnv,
        variable: {
          name: param.name,
          type: createType0(),
          isCompileTimeOnly: true,
          value: [createTypeValue(param.someType)],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        allowVariableShadowing: true,
      });
      unifyEnv = nextEnv;
    } else {
      // Value parameter: add the unknown value to the environment
      const { env: nextEnv } = addVariableToEnv({
        env: unifyEnv,
        variable: {
          name: param.name,
          type: param.type,
          isCompileTimeOnly: true,
          value: [param.unknownValue],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        allowVariableShadowing: true,
      });
      unifyEnv = nextEnv;
    }
  }

  // Try to unify the concrete type with the receiver type pattern
  try {
    let { expectedEnv } = synthesizeTypes(
      { type: impl.receiverTypePattern, env: unifyEnv },
      { type: concreteType, env }
    );

    // When structural field unification can't bind all forall type parameters
    // (e.g., when a struct erases type params to *(void) to break circular deps),
    // fall back to extracting bindings from the concrete type's captured env.
    // The concrete type's env was captured at construction time and contains
    // the actual type parameter values (e.g., K=i32, V=i32).
    if (isStructType(concreteType)) {
      for (const param of impl.forallParameters) {
        if (param.kind !== "type") continue;
        const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
          expectedEnv,
          param.someType
        );
        // Still unresolved (SomeType → itself)?  Try the concrete type's env.
        // Use name-based lookup since the forall param's SomeType was defined at
        // a different frame level than the concrete type's env bindings.
        if (isSomeType(boundType)) {
          const resolved = getValueOfSomeTypeFromEnvForGenericImpl(
            concreteType.env,
            param.someType
          );
          if (!isSomeType(resolved)) {
            // Update the forall param's value in-place in expectedEnv.
            // We can't use addVariableToEnv because the param already exists
            // in the forall frame. Instead, find and update its value directly.
            for (let fi = expectedEnv.frames.length - 1; fi >= 0; fi--) {
              const frame = expectedEnv.frames[fi]!;
              const varIdx = frame.variables.findIndex(
                (v) => v.name === param.name
              );
              if (varIdx >= 0) {
                // Clone frames immutably
                const newFrames = expectedEnv.frames.slice();
                const newVars = frame.variables.slice();
                newVars[varIdx] = {
                  ...newVars[varIdx]!,
                  value: [createTypeValue(resolved)],
                };
                newFrames[fi] = { ...frame, variables: newVars };
                expectedEnv = { ...expectedEnv, frames: newFrames };
                break;
              }
            }
          }
        }
      }
    }

    // Check if all where constraints are satisfied
    for (const {
      someType,
      traitType: constraintTrait,
      traitExpr: constraintExpr,
    } of impl.whereConstraints) {
      // Get the bound type for this SomeType from the unified environment
      const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
        expectedEnv,
        someType
      );

      if (!boundType) {
        return noMatch;
      }

      // If we have the original expression, re-evaluate it with the bound types
      // This handles cases like Eq(T) -> Eq(i32) when T=i32
      let actualConstraintTrait = constraintTrait;
      if (constraintExpr) {
        try {
          const exprClone = cloneExpr(constraintExpr);
          const evaluated = evaluateExpression({
            expr: exprClone,
            env: expectedEnv,
            context: {
              stdPath: "",
              isEvaluatingGenericImplSpecialization: true,
            } as EvaluatorContext,
          });
          if (
            evaluated.$ &&
            isTypeValue(evaluated.$.value) &&
            isTraitType(evaluated.$.value.value)
          ) {
            actualConstraintTrait = evaluated.$.value.value;
          }
        } catch {
          // If re-evaluation fails, fall back to the original constraint trait
        }
      }

      // Handle negated constraints: the bound type must NOT implement the trait
      if (actualConstraintTrait.isNegatedConstraint) {
        // If bound to a SomeType, check if it has the negated constraint attached
        if (isSomeType(boundType)) {
          if (
            !someTypeHasNegatedTraitConstraint(
              boundType,
              actualConstraintTrait,
              env
            )
          ) {
            return noMatch;
          }
          continue;
        }

        // For concrete types, verify they do NOT implement the trait
        if (
          typeImplementsTraitBool({
            targetType: boundType,
            traitType: actualConstraintTrait,
            env,
          })
        ) {
          return noMatch;
        }
        continue;
      }

      // If bound to a SomeType, check if it has the required constraint attached
      if (isSomeType(boundType)) {
        if (
          !someTypeHasTraitConstraint(boundType, actualConstraintTrait, env)
        ) {
          return noMatch;
        }
        continue;
      }

      // Check if the bound type implements the required trait.
      // Use the full typeImplementsTrait (not Bool) so that bindings produced
      // during trait satisfaction (e.g. synthesizing `A=i32` from
      // `F <: Fn(item:A)->B` against `fn(item:i32)->i32`) are propagated back
      // into expectedEnv.  This is necessary for forall params that are only
      // constrained through where-clauses (not struct fields) to appear in the
      // final substitutions map and avoid a false hasMissingForallParams skip.
      const { implemented, env: afterConstraintEnv } = typeImplementsTrait({
        targetType: boundType,
        traitType: actualConstraintTrait,
        env: expectedEnv,
      });
      if (!implemented) {
        return noMatch;
      }
      // Propagate new bindings (e.g. A=i32) into expectedEnv.
      expectedEnv = afterConstraintEnv;
    }

    // Extract type substitutions from the unified environment
    const substitutions = new Map<string, Type>();
    const valueSubstitutions = new Map<string, Value>();
    for (const param of impl.forallParameters) {
      if (param.kind === "type") {
        const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
          expectedEnv,
          param.someType
        );
        // Include the substitution if the type was resolved to a concrete type,
        // OR if it was unified to a DIFFERENT SomeType (e.g., T unified to U
        // from an outer forall scope). Only skip when T is still its own
        // original unresolved SomeType (meaning nothing was unified).
        if (
          boundType &&
          (!isSomeType(boundType) || boundType !== param.someType)
        ) {
          substitutions.set(param.name, boundType);
        }
      } else {
        // Value parameter: extract the bound value from the environment
        const variables = getVariablesFromEnv(expectedEnv, param.name);
        const variable = variables[variables.length - 1];
        if (variable && variable.value && !isUnknownValue(variable.value[0])) {
          // IMPORTANT: Use the parameter's declared type, not the value's type
          // For example, if forall(U : usize) and the value is 3 (comptime_int),
          // we should store it as 3 with type usize, not comptime_int
          const valueWithCorrectType = {
            ...variable.value[0],
            type: param.type,
          } as Value;
          valueSubstitutions.set(param.name, valueWithCorrectType);
        }
      }
    }

    // Also add Self -> concreteType substitution
    substitutions.set("Self", concreteType);

    return { matched: true, substitutions, valueSubstitutions };
  } catch {
    // Unification failed
    return noMatch;
  }
}

/**
 * Check if a SomeType has a specific trait constraint attached.
 * Used when checking where constraints during generic impl matching.
 */
function someTypeHasTraitConstraint(
  someType: SomeType,
  requiredTrait: TraitType,
  env: Environment
): boolean {
  const traitName = requiredTrait.typeName;
  // For anonymous traits without a typeName (e.g., Fn(...) trait values produced
  // by the `Fn` comptime function), each evaluation creates a fresh TraitType
  // with a new id. We must compare structurally instead of by id/name.
  const useStructuralCompare = !traitName && isFnTraitType(requiredTrait);

  // Check in requiredTraits (SomeType-level constraints)
  for (const requiredTraitEntry of someType.requiredTraits) {
    if (requiredTraitEntry.traitType.id === requiredTrait.id) {
      return true;
    }
    if (
      useStructuralCompare &&
      areTypesCompatible(
        { type: requiredTrait, env },
        { type: requiredTraitEntry.traitType, env }
      )
    ) {
      return true;
    }
  }

  // If this SomeType has been resolved to another SomeType (e.g., a wrapper
  // Impl(Fn(...))) carrying the trait constraint, follow the resolution chain.
  // This is critical when a forall SomeType `F` is bound to a closure whose
  // value-type is `Impl(Fn(...))`-wrapped — the Fn constraint sits on the
  // wrapper, not on F itself.
  if (
    someType.resolvedConcreteType &&
    isSomeType(someType.resolvedConcreteType)
  ) {
    if (
      someTypeHasTraitConstraint(
        someType.resolvedConcreteType,
        requiredTrait,
        env
      )
    ) {
      return true;
    }
  }

  // If this SomeType has been resolved to a concrete type (closure struct,
  // function type, struct/enum that impls Fn, etc.), delegate to the full
  // trait check on the concrete type. This handles closures whose captures
  // are wrapped in a struct that has the Fn trait impl'd structurally.
  if (
    someType.resolvedConcreteType &&
    !isSomeType(someType.resolvedConcreteType)
  ) {
    if (
      typeImplementsTraitBool({
        targetType: someType.resolvedConcreteType,
        traitType: requiredTrait,
        env,
      })
    ) {
      return true;
    }
  }

  if (!traitName && !useStructuralCompare) {
    return false;
  }

  const whereConstraints = getWhereClauseConstraintsForSomeType(env, someType);
  if (whereConstraints) {
    for (const requiredTraitType of whereConstraints.requiredTraits) {
      if (requiredTraitType.id === requiredTrait.id) {
        return true;
      }
      if (
        useStructuralCompare &&
        areTypesCompatible(
          { type: requiredTrait, env },
          { type: requiredTraitType, env }
        )
      ) {
        return true;
      }
    }
  }

  // Also check trait.fields (from auto-derivation, e.g., Runtime is auto-attached to SomeTypes)
  for (const field of someType.trait.fields) {
    if (isTraitValue(field.assignedValue)) {
      if (field.assignedValue.type.id === requiredTrait.id) {
        return true;
      }
      if (
        useStructuralCompare &&
        areTypesCompatible(
          { type: requiredTrait, env },
          { type: field.assignedValue.type, env }
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a SomeType has a specific negated trait constraint attached.
 * Used when checking where constraints like `where(T <: !(Copy))`.
 */
function someTypeHasNegatedTraitConstraint(
  someType: SomeType,
  requiredNegatedTrait: TraitType,
  env: Environment
): boolean {
  const traitName = requiredNegatedTrait.typeName;
  if (!traitName) {
    return false;
  }

  // Check in negativeTraits (SomeType-level constraints)
  if (someType.negativeTraits) {
    for (const negativeTraitEntry of someType.negativeTraits) {
      if (negativeTraitEntry.traitType.id === requiredNegatedTrait.id) {
        return true;
      }
    }
  }

  const whereConstraints = getWhereClauseConstraintsForSomeType(env, someType);
  if (whereConstraints) {
    for (const negativeTraitType of whereConstraints.negativeTraits) {
      if (negativeTraitType.id === requiredNegatedTrait.id) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check that a generic impl's receiver type pattern satisfies the trait's self-constraints.
 * For example, if trait Id has `where(Self <: Copy)`, then any impl of Id must ensure
 * the receiver type implements Copy.
 *
 * For `impl(forall(T : Type), Data(T), Id(...))`, this would fail because Data(T) doesn't
 * necessarily implement Copy (T is unconstrained).
 *
 * For `impl(forall(T : Type), where(T <: Copy), Data(T), Id(...))`, this would succeed
 * because the where clause provides the necessary constraint.
 */
function checkGenericImplSelfConstraints({
  receiverTypePattern,
  traitType,
  whereConstraints,
  env,
  errorToken,
}: {
  receiverTypePattern: Type;
  traitType: TraitType;
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  env: Environment;
  errorToken: Token;
}): void {
  // Check positive constraints (must implement)
  if (traitType.selfConstraints && traitType.selfConstraints.length > 0) {
    for (const constraintTrait of traitType.selfConstraints) {
      // Check if the receiver type pattern implements the constraint
      // This uses typeImplementsTraitBool which will check generic impls
      if (
        typeImplementsTraitBool({
          targetType: receiverTypePattern,
          traitType: constraintTrait,
          env,
        })
      ) {
        continue;
      }

      // If direct check failed, collect all SomeTypes from the forall that have
      // the required constraint in whereConstraints and check if the receiver
      // pattern contains those SomeTypes with proper constraints
      const someTypesWithConstraint = new Set<string>();
      for (const wc of whereConstraints) {
        if (
          wc.traitType.typeName === constraintTrait.typeName &&
          !wc.traitType.isNegatedConstraint
        ) {
          someTypesWithConstraint.add(wc.someType.name);
        }
      }

      // Check if receiver type pattern relies on SomeTypes that have the required constraint
      // For now, we just fail - the typeImplementsTraitBool check should handle this
      // via findMatchingGenericImpl which checks someTypeHasTraitConstraint

      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" does not satisfy constraint "${constraintTrait.typeName ?? typeToString(constraintTrait)}" required by trait "${traitType.typeName ?? typeToString(traitType)}".
Consider adding "where(T <: ${constraintTrait.typeName ?? typeToString(constraintTrait)})" to the impl.`,
      });
    }
  }

  // Check negative constraints (must NOT implement)
  if (
    traitType.negativeSelfConstraints &&
    traitType.negativeSelfConstraints.length > 0
  ) {
    for (const constraintTrait of traitType.negativeSelfConstraints) {
      // If the receiver type pattern directly implements the forbidden trait, it's an error
      if (
        typeImplementsTraitBool({
          targetType: receiverTypePattern,
          traitType: constraintTrait,
          env,
        })
      ) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" implements "${constraintTrait.typeName ?? typeToString(constraintTrait)}" but trait "${traitType.typeName ?? typeToString(traitType)}" requires it to NOT implement this trait.
Consider adding "where(T <: !(${constraintTrait.typeName ?? typeToString(constraintTrait)}))" to the impl.`,
        });
      }

      // If the receiver type pattern contains SomeTypes, check if they have the negated constraint
      // If they don't have the negated constraint in whereConstraints, we can't guarantee they won't implement it
      // For now, we allow this and rely on runtime checks when concrete types are substituted
    }
  }
}

/**
 * Get the bound value of a SomeType from the environment.
 * Returns the SomeType itself if not bound.
 */
function getValueOfSomeTypeFromEnvForGenericImpl(
  env: Environment,
  someType: SomeType
): Type {
  // Search from the most recent frame to the oldest
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i]!;
    for (const variable of frame.variables) {
      if (variable.name === someType.name && variable.value) {
        if (isTypeValue(variable.value[0])) {
          return variable.value[0].value;
        }
      }
    }
  }
  return someType;
}

/**
 * Clear all impl fields from types that were added by the specified trait.
 * Call this before re-evaluating a trait to prevent duplicate impls.
 */
export function clearImplsFromModule(modulePath: string): void {
  const typesWithImpls = implRegistry.get(modulePath);
  if (!typesWithImpls) {
    return;
  }

  for (const traitType of typesWithImpls) {
    traitType.fields = traitType.fields.filter(
      (field) => field.sourceModulePath !== modulePath
    );
  }

  implRegistry.delete(modulePath);

  // Also clear the duplicate detection registry for this trait
  clearImplRecordsFromModule(modulePath);
}

/**
 * Snapshot all trait field arrays across ALL modules in the implRegistry.
 * Used by LSP before deleteModule (which invalidates multiple modules)
 * to preserve trait fields for lastGoodModule cache.
 */
export function snapshotAllImplTraitFields(): Map<TraitType, TraitField[]> {
  const snapshots = new Map<TraitType, TraitField[]>();
  for (const typesWithImpls of implRegistry.values()) {
    for (const traitType of typesWithImpls) {
      if (!snapshots.has(traitType)) {
        snapshots.set(traitType, [...traitType.fields]);
      }
    }
  }
  return snapshots;
}

/**
 * Register that a type has an impl field from the specified trait.
 */
function registerImpl(modulePath: string, traitType: TraitType): void {
  let types = implRegistry.get(modulePath);
  if (!types) {
    types = new Set();
    implRegistry.set(modulePath, types);
  }
  types.add(traitType);
}

/**
 * Attach a trait value to a receiver type's trait.
 * For anonymous traits (begin blocks), flatten the fields directly.
 * For named traits, attach with an empty label for method lookup.
 *
 * Note: clearImplsFromModule should be called before re-evaluating a trait
 * to remove old impls. This function just adds the new impl.
 */
function attachTraitToReceiverType(
  traitValue: TraitValue,
  expr: Expr,
  sourceModulePath?: string
): void {
  const receiverType = traitValue.type.receiverType;
  if (!receiverType || !receiverType.trait) {
    return;
  }

  // Check for duplicate impl (only for named traits, not anonymous ones)
  if (traitValue.type.typeName) {
    // Check orphan rule
    checkOrphanRule({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Check for duplicate impl
    checkDuplicateImpl({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Phase N: Check contradiction with existing negative impl
    if (hasNegativeImpl(receiverType.id, traitValue.type.id)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Conflicting impls for ${typeToString(receiverType)}: impl(${typeToString(receiverType)}, ${traitValue.type.typeName || typeToString(traitValue.type)}()) conflicts with an existing negative impl 'impl(${typeToString(receiverType)}, !(${traitValue.type.typeName || typeToString(traitValue.type)}))'. Positive and negative impls cannot coexist for the same type and trait.`,
      });
    }

    // Register this impl for duplicate detection
    registerImplForType({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });
  }

  // Register this impl for cleanup on re-evaluation
  if (sourceModulePath) {
    registerImpl(sourceModulePath, receiverType.trait);
  }

  // Check if this is an anonymous trait (no typeName) - flatten its fields
  if (!traitValue.type.typeName) {
    // Flatten the trait's fields directly onto the receiver type's trait
    for (let i = 0; i < traitValue.type.fields.length; i++) {
      const field = traitValue.type.fields[i]!;
      const value = traitValue.fields[i];

      // Check for duplicate method names across impl blocks
      if (field.label && isFunctionType(field.type)) {
        const existingField = receiverType.trait.fields.find(
          (f) => f.label === field.label && isFunctionType(f.type)
        );
        if (existingField) {
          // Re-evaluating the SAME module's impl on a process-cached builtin
          // type singleton (e.g. the prelude's inherent methods on `str`):
          // replace the stale registration instead of rejecting. Distinct
          // modules still conflict.
          if (
            sourceModulePath &&
            existingField.sourceModulePath === sourceModulePath
          ) {
            receiverType.trait.fields = receiverType.trait.fields.filter(
              (f) => f !== existingField
            );
          } else {
            throw formatErrorMessage({
              token: expr.token,
              errorMessage:
                `Method "${field.label}" is already defined for type "${typeToString(receiverType)}".\n` +
                `Cannot define duplicate method names across impl blocks. ` +
                `Use a different name (e.g., "comptime_${field.label}") for the comptime variant.`,
            });
          }
        }
      }

      const newField: TraitField = {
        label: field.label,
        type: field.type,
        assignedValue: value,
        sourceModulePath,
        docComment: field.docComment,
        exprs: {
          expr,
        },
      };

      receiverType.trait.fields.push(newField);
    }
  } else {
    // Named trait - attach with empty label for method lookup
    const field: TraitField = {
      label: "", // Empty label prevents direct access, only method calls work
      type: createTypeHierarchy(1), // Trait type
      assignedValue: traitValue,
      sourceModulePath,
      exprs: {
        expr,
      },
    };

    // Add the field to the receiver type's trait
    receiverType.trait.fields.push(field);
  }
}

/**
 * Phase A (THREAD_SAFETY): Gate manual impl(T, Send()) and impl(T, Acyclic())
 * behind pragma(Pragma.AllowUnsafe). Auto-derived Send/Acyclic (via
 * autoDeriveSendForStructType etc.) goes through a separate code path in
 * types/utils.ts and is NOT gated — only manual impl declarations are checked.
 */
function checkManualSendAcyclicPragmaGate({
  traitEntries,
  currentModulePath,
  errorToken,
}: {
  traitEntries: ImplTraitEntry[];
  currentModulePath: string | undefined;
  errorToken: Token;
}): void {
  for (const entry of traitEntries) {
    if (entry.isAnonymousTrait) continue;
    const traitTypeName = entry.traitValue.type.typeName;
    if (traitTypeName === "Send" || traitTypeName === "Acyclic") {
      if (!isImplicitlyUnsafeCapableFile(currentModulePath)) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Manual 'impl(..., ${traitTypeName}())' requires pragma(Pragma.AllowUnsafe). Add a '// SAFETY:' comment explaining why the type is safe to ${traitTypeName === "Send" ? "send across threads" : "declare Acyclic"}.`,
        });
      }
    }
  }
}

/**
 * Phase F (THREAD_SAFETY): When a manual impl(T, Send()) is registered for an
 * atomic object type, re-verify that all fields are truly Send transitively.
 * This is the safety belt that catches Phase A2's lies — even if a pragma'd
 * file claims `impl(MyAtomic, Send())`, the field-level check asserts the
 * claim matches reality.
 */
function verifyAtomicObjectSend({
  receiverType,
  traitTypeName,
  env,
  errorToken,
}: {
  receiverType: Type;
  traitTypeName: string | undefined;
  env: Environment;
  errorToken: Token;
}): void {
  if (traitTypeName !== "Send") return;
  if (!isStructType(receiverType)) return;
  if (!receiverType.isAtomicRc) return;

  const nonSendFields: string[] = [];
  for (const field of receiverType.fields) {
    if (!typeImplementsSend(field.type, env)) {
      nonSendFields.push(`  - ${field.label}: ${typeToString(field.type)}`);
    }
  }

  if (nonSendFields.length > 0) {
    throw formatErrorMessage({
      token: errorToken,
      errorMessage:
        `atomic object '${typeToString(receiverType)}' has non-Send field(s) — manual impl(..., Send()) is contradicted:\n` +
        nonSendFields.join("\n") +
        `\nEither wrap the non-Send fields in Arc/Mutex/Atomic, or remove the manual 'impl(${typeToString(receiverType)}, Send())'.`,
    });
  }
}

/**
 * Phase N (THREAD_SAFETY): Register negative trait impls.
 * For each `!(Trait)` entry, validate it's a marker trait, check for
 * contradictions with existing positive impls, and register in the
 * negative-impl registry (concrete) or negative-generic-impl registry.
 */
function processNegativeTraitEntries({
  negativeTraitEntries,
  receiverType,
  forallParameters,
  whereConstraints,
  currentModulePath,
  isGeneric,
  errorToken,
}: {
  negativeTraitEntries: NegativeImplEntry[];
  receiverType: Type;
  forallParameters: ForallParameter[];
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  currentModulePath: string | undefined;
  isGeneric: boolean;
  errorToken: Token;
}): void {
  for (const entry of negativeTraitEntries) {
    const traitType = entry.traitType;

    // Reject negative impls for traits that have named methods (non-marker traits)
    if (
      traitType.fields.some(
        (f) => isFunctionType(f.type) && f.label !== "" && f.label !== "id"
      ) ||
      traitType.fields.some(
        (f) =>
          isSomeType(f.type) &&
          f.type.requiredTraits.some((rt) => isFnTraitType(rt.traitType))
      )
    ) {
      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Cannot use '!(${traitType.typeName || typeToString(traitType)})' — negative impls are only allowed for marker traits (traits without methods).`,
      });
    }

    if (isGeneric) {
      negativeGenericImplRegistry.push({
        forallParameters,
        whereConstraints,
        receiverTypePattern: receiverType,
        traitType,
        sourceModulePath: currentModulePath,
      });
    } else {
      registerNegativeImpl(receiverType.id, traitType.id);
    }
  }
}

export function evaluateImplBlock({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.impl)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "impl", got:\n${exprToString(expr)}`,
    });
  }

  // Anonymous impl block.
  if (
    expr.args.length === 1 &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.begin)
  ) {
    const beginExprs = expr.args[0]!.args;
    const {
      sourceNamespaceType,
      moduleValue,
      env: nextEnv,
    } = evaluateAnonymousModuleBeginExprs({
      beginExprs,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: context.SelfType,
        isInsideImplBlock: true,
      },
    });
    env = nextEnv;

    // Set the generated trait record value to the expr.
    expr.$ = {
      env,
      type: sourceNamespaceType,
      value: moduleValue,
      pathCollection: [],
    };

    return expr;
  }
  const args = expr.args;
  let argIndex = 0;
  let forallArg: FnCallExpr | undefined;
  let whereArg: FnCallExpr | undefined;

  // Supported forms:
  //   impl(forall(...), where(...), receiverType, ...)
  //   impl(forall(...), receiverType, where(...), ...)

  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.forall)
  ) {
    forallArg = args[argIndex]! as FnCallExpr;
    argIndex++;
  }

  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.where)
  ) {
    if (!forallArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `impl where(...) requires forall(...) and may appear before or after the receiver type.`,
      });
    }
    whereArg = args[argIndex]! as FnCallExpr;
    argIndex++;
  }

  if (!args[argIndex]) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `impl requires a receiver type and at least one field.`,
    });
  }

  const receiverTypeArg = args[argIndex]!;
  argIndex++;

  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.where)
  ) {
    if (!forallArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `impl where(...) requires forall(...) and may appear before or after the receiver type.`,
      });
    }
    if (whereArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `impl supports only a single where(...) clause.`,
      });
    }
    whereArg = args[argIndex]! as FnCallExpr;
    argIndex++;
  }
  const fieldExprs = args.slice(argIndex);

  if (fieldExprs.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `impl requires at least one field after the receiver type.`,
    });
  }

  if (!forallArg) {
    // Non-generic impl: impl(receiverType, field1, field2, ...)
    const evaluatedReceiverTypeArg = evaluateExpression({
      expr: receiverTypeArg,
      env,
      context: { ...context },
    });

    if (
      !evaluatedReceiverTypeArg.$ ||
      !evaluatedReceiverTypeArg.$.value ||
      !isTypeValue(evaluatedReceiverTypeArg.$.value)
    ) {
      throw formatErrorMessage({
        token: receiverTypeArg.token,
        errorMessage: `Expected type for receiver type argument.`,
      });
    }

    env = evaluatedReceiverTypeArg.$.env;
    const receiverType = evaluatedReceiverTypeArg.$.value.value;

    const isStructuralType = isArrayType(receiverType);

    // Pre-register concrete trait impls being evaluated so that recursive types
    // (e.g. TreeNode containing Box(TreeNode)) can find their own Clone impl
    // while the function body is being validated.
    const preRegisteredKeys: string[] = [];
    for (const fExpr of fieldExprs) {
      // Skip named-field assignments (label : value) — not trait names
      if (exprIsFunctionCall(fExpr) && exprIsFunctionCallOf(fExpr, ":", 2)) {
        continue;
      }
      // Trait name is either the atom value (bare trait like `Hash`) or the
      // head token of a call expr (parameterized trait like `Clone(...)` or
      // `Eq(Point)(...)`). All trait names start with uppercase.
      const traitName = fExpr.token.value;
      if (traitName && /^[A-Z]/.test(traitName)) {
        const key = `${receiverType.id}:${traitName}`;
        currentlyRegisteringConcreteImpls.add(key);
        preRegisteredKeys.push(key);
      }
    }

    let nextEnv: Environment;
    let traitEntries: ImplTraitEntry[];
    let negativeTraitEntries: NegativeImplEntry[];
    try {
      const result = evaluateImplFieldList({
        fieldExprs,
        env,
        context: { ...context },
        receiverType,
      });
      nextEnv = result.env;
      traitEntries = result.traitEntries;
      negativeTraitEntries = result.negativeTraitEntries;
    } finally {
      for (const key of preRegisteredKeys) {
        currentlyRegisteringConcreteImpls.delete(key);
      }
    }
    env = nextEnv;

    if (traitEntries.length === 0 && negativeTraitEntries.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `impl requires at least one trait or member field.`,
      });
    }

    checkManualSendAcyclicPragmaGate({
      traitEntries,
      currentModulePath: context.currentModulePath,
      errorToken: expr.token,
    });

    if (negativeTraitEntries.length > 0) {
      processNegativeTraitEntries({
        negativeTraitEntries,
        receiverType,
        forallParameters: [],
        whereConstraints: [],
        currentModulePath: context.currentModulePath,
        isGeneric: false,
        errorToken: expr.token,
      });
    }

    for (const entry of traitEntries) {
      const traitValue = entry.traitValue;
      const traitType = traitValue.type;

      if (!entry.isAnonymousTrait) {
        checkTypeImplementsSelfConstraints({
          targetType: receiverType,
          traitType: traitType,
          env,
          errorToken: expr.token,
        });
      }

      if (isStructuralType) {
        const traitTypeKey = getBaseTraitKey(traitType);
        const genericImpl: GenericImpl = {
          forallParameters: [],
          whereConstraints: [],
          receiverTypePattern: receiverType,
          traitType,
          traitValue,
          expr,
          sourceModulePath: context.currentModulePath,
          definitionEnv: env,
        };
        registerGenericImpl(traitTypeKey, genericImpl);
      } else {
        attachTraitToReceiverType(traitValue, expr, context.currentModulePath);
      }

      verifyAtomicObjectSend({
        receiverType,
        traitTypeName: traitType.typeName,
        env,
        errorToken: expr.token,
      });
    }

    const primaryTraitValue = traitEntries[0]?.traitValue;
    expr.$ = {
      env,
      type: primaryTraitValue ? primaryTraitValue.type : VUnit.type,
      value: primaryTraitValue || VUnit,
      pathCollection: [],
    };

    return expr;
  }

  // Generic impl with forall (and optional where)
  const firstArg = forallArg;

  // Parse forall parameters and create SomeTypes or unknown values
  const forallParamExprs = firstArg.args;
  const forallParameters: ForallParameter[] = [];

  // Create a new env frame for forall parameters
  env = pushEnvFrame(env);

  for (const paramExpr of forallParamExprs) {
    // Parse parameter expression: T : Type or just T
    let paramName: string;
    let paramTypeExpr: Expr | undefined;

    if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, ":", 2)
    ) {
      // T : Type form
      const nameExpr = paramExpr.args[0]!;
      if (!exprIsAtom(nameExpr)) {
        throw formatErrorMessage({
          token: nameExpr.token,
          errorMessage: `Expected identifier for forall parameter name, got: ${exprToString(nameExpr)}`,
        });
      }
      paramName = nameExpr.token.value;
      paramTypeExpr = paramExpr.args[1]!;
    } else if (exprIsAtom(paramExpr)) {
      // Just T form
      paramName = paramExpr.token.value;
    } else {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Expected parameter name or "name : Type" for forall parameter, got: ${exprToString(paramExpr)}`,
      });
    }

    // Evaluate the type expression if present
    let paramType: Type | undefined;
    if (paramTypeExpr) {
      const evaluatedType = evaluateExpression({
        expr: paramTypeExpr,
        env,
        context: { ...context },
      });
      if (evaluatedType.$?.env) {
        env = evaluatedType.$.env;
      }
      // Verify it's a type
      if (
        !evaluatedType.$ ||
        !evaluatedType.$.value ||
        !isTypeValue(evaluatedType.$.value)
      ) {
        throw formatErrorMessage({
          token: paramTypeExpr.token,
          errorMessage: `Expected type for forall parameter type, got: ${exprToString(paramTypeExpr)}`,
        });
      }
      paramType = evaluatedType.$.value.value;
    }

    // Check if this is a Type parameter or a value parameter
    const isTypeParam = !paramType || isType0(paramType);
    const effectiveType = paramType || createType0();

    // createUnknownValue handles both cases:
    // - For Type0: creates SomeType wrapped in TypeValue
    // - For other types: creates UnknownValue
    const unknownOrTypeValue = createUnknownValue(effectiveType, {
      variableName: paramName,
      env,
      context,
    });

    // Add to environment
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: paramName,
        type: effectiveType,
        isCompileTimeOnly: true,
        value: [unknownOrTypeValue],
        token: paramExpr.token,
        initializedAtToken: paramExpr.token,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
      },
    });
    env = nextEnv;

    if (isTypeParam) {
      // Type parameter: extract the SomeType from the TypeValue
      const someType = (unknownOrTypeValue as TypeValue).value as SomeType;
      forallParameters.push({ kind: "type", name: paramName, someType });
    } else {
      // Value parameter
      forallParameters.push({
        kind: "value",
        name: paramName,
        type: effectiveType,
        unknownValue: unknownOrTypeValue as UnknownValue,
      });
    }
  }

  // Parse where constraints if present
  // The <: operator with isInsideWhereClause will attach constraints to SomeType's trait
  const whereConstraintTraitExprById = new Map<string, Expr>();

  if (whereArg) {
    for (const constraintExpr of whereArg.args) {
      // Each constraint must be of the form: T <: Trait
      if (
        !exprIsFunctionCall(constraintExpr) ||
        !exprIsFunctionCallOf(constraintExpr, "<:", 2)
      ) {
        throw formatErrorMessage({
          token: constraintExpr.token,
          errorMessage: `Expected constraint in the form "T <: Trait", got: ${exprToString(constraintExpr)}`,
        });
      }

      const lhsExpr = constraintExpr.args[0]!;
      const rhsExpr = constraintExpr.args[1]!;

      // Evaluate LHS first to get the SomeType (side-effect-free variable lookup)
      const evaluatedLhs = evaluateExpression({
        expr: lhsExpr,
        env,
        context: {
          ...context,
        },
      });

      if (
        !evaluatedLhs.$ ||
        !evaluatedLhs.$.value ||
        !isTypeValue(evaluatedLhs.$.value) ||
        !isSomeType(evaluatedLhs.$.value.value)
      ) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `In a where clause, the left-hand side of <: must be a type parameter (SomeType), got: ${exprToString(lhsExpr)}`,
        });
      }
      const lhsSomeType = evaluatedLhs.$.value.value;

      // Snapshot constraint counts BEFORE the <: evaluation.
      // addWhereClauseConstraintToEnv mutates in-place, so we capture lengths.
      const constraintsBefore = getWhereClauseConstraintsForSomeType(
        env,
        lhsSomeType
      );
      const prevRequiredCount = constraintsBefore?.requiredTraits.length ?? 0;
      const prevNegativeCount = constraintsBefore?.negativeTraits.length ?? 0;

      // Evaluate with isInsideWhereClause context
      // This will attach the trait constraint to the SomeType via addWhereClauseConstraintToEnv
      const evaluated = evaluateExpression({
        expr: constraintExpr,
        env,
        context: {
          ...context,
          isInsideWhereClause: true,
        },
      });
      if (evaluated.$?.env) {
        env = evaluated.$.env;
      }

      // Parse RHS trait expressions to collect the source ASTs
      const traitExprs: { expr: Expr; isNegated: boolean }[] = [];
      if (
        exprIsFunctionCall(rhsExpr) &&
        exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
      ) {
        for (const traitExpr of rhsExpr.args) {
          if (
            exprIsFunctionCall(traitExpr) &&
            exprIsFunctionCallOf(traitExpr, "!") &&
            traitExpr.args.length === 1
          ) {
            traitExprs.push({ expr: traitExpr.args[0]!, isNegated: true });
          } else {
            traitExprs.push({ expr: traitExpr, isNegated: false });
          }
        }
      } else if (
        exprIsFunctionCall(rhsExpr) &&
        exprIsFunctionCallOf(rhsExpr, "!") &&
        rhsExpr.args.length === 1
      ) {
        traitExprs.push({ expr: rhsExpr.args[0]!, isNegated: true });
      } else {
        traitExprs.push({ expr: rhsExpr, isNegated: false });
      }

      // Get the ACTUAL constraint trait types that were added by the <: evaluation.
      // These are the same TraitType objects stored in the env's whereClauseConstraints,
      // which will be retrieved later in tryMatchGenericImpl. Using their IDs ensures
      // the expression map keys match the constraint lookup keys.
      // (Previously, re-evaluating the RHS created NEW TraitType objects with different
      // IDs, causing Fn-trait expressions to be unfindable.)
      const constraintsAfter = getWhereClauseConstraintsForSomeType(
        env,
        lhsSomeType
      );
      const newRequired =
        constraintsAfter?.requiredTraits.slice(prevRequiredCount) ?? [];
      const newNegative =
        constraintsAfter?.negativeTraits.slice(prevNegativeCount) ?? [];

      // Key by (someType.id, req|neg, absolute index in the someType's constraint
      // array). Trait IDs alone are not unique: two specialized variants of the
      // same trait (e.g., `Iterator(Item := A)` and `Iterator(Item := B)`) share
      // the base trait's id, so keying by id would collide and overwrite.
      let reqIdx = 0;
      let negIdx = 0;
      for (const { expr: traitExpr, isNegated } of traitExprs) {
        if (isNegated) {
          if (negIdx < newNegative.length) {
            const key = `${lhsSomeType.id}:neg:${prevNegativeCount + negIdx}`;
            whereConstraintTraitExprById.set(key, cloneExpr(traitExpr));
            negIdx++;
          }
        } else {
          if (reqIdx < newRequired.length) {
            const key = `${lhsSomeType.id}:req:${prevRequiredCount + reqIdx}`;
            whereConstraintTraitExprById.set(key, cloneExpr(traitExpr));
            reqIdx++;
          }
        }
      }
    }
  }

  // Collect where constraints from the current env frames
  const whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[] = [];
  for (const param of forallParameters) {
    // Only type parameters have SomeTypes with constraints
    if (param.kind !== "type") continue;
    const { someType } = param;
    const constraints = getWhereClauseConstraintsForSomeType(env, someType);
    if (!constraints) {
      continue;
    }
    for (let i = 0; i < constraints.requiredTraits.length; i++) {
      const requiredTraitType = constraints.requiredTraits[i]!;
      whereConstraints.push({
        someType,
        traitType: requiredTraitType,
        traitExpr: whereConstraintTraitExprById.get(`${someType.id}:req:${i}`),
      });
    }
    for (let i = 0; i < constraints.negativeTraits.length; i++) {
      const negativeTraitType = constraints.negativeTraits[i]!;
      const negatedTrait: TraitType = {
        ...negativeTraitType,
        isNegatedConstraint: true,
      };
      whereConstraints.push({
        someType,
        traitType: negatedTrait,
        traitExpr: whereConstraintTraitExprById.get(`${someType.id}:neg:${i}`),
      });
    }
  }

  // Evaluate the receiver type pattern with SomeTypes in scope
  const evaluatedReceiverTypeArg = evaluateExpression({
    expr: receiverTypeArg,
    env,
    context: { ...context },
  });

  if (
    !evaluatedReceiverTypeArg.$ ||
    !evaluatedReceiverTypeArg.$.value ||
    !isTypeValue(evaluatedReceiverTypeArg.$.value)
  ) {
    throw formatErrorMessage({
      token: receiverTypeArg.token,
      errorMessage: `Expected type for receiver type pattern.`,
    });
  }
  env = evaluatedReceiverTypeArg.$.env;
  const receiverTypePattern = evaluatedReceiverTypeArg.$.value.value;

  const {
    env: nextEnv,
    traitEntries,
    negativeTraitEntries,
  } = evaluateImplFieldList({
    fieldExprs,
    env,
    context: { ...context },
    receiverType: receiverTypePattern,
  });
  env = nextEnv;

  if (traitEntries.length === 0 && negativeTraitEntries.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `impl requires at least one trait or member field.`,
    });
  }

  checkManualSendAcyclicPragmaGate({
    traitEntries,
    currentModulePath: context.currentModulePath,
    errorToken: expr.token,
  });

  if (negativeTraitEntries.length > 0) {
    processNegativeTraitEntries({
      negativeTraitEntries,
      receiverType: receiverTypePattern,
      forallParameters,
      whereConstraints,
      currentModulePath: context.currentModulePath,
      isGeneric: true,
      errorToken: expr.token,
    });
  }

  const pendingRegistrations: Array<{
    traitType: TraitType;
    traitValue: TraitValue;
    traitTypeArgExprs?: Expr[];
    traitFunctionParamNames?: string[];
  }> = [];

  for (const entry of traitEntries) {
    const traitValue = entry.traitValue;
    const traitType = traitValue.type;

    checkGenericImplSelfConstraints({
      receiverTypePattern,
      traitType,
      whereConstraints,
      env,
      errorToken: expr.token,
    });

    const { traitTypeArgExprs, traitFunctionParamNames } =
      entry.isAnonymousTrait
        ? {}
        : extractTraitTypeArgsFromImplExpr({
            traitExpr: entry.sourceExpr,
            traitType,
          });

    pendingRegistrations.push({
      traitType,
      traitValue,
      traitTypeArgExprs,
      traitFunctionParamNames,
    });
  }

  // Pop the forall env frame
  env = popEnvFrame(env);

  for (const registration of pendingRegistrations) {
    const traitTypeKey = getBaseTraitKey(registration.traitType);

    const genericImpl: GenericImpl = {
      forallParameters,
      whereConstraints,
      receiverTypePattern,
      traitType: registration.traitType,
      traitValue: registration.traitValue,
      expr,
      sourceModulePath: context.currentModulePath,
      definitionEnv: env, // Store the environment where the impl was defined
      traitTypeArgExprs: registration.traitTypeArgExprs,
      traitFunctionParamNames: registration.traitFunctionParamNames,
    };

    registerGenericImpl(traitTypeKey, genericImpl);
  }

  const primaryTraitValue = pendingRegistrations[0]?.traitValue;
  expr.$ = {
    env,
    type: primaryTraitValue ? primaryTraitValue.type : VUnit.type,
    value: primaryTraitValue || VUnit,
    pathCollection: [],
  };
  return expr;
}
