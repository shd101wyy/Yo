import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createStructType } from "../../types/creators";
import { typeToString } from "../../types/utils";
import { isIsoType } from "../../types/guards";
import { createTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateTypeField } from "./field";
import {
  addRcFunctionSignaturesToStructType,
  autoDeriveTraitsAndAddRcFunctionsForStructType,
} from "./utils";
import {
  beginSendDerivation,
  endSendDerivation,
  typeImplementsSend,
} from "../trait-checking";

export function evaluateStructType({
  expr,
  env,
  context,
  isAtomicRc = false,
  forceReferenceSemantics = false,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isAtomicRc?: boolean;
  // `ref(struct(…))` evaluates the inner `struct(…)` literal but with
  // reference semantics forced on (plans/REF_REFERENCE_SEMANTICS.md Phase 2).
  forceReferenceSemantics?: boolean;
}): FnCallExpr {
  const isObjectKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.object);
  const isStructKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.struct);
  const isNewtypeKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.newtype);

  if (!isStructKeyword && !isObjectKeyword && !isNewtypeKeyword) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "struct" or "object" or "newtype", got:\n${exprToString(expr)}`,
    });
  }

  // Reference semantics: the deprecated `object` keyword, or `ref(struct(…))`.
  const isReferenceSemantics = isObjectKeyword || forceReferenceSemantics;
  const isNewtype = isNewtypeKeyword;

  // Create structType with empty fields
  // This is used as the SelfType for the following evaluations.
  const structType = createStructType(
    env,
    isReferenceSemantics,
    isNewtype,
    isAtomicRc
  );
  addRcFunctionSignaturesToStructType({ structType, env, context });

  // Set the definedInModulePath for orphan rule checks.
  // Prefer the lexical token's modulePath (where the `struct(...)` expression
  // appears in source) over context.currentModulePath (which is the caller of
  // a generic-type constructor like `ArrayList(i32)`). Otherwise instantiating
  // a generic in a user file would record the *user* file as the defining
  // module, breaking Phase P field-visibility checks that fire inside the
  // generic's own methods (e.g., array_list.yo's `len()` reading `self._length`).
  const lexicalModulePath = expr.token.modulePath || context.currentModulePath;
  if (lexicalModulePath) {
    structType.definedInModulePath = lexicalModulePath;
    structType.trait.definedInModulePath = lexicalModulePath;
  }

  // For atomic objects, register Send derivation in-progress BEFORE evaluating fields.
  // Self-referential types like `atomic object(_next: Option(Self))` trigger
  // Option enum creation during field evaluation, which checks Send for this type.
  // Without this, the cycle causes Send derivation to fail.
  const needsSendCycleBreak = isAtomicRc;
  if (needsSendCycleBreak) {
    beginSendDerivation(structType.id);
  }

  // Evaluate the fields
  const fields = structType.fields;
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    {
      const { field, env: nextEnv } = evaluateTypeField({
        expr: arg,
        env,
        tupleFieldIndex: i,
        context: { ...context, SelfType: structType },
        forType: "struct",
      });

      // Check if there is duplicate labels
      const duplicateLabel = fields.find((elem) => elem.label === field.label);
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label "${field.label}" in struct`,
        });
      }

      fields.push(field);
      env = nextEnv;
    }
  }

  // Phase H: Ban Arc(Iso(T)) — the `*` field of an atomic object
  // wrapping Iso directly. Arc(Iso) is contradictory: Arc shares, Iso is
  // unique. Transitive nesting (Arc(MyStruct(_inner: Iso(T)))) stays legal.
  if (isAtomicRc) {
    const derefField = fields.find((f) => f.label === "*");
    if (derefField && isIsoType(derefField.type)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Arc(Iso(T)) is not allowed.\n  - Arc is for shared ownership; Iso is for unique ownership. The composition is contradictory.\n  - If you want a "one of many threads races to claim a value" pattern, build a Oneshot(T) primitive on top of Mutex + Option (or wait for std/sync to expose one).`,
      });
    }
  }

  // Check if it's newtype and has only one field
  if (isNewtype && fields.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Newtype struct must have exactly one field, but got ${fields.length} fields.`,
    });
  }

  // Auto-derive all applicable traits (Send, Rc, Acyclic, Comptime, Runtime)
  // and Rc functions if needed
  env = autoDeriveTraitsAndAddRcFunctionsForStructType({
    structType,
    env,
    context,
    errorToken: expr.token,
  });

  // Clear the Send cycle break AFTER auto-derive is complete
  if (needsSendCycleBreak) {
    endSendDerivation(structType.id);
  }

  // Enforce Send for atomic object types.
  // Acyclic is NOT enforced here — self-referential atomic objects are valid
  // (e.g., tree nodes via Option(Self)). Acyclic auto-derivation correctly
  // withholds Acyclic from self-referential types, and cross-type cycles
  // (A→B→C→A) are impossible because Yo evaluates declarations top-down.
  // This check runs AFTER endSendDerivation so the cycle breaker doesn't
  // interfere with the typeImplementsSend check.
  if (isAtomicRc) {
    if (!typeImplementsSend(structType, env)) {
      const nonSendFields = structType.fields
        .filter((field) => !typeImplementsSend(field.type, env))
        .map((field) => `  - ${field.label}: ${typeToString(field.type)}`)
        .join("\n");
      throw formatErrorMessage({
        token: expr.token,
        errorMessage:
          `atomic object must implement Send (all fields must be Send), but ${typeToString(structType)} has non-Send fields:\n` +
          nonSendFields +
          `\nUse "object" instead if thread safety is not needed.`,
      });
    }
  }

  // console.log(typeToString(structType));
  const structTypeValue = createTypeValue(structType);
  expr.$ = {
    env,
    type: structTypeValue.type,
    value: structTypeValue,
    pathCollection: [],
  };

  // Append more information to "struct" token.
  expr.func.$ = expr.$;
  return expr;
}
