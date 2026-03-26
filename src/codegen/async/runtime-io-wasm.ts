/**
 * runtime-io-wasm.ts
 *
 * Emits stub implementations of platform-specific I/O functions for WASM targets.
 * These stubs allow Yo programs that import sys modules (std/sys/file, std/net, etc.)
 * to compile for WASM even though real I/O operations are not available.
 *
 * Async stubs return an immediately-completed IOFuture with result = -ENOSYS.
 * Sync stubs return -ENOSYS (or 0 for size queries, NULL for pointer returns).
 *
 * This is analogous to how Emscripten provides stub POSIX implementations:
 * programs compile and link, but I/O operations fail gracefully at runtime.
 */

import { Emitter } from "../../emitter";

/**
 * Emits WASM stub implementations for all platform-specific sync system helpers.
 * These correspond to functions emitted by generatePlatformSysRuntimeLinux/macOS/Windows.
 */
export function generatePlatformSysRuntimeWasm(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// WASM Platform Stubs — Synchronous System Helpers
// ============================================================================
// Stub implementations for WASM targets. Real I/O is not available; these
// return -ENOSYS (function not implemented) or appropriate zero/null values.

#ifndef ENOSYS
#define ENOSYS 38
#endif

// --- File helpers ---
static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  (void)path; (void)flags; (void)mode;
  return -ENOSYS;
}
static void __yo_file_close(int32_t fd) { (void)fd; }
static int64_t __yo_file_size(int32_t fd) { (void)fd; return -ENOSYS; }

// --- Pipe / dup ---
static int32_t __yo_sync_pipe(int32_t* pipefd) { (void)pipefd; return -ENOSYS; }
static int32_t __yo_sync_dup(int32_t oldfd) { (void)oldfd; return -ENOSYS; }
static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) { (void)oldfd; (void)newfd; return -ENOSYS; }

// --- Fcntl ---
static int32_t __yo_sync_fcntl_getfl(int32_t fd) { (void)fd; return -ENOSYS; }
static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) { (void)fd; (void)flags; return -ENOSYS; }
static int32_t __yo_sync_fcntl_getfd(int32_t fd) { (void)fd; return -ENOSYS; }
static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) { (void)fd; (void)flags; return -ENOSYS; }

// --- File locking ---
static int32_t __yo_sync_flock(int32_t fd, int32_t operation) { (void)fd; (void)operation; return -ENOSYS; }

// --- Vectored I/O ---
static size_t __yo_iovec_size(void) { return sizeof(void*) + sizeof(size_t); /* iovec-like */ }
static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  (void)iov; (void)index; (void)base; (void)len;
}
static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) { (void)fd; (void)iov; (void)iovcnt; return -ENOSYS; }
static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) { (void)fd; (void)iov; (void)iovcnt; return -ENOSYS; }
static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) { (void)fd; (void)iov; (void)iovcnt; (void)offset; return -ENOSYS; }
static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) { (void)fd; (void)iov; (void)iovcnt; (void)offset; return -ENOSYS; }

// --- Memory-mapped I/O ---
static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  (void)addr; (void)length; (void)prot; (void)flags; (void)fd; (void)offset;
  return (uint8_t*)(intptr_t)-1; /* MAP_FAILED */
}
static bool __yo_sync_mmap_is_error(uint8_t* addr) { return addr == (uint8_t*)(intptr_t)-1; }
static int32_t __yo_sync_mmap_errno(uint8_t* addr) { (void)addr; return ENOSYS; }
static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) { (void)addr; (void)length; return -ENOSYS; }
static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) { (void)addr; (void)length; (void)prot; return -ENOSYS; }
static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) { (void)addr; (void)length; (void)flags; return -ENOSYS; }

// --- File advice ---
static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  (void)fd; (void)mode; (void)offset; (void)length; return -ENOSYS;
}

// --- Metadata ---
static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  (void)dirfd; (void)path; (void)buf; (void)bufsize; return -ENOSYS;
}

// --- Socket addresses ---
static size_t __yo_sockaddr_storage_size(void) { return 128; }
static size_t __yo_sockaddr_in_size(void) { return 16; }
static size_t __yo_sockaddr_in6_size(void) { return 28; }
static size_t __yo_sockaddr_un_size(void) { return 110; }

// --- Socket helpers ---
static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  (void)domain; (void)sock_type; (void)protocol; (void)sv; return -ENOSYS;
}

// --- System info ---
static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  (void)clock_id; (void)sec; (void)nsec; return -ENOSYS;
}
static int32_t __yo_sync_uname(void* buf) { (void)buf; return -ENOSYS; }
static int32_t __yo_sync_gethostname(char* name, size_t len) { (void)name; (void)len; return -ENOSYS; }
static int32_t __yo_sync_umask(int32_t mask) { (void)mask; return 0; }

// --- Process helpers ---
static int32_t __yo_process_exit_status(int32_t status) { (void)status; return -1; }
static int32_t __yo_process_term_signal(int32_t status) { (void)status; return -1; }

// --- Directory entry helpers ---
static size_t __yo_dirent_size(void) { return 0; }
static uint64_t __yo_dirent_ino(void* entry) { (void)entry; return 0; }
static uint16_t __yo_dirent_reclen(void* entry) { (void)entry; return 0; }

// --- DNS / addrinfo helpers ---
static size_t __yo_addrinfo_size(void) { return 0; }
static int32_t __yo_addrinfo_flags(uint8_t* ai) { (void)ai; return 0; }
static int32_t __yo_addrinfo_family(uint8_t* ai) { (void)ai; return 0; }
static int32_t __yo_addrinfo_socktype(uint8_t* ai) { (void)ai; return 0; }
static int32_t __yo_addrinfo_protocol(uint8_t* ai) { (void)ai; return 0; }
static uint32_t __yo_addrinfo_addrlen(uint8_t* ai) { (void)ai; return 0; }
static uint8_t* __yo_addrinfo_addr(uint8_t* ai) { (void)ai; return NULL; }
static uint8_t* __yo_addrinfo_canonname(uint8_t* ai) { (void)ai; return NULL; }
static uint8_t* __yo_addrinfo_next(uint8_t* ai) { (void)ai; return NULL; }
static void __yo_freeaddrinfo(uint8_t* res) { (void)res; }

// --- Statx field extractors ---
static size_t __yo_statx_buf_size(void) { return 256; }
static int64_t __yo_statx_size(void* buf) { (void)buf; return 0; }
static uint32_t __yo_statx_mode(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_mtime_sec(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_mtime_nsec(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_atime_sec(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_atime_nsec(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_ctime_sec(void* buf) { (void)buf; return 0; }
static int64_t __yo_statx_ctime_nsec(void* buf) { (void)buf; return 0; }
static uint32_t __yo_statx_uid(void* buf) { (void)buf; return 0; }
static uint32_t __yo_statx_gid(void* buf) { (void)buf; return 0; }
static uint64_t __yo_statx_ino(void* buf) { (void)buf; return 0; }
static uint64_t __yo_statx_nlink(void* buf) { (void)buf; return 0; }

// --- Socket address set/get helpers ---
static void __yo_sockaddr_set_family(void* addr, int32_t family) { (void)addr; (void)family; }
static int32_t __yo_sockaddr_get_family(void* addr) { (void)addr; return 0; }
static void __yo_sockaddr_in_set_port(void* addr, uint16_t port) { (void)addr; (void)port; }
static uint16_t __yo_sockaddr_in_get_port(void* addr) { (void)addr; return 0; }
static void __yo_sockaddr_in_set_addr(void* addr, uint32_t ip) { (void)addr; (void)ip; }
static uint32_t __yo_sockaddr_in_get_addr(void* addr) { (void)addr; return 0; }
static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) { (void)addr; (void)port; }
static void __yo_sockaddr_un_set_path(void* addr, const char* path) { (void)addr; (void)path; }
static const char* __yo_sockaddr_un_get_path(void* addr) { (void)addr; return ""; }

// --- Network byte order ---
static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) { (void)af; (void)src; (void)dst; return -ENOSYS; }
static uint16_t __yo_htons(uint16_t hostshort) { (void)hostshort; return 0; }
static uint16_t __yo_ntohs(uint16_t netshort) { (void)netshort; return 0; }
static uint32_t __yo_htonl(uint32_t hostlong) { (void)hostlong; return 0; }
static uint32_t __yo_ntohl(uint32_t netlong) { (void)netlong; return 0; }

// --- Socket info ---
static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen; return -ENOSYS;
}
static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen; return -ENOSYS;
}
static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname, const void* optval, uint32_t optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen; return -ENOSYS;
}
static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname, void* optval, uint32_t* optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen; return -ENOSYS;
}

// --- File metadata ---
static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t length, int32_t advice) {
  (void)fd; (void)offset; (void)length; (void)advice; return -ENOSYS;
}
static int32_t __yo_sync_madvise(void* addr, size_t length, int32_t advice) {
  (void)addr; (void)length; (void)advice; return -ENOSYS;
}
static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) { (void)fd; (void)mode; return -ENOSYS; }
static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  (void)dirfd; (void)path; (void)mode; (void)flags; return -ENOSYS;
}
static int32_t __yo_sync_fchown(int32_t fd, uint32_t owner, uint32_t group) {
  (void)fd; (void)owner; (void)group; return -ENOSYS;
}
static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t owner, uint32_t group, int32_t flags) {
  (void)dirfd; (void)path; (void)owner; (void)group; (void)flags; return -ENOSYS;
}
static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  (void)fd; (void)offset; (void)whence; return -ENOSYS;
}
`);
}

/**
 * Emits WASM stub implementations for all async I/O start functions.
 * These correspond to functions emitted by generateAsyncRuntimeIO{Linux,MacOS,Windows}
 * and generateAsyncRuntimeIOCommon.
 *
 * Each stub allocates an IOFuture, marks it as immediately completed with -ENOSYS,
 * and returns it. This allows async/await code to compile and run — the awaited
 * result will be an error code that Yo-level error handling can process.
 */
export function generateAsyncRuntimeIOWasm(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// WASM Platform Stubs — Async I/O Start Functions
// ============================================================================
// Stub async I/O functions for WASM. Each returns an immediately-completed
// IOFuture with result = -ENOSYS. The await machinery processes this as a
// normal completion, and Yo-level code sees the error via Result types.

#ifndef ENOSYS
#define ENOSYS 38
#endif

static __yo_io_future_t* __yo_wasm_io_stub(void) {
  __yo_io_future_t* future = (__yo_io_future_t*)__yo_malloc(sizeof(__yo_io_future_t));
  memset(future, 0, sizeof(__yo_io_future_t));
  future->header.ref_count = 1;
  future->state = -1;    /* completed */
  future->result = -ENOSYS;
  return future;
}

// --- File operations ---
static __yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  (void)dirfd; (void)path; (void)flags; (void)mode; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_close_start(int32_t fd) {
  (void)fd; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  (void)dirfd; (void)path; (void)flags; (void)mask; (void)statxbuf; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  (void)fd; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  (void)fd; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  (void)fd; (void)length; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  (void)dirfd; (void)path; (void)mode; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  (void)dirfd; (void)path; (void)flags; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  (void)target; (void)newdirfd; (void)linkpath; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath; (void)flags; return __yo_wasm_io_stub();
}

// --- Socket operations ---
static __yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  (void)domain; (void)type; (void)protocol; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  (void)sockfd; (void)backlog; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)dest_addr; (void)addrlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)src_addr; (void)addrlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  (void)sockfd; (void)how; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    void* optval, uint32_t* optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen; return __yo_wasm_io_stub();
}

// --- Timer ---
static __yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  (void)milliseconds; return __yo_wasm_io_stub();
}

// --- DNS ---
static __yo_io_future_t* __yo_async_getaddrinfo_start(const uint8_t* node, const uint8_t* service,
                                                     const uint8_t* hints, uint8_t** result) {
  (void)node; (void)service; (void)hints; (void)result; return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_getnameinfo_start(const uint8_t* addr, uint32_t addrlen,
                                                     uint8_t* host, size_t hostlen,
                                                     uint8_t* service, size_t servlen, int32_t flags) {
  (void)addr; (void)addrlen; (void)host; (void)hostlen; (void)service; (void)servlen; (void)flags;
  return __yo_wasm_io_stub();
}

// --- Directory scanning ---
static __yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  (void)fd; (void)buf; (void)buf_size; return __yo_wasm_io_stub();
}

// --- Process spawn/wait ---
static __yo_io_future_t* __yo_async_spawn_start(const uint8_t* file, uint8_t** argv, uint8_t** envp,
                                              int32_t stdin_fd, int32_t stdout_fd, int32_t stderr_fd) {
  (void)file; (void)argv; (void)envp; (void)stdin_fd; (void)stdout_fd; (void)stderr_fd;
  return __yo_wasm_io_stub();
}
static __yo_io_future_t* __yo_async_waitpid_start(int32_t pid, int32_t options) {
  (void)pid; (void)options; return __yo_wasm_io_stub();
}

// --- Poll ---
static void* __yo_poll_init(int32_t fd) { (void)fd; return NULL; }
static int32_t __yo_poll_start(void* h, int32_t events, void* callback, void* user_data) {
  (void)h; (void)events; (void)callback; (void)user_data; return -ENOSYS;
}
static int32_t __yo_poll_stop(void* h) { (void)h; return -ENOSYS; }
static void __yo_poll_close(void* h) { (void)h; }

// --- FS Event watching ---
static void* __yo_fs_event_init(void) { return NULL; }
static int32_t __yo_fs_event_start(void* h, const char* path, uint32_t flags, void* callback, void* user_data) {
  (void)h; (void)path; (void)flags; (void)callback; (void)user_data; return -ENOSYS;
}
static int32_t __yo_fs_event_stop(void* h) { (void)h; return -ENOSYS; }
static void __yo_fs_event_close(void* h) { (void)h; }
`);
}
