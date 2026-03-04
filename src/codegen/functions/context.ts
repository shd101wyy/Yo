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
  // Async state machine context (set when generating code inside an async state machine)
  inAsyncStateMachine?: { futureType: SomeType | DynType };
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
  // For resume handlers, directExitLabel is also set so nested escape handlers
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
  asyncCondBranchInfo?: Map<
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
  asyncWhileLoopInfo?: Map<
    number,
    {
      conditionExpr: Expr; // The loop condition expression
      bodyExpr: Expr; // The loop body expression
      bodyExprsAfterAwait?: Expr[]; // Expressions after the await in the loop body
      // Expressions from an enclosing cond branch that come after this while loop.
      // These should only be executed after the while loop exits, not on every resume.
      condBranchPostWhileExprs?: {
        branchIndex: number;
        condBranchFieldIndex: number;
        exprs: Expr[];
        deferredDropExpressions?: Expr[];
        // When true, skip the sm->cond_branch_N guard check. This is needed when
        // nested conds share the same cond_branch_N field — the innermost cond's
        // write overwrites the outer cond's value, making the guard always fail.
        skipCondBranchCheck?: boolean;
      };
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
  asyncNextWhileLoopIndex?: number;
  // Variables that are locally shadowed (e.g., in match destructuring patterns)
  // When a variable name is in this set, use the local C variable instead of sm->var_...
  localShadowedVariables?: Set<string>;
  // When generating while loop body inside a state machine (async or effect),
  // these hold the labels/info needed for break/continue to correctly exit via goto
  // (plain "break"/"continue" don't work inside a switch or goto-based loop).
  smWhileBreakInfo?: { label: string; activeIndex?: number };
  smWhileContinueInfo?: {
    label: string;
    emitDropsBeforeGoto?: boolean;
    stepExpr?: Expr;
  };
  // Deferred drops for the while loop body's local variables.
  // These must be emitted before break/continue/normal-exit in state machine while loop code.
  smWhileBodyDrops?: Expr[];
  // Variable names whose drops were already emitted inside short-circuit conditional branches.
  // Used to prevent the enclosing begin block from double-emitting drops for variables
  // that are only conditionally created inside || or && if-chains.
  shortCircuitHandledDropVarNames?: Set<string>;
  // Drop code strings for effect handler parameters (e.g., msg: String from ctl yield_value).
  // These are emitted before escape returns to prevent leaking handler params.
  effectHandlerParamDrops?: string[];
  // C variable names of SM arguments whose ownership was transferred to the SM (no dup).
  // For escape handlers, the handler params alias these variables, so handler param drops
  // already free them. Pending deferred drops must skip these to avoid double-free.
  effectSmConsumedArgCNames?: Set<string>;
  // When generating an effect call inside a while loop's body,
  // this stores the goto label and step expression so that
  // generateTransitiveEffectYield can emit step + goto instead of completed=1.
  effectWhileLoopContinuation?: {
    label: string;
    stepExpr: Expr | undefined;
    whileDoneLabel: string;
    remainingExprs: Expr[];
    bodyDropExprs: Expr[];
  };
  // Baseline count of pendingDeferredDrops when entering the current loop body.
  // Used to determine which drops belong to the loop body scope and must be
  // emitted before break/continue (which would otherwise skip end-of-body drops).
  loopBodyDropsBaselineCount?: number;
}
