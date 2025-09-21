import { FunctionValue, FuncValueId } from "../../function-value";
import { ClosureType, FunctionType, TypeId } from "../../types";
import { CodeGenContext } from "../utils";

export interface FunctionGenerationContext extends CodeGenContext {
  functions: Record<FuncValueId, { value: FunctionValue; cName: string }>;
  externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string; cInclude?: string }
  >;
  currentFunctionName: string;
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: ClosureType; // Current closure type being generated
}
