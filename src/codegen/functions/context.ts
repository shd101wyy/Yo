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
import type { CodeGenContext } from "../utils";
import type { EvidenceParameter } from "./declarations";

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
  // C type strings of every non-unit `unwind(value)` argument in the program,
  // collected by a pre-pass (collectUnwindValueCTypes) before the unwind-value
  // buffer is declared. The buffer is sized (via a union) to fit the largest of
  // these so `unwind` of a value bigger than 64 bytes does not overflow it.
  unwindValueCTypes?: Set<string>;
  currentFunctionType?: FunctionType; // Type of the current function being generated
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: FunctionType; // Current closure type being generated
  currentClosureCaptureTypeCName?: string; // C name of the capture struct type (e.g. "__yo_struct_abc123_capture")
  // Async state machine context (set when generating code inside an async state machine)
  inAsyncStateMachine?: { futureType: SomeType | DynType };
  stateMachineVariables?: Map<string, CapturedVariable>; // Variables captured in state machine (id -> variable)
  // Phase 1b: Maps temp future variable IDs to their aliased await_future_N field names.
  // When set, atom.ts redirects SM variable lookups to the existing await_future field.
  stateMachineFieldAliases?: Map<string, string>;
  inEffectStateMachine?: unknown; // Legacy — no longer used (effects use evidence passing)
  // Set when generating code foran effect record member function (e.g., Exception.throw handler)
  isEffectRecordMemberFunction?: boolean;
  // Evidence parameters for the current function — maps "implicitLabel.fieldLabel"
  // (e.g., "raise_mod.raise") to the C parameter name (e.g., "raise_mod__raise").
  // Set when generating a function body that uses effect-record evidence passing.
  currentEvidenceParams?: Map<string, EvidenceParameter>;
  // Map from continuation variable names to their state machine info.
  // Used when generating handler body inline — resume calls are intercepted
  // and generate SM copy + resume code instead of normal function calls.
  // For direct ctl calls (no SM), the entry carries { directReturnVar } instead.
  // For resume handlers, directExitLabel is also set so nested escape handlers
  // can jump to the end of the enclosing handler's block.
  continuationVariables?: Map<
    string,
    {
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
  // Drops for RC-typed variables consumed by return values (ownership transfer).
  // These are NOT emitted at normal scope exit or return, but ARE emitted when
  // escape propagates through the function (the return value is discarded).
  consumedVarPendingDrops?: Expr[];
  // Deferred async block generation - async blocks are generated after all regular functions
  deferredAsyncBlocks?: Array<{
    bodyExpr: Expr;
    asyncBlockId: string;
    structName: string;
    resumeFunctionName: string;
    constructorName: string;
    disposeFunctionName: string;
    setEffectFunctionName: string;
    futureType: SomeType | DynType;
    futureTraitType: FutureTraitType;
    resultType: Type;
    resultTypeCName: string;
    captureType: StructType | undefined;
    analysis: AwaitAnalysisResult;
    // Closure parameter slots: io.async-shaped closures take a bundle param
    // (e : E). For full-SM closures (with awaits) the param value is supplied
    // at io.await/io.spawn time via set_effect("__bundle", &value) — we store
    // it in a dedicated __yo_param_<i> slot on the SM struct so the resume
    // segments can read it across yield boundaries.
    closureParamSlots?: {
      fieldName: string;
      cType: string;
      paramName: string;
      paramType: Type;
    }[];
  }>;
  // State machine fields that hold match PATTERN BINDINGS. A binding borrows
  // the scrutinee's ownership (its store does not dup), so the escape dispose
  // must not drop it alongside the scrutinee — that would double-decr. Filled
  // by generateMatchWithAwait's binding stores.
  asyncPatternBindingFieldIds?: Set<string>;
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
        // The variable THIS branch binds its own await result to, e.g. the `a`
        // in `.Ok(_) => { a := io.await(f, io); … }`. Several arms collapse onto
        // ONE await point (only one arm runs, so one suspension state suffices),
        // so the await point's single `targetVariableId` can only name one of
        // them — every other arm's binding was left unassigned, reading a
        // zero-initialised field. Recorded per branch and assigned inside that
        // branch's `case`. See issues/fixed/async-await-in-nested-match-arms.md.
        awaitTargetVariableId?: string;
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
      stepExpr?: Expr; // Optional step expression (3-arg while form)
      bodyExpr: Expr; // The loop body expression
      bodyExprsAfterAwait?: Expr[]; // Expressions after the await in the loop body
      // For chained awaits in while loops: the original while loop's await point index.
      // Used so loop-back gotos and active-flag checks reference the correct while loop.
      whileLoopOriginIndex?: number;
      // When true, this entry was created by chaining from a previous await in the same
      // while loop body. The transition code should use whileLoopOriginIndex for the
      // while_loop_N_active guard instead of segment.awaitPoint.index.
      isChainedAwait?: boolean;
      // Set when the loop's suspension point is the CONDITION itself
      // (`while(io.await(f, io), body)`). Unlike a body await, the condition is
      // re-evaluated every iteration, so it cannot be hoisted once before the
      // loop — the state cycle becomes:
      //
      //   state N   : while_start: store the condition's future, suspend
      //   state N+1 : result is live -> if false, leave the loop; otherwise run
      //               body, then step, then jump back to state N, which stores
      //               the future for the NEXT iteration.
      //
      // The body is emitted in state N+1 rather than state N, which is why
      // generateWhileWithAwait skips it when this is set.
      conditionAwait?: boolean;
      // Set when the loop's suspension point is in the STEP (arg 2 of the
      // 3-arg `while(cond, step, body)`). The step runs after the body each
      // iteration, so its await splits the loop in the same place a trailing
      // body await would: everything up to it runs in this state, the rest is
      // `bodyExprsAfterAwait`. The resume state must NOT re-emit the step —
      // it already ran.
      stepAwait?: boolean;
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
        stepExpr?: Expr;
        bodyExpr: Expr;
        bodyExprsAfterAwait: Expr[];
      };
      // Set when this loop handed its remaining body, loop-back and exit label
      // to a nested while-with-await's entry (as that entry's `outerWhileLoop`)
      // because both loops share one await index. The resume state for THIS
      // entry must then emit none of them — the state that finishes the nested
      // loop emits them instead, in the right order.
      deferredToOuterWhileLoop?: boolean;
    }
  >;
  // Counter for allocating unique while loop indices for nested while-with-await.
  // Starts at awaitPoints.length so outer while indices don't collide with await point indices.
  asyncNextWhileLoopIndex?: number;
  // When set, non-await cond branches whose condExpr === this expression should
  // emit async Future completion (store result, drop locals, return). This
  // indicates the cond IS the async block body's implicit return value.
  asyncBodyReturnExpr?: Expr;
  // `io.await` in a position the body cannot be SPLIT at — a `cond`/`if`
  // condition, or a `match` scrutinee. These are evaluated before any branch is
  // chosen, so the await cannot end a state the way a branch-body await does.
  //
  // They are handled by hoisting across the state boundary: the state that
  // reaches the expression stores only the future, and the NEXT state (where
  // `sm->await_result_N` is live) re-emits the whole expression with the await
  // substituted for that result.
  //
  // awaitResultSubstitutions: the `io.await(...)` node -> the C lvalue holding
  // its extracted result. Consulted by generateAwait (codegen/exprs/await.ts),
  // which otherwise emits "" inside a state machine — the empty operand that
  // used to produce `sm->var_N = ;`.
  awaitResultSubstitutions?: Map<Expr, string>;
  // hoistedAwaitExprs: await point index -> the enclosing expression whose
  // emission was deferred to the next state.
  hoistedAwaitExprs?: Map<number, Expr>;
  // Monotonic counter handing out DISTINCT `sm->cond_branch_N` dispatch codes
  // to each awaiting arm of each cond/match in this function. Arm indices alone
  // collide when two matches share one await point's resume switch, which C
  // rejects as a duplicate case value. See allocCondBranchCodes.
  condBranchCaseSeq?: number;
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
  // Temp variable names that have already been declared in the C output.
  // Prevents duplicate declarations when the same sub-expression is traversed
  // multiple times (e.g., begin block dup handling re-generating the last expr).
  declaredTempVars?: Set<string>;
  // Drop code strings for effect handler parameters (e.g., msg: String from ctl yield_value).
  // These are emitted before escape returns to prevent leaking handler params.
  effectHandlerParamDrops?: string[];
  // C variable names of SM arguments whose ownership was transferred to the SM (no dup).
  // For escape handlers, the handler params alias these variables, so handler param drops
  // already free them. Pending deferred drops must skip these to avoid double-free.
  effectSmConsumedArgCNames?: Set<string>;
  // Baseline count of pendingDeferredDrops when entering the current loop body.
  // Used to determine which drops belong to the loop body scope and must be
  // emitted before break/continue (which would otherwise skip end-of-body drops).
  loopBodyDropsBaselineCount?: number;
  // Override C return type string for functions where the declaration uses a
  // body-derived type (e.g., effect record member handlers with SomeType return).
  // Used by escape codegen to emit correct dummy return values.
  overrideReturnTypeStr?: string;
  // Set to true when any io.async, io.await, or io.spawn call is encountered.
  // Used to conditionally emit the async runtime and event loop in main().
  usesAsync?: boolean;
  // Set to true when any __yo_thread_spawn or __yo_worker_spawn call is found.
  // Used to conditionally emit the parallelism runtime (thread pool, worker spawn).
  usesParallelism?: boolean;
}
