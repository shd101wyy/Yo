import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { PlaceholderToken, type Token } from "../../token";
import type { FutureEffect, Type } from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isArrayType,
  isComptimeListType,
  isEnumType,
  isFnTraitType,
  isFunctionType,
  isFutureTraitType,
  isIsoType,
  isSourceNamespaceType,
  isPtrType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isTypeApplicationType,
  isTypeHierarchyType,
  isUnionType,
} from "../../types/guards";
import { TypeTag } from "../../types/tags";
import { typeToString } from "../../types/utils";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";

/**
 * Check if a given type hierarchy type can be assigned to an expected type hierarchy type.
 * Based on the logic from compatibility.ts
 */
export function canAssignTypeHierarchy(expected: Type, given: Type): boolean {
  if (!isTypeHierarchyType(expected) || !isTypeHierarchyType(given)) {
    return false;
  }

  // Check if the given type is a subtype of the expected type
  return (
    given.level === expected.level &&
    (given.tag === expected.tag || expected.tag === TypeTag.Type)
  );
}

/**
 * Occurs check: Check if a SomeType occurs within another type.
 * This prevents infinite types like T = Option(T).
 * Returns true if someType occurs in the type structure.
 */
function occursCheck(
  someTypeId: string,
  type: Type,
  visited: Set<string> = new Set()
): boolean {
  // Prevent infinite recursion on cyclic types like Node(T) → Option(Node(T)) → Node(T)
  if (visited.has(type.id)) {
    return false;
  }
  visited.add(type.id);

  if (isSomeType(type)) {
    return someTypeId === type.id;
  }

  if (isStructType(type)) {
    return type.fields.some((el) => occursCheck(someTypeId, el.type, visited));
  }

  if (isEnumType(type)) {
    return type.variants.some((v) =>
      v.fields
        ? v.fields.some((el) => occursCheck(someTypeId, el.type, visited))
        : false
    );
  }

  if (isTupleType(type)) {
    return type.fields.some((el) => occursCheck(someTypeId, el.type, visited));
  }

  if (isArrayType(type) || isComptimeListType(type)) {
    return occursCheck(someTypeId, type.childType, visited);
  }

  if (isPtrType(type)) {
    // Don't check inside pointer types for occurs check
    // This prevents false positives like trying to bind X to *(X)
    // This is a valid indirection.
    return false;
  }

  if (isIsoType(type)) {
    return occursCheck(someTypeId, type.childType, visited);
  }

  if (isFunctionType(type)) {
    return (
      type.parameters.some((p) => occursCheck(someTypeId, p.type, visited)) ||
      occursCheck(someTypeId, type.return.type, visited)
    );
  }

  if (isFutureTraitType(type)) {
    if (occursCheck(someTypeId, type.isFuture.outputType, visited)) {
      return true;
    }
    if (
      type.isFuture.effect &&
      occursCheck(someTypeId, type.isFuture.effect.type, visited)
    ) {
      return true;
    }
    return false;
  }

  if (isFnTraitType(type)) {
    return occursCheck(someTypeId, type.isFn.callType, visited);
  }

  if (isTypeApplicationType(type)) {
    return (
      occursCheck(someTypeId, type.constructor, visited) ||
      type.args.some((arg) => occursCheck(someTypeId, arg, visited))
    );
  }

  if (isTraitType(type)) {
    return type.fields.some((f) => occursCheck(someTypeId, f.type, visited));
  }

  if (isSourceNamespaceType(type)) {
    return type.fields.some((f) => occursCheck(someTypeId, f.type, visited));
  }

  if (isUnionType(type)) {
    return type.fields.some((f) => occursCheck(someTypeId, f.type, visited));
  }

  return false;
}

/**
 * Synthesize the types, such as
 * comptime(T): Type, i32  => T = i32
 */
export interface SynthesizeTypesOptions {
  /** When true, also sets `resolvedConcreteType` on SomeType objects when binding
   * them to concrete types. This allows forall parameter inference to pick up
   * bindings that cross environment boundaries (e.g., from closure body evaluation
   * back to the call site). Only enable at targeted call sites. */
  setResolvedConcreteType?: boolean;
  /** Optional source token for variable bindings created during synthesis.
   * When provided, improves error messages by pointing to the actual source
   * location where type inference occurred instead of a placeholder. */
  token?: Token;
}

type SynthStats = { calls: number; throws: number };
const _g2: typeof globalThis & { __yoSynthStats?: SynthStats } = globalThis;
const _synthStats =
  _g2.__yoSynthStats ?? (_g2.__yoSynthStats = { calls: 0, throws: 0 });

/**
 * Lightweight `Error` clone that skips V8 stack-capture *and* lazily
 * builds its message string.
 *
 * `synthesizeTypes` is called speculatively during overload resolution
 * and where-clause checking; per `perf-repros/run.sh ts-nested-tostring`
 * roughly 30% of calls throw to signal "incompatible types" — these
 * throws are caught and discarded by almost every call site. The only
 * site that *reads* the message is `evaluator/calls/helper.ts:~610`,
 * which forwards it into a user-facing error.
 *
 * Two wins over `new Error("...")`:
 *
 *   1. The constructor does not call `super()`, so V8's stack-capture
 *      pass is skipped (~2x faster per throw/catch pair on Bun). We
 *      still patch the prototype so `error instanceof Error === true`
 *      for catch sites that check it.
 *   2. The message is computed lazily via a getter. The two
 *      `typeToString(...)` calls that go into a typical message
 *      ("Cannot unify X and Y") only execute when the message is
 *      actually read — i.e. essentially never on the hot speculative
 *      path. For the heavy yo-self compile this avoids tens of
 *      thousands of recursive `typeToString` walks.
 */
class IncompatibleTypesError {
  name: string = "IncompatibleTypesError";
  private _msg: string | (() => string);
  constructor(msg: string | (() => string)) {
    this._msg = msg;
  }
  get message(): string {
    if (typeof this._msg === "function") {
      this._msg = this._msg();
    }
    return this._msg;
  }
}
// Make `error instanceof Error` still hold for the catch sites that
// check it (see src/evaluator/calls/function.ts:1721).
Object.setPrototypeOf(IncompatibleTypesError.prototype, Error.prototype);
export function _printSynthStats() {
  if (process.env["YO_DEBUG_CALL_PROFILE"] === "1") {
    // eslint-disable-next-line no-console
    console.log(
      `[SYNTH] calls=${_synthStats.calls} throws=${_synthStats.throws} (throw rate ${
        _synthStats.calls === 0
          ? "n/a"
          : ((100 * _synthStats.throws) / _synthStats.calls).toFixed(1) + "%"
      })`
    );
  }
}

export function synthesizeTypes(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  },
  checkedTypePairs: { expected: Type; given: Type }[] = [],
  options?: SynthesizeTypesOptions
): { expectedEnv: Environment; givenEnv: Environment } {
  _synthStats.calls++;
  // Prevent circular checks for `object` and similar recursive types
  if (
    checkedTypePairs.find(
      (pair) => pair.expected === expected.type && pair.given === given.type
    )
  ) {
    // Already checked this pair, avoid infinite recursion
    return { expectedEnv: expected.env, givenEnv: given.env };
  } else {
    checkedTypePairs.push({ expected: expected.type, given: given.type });
  }

  if (isSomeType(expected.type) && isSomeType(given.type)) {
    // Handle case where both are SomeTypes - unify them
    // Check if either SomeType is already bound
    const expectedBoundType = getValueOfSomeTypeFromEnv(
      expected.env,
      expected.type
    );
    const givenBoundType = getValueOfSomeTypeFromEnv(given.env, given.type);

    if (!isSomeType(expectedBoundType)) {
      // Expected is bound, use it to bind given
      const value = createTypeValue(expectedBoundType);
      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: [value],
            type: value.type,
            isCompileTimeOnly: true,
            token: options?.token ?? PlaceholderToken,
            initializedAtToken: options?.token ?? PlaceholderToken,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
          },
        });
        given.env = nextEnv;
      } else {
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value: [value],
        });
      }
    } else if (!isSomeType(givenBoundType)) {
      // Given is bound, use it to bind expected
      const value = createTypeValue(givenBoundType);
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: [value],
            type: value.type,
            isCompileTimeOnly: true,
            token: options?.token ?? PlaceholderToken,
            initializedAtToken: options?.token ?? PlaceholderToken,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
          },
        });
        expected.env = nextEnv;
      } else {
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value: [value],
        });
      }
    } else if (expectedBoundType === givenBoundType) {
      // Do nothing since both are the same
    }
    // both are some type
    else {
      // Both SomeTypes are unbound. Bind both to given.type as the representative.
      // This is intentionally asymmetric: in the expected/given convention, the given side
      // represents the actual value being matched, so it becomes the unification target.
      // Expected's SomeType gets bound to given.type, while given.type remains self-bound
      // (effectively unbound until resolved later via concrete type assignment).
      const value = createTypeValue(given.type);

      // Update expected env
      {
        const existingVariables = getVariablesFromEnv(
          expected.env,
          expected.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: expected.env,
            variable: {
              name: expected.type.name,
              value: [value],
              type: value.type,
              isCompileTimeOnly: true,
              token: options?.token ?? PlaceholderToken,
              initializedAtToken: options?.token ?? PlaceholderToken,
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
            },
          });
          expected.env = nextEnv;
        } else {
          expected.env = updateExistingVariable(expected.env, variable, {
            ...variable,
            value: [value],
          });
        }
      }

      // Update given env
      {
        const existingVariables = getVariablesFromEnv(
          given.env,
          given.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: given.env,
            variable: {
              name: given.type.name,
              value: [value],
              type: value.type,
              isCompileTimeOnly: true,
              token: options?.token ?? PlaceholderToken,
              initializedAtToken: options?.token ?? PlaceholderToken,
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
            },
          });
          given.env = nextEnv;
        } else {
          given.env = updateExistingVariable(given.env, variable, {
            ...variable,
            value: [value],
          });
        }
      }
    }

    // After unifying the two SomeTypes, recursively synthesize their required trait
    // type parameters. For example, when expected=Impl(Future(T)) and given=Impl(Future(i32)),
    // we need to match Future(T) with Future(i32) to resolve T = i32.
    // Only do this when the two SomeTypes are from DIFFERENT declarations (different IDs).
    // When they are the same object (e.g., closure takes on expected type), recursion is unnecessary.
    if (
      expected.type.id !== given.type.id &&
      expected.type.requiredTraits &&
      given.type.requiredTraits
    ) {
      const expectedTraits = expected.type.requiredTraits;
      const givenTraits = given.type.requiredTraits;
      // Match traits by kind rather than by position, so that
      // Impl(Future(T)) can match against Impl(Concrete(...), Future(i32))
      // even when the Future trait is at a different index.
      for (let i = 0; i < expectedTraits.length; i++) {
        const expectedTrait = expectedTraits[i]!.traitType;
        if (isFnTraitType(expectedTrait)) {
          const matchingGiven = givenTraits.find((gt) =>
            isFnTraitType(gt.traitType)
          );
          if (matchingGiven && isFnTraitType(matchingGiven.traitType)) {
            const { expectedEnv, givenEnv } = synthesizeTypes(
              { type: expectedTrait.isFn.callType, env: expected.env },
              { type: matchingGiven.traitType.isFn.callType, env: given.env },
              checkedTypePairs,
              options
            );
            expected.env = expectedEnv;
            given.env = givenEnv;
          }
        } else if (isFutureTraitType(expectedTrait)) {
          const matchingGiven = givenTraits.find((gt) =>
            isFutureTraitType(gt.traitType)
          );
          if (matchingGiven && isFutureTraitType(matchingGiven.traitType)) {
            const { expectedEnv, givenEnv } = synthesizeTypes(
              { type: expectedTrait.isFuture.outputType, env: expected.env },
              {
                type: matchingGiven.traitType.isFuture.outputType,
                env: given.env,
              },
              checkedTypePairs,
              options
            );
            expected.env = expectedEnv;
            given.env = givenEnv;
            synthesizeFutureEffects(
              expectedTrait.isFuture.effect,
              matchingGiven.traitType.isFuture.effect,
              expected,
              given,
              checkedTypePairs,
              options
            );
          }
        }
      }
    }
  } else if (isSomeType(expected.type)) {
    // Check if the env has

    const type = getValueOfSomeTypeFromEnv(expected.env, expected.type);

    if (isSomeType(type) && type.id === expected.type.id) {
      // Occurs check: prevent infinite types like T = Option(T)
      if (occursCheck(expected.type.id, given.type)) {
        _synthStats.throws++;
        const expectedName = expected.type.name;
        const givenType = given.type;
        throw new IncompatibleTypesError(
          () =>
            `Cannot unify type variable "${expectedName}" with type "${typeToString(givenType)}" because it would create an infinite type.`
        );
      }

      const value = createTypeValue(given.type);

      if (
        options?.setResolvedConcreteType &&
        !expected.type.resolvedConcreteType
      ) {
        expected.type.resolvedConcreteType = given.type;
      }

      // Check if the same variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        // Place the binding at the SomeType's definitionFrameLevel when
        // possible, so subsequent lookups via `getValueOfSomeTypeFromEnv`
        // (which keys off `definitionFrameLevel`) can find it. Without this
        // the binding goes onto the top frame and the fast/fallback paths in
        // env-lookup miss it, returning the SomeType as "unbound".
        let deltaFrame: number | undefined = undefined;
        const defLevel = expected.type.definitionFrameLevel;
        if (
          defLevel !== undefined &&
          defLevel >= 0 &&
          defLevel < expected.env.frames.length
        ) {
          deltaFrame = defLevel - (expected.env.frames.length - 1);
        }
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: [value],
            type: value.type,
            isCompileTimeOnly: true,
            token: options?.token ?? PlaceholderToken,
            initializedAtToken: options?.token ?? PlaceholderToken,
            consumedAtToken: undefined, // Not consumed yet
            isOwningTheRcValue: false,
          },
          deltaFrame,
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value: [value],
        });
      }

      // After binding the SomeType, recursively synthesize required trait type parameters.
      // For Impl(Fn(using(...(E)) -> T)) matched with fn() -> i32,
      // this resolves T = i32 and E = empty by matching the Fn trait's call type
      // with the given function type.
      if (expected.type.requiredTraits) {
        for (const { traitType } of expected.type.requiredTraits) {
          if (isFnTraitType(traitType) && isFunctionType(given.type)) {
            const fnCallType = traitType.isFn.callType;
            const { expectedEnv, givenEnv } = synthesizeTypes(
              { type: fnCallType, env: expected.env },
              { type: given.type, env: given.env },
              checkedTypePairs,
              options
            );
            expected.env = expectedEnv;
            given.env = givenEnv;
          } else if (
            isFutureTraitType(traitType) &&
            isFutureTraitType(given.type)
          ) {
            const { expectedEnv, givenEnv } = synthesizeTypes(
              { type: traitType.isFuture.outputType, env: expected.env },
              { type: given.type.isFuture.outputType, env: given.env },
              checkedTypePairs,
              options
            );
            expected.env = expectedEnv;
            given.env = givenEnv;
            synthesizeFutureEffects(
              traitType.isFuture.effect,
              given.type.isFuture.effect,
              expected,
              given,
              checkedTypePairs,
              options
            );
          }
        }
      }
    } else if (!isSomeType(type)) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: type, env: expected.env },
        { type: given.type, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (isSomeType(given.type)) {
    // Handle case where given is SomeType but expected is not
    // This can happen in closure synthesis where we need to unify SomeTypes

    // Check if the given SomeType is already bound in its environment
    const existingType = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (!isSomeType(existingType)) {
      // The given SomeType is already bound to a concrete type
      // Recursively synthesize with the bound type
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type, env: expected.env },
        { type: existingType, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    } else {
      // Occurs check: prevent infinite types like T = Option(T)
      if (occursCheck(given.type.id, expected.type)) {
        _synthStats.throws++;
        const givenName = given.type.name;
        const expectedType = expected.type;
        throw new IncompatibleTypesError(
          () =>
            `Cannot unify type variable "${givenName}" with type "${typeToString(expectedType)}" because it would create an infinite type.`
        );
      }

      // Bind the given SomeType to the expected type
      const value = createTypeValue(expected.type);

      if (
        options?.setResolvedConcreteType &&
        !given.type.resolvedConcreteType
      ) {
        given.type.resolvedConcreteType = expected.type;
      }

      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: [value],
            type: value.type,
            isCompileTimeOnly: true,
            token: options?.token ?? PlaceholderToken,
            initializedAtToken: options?.token ?? PlaceholderToken,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
          },
        });
        given.env = nextEnv;
      } else if (variable) {
        // Update existing
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value: [value],
        });
      }
    }
  } else if (
    isTupleType(expected.type) &&
    isTupleType(given.type) &&
    expected.type.fields.length === given.type.fields.length
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type.fields[i]!.type, env: expected.env },
        { type: given.type.fields[i]!.type, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (isTupleType(expected.type) && isTupleType(given.type)) {
    _synthStats.throws++;
    throw new IncompatibleTypesError(
      () =>
        `Cannot unify incompatible tuple types: "${typeToString(
          expected.type
        )}" and "${typeToString(given.type)}"`
    );
  } else if (isStructType(expected.type) && isStructType(given.type)) {
    if (
      expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue)
    ) {
      // NOTE: The typeId might not match
      // They might be different structs that both are returned from the same function.
      // We removed the typeName condition since it fails for Data(boolean) vs Data(A1)
    } else if (
      // Allow unification if both structs come from the same type constructor (same funcId).
      // This handles cases where different forall scopes produce different struct instances
      // but from the same constructor function (e.g., JoinHandle(T) from module definition
      // vs JoinHandle(T) from extern function definition).
      expected.type.functionValue &&
      given.type.functionValue &&
      expected.type.functionValue.funcId === given.type.functionValue.funcId
    ) {
      // Same type constructor by funcId — allow structural unification
    } else {
      _synthStats.throws++;
      throw new IncompatibleTypesError(
        () =>
          `Cannot unify incompatible struct types: "${typeToString(expected.type)}" and "${typeToString(given.type)}"`
      );
    }

    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedElement = expected.type.fields[i]!;
      const givenElement = given.type.fields[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv: _expectedEnv, givenEnv: _givenEnv } =
          synthesizeTypes(
            {
              type: expectedElement.assignedValue.value,
              env: expected.env,
            },
            {
              type: givenElement.assignedValue.value,
              env: given.env,
            },
            checkedTypePairs,
            options
          );
        expected.env = _expectedEnv;
        given.env = _givenEnv;
      }
    }
  } else if (
    isEnumType(expected.type) &&
    isEnumType(given.type) &&
    (expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue))
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedTypeVariant = expected.type.variants[i]!;
      const givenTypeVariant = given.type.variants[i]!;

      const expectedTypeVariantElements = expectedTypeVariant.fields ?? [];
      const givenTypeVariantElements = givenTypeVariant.fields ?? [];

      for (let j = 0; j < expectedTypeVariantElements.length; j++) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          { type: expectedTypeVariantElements[j]!.type, env: expected.env },
          { type: givenTypeVariantElements[j]!.type, env: given.env },
          checkedTypePairs,
          options
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }

    // Also synthesize via typeConstructorArgs (needed for GADT enums
    // where variant field types are concrete and don't contain type parameters)
    if (expected.type.typeConstructorArgs && given.type.typeConstructorArgs) {
      const len = Math.min(
        expected.type.typeConstructorArgs.length,
        given.type.typeConstructorArgs.length
      );
      for (let i = 0; i < len; i++) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          { type: expected.type.typeConstructorArgs[i]!, env: expected.env },
          { type: given.type.typeConstructorArgs[i]!, env: given.env },
          checkedTypePairs,
          options
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (isEnumType(expected.type) && isEnumType(given.type)) {
    _synthStats.throws++;
    throw new IncompatibleTypesError(
      () =>
        `Cannot unify incompatible enum types: "${typeToString(
          expected.type
        )}" and "${typeToString(given.type)}"`
    );
  } else if (
    isSourceNamespaceType(expected.type) &&
    isSourceNamespaceType(given.type) &&
    expected.type.functionValue &&
    given.type.functionValue &&
    expected.type.functionValue === given.type.functionValue
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedElement = expected.type.fields[i]!;
      const givenElement = given.type.fields[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv: _expectedEnv, givenEnv: _givenEnv } =
          synthesizeTypes(
            {
              type: expectedElement.assignedValue.value,
              env: expected.env,
            },
            {
              type: givenElement.assignedValue.value,
              env: given.env,
            },
            checkedTypePairs,
            options
          );
        expected.env = _expectedEnv;
        given.env = _givenEnv;
      }
    }
  } else if (
    isTraitType(expected.type) &&
    isTraitType(given.type) &&
    expected.type.functionValue &&
    given.type.functionValue &&
    expected.type.functionValue === given.type.functionValue
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedElement = expected.type.fields[i]!;
      const givenElement = given.type.fields[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv: _expectedEnv, givenEnv: _givenEnv } =
          synthesizeTypes(
            {
              type: expectedElement.assignedValue.value,
              env: expected.env,
            },
            {
              type: givenElement.assignedValue.value,
              env: given.env,
            },
            checkedTypePairs,
            options
          );
        expected.env = _expectedEnv;
        given.env = _givenEnv;
      }
    }
  } else if (isPtrType(expected.type) && isPtrType(given.type)) {
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isIsoType(expected.type) && isIsoType(given.type)) {
    // Synthesize the child types of the Iso types
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Synthesize the element types of the arrays
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;

    // Synthesize the array lengths
    // TODO: Extract this to a separate function?
    if (
      isUnknownValue(expected.type.length) &&
      expected.type.length.variableName &&
      !isUnknownValue(given.type.length)
    ) {
      const expectedLengthVariableName = expected.type.length.variableName;
      const givenLength = given.type.length;
      // Check if the variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expectedLengthVariableName
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        // QUESTION: Will it enter this case?
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expectedLengthVariableName,
            value: [givenLength],
            type: given.type.length.type,
            isCompileTimeOnly: true,
            token: options?.token ?? PlaceholderToken,
            initializedAtToken: options?.token ?? PlaceholderToken,
            consumedAtToken: undefined, // Not consumed yet
            isOwningTheRcValue: false,
          },
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value: [givenLength],
        });
      }
    }
  } else if (
    isComptimeListType(expected.type) &&
    isComptimeListType(given.type)
  ) {
    // Synthesize the element types of the ComptimeLists
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (
    isFutureTraitType(expected.type) &&
    isFutureTraitType(given.type)
  ) {
    // Synthesize the element types of the Futures
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.isFuture.outputType,
        env: expected.env,
      },
      {
        type: given.type.isFuture.outputType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
    synthesizeFutureEffects(
      expected.type.isFuture.effect,
      given.type.isFuture.effect,
      expected,
      given,
      checkedTypePairs,
      options
    );
  } else if (isFnTraitType(expected.type) && isFnTraitType(given.type)) {
    // Synthesize FnTraitType types - match the function types (isFn)
    const expectedFnTrait = expected.type;
    const givenFnTrait = given.type;

    // Synthesize the function types (isFn)
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedFnTrait.isFn.callType,
        env: expected.env,
      },
      {
        type: givenFnTrait.isFn.callType,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (
    isFunctionType(expected.type) &&
    isFunctionType(given.type) &&
    expected.type.forallParameters.length ===
      given.type.forallParameters.length &&
    expected.type.parameters.length === given.type.parameters.length
  ) {
    // Synthesize function types - match parameter types and return types
    const expectedFunction = expected.type;
    const givenFunction = given.type;

    // Synthesize the forall parameter types
    for (let i = 0; i < expectedFunction.forallParameters.length; i++) {
      const expectedForallParam = expectedFunction.forallParameters[i]!;
      const givenForallParam = givenFunction.forallParameters[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedForallParam.type,
          env: expected.env,
        },
        {
          type: givenForallParam.type,
          env: given.env,
        },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the parameter types
    for (let i = 0; i < expectedFunction.parameters.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedFunction.parameters[i]!.type,
          env: expected.env,
        },
        {
          type: givenFunction.parameters[i]!.type,
          env: given.env,
        },
        checkedTypePairs,
        options
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the return types
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedFunction.return.type,
        env: expected.env,
      },
      {
        type: givenFunction.return.type,
        env: given.env,
      },
      checkedTypePairs,
      options
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (
    isTypeHierarchyType(expected.type) &&
    !isTypeHierarchyType(given.type)
  ) {
    // When expected is Type (type hierarchy) and given is a concrete type (struct, enum, etc.),
    // this is valid - a concrete type can be assigned to Type.
    // No synthesis needed, just accept the assignment.
  } else {
    // If we reach here, the types are fundamentally incompatible
    // (different type constructors with no SomeType to unify)
    // Check if they have the same tag as a basic compatibility check
    if (expected.type.tag !== given.type.tag) {
      _synthStats.throws++;
      throw new IncompatibleTypesError(
        () =>
          `Cannot unify incompatible types:
Expected: "${typeToString(expected.type)}"
Given: "${typeToString(given.type)}"`
      );
    }
  }
  return { expectedEnv: expected.env, givenEnv: given.env };
}

/**
 * Synthesize the optional effect bundle between two FutureTraitTypes.
 * Each Future carries at most one effect bundle; when both sides have one
 * and their type ids match, recurse into the bundle types so any forall
 * variables they mention get bound.
 */
function synthesizeFutureEffects(
  expectedEffect: FutureEffect | undefined,
  givenEffect: FutureEffect | undefined,
  expected: { env: Environment },
  given: { env: Environment },
  checkedTypePairs: { expected: Type; given: Type }[],
  options?: SynthesizeTypesOptions
): void {
  if (!expectedEffect || !givenEffect) {
    return;
  }
  // Allow same-id fast-path AND the bind-forall-var case where the
  // expected effect is a SomeType (forall E from an outer signature)
  // and the given effect is a concrete struct. The strict id-equality
  // gate previously blocked binding `E := IoExn` when synthesizing
  // `io.async`'s outer return `Impl(Future(T, E))` against the
  // surrounding function's declared `Impl(Future(i32, IoExn))`.
  if (
    expectedEffect.type.id !== givenEffect.type.id &&
    !isSomeType(expectedEffect.type)
  ) {
    return;
  }
  const { expectedEnv, givenEnv } = synthesizeTypes(
    { type: expectedEffect.type, env: expected.env },
    { type: givenEffect.type, env: given.env },
    checkedTypePairs,
    options
  );
  expected.env = expectedEnv;
  given.env = givenEnv;
}
