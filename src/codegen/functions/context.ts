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
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: ClosureType; // Current closure type being generated
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
}
