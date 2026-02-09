/**
 * runtime-io-windows.ts
 *
 * Windows async I/O backend using IOCP.
 * Provides async read/write via overlapped I/O and synchronous wrappers for other operations.
 */

import { Emitter } from "../../emitter";

export function generateAsyncRuntimeIOWindows(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// Async I/O Runtime (Windows - IOCP)
// ============================================================================

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <direct.h>
#include <stdlib.h>
#include <errno.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>


#ifndef DT_UNKNOWN
#define DT_UNKNOWN 0
#endif
#ifndef DT_DIR
#define DT_DIR 4
#endif
#ifndef DT_REG
#define DT_REG 8
#endif
#ifndef DT_LNK
#define DT_LNK 10
#endif
#ifndef DT_FIFO
#define DT_FIFO 1
#endif
#ifndef DT_CHR
#define DT_CHR 2
#endif
#ifndef DT_BLK
#define DT_BLK 6
#endif
#ifndef DT_SOCK
#define DT_SOCK 12
#endif

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif
#ifndef AT_REMOVEDIR
#define AT_REMOVEDIR 0x200
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif
#ifndef SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
#define SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE 0x2
#endif

static bool __yo_io_initialized = false;
static _Atomic size_t __yo_pending_io_count = 0;
static HANDLE __yo_io_iocp = NULL;
static CRITICAL_SECTION __yo_dir_state_mutex;

typedef struct yo_win_timer_entry_t {
  uint64_t due_ms;
  yo_io_future_t* future;
  struct yo_win_timer_entry_t* next;
} yo_win_timer_entry_t;

static yo_win_timer_entry_t* __yo_win_timer_head = NULL;

typedef struct {
  OVERLAPPED overlapped;
  yo_io_future_t* future;
  HANDLE handle;
  bool is_socket;
  SOCKET sock;
} yo_win_overlapped_t;

static bool __yo_is_at_fdcwd(int32_t dirfd) {
  return (dirfd == -100 || dirfd == -2);
}

static int __yo_win_last_error_to_errno(void) {
  DWORD err = GetLastError();
  errno = (int)err;
  return (int)err;
}

static int __yo_win_error_to_errno(DWORD err) {
  errno = (int)err;
  return (int)err;
}

static wchar_t* __yo_win_utf8_to_wide(const char* str) {
  if (!str) return NULL;
  int len = MultiByteToWideChar(CP_UTF8, 0, str, -1, NULL, 0);
  if (len <= 0) return NULL;
  wchar_t* buf = (wchar_t*)__yo_malloc((size_t)len * sizeof(wchar_t));
  if (!buf) return NULL;
  if (!MultiByteToWideChar(CP_UTF8, 0, str, -1, buf, len)) {
    __yo_free(buf);
    return NULL;
  }
  return buf;
}

static int __yo_win_wide_to_utf8(const wchar_t* wstr, char* out, size_t out_size) {
  if (!wstr || !out || out_size == 0) return -EINVAL;
  int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, out, (int)out_size, NULL, NULL);
  if (len <= 0) {
    return -__yo_win_last_error_to_errno();
  }
  return len - 1;
}

static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  InitializeCriticalSection(&__yo_dir_state_mutex);
  __yo_io_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (!__yo_io_iocp) {
    ASYNC_DEBUG("[IO] CreateIoCompletionPort failed: %lu\\n", GetLastError());
  }

  WSADATA wsa;
  int wsa_result = WSAStartup(MAKEWORD(2, 2), &wsa);
  if (wsa_result != 0) {
    ASYNC_DEBUG("[IO] WSAStartup failed: %d\\n", wsa_result);
  }

  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] Windows async runtime initialized\\n");
}

static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  if (__yo_io_iocp) {
    CloseHandle(__yo_io_iocp);
    __yo_io_iocp = NULL;
  }
  while (__yo_win_timer_head) {
    yo_win_timer_entry_t* node = __yo_win_timer_head;
    __yo_win_timer_head = node->next;
    __yo_free(node);
  }
  DeleteCriticalSection(&__yo_dir_state_mutex);
  WSACleanup();
  __yo_io_initialized = false;
}

static bool __yo_win_associate_handle(HANDLE handle) {
  if (!__yo_io_iocp) return false;
  HANDLE res = CreateIoCompletionPort(handle, __yo_io_iocp, 0, 0);
  return res != NULL;
}

static inline bool __yo_has_pending_io(void) {
  return atomic_load(&__yo_pending_io_count) > 0;
}

static void __yo_io_wake_continuation(yo_io_future_t* future) {
  atomic_store_explicit(&future->state, -1, memory_order_release);

  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);

  if (cont_fn && cont_sm) {
    yo_async_spawn_task(cont_fn, cont_sm);
  }

  atomic_fetch_sub(&__yo_pending_io_count, 1);
}

static uint64_t __yo_win_now_ms(void) {
  return (uint64_t)GetTickCount64();
}

static void __yo_win_timer_add(yo_io_future_t* future, uint64_t milliseconds) {
  atomic_fetch_add(&__yo_pending_io_count, 1);

  yo_win_timer_entry_t* node = (yo_win_timer_entry_t*)__yo_malloc(sizeof(yo_win_timer_entry_t));
  if (!node) {
    future->result = -ENOMEM;
    __yo_io_wake_continuation(future);
    return;
  }

  uint64_t now_ms = __yo_win_now_ms();
  node->due_ms = now_ms + milliseconds;
  node->future = future;
  node->next = NULL;

  if (!__yo_win_timer_head || node->due_ms < __yo_win_timer_head->due_ms) {
    node->next = __yo_win_timer_head;
    __yo_win_timer_head = node;
    return;
  }

  yo_win_timer_entry_t* cur = __yo_win_timer_head;
  while (cur->next && cur->next->due_ms <= node->due_ms) {
    cur = cur->next;
  }
  node->next = cur->next;
  cur->next = node;
}

static int __yo_win_timer_process_due(uint64_t now_ms) {
  int fired = 0;
  while (__yo_win_timer_head && __yo_win_timer_head->due_ms <= now_ms) {
    yo_win_timer_entry_t* node = __yo_win_timer_head;
    __yo_win_timer_head = node->next;
    node->future->result = (int32_t)sizeof(uint64_t);
    __yo_io_wake_continuation(node->future);
    __yo_free(node);
    fired++;
  }
  return fired;
}

static DWORD __yo_win_timer_next_timeout(uint64_t now_ms) {
  if (!__yo_win_timer_head) return INFINITE;
  if (__yo_win_timer_head->due_ms <= now_ms) return 0;
  uint64_t delta = __yo_win_timer_head->due_ms - now_ms;
  if (delta > 0xFFFFFFFFULL) return 0xFFFFFFFFU;
  return (DWORD)delta;
}

static void __yo_win_process_completion(yo_win_overlapped_t* ov, DWORD bytes) {
  if (!ov) return;

  if (ov->is_socket) {
    DWORD flags = 0;
    DWORD transferred = bytes;
    BOOL ok = WSAGetOverlappedResult(ov->sock, &ov->overlapped, &transferred, FALSE, &flags);
    if (!ok) {
      ov->future->result = -(int32_t)WSAGetLastError();
    } else {
      ov->future->result = (int32_t)transferred;
    }
  } else {
    DWORD transferred = bytes;
    BOOL ok = GetOverlappedResult(ov->handle, &ov->overlapped, &transferred, FALSE);
    if (!ok) {
      DWORD err = GetLastError();
      if (err == ERROR_HANDLE_EOF) {
        ov->future->result = 0;
      } else {
        ov->future->result = -__yo_win_error_to_errno(err);
      }
    } else {
      ov->future->result = (int32_t)transferred;
    }
  }

  __yo_io_wake_continuation(ov->future);
  __yo_free(ov);
}

static int __yo_io_poll(void) {
  if (!__yo_io_iocp) return 0;

  OVERLAPPED_ENTRY entries[64];
  ULONG count = 0;
  BOOL ok = GetQueuedCompletionStatusEx(__yo_io_iocp, entries, 64, &count, 0, FALSE);
  if (!ok && GetLastError() == WAIT_TIMEOUT) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }
  if (!ok) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }

  int processed = 0;
  for (ULONG i = 0; i < count; i++) {
    if (!entries[i].lpOverlapped) continue;
    __yo_win_process_completion((yo_win_overlapped_t*)entries[i].lpOverlapped,
                                entries[i].dwNumberOfBytesTransferred);
    processed++;
  }
  processed += __yo_win_timer_process_due(__yo_win_now_ms());
  return processed;
}

static int __yo_io_wait(void) {
  if (!__yo_io_iocp || atomic_load(&__yo_pending_io_count) == 0) return 0;

  DWORD bytes = 0;
  ULONG_PTR key = 0;
  OVERLAPPED* ov = NULL;
  DWORD timeout_ms = __yo_win_timer_next_timeout(__yo_win_now_ms());
  BOOL ok = GetQueuedCompletionStatus(__yo_io_iocp, &bytes, &key, &ov, timeout_ms);
  if (!ok && GetLastError() == WAIT_TIMEOUT) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }
  if (!ok) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }
  if (!ov) return 0;

  __yo_win_process_completion((yo_win_overlapped_t*)ov, bytes);
  return 1 + __yo_win_timer_process_due(__yo_win_now_ms());
}

// ============================================================================
// File Operations (Windows)
// ============================================================================

static yo_win_overlapped_t* __yo_win_alloc_overlapped(yo_io_future_t* future, HANDLE handle, uint64_t offset) {
  yo_win_overlapped_t* ov = (yo_win_overlapped_t*)__yo_malloc(sizeof(yo_win_overlapped_t));
  if (!ov) return NULL;
  memset(ov, 0, sizeof(yo_win_overlapped_t));
  ov->future = future;
  ov->handle = handle;
  ov->is_socket = false;
  ov->sock = INVALID_SOCKET;
  ov->overlapped.Offset = (DWORD)(offset & 0xFFFFFFFF);
  ov->overlapped.OffsetHigh = (DWORD)((offset >> 32) & 0xFFFFFFFF);
  return ov;
}

static DWORD __yo_win_access_flags(int32_t flags) {
  if ((flags & O_RDWR) == O_RDWR) return GENERIC_READ | GENERIC_WRITE;
  if (flags & O_WRONLY) return GENERIC_WRITE;
  return GENERIC_READ;
}

static DWORD __yo_win_creation_flags(int32_t flags) {
  if (flags & O_CREAT) {
    if (flags & O_EXCL) return CREATE_NEW;
    if (flags & O_TRUNC) return CREATE_ALWAYS;
    return OPEN_ALWAYS;
  }
  if (flags & O_TRUNC) return TRUNCATE_EXISTING;
  return OPEN_EXISTING;
}

static yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }
  if (!__yo_win_associate_handle(handle)) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_store(&future->state, -1);
    return future;
  }

  yo_win_overlapped_t* ov = __yo_win_alloc_overlapped(future, handle, offset);
  if (!ov) {
    future->result = -ENOMEM;
    atomic_store(&future->state, -1);
    return future;
  }

  BOOL ok = ReadFile(handle, buffer, (DWORD)size, NULL, &ov->overlapped);
  if (!ok) {
    DWORD err = GetLastError();
    if (err != ERROR_IO_PENDING) {
      __yo_free(ov);
      future->result = -__yo_win_error_to_errno(err);
      atomic_store(&future->state, -1);
      return future;
    }
  }

  atomic_fetch_add(&__yo_pending_io_count, 1);
  return future;
}

static yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }
  if (!__yo_win_associate_handle(handle)) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_store(&future->state, -1);
    return future;
  }

  yo_win_overlapped_t* ov = __yo_win_alloc_overlapped(future, handle, offset);
  if (!ov) {
    future->result = -ENOMEM;
    atomic_store(&future->state, -1);
    return future;
  }

  BOOL ok = WriteFile(handle, buffer, (DWORD)size, NULL, &ov->overlapped);
  if (!ok) {
    DWORD err = GetLastError();
    if (err != ERROR_IO_PENDING) {
      __yo_free(ov);
      future->result = -__yo_win_error_to_errno(err);
      atomic_store(&future->state, -1);
      return future;
    }
  }

  atomic_fetch_add(&__yo_pending_io_count, 1);
  return future;
}

static yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD access = __yo_win_access_flags(flags);
  DWORD creation = __yo_win_creation_flags(flags);
  DWORD attrs = FILE_ATTRIBUTE_NORMAL;
  if (flags & O_DIRECTORY) {
    attrs |= FILE_FLAG_BACKUP_SEMANTICS;
  }
  attrs |= FILE_FLAG_OVERLAPPED;

  HANDLE handle = CreateFileW(wpath, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, creation, attrs, NULL);
  __yo_free(wpath);

  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  if (!__yo_win_associate_handle(handle)) {
    CloseHandle(handle);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int fd = _open_osfhandle((intptr_t)handle, flags);
  if (fd < 0) {
    CloseHandle(handle);
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  (void)mode;
  future->result = fd;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _close(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = -1;
  if (__yo_is_at_fdcwd(dirfd)) {
    wchar_t* wpath = __yo_win_utf8_to_wide(path);
    if (!wpath) {
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }
    (void)flags;
    (void)mask;
    result = _wstat64(wpath, (struct _stat64*)statxbuf);
    __yo_free(wpath);
  } else {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  (void)mode;
  int result = _wmkdir(wpath);
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result;
  if (flags & AT_REMOVEDIR) {
    result = _wrmdir(wpath);
  } else {
    result = _wunlink(wpath);
  }
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(olddirfd) || !__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wold = __yo_win_utf8_to_wide(oldpath);
  wchar_t* wnew = __yo_win_utf8_to_wide(newpath);
  if (!wold || !wnew) {
    if (wold) __yo_free(wold);
    if (wnew) __yo_free(wnew);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _wrename(wold, wnew);
  __yo_free(wold);
  __yo_free(wnew);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wtarget = __yo_win_utf8_to_wide(target);
  wchar_t* wlink = __yo_win_utf8_to_wide(linkpath);
  if (!wtarget || !wlink) {
    if (wtarget) __yo_free(wtarget);
    if (wlink) __yo_free(wlink);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD attrs = GetFileAttributesW(wtarget);
  DWORD flags = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
  if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    flags |= SYMBOLIC_LINK_FLAG_DIRECTORY;
  }

  BOOL ok = CreateSymbolicLinkW(wlink, wtarget, flags);
  __yo_free(wtarget);
  __yo_free(wlink);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(olddirfd) || !__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  (void)flags;
  wchar_t* wold = __yo_win_utf8_to_wide(oldpath);
  wchar_t* wnew = __yo_win_utf8_to_wide(newpath);
  if (!wold || !wnew) {
    if (wold) __yo_free(wold);
    if (wnew) __yo_free(wnew);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  BOOL ok = CreateHardLinkW(wnew, wold, NULL);
  __yo_free(wold);
  __yo_free(wnew);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _commit(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  return __yo_async_fsync_start(fd);
}

static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _chsize_s(fd, (size_t)length);
  future->result = (result != 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fchmod_start(int32_t fd, uint32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t path_buf[MAX_PATH];
  DWORD len = GetFinalPathNameByHandleW(handle, path_buf, MAX_PATH, FILE_NAME_NORMALIZED);
  if (len == 0 || len >= MAX_PATH) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _wchmod(path_buf, (int)mode);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fchmodat_start(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  (void)flags;
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _wchmod(wpath, (int)mode);
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fchown_start(int32_t fd, uint32_t uid, uint32_t gid) {
  __yo_io_init();
  (void)fd; (void)uid; (void)gid;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fchownat_start(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  __yo_io_init();
  (void)dirfd; (void)path; (void)uid; (void)gid; (void)flags;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_readlinkat_start(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  HANDLE handle = CreateFileW(wpath, 0,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                              NULL);
  __yo_free(wpath);

  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t wbuf[MAX_PATH];
  DWORD len = GetFinalPathNameByHandleW(handle, wbuf, MAX_PATH, FILE_NAME_NORMALIZED);
  CloseHandle(handle);
  if (len == 0 || len >= MAX_PATH) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int written = __yo_win_wide_to_utf8(wbuf, buf, bufsize);
  future->result = (written < 0) ? written : written;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_dup_start(int32_t oldfd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _dup(oldfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_dup2_start(int32_t oldfd, int32_t newfd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _dup2(oldfd, newfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_pipe_start(int32_t* pipefd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _pipe(pipefd, 4096, _O_BINARY);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

// ============================================================================
// Directory Listing (Windows)
// ============================================================================

typedef struct {
  uint16_t d_reclen;
  uint8_t d_type;
  uint8_t _pad;
  uint64_t d_ino;
  char d_name[1];
} yo_win_dirent_t;

typedef struct yo_win_dir_state_t {
  int32_t fd;
  HANDLE find_handle;
  WIN32_FIND_DATAW find_data;
  bool has_data;
  int phase;
  wchar_t* pattern;
  struct yo_win_dir_state_t* next;
} yo_win_dir_state_t;

static yo_win_dir_state_t* __yo_dir_state_head = NULL;

static yo_win_dir_state_t* __yo_win_get_dir_state(int32_t fd) {
  EnterCriticalSection(&__yo_dir_state_mutex);
  yo_win_dir_state_t* node = __yo_dir_state_head;
  while (node) {
    if (node->fd == fd) {
      LeaveCriticalSection(&__yo_dir_state_mutex);
      return node;
    }
    node = node->next;
  }

  node = (yo_win_dir_state_t*)__yo_malloc(sizeof(yo_win_dir_state_t));
  memset(node, 0, sizeof(yo_win_dir_state_t));
  node->fd = fd;
  node->find_handle = INVALID_HANDLE_VALUE;
  node->has_data = false;
  node->phase = 0;
  node->pattern = NULL;
  node->next = __yo_dir_state_head;
  __yo_dir_state_head = node;
  LeaveCriticalSection(&__yo_dir_state_mutex);
  return node;
}

static size_t __yo_win_dirent_write(char* buf, size_t buf_size, const char* name, uint8_t dtype) {
  size_t name_len = strlen(name);
  size_t base = offsetof(yo_win_dirent_t, d_name);
  size_t reclen = base + name_len + 1;
  size_t aligned = (reclen + 7) & ~((size_t)7);
  if (aligned > buf_size) return 0;

  yo_win_dirent_t* ent = (yo_win_dirent_t*)buf;
  ent->d_reclen = (uint16_t)aligned;
  ent->d_type = dtype;
  ent->d_ino = 0;
  memcpy(ent->d_name, name, name_len + 1);
  return aligned;
}

static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (buf_size == 0) {
    future->result = 0;
    atomic_init(&future->state, -1);
    return future;
  }

  yo_win_dir_state_t* state = __yo_win_get_dir_state(fd);
  if (state->find_handle == INVALID_HANDLE_VALUE && !state->pattern) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
      future->result = -EBADF;
      atomic_init(&future->state, -1);
      return future;
    }

    wchar_t path_buf[MAX_PATH];
    DWORD len = GetFinalPathNameByHandleW(handle, path_buf, MAX_PATH, FILE_NAME_NORMALIZED);
    if (len == 0 || len >= MAX_PATH) {
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }

    size_t path_len = wcslen(path_buf);
    wchar_t* pattern = (wchar_t*)__yo_malloc((path_len + 3) * sizeof(wchar_t));
    wcscpy(pattern, path_buf);
    if (pattern[path_len - 1] != L'\\\\' && pattern[path_len - 1] != L'/') {
      pattern[path_len] = L'\\\\';
      pattern[path_len + 1] = L'*';
      pattern[path_len + 2] = L'\\0';
    } else {
      pattern[path_len] = L'*';
      pattern[path_len + 1] = L'\\0';
    }
    state->pattern = pattern;

    state->find_handle = FindFirstFileW(state->pattern, &state->find_data);
    if (state->find_handle == INVALID_HANDLE_VALUE) {
      future->result = 0;  // No entries
      atomic_init(&future->state, -1);
      return future;
    }
    state->has_data = true;
    state->phase = 0;
  }

  size_t total = 0;
  char* out = (char*)buf;

  while (total < buf_size) {
    if (state->phase == 0) {
      size_t written = __yo_win_dirent_write(out + total, buf_size - total, ".", DT_DIR);
      if (!written) break;
      total += written;
      state->phase = 1;
      continue;
    }

    if (state->phase == 1) {
      size_t written = __yo_win_dirent_write(out + total, buf_size - total, "..", DT_DIR);
      if (!written) break;
      total += written;
      state->phase = 2;
      continue;
    }

    if (!state->has_data) {
      break;
    }

    char name_buf[MAX_PATH];
    if (__yo_win_wide_to_utf8(state->find_data.cFileName, name_buf, sizeof(name_buf)) < 0) {
      state->has_data = false;
      break;
    }

    uint8_t dtype = (state->find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? DT_DIR : DT_REG;
    size_t written = __yo_win_dirent_write(out + total, buf_size - total, name_buf, dtype);
    if (!written) break;
    total += written;

    if (!FindNextFileW(state->find_handle, &state->find_data)) {
      FindClose(state->find_handle);
      state->find_handle = INVALID_HANDLE_VALUE;
      state->has_data = false;
    }
  }

  if (total == 0 && !state->has_data) {
    future->result = 0;
  } else {
    future->result = (int32_t)total;
  }
  atomic_init(&future->state, -1);
  return future;
}

static size_t __yo_dirent_size(void) {
  return sizeof(yo_win_dirent_t);
}

static uint16_t __yo_dirent_reclen(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_reclen;
}

static uint8_t __yo_dirent_type(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_type;
}

static const char* __yo_dirent_name(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_name;
}

static uint64_t __yo_dirent_ino(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_ino;
}

// ============================================================================
// Socket Operations (Windows)
// ============================================================================

static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  SOCKET s = WSASocketW(domain, type, protocol, NULL, 0, WSA_FLAG_OVERLAPPED);
  if (s == INVALID_SOCKET) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    future->result = (int32_t)(uintptr_t)s;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = bind((SOCKET)(uintptr_t)sockfd, (const struct sockaddr*)addr, (int)addrlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = listen((SOCKET)(uintptr_t)sockfd, backlog);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int len = (int)(*addrlen);
  SOCKET result = accept((SOCKET)(uintptr_t)sockfd, (struct sockaddr*)addr, &len);
  if (result == INVALID_SOCKET) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    *addrlen = (uint32_t)len;
    future->result = (int32_t)(uintptr_t)result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = connect((SOCKET)(uintptr_t)sockfd, (const struct sockaddr*)addr, (int)addrlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int result = send((SOCKET)(uintptr_t)sockfd, (const char*)buf, (int)len, flags);
    future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int result = recv((SOCKET)(uintptr_t)sockfd, (char*)buf, (int)len, flags);
    future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int result = sendto((SOCKET)(uintptr_t)sockfd, (const char*)buf, (int)len, flags,
                        (const struct sockaddr*)dest_addr, (int)addrlen);
    future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int alen = (int)(*addrlen);
    int result = recvfrom((SOCKET)(uintptr_t)sockfd, (char*)buf, (int)len, flags,
                          (struct sockaddr*)src_addr, &alen);
    if (result == SOCKET_ERROR) {
      future->result = -(int32_t)WSAGetLastError();
    } else {
      *addrlen = (uint32_t)alen;
      future->result = result;
    }
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = shutdown((SOCKET)(uintptr_t)sockfd, how);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname, const void* optval, uint32_t optlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = setsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (const char*)optval, (int)optlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname, void* optval, uint32_t* optlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int len = (int)(*optlen);
  int result = getsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (char*)optval, &len);
  if (result == SOCKET_ERROR) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    *optlen = (uint32_t)len;
    future->result = 0;
  }
  atomic_init(&future->state, -1);
  return future;
}

// ============================================================================
// Synchronous File Helpers (Windows)
// ============================================================================

static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  int fd = _wopen(wpath, flags, mode);
  __yo_free(wpath);
  return (fd < 0) ? -errno : fd;
}

static void __yo_file_close(int32_t fd) {
  _close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct _stat64 st;
  if (_fstat64(fd, &st) < 0) return -1;
  return (int64_t)st.st_size;
}

// ============================================================================
// Stat Buffer Accessors (Windows)
// ============================================================================

static size_t __yo_statx_buf_size(void) {
  return sizeof(struct _stat64);
}

static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct _stat64*)statxbuf)->st_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct _stat64*)statxbuf)->st_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct _stat64*)statxbuf)->st_mtime;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return 0;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct _stat64*)statxbuf)->st_atime;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return 0;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct _stat64*)statxbuf)->st_ctime;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return 0;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct _stat64*)statxbuf)->st_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct _stat64*)statxbuf)->st_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct _stat64*)statxbuf)->st_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)((struct _stat64*)statxbuf)->st_dev;
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct _stat64*)statxbuf)->st_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

// ============================================================================
// Socket Address Helpers (Windows)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return 0;  // Unix sockets are unsupported on Windows
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
  ((struct sockaddr_in*)addr)->sin_addr.s_addr = htonl(ip);
}

static uint32_t __yo_sockaddr_in_get_addr(void* addr) {
  return ntohl(((struct sockaddr_in*)addr)->sin_addr.s_addr);
}

static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in6*)addr)->sin6_port = htons(port);
}

static uint16_t __yo_sockaddr_in6_get_port(void* addr) {
  return ntohs(((struct sockaddr_in6*)addr)->sin6_port);
}

static void __yo_sockaddr_in6_set_addr(void* addr, const void* ip) {
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, sizeof(struct in6_addr));
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, sizeof(struct in6_addr));
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  (void)addr; (void)path;
}

static const char* __yo_sockaddr_un_get_path(void* addr) {
  (void)addr;
  return "";
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return InetPtonA(af, src, dst) == 1 ? 1 : 0;
}

static const char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return InetNtopA(af, src, dst, (DWORD)size);
}

static uint16_t __yo_htons(uint16_t hostshort) { return htons(hostshort); }
static uint16_t __yo_ntohs(uint16_t netshort) { return ntohs(netshort); }
static uint32_t __yo_htonl(uint32_t hostlong) { return htonl(hostlong); }
static uint32_t __yo_ntohl(uint32_t netlong) { return ntohl(netlong); }

// ============================================================================
// File Extra Operations (Windows)
// ============================================================================

static yo_io_future_t* __yo_async_access_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _waccess(wpath, mode);
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_realpath_start(const char* path, char* resolved) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t wbuf[MAX_PATH];
  DWORD len = GetFullPathNameW(wpath, MAX_PATH, wbuf, NULL);
  __yo_free(wpath);
  if (len == 0 || len >= MAX_PATH) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int written = __yo_win_wide_to_utf8(wbuf, resolved, MAX_PATH);
  future->result = (written < 0) ? written : 0;
  atomic_init(&future->state, -1);
  return future;
}

static FILETIME __yo_win_timespec_to_filetime(int64_t sec, int64_t nsec) {
  ULONGLONG t = ((ULONGLONG)(sec + 11644473600LL) * 10000000ULL) + ((ULONGLONG)(nsec / 100));
  FILETIME ft;
  ft.dwLowDateTime = (DWORD)t;
  ft.dwHighDateTime = (DWORD)(t >> 32);
  return ft;
}

static yo_io_future_t* __yo_async_utime_start(const char* path, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  HANDLE handle = CreateFileW(wpath, FILE_WRITE_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  __yo_free(wpath);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  CloseHandle(handle);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_futime_start(int32_t fd, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_init(&future->state, -1);
    return future;
  }

  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_lutime_start(const char* path, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  HANDLE handle = CreateFileW(wpath, FILE_WRITE_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                              NULL);
  __yo_free(wpath);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  CloseHandle(handle);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_mkdtemp_start(char* template_str) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wtemplate = __yo_win_utf8_to_wide(template_str);
  if (!wtemplate) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) {
    __yo_free(wtemplate);
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _wmkdir(wtemplate);
  if (result == 0) {
    __yo_win_wide_to_utf8(wtemplate, template_str, MAX_PATH);
  }
  __yo_free(wtemplate);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_mkstemp_start(char* template_str) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wtemplate = __yo_win_utf8_to_wide(template_str);
  if (!wtemplate) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) {
    __yo_free(wtemplate);
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  int fd = _wopen(wtemplate, _O_CREAT | _O_EXCL | _O_RDWR | _O_BINARY, _S_IREAD | _S_IWRITE);
  if (fd >= 0) {
    __yo_win_wide_to_utf8(wtemplate, template_str, MAX_PATH);
  }
  __yo_free(wtemplate);
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_copyfile_start(const char* src_path, const char* dst_path, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  (void)flags;
  wchar_t* wsrc = __yo_win_utf8_to_wide(src_path);
  wchar_t* wdst = __yo_win_utf8_to_wide(dst_path);
  if (!wsrc || !wdst) {
    if (wsrc) __yo_free(wsrc);
    if (wdst) __yo_free(wdst);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  BOOL ok = CopyFileW(wsrc, wdst, FALSE);
  __yo_free(wsrc);
  __yo_free(wdst);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_sendfile_start(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  __yo_io_init();
  (void)out_fd; (void)in_fd; (void)offset; (void)count;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

typedef struct {
  uint64_t type;
  uint64_t bsize;
  uint64_t blocks;
  uint64_t bfree;
  uint64_t bavail;
  uint64_t files;
  uint64_t ffree;
} yo_win_statfs_t;

static yo_io_future_t* __yo_async_statfs_start(const char* path, void* statfsbuf) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  ULARGE_INTEGER free_avail, total_bytes, free_bytes;
  if (!GetDiskFreeSpaceExW(wpath, &free_avail, &total_bytes, &free_bytes)) {
    __yo_free(wpath);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD sectors_per_cluster = 0, bytes_per_sector = 0, num_free_clusters = 0, total_clusters = 0;
  if (!GetDiskFreeSpaceW(wpath, &sectors_per_cluster, &bytes_per_sector, &num_free_clusters, &total_clusters)) {
    __yo_free(wpath);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }
  __yo_free(wpath);

  uint64_t bsize = (uint64_t)sectors_per_cluster * (uint64_t)bytes_per_sector;
  yo_win_statfs_t* fs = (yo_win_statfs_t*)statfsbuf;
  fs->type = 0;
  fs->bsize = bsize;
  fs->blocks = bsize ? (total_bytes.QuadPart / bsize) : 0;
  fs->bfree = bsize ? (free_bytes.QuadPart / bsize) : 0;
  fs->bavail = bsize ? (free_avail.QuadPart / bsize) : 0;
  fs->files = 0;
  fs->ffree = 0;

  future->result = 0;
  atomic_init(&future->state, -1);
  return future;
}

static size_t __yo_statfs_buf_size(void) { return sizeof(yo_win_statfs_t); }
static uint64_t __yo_statfs_type(void* buf) { return ((yo_win_statfs_t*)buf)->type; }
static uint64_t __yo_statfs_bsize(void* buf) { return ((yo_win_statfs_t*)buf)->bsize; }
static uint64_t __yo_statfs_blocks(void* buf) { return ((yo_win_statfs_t*)buf)->blocks; }
static uint64_t __yo_statfs_bfree(void* buf) { return ((yo_win_statfs_t*)buf)->bfree; }
static uint64_t __yo_statfs_bavail(void* buf) { return ((yo_win_statfs_t*)buf)->bavail; }
static uint64_t __yo_statfs_files(void* buf) { return ((yo_win_statfs_t*)buf)->files; }
static uint64_t __yo_statfs_ffree(void* buf) { return ((yo_win_statfs_t*)buf)->ffree; }

// ============================================================================
// Directory Scanning (stubs for now)
// ============================================================================

static yo_io_future_t* __yo_async_scandir_start(int32_t dirfd, const char* path) {
  __yo_io_init();
  (void)dirfd; (void)path;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_opendir_start(const char* path) {
  __yo_io_init();
  (void)path;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_readdir_start(void* dir, void* entries, size_t max_entries) {
  __yo_io_init();
  (void)dir; (void)entries; (void)max_entries;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_closedir_start(void* dir) {
  __yo_io_init();
  (void)dir;

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  future->result = -ENOSYS;
  atomic_init(&future->state, -1);
  return future;
}

// ============================================================================
// DNS Operations (Windows)
// ============================================================================

static yo_io_future_t* __yo_async_getaddrinfo_start(const char* node, const char* service,
                                                     const void* hints, void** result) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  struct addrinfo* res = NULL;
  int ret = getaddrinfo(node, service, (const struct addrinfo*)hints, &res);

  if (ret == 0) {
    *result = res;
    future->result = 0;
  } else {
    future->result = -ret;
  }
  atomic_init(&future->state, -1);

  return future;
}

static yo_io_future_t* __yo_async_getnameinfo_start(const void* addr, uint32_t addrlen,
                                                     char* host, size_t hostlen,
                                                     char* service, size_t servlen, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int ret = getnameinfo((const struct sockaddr*)addr, (socklen_t)addrlen,
                        host, (socklen_t)hostlen, service, (socklen_t)servlen, flags);
  future->result = (ret == 0) ? 0 : -ret;
  atomic_init(&future->state, -1);

  return future;
}

static void __yo_freeaddrinfo(void* res) {
  if (res) freeaddrinfo((struct addrinfo*)res);
}

static size_t __yo_addrinfo_size(void) { return sizeof(struct addrinfo); }
static int32_t __yo_addrinfo_flags(void* ai) { return ((struct addrinfo*)ai)->ai_flags; }
static int32_t __yo_addrinfo_family(void* ai) { return ((struct addrinfo*)ai)->ai_family; }
static int32_t __yo_addrinfo_socktype(void* ai) { return ((struct addrinfo*)ai)->ai_socktype; }
static int32_t __yo_addrinfo_protocol(void* ai) { return ((struct addrinfo*)ai)->ai_protocol; }
static uint32_t __yo_addrinfo_addrlen(void* ai) { return (uint32_t)((struct addrinfo*)ai)->ai_addrlen; }
static void* __yo_addrinfo_addr(void* ai) { return ((struct addrinfo*)ai)->ai_addr; }
static char* __yo_addrinfo_canonname(void* ai) { return ((struct addrinfo*)ai)->ai_canonname; }
static void* __yo_addrinfo_next(void* ai) { return ((struct addrinfo*)ai)->ai_next; }

// ============================================================================
// Signal Operations (stubs)
// ============================================================================

static int32_t __yo_signal_start(int32_t signum, void* handler) { (void)signum; (void)handler; return -ENOSYS; }
static int32_t __yo_signal_stop(int32_t signum) { (void)signum; return -ENOSYS; }
static int32_t __yo_kill(int32_t pid, int32_t signum) { (void)pid; (void)signum; return -ENOSYS; }

// ============================================================================
// TTY Operations (minimal)
// ============================================================================

static int32_t __yo_tty_init(int32_t fd) { (void)fd; return 0; }
static int32_t __yo_tty_set_mode(int32_t fd, int32_t mode) { (void)fd; (void)mode; return -ENOSYS; }
static int32_t __yo_tty_reset_mode(void) { return -ENOSYS; }
static int32_t __yo_tty_get_winsize(int32_t fd, int32_t* width, int32_t* height) { (void)fd; (void)width; (void)height; return -ENOSYS; }
static int32_t __yo_isatty(int32_t fd) { return _isatty(fd) ? 1 : 0; }

// ============================================================================
// FS Events (stubs)
// ============================================================================

static void* __yo_fs_event_init(void) { return NULL; }
static int32_t __yo_fs_event_start(void* handle, const char* path, uint32_t flags, void* callback) { (void)handle; (void)path; (void)flags; (void)callback; return -ENOSYS; }
static int32_t __yo_fs_event_stop(void* handle) { (void)handle; return -ENOSYS; }
static void __yo_fs_event_close(void* handle) { (void)handle; }

// ============================================================================
// Poll Operations (stubs)
// ============================================================================

static void* __yo_poll_init(int32_t fd) { (void)fd; return NULL; }
static int32_t __yo_poll_start(void* handle, int32_t events, void* callback) { (void)handle; (void)events; (void)callback; return -ENOSYS; }
static int32_t __yo_poll_stop(void* handle) { (void)handle; return -ENOSYS; }
static void __yo_poll_close(void* handle) { (void)handle; }

#endif // _WIN32
`);
}
