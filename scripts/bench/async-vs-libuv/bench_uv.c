/* libuv benchmark twin of bench.yo: pingpong / multi / timers.
 * One event loop for everything; small payloads so per-operation overhead
 * dominates. Usage: bench_uv <mode> <count> [nconn|ktimers]
 * Portable: builds against libuv on Windows, Linux and macOS (README.md). */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#endif
#include <uv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uv_tcp_t conn;
  uv_write_t wr;
  char rx[64];
  char tx[64];
  size_t txlen;
  long long done;
  long long target;
  int is_client;
} side_t;

static uv_loop_t loop;
static side_t client_side, server_side;
/* multi mode: N pairs */
#define MAXP 16
static side_t mclient[MAXP], mserver[MAXP];
static uv_tcp_t mlst[MAXP];
static long long global_done = 0;
/* Clients still running: the measurement ends when the LAST one finishes,
 * as bench.yo's does (it waits for every pair). It used to end — exit(0) —
 * when the first client reached its target, timing less work than the Yo
 * side and dropping the slowest connection's tail. */
static int clients_left = 1;
static uint64_t t0;

static void on_close(uv_handle_t* h) { (void)h; }


static void on_write(uv_write_t* req, int status) {
  if (status) { fprintf(stderr, "write error %d\n", status); exit(1); }
  (void)req;
}

static void on_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
  side_t* s = (side_t*)stream->data;
  if (nread <= 0) {
    if (nread < 0) { fprintf(stderr, "read error %zd\n", nread); exit(1); }
    uv_close((uv_handle_t*)stream, on_close);
    return;
  }
  (void)buf;
  memcpy(s->tx, s->rx, (size_t)nread);
  s->txlen = (size_t)nread;
  if (s->is_client) {
    global_done++;
    s->done++;
    if (s->done >= s->target) {
      uv_read_stop(stream);
      if (--clients_left == 0) {
        printf("%lld round trips in %.3f ms -> %.0f rt/s (%.2f us/rt)\n",
               global_done, (double)(uv_hrtime() - t0) / 1e6,
               (double)global_done / ((double)(uv_hrtime() - t0) / 1e9),
               (double)(uv_hrtime() - t0) / 1e3 / (double)global_done);
        exit(0);
      }
      return;
    }
  }
  uv_buf_t ob = uv_buf_init(s->tx, (unsigned int)s->txlen);
  uv_write(&s->wr, stream, &ob, 1, on_write);
}

static void alloc_cb(uv_handle_t* h, size_t size, uv_buf_t* buf) {
  side_t* s = (side_t*)h->data;
  (void)size;
  buf->base = s->rx;
  buf->len = sizeof(s->rx);
}

static void on_connect(uv_connect_t* cr, int status) {
  if (status) { fprintf(stderr, "connect %d\n", status); exit(1); }
  uv_read_start(cr->handle, alloc_cb, on_read);
  client_side.tx[0] = 'x';
  client_side.txlen = 1;
  uv_buf_t ob = uv_buf_init(client_side.tx, 1);
  uv_write(&client_side.wr, cr->handle, &ob, 1, on_write);
}

static void on_conn(uv_stream_t* server, int status) {
  if (status) { fprintf(stderr, "accept %d\n", status); exit(1); }
  int r = uv_accept(server, (uv_stream_t*)&server_side.conn);
  if (r) { fprintf(stderr, "uv_accept %d\n", r); exit(1); }
  server_side.conn.data = &server_side;
  uv_read_start((uv_stream_t*)&server_side.conn, alloc_cb, on_read);
}

/* ---- timers ---- */
typedef struct { uv_timer_t t; long long delay; long long left; } btimer_t;
static btimer_t* timers;
static long long timer_fires = 0, timer_target = 0;

static void on_timer(uv_timer_t* t) {
  btimer_t* bt = (btimer_t*)t->data;
  bt->left--;
  timer_fires++;
  if (timer_fires >= timer_target) {
    printf("%lld timer fires in %.3f ms -> %.0f fires/s\n",
           timer_fires, (double)(uv_hrtime() - t0) / 1e6,
           (double)timer_fires / ((double)(uv_hrtime() - t0) / 1e9));
    exit(0);
  }
  if (bt->left > 0) uv_timer_start(t, on_timer, (uint64_t)bt->delay, 0);
}

static void on_multi_conn(uv_stream_t* server, int status) {
  if (status) { fprintf(stderr, "accept %d\n", status); exit(1); }
  int i = (int)(intptr_t)server->data;
  if (uv_accept(server, (uv_stream_t*)&mserver[i].conn)) exit(1);
  mserver[i].conn.data = &mserver[i];
  uv_read_start((uv_stream_t*)&mserver[i].conn, alloc_cb, on_read);
}

static void on_multi_connect(uv_connect_t* cr, int status) {
  if (status) { fprintf(stderr, "connect %d\n", status); exit(1); }
  side_t* s = (side_t*)cr->handle->data;
  uv_read_start(cr->handle, alloc_cb, on_read);
  s->tx[0] = 'x';
  s->txlen = 1;
  uv_buf_t ob = uv_buf_init(s->tx, 1);
  uv_write(&s->wr, cr->handle, &ob, 1, on_write);
}

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: %s <pingpong|multi|timers> <count> [nconn|ktimers]\n", argv[0]); return 2; }
  const char* mode = argv[1];
  long long count = atoll(argv[2]);
  uv_loop_init(&loop);
  if (strcmp(mode, "pingpong") == 0) {
    clients_left = 1;
    struct sockaddr_in addr;
    uv_ip4_addr("127.0.0.1", 0, &addr);
    uv_tcp_init(&loop, &client_side.conn);
    uv_tcp_init(&loop, &server_side.conn);
    client_side.conn.data = &client_side;
    client_side.target = count;
    client_side.is_client = 1;
    uv_tcp_t lst;
    uv_tcp_init(&loop, &lst);
    uv_tcp_bind(&lst, (const struct sockaddr*)&addr, 0);
    uv_tcp_nodelay(&lst, 1);
    uv_tcp_nodelay(&client_side.conn, 1);
    uv_tcp_nodelay(&server_side.conn, 1);
    uv_listen((uv_stream_t*)&lst, 16, on_conn);
    int namelen = sizeof(addr);
    uv_tcp_getsockname(&lst, (struct sockaddr*)&addr, &namelen);
    static uv_connect_t cr;
    t0 = uv_hrtime();
    uv_tcp_connect(&cr, &client_side.conn, (const struct sockaddr*)&addr, on_connect);
    uv_run(&loop, UV_RUN_DEFAULT);
  } else if (strcmp(mode, "multi") == 0) {
    int npair = (argc > 3) ? atoi(argv[3]) : 8;
    if (npair > MAXP) npair = MAXP;
    clients_left = npair;
    for (int i = 0; i < npair; i++) {
      struct sockaddr_in a;
      uv_ip4_addr("127.0.0.1", 0, &a);
      uv_tcp_init(&loop, &mclient[i].conn);
      uv_tcp_init(&loop, &mserver[i].conn);
      mclient[i].conn.data = &mclient[i];
      mclient[i].target = count;
      mclient[i].is_client = 1;
      uv_tcp_init(&loop, &mlst[i]);
      mlst[i].data = (void*)(intptr_t)i;
      uv_tcp_bind(&mlst[i], (const struct sockaddr*)&a, 0);
      uv_tcp_nodelay(&mlst[i], 1);
      uv_tcp_nodelay(&mclient[i].conn, 1);
      uv_tcp_nodelay(&mserver[i].conn, 1);
    }
    /* listens first, then connects, then accepts via each listen cb */
    for (int i = 0; i < npair; i++) uv_listen((uv_stream_t*)&mlst[i], 8, on_multi_conn);
    t0 = uv_hrtime();
    for (int i = 0; i < npair; i++) {
      struct sockaddr_in a;
      uv_ip4_addr("127.0.0.1", 0, &a);
      int al = sizeof(a);
      uv_tcp_getsockname(&mlst[i], (struct sockaddr*)&a, &al);
      static uv_connect_t crs[MAXP];
      uv_tcp_connect(&crs[i], &mclient[i].conn, (const struct sockaddr*)&a, on_multi_connect);
    }
    uv_run(&loop, UV_RUN_DEFAULT);
  } else if (strcmp(mode, "timers") == 0) {
    long long k = (argc > 3) ? atoll(argv[3]) : 5000;
    timer_target = count;
    timers = (btimer_t*)calloc((size_t)k, sizeof(btimer_t));
    t0 = uv_hrtime();
    for (long long i = 0; i < k; i++) {
      uv_timer_init(&loop, &timers[i].t);
      timers[i].t.data = &timers[i];
      /* 1 ms, the delay bench.yo's timer tasks sleep. This was
       * 1 + (i % 50) — delays averaging ~25 ms against Yo's 1 ms — which is
       * where the "~40x faster timers" of #981 came from; with equal delays
       * the two are within ~10% (README.md). */
      timers[i].delay = 1;
      timers[i].left = (count + k - 1) / k;
      uv_timer_start(&timers[i].t, on_timer, (uint64_t)timers[i].delay, 0);
    }
    uv_run(&loop, UV_RUN_DEFAULT);
  } else {
    fprintf(stderr, "unknown mode\n");
    return 2;
  }
  return 0;
}
