import { readFileSync } from "node:fs";
import path from "path";
import {
  addVariableToEnv,
  buildPreludeVarCache,
  createNewEnv,
  pushEnvFrame,
  setEnvContainingPrelude,
  type Environment,
} from "../env";
import type { Expr } from "../expr";
import Parser from "../parser";
import type { Token } from "../token";
import { isSourceNamespaceType } from "../types/guards";
import type { StructValue } from "../value";
import { extractDocComments, getDocCommentLookupKey } from "../doc/extractor";

// Import extracted evaluator functions
import { describeThrown } from "../error";
import { preScanForSkipPrelude } from "./builtins/pragma";
import type { LoadModuleFn } from "./context";
import { evaluateAnonymousModuleBeginExprs } from "./values/anonymous-module";
import {
  clearAllGlobalImplState,
  clearGenericImplsFromModule,
  clearImplsFromModule,
} from "./values/impl";

// Re-export clearImplsFromModule and clearGenericImplsFromModule for use by module manager
export {
  clearAllGlobalImplState,
  clearGenericImplsFromModule,
  clearImplsFromModule,
};

const SKIP_PRELUDE =
  process.env.YO_SKIP_PRELUDE === "1" || process.env.YO_SKIP_PRELUDE === "true";

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private parser: Parser;
  private program: Expr[];
  private tokens: Token[];
  private moduleValue: StructValue | undefined;
  private moduleError: Error | undefined;
  private env: Environment | undefined;
  private allowPartialModule: boolean;
  private registerPartialModule: ((mv: StructValue) => void) | undefined;

  constructor({
    modulePath,
    stdPath,
    loadModule,
    inputString,
    allowPartialModule = false,
    registerPartialModule,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: LoadModuleFn;
    inputString?: string;
    allowPartialModule?: boolean;
    registerPartialModule?: (mv: StructValue) => void;
  }) {
    this.modulePath = modulePath;
    this.allowPartialModule = allowPartialModule;
    this.registerPartialModule = registerPartialModule;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }
    try {
      this.inputString =
        inputString ??
        readFileSync(
          modulePath.replace(/^file:\/\//, ""), // NOTE: We only support local file for now
          "utf-8"
        );

      // Parse the module
      this.parser = new Parser({ modulePath, inputString: this.inputString });
      this.program = this.parser.getProgram();
      this.tokens = this.parser.getTokens();

      // If partial modules are not allowed, throw immediately on parse errors
      if (!this.allowPartialModule && this.parser.getParserError()) {
        throw this.parser.getParserError()!;
      }

      // Evaluate the program
      this.evaluateProgram(stdPath, loadModule);
    } catch (error) {
      throw new Error(
        `Failed to import module "${modulePath}":\n${describeThrown(error)}`
      );
    }
  }

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
  }

  // Add a public method to get the tokens
  public getTokens(): Token[] {
    return this.tokens;
  }

  private evaluateProgram(stdPath: string, loadModule: LoadModuleFn): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });

    // Auto-import prelude unless the file declared
    // `pragma(Pragma.SkipPrelude);` at the top level. This pre-scan
    // runs before the prelude is loaded — by definition, the file
    // doesn't have `Pragma` in scope yet — so we match the call by
    // AST shape. Other pragma variants are validated by full
    // evaluation in `evaluatePragma`. See plans/MEMORY_SAFETY.md.
    const skipPrelude = preScanForSkipPrelude(this.program, this.modulePath);

    if (!skipPrelude && !SKIP_PRELUDE) {
      const preludePath = "file://" + path.join(stdPath, "prelude.yo");
      const { moduleValue: preludeValue, moduleError: preludeError } =
        loadModule(preludePath);

      if (preludeError) {
        // console.error(preludeError);
        throw preludeError;
      }

      // Inject prelude exports into the environment
      if (preludeValue && isSourceNamespaceType(preludeValue.type)) {
        // Push a new frame for prelude exports
        env = pushEnvFrame(env);

        // Add each exported field from prelude to the environment
        for (let i = 0; i < preludeValue.type.fields.length; i++) {
          const field = preludeValue.type.fields[i]!;
          const fieldValue = preludeValue.fields[i];

          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: field.label,
              type: field.type,
              value: fieldValue ? [fieldValue] : undefined,
              isCompileTimeOnly: true,
              initializedAtToken:
                field.exprs.labelExpr?.token ?? field.exprs.expr.token,
              consumedAtToken: undefined,
              token: field.exprs.labelExpr?.token ?? field.exprs.expr.token,
              isOwningTheRcValue: false,
            },
          });
          env = nextEnv;
        }
      }

      setEnvContainingPrelude(env);
    }

    // Build doc comment lookup from token stream before evaluation
    const docExtractionResult = extractDocComments(this.tokens);
    const docCommentLookup = new Map<string, string>();
    for (const assoc of docExtractionResult.declarations) {
      if (assoc.declarationPosition) {
        docCommentLookup.set(
          getDocCommentLookupKey({
            position: assoc.declarationPosition,
            modulePath: assoc.comment.modulePath,
          }),
          assoc.comment.content
        );
      }
    }

    const {
      moduleValue,
      env: nextEnv,
      partialModuleError,
    } = evaluateAnonymousModuleBeginExprs({
      beginExprs: this.program,
      env,
      context: {
        isExecuting: true, // We're executing the main program
        expectedType: undefined,
        SelfType: undefined,
        loadModule: loadModule.bind(this),
        stdPath,
        currentModulePath: this.modulePath,
        docCommentLookup,
      },
      allowPartialModule: this.allowPartialModule,
      registerPartialModule: this.registerPartialModule,
    });
    env = nextEnv;
    this.env = env;
    this.moduleValue = moduleValue;
    this.moduleError = partialModuleError;

    // Build the O(1) prelude variable cache after prelude evaluation.
    if (
      this.modulePath.endsWith("/std/prelude.yo") ||
      this.modulePath.endsWith("/prelude.yo")
    ) {
      buildPreludeVarCache(env);
    }
  }

  public getModuleValue(): StructValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.parser.getParserError() ?? this.moduleError;
  }

  public getEnv(): Environment {
    if (!this.env) {
      throw new Error("Evaluator environment is not set");
    }
    return this.env;
  }
}
