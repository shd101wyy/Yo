import { readFileSync } from "node:fs";
import path from "path";
import {
  addVariableToEnv,
  createNewEnv,
  pushEnvFrame,
  setEnvContainingPrelude,
} from "../env";
import { Expr } from "../expr";
import Parser from "../parser";
import { Token } from "../token";
import { isModuleType } from "../types";
import { ModuleValue } from "../value";

// Import extracted evaluator functions
import { YoError } from "../error";
import { LoadModuleFn } from "./context";
import { evaluateAnonymousModuleBeginExprs } from "./values/anonymous_module";
import {
  clearAllGlobalImplState,
  clearGenericImplsFromModule,
  clearImplsFromModule,
} from "./values/module";

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
  private moduleValue: ModuleValue;
  private moduleError: Error | undefined;

  constructor({
    modulePath,
    stdPath,
    loadModule,
    inputString,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: LoadModuleFn;
    inputString?: string;
  }) {
    this.modulePath = modulePath;

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

      // Evaluate the program
      this.evaluateProgram(stdPath, loadModule);
    } catch (error) {
      throw new Error(
        `Failed to import module "${modulePath}":\n${error instanceof YoError ? error.toString() : error instanceof Error ? error.message : String(error)}`
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

    // Auto-import prelude for all modules except prelude.yo itself
    const preludePath = "file://" + path.join(stdPath, "prelude.yo");
    const isPreludeItself = this.modulePath === preludePath;

    if (!isPreludeItself && !SKIP_PRELUDE) {
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
              value: fieldValue,
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
      allowPartialModule: true,
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
