import { readFileSync } from "node:fs";
import path from "path";
import {
  addVariableToEnv,
  createNewEnv,
  pushEnvFrame,
  setEnvContainingPrelude,
} from "../env";
import type { Expr } from "../expr";
import Parser from "../parser";
import { TokenType, type Token } from "../token";
import { isModuleType } from "../types/guards";
import type { ModuleValue } from "../value";

// Import extracted evaluator functions
import { YoError, YoLexerError } from "../error";
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
 * Check if any comment in the tokens contains a specific attribute.
 * This is useful for checking attributes like @skip_prelude, @no-implicit-prelude, etc.
 * In the future, this can be extended to support JSDoc-like attributes.
 */
function hasCommentAttribute(tokens: Token[], attribute: string): boolean {
  return tokens.some(
    (token) =>
      (token.type === TokenType.SingleLineComment ||
        token.type === TokenType.MultiLineComment) &&
      token.value.includes(attribute)
  );
}

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
  private moduleValue: ModuleValue | undefined;
  private moduleError: Error | undefined;
  private allowPartialModule: boolean;
  private registerPartialModule: ((mv: ModuleValue) => void) | undefined;

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
    registerPartialModule?: (mv: ModuleValue) => void;
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
        `Failed to import module "${modulePath}":\n${error instanceof YoError || error instanceof YoLexerError ? error.toString() : error instanceof Error ? error.message : String(error)}`
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

    // Auto-import prelude unless the file has @skip_prelude comment
    const skipPrelude = hasCommentAttribute(this.tokens, "@skip_prelude");

    if (!skipPrelude && !SKIP_PRELUDE) {
      const preludePath = "file://" + path.join(stdPath, "prelude.yo");
      const { moduleValue: preludeValue, moduleError: preludeError } =
        loadModule(preludePath);

      if (preludeError) {
        // console.error(preludeError);
        throw preludeError;
      }

      // Inject prelude exports into the environment
      if (preludeValue && isModuleType(preludeValue.type)) {
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
      },
      allowPartialModule: this.allowPartialModule,
      registerPartialModule: this.registerPartialModule,
    });
    env = nextEnv;
    this.moduleValue = moduleValue;
    this.moduleError = partialModuleError;
  }

  public getModuleValue(): ModuleValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.parser.getParserError() ?? this.moduleError;
  }
}
