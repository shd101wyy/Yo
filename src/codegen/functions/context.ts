import { FunctionValue, FuncValueId } from "../../function-value";
import { ClosureType, FunctionType, TypeId } from "../../types";
import { CapturedVariable } from "../async/await-analysis";
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
  inStateMachine?: boolean; // True if we're generating code inside a state machine
  stateMachineVariables?: Map<string, CapturedVariable>; // Variables captured in state machine (id -> variable)
}
