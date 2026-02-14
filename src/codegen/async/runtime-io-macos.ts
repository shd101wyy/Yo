/**
 * runtime-io-macos.ts
 *
 * macOS async I/O via Grand Central Dispatch (dispatch_io).
 * Provides async read, write, openat, close, statx, mkdir, unlink,
 * rename, symlink, link, fsync, fdatasync, ftruncate, chmod, chown,
 * readlink, dup, pipe, and socket operations.
 */

import { Emitter } from "../../emitter";

export function generateAsyncRuntimeIOMacOS(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// Async I/O Runtime (macOS - dispatch_io via Grand Central Dispatch)
// ============================================================================

#if defined(__APPLE__)
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <errno.h>
#include <pthread.h>

// Global dispatch queue for I/O completions
static dispatch_queue_t __yo_io_queue = NULL;
static bool __yo_io_initialized = false;
static _Atomic size_t __yo_pending_io_count = 0;

// Semaphore for blocking wait
static dispatch_semaphore_t __yo_io_semaphore = NULL;

// Cross-thread continuation queue (dispatch callbacks run on GCD threads)
typedef struct yo_io_continuation_t {
  void (*resume_fn)(void*);
  void* state_machine;
  struct yo_io_continuation_t* next;
} yo_io_continuation_t;

static pthread_mutex_t __yo_io_ready_mutex = PTHREAD_MUTEX_INITIALIZER;
static yo_io_continuation_t* __yo_io_ready_head = NULL;
static yo_io_continuation_t* __yo_io_ready_tail = NULL;

// Initialize dispatch_io subsystem
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  // Create a serial queue for I/O completions to ensure thread safety
  __yo_io_queue = dispatch_queue_create("yo.io.completion", DISPATCH_QUEUE_SERIAL);
  __yo_io_semaphore = dispatch_semaphore_create(0);
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] dispatch_io initialized\\n");
}

// Cleanup dispatch_io
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  
  // Wait for pending I/O to complete
  while (atomic_load(&__yo_pending_io_count) > 0) {
    dispatch_semaphore_wait(__yo_io_semaphore, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
  }
  
  // Note: ARC manages dispatch objects in modern macOS, but we use manual retain/release for C code
  // dispatch_release(__yo_io_queue);  // Commented out - let it leak on cleanup for simplicity
  __yo_io_initialized = false;
  ASYNC_DEBUG("[IO] dispatch_io cleaned up\\n");
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return atomic_load(&__yo_pending_io_count) > 0 || __yo_active_watch_count > 0;
}

// Forward declaration for poll/fs_event tick (defined in runtime-io-common)
static int __yo_poll_and_fs_event_tick(void);

// Process completions - on macOS, GCD handles this automatically via callback
// This function processes any completions that have been queued
static int __yo_io_poll(void) {
  // dispatch_io delivers completions on GCD threads.
  // Drain cross-thread ready continuations and enqueue to event-loop thread.
  yo_io_continuation_t* local_head = NULL;
  yo_io_continuation_t* local_tail = NULL;

  pthread_mutex_lock(&__yo_io_ready_mutex);
  local_head = __yo_io_ready_head;
  local_tail = __yo_io_ready_tail;
  __yo_io_ready_head = NULL;
  __yo_io_ready_tail = NULL;
  pthread_mutex_unlock(&__yo_io_ready_mutex);

  int count = 0;
  yo_io_continuation_t* node = local_head;
  while (node) {
    yo_io_continuation_t* next = node->next;
    yo_async_spawn_task(node->resume_fn, node->state_machine);
    __yo_free(node);
    count++;
    node = next;
  }

  if (count > 0) {
    ASYNC_DEBUG("[IO] Polled %d completions from GCD threads\\n", count);
  }
  
  // Also tick poll/fs_event handles
  count += __yo_poll_and_fs_event_tick();
  
  return count;
}

// Wait for at least one I/O completion
static int __yo_io_wait(void) {
  if (atomic_load(&__yo_pending_io_count) == 0 && __yo_active_watch_count > 0) {
    // Only watches pending, use short sleep then tick
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC);
    dispatch_semaphore_wait(__yo_io_semaphore, timeout);
    return __yo_poll_and_fs_event_tick();
  }
  if (atomic_load(&__yo_pending_io_count) == 0) return 0;
  
  // Wait on semaphore with timeout
  dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC);
  dispatch_semaphore_wait(__yo_io_semaphore, timeout);
  return 1;
}

// Helper to wake continuation from I/O completion
static void __yo_io_wake_continuation(yo_io_future_t* future) {
  // Mark as completed
  atomic_store_explicit(&future->state, -1, memory_order_release);
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);
  
  ASYNC_DEBUG("[IO] Waking continuation: cont_fn=%p, cont_sm=%p, result=%d\\n",
              (void*)cont_fn, cont_sm, future->result);
  
  if (cont_fn && cont_sm) {
    yo_io_continuation_t* node = (yo_io_continuation_t*)__yo_malloc(sizeof(yo_io_continuation_t));
    node->resume_fn = cont_fn;
    node->state_machine = cont_sm;
    node->next = NULL;

    pthread_mutex_lock(&__yo_io_ready_mutex);
    if (__yo_io_ready_tail) {
      __yo_io_ready_tail->next = node;
      __yo_io_ready_tail = node;
    } else {
      __yo_io_ready_head = node;
      __yo_io_ready_tail = node;
    }
    pthread_mutex_unlock(&__yo_io_ready_mutex);
  }
  
  // Signal semaphore for waiting threads
  dispatch_semaphore_signal(__yo_io_semaphore);
  
  // Decrement pending count
  atomic_fetch_sub(&__yo_pending_io_count, 1);
}

// Create and start an async read operation using dispatch_io
static yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  // Use random I/O only for seekable regular/block files.
  // Pipes/sockets/ttys must use stream mode or writes/reads fail with ESPIPE.
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)dup(fd);
  if (dispatch_fd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to dup fd for read: fd=%d errno=%d\\n", fd, errno);
    return future;
  }
  struct stat st;
  bool use_random = false;
  if (fstat(fd, &st) == 0) {
    use_random = S_ISREG(st.st_mode) || S_ISBLK(st.st_mode);
  }
  dispatch_io_type_t io_type = use_random ? DISPATCH_IO_RANDOM : DISPATCH_IO_STREAM;
  
  dispatch_io_t channel = dispatch_io_create(io_type, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\\n", error);
    }
  });
  
  if (!channel) {
    close((int)dispatch_fd);
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to create dispatch_io channel: %d\\n", errno);
    return future;
  }

  // Ensure callbacks deliver data promptly
  dispatch_io_set_low_water(channel, 1);
  dispatch_io_set_high_water(channel, (size_t)size);
  
  // Capture buffer pointer for the block
  void* buf = buffer;
  yo_io_future_t* fut = future;
  uint32_t sz = size;
  __block size_t total = 0;
  __block bool completed = false;
  off_t read_offset = use_random ? (off_t)offset : 0;
  
  dispatch_io_read(channel, read_offset, (size_t)size, __yo_io_queue,
    ^(bool done, dispatch_data_t data, int error) {
      if (completed) {
        return;
      }
      if (error) {
        fut->result = -error;
        if (done || !use_random) {
          completed = true;
          dispatch_io_close(channel, DISPATCH_IO_STOP);
          __yo_io_wake_continuation(fut);
        }
        return;
      }
      
      if (data) {
        // Copy data to buffer (respect region offsets)
        dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t region_offset, const void* region_buffer, size_t region_size) {
          (void)region;
          size_t to_copy = region_size;
          if (region_offset >= sz) {
            return false;
          }
          if (region_offset + to_copy > sz) {
            to_copy = sz - region_offset;
          }
          if (to_copy > 0) {
            memcpy((char*)buf + region_offset, region_buffer, to_copy);
            size_t end = region_offset + to_copy;
            if (end > total) {
              total = end;
            }
          }
          return true;
        });
      }

      // For stream descriptors (pipes/sockets/ttys), complete as soon as any data arrives,
      // matching read(2) semantics for "up to size" bytes.
      if (!use_random && total > 0) {
        completed = true;
        fut->result = (int32_t)total;
        dispatch_io_close(channel, DISPATCH_IO_STOP);
        ASYNC_DEBUG("[IO] Stream read completed: %d bytes\\n", fut->result);
        __yo_io_wake_continuation(fut);
        return;
      }
      
      if (done) {
        completed = true;
        fut->result = (int32_t)total;
        dispatch_io_close(channel, 0);
        ASYNC_DEBUG("[IO] Read completed: %d bytes\\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, buffer, size, (unsigned long long)offset, atomic_load(&__yo_pending_io_count));
  
  return future;
}

// Create and start an async write operation
static yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)dup(fd);
  if (dispatch_fd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to dup fd for write: fd=%d errno=%d\\n", fd, errno);
    return future;
  }
  struct stat st;
  bool use_random = false;
  if (fstat(fd, &st) == 0) {
    use_random = S_ISREG(st.st_mode) || S_ISBLK(st.st_mode);
  }
  dispatch_io_type_t io_type = use_random ? DISPATCH_IO_RANDOM : DISPATCH_IO_STREAM;
  
  dispatch_io_t channel = dispatch_io_create(io_type, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\\n", error);
    }
  });
  
  if (!channel) {
    close((int)dispatch_fd);
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    return future;
  }
  
  // Create dispatch_data from buffer
  dispatch_data_t data = dispatch_data_create(buffer, size, __yo_io_queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
  
  yo_io_future_t* fut = future;
  off_t write_offset = use_random ? (off_t)offset : 0;
  
  dispatch_io_write(channel, write_offset, data, __yo_io_queue,
    ^(bool done, dispatch_data_t remaining, int error) {
      if (error) {
        fut->result = -error;
        if (done) {
          dispatch_io_close(channel, DISPATCH_IO_STOP);
          __yo_io_wake_continuation(fut);
        }
        return;
      }
      
      if (done) {
        fut->result = (int32_t)size;  // All bytes written
        dispatch_io_close(channel, 0);
        ASYNC_DEBUG("[IO] Write completed: %d bytes\\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  // dispatch_data is retained by the write operation
  dispatch_release(data);
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, (void*)buffer, size, (unsigned long long)offset, atomic_load(&__yo_pending_io_count));
  
  return future;
}

// Async openat - on macOS we use synchronous open wrapped in an immediately-completed future
// because dispatch_io requires an already-open fd
static yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Perform synchronous open
  int fd;
  if (dirfd == -100) {  // AT_FDCWD
    fd = open(path, flags, mode);
  } else {
    fd = openat(dirfd, path, flags, mode);
  }
  
  if (fd < 0) {
    future->result = -errno;
  } else {
    future->result = fd;
  }
  
  // Mark as immediately completed
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] openat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async close
static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = close(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] close completed: fd=%d result=%d\\n", fd, future->result);
  
  return future;
}

// Async stat - uses synchronous fstatat on macOS
static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();
  (void)mask;  // Unused on macOS
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // On macOS, we use fstatat instead of statx
  // The statxbuf is actually a struct stat on macOS
  int at_flags = 0;
  if (flags & 0x100) {  // AT_SYMLINK_NOFOLLOW
    at_flags |= AT_SYMLINK_NOFOLLOW;
  }
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    if (at_flags & AT_SYMLINK_NOFOLLOW) {
      result = lstat(path, (struct stat*)statxbuf);
    } else {
      result = stat(path, (struct stat*)statxbuf);
    }
  } else {
    result = fstatat(dirfd, path, (struct stat*)statxbuf, at_flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] stat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async mkdirat
static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {
    result = mkdir(path, (mode_t)mode);
  } else {
    result = mkdirat(dirfd, path, (mode_t)mode);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] mkdirat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async unlinkat
static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {
    if (flags & 0x80) {  // AT_REMOVEDIR (macOS value)
      result = rmdir(path);
    } else {
      result = unlink(path);
    }
  } else {
    result = unlinkat(dirfd, path, flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] unlinkat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async renameat
static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (olddirfd == -100 && newdirfd == -100) {
    result = rename(oldpath, newpath);
  } else {
    result = renameat(olddirfd, oldpath, newdirfd, newpath);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] renameat completed: %s -> %s result=%d\\n", oldpath, newpath, future->result);
  
  return future;
}

// Async symlinkat
static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (newdirfd == -100) {
    result = symlink(target, linkpath);
  } else {
    result = symlinkat(target, newdirfd, linkpath);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] symlinkat completed: %s -> %s result=%d\\n", target, linkpath, future->result);
  
  return future;
}

// Async linkat
static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (olddirfd == -100 && newdirfd == -100) {
    result = link(oldpath, newpath);
  } else {
    result = linkat(olddirfd, oldpath, newdirfd, newpath, flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] linkat completed: %s -> %s result=%d\\n", oldpath, newpath, future->result);
  
  return future;
}

// Async fsync
static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fsync(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fsync completed: fd=%d result=%d\\n", fd, future->result);
  
  return future;
}

// Async fdatasync - macOS doesn't have fdatasync, use fsync
static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  // macOS: fdatasync is not available, fall back to fsync
  // F_FULLFSYNC is even stronger than fsync on macOS
  return __yo_async_fsync_start(fd);
}

// Async ftruncate
static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = ftruncate(fd, (off_t)length);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] ftruncate completed: fd=%d length=%lld result=%d\\n",
              fd, (long long)length, future->result);
  
  return future;
}

// ============================================================================
// Permission Operations (macOS)
// ============================================================================

// Async fchmod - change file permissions by fd
static yo_io_future_t* __yo_async_fchmod_start(int32_t fd, uint32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchmod(fd, (mode_t)mode);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmod completed: fd=%d mode=0%o result=%d\\n", fd, mode, future->result);
  
  return future;
}

// Async fchmodat - change file permissions by path
static yo_io_future_t* __yo_async_fchmodat_start(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = chmod(path, (mode_t)mode);
  } else {
    result = fchmodat(dirfd, path, (mode_t)mode, flags);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmodat completed: path=%s mode=0%o result=%d\\n", path, mode, future->result);
  
  return future;
}

// Async fchown - change file ownership by fd
static yo_io_future_t* __yo_async_fchown_start(int32_t fd, uint32_t uid, uint32_t gid) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchown completed: fd=%d uid=%u gid=%u result=%d\\n", fd, uid, gid, future->result);
  
  return future;
}

// Async fchownat - change file ownership by path
static yo_io_future_t* __yo_async_fchownat_start(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    if (flags & 0x100) {  // AT_SYMLINK_NOFOLLOW
      result = lchown(path, (uid_t)uid, (gid_t)gid);
    } else {
      result = chown(path, (uid_t)uid, (gid_t)gid);
    }
  } else {
    result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchownat completed: path=%s uid=%u gid=%u result=%d\\n", path, uid, gid, future->result);
  
  return future;
}

// ============================================================================
// Symbolic Link Operations (macOS)
// ============================================================================

// Async readlinkat - read symbolic link target
static yo_io_future_t* __yo_async_readlinkat_start(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  ssize_t result;
  if (dirfd == -100) {  // AT_FDCWD
    result = readlink(path, buf, bufsize);
  } else {
    result = readlinkat(dirfd, path, buf, bufsize);
  }
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] readlinkat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// ============================================================================
// File Descriptor Operations (macOS)
// ============================================================================

// Async dup - duplicate file descriptor
static yo_io_future_t* __yo_async_dup_start(int32_t oldfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup(oldfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup completed: oldfd=%d result=%d\\n", oldfd, future->result);
  
  return future;
}

// Async dup2 - duplicate file descriptor to specific fd
static yo_io_future_t* __yo_async_dup2_start(int32_t oldfd, int32_t newfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup2(oldfd, newfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup2 completed: oldfd=%d newfd=%d result=%d\\n", oldfd, newfd, future->result);
  
  return future;
}

// Async pipe - create pipe
static yo_io_future_t* __yo_async_pipe_start(int32_t* pipefd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = pipe((int*)pipefd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] pipe completed: result=%d readfd=%d writefd=%d\\n",
              future->result, pipefd[0], pipefd[1]);
  
  return future;
}

// ============================================================================
// Synchronous FD Operations (macOS) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = pipe((int*)pipefd);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = dup2(oldfd, newfd);
  return (result < 0) ? -errno : result;
}

static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  off_t result = lseek(fd, (off_t)offset, whence);
  return (result < 0) ? (int64_t)(-errno) : (int64_t)result;
}

static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  if (offset < 0 || length < 0) return -EINVAL;

  fstore_t store;
  memset(&store, 0, sizeof(store));
  store.fst_flags = F_ALLOCATECONTIG;
  store.fst_posmode = F_VOLPOSMODE;
  store.fst_offset = (off_t)offset;
  store.fst_length = (off_t)length;

  int result = fcntl(fd, F_PREALLOCATE, &store);
  if (result < 0) {
    store.fst_flags = F_ALLOCATEALL;
    result = fcntl(fd, F_PREALLOCATE, &store);
  }
  if (result < 0) return -errno;

  // FALLOC_FL_KEEP_SIZE = 0x01
  if ((mode & 0x01) == 0) {
    off_t target = (off_t)(offset + length);
    struct stat st;
    if (fstat(fd, &st) < 0) return -errno;
    if (st.st_size < target) {
      if (ftruncate(fd, target) < 0) return -errno;
    }
  }

  return 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  int result = fcntl(fd, F_GETFL, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFL, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  int result = fcntl(fd, F_GETFD, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFD, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_flock(int32_t fd, int32_t operation) {
  int result = flock(fd, operation);
  return (result < 0) ? -errno : 0;
}

static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  void* result = mmap((void*)addr, length, prot, flags, fd, (off_t)offset);
  if (result == MAP_FAILED) {
    return (uint8_t*)(intptr_t)(-errno);
  }
  return (uint8_t*)result;
}

static bool __yo_sync_mmap_is_error(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  return (value < 0) && (value >= -65535);
}

static int32_t __yo_sync_mmap_errno(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  if ((value < 0) && (value >= -65535)) {
    return (int32_t)(-value);
  }
  return 0;
}

static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) {
  int result = munmap((void*)addr, length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) {
  int result = mprotect((void*)addr, length, prot);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) {
  int result = msync((void*)addr, length, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  int result = fchmod(fd, (mode_t)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  int result;
  if (dirfd == -100) {
    result = chmod(path, (mode_t)mode);
  } else {
    result = fchmodat(dirfd, path, (mode_t)mode, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result;
  if (dirfd == -100) {
    if (flags & 0x100) {
      result = lchown(path, (uid_t)uid, (gid_t)gid);
    } else {
      result = chown(path, (uid_t)uid, (gid_t)gid);
    }
  } else {
    result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result;
  if (dirfd == -100) {
    result = readlink(path, buf, bufsize);
  } else {
    result = readlinkat(dirfd, path, buf, bufsize);
  }
  return (result < 0) ? -errno : (int32_t)result;
}

// ============================================================================
// Socket Operations (macOS)
// ============================================================================
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// Async socket - create socket (non-blocking for async dispatch_source operations)
static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = socket(domain, type, protocol);
  if (result >= 0) {
    int flags = fcntl(result, F_GETFL, 0);
    if (flags >= 0) fcntl(result, F_SETFL, flags | O_NONBLOCK);
  }
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\\n",
              domain, type, protocol, future->result);
  
  return future;
}

// Async bind - bind socket to address
static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = bind(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async listen - mark socket as listening
static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = listen(sockfd, backlog);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection using dispatch_source for true async
static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking accept first
  int result = accept(sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen);
  if (result >= 0) {
    // Set accepted socket to non-blocking too
    int fl = fcntl(result, F_GETFL, 0);
    if (fl >= 0) fcntl(result, F_SETFL, fl | O_NONBLOCK);
    future->result = result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] accept completed immediately: sockfd=%d result=%d\\n", sockfd, result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] accept failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // Socket not ready — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* a = addr;
  uint32_t* al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    int r = accept(sfd, (struct sockaddr*)a, (socklen_t*)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    if (r >= 0) {
      int fl = fcntl(r, F_GETFL, 0);
      if (fl >= 0) fcntl(r, F_SETFL, fl | O_NONBLOCK);
      fut->result = r;
    } else {
      fut->result = -errno;
    }
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] accept completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] accept waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async connect - connect to remote address using dispatch_source for true async
static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking connect
  int result = connect(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  if (result == 0) {
    future->result = 0;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] connect completed immediately: sockfd=%d\\n", sockfd);
    return future;
  }
  
  if (errno != EINPROGRESS) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] connect failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // Connection in progress — wait for writable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    int so_error = 0;
    socklen_t len = sizeof(so_error);
    getsockopt(sfd, SOL_SOCKET, SO_ERROR, &so_error, &len);
    fut->result = (so_error == 0) ? 0 : -so_error;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] connect completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] connect waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async send - send data on socket using dispatch_source for true async
static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking send first
  ssize_t result = send(sockfd, buf, len, flags);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] send completed immediately: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] send failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // Socket not writable — wait via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  const void* b = buf;
  size_t l = len;
  int32_t f = flags;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = send(sfd, b, l, f);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] send completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] send waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async recv - receive data from socket using dispatch_source for true async
static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking recv first
  ssize_t result = recv(sockfd, buf, len, flags);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recv completed immediately: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recv failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // No data available — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* b = buf;
  size_t l = len;
  int32_t f = flags;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = recv(sfd, b, l, f);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] recv completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] recv waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async sendto - send data to specific address (UDP) using dispatch_source for true async
static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking sendto first
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] sendto completed immediately: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] sendto failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // Socket not writable — wait via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  const void* b = buf;
  size_t l = len;
  int32_t f = flags;
  const void* da = dest_addr;
  uint32_t al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = sendto(sfd, b, l, f, (const struct sockaddr*)da, (socklen_t)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] sendto completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] sendto waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async recvfrom - receive data with source address (UDP) using dispatch_source for true async
static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking recvfrom first
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recvfrom completed immediately: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recvfrom failed: sockfd=%d errno=%d\\n", sockfd, errno);
    return future;
  }
  
  // No data available — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* b = buf;
  size_t l = len;
  int32_t f = flags;
  void* sa = src_addr;
  uint32_t* al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = recvfrom(sfd, b, l, f, (struct sockaddr*)sa, (socklen_t*)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] recvfrom completed via dispatch: sockfd=%d result=%d\\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] recvfrom waiting via dispatch_source: sockfd=%d\\n", sockfd);
  return future;
}

// Async shutdown - shutdown socket
static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = shutdown(sockfd, how);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\\n", sockfd, how, future->result);
  
  return future;
}

// Async setsockopt - set socket option
static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Async getsockopt - get socket option
static yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    void* optval, uint32_t* optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = getsockopt(sockfd, level, optname, optval, (socklen_t*)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Sync getsockname - get local socket address
static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getsockname(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync getpeername - get remote peer address
static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getpeername(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync setsockopt - set socket option value
static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     const void* optval, uint32_t optlen) {
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  return (result < 0) ? -errno : 0;
}

// Sync getsockopt - get socket option value
static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     void* optval, uint32_t* optlen) {
  socklen_t len = (socklen_t)(*optlen);
  int result = getsockopt(sockfd, level, optname, optval, &len);
  if (result < 0) {
    return -errno;
  }
  *optlen = (uint32_t)len;
  return 0;
}

// Sync socketpair - create a connected socket pair
static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  int result = socketpair(domain, sock_type, protocol, (int*)sv);
  return (result < 0) ? -errno : 0;
}

// ============================================================================
// Socket Address Helpers (macOS)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return sizeof(struct sockaddr_un);
}

static size_t __yo_sockaddr_storage_size(void) {
  return sizeof(struct sockaddr_storage);
}

static void __yo_sockaddr_set_family(void* addr, uint16_t family) {
  ((struct sockaddr*)addr)->sa_family = family;
}

static uint16_t __yo_sockaddr_get_family(void* addr) {
  return ((struct sockaddr*)addr)->sa_family;
}

static void __yo_sockaddr_in_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in*)addr)->sin_port = htons(port);
}

static uint16_t __yo_sockaddr_in_get_port(void* addr) {
  return ntohs(((struct sockaddr_in*)addr)->sin_port);
}

static void __yo_sockaddr_in_set_addr(void* addr, uint32_t ip) {
  ((struct sockaddr_in*)addr)->sin_addr.s_addr = ip;
}

static uint32_t __yo_sockaddr_in_get_addr(void* addr) {
  return ((struct sockaddr_in*)addr)->sin_addr.s_addr;
}

static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in6*)addr)->sin6_port = htons(port);
}

static uint16_t __yo_sockaddr_in6_get_port(void* addr) {
  return ntohs(((struct sockaddr_in6*)addr)->sin6_port);
}

static void __yo_sockaddr_in6_set_addr(void* addr, const void* ip) {
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, 16);
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, 16);
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  strncpy(((struct sockaddr_un*)addr)->sun_path, path, sizeof(((struct sockaddr_un*)addr)->sun_path) - 1);
}

static char* __yo_sockaddr_un_get_path(void* addr) {
  return ((struct sockaddr_un*)addr)->sun_path;
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return inet_pton(af, src, dst);
}

static char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return (char*)inet_ntop(af, src, dst, (socklen_t)size);
}

static uint16_t __yo_htons(uint16_t hostshort) {
  return htons(hostshort);
}

static uint16_t __yo_ntohs(uint16_t netshort) {
  return ntohs(netshort);
}

static uint32_t __yo_htonl(uint32_t hostlong) {
  return htonl(hostlong);
}

static uint32_t __yo_ntohl(uint32_t netlong) {
  return ntohl(netlong);
}

// Synchronous file operations
static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  int result = fd >= 0 ? fd : -errno;
  ASYNC_DEBUG("[IO] open(%s, 0x%x, 0%o) = %d\\n", path, flags, mode, result);
  return result;
}

static void __yo_file_close(int32_t fd) {
  ASYNC_DEBUG("[IO] close(%d)\\n", fd);
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) {
    int result = -errno;
    ASYNC_DEBUG("[IO] fstat(%d) failed: %d\\n", fd, result);
    return result;
  }
  ASYNC_DEBUG("[IO] fstat(%d) = %lld bytes\\n", fd, (long long)st.st_size);
  return st.st_size;
}

// On macOS, we use struct stat instead of struct statx
// These functions wrap struct stat access to match the Linux statx API
static size_t __yo_statx_buf_size(void) {
  return sizeof(struct stat);
}

static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_mtimespec.tv_sec;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mtimespec.tv_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_atimespec.tv_sec;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_atimespec.tv_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_ctimespec.tv_sec;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_ctimespec.tv_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_birthtimespec.tv_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_birthtimespec.tv_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)major(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  return (uint64_t)minor(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blksize;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blocks;
}

#endif // __APPLE__
`);
}
