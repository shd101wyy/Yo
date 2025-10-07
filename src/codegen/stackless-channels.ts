/**
 * Stackless channel operations
 *
 * This module generates C code for stackless channel send/receive operations.
 * Instead of using setjmp/longjmp, we use continuation-passing style where
 * tasks can suspend and resume via their continuation function.
 */

export function generateStacklessChannelHelpers(): string {
  return `
// Stackless channel helper: suspend current task
static void __yo_task_suspend_on_channel(void* channel) {
  if (!yo_task_current) {
    return; // Not in task context
  }
  
  yo_task_current->state = YO_TASK_SUSPENDED;
  yo_task_current->wait_channel = channel;
  
  CONCURRENCY_DEBUG("[CHAN] Task=%p suspended on channel=%p\\n", yo_task_current, channel);
}

// Stackless channel helper: resume a task from a channel wait queue
static void __yo_task_resume_from_channel(yo_task_t* task) {
  if (!task) {
    return;
  }
  
  task->state = YO_TASK_READY;
  task->wait_channel = NULL;
  
  CONCURRENCY_DEBUG("[CHAN] Resuming task=%p\\n", task);
  
  // Re-enqueue the task to its worker's ready queue
  if (yo_task_current_worker) {
    __yo_task_enqueue_to_worker(yo_task_current_worker, task);
  } else {
    // Fallback: enqueue to first worker
    if (yo_worker_thread_count > 0) {
      __yo_task_enqueue_to_worker(&yo_worker_threads[0], task);
    }
  }
}
`;
}

/**
 * Generate stackless channel send function for a specific channel type.
 *
 * For stackless operation:
 * 1. If receiver is waiting: handoff value and resume receiver
 * 2. If no receiver: return SUSPENDED state and let caller handle state machine
 *
 * The caller (state machine) will check the return value:
 * - If COMPLETED: send succeeded, continue
 * - If SUSPENDED: task was suspended, return from continuation (will be resumed later)
 */
export function generateStacklessChannelSend(
  elementTypeStr: string,
  safeCName: string,
  cName: string
): string {
  return `
// Stackless channel send - returns task state after operation
yo_task_state_t __yo_chan_send_${safeCName}_stackless(${cName}* chan, ${elementTypeStr} value) {
  if (!chan || atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    return YO_TASK_COMPLETED; // Send to closed channel is no-op
  }

  if (!yo_task_scheduler_initialized || !yo_task_current) {
    // Not in task context - fall back to blocking pthread operation
    // TODO: Implement non-task blocking send
    return YO_TASK_COMPLETED;
  }

  // Task context - use stackless suspend/resume
  
#if defined(_WIN32)
  EnterCriticalSection(&chan->mutex);
#else
  pthread_mutex_lock(&chan->mutex);
#endif

  if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
    return YO_TASK_COMPLETED;
  }

  // Check if receiver is waiting
  if (!__yo_chan_wait_queue_empty(chan->recv_queue_head)) {
    // Receiver waiting - direct handoff
    yo_task_t* receiver = __yo_chan_wait_queue_pop(&chan->recv_queue_head, &chan->recv_queue_tail);
    
    // Store value in channel buffer for receiver to pick up
    if (chan->buffer == NULL) {
      chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}));
    }
    chan->buffer[0] = value;
    chan->size = 1;
    
    CONCURRENCY_DEBUG("[CHAN_SEND] Direct handoff to receiver task=%p\\n", receiver);
    
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
    
    // Resume the receiver
    __yo_task_resume_from_channel(receiver);
    
    return YO_TASK_COMPLETED; // Send succeeded
  }
  
  // No receiver waiting - must suspend
  __yo_chan_wait_queue_add(&chan->send_queue_head, &chan->send_queue_tail, yo_task_current);
  
  // Store value in channel buffer for receiver to pick up later
  if (chan->buffer == NULL) {
    chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}));
  }
  chan->buffer[0] = value;
  chan->size = 1;
  
  CONCURRENCY_DEBUG("[CHAN_SEND] No receiver, suspending task=%p\\n", yo_task_current);
  
  __yo_task_suspend_on_channel(chan);
  
#if defined(_WIN32)
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_mutex_unlock(&chan->mutex);
#endif
  
  return YO_TASK_SUSPENDED; // Caller should return from continuation
}

// Wrapper that ignores return value (for compatibility)
void __yo_chan_send_${safeCName}(${cName}* chan, ${elementTypeStr} value) {
  (void)__yo_chan_send_${safeCName}_stackless(chan, value);
}
`;
}

/**
 * Generate stackless channel receive function for a specific channel type.
 *
 * Returns the received value via output parameter and task state as return value.
 */
export function generateStacklessChannelReceive(
  elementTypeStr: string,
  safeCName: string,
  cName: string,
  optionReturnTypeStr: string,
  noneTag: number,
  someTag: number
): string {
  return `
// Stackless channel receive - returns Option(value)
${optionReturnTypeStr} __yo_chan_recv_${safeCName}(${cName}* chan) {
  ${optionReturnTypeStr} result;
  
  if (!chan) {
    result.tag = ${noneTag}; // None
    return result;
  }

  if (!yo_task_scheduler_initialized || !yo_task_current) {
    // Not in task context - fall back to blocking pthread operation
    // TODO: Implement non-task blocking receive
    result.tag = ${noneTag};
    return result;
  }

  // Task context - use stackless suspend/resume
  
#if defined(_WIN32)
  EnterCriticalSection(&chan->mutex);
#else
  pthread_mutex_lock(&chan->mutex);
#endif

  // Check if sender is waiting with value
  if (!__yo_chan_wait_queue_empty(chan->send_queue_head)) {
    // Sender waiting - take value and resume sender
    yo_task_t* sender = __yo_chan_wait_queue_pop(&chan->send_queue_head, &chan->send_queue_tail);
    
    if (chan->size > 0) {
      result.tag = ${someTag}; // Some
      result.value = chan->buffer[0];
      chan->size = 0;
      
      CONCURRENCY_DEBUG("[CHAN_RECV] Got value from sender task=%p\\n", sender);
      
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      
      // Resume the sender
      __yo_task_resume_from_channel(sender);
      
      return result;
    }
  }
  
  // No sender waiting - must suspend
  __yo_chan_wait_queue_add(&chan->recv_queue_head, &chan->recv_queue_tail, yo_task_current);
  
  CONCURRENCY_DEBUG("[CHAN_RECV] No sender, suspending task=%p\\n", yo_task_current);
  
  __yo_task_suspend_on_channel(chan);
  
#if defined(_WIN32)
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_mutex_unlock(&chan->mutex);
#endif
  
  // Suspend: return None for now, will be resumed with value
  // NOTE: This is a problem - we can't return the value after resume!
  // We need state machine transformation to handle this properly.
  result.tag = ${noneTag};
  return result;
}
`;
}
