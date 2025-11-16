import { Expr } from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  ClosureType,
  FunctionType,
  FutureType,
  StructType,
  TypeId,
} from "../../types";
import { AwaitAnalysisResult, CapturedVariable } from "../async/await-analysis";
import { CodeGenContext } from "../utils";

export interface FunctionGenerationContext extends CodeGenContext {
  functions: Record<FuncValueId, { value: FunctionValue; cName: string }>;
  externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string; cInclude?: string }
  >;
  currentFunctionName: string;
  currentFunctionType?: FunctionType; // Type of the current function being generated
  currentFunctionHasShadowFrame?: boolean; // True if current function has shadow frame for GC roots
  currentShadowFrameRoots?: Map<string, number>; // Variable name -> root index mapping for shadow frame
  currentShadowFrameNextIndex?: number; // Next available index in the roots array
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: ClosureType; // Current closure type being generated
  currentClosureCaptureTypeCName?: string; // C name of the capture struct type (e.g. "yo_struct_abc123_capture")
  // State machine context (when generating code inside async state machine)
  inStateMachine?: { futureType: FutureType }; // Set when generating code inside a state machine, contains the Future type being generated
  stateMachineVariables?: Map<string, CapturedVariable>; // Variables captured in state machine (id -> variable)
  // Deferred async block generation - async blocks are generated after all regular functions
  deferredAsyncBlocks?: Array<{
    bodyExpr: Expr;
    asyncBlockId: string;
    structName: string;
    resumeFunctionName: string;
    constructorName: string;
    disposeFunctionName: string;
    futureType: FutureType;
    futureTypeCName: string;
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
}
