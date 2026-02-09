/**
 * runtime-io-common.ts
 *
 * Cross-platform and POSIX-only I/O helpers:
 * - File system stat helpers (struct stat field accessors)
 * - Timer operations (Linux timerfd, macOS dispatch, Windows threadpool)
 * - File extra operations (access, realpath, utime, mkdtemp, copyfile, sendfile, statfs)
 * - Directory operations (scandir, opendir, readdir, closedir, getdents)
 * - DNS resolution (getaddrinfo, getnameinfo)
 * - Signal handling
 * - TTY operations
 * - FS event watching
 * - Poll operations
 */

import { Emitter } from "../../emitter";

export function generateAsyncRuntimeIOCommon(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// File System Helper Functions
// ============================================================================
// These functions help extract fields from struct stat, which has platform-specific layout.

#ifndef _WIN32
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <string.h>
#if defined(__APPLE__)
#include <sys/dirent.h>
#include <unistd.h>
#endif

// Get size of stat buffer (for allocation)
static size_t __yo_stat_buf_size(void) {
  return sizeof(struct stat);
}

// Extract fields from struct stat
static int64_t __yo_stat_size(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_size;
}

static uint32_t __yo_stat_mode(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_mode;
}

static int64_t __yo_stat_mtime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_mtime;
}

static int64_t __yo_stat_atime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_atime;
}

static int64_t __yo_stat_ctime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_ctime;
}

static uint32_t __yo_stat_uid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_uid;
}

static uint32_t __yo_stat_gid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_gid;
}

static uint64_t __yo_stat_ino(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_ino;
}

static uint64_t __yo_stat_dev(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_dev;
}

static uint64_t __yo_stat_nlink(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_nlink;
}

// Extract fields from struct dirent
static const char* __yo_dirent_name(void* entry) {
  return ((struct dirent*)entry)->d_name;
}

static uint8_t __yo_dirent_type(void* entry) {
#if defined(_DIRENT_HAVE_D_TYPE) || defined(__APPLE__)
  return ((struct dirent*)entry)->d_type;
#else
  // d_type not available on some systems, return DT_UNKNOWN
  return 0;
#endif
}
#endif // !_WIN32

// ============================================================================
// Timer Operations (cross-platform)
// ============================================================================

#if defined(__linux__)
#include <sys/timerfd.h>

// Extended future for timer that holds timerfd and buffer for cleanup
typedef struct {
  yo_io_future_t base;
  int timerfd;
  uint64_t* read_buf;
} yo_timer_future_t;

static void __yo_timer_future_dispose(void* ptr) {
  yo_timer_future_t* tf = (yo_timer_future_t*)ptr;
  if (tf->timerfd >= 0) {
    close(tf->timerfd);
    tf->timerfd = -1;
  }
  if (tf->read_buf) {
    __yo_free(tf->read_buf);
    tf->read_buf = NULL;
  }
}

// Async sleep using timerfd + io_uring
static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();
  
  yo_timer_future_t* timer_future = (yo_timer_future_t*)__yo_malloc(sizeof(yo_timer_future_t));
  memset(timer_future, 0, sizeof(yo_timer_future_t));
  
  yo_io_future_t* future = &timer_future->base;
  future->header.ref_count = 1;
  future->header.dispose_fn = __yo_timer_future_dispose;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  timer_future->timerfd = -1;
  timer_future->read_buf = NULL;
  
  // Create a timerfd
  int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
  if (tfd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    return future;
  }
  timer_future->timerfd = tfd;
  
  // Set timer to expire after milliseconds
  struct itimerspec its = {0};
  its.it_value.tv_sec = (time_t)(milliseconds / 1000);
  its.it_value.tv_nsec = (long)((milliseconds % 1000) * 1000000);
  
  if (timerfd_settime(tfd, 0, &its, NULL) < 0) {
    int err = errno;
    future->result = -err;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Use io_uring to read from timerfd (fires when timer expires)
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Allocate buffer for timerfd read (8 bytes)
  uint64_t* buf = (uint64_t*)__yo_malloc(sizeof(uint64_t));
  timer_future->read_buf = buf;
  io_uring_prep_read(sqe, tfd, buf, sizeof(uint64_t), 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\\n",
              (unsigned long long)milliseconds, __yo_pending_io_count);
  
  return future;
}

#elif defined(__APPLE__)
// macOS timer using dispatch_after
static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  dispatch_after(
    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(milliseconds * NSEC_PER_MSEC)),
    __yo_io_queue,
    ^{
      fut->result = (int32_t)sizeof(uint64_t);  // Match timerfd read size on Linux
      __yo_io_wake_continuation(fut);
    }
  );
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\\n",
              (unsigned long long)milliseconds, atomic_load(&__yo_pending_io_count));
  
  return future;
}

#elif defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#include <windows.h>

static void __yo_io_init(void);
static void __yo_win_timer_add(yo_io_future_t* future, uint64_t milliseconds);

static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  __yo_win_timer_add(future, milliseconds);
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms\\n", (unsigned long long)milliseconds);
  
  return future;
}

#endif

// ============================================================================
// File Extra Operations (POSIX-only)
// ============================================================================
#if !defined(_WIN32)

// Async access - check file accessibility
static yo_io_future_t* __yo_async_access_start(int32_t dirfd, const char* path, int32_t mode) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = access(path, mode);
  } else {
    result = faccessat(dirfd, path, mode, 0);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] access completed: path=%s mode=%d result=%d\\n", path, mode, future->result);
  
  return future;
}

// Async realpath - resolve canonical path
static yo_io_future_t* __yo_async_realpath_start(const char* path, char* resolved) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  char* result = realpath(path, resolved);
  future->result = result ? 0 : -errno;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] realpath completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async utime - change file timestamps
static yo_io_future_t* __yo_async_utime_start(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                               int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = utimensat(AT_FDCWD, path, times, 0);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async futime - change file timestamps by fd
static yo_io_future_t* __yo_async_futime_start(int32_t fd, int64_t atime_sec, int64_t atime_nsec,
                                                int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = futimens(fd, times);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async lutime - change symlink timestamps
static yo_io_future_t* __yo_async_lutime_start(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                                int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = utimensat(AT_FDCWD, path, times, AT_SYMLINK_NOFOLLOW);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async mkdtemp - create temporary directory
static yo_io_future_t* __yo_async_mkdtemp_start(char* template) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  char* result = mkdtemp(template);
  future->result = result ? 0 : -errno;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async mkstemp - create temporary file
static yo_io_future_t* __yo_async_mkstemp_start(char* template) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int fd = mkstemp(template);
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async copyfile
#if defined(__linux__)
#include <sys/sendfile.h>

static yo_io_future_t* __yo_async_copyfile_start(const char* src, const char* dst, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Open source
  int src_fd = open(src, O_RDONLY);
  if (src_fd < 0) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Get source size
  struct stat st;
  if (fstat(src_fd, &st) < 0) {
    int err = errno;
    close(src_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Open/create destination
  int open_flags = O_WRONLY | O_CREAT | O_TRUNC;
  if (flags & 1) open_flags |= O_EXCL;  // COPYFILE_EXCL
  
  int dst_fd = open(dst, open_flags, st.st_mode);
  if (dst_fd < 0) {
    int err = errno;
    close(src_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Try copy_file_range first (supports clone), fall back to sendfile
  ssize_t copied = 0;
  off_t off_in = 0;
  
#ifdef __NR_copy_file_range
  copied = syscall(__NR_copy_file_range, src_fd, &off_in, dst_fd, NULL, (size_t)st.st_size, 0);
#endif
  
  if (copied < 0) {
    // Fall back to sendfile
    off_t offset = 0;
    copied = sendfile(dst_fd, src_fd, &offset, (size_t)st.st_size);
  }
  
  close(src_fd);
  close(dst_fd);
  
  future->result = (copied < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

#elif defined(__APPLE__)
#include <copyfile.h>

static yo_io_future_t* __yo_async_copyfile_start(const char* src, const char* dst, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;  // COPYFILE_EXCL
  if (flags & 2) cf_flags |= COPYFILE_CLONE;  // COPYFILE_FICLONE
  if (flags & 4) cf_flags |= COPYFILE_CLONE_FORCE;  // COPYFILE_FICLONE_FORCE
  
  int result = copyfile(src, dst, NULL, cf_flags);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}
#endif

// Async sendfile
static yo_io_future_t* __yo_async_sendfile_start(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
#if defined(__linux__)
  off_t off = (off_t)offset;
  ssize_t sent = sendfile(out_fd, in_fd, &off, count);
  future->result = (sent < 0) ? -errno : (int32_t)sent;
#elif defined(__APPLE__)
  off_t len = (off_t)count;
  int result = sendfile(in_fd, out_fd, (off_t)offset, &len, NULL, 0);
  future->result = (result < 0) ? -errno : (int32_t)len;
#endif
  
  atomic_init(&future->state, -1);
  return future;
}

// Statfs support
#include <sys/statvfs.h>

static yo_io_future_t* __yo_async_statfs_start(const char* path, void* buf) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = statvfs(path, (struct statvfs*)buf);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

static size_t __yo_statfs_buf_size(void) {
  return sizeof(struct statvfs);
}

static uint64_t __yo_statfs_type(void* buf) {
  // statvfs doesn't have type, return 0
  (void)buf;
  return 0;
}

static uint64_t __yo_statfs_bsize(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bsize;
}

static uint64_t __yo_statfs_blocks(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_blocks;
}

static uint64_t __yo_statfs_bfree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bfree;
}

static uint64_t __yo_statfs_bavail(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bavail;
}

static uint64_t __yo_statfs_files(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_files;
}

static uint64_t __yo_statfs_ffree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_ffree;
}

// ============================================================================
// Directory Scanning Operations
// ============================================================================

static yo_io_future_t* __yo_async_scandir_start(int32_t dirfd, const char* path) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, just open the directory - actual scanning happens via readdir
  int fd;
  if (dirfd == -100) {
    fd = open(path, O_RDONLY | O_DIRECTORY);
  } else {
    fd = openat(dirfd, path, O_RDONLY | O_DIRECTORY);
  }
  
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_opendir_start(const char* path) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  DIR* dir = opendir(path);
  future->result = dir ? (int32_t)(intptr_t)dir : -errno;
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_readdir_start(void* dir, void* entries, size_t max_entries) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  (void)entries;
  (void)max_entries;
  
  // Read one entry
  struct dirent* entry = readdir((DIR*)dir);
  if (entry) {
    future->result = 1;
  } else {
    future->result = 0;  // No more entries
  }
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_closedir_start(void* dir) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = closedir((DIR*)dir);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

static size_t __yo_dirent_size(void) {
  return sizeof(struct dirent);
}

static uint16_t __yo_dirent_reclen(void* entry) {
#if defined(__linux__)
  return ((struct dirent*)entry)->d_reclen;
#else
  return (uint16_t)((struct dirent*)entry)->d_reclen;
#endif
}

static uint64_t __yo_dirent_ino(void* entry) {
  return (uint64_t)((struct dirent*)entry)->d_ino;
}

#if defined(__linux__)
#include <sys/syscall.h>
static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Use getdents64 syscall directly
  long nread = syscall(SYS_getdents64, fd, buf, buf_size);
  future->result = (nread < 0) ? -errno : (int32_t)nread;
  atomic_init(&future->state, -1);
  
  return future;
}
#elif defined(__APPLE__)
static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // macOS doesn't have getdents; emulate using readdir on a dup()'d fd
  int dup_fd = dup(fd);
  if (dup_fd < 0) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  DIR* dir = fdopendir(dup_fd);
  if (!dir) {
    int err = errno;
    close(dup_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }

  int dir_fd = dirfd(dir);
  size_t total = 0;
  long last_pos = telldir(dir);
  struct dirent* entry = NULL;

  while ((entry = readdir(dir)) != NULL) {
    size_t reclen = (size_t)entry->d_reclen;
    if (entry->d_type == DT_UNKNOWN) {
      struct stat st;
      if (dir_fd >= 0 && fstatat(dir_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        if (S_ISDIR(st.st_mode)) {
          entry->d_type = DT_DIR;
        } else if (S_ISREG(st.st_mode)) {
          entry->d_type = DT_REG;
        } else if (S_ISLNK(st.st_mode)) {
          entry->d_type = DT_LNK;
        } else if (S_ISCHR(st.st_mode)) {
          entry->d_type = DT_CHR;
        } else if (S_ISBLK(st.st_mode)) {
          entry->d_type = DT_BLK;
        } else if (S_ISFIFO(st.st_mode)) {
          entry->d_type = DT_FIFO;
        } else if (S_ISSOCK(st.st_mode)) {
          entry->d_type = DT_SOCK;
        } else {
          entry->d_type = DT_UNKNOWN;
        }
      }
    }
    if (total + reclen > (size_t)buf_size) {
      // Roll back to the previous position so the entry is returned next time
      seekdir(dir, last_pos);
      break;
    }
    memcpy((char*)buf + total, entry, reclen);
    total += reclen;
    last_pos = telldir(dir);
  }

  closedir(dir);  // closes dup_fd
  future->result = (int32_t)total;
  atomic_init(&future->state, -1);
  
  return future;
}
#endif

// ============================================================================
// DNS Operations
// ============================================================================
#include <netdb.h>

static yo_io_future_t* __yo_async_getaddrinfo_start(const uint8_t* node, const uint8_t* service,
                                                     const uint8_t* hints, uint8_t** result) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct addrinfo* res = NULL;
  int ret = getaddrinfo((const char*)node, (const char*)service, (const struct addrinfo*)hints, &res);
  
  if (ret == 0) {
    *result = (uint8_t*)res;
    future->result = 0;
  } else {
    future->result = -ret;  // Return negative gai error code
  }
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_getnameinfo_start(const uint8_t* addr, uint32_t addrlen,
                                                     uint8_t* host, size_t hostlen,
                                                     uint8_t* service, size_t servlen, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int ret = getnameinfo((const struct sockaddr*)addr, (socklen_t)addrlen,
                        (char*)host, (socklen_t)hostlen, (char*)service, (socklen_t)servlen, flags);
  future->result = (ret == 0) ? 0 : -ret;
  atomic_init(&future->state, -1);
  
  return future;
}

static void __yo_freeaddrinfo(uint8_t* res) {
  if (res) freeaddrinfo((struct addrinfo*)res);
}

static size_t __yo_addrinfo_size(void) {
  return sizeof(struct addrinfo);
}

static int32_t __yo_addrinfo_flags(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_flags;
}

static int32_t __yo_addrinfo_family(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_family;
}

static int32_t __yo_addrinfo_socktype(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_socktype;
}

static int32_t __yo_addrinfo_protocol(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_protocol;
}

static uint32_t __yo_addrinfo_addrlen(uint8_t* ai) {
  return (uint32_t)((struct addrinfo*)ai)->ai_addrlen;
}

static uint8_t* __yo_addrinfo_addr(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_addr;
}

static uint8_t* __yo_addrinfo_canonname(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_canonname;
}

static uint8_t* __yo_addrinfo_next(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_next;
}

// ============================================================================
// Signal Operations
// ============================================================================
#include <signal.h>

// Signal handler storage (up to 32 signals)
static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};

static void __yo_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
    __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = (void (*)(void*))handler;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = __yo_signal_trampoline;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  
  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_signal_stop(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = NULL;
  __yo_signal_handler_data[signum] = NULL;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);
  
  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_kill(int32_t pid, int32_t signum) {
  int result = kill((pid_t)pid, signum);
  return (result < 0) ? -errno : 0;
}

// ============================================================================
// TTY Operations
// ============================================================================
#include <termios.h>
#include <sys/ioctl.h>

static struct termios __yo_orig_termios;
static bool __yo_termios_saved = false;

static int32_t __yo_tty_init(int32_t fd) {
  if (!__yo_termios_saved) {
    if (tcgetattr(fd, &__yo_orig_termios) < 0) {
      return -errno;
    }
    __yo_termios_saved = true;
  }
  return 0;
}

static int32_t __yo_tty_set_mode(int32_t fd, int32_t mode) {
  struct termios t;
  if (tcgetattr(fd, &t) < 0) return -errno;
  
  switch (mode) {
    case 0:  // TTY_MODE_NORMAL
      t = __yo_orig_termios;
      break;
    case 1:  // TTY_MODE_RAW
      t.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
      t.c_oflag &= ~(OPOST);
      t.c_cflag |= (CS8);
      t.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
      t.c_cc[VMIN] = 1;
      t.c_cc[VTIME] = 0;
      break;
    case 2:  // TTY_MODE_IO (Unix binary mode)
      t.c_iflag &= ~(ICRNL | IXON);
      t.c_oflag &= ~(OPOST);
      break;
    default:
      return -EINVAL;
  }
  
  if (tcsetattr(fd, TCSAFLUSH, &t) < 0) return -errno;
  return 0;
}

static int32_t __yo_tty_reset_mode(void) {
  if (__yo_termios_saved) {
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &__yo_orig_termios) < 0) {
      return -errno;
    }
  }
  return 0;
}

static int32_t __yo_tty_get_winsize(int32_t fd, int32_t* width, int32_t* height) {
  struct winsize ws;
  if (ioctl(fd, TIOCGWINSZ, &ws) < 0) {
    return -errno;
  }
  *width = ws.ws_col;
  *height = ws.ws_row;
  return 0;
}

static int32_t __yo_isatty(int32_t fd) {
  return isatty(fd) ? 1 : 0;
}

// ============================================================================
// FS Event Operations (placeholder - needs kqueue/inotify)
// ============================================================================

typedef struct {
  int fd;
  void (*callback)(const char*, int, void*);
  void* user_data;
} yo_fs_event_t;

static void* __yo_fs_event_init(void) {
  yo_fs_event_t* handle = (yo_fs_event_t*)__yo_malloc(sizeof(yo_fs_event_t));
  memset(handle, 0, sizeof(yo_fs_event_t));
  return handle;
}

static int32_t __yo_fs_event_start(void* handle, const char* path, uint32_t flags, void* callback) {
  (void)handle;
  (void)path;
  (void)flags;
  (void)callback;
  // TODO: Implement with inotify (Linux) or kqueue (macOS)
  return -ENOTSUP;
}

static int32_t __yo_fs_event_stop(void* handle) {
  (void)handle;
  return 0;
}

static void __yo_fs_event_close(void* handle) {
  if (handle) __yo_free(handle);
}

// ============================================================================
// Poll Operations (placeholder - needs kqueue/epoll)
// ============================================================================

typedef struct {
  int fd;
  int events;
  void (*callback)(int, int, void*);
  void* user_data;
} yo_poll_t;

static void* __yo_poll_init(int32_t fd) {
  yo_poll_t* handle = (yo_poll_t*)__yo_malloc(sizeof(yo_poll_t));
  memset(handle, 0, sizeof(yo_poll_t));
  handle->fd = fd;
  return handle;
}

static int32_t __yo_poll_start(void* handle, int32_t events, void* callback) {
  (void)handle;
  (void)events;
  (void)callback;
  // TODO: Implement with epoll (Linux) or kqueue (macOS)
  return -ENOTSUP;
}

static int32_t __yo_poll_stop(void* handle) {
  (void)handle;
  return 0;
}

static void __yo_poll_close(void* handle) {
  if (handle) __yo_free(handle);
}

#endif // !defined(_WIN32) - End of POSIX-only File Extra Operations
`);
}
