import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  consumeCaseBodyTempVar,
  type ControlFlowFlags,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  hasControlFlow,
  mergeAndCheckEnvs,
  mergeControlFlows,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { createPtrType } from "../../types/creators";
import type { EnumType, PtrType, Type } from "../../types/definitions";
import {
  isBooleanType,
  isCCompatibleType,
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeStringType,
  isEnumType,
  isFloatType,
  isFunctionTypeAndReturnsComptimeValue,
  isIntegerType,
  isPtrType,
  isSomeType,
} from "../../types/guards";
import { TypeTag } from "../../types/tags";
import {
  convertComptimeTypeToRuntimeType,
  typeContainsSomeType,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  areValuesEqual,
  createUnknownValue,
  isEnumValue,
  isUnknownValue,
  type Value,
  valueToString,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";
import { evaluateExpression } from "./expr";

/**
 * Helper function to check if an expression is an or-pattern (using `|`)
 * Returns true if the expression is of the form `(a | b | c | ...)`
 */
function isOrPattern(expr: Expr): boolean {
  if (!exprIsFunctionCall(expr)) return false;
  return exprIsFunctionCallOf(expr, "|", 2);
}

/**
 * Helper function to flatten an or-pattern into a list of individual patterns
 * For example, `(1 | 2 | 3)` becomes `[1, 2, 3]`
 */
function flattenOrPattern(expr: Expr): Expr[] {
  if (!isOrPattern(expr)) {
    return [expr];
  }
  const fnCall = expr as FnCallExpr;
  const left = fnCall.args[0]!;
  const right = fnCall.args[1]!;
  return [...flattenOrPattern(left), ...flattenOrPattern(right)];
}

/**
 * Compute the GADT-refined expected type for a match branch.
 * Given the original expected type (e.g., SomeType_T), the enum's type constructor args,
 * and the variant's GADT return type args, substitute SomeType parameters
 * with their refined concrete types.
 *
 * For example, if expectedType is SomeType_T, typeConstructorArgs is [SomeType_T],
 * and gadtReturnTypeArgs is [i32], the refined expected type is i32.
 */
function getGadtRefinedExpectedType(
  expectedType: Type,
  typeConstructorArgs: Type[],
  gadtReturnTypeArgs: Type[]
): Type {
  if (isSomeType(expectedType)) {
    for (let k = 0; k < typeConstructorArgs.length; k++) {
      const tca = typeConstructorArgs[k];
      if (tca && isSomeType(tca) && expectedType.id === tca.id) {
        const refined = gadtReturnTypeArgs[k];
        if (refined) {
          return refined;
        }
      }
    }
  }
  return expectedType;
}

/**
 * Check if a GADT branch is reachable given the enum's concrete type constructor args.
 * A branch is unreachable when the enum is instantiated with concrete types that
 * don't match the variant's GADT return type args.
 * For example, Value(i32).BoolVal is unreachable because BoolVal -> recur(bool) and bool != i32.
 */
function isGadtBranchReachable(
  enumType: EnumType,
  variant: { gadtReturnTypeArgs?: Type[] }
): boolean {
  if (
    !enumType.isGadt ||
    !variant.gadtReturnTypeArgs ||
    !enumType.typeConstructorArgs
  ) {
    return true;
  }
  for (let k = 0; k < enumType.typeConstructorArgs.length; k++) {
    const tca = enumType.typeConstructorArgs[k];
    const gra = variant.gadtReturnTypeArgs[k];
    if (tca && gra && !isSomeType(tca)) {
      if (
        !areTypesCompatible(
          { type: tca, env: enumType.env },
          { type: gra, env: enumType.env }
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Helper function to check if a type is a primitive type that can be matched
 * (integers, bool)
 */
function isMatchablePrimitiveType(type: Type): boolean {
  return (
    isIntegerType(type) ||
    isFloatType(type) ||
    isCCompatibleType(type) ||
    isBooleanType(type) ||
    isComptimeIntType(type) ||
    isComptimeFloatType(type) ||
    isComptimeStringType(type)
  );
}

/**
 * True for a *place* expression: a plain variable (atom) or a bare field-access
 * chain rooted at one (`self._bytes`, `a.b.c`).
 *
 * A place is already owned by the enclosing scope for the whole duration of the
 * match, so — exactly like the atom case — it must not be wrapped in an implicit
 * begin() scope, which would materialize an owning temp copy (a `___dup` before
 * the switch and a `___drop` after it) on every single match.
 *
 * That pair is the single hottest shape in a self-compile: `String ==`,
 * `ast_expr_is_fn_call_of` and `ast_expr_is_atom_of` all match on a field and
 * together account for ~60% of all `__yo_decr_rc` traffic, purely to borrow a
 * payload their arms only read.
 *
 * A method call (`x.f()`) is NOT a 2-arg dot call — its `func` is the dot — so
 * it still takes the begin() path and keeps its owning temp.
 */
function exprIsPlaceExpression(expr: Expr, env: Environment): boolean {
  if (exprIsAtom(expr)) {
    return true;
  }
  if (
    !exprIsFunctionCall(expr) ||
    !exprIsFunctionCallOf(expr, ".", 2) ||
    !exprIsAtom(expr.args[1]!)
  ) {
    return false;
  }
  // Walk to the root of the `a.b.c` chain.
  let root: Expr = expr.args[0]!;
  while (
    exprIsFunctionCall(root) &&
    exprIsFunctionCallOf(root, ".", 2) &&
    exprIsAtom(root.args[1]!)
  ) {
    root = root.args[0]!;
  }
  if (!exprIsAtom(root)) {
    return false;
  }
  // The chain must bottom out in a RUNTIME variable. A compile-time dot such as
  // `Kind.Func` (an enum variant) or a module member is not a place: evaluating
  // it directly yields no `variableName` for the match to bind, and it carries
  // no RC traffic to save in the first place.
  const rootVars = getVariablesFromEnv(env, root.token.value);
  const rootVar = rootVars.length ? rootVars[rootVars.length - 1] : undefined;
  return rootVar !== undefined && !rootVar.isCompileTimeOnly;
}

/**
 * Evaluate a `match` expression.
 *
 * **Ownership**: `match` does NOT consume the scrutinee. The original variable
 * remains live and accessible both inside the arm body and after the match
 * expression. Only the extracted destructuring variables (e.g., `w`, `h` from
 * `.Rectangle(w, h)`) are new bindings scoped to that arm.
 *
 * Supported scrutinee types:
 *   - Enum types (with variant patterns, optional destructuring, GADT refinement)
 *   - Primitive types (i*, u*, f*, bool, comptime_int/float/string) — see
 *     `evaluateMatchForPrimitiveTypes` below
 *   - Pointer-to-enum: matched as the underlying enum, with destructured
 *     variables typed as `*(FieldType)` so users can mutate fields in place
 *
 * Match arm syntax (enum scrutinee):
 *
 *   match(shape,
 *     .Circle           => use_circle_unit_variant(),
 *     .Rectangle(w, h)  => (w + h),                    // positional
 *     .Square(side: s)  => double(s),                  // labeled
 *     .Triangle({base, height: h}) => (base * h),      // curly shorthand
 *     (.Foo | .Bar)     => 0,                          // or-pattern
 *     _                 => fallback_value              // wildcard (must be last)
 *   );
 *
 * Destructuring forms (mutually exclusive within a single arm):
 *   - **Positional**: `.Variant(a, b, c)` — must list exactly N args for N fields.
 *     Use `_` to ignore individual positions.
 *   - **Labeled**: `.Variant(label1: var1, label2: _)` — partial; only listed
 *     labels are bound. `_` on the RHS asserts presence without binding.
 *   - **Curly shorthand**: `.Variant({label1, label2: alias})` — partial;
 *     bare atoms are sugar for `name: name`. Bare `_` and nested `{...}` are
 *     rejected; use the labeled form `(label: _)` to skip a single field.
 *
 * GADT support: branches whose declared return-type args are incompatible
 * with the scrutinee's concrete type-constructor args are unreachable and
 * silently skipped (also excluded from exhaustiveness checking).
 *
 * Compile-time scrutinees: when the scrutinee is a known compile-time enum
 * value, only the matching branch is evaluated and destructured fields are
 * bound as compile-time values (enabling further CTFE inside the body).
 */
export function evaluateMatch({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "match", got ${expr.tag}`,
    });
  }

  const args = expr.args;
  if (args.length < 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least 2 arguments for "match", got ${args.length}`,
    });
  }

  // Evaluate the value to be matched
  const scrutineeExpr = args[0]!;

  // Evaluate any expression as scrutinee, not just atoms.
  // Important: don't wrap a *place* scrutinee in an implicit begin() scope.
  // Doing so creates an owning temp copy that gets dropped at end-of-scope, which is
  // incorrect for borrowed scrutinees and breaks enums/structs-with-GC-fields
  // (e.g. Result(String, Err) causing double-drop/UAF).
  // Also, match(self, XXX) will `dup(self)` infinitely if wrapped in begin block
  const evaluatedScrutineeExpr = exprIsPlaceExpression(scrutineeExpr, env)
    ? evaluateExpression({
        expr: scrutineeExpr,
        env,
        context: {
          ...context,
          expectedType: undefined,
        },
      })
    : evaluateBeginExpression({
        expr: scrutineeExpr,
        env,
        context: {
          ...context,
          expectedType: undefined,
        },
        variablesToAdd: [],
      });

  if (!evaluatedScrutineeExpr.$ || !evaluatedScrutineeExpr.$.variableName) {
    throw formatErrorMessage({
      token: scrutineeExpr.token,
      errorMessage: `Failed to evaluate the match scrutinee expression: ${exprToString(scrutineeExpr)}`,
    });
  }
  env = evaluatedScrutineeExpr.$.env;

  const scrutineeType = evaluatedScrutineeExpr.$.type;
  const scrutineeValue = evaluatedScrutineeExpr.$.value;

  // Check if it's a pointer/reference type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.Ptr | undefined = undefined;

  let matchedType: Type;

  if (isPtrType(scrutineeType)) {
    matchedType = scrutineeType.childType;
    ptrOrRefType = scrutineeType.tag;
  } else {
    matchedType = scrutineeType;
  }

  // Check if the matched type is a primitive type (integer, bool)
  if (isMatchablePrimitiveType(matchedType)) {
    return evaluatePrimitiveMatch({
      expr,
      env,
      context,
      scrutineeExpr: evaluatedScrutineeExpr,
      scrutineeType: matchedType,
      scrutineeValue,
    });
  }

  // Check if the value is an enum type
  if (!isEnumType(matchedType)) {
    throw formatErrorMessage({
      token: scrutineeExpr.token,
      errorMessage: `Expected enum type or primitive type (integer, bool) for match expression, got ${
        scrutineeType ? typeToString(scrutineeType) : "unknown type"
      }`,
    });
  }

  const enumType = matchedType;

  // Detect GADT match: the enum is a GADT and we have an expected type to refine against
  const isGadtMatch =
    enumType.isGadt === true &&
    context.expectedType?.type !== undefined &&
    enumType.typeConstructorArgs !== undefined &&
    enumType.typeConstructorArgs.length > 0;

  // Check if there is already selected variant,
  // If yes, then we disallow to use enum because we already know the selected variant.
  /*
  if (enumType.selectedVariantName) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage:
        `Enum type ${typeToString(enumType)} already has selected variant "${enumType.selectedVariantName}".\n` +
        `You cannot use "match" on it, because it already has a selected variant.`,
    });
  }
  */

  const patterns = args.slice(1);

  // Evaluate each statement
  // expect each value to be the same type.
  const bodies: Expr[] = [];
  let resultType: { type: Type; env: Environment } | undefined = undefined;
  const checkedVariantNames: Set<string> = new Set();
  let hasCaseThatDoesntHaveControlFlowSet = false;
  let usedWildcardPattern = false;
  const controlFlows: ControlFlowFlags[] = []; // Track control flows from all cases
  const returnBodies: Expr[] = []; // Track bodies with return control flow for validation
  let matchedBodyIndex = -1; // Track which body index is the compile-time matched branch

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;

    // NOTE: We shouldn't use the parent `env` here
    // instead, we should create new env.
    let caseEnv = env; // pushFrame(env); // NOTE: No need to do this. We now use evaluateBeginExpression instead of evaluateExpression. evaluateBeginExpression will push frame itself.

    // Check if the pattern is a valid match arm
    if (
      !exprIsFunctionCall(pattern) ||
      !exprIsFunctionCallOf(pattern, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: pattern.token,
        errorMessage: `Expected ":" for match pattern, got ${exprToString(pattern)}`,
      });
    }

    const matchArmExpr = pattern.args[0]!;
    const rhsExpr = pattern.args[1]!;

    // Check if the pattern is a valid enum variant
    if (
      // For patterns like .Red
      (exprIsFunctionCall(matchArmExpr) &&
        exprIsFunctionCallOf(matchArmExpr, ".", 1)) ||
      // "_" is a wildcard pattern
      exprIsAtomOf(matchArmExpr, "_")
    ) {
      if (usedWildcardPattern) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Wildcard pattern "_" can only be used once and must be the last match arm in a "match" expression.`,
        });
      }

      // For patterns like .Red
      let variantNameExpr: Expr;
      if (exprIsFunctionCall(matchArmExpr)) {
        variantNameExpr = matchArmExpr.args[0]!;
        if (!exprIsAtom(variantNameExpr)) {
          throw formatErrorMessage({
            token: matchArmExpr.token,
            errorMessage: `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`,
          });
        }
      } else {
        // "_" is a wildcard pattern
        usedWildcardPattern = true;
        variantNameExpr = matchArmExpr;
      }

      const variantName = variantNameExpr.token.value;
      // Check if variant exists in enum
      const variant = enumType.variants.find((v) => v.name === variantName);
      if (!variant && variantName !== "_") {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(enumType)}`,
        });
      }

      // Bare `.Variant` is allowed even for variants WITH fields: it matches
      // the variant and binds none of its fields (the "ignore all fields"
      // form, equivalent to `.Variant({})`). Use `.Variant(a, b)` or
      // `.Variant({label, ...})` when you need the field values.

      checkedVariantNames.add(variantName);

      // Skip unreachable GADT branches (e.g., BoolVal when matching Value(i32))
      if (variant && !isGadtBranchReachable(enumType, variant)) {
        continue;
      }

      if (
        variantName !== "_" &&
        isEnumValue(scrutineeValue) &&
        scrutineeValue.variantName !== variantName
      ) {
        continue; // No need to continue if the variant is not selected
      }

      // Update the enum type to set the selectedVariantName
      const newEnumType = {
        ...enumType,
        selectedVariantName: variantName === "_" ? undefined : variantName,
      };
      /// Add the newEnumType with selectedVariantName to the variantNameExpr
      variantNameExpr.$ = {
        env: caseEnv,
        type: newEnumType,
        value: undefined,
        pathCollection: [],
      };

      let variableType: EnumType | PtrType = newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        }
      }

      const bodyExpr = rhsExpr;

      // Push a new frame for this match case to allow variable shadowing
      caseEnv = pushEnvFrame(caseEnv);

      // Mark the case as executed
      matchArmExpr.$ = {
        env: caseEnv,
        type: variableType,
        value: undefined, // No value yet
        pathCollection: [],
        caseExecuted: true, // Mark the case as executed
      };

      // Evaluate the result expression. Pass the running resultType as
      // expectedType so divergent constructs like `panic(...)` in this arm
      // can pick up the unified type from earlier arms instead of falling
      // back to the function's overall return type. Without this, a
      // match like `.Some(v) => unit_body`, `.None => panic("...")` in a
      // function returning `*(T)` would type-mismatch (panic := *(T), arm
      // body := unit).
      const evaluatedBody = evaluateBeginExpression({
        expr: bodyExpr,
        env: caseEnv,
        context: {
          ...context,
          isExecuting:
            isEnumValue(scrutineeValue) &&
            scrutineeValue.variantName === variantName,
          expectedType: resultType ?? context.expectedType,
        },
        variablesToAdd: [],
      });

      if (!evaluatedBody.$?.type) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(bodyExpr)}`,
        });
      }

      // Pop the frame we pushed for this match case
      // This must be done before mergeAndCheckEnvs so all case environments have the same frame level
      const poppedEnv = popEnvFrame(evaluatedBody.$.env, true); // Ignore check here because the top frame might contain return value from begin expression
      caseEnv = poppedEnv;

      // Update the evaluatedBody's environment to the popped environment
      // so that mergeAndCheckEnvs sees the correct frame level
      evaluatedBody.$ = {
        ...evaluatedBody.$,
        env: poppedEnv,
      };

      // Consume the case body's temp variable so it won't generate a phantom drop
      caseEnv = consumeCaseBodyTempVar(evaluatedBody, caseEnv);
      evaluatedBody.$.env = caseEnv;

      // If scrutinee is a runtime value (undefined), unset the body's compile-time value
      // to force codegen to generate all statements
      // Note: UnknownValue means compile-time but unknown concrete value, keep the body value
      if (scrutineeValue === undefined && evaluatedBody.$) {
        evaluatedBody.$.value = undefined;
      }

      // Check control flow BEFORE type compatibility — branches with return/escape/break/continue
      // act as "never" type and are compatible with any expected type
      if (hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        controlFlows.push(evaluatedBody.$.controlFlow!);
        // Collect bodies with return control flow for validation
        if (hasControlFlow(evaluatedBody.$.controlFlow, "return")) {
          returnBodies.push(evaluatedBody);
        }
        // Check if we have a scrutinee value
        // If so, then this is the matched arm.
        if (
          scrutineeValue &&
          !isUnknownValue(scrutineeValue) &&
          isEnumValue(scrutineeValue)
        ) {
          // If the scrutinee value is an enum value, we can return it directly
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        } else if (scrutineeValue === undefined) {
          // Scrutinee is a runtime value - don't propagate compile-time values
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: undefined,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        }
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;

        if (
          context.expectedType &&
          !areTypesCompatible(context.expectedType, {
            type: evaluatedBody.$.type,
            env: evaluatedBody.$.env,
          })
        ) {
          throw formatErrorMessage({
            token: evaluatedBody.token,
            errorMessage: `Incompatible type with expected type:\n- Expected: ${typeToString(context.expectedType.type)}\n- Actual  : ${typeToString(evaluatedBody.$.type)}`,
          });
        }
      }

      caseEnv = evaluatedBody.$.env;
      bodies.push(evaluatedBody);

      // Track the compile-time matched body index (fieldless variant path)
      if (
        matchedBodyIndex === -1 &&
        isEnumValue(scrutineeValue) &&
        !isUnknownValue(scrutineeValue) &&
        (scrutineeValue.variantName === variantName || variantName === "_")
      ) {
        matchedBodyIndex = bodies.length - 1;
      }

      // Set or verify the result type consistency
      if (!hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        // skip continue/break/return cases

        if (context.expectedType) {
          if (
            !areTypesCompatible(context.expectedType, {
              type: evaluatedBody.$.type,
              env: evaluatedBody.$.env,
            })
          ) {
            throw formatErrorMessage({
              token: evaluatedBody.token,
              errorMessage: `Incompatible type with expected type:
- Expected: ${typeToString(context.expectedType.type)}
- Actual  : ${typeToString(evaluatedBody.$.type)}`,
            });
          }
        }

        if (isGadtMatch) {
          // For GADT matches, verify each branch body type against its GADT-refined expected type
          // rather than checking cross-branch consistency
          if (variant?.gadtReturnTypeArgs && context.expectedType) {
            const refinedExpected = getGadtRefinedExpectedType(
              context.expectedType.type,
              enumType.typeConstructorArgs!,
              variant.gadtReturnTypeArgs
            );
            if (
              !areTypesCompatible(
                { type: refinedExpected, env: caseEnv },
                { type: evaluatedBody.$.type, env: caseEnv }
              )
            ) {
              throw formatErrorMessage({
                token: evaluatedBody.token,
                errorMessage: `GADT type mismatch in branch ".${variantName}":
- Expected: ${typeToString(refinedExpected)}
- Actual  : ${typeToString(evaluatedBody.$.type)}`,
              });
            }
          }
          // Set resultType to the context's expected type (the unrefined type parameter)
          if (!resultType) {
            resultType = context.expectedType!;
          }
        } else if (!resultType) {
          resultType = { type: evaluatedBody.$?.type, env: caseEnv };
        } else if (
          !areTypesCompatible(
            { type: resultType.type, env: caseEnv },
            { type: evaluatedBody.$?.type, env }
          )
        ) {
          // Check if the types match when converting to runtime type
          if (
            areTypesCompatible(
              {
                type: convertComptimeTypeToRuntimeType({
                  type: resultType.type,
                  expectedType: undefined,
                  expr: undefined,
                  env: resultType.env,
                }),
                env: resultType.env,
              },
              {
                type: evaluatedBody.$.type,
                env: caseEnv,
              }
            )
          ) {
            resultType = { type: evaluatedBody.$.type, env: caseEnv };
          } else {
            throw formatErrorMessage({
              token: evaluatedBody.token,
              errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
            });
          }
        }
      }
    }
    // For patterns with destructuring like .Circle(r) or .Rectangle(w, h)
    else if (
      exprIsFunctionCall(matchArmExpr) &&
      exprIsFunctionCall(matchArmExpr.func) &&
      exprIsFunctionCallOf(matchArmExpr.func, ".", 1)
    ) {
      if (usedWildcardPattern) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Wildcard pattern "_" can only be used once and must be the last match arm in a "match" expression.`,
        });
      }

      // Extract variant name from .Circle(r) pattern
      const variantNameExpr = matchArmExpr.func.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(variantNameExpr)}`,
        });
      }

      const variantName = variantNameExpr.token.value;

      // Check if variant exists in enum
      const variant = enumType.variants.find((v) => v.name === variantName);
      if (!variant) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(enumType)}`,
        });
      }

      checkedVariantNames.add(variantName);

      // Skip unreachable GADT branches (e.g., BoolVal when matching Value(i32))
      if (!isGadtBranchReachable(enumType, variant)) {
        continue;
      }

      // Check if this variant should be matched
      if (
        isEnumValue(scrutineeValue) &&
        scrutineeValue.variantName !== variantName
      ) {
        continue; // No need to continue if the variant is not selected
      }

      // Extract destructuring parameters.
      //
      // Curly-destructuring shorthand: `.Variant({a, b: c})` parses as
      // `.Variant(_(a: a, b: c))` — the parser rewrites `{...}` to `_(...)`
      // and converts bare atoms inside to `(name: name)` labeled pairs.
      // When the only arg is such a `_(...)` call, lift its inner args so the
      // rest of this function (and codegen) see canonical labeled-destructuring
      // form. Curly destructuring permits partial matches (omit fields you
      // don't need). We mutate `matchArmExpr.args` in place so codegen — which
      // re-reads `caseValue.args` — sees the same lifted form.
      let isCurlyDestructuring = false;
      if (
        matchArmExpr.args.length === 1 &&
        exprIsFunctionCall(matchArmExpr.args[0]!) &&
        exprIsFunctionCallOf(matchArmExpr.args[0]!, "_")
      ) {
        const curly = matchArmExpr.args[0] as FnCallExpr;
        // Empty curly `.Variant({})` is the explicit "match this variant,
        // bind none of its fields" form — the zero case of curly partial
        // destructuring. It is permitted for any variant (fields or not).
        // Reject nested curly: any inner arg that is itself `_(...)`.
        for (const inner of curly.args) {
          if (exprIsFunctionCall(inner) && exprIsFunctionCallOf(inner, "_")) {
            throw formatErrorMessage({
              token: inner.token,
              errorMessage: `Nested curly destructuring "{...}" inside another "{...}" is not supported.`,
            });
          }
          // Reject bare `_` inside `{...}` — meaningless without a label.
          if (exprIsAtomOf(inner, "_")) {
            throw formatErrorMessage({
              token: inner.token,
              errorMessage: `Bare "_" inside curly destructuring "{...}" is meaningless. Either omit the field, or write "label: _" to assert presence without binding.`,
            });
          }
        }
        isCurlyDestructuring = true;
        matchArmExpr.args = curly.args;
      }
      const destructuringParams = matchArmExpr.args;

      // Check if variant has fields
      if (variant.fields && variant.fields.length > 0) {
        // For labeled destructuring (and curly shorthand), we don't require all
        // parameters to be specified. For positional destructuring, we require
        // exact match.
        const hasLabeledParams =
          isCurlyDestructuring ||
          destructuringParams.some(
            (param) =>
              exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
          );

        if (
          !hasLabeledParams &&
          destructuringParams.length !== variant.fields.length
        ) {
          throw formatErrorMessage({
            token: matchArmExpr.token,
            errorMessage: `Variant "${variantName}" expects ${variant.fields.length} parameters, got ${destructuringParams.length}`,
          });
        }
      } else if (destructuringParams.length > 0) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Variant "${variantName}" has no fields, but destructuring parameters were provided`,
        });
      }

      // Update the enum type to set the selectedVariantName
      const newEnumType = {
        ...enumType,
        selectedVariantName: variantName,
      };

      // Add the newEnumType with selectedVariantName to the variantNameExpr
      variantNameExpr.$ = {
        env: caseEnv,
        type: newEnumType,
        value: undefined,
        pathCollection: [],
      };

      let variableType: EnumType | PtrType = newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        }
      }

      // Push a new frame for this match case
      caseEnv = pushEnvFrame(caseEnv);

      // Add destructured variables to environment
      if (variant.fields && variant.fields.length > 0) {
        const destructuredLabels = new Set<string>();

        for (let j = 0; j < destructuringParams.length; j++) {
          const param = destructuringParams[j]!;

          // Handle labeled destructuring like (label: variable) or (label: _)
          if (
            exprIsFunctionCall(param) &&
            exprIsFunctionCallOf(param, ":", 2)
          ) {
            const labelExpr = param.args[0]!;
            const variableExpr = param.args[1]!;

            if (!exprIsAtom(labelExpr)) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Expected identifier for label in destructuring pattern, got ${exprToString(labelExpr)}`,
              });
            }

            const label = labelExpr.token.value;

            // Find the field with matching label
            const fieldIndex = variant.fields.findIndex(
              (elem) => elem.label === label
            );
            if (fieldIndex === -1) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Label "${label}" not found in variant "${variantName}". Available labels: ${variant.fields.map((e) => e.label).join(", ")}`,
              });
            }

            if (destructuredLabels.has(label)) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Label "${label}" is already destructured`,
              });
            }
            destructuredLabels.add(label);

            const field = variant.fields[fieldIndex]!;

            // Extract compile-time field value if scrutinee is a compile-time enum value
            const isComptimeScrutinee =
              isEnumValue(scrutineeValue) && !isUnknownValue(scrutineeValue);
            const fieldValue = isComptimeScrutinee
              ? scrutineeValue.fields[fieldIndex]
              : undefined;

            // Handle the variable part (could be identifier or _)
            if (exprIsAtom(variableExpr)) {
              const variableName = variableExpr.token.value;

              // Skip if variable name is "_" (ignore pattern)
              if (variableName !== "_") {
                const { env: nextEnv } = addVariableToEnv({
                  env: caseEnv,
                  variable: {
                    name: variableName,
                    type: field.type,
                    isCompileTimeOnly: isComptimeScrutinee,
                    value: fieldValue !== undefined ? [fieldValue] : undefined,
                    token: variableExpr.token,
                    initializedAtToken: variableExpr.token,
                    consumedAtToken: undefined,
                    isReassignable: false,
                    isOwningTheRcValue: false,
                  },
                });
                caseEnv = nextEnv;
              }

              // Add type information to the variableExpr and labelExpr
              variableExpr.$ = {
                env: caseEnv,
                type: field.type,
                value: undefined,
                pathCollection: [],
              };
              labelExpr.$ = {
                env: caseEnv,
                type: field.type,
                value: undefined,
                pathCollection: [],
              };
            } else {
              throw formatErrorMessage({
                token: variableExpr.token,
                errorMessage: `Expected identifier or "_" for variable in labeled destructuring, got ${exprToString(variableExpr)}`,
              });
            }
          }
          // Handle positional destructuring like (r) or (_)
          else if (exprIsAtom(param)) {
            const paramName = param.token.value;
            const field = variant.fields[j]!;

            // Extract compile-time field value if scrutinee is a compile-time enum value
            const isComptimeScrutinee =
              isEnumValue(scrutineeValue) && !isUnknownValue(scrutineeValue);
            const fieldValue = isComptimeScrutinee
              ? scrutineeValue.fields[j]
              : undefined;

            // Skip if parameter name is "_" (ignore pattern)
            if (paramName !== "_") {
              const { env: nextEnv } = addVariableToEnv({
                env: caseEnv,
                variable: {
                  name: paramName,
                  type: field.type,
                  isCompileTimeOnly: isComptimeScrutinee,
                  value: fieldValue !== undefined ? [fieldValue] : undefined,
                  token: param.token,
                  initializedAtToken: param.token,
                  consumedAtToken: undefined,
                  isReassignable: false,
                  isOwningTheRcValue: false,
                },
              });
              caseEnv = nextEnv;
            }

            // Add type information to the param
            param.$ = {
              env: caseEnv,
              type: field.type,
              value: undefined,
              pathCollection: [],
            };
          } else {
            throw formatErrorMessage({
              token: param.token,
              errorMessage: isCurlyDestructuring
                ? `Expected labeled pattern (label: variable) inside curly destructuring "{...}", got ${exprToString(param)}`
                : `Expected identifier, "_", or labeled pattern (label: variable) for destructuring parameter, got ${exprToString(param)}`,
            });
          }
        }
      }

      // Mark the case as executed
      matchArmExpr.$ = {
        env: caseEnv,
        type: variableType,
        value: undefined,
        pathCollection: [],
        caseExecuted: true,
      };

      const bodyExpr = rhsExpr;

      // Evaluate the result expression. Pass the running resultType as
      // expectedType so divergent constructs like `panic(...)` in this arm
      // can pick up the unified type from earlier arms instead of falling
      // back to the function's overall return type. Without this, a
      // match like `.Some(v) => unit_body`, `.None => panic("...")` in a
      // function returning `*(T)` would type-mismatch (panic := *(T), arm
      // body := unit).
      const evaluatedBody = evaluateBeginExpression({
        expr: bodyExpr,
        env: caseEnv,
        context: {
          ...context,
          isExecuting:
            isEnumValue(scrutineeValue) &&
            scrutineeValue.variantName === variantName,
          expectedType: resultType ?? context.expectedType,
        },
        variablesToAdd: [],
      });

      if (!evaluatedBody.$?.type) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(bodyExpr)}`,
        });
      }

      // Pop the frame we pushed for this match case
      // This must be done before mergeAndCheckEnvs so all case environments have the same frame level
      const poppedEnv = popEnvFrame(evaluatedBody.$.env, true); // Ignore check here because the top frame might contain return value from begin expression
      caseEnv = poppedEnv;

      // Update the evaluatedBody's environment to the popped environment
      // so that mergeAndCheckEnvs sees the correct frame level
      evaluatedBody.$ = {
        ...evaluatedBody.$,
        env: poppedEnv,
      };

      // Consume the case body's temp variable so it won't generate a phantom drop
      caseEnv = consumeCaseBodyTempVar(evaluatedBody, caseEnv);
      evaluatedBody.$.env = caseEnv;

      // If scrutinee is a runtime value (undefined), unset the body's compile-time value
      // to force codegen to generate all statements
      // Note: UnknownValue means compile-time but unknown concrete value, keep the body value
      if (scrutineeValue === undefined && evaluatedBody.$) {
        evaluatedBody.$.value = undefined;
      }

      // Handle control flow
      if (hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        controlFlows.push(evaluatedBody.$.controlFlow!);
        // Collect bodies with return control flow for validation
        if (hasControlFlow(evaluatedBody.$.controlFlow, "return")) {
          returnBodies.push(evaluatedBody);
        }
        if (
          scrutineeValue &&
          !isUnknownValue(scrutineeValue) &&
          isEnumValue(scrutineeValue)
        ) {
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        } else if (scrutineeValue === undefined) {
          // Scrutinee is a runtime value - don't propagate compile-time values
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: undefined,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        }
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;
      }

      caseEnv = evaluatedBody.$.env;
      bodies.push(evaluatedBody);

      // Track the compile-time matched body index (variant-with-fields path)
      if (
        matchedBodyIndex === -1 &&
        isEnumValue(scrutineeValue) &&
        !isUnknownValue(scrutineeValue) &&
        (scrutineeValue.variantName === variantName || variantName === "_")
      ) {
        matchedBodyIndex = bodies.length - 1;
      }

      // Set or verify the result type consistency
      if (!hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        // skip continue/break/return cases

        if (isGadtMatch) {
          // For GADT matches, verify each branch body type against its GADT-refined expected type
          if (variant.gadtReturnTypeArgs && context.expectedType) {
            const refinedExpected = getGadtRefinedExpectedType(
              context.expectedType.type,
              enumType.typeConstructorArgs!,
              variant.gadtReturnTypeArgs
            );
            if (
              !areTypesCompatible(
                { type: refinedExpected, env: caseEnv },
                { type: evaluatedBody.$.type, env: caseEnv }
              )
            ) {
              throw formatErrorMessage({
                token: evaluatedBody.token,
                errorMessage: `GADT type mismatch in branch ".${variantName}":
- Expected: ${typeToString(refinedExpected)}
- Actual  : ${typeToString(evaluatedBody.$.type)}`,
              });
            }
          }
          if (!resultType) {
            resultType = context.expectedType!;
          }
        } else if (!resultType) {
          resultType = { type: evaluatedBody.$?.type, env: caseEnv };
        } else if (
          !areTypesCompatible(
            { type: resultType.type, env: caseEnv },
            { type: evaluatedBody.$?.type, env }
          )
        ) {
          // Check if the types match when converting to runtime type
          if (
            areTypesCompatible(
              {
                type: convertComptimeTypeToRuntimeType({
                  type: resultType.type,
                  expectedType: undefined,
                  expr: undefined,
                  env: resultType.env,
                }),
                env: resultType.env,
              },
              {
                type: evaluatedBody.$.type,
                env: caseEnv,
              }
            )
          ) {
            resultType = { type: evaluatedBody.$.type, env: caseEnv };
          } else {
            throw formatErrorMessage({
              token: evaluatedBody.token,
              errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
            });
          }
        }
      }
    } else {
      throw formatErrorMessage({
        token: matchArmExpr.token,
        errorMessage: `Invalid pattern in match expression: ${exprToString(matchArmExpr)}
Supported patterns:
- .VariantName (for variants without fields)
- .VariantName(param1, param2, ...) (for variants with fields)
- _ (wildcard pattern)`,
      });
    }
  }

  // Merge all control flow flags from branches
  const finalControlFlow: ControlFlowFlags | undefined =
    controlFlows.length > 0 ? mergeControlFlows(controlFlows) : undefined;

  if (
    hasCaseThatDoesntHaveControlFlowSet || // some case has no control flow
    !hasAnyControlFlow(finalControlFlow) // no control flows at all
  ) {
    if (hasCaseThatDoesntHaveControlFlowSet && !resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to determine the type of value from the cond.`,
      });
    } else if (!resultType) {
      resultType = { type: VUnit.type, env: env };
    }

    // Perform exhaustiveness check
    if (!checkedVariantNames.has("_")) {
      const missingVariants = enumType.variants.filter(
        (variant) =>
          !checkedVariantNames.has(variant.name) &&
          // GADT: don't require unreachable variants
          isGadtBranchReachable(enumType, variant)
      );
      if (missingVariants.length > 0) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Match expression is not exhaustive. Missing cases for variants:

- ${missingVariants.map((v) => v.name).join("\n- ")}`,
        });
      }
    }

    // When we have a compile-time known scrutinee (enum value), we KNOW exactly which branch was taken.
    // Use the environment from that branch directly, not mergeAndCheckEnvs.
    // mergeAndCheckEnvs is for runtime unknown conditions where we need to merge metadata.
    // Using the branch's environment directly preserves compile-time values like updated variables.
    const nonReturnBodies = bodies.filter(
      (body) =>
        body.$ &&
        !hasControlFlow(body.$.controlFlow, "return") &&
        !hasControlFlow(body.$.controlFlow, "unwind")
    );

    // For compile-time known enum value, find the matched body's value.
    // When the scrutinee is a concrete EnumValue, only one branch was evaluated with
    // isExecuting=true (the matching one). Other branches (like wildcard `_`) are evaluated
    // for type-checking but with isExecuting=false. We use matchedBodyIndex to find it.
    let matchedBodyValue: Value | undefined = undefined;
    if (
      isEnumValue(scrutineeValue) &&
      !isUnknownValue(scrutineeValue) &&
      matchedBodyIndex >= 0 &&
      matchedBodyIndex < bodies.length &&
      bodies[matchedBodyIndex]!.$
    ) {
      // Use the matched body directly
      const matchedBody = bodies[matchedBodyIndex]!.$!;
      env = matchedBody.env;
      matchedBodyValue = matchedBody.value;
    } else if (
      isEnumValue(scrutineeValue) &&
      !isUnknownValue(scrutineeValue) &&
      nonReturnBodies.length === 1 &&
      nonReturnBodies[0]!.$
    ) {
      // Fallback: single non-return body
      env = nonReturnBodies[0]!.$.env;
      matchedBodyValue = nonReturnBodies[0]!.$.value;
    } else if (
      isEnumValue(scrutineeValue) &&
      nonReturnBodies.length === 1 &&
      nonReturnBodies[0]!.$
    ) {
      // Compile-time known match (but UnknownValue) with exactly one matching body
      env = nonReturnBodies[0]!.$.env;
    } else {
      // Merge and check all environments for runtime or multiple bodies
      env = mergeAndCheckEnvs(env, nonReturnBodies);
    }

    // Set the type and value of the match expression
    expr.$ = {
      env,
      type:
        // For GADT matches, use the expected type (the unrefined type parameter)
        // even though it contains SomeType
        isGadtMatch && context.expectedType?.type
          ? context.expectedType.type
          : context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
            ? context.expectedType.type
            : resultType.type,
      // - undefined scrutinee = runtime value, result is undefined (runtime)
      // - UnknownValue scrutinee = compile-time value of unknown concrete value,
      //   result is UnknownValue (CTFE is possible)
      // - Concrete scrutinee = use the actual matched body's computed value
      value:
        scrutineeValue === undefined
          ? undefined
          : matchedBodyValue !== undefined
            ? matchedBodyValue
            : createUnknownValue(resultType.type, { env, context }),
      pathCollection: [],
    };
    attachTempVariableToExpr(expr, true);
  } else {
    // All cases have control flow - determine which one to use
    if (controlFlows.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No control flows found but expected some.`,
      });
    }

    if (hasControlFlow(finalControlFlow, "return")) {
      // At least some cases are returning from function
      if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are returning from function, but not evaluating in function body.`,
        });
      }

      // Use the actual return value type from return bodies when available.
      // This ensures the match's type reflects the concrete type being returned,
      // which is important for detecting generic return type mismatches.
      let returnType: Type | undefined;
      if (returnBodies.length > 0 && returnBodies[0]!.$) {
        returnType = returnBodies[0]!.$.type;
      } else if (
        context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body"
      ) {
        returnType =
          context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;
      } else if (context.expectedType) {
        returnType = context.expectedType.type;
      }

      if (!returnType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to determine the return type for match statement.`,
        });
      }

      expr.$ = {
        env,
        type: returnType,
        value:
          context.isEvaluatingFunctionBodyOrAsyncBlock.kind ===
            "function-body" &&
          isFunctionTypeAndReturnsComptimeValue(
            context.isEvaluatingFunctionBodyOrAsyncBlock.type
          )
            ? createUnknownValue(returnType, { env, context })
            : undefined,
        pathCollection: [],
        controlFlow: finalControlFlow,
      };
    } else if (hasControlFlow(finalControlFlow, "unwind")) {
      // All cases are escaping (returning from enclosing function)
      if (!context.enclosingFunctionReturnType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match use "unwind", but not inside a function with an enclosing function.`,
        });
      }
      const unwindType = context.enclosingFunctionReturnType;
      expr.$ = {
        env,
        type: unwindType,
        value: undefined,
        pathCollection: [],
        controlFlow: finalControlFlow,
      };
    } else if (hasControlFlow(finalControlFlow, "break")) {
      // All cases break from loop
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are breaking from loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        pathCollection: [],
        controlFlow: finalControlFlow,
      };
    } else if (hasControlFlow(finalControlFlow, "continue")) {
      // All cases continue loop
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are continuing loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        pathCollection: [],
        controlFlow: finalControlFlow,
      };
    } else {
      // This should never reach
    }

    return expr;
  }

  return expr;
}

/**
 * Evaluate match expression for primitive types (integers, bool)
 * Supports:
 * - Literal patterns: 1 => ..., true => ...
 * - Or-patterns: (1 | 2 | 3) => ...
 * - Wildcard pattern: _ => ...
 */
function evaluatePrimitiveMatch({
  expr,
  env,
  context,
  scrutineeExpr,
  scrutineeType,
  scrutineeValue,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  scrutineeExpr: Expr;
  scrutineeType: Type;
  scrutineeValue: Value | undefined;
}): FnCallExpr {
  const patterns = expr.args.slice(1);

  const bodies: Expr[] = [];
  let resultType: { type: Type; env: Environment } | undefined = undefined;
  const checkedLiteralValues: Set<string> = new Set();
  let hasCaseThatDoesntHaveControlFlowSet = false;
  let usedWildcardPattern = false;
  const controlFlows: ControlFlowFlags[] = [];
  const returnBodies: Expr[] = [];

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;

    let caseEnv = env;

    // Check if the pattern is a valid match arm (pattern => body)
    if (
      !exprIsFunctionCall(pattern) ||
      !exprIsFunctionCallOf(pattern, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: pattern.token,
        errorMessage: `Expected "=>" for match pattern, got ${exprToString(pattern)}`,
      });
    }

    const matchArmExpr = pattern.args[0]!;
    const rhsExpr = pattern.args[1]!;

    // Check for wildcard pattern "_"
    if (exprIsAtomOf(matchArmExpr, "_")) {
      if (usedWildcardPattern) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Wildcard pattern "_" can only be used once and must be the last match arm in a "match" expression.`,
        });
      }
      usedWildcardPattern = true;

      // Mark the case as executed
      matchArmExpr.$ = {
        env: caseEnv,
        type: scrutineeType,
        value: undefined,
        pathCollection: [],
        caseExecuted: true,
      };

      // Push a new frame for this match case
      caseEnv = pushEnvFrame(caseEnv);

      // Evaluate the result expression
      const evaluatedBody = evaluateBeginExpression({
        expr: rhsExpr,
        env: caseEnv,
        context: {
          ...context,
          // For wildcard at compile-time, we're executing if we have a concrete value
          // UnknownValue means we don't know the concrete value
          isExecuting:
            scrutineeValue !== undefined && !isUnknownValue(scrutineeValue),
        },
        variablesToAdd: [],
      });

      if (!evaluatedBody.$?.type) {
        throw formatErrorMessage({
          token: rhsExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(rhsExpr)}`,
        });
      }

      // Pop the frame we pushed for this match case
      const poppedEnv = popEnvFrame(evaluatedBody.$.env, true);
      caseEnv = poppedEnv;

      evaluatedBody.$ = {
        ...evaluatedBody.$,
        env: poppedEnv,
      };

      // Consume the case body's temp variable so it won't generate a phantom drop
      caseEnv = consumeCaseBodyTempVar(evaluatedBody, caseEnv);
      evaluatedBody.$.env = caseEnv;

      // If scrutinee is a runtime value (undefined), unset the body's compile-time value
      // to force codegen to generate all statements
      // Note: UnknownValue means compile-time but unknown concrete value, keep the body value
      if (scrutineeValue === undefined && evaluatedBody.$) {
        evaluatedBody.$.value = undefined;
      }

      // Check control flow BEFORE type compatibility — branches with return/escape/break/continue
      // act as "never" type and are compatible with any expected type
      if (hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        controlFlows.push(evaluatedBody.$.controlFlow!);
        if (hasControlFlow(evaluatedBody.$.controlFlow, "return")) {
          returnBodies.push(evaluatedBody);
        }
        if (scrutineeValue !== undefined && !isUnknownValue(scrutineeValue)) {
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        } else if (scrutineeValue === undefined) {
          expr.$ = {
            env: evaluatedBody.$.env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: undefined,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        }
        // else: scrutineeValue is UnknownValue, don't set expr.$ here
        // let the final result handling set it with UnknownValue
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;

        if (
          context.expectedType &&
          !areTypesCompatible(context.expectedType, {
            type: evaluatedBody.$.type,
            env: evaluatedBody.$.env,
          })
        ) {
          throw formatErrorMessage({
            token: evaluatedBody.token,
            errorMessage: `Incompatible type with expected type:\n- Expected: ${typeToString(context.expectedType.type)}\n- Actual  : ${typeToString(evaluatedBody.$.type)}`,
          });
        }

        // If we have a concrete compile-time value for scrutinee (not UnknownValue),
        // wildcard always matches, so return early with the body value
        if (scrutineeValue !== undefined && !isUnknownValue(scrutineeValue)) {
          // Merge and check all environments
          env = mergeAndCheckEnvs(
            env,
            bodies.filter(
              (body) =>
                body.$ &&
                !hasControlFlow(body.$.controlFlow, "return") &&
                !hasControlFlow(body.$.controlFlow, "unwind")
            )
          );

          expr.$ = {
            env,
            type:
              context.expectedType?.type &&
              !typeContainsSomeType(context.expectedType.type)
                ? context.expectedType.type
                : evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            pathCollection: [],
            isPrimitiveMatch: true,
          };
          attachTempVariableToExpr(expr, true);
          return expr;
        }
      }

      caseEnv = evaluatedBody.$.env;
      bodies.push(evaluatedBody);

      // Type consistency check
      if (!hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
        if (!resultType) {
          resultType = { type: evaluatedBody.$.type, env: caseEnv };
        } else if (
          !areTypesCompatible(
            { type: resultType.type, env: caseEnv },
            { type: evaluatedBody.$.type, env }
          )
        ) {
          throw formatErrorMessage({
            token: evaluatedBody.token,
            errorMessage: `Incompatible types in match branches:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
          });
        }
      }

      continue;
    }

    // Handle literal patterns and or-patterns
    // First, flatten any or-patterns into a list of individual patterns
    const flattenedPatterns = flattenOrPattern(matchArmExpr);
    const patternValues: { expr: Expr; value: Value | undefined }[] = [];

    for (const patternExpr of flattenedPatterns) {
      // Evaluate the pattern expression to get its value
      const evaluatedPattern = evaluateExpression({
        expr: patternExpr,
        env: caseEnv,
        context: {
          ...context,
          expectedType: { type: scrutineeType, env: caseEnv },
        },
      });

      if (!evaluatedPattern.$) {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Failed to evaluate pattern expression: ${exprToString(patternExpr)}`,
        });
      }

      // Check type compatibility
      if (
        !areTypesCompatible(
          { type: scrutineeType, env: caseEnv },
          { type: evaluatedPattern.$.type, env: evaluatedPattern.$.env }
        )
      ) {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Pattern type ${typeToString(evaluatedPattern.$.type)} is not compatible with scrutinee type ${typeToString(scrutineeType)}`,
        });
      }

      const patternValue = evaluatedPattern.$.value;

      // Rust-like constraint: patterns must be compile-time known values
      // This includes literals (1, 2, true, false) and compile-time constants (defined with ::)
      if (patternValue === undefined) {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Match patterns must be compile-time known values. "${exprToString(patternExpr)}" is a runtime value.
Hint: Use "::" to define compile-time constants, e.g., "myConst :: 42"`,
        });
      }

      // Check for duplicate pattern values
      const literalKey = valueToString(patternValue);
      if (literalKey) {
        if (checkedLiteralValues.has(literalKey)) {
          throw formatErrorMessage({
            token: patternExpr.token,
            errorMessage: `Duplicate pattern value: ${valueToString(patternValue)}`,
          });
        }
        checkedLiteralValues.add(literalKey);
      }

      patternValues.push({ expr: evaluatedPattern, value: patternValue });
    }

    // Check if any pattern matches the scrutinee at compile time
    // Note: UnknownValue means we have a compile-time type but don't know the concrete value
    // so we can't do compile-time pattern matching in that case
    let matchesAtCompileTime = false;
    if (scrutineeValue !== undefined && !isUnknownValue(scrutineeValue)) {
      for (const { value, expr: patternExpr } of patternValues) {
        if (
          areValuesEqual(
            { value: scrutineeValue, env: scrutineeExpr.$!.env },
            { value, env: patternExpr.$!.env }
          )
        ) {
          matchesAtCompileTime = true;
          break;
        }
      }
    }

    // Mark the case as executed
    matchArmExpr.$ = {
      env: caseEnv,
      type: scrutineeType,
      value: undefined,
      pathCollection: [],
      caseExecuted: true,
      // Store pattern values for codegen
      primitivePatternValues: patternValues.map((p) => p.value),
    };

    // Push a new frame for this match case
    caseEnv = pushEnvFrame(caseEnv);

    // Evaluate the result expression
    const evaluatedBody = evaluateBeginExpression({
      expr: rhsExpr,
      env: caseEnv,
      context: {
        ...context,
        isExecuting: matchesAtCompileTime,
      },
      variablesToAdd: [],
    });

    if (!evaluatedBody.$?.type) {
      throw formatErrorMessage({
        token: rhsExpr.token,
        errorMessage: `Expected type for match result expression, got ${exprToString(rhsExpr)}`,
      });
    }

    // Pop the frame we pushed for this match case
    const poppedEnv = popEnvFrame(evaluatedBody.$.env, true);
    caseEnv = poppedEnv;

    evaluatedBody.$ = {
      ...evaluatedBody.$,
      env: poppedEnv,
    };

    // Consume the case body's temp variable so it won't generate a phantom drop
    caseEnv = consumeCaseBodyTempVar(evaluatedBody, caseEnv);
    evaluatedBody.$.env = caseEnv;

    // If scrutinee is a runtime value, unset the body's compile-time value
    // Note: UnknownValue means compile-time but unknown concrete value, keep the body value
    if (scrutineeValue === undefined && evaluatedBody.$) {
      evaluatedBody.$.value = undefined;
    }

    // Check control flow BEFORE type compatibility — branches with return/escape/break/continue
    // act as "never" type and are compatible with any expected type
    if (hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
      controlFlows.push(evaluatedBody.$.controlFlow!);
      if (hasControlFlow(evaluatedBody.$.controlFlow, "return")) {
        returnBodies.push(evaluatedBody);
      }
      if (scrutineeValue !== undefined && matchesAtCompileTime) {
        expr.$ = {
          env: evaluatedBody.$.env,
          type:
            context.expectedType?.type &&
            !typeContainsSomeType(context.expectedType.type)
              ? context.expectedType.type
              : evaluatedBody.$.type,
          value: evaluatedBody.$.value,
          pathCollection: evaluatedBody.$.pathCollection,
          controlFlow: evaluatedBody.$.controlFlow,
        };
        // Early return when we have a compile-time match with control flow
        return expr;
      } else if (scrutineeValue === undefined) {
        expr.$ = {
          env: evaluatedBody.$.env,
          type:
            context.expectedType?.type &&
            !typeContainsSomeType(context.expectedType.type)
              ? context.expectedType.type
              : evaluatedBody.$.type,
          value: undefined,
          pathCollection: evaluatedBody.$.pathCollection,
          controlFlow: evaluatedBody.$.controlFlow,
        };
      }
    } else {
      hasCaseThatDoesntHaveControlFlowSet = true;

      if (
        context.expectedType &&
        !areTypesCompatible(context.expectedType, {
          type: evaluatedBody.$.type,
          env: evaluatedBody.$.env,
        })
      ) {
        throw formatErrorMessage({
          token: evaluatedBody.token,
          errorMessage: `Incompatible type with expected type:\n- Expected: ${typeToString(context.expectedType.type)}\n- Actual  : ${typeToString(evaluatedBody.$.type)}`,
        });
      }

      // When we have a compile-time match without control flow, return early with the matched value
      if (
        scrutineeValue !== undefined &&
        !isUnknownValue(scrutineeValue) &&
        matchesAtCompileTime
      ) {
        expr.$ = {
          env: evaluatedBody.$.env,
          type:
            context.expectedType?.type &&
            !typeContainsSomeType(context.expectedType.type)
              ? context.expectedType.type
              : evaluatedBody.$.type,
          value: evaluatedBody.$.value,
          pathCollection: evaluatedBody.$.pathCollection,
          isPrimitiveMatch: true,
        };
        attachTempVariableToExpr(expr, true);
        return expr;
      }
    }

    caseEnv = evaluatedBody.$.env;
    bodies.push(evaluatedBody);

    // Type consistency check
    if (!hasAnyControlFlow(evaluatedBody.$.controlFlow)) {
      if (!resultType) {
        resultType = { type: evaluatedBody.$.type, env: caseEnv };
      } else if (
        !areTypesCompatible(
          { type: resultType.type, env: caseEnv },
          { type: evaluatedBody.$.type, env }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptimeTypeToRuntimeType({
                type: resultType.type,
                expectedType: undefined,
                expr: undefined,
                env: resultType.env,
              }),
              env: resultType.env,
            },
            {
              type: evaluatedBody.$.type,
              env: caseEnv,
            }
          )
        ) {
          resultType = { type: evaluatedBody.$.type, env: caseEnv };
        } else {
          throw formatErrorMessage({
            token: evaluatedBody.token,
            errorMessage: `Incompatible types in match branches:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
          });
        }
      }
    }
  }

  // For primitive type matching, we require a wildcard pattern for exhaustiveness
  // (unless we're matching bool and have both true and false)
  if (!usedWildcardPattern) {
    if (isBooleanType(scrutineeType)) {
      const hasTrue = checkedLiteralValues.has("true");
      const hasFalse = checkedLiteralValues.has("false");
      if (!hasTrue || !hasFalse) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Match expression on bool is not exhaustive. Missing cases for: ${!hasTrue ? "true" : ""}${!hasTrue && !hasFalse ? ", " : ""}${!hasFalse ? "false" : ""}`,
        });
      }
    } else {
      // For integer types, we always require a wildcard pattern
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Match expression on ${typeToString(scrutineeType)} requires a wildcard pattern "_" for exhaustiveness.`,
      });
    }
  }

  // Merge all control flow flags from branches
  const finalControlFlow: ControlFlowFlags | undefined =
    controlFlows.length > 0 ? mergeControlFlows(controlFlows) : undefined;

  if (
    hasCaseThatDoesntHaveControlFlowSet ||
    !hasAnyControlFlow(finalControlFlow)
  ) {
    if (hasCaseThatDoesntHaveControlFlowSet && !resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to determine the type of value from the match.`,
      });
    } else if (!resultType) {
      resultType = { type: VUnit.type, env: env };
    }

    // When we have a compile-time known scrutinee, we KNOW exactly which branch was taken.
    // Use the environment from that branch directly, not mergeAndCheckEnvs.
    // mergeAndCheckEnvs is for runtime unknown conditions where we need to merge metadata.
    // Using the branch's environment directly preserves compile-time values like updated variables.
    const nonReturnBodies = bodies.filter(
      (body) =>
        body.$ &&
        !hasControlFlow(body.$.controlFlow, "return") &&
        !hasControlFlow(body.$.controlFlow, "unwind")
    );
    if (
      scrutineeValue !== undefined &&
      !isUnknownValue(scrutineeValue) &&
      nonReturnBodies.length === 1 &&
      nonReturnBodies[0]!.$
    ) {
      // Compile-time known match with exactly one matching body
      env = nonReturnBodies[0]!.$.env;
    } else {
      // Merge and check all environments for runtime or multiple bodies
      env = mergeAndCheckEnvs(env, nonReturnBodies);
    }

    // Set the type and value of the match expression
    expr.$ = {
      env,
      type:
        context.expectedType?.type &&
        !typeContainsSomeType(context.expectedType.type)
          ? context.expectedType.type
          : resultType.type,
      // - undefined scrutinee = runtime value, result is undefined (runtime)
      // - UnknownValue scrutinee = compile-time value of unknown concrete value,
      //   result is UnknownValue (CTFE is possible)
      // - Concrete scrutinee = should have already matched a branch above
      value:
        scrutineeValue === undefined
          ? undefined
          : createUnknownValue(resultType.type, { env, context }),
      pathCollection: [],
      // Mark this as a primitive match for codegen
      isPrimitiveMatch: true,
    };
    attachTempVariableToExpr(expr, true);
  } else {
    // All cases have control flow
    if (controlFlows.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No control flows found but expected some.`,
      });
    }

    if (hasControlFlow(finalControlFlow, "return")) {
      if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are returning from function, but not evaluating in function body.`,
        });
      }

      // Use the actual return value type from return bodies when available.
      let returnType: Type | undefined;
      if (returnBodies.length > 0 && returnBodies[0]!.$) {
        returnType = returnBodies[0]!.$.type;
      } else if (
        context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body"
      ) {
        returnType =
          context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;
      } else if (context.expectedType) {
        returnType = context.expectedType.type;
      }

      if (!returnType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to determine the return type for match statement.`,
        });
      }

      expr.$ = {
        env,
        type: returnType,
        value:
          context.isEvaluatingFunctionBodyOrAsyncBlock.kind ===
            "function-body" &&
          isFunctionTypeAndReturnsComptimeValue(
            context.isEvaluatingFunctionBodyOrAsyncBlock.type
          )
            ? createUnknownValue(returnType, { env, context })
            : undefined,
        pathCollection: [],
        controlFlow: finalControlFlow,
        isPrimitiveMatch: true,
      };
    } else if (hasControlFlow(finalControlFlow, "unwind")) {
      if (!context.enclosingFunctionReturnType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match use "unwind", but not inside a function with an enclosing function.`,
        });
      }
      const unwindType = context.enclosingFunctionReturnType;
      expr.$ = {
        env,
        type: unwindType,
        value: undefined,
        pathCollection: [],
        controlFlow: finalControlFlow,
        isPrimitiveMatch: true,
      };
    } else if (hasControlFlow(finalControlFlow, "break")) {
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are breaking from loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        pathCollection: [],
        controlFlow: finalControlFlow,
        isPrimitiveMatch: true,
      };
    } else if (hasControlFlow(finalControlFlow, "continue")) {
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are continuing loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        pathCollection: [],
        controlFlow: finalControlFlow,
        isPrimitiveMatch: true,
      };
    }

    return expr;
  }

  return expr;
}
