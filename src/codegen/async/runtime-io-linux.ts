/**
 * runtime-io-linux.ts
 *
 * Linux I/O helpers split into two categories:
 *
 * 1. generatePlatformSysRuntimeLinux — synchronous POSIX helpers (pipe, dup,
 *    lseek, fallocate, mmap, socket address helpers, statx wrappers, etc.)
 *    that do NOT depend on IOFuture or the async event loop.
 *
 * 2. generateAsyncRuntimeIOLinux — async I/O via io_uring (liburing).
 *    Provides async read, write, openat, close, statx, mkdir, unlink,
 *    rename, symlink, link, fsync, fdatasync, ftruncate, and socket operations.
 */

import { Emitter } from "../../emitter";

// ---------------------------------------------------------------------------
// 1. Synchronous platform helpers (Linux) — no IOFuture / event-loop dependency
// ---------------------------------------------------------------------------

/**
 * Emits synchronous Linux-specific POSIX helpers.  These do NOT depend on the
 * async runtime (no IOFuture, no event-loop types).  All functions are `static`
 * so unused ones are dead-code-eliminated by the C compiler.
 *
 * Sections: sync FD ops (pipe, dup, lseek, fallocate, fcntl, flock, readv/writev,
 * iovec, fadvise, madvise, mmap, mprotect, msync, fchmod, fchown, readlinkat),
 * sync socket ops (getsockname, getpeername, setsockopt, getsockopt, socketpair,
 * clock_gettime, uname, gethostname, umask), address/socket helpers,
 * file open/close/size, statx accessors.
 */
export function generatePlatformSysRuntimeLinux(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// Platform-specific sync helpers (Linux)
// ============================================================================

#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <sys/uio.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// ============================================================================
// Synchronous FD Operations (Linux) - no IOFuture overhead
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
  int result = fallocate(fd, mode, (off_t)offset, (off_t)length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  int result = fcntl(fd, F_GETFL);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFL, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  int result = fcntl(fd, F_GETFD);
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

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = readv(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = writev(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pread(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pwrite(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static size_t __yo_iovec_size(void) {
  return sizeof(struct iovec);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  struct iovec* vec = (struct iovec*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  int result = posix_fadvise(fd, (off_t)offset, (off_t)len, advice);
  return (result == 0) ? 0 : -result;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  int result = madvise((void*)addr, length, advice);
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
  int result = fchmodat(dirfd, path, (mode_t)mode, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result = readlinkat(dirfd, path, buf, bufsize);
  return (result < 0) ? -errno : (int32_t)result;
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

// Sync clock_gettime - read current clock time
static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  struct timespec ts;
  int result = clock_gettime((clockid_t)clock_id, &ts);
  if (result < 0) {
    return -errno;
  }
  *sec = (int64_t)ts.tv_sec;
  *nsec = (int64_t)ts.tv_nsec;
  return 0;
}

// Sync uname - system identification
static int32_t __yo_sync_uname(void* buf) {
  int result = uname((struct utsname*)buf);
  return (result < 0) ? -errno : 0;
}

// Sync gethostname - read host name
static int32_t __yo_sync_gethostname(char* name, size_t len) {
  int result = gethostname(name, len);
  if (result < 0) {
    return -errno;
  }
  if (len > 0) {
    name[len - 1] = '\0';
  }
  return 0;
}

// Sync umask - set process file mode creation mask
static int32_t __yo_sync_umask(int32_t mask) {
  mode_t prev = umask((mode_t)mask);
  return (int32_t)prev;
}


// ============================================================================
// Socket Address Helpers (Cross-platform)
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
  ((struct sockaddr_un*)addr)->sun_path[sizeof(((struct sockaddr_un*)addr)->sun_path) - 1] = '\\0';
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

// Synchronous file operations (kept for compatibility)
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

// Get size of statx buffer (for allocation)
static size_t __yo_statx_buf_size(void) {
  return sizeof(struct statx);
}

// Extract fields from struct statx
static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_mtime.tv_sec;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_mtime.tv_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_atime.tv_sec;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_atime.tv_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_ctime.tv_sec;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_ctime.tv_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_btime.tv_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_btime.tv_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_dev_major;
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_dev_minor;
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_blksize;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_blocks;
}


`);
}

// ---------------------------------------------------------------------------
// 2. Async I/O runtime (Linux) — requires IOFuture / event-loop types
// ---------------------------------------------------------------------------

/**
 * Emits async I/O helpers that depend on the IOFuture type and event loop.
 * Uses io_uring via liburing when available, falls back to stubs otherwise.
 */
export function generateAsyncRuntimeIOLinux(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// Async I/O Runtime (Linux - io_uring via liburing)
// ============================================================================

// Try to include liburing.h - if not available, disable I/O features
#if __has_include(<liburing.h>)
#define __YO_HAS_LIBURING 1
#include <liburing.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

static _Thread_local struct io_uring __yo_io_ring;
// __yo_io_initialized is defined in runtime-core
static _Thread_local size_t __yo_pending_io_count = 0;

// I/O Future types - __yo_io_future_t is defined in types/generation.ts
// It has the same layout as async state machines (state, result, continuation_fn, continuation_sm)
// so the await codegen can access ->state and ->result uniformly.
// We store the future pointer directly in the SQE user data.

// Initialize io_uring (called once at event loop start)
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  int ret = io_uring_queue_init(256, &__yo_io_ring, 0);
  if (ret < 0) {
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\\n", strerror(-ret));
    exit(1);
  }
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] io_uring initialized with 256 entries\\n");
}

// Cleanup io_uring
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  io_uring_queue_exit(&__yo_io_ring);
  __yo_io_initialized = false;
  ASYNC_DEBUG("[IO] io_uring cleaned up\\n");
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return __yo_pending_io_count > 0 || __yo_active_watch_count > 0;
}

// Forward declaration for poll/fs_event tick (defined in runtime-io-common)
static int __yo_poll_and_fs_event_tick(void);

// Submit an SQE to io_uring with an event-loop RC reference.
// The reference is released in __yo_io_process_cqe after the CQE is consumed,
// preventing use-after-free if the user drops the future before completion.
static inline void __yo_io_ring_submit(__yo_io_future_t* future) {
  future->header.ref_count++;    // io_uring holds a reference until CQE
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
}

// Process completions from CQ
// The future pointer is stored directly in the SQE user data
static void __yo_io_process_cqe(struct io_uring_cqe* cqe) {
  __yo_io_future_t* future = (__yo_io_future_t*)io_uring_cqe_get_data(cqe);
  __yo_pending_io_count--;

  // Set the result
  future->result = cqe->res;
  
  ASYNC_DEBUG("[IO] Completed I/O: result=%d (pending=%zu)\\n",
              future->result, __yo_pending_io_count);
  
  // Mark as completed (state -1 = done)
  future->state = -1;
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = future->continuation_fn;
  void* cont_sm = future->continuation_sm;
  
  ASYNC_DEBUG("[IO] Continuation check: cont_fn=%p, cont_sm=%p\\n", (void*)cont_fn, cont_sm);
  
  if (cont_fn && cont_sm) {
    ASYNC_DEBUG("[IO] Spawning continuation for I/O completion\\n");
    __yo_async_spawn_task(cont_fn, cont_sm);
  }

  io_uring_cqe_seen(&__yo_io_ring, cqe);
  
  // Release the io_uring event loop reference.
  // This must be AFTER io_uring_cqe_seen and AFTER reading all future fields,
  // because decr_rc may free the future if user already dropped their ref.
  __yo_decr_rc((void*)future);
}

// Poll for I/O completions (non-blocking)
static int __yo_io_poll(void) {
  struct io_uring_cqe* cqe;
  int count = 0;
  
  while (io_uring_peek_cqe(&__yo_io_ring, &cqe) == 0) {
    __yo_io_process_cqe(cqe);
    count++;
  }
  
  // Also tick poll/fs_event handles
  count += __yo_poll_and_fs_event_tick();
  
  if (count > 0) {
    ASYNC_DEBUG("[IO] Polled %d completions\\n", count);
  }
  return count;
}

// Wait for at least one I/O completion (blocking)
static int __yo_io_wait(void) {
  // If only poll/fs_event watches are pending (no io_uring ops), use a short sleep
  if (__yo_pending_io_count == 0 && __yo_active_watch_count > 0) {
    struct timespec ts = {0, 10 * 1000 * 1000}; // 10ms
    nanosleep(&ts, NULL);
    return __yo_poll_and_fs_event_tick();
  }
  
  struct io_uring_cqe* cqe;
  int ret = io_uring_wait_cqe(&__yo_io_ring, &cqe);
  if (ret < 0) {
    ASYNC_DEBUG("[IO] WARNING: io_uring_wait_cqe failed: %d\\n", ret);
    return 0;
  }
  
  ASYNC_DEBUG("[IO] Waiting for I/O completion...\\n");
  __yo_io_process_cqe(cqe);
  return 1 + __yo_io_poll();  // Process any additional completions
}

// Create and start an async read operation
// Returns a __yo_io_future_t* that completes when the read finishes
static __yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  // Ensure io_uring is initialized (lazy initialization for eager async execution)
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));  // Zero-initialize to ensure dispose_fn etc. are NULL
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  future->state = 0;  // 0 = pending
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    future->state = -1;  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return future;
  }
  
  io_uring_prep_read(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Create and start an async write operation
// Returns a __yo_io_future_t* that completes when the write finishes
static __yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  // Ensure io_uring is initialized (lazy initialization for eager async execution)
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));  // Zero-initialize to ensure dispose_fn etc. are NULL
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  future->state = 0;  // 0 = pending
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    future->state = -1;  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return future;
  }
  
  io_uring_prep_write(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, (void*)buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Create and start an async openat operation
// Returns a __yo_io_future_t* that completes with the fd or error
static __yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_openat(sqe, dirfd, path, flags, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async openat: dirfd=%d path=%s flags=0x%x mode=0%o (pending=%zu)\\n",
              dirfd, path, flags, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async close operation
static __yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_close(sqe, fd);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async close: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async statx operation (for async stat)
// Uses statx which is the modern replacement for stat, supported by io_uring
static __yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_statx(sqe, dirfd, path, flags, mask, (struct statx*)statxbuf);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async statx: dirfd=%d path=%s flags=0x%x mask=0x%x (pending=%zu)\\n",
              dirfd, path, flags, mask, __yo_pending_io_count);
  
  return future;
}

// Create and start an async mkdirat operation
static __yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_mkdirat(sqe, dirfd, path, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async mkdirat: dirfd=%d path=%s mode=0%o (pending=%zu)\\n",
              dirfd, path, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async unlinkat operation
static __yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_unlinkat(sqe, dirfd, path, flags);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async unlinkat: dirfd=%d path=%s flags=0x%x (pending=%zu)\\n",
              dirfd, path, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async renameat operation
static __yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_renameat(sqe, olddirfd, oldpath, newdirfd, newpath, 0);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async renameat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s (pending=%zu)\\n",
              olddirfd, oldpath, newdirfd, newpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async symlinkat operation
static __yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_symlinkat(sqe, target, newdirfd, linkpath);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async symlinkat: target=%s newdirfd=%d linkpath=%s (pending=%zu)\\n",
              target, newdirfd, linkpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async linkat operation (hard link)
static __yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_linkat(sqe, olddirfd, oldpath, newdirfd, newpath, flags);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async linkat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s flags=0x%x (pending=%zu)\\n",
              olddirfd, oldpath, newdirfd, newpath, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fsync operation
static __yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, 0);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async fsync: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fdatasync operation
static __yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, IORING_FSYNC_DATASYNC);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async fdatasync: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async ftruncate operation
static __yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;

#if defined(IORING_OP_FTRUNCATE)
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }

  io_uring_prep_rw(IORING_OP_FTRUNCATE, sqe, fd, NULL, 0, (uint64_t)length);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);

  ASYNC_DEBUG("[IO] Started async ftruncate: fd=%d length=%lld (pending=%zu)\\n",
              fd, (long long)length, __yo_pending_io_count);
#else
  int result = ftruncate(fd, (off_t)length);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;

  ASYNC_DEBUG("[IO] Completed ftruncate synchronously (liburing fallback): fd=%d length=%lld result=%d\\n",
              fd, (long long)length, future->result);
#endif
  
  return future;
}

// ============================================================================
// Socket Operations (Linux io_uring)
// ============================================================================

// Async socket - create socket
static __yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = socket(domain, type, protocol);
  future->result = (result < 0) ? -errno : result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\\n",
              domain, type, protocol, future->result);
  
  return future;
}

// Async bind - bind socket to address
static __yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = bind(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async listen - mark socket as listening
static __yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = listen(sockfd, backlog);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection (using io_uring)
static __yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_accept(sqe, sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen, 0);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async accept: sockfd=%d (pending=%zu)\\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async connect - connect to remote address (using io_uring)
static __yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_connect(sqe, sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async connect: sockfd=%d (pending=%zu)\\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async send - send data on socket (using io_uring)
static __yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_send(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async send: sockfd=%d len=%zu (pending=%zu)\\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async recv - receive data from socket (using io_uring)
static __yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_recv(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  __yo_io_ring_submit(future);
  
  ASYNC_DEBUG("[IO] Started async recv: sockfd=%d len=%zu (pending=%zu)\\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async sendto - send data to specific address (UDP)
static __yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // io_uring doesn't have direct sendto, use synchronous
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] sendto completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async recvfrom - receive data with source address (UDP)
static __yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // io_uring doesn't have direct recvfrom, use synchronous
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] recvfrom completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async shutdown - shutdown socket
static __yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = shutdown(sockfd, how);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\\n", sockfd, how, future->result);
  
  return future;
}

// Async setsockopt - set socket option
static __yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Async getsockopt - get socket option
static __yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    void* optval, uint32_t* optlen) {
  __yo_io_init();
  
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = getsockopt(sockfd, level, optname, optval, (socklen_t*)optlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

#else // !__YO_HAS_LIBURING

#include <time.h>

// Stub functions when liburing is not available
static inline void __yo_io_init(void) {
  fprintf(stderr, "[Yo] Warning: liburing not available, async I/O disabled\\n");
}

static inline void __yo_io_cleanup(void) {}

static inline bool __yo_has_pending_io(void) {
  return __yo_active_watch_count > 0;
}

static int __yo_poll_and_fs_event_tick(void);

static inline int __yo_io_poll(void) { return __yo_poll_and_fs_event_tick(); }

static inline int __yo_io_wait(void) {
  if (__yo_active_watch_count > 0) {
    struct timespec ts = {0, 10 * 1000 * 1000};
    nanosleep(&ts, NULL);
    return __yo_poll_and_fs_event_tick();
  }
  return 0;
}

static inline void* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async read not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async write not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  (void)dirfd; (void)path; (void)flags; (void)mode;
  fprintf(stderr, "[Yo] Error: async openat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_close_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async close not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  (void)dirfd; (void)path; (void)flags; (void)mask; (void)statxbuf;
  fprintf(stderr, "[Yo] Error: async statx not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  (void)dirfd; (void)path; (void)mode;
  fprintf(stderr, "[Yo] Error: async mkdirat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  (void)dirfd; (void)path; (void)flags;
  fprintf(stderr, "[Yo] Error: async unlinkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath;
  fprintf(stderr, "[Yo] Error: async renameat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  (void)target; (void)newdirfd; (void)linkpath;
  fprintf(stderr, "[Yo] Error: async symlinkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath; (void)flags;
  fprintf(stderr, "[Yo] Error: async linkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fsync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fsync not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fdatasync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fdatasync not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  (void)fd; (void)length;
  fprintf(stderr, "[Yo] Error: async ftruncate not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  (void)domain; (void)type; (void)protocol;
  fprintf(stderr, "[Yo] Error: async socket not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async bind not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  (void)sockfd; (void)backlog;
  fprintf(stderr, "[Yo] Error: async listen not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async accept not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async connect not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async send not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async recv not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                             const void* dest_addr, uint32_t addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)dest_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async sendto not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                               void* src_addr, uint32_t* addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)src_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async recvfrom not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  (void)sockfd; (void)how;
  fprintf(stderr, "[Yo] Error: async shutdown not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 const void* optval, uint32_t optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async setsockopt not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 void* optval, uint32_t* optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async getsockopt not supported without liburing\\n");
  abort();
  return NULL;
}

#endif // __YO_HAS_LIBURING

`);
}
