import {
  AwaitAnalysisResult,
  CapturedVariable,
} from "../../evaluator/async/await-analysis";
import { Expr } from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  DynType,
  FunctionType,
  SomeType,
  StructType,
  Type,
  TypeId,
} from "../../types";
import { CodeGenContext } from "../utils";

export interface FunctionGenerationContext extends CodeGenContext {
  functions: Record<FuncValueId, { value: FunctionValue; cName: string }>;
  externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string; cInclude?: string }
  >;
  currentFunctionName: string;
  currentFunctionType?: FunctionType; // Type of the current function being generated
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: FunctionType; // Current closure type being generated
  currentClosureCaptureTypeCName?: string; // C name of the capture struct type (e.g. "yo_struct_abc123_capture")
  // State machine context (when generating code inside async state machine)
  // FIXME: OUTDATED, it used to be { futureType: FutureType }
  inStateMachine?: { futureType: SomeType | DynType }; // Set when generating code inside a state machine, contains the Future type being generated
  stateMachineVariables?: Map<string, CapturedVariable>; // Variables captured in state machine (id -> variable)
  // Deferred async block generation - async blocks are generated after all regular functions
  deferredAsyncBlocks?: Array<{
    bodyExpr: Expr;
    asyncBlockId: string;
    structName: string;
    resumeFunctionName: string;
    constructorName: string;
    disposeFunctionName: string;
    futureType: SomeType | DynType;
    futureModuleType: import("../../types").FutureModuleType;
    resultType: Type;
    resultTypeCName: string;
    captureType: StructType | undefined;
    analysis: AwaitAnalysisResult;
  }>;
  // Branch tracking for cond expressions with await
  condBranchInfo?: Map<
    number,
    {
      branches: Array<{
        index: number;
        value: Expr;
        hasAwait: boolean;
        remainingExprs?: Expr[]; // Expressions after the await in this branch
      }>;
      targetVariableId?: string; // Variable that receives the cond result (if any)
    }
  >;
  // Loop tracking for while loops with await
  whileLoopInfo?: Map<
    number,
    {
      conditionExpr: Expr; // The loop condition expression
      bodyExpr: Expr; // The loop body expression
      bodyExprsAfterAwait?: Expr[]; // Expressions after the await in the loop body
    }
  >;
}
