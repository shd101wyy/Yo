import type {
  AwaitAnalysisResult,
  CapturedVariable,
} from "../../evaluator/async/await-analysis";
import type { Expr } from "../../expr";
import type { FunctionValue, FuncValueId } from "../../function-value";
import type {
  DynType,
  FunctionType,
  FutureTraitType,
  SomeType,
  StructType,
  Type,
  TypeId,
} from "../../types/definitions";
import type { EffectStateMachineInfo } from "../effects/effect-state-machine";
import type { CodeGenContext } from "../utils";

export interface FunctionGenerationContext extends CodeGenContext {
  functions: Record<
    FuncValueId,
    {
      value: FunctionValue;
      cName: string;
      effectStateMachineInfo?: unknown;
    }
  >;
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
  // Effect state machine context (when generating code inside an effectful function's state machine)
  inEffectStateMachine?: EffectStateMachineInfo; // Set when generating code inside an effect state machine
  // Deferred effectful function generation - effectful functions are generated after regular functions
  deferredEffectfulFunctions?: Array<{
    functionValue: FunctionValue;
    cFunctionName: string;
    info: EffectStateMachineInfo;
  }>;
  // Map from continuation variable names to their state machine info.
  // Used when generating handler body inline — resume calls are intercepted
  // and generate SM copy + resume code instead of normal function calls.
  // For direct ctl calls (no SM), the entry carries { directReturnVar } instead.
  // For resume handlers, directExitLabel is also set so nested abort handlers
  // can jump to the end of the enclosing handler's block.
  continuationVariables?: Map<
    string,
    | { smVar: string; smInfo: EffectStateMachineInfo; effectIndex?: number }
    | {
        directReturnVar: string;
        directExitLabel?: string;
        isUnitReturn?: boolean;
      }
  >;
  // Maps SSA-renamed variable IDs to their original/canonical IDs.
  // Used to resolve all versions of a reassigned variable to the same struct field in loops.
  variableIdRemapping?: Map<string, string>;
  // Pending deferred drops from enclosing begin blocks that need to run before async completion
  // This is used to ensure local variables are dropped when an async function completes
  // from within a nested expression (e.g., a cond branch that returns early)
  pendingDeferredDrops?: Expr[];
  // Deferred async block generation - async blocks are generated after all regular functions
  deferredAsyncBlocks?: Array<{
    bodyExpr: Expr;
    asyncBlockId: string;
    structName: string;
    resumeFunctionName: string;
    constructorName: string;
    disposeFunctionName: string;
    futureType: SomeType | DynType;
    futureModuleType: FutureTraitType;
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
        deferredDropExpressions?: Expr[]; // Drop expressions for the branch's begin block
      }>;
      targetVariableId?: string; // Variable that receives the cond result (if any)
      targetAssignmentCode?: string; // C code for the assignment target (for `= (target, cond/match(...))`)
      condBranchFieldIndex?: number; // The cond_branch_X index to use in the switch (for continuation states)
      // When a nested cond stores its continuation at the same key as an outer cond's remaining code,
      // the outer code goes into chainedBranches (processed as a separate switch AFTER the nested cond's switch)
      chainedBranches?: Array<{
        branches: Array<{
          index: number;
          value: Expr;
          hasAwait: boolean;
          remainingExprs?: Expr[];
          deferredDropExpressions?: Expr[];
        }>;
        condBranchFieldIndex: number;
      }>;
    }
  >;
  // Loop tracking for while loops with await
  whileLoopInfo?: Map<
    number,
    {
      conditionExpr: Expr; // The loop condition expression
      bodyExpr: Expr; // The loop body expression
      bodyExprsAfterAwait?: Expr[]; // Expressions after the await in the loop body
      outerWhileLoop?: {
        whileLoopIndex: number;
        conditionExpr: Expr;
        bodyExpr: Expr;
        bodyExprsAfterAwait: Expr[];
      };
    }
  >;
  // Counter for allocating unique while loop indices for nested while-with-await.
  // Starts at awaitPoints.length so outer while indices don't collide with await point indices.
  nextWhileLoopIndex?: number;
  // Variables that are locally shadowed (e.g., in match destructuring patterns)
  // When a variable name is in this set, use the local C variable instead of sm->var_...
  localShadowedVariables?: Set<string>;
  // When generating async while loop resume body, this holds the label and index
  // needed for break to correctly exit the state machine's switch and jump to after-loop code
  asyncWhileBreakInfo?: { label: string; index: number };
  // When generating async while loop resume body, this holds the label
  // needed for continue to skip remaining body and jump to condition re-evaluation
  asyncWhileContinueInfo?: { label: string; emitDropsBeforeGoto?: boolean };
  // Deferred drops for the while loop body's local variables.
  // These must be emitted before break/continue/normal-exit in async while loop resume code.
  asyncWhileBodyDrops?: Expr[];
  // Drop code strings for effect handler parameters (e.g., msg: String from ctl yield_value).
  // These are emitted before abort returns to prevent leaking handler params.
  effectHandlerParamDrops?: string[];
  // C variable names of SM arguments whose ownership was transferred to the SM (no dup).
  // For abort handlers, the handler params alias these variables, so handler param drops
  // already free them. Pending deferred drops must skip these to avoid double-free.
  effectSmConsumedArgCNames?: Set<string>;
  // Baseline count of pendingDeferredDrops when entering the current loop body.
  // Used to determine which drops belong to the loop body scope and must be
  // emitted before break/continue (which would otherwise skip end-of-body drops).
  loopBodyDropsBaselineCount?: number;
}
