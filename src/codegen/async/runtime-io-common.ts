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

#if defined(__linux__)
#include <sys/sendfile.h>
#elif defined(__APPLE__)
#include <copyfile.h>
#endif

// Fallback for platforms where sendfile cannot handle all fd combinations
// (e.g. macOS sendfile requires socket destination).
#if defined(__linux__) || defined(__APPLE__)
static int32_t __yo_sendfile_fallback_copy(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  unsigned char buffer[65536];
  size_t total = 0;

  while (total < count) {
    size_t remaining = count - total;
    size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);

    ssize_t nread = pread(in_fd, buffer, chunk, (off_t)(offset + (int64_t)total));
    if (nread < 0) {
      return -errno;
    }
    if (nread == 0) {
      break;
    }

    size_t written = 0;
    while (written < (size_t)nread) {
      ssize_t nwrite = write(out_fd, buffer + written, (size_t)nread - written);
      if (nwrite < 0) {
        return -errno;
      }
      written += (size_t)nwrite;
    }

    total += (size_t)nread;
  }

  return (int32_t)total;
}
#endif

// ============================================================================
// Synchronous Operations (POSIX-only) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_access(int32_t dirfd, const char* path, int32_t mode) {
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = access(path, mode);
  } else {
    result = faccessat(dirfd, path, mode, 0);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_realpath(const char* path, char* resolved) {
  char* result = realpath(path, resolved);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkdtemp(char* template) {
  char* result = mkdtemp(template);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkstemp(char* template) {
  int fd = mkstemp(template);
  return (fd < 0) ? -errno : fd;
}

static int32_t __yo_sync_copyfile(const char* src, const char* dst, int32_t flags) {
#if defined(__linux__)
  int src_fd = open(src, O_RDONLY);
  if (src_fd < 0) return -errno;

  struct stat st;
  if (fstat(src_fd, &st) < 0) {
    int err = errno;
    close(src_fd);
    return -err;
  }

  int open_flags = O_WRONLY | O_CREAT | O_TRUNC;
  if (flags & 1) open_flags |= O_EXCL;

  int dst_fd = open(dst, open_flags, st.st_mode);
  if (dst_fd < 0) {
    int err = errno;
    close(src_fd);
    return -err;
  }

  ssize_t copied = 0;
  off_t off_in = 0;
#ifdef __NR_copy_file_range
  copied = syscall(__NR_copy_file_range, src_fd, &off_in, dst_fd, NULL, (size_t)st.st_size, 0);
#endif
  if (copied < 0) {
    off_t offset = 0;
    copied = sendfile(dst_fd, src_fd, &offset, (size_t)st.st_size);
  }

  close(src_fd);
  close(dst_fd);
  return (copied < 0) ? -errno : 0;

#elif defined(__APPLE__)
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;
  if (flags & 2) cf_flags |= COPYFILE_CLONE;
  if (flags & 4) cf_flags |= COPYFILE_CLONE_FORCE;

  int result = copyfile(src, dst, NULL, cf_flags);
  return (result < 0) ? -errno : 0;
#else
  (void)src; (void)dst; (void)flags;
  return -ENOSYS;
#endif
}

static int32_t __yo_sync_sendfile(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
#if defined(__linux__)
  off_t off = (off_t)offset;
  ssize_t sent = sendfile(out_fd, in_fd, &off, count);
  return (sent < 0) ? -errno : (int32_t)sent;
#elif defined(__APPLE__)
  off_t len = (off_t)count;
  int result = sendfile(in_fd, out_fd, (off_t)offset, &len, NULL, 0);
  if (result < 0) {
    if (errno == ENOTSOCK || errno == EINVAL || errno == ENOSYS) {
      return __yo_sendfile_fallback_copy(out_fd, in_fd, offset, count);
    }
    return -errno;
  }
  return (int32_t)len;
#else
  (void)out_fd; (void)in_fd; (void)offset; (void)count;
  return -ENOSYS;
#endif
}

static int32_t __yo_sync_utime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                               int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, 0);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_futime(int32_t fd, int64_t atime_sec, int64_t atime_nsec,
                                int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = futimens(fd, times);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_lutime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, AT_SYMLINK_NOFOLLOW);
  return (result < 0) ? -errno : 0;
}

// Statfs support
#include <sys/statvfs.h>

static int32_t __yo_sync_statfs(const char* path, void* buf) {
  int result = statvfs(path, (struct statvfs*)buf);
  return (result < 0) ? -errno : 0;
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
    future->result = ret;  // Return raw gai error code (already negative on glibc)
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
  future->result = ret;  // Return raw gai error code
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
// Process Operations
// ============================================================================
#include <spawn.h>
#include <sys/wait.h>

extern char** environ;

static yo_io_future_t* __yo_async_spawn_start(const uint8_t* file, uint8_t** argv, uint8_t** envp,
                                              int32_t stdin_fd, int32_t stdout_fd, int32_t stderr_fd) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);

  if (stdin_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stdin_fd, 0);
  }
  if (stdout_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stdout_fd, 1);
  }
  if (stderr_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stderr_fd, 2);
  }

  pid_t pid = 0;
  char* const* envp_actual = envp ? (char* const*)envp : environ;
  int result = posix_spawnp(&pid, (const char*)file, &actions, NULL, (char* const*)argv, envp_actual);
  posix_spawn_file_actions_destroy(&actions);

  if (result != 0) {
    future->result = -result;
  } else {
    future->result = (int32_t)pid;
  }
  atomic_init(&future->state, -1);

  return future;
}

static yo_io_future_t* __yo_async_waitpid_start(int32_t pid, int32_t options) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int status = 0;
  pid_t result = waitpid((pid_t)pid, &status, options);
  if (result < 0) {
    future->result = -errno;
  } else if (result == 0) {
    // WNOHANG and child still running
    future->result = 0;
  } else {
    future->result = status;
  }
  atomic_init(&future->state, -1);

  return future;
}

static int32_t __yo_process_exit_status(int32_t status) {
  if (WIFEXITED(status)) {
    return (int32_t)WEXITSTATUS(status);
  }
  return -1;
}

static int32_t __yo_process_term_signal(int32_t status) {
  if (WIFSIGNALED(status)) {
    return (int32_t)WTERMSIG(status);
  }
  return 0;
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
// FS Event Operations (inotify on Linux, kqueue on macOS)
// ============================================================================

#include <poll.h>
#if defined(__linux__)
#include <sys/inotify.h>
#elif defined(__APPLE__)
#include <sys/event.h>

typedef struct yo_fs_event_entry_s {
  char* name;
  int64_t mtime_sec;
  int64_t mtime_nsec;
  int64_t size;
  struct yo_fs_event_entry_s* next;
} yo_fs_event_entry_t;
#endif

typedef struct yo_fs_event_s {
  int fd;
  int watch_fd;
  void (*callback)(const char*, int, void*);
  void* user_data;
  int active;
#if defined(__APPLE__)
  char* path;
  int is_dir;
  int exists;
  int64_t mtime_sec;
  int64_t mtime_nsec;
  int64_t size;
  yo_fs_event_entry_t* entries;
#endif
  struct yo_fs_event_s* next;
} yo_fs_event_t;

static yo_fs_event_t* __yo_active_fs_events = NULL;

#if defined(__APPLE__)
static void __yo_fs_event_free_entries(yo_fs_event_entry_t* head) {
  while (head) {
    yo_fs_event_entry_t* next = head->next;
    if (head->name) __yo_free(head->name);
    __yo_free(head);
    head = next;
  }
}

static yo_fs_event_entry_t* __yo_fs_event_find_entry(yo_fs_event_entry_t* head, const char* name) {
  while (head) {
    if (strcmp(head->name, name) == 0) {
      return head;
    }
    head = head->next;
  }
  return NULL;
}

static yo_fs_event_entry_t* __yo_fs_event_snapshot_dir(const char* path, int* err_out) {
  *err_out = 0;
  DIR* dir = opendir(path);
  if (!dir) {
    *err_out = errno;
    return NULL;
  }

  yo_fs_event_entry_t* head = NULL;
  struct dirent* ent = NULL;
  while ((ent = readdir(dir)) != NULL) {
    if ((strcmp(ent->d_name, ".") == 0) || (strcmp(ent->d_name, "..") == 0)) {
      continue;
    }

    size_t path_len = strlen(path);
    size_t name_len = strlen(ent->d_name);
    char* full_path = (char*)__yo_malloc(path_len + 1 + name_len + 1);
    memcpy(full_path, path, path_len);
    full_path[path_len] = '/';
    memcpy(full_path + path_len + 1, ent->d_name, name_len + 1);

    struct stat st;
    if (stat(full_path, &st) == 0) {
      yo_fs_event_entry_t* node = (yo_fs_event_entry_t*)__yo_malloc(sizeof(yo_fs_event_entry_t));
      memset(node, 0, sizeof(yo_fs_event_entry_t));
      node->name = (char*)__yo_malloc(name_len + 1);
      memcpy(node->name, ent->d_name, name_len + 1);
      node->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
      node->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
      node->size = (int64_t)st.st_size;
      node->next = head;
      head = node;
    }

    __yo_free(full_path);
  }

  closedir(dir);
  return head;
}

static int __yo_fs_event_detect_snapshot_changes(yo_fs_event_t* handle) {
  int yo_event = 0;

  if (handle->is_dir) {
    int snap_err = 0;
    yo_fs_event_entry_t* next_entries = __yo_fs_event_snapshot_dir(handle->path, &snap_err);
    if (snap_err != 0) {
      if (snap_err == ENOENT) {
        yo_event |= 1; // FS_EVENT_RENAME
      }
      return yo_event;
    }

    yo_fs_event_entry_t* ne = next_entries;
    while (ne) {
      yo_fs_event_entry_t* oe = __yo_fs_event_find_entry(handle->entries, ne->name);
      if (!oe) {
        yo_event |= 1; // FS_EVENT_RENAME (create)
      } else if ((oe->mtime_sec != ne->mtime_sec) ||
                 (oe->mtime_nsec != ne->mtime_nsec) ||
                 (oe->size != ne->size)) {
        yo_event |= 2; // FS_EVENT_CHANGE (modify)
      }
      ne = ne->next;
    }

    yo_fs_event_entry_t* oe = handle->entries;
    while (oe) {
      if (!__yo_fs_event_find_entry(next_entries, oe->name)) {
        yo_event |= 1; // FS_EVENT_RENAME (delete)
      }
      oe = oe->next;
    }

    __yo_fs_event_free_entries(handle->entries);
    handle->entries = next_entries;
    return yo_event;
  }

  struct stat st;
  if (stat(handle->path, &st) < 0) {
    if (errno == ENOENT && handle->exists) {
      handle->exists = 0;
      return 1; // FS_EVENT_RENAME (delete)
    }
    return 0;
  }

  if (!handle->exists) {
    handle->exists = 1;
    handle->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
    handle->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
    handle->size = (int64_t)st.st_size;
    return 1; // FS_EVENT_RENAME (create)
  }

  if ((handle->mtime_sec != (int64_t)st.st_mtimespec.tv_sec) ||
      (handle->mtime_nsec != (int64_t)st.st_mtimespec.tv_nsec) ||
      (handle->size != (int64_t)st.st_size)) {
    handle->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
    handle->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
    handle->size = (int64_t)st.st_size;
    return 2; // FS_EVENT_CHANGE
  }

  return 0;
}
#endif

static void* __yo_fs_event_init(void) {
  yo_fs_event_t* handle = (yo_fs_event_t*)__yo_malloc(sizeof(yo_fs_event_t));
  memset(handle, 0, sizeof(yo_fs_event_t));
  handle->fd = -1;
  handle->watch_fd = -1;
#if defined(__APPLE__)
  handle->path = NULL;
  handle->entries = NULL;
#endif
  return handle;
}

static int32_t __yo_fs_event_start(void* h, const char* path, uint32_t flags, void* callback, void* user_data) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle || !path || !callback) return -EINVAL;

#if defined(__linux__)
  handle->fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  if (handle->fd < 0) return -errno;

  uint32_t mask = IN_MODIFY | IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_ATTRIB;
  if (flags & 4) mask |= IN_ISDIR; // FS_EVENT_RECURSIVE hint (inotify doesn't do recursive natively)
  handle->watch_fd = inotify_add_watch(handle->fd, path, mask);
  if (handle->watch_fd < 0) {
    int err = errno;
    close(handle->fd);
    handle->fd = -1;
    return -err;
  }
#elif defined(__APPLE__)
  handle->path = (char*)__yo_malloc(strlen(path) + 1);
  strcpy(handle->path, path);

  struct stat path_st;
  if (stat(path, &path_st) < 0) {
    int err = errno;
    __yo_free(handle->path);
    handle->path = NULL;
    return -err;
  }
  handle->is_dir = S_ISDIR(path_st.st_mode) ? 1 : 0;
  handle->exists = 1;
  handle->mtime_sec = (int64_t)path_st.st_mtimespec.tv_sec;
  handle->mtime_nsec = (int64_t)path_st.st_mtimespec.tv_nsec;
  handle->size = (int64_t)path_st.st_size;

  if (handle->is_dir) {
    int snap_err = 0;
    handle->entries = __yo_fs_event_snapshot_dir(path, &snap_err);
    if (snap_err != 0) {
      __yo_free(handle->path);
      handle->path = NULL;
      return -snap_err;
    }
  }

  // Open the path to get an fd for kqueue EVFILT_VNODE
  handle->fd = open(path, O_EVTONLY | O_CLOEXEC);
  if (handle->fd < 0) {
    int err = errno;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }

  handle->watch_fd = kqueue();
  if (handle->watch_fd < 0) {
    int err = errno;
    close(handle->fd);
    handle->fd = -1;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }

  // Register EVFILT_VNODE for common file/directory changes
  struct kevent ev;
  unsigned int fflags = NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_ATTRIB | NOTE_EXTEND;
  EV_SET(&ev, handle->fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, fflags, 0, NULL);
  if (kevent(handle->watch_fd, &ev, 1, NULL, 0, NULL) < 0) {
    int err = errno;
    close(handle->watch_fd);
    close(handle->fd);
    handle->fd = -1;
    handle->watch_fd = -1;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }
#else
  return -ENOTSUP;
#endif

  handle->callback = (void (*)(const char*, int, void*))callback;
  handle->user_data = user_data;
  handle->active = 1;

  // Add to linked list
  handle->next = __yo_active_fs_events;
  __yo_active_fs_events = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_fs_event_stop(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

#if defined(__linux__)
  if (handle->watch_fd >= 0 && handle->fd >= 0) {
    inotify_rm_watch(handle->fd, handle->watch_fd);
    handle->watch_fd = -1;
  }
  if (handle->fd >= 0) {
    close(handle->fd);
    handle->fd = -1;
  }
#elif defined(__APPLE__)
  if (handle->watch_fd >= 0) {
    close(handle->watch_fd);
    handle->watch_fd = -1;
  }
  if (handle->fd >= 0) {
    close(handle->fd);
    handle->fd = -1;
  }
  if (handle->entries) {
    __yo_fs_event_free_entries(handle->entries);
    handle->entries = NULL;
  }
  if (handle->path) {
    __yo_free(handle->path);
    handle->path = NULL;
  }
#endif

  // Remove from linked list
  yo_fs_event_t** pp = &__yo_active_fs_events;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_fs_event_close(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return;
  if (handle->active) __yo_fs_event_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Poll Operations (POSIX poll() on Linux/macOS)
// ============================================================================

typedef struct yo_poll_s {
  int fd;
  int events;
  void (*callback)(int, int, void*);
  void* user_data;
  int active;
  struct yo_poll_s* next;
} yo_poll_t;

static yo_poll_t* __yo_active_polls = NULL;

static void* __yo_poll_init(int32_t fd) {
  yo_poll_t* handle = (yo_poll_t*)__yo_malloc(sizeof(yo_poll_t));
  memset(handle, 0, sizeof(yo_poll_t));
  handle->fd = fd;
  return handle;
}

static int32_t __yo_poll_start(void* h, int32_t events, void* callback, void* user_data) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle || !callback) return -EINVAL;

  handle->events = events;
  handle->callback = (void (*)(int, int, void*))callback;
  handle->user_data = user_data;
  handle->active = 1;

  // Add to linked list
  handle->next = __yo_active_polls;
  __yo_active_polls = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_poll_stop(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

  // Remove from linked list
  yo_poll_t** pp = &__yo_active_polls;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_poll_close(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return;
  if (handle->active) __yo_poll_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Tick function: check all active poll and fs_event handles (non-blocking)
// Called from __yo_io_poll() in platform-specific runtime files.
// ============================================================================

static int __yo_poll_and_fs_event_tick(void) {
  int count = 0;

  // --- Tick FS event handles ---
#if defined(__linux__)
  {
    yo_fs_event_t* fse = __yo_active_fs_events;
    while (fse) {
      yo_fs_event_t* next = fse->next;
      if (fse->active && fse->fd >= 0) {
        char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
        ssize_t len = read(fse->fd, buf, sizeof(buf));
        if (len > 0) {
          char* ptr = buf;
          while (ptr < buf + len) {
            struct inotify_event* event = (struct inotify_event*)ptr;
            int yo_event = 0;
            if (event->mask & (IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO)) {
              yo_event = 1; // FS_EVENT_RENAME
            }
            if (event->mask & (IN_MODIFY | IN_ATTRIB)) {
              yo_event |= 2; // FS_EVENT_CHANGE
            }
            const char* name = (event->len > 0) ? event->name : "";
            if (fse->callback && fse->active) {
              fse->callback(name, yo_event, fse->user_data);
              count++;
            }
            ptr += sizeof(struct inotify_event) + event->len;
          }
        }
      }
      fse = next;
    }
  }
#elif defined(__APPLE__)
  {
    yo_fs_event_t* fse = __yo_active_fs_events;
    while (fse) {
      yo_fs_event_t* next = fse->next;
      if (fse->active && fse->watch_fd >= 0) {
        int yo_event = __yo_fs_event_detect_snapshot_changes(fse);

        struct kevent ev;
        struct timespec ts = {0, 0}; // Non-blocking
        int n = kevent(fse->watch_fd, NULL, 0, &ev, 1, &ts);
        if (n > 0) {
          if (ev.fflags & (NOTE_DELETE | NOTE_RENAME)) {
            yo_event |= 1; // FS_EVENT_RENAME
          }
          if (ev.fflags & (NOTE_WRITE | NOTE_ATTRIB | NOTE_EXTEND)) {
            yo_event |= 2; // FS_EVENT_CHANGE
          }
        }

        if (yo_event != 0) {
          if (fse->callback && fse->active) {
            fse->callback("", yo_event, fse->user_data);
            count++;
          }
        }
      }
      fse = next;
    }
  }
#endif

  // --- Tick poll handles ---
  {
    yo_poll_t* ph = __yo_active_polls;
    while (ph) {
      yo_poll_t* next = ph->next;
      if (ph->active) {
        struct pollfd pfd;
        pfd.fd = ph->fd;
        pfd.events = 0;
        if (ph->events & 1) pfd.events |= POLLIN;   // POLL_READABLE
        if (ph->events & 2) pfd.events |= POLLOUT;  // POLL_WRITABLE
        if (ph->events & 8) pfd.events |= POLLPRI;  // POLL_PRIORITIZED
        pfd.revents = 0;

        int ret = poll(&pfd, 1, 0); // Non-blocking
        if (ret > 0) {
          int yo_events = 0;
          if (pfd.revents & POLLIN)  yo_events |= 1; // POLL_READABLE
          if (pfd.revents & POLLOUT) yo_events |= 2; // POLL_WRITABLE
          if (pfd.revents & POLLHUP) yo_events |= 4; // POLL_DISCONNECT
          if (pfd.revents & POLLPRI) yo_events |= 8; // POLL_PRIORITIZED
          if (ph->callback && ph->active) {
            ph->callback(yo_events, 0, ph->user_data);
            count++;
          }
        } else if (ret < 0) {
          if (ph->callback && ph->active) {
            ph->callback(0, -errno, ph->user_data);
            count++;
          }
        }
      }
      ph = next;
    }
  }

  return count;
}

#endif // !defined(_WIN32) - End of POSIX-only File Extra Operations
`);
}
