// libuv counterparts of scripts/bench/io_bench.yo's echo, timer and file
// workloads, written the way a libuv program would write them (callbacks,
// uv_write, uv_read_start, uv_timer, uv_fs on the threadpool). Driven by
// scripts/bench-vs-libuv.sh, which prints both programs' numbers side by
// side. Output lines match io_bench.yo's: "<key>_us <micros> ops <count>".
#include <uv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>

#define ECHO1_ROUNDS 20000
#define ECHOC_CONNS 64
#define ECHOC_ROUNDS 500
#define TIMER_TICKS 20000
#define FILE_ITERS 400
#define FILE_SIZE 16384

static uv_loop_t* loop;

static uint64_t now_us(void) { return uv_hrtime() / 1000; }

// ---------------------------------------------------------------- echo ----
typedef struct {
  // uv_tcp_t for the TCP runs; the socketpair run opens its two ends as
  // uv_pipe_t in the same storage (both are uv_stream_t).
  union { uv_tcp_t tcp; uv_pipe_t pipe; } client_h, server_h;
  int rounds_left;
  char buf[64];
  char msg[32];
  uv_write_t creq, sreq;
  int connected;
} conn_t;

static conn_t* conns;
static int conns_total, conns_done, conns_accepted, conns_connected;
static int echo_rounds;
static const char* echo_key;
static uv_tcp_t listener;
static uint64_t echo_t0;
static struct sockaddr_in listen_addr;

static void alloc_cb(uv_handle_t* h, size_t sz, uv_buf_t* b) {
  conn_t* c = (conn_t*)h->data;
  (void)sz;
  *b = uv_buf_init(c->buf, sizeof(c->buf));
}

static void client_write(conn_t* c);

static void server_written(uv_write_t* req, int status) { (void)req; (void)status; }
static void client_written(uv_write_t* req, int status) { (void)req; (void)status; }

static void server_read(uv_stream_t* s, ssize_t n, const uv_buf_t* b) {
  conn_t* c = (conn_t*)s->data;
  if (n <= 0) return;
  uv_buf_t out = uv_buf_init(b->base, (unsigned)n);
  uv_write(&c->sreq, s, &out, 1, server_written);
}

static void close_cb(uv_handle_t* h) { (void)h; }

static void echo_finish(void) {
  uint64_t us = now_us() - echo_t0;
  printf("%s_us %llu ops %d\n", echo_key,
         (unsigned long long)us, conns_total * echo_rounds * 4);
  for (int i = 0; i < conns_total; i++) {
    uv_close((uv_handle_t*)&conns[i].client_h, close_cb);
    uv_close((uv_handle_t*)&conns[i].server_h, close_cb);
  }
  if (echo_key[0] != 'u') uv_close((uv_handle_t*)&listener, close_cb);
}

static void client_read(uv_stream_t* s, ssize_t n, const uv_buf_t* b) {
  conn_t* c = (conn_t*)s->data;
  (void)b;
  if (n <= 0) return;
  if (--c->rounds_left == 0) {
    // Only the client side stops: accept order need not match connect
    // order, so c->server may be echoing a different client.
    uv_read_stop(s);
    if (++conns_done == conns_total) echo_finish();
    return;
  }
  client_write(c);
}

static void client_write(conn_t* c) {
  uv_buf_t out = uv_buf_init(c->msg, sizeof(c->msg));
  uv_write(&c->creq, (uv_stream_t*)&c->client_h, &out, 1, client_written);
}

static void maybe_start(void) {
  if (conns_accepted < conns_total || conns_connected < conns_total) return;
  echo_t0 = now_us();
  for (int i = 0; i < conns_total; i++) {
    conn_t* c = &conns[i];
    c->rounds_left = echo_rounds;
    uv_read_start((uv_stream_t*)&c->server_h, alloc_cb, server_read);
    uv_read_start((uv_stream_t*)&c->client_h, alloc_cb, client_read);
    client_write(c);
  }
}

static void on_connect(uv_connect_t* req, int status) {
  if (status < 0) { fprintf(stderr, "connect: %s\n", uv_strerror(status)); exit(1); }
  free(req);
  conns_connected++;
  maybe_start();
}

static void on_conn(uv_stream_t* l, int status) {
  if (status < 0) { fprintf(stderr, "listen: %s\n", uv_strerror(status)); exit(1); }
  conn_t* c = &conns[conns_accepted++];
  uv_tcp_init(loop, &c->server_h.tcp);
  c->server_h.tcp.data = c;
  uv_accept(l, (uv_stream_t*)&c->server_h);
  uv_tcp_nodelay(&c->server_h.tcp, 1);
  maybe_start();
}

static void run_echo(int nconns, int rounds, const char* key) {
  echo_key = key;
  conns_total = nconns;
  echo_rounds = rounds;
  conns_done = conns_accepted = conns_connected = 0;
  conns = calloc((size_t)nconns, sizeof(conn_t));
  uv_tcp_init(loop, &listener);
  uv_ip4_addr("127.0.0.1", 0, &listen_addr);
  uv_tcp_bind(&listener, (const struct sockaddr*)&listen_addr, 0);
  int len = sizeof(listen_addr);
  uv_tcp_getsockname(&listener, (struct sockaddr*)&listen_addr, &len);
  uv_listen((uv_stream_t*)&listener, 1024, on_conn);
  for (int i = 0; i < nconns; i++) {
    conn_t* c = &conns[i];
    memset(c->msg, 'x', sizeof(c->msg));
    uv_tcp_init(loop, &c->client_h.tcp);
    c->client_h.tcp.data = c;
    uv_tcp_nodelay(&c->client_h.tcp, 1);
    uv_connect_t* req = malloc(sizeof(*req));
    uv_tcp_connect(req, &c->client_h.tcp, (const struct sockaddr*)&listen_addr, on_connect);
  }
  uv_run(loop, UV_RUN_DEFAULT);
  free(conns);
}

// One AF_UNIX socketpair, its ends opened as pipes: the echo without a TCP
// stack under it, so the number is the runtime's own per-hop cost.
static void run_unix_echo(int rounds) {
  echo_key = "uecho_1";
  conns_total = 1;
  echo_rounds = rounds;
  conns_done = 0;
  conns = calloc(1, sizeof(conn_t));
  conn_t* c = &conns[0];
  memset(c->msg, 'x', sizeof(c->msg));
  uv_os_sock_t sv[2];
  if (uv_socketpair(SOCK_STREAM, 0, sv, UV_NONBLOCK_PIPE, UV_NONBLOCK_PIPE) != 0) { fprintf(stderr, "socketpair\n"); exit(1); }
  uv_pipe_init(loop, &c->client_h.pipe, 0);
  uv_pipe_init(loop, &c->server_h.pipe, 0);
  uv_pipe_open(&c->client_h.pipe, sv[0]);
  uv_pipe_open(&c->server_h.pipe, sv[1]);
  c->client_h.pipe.data = c;
  c->server_h.pipe.data = c;
  conns_accepted = conns_connected = 1;
  maybe_start();
  uv_run(loop, UV_RUN_DEFAULT);
  free(conns);
}

// --------------------------------------------------------------- timer ----
static uv_timer_t timer;
static int ticks_left;
static uint64_t timer_t0;

static void on_tick(uv_timer_t* t) {
  if (--ticks_left == 0) {
    printf("timer_us %llu ops %d\n", (unsigned long long)(now_us() - timer_t0), TIMER_TICKS);
    uv_close((uv_handle_t*)t, close_cb);
    return;
  }
  uv_timer_start(t, on_tick, 0, 0);
}

static void run_timer(void) {
  uv_timer_init(loop, &timer);
  ticks_left = TIMER_TICKS;
  timer_t0 = now_us();
  uv_timer_start(&timer, on_tick, 0, 0);
  uv_run(loop, UV_RUN_DEFAULT);
}

// ---------------------------------------------------------------- file ----
// One iteration: write the file (open O_CREAT|O_TRUNC, write, close), then
// read it back to EOF (open, fstat, read until 0, close) — what io_bench.yo's
// write_string + read_to_string do.
static char path[4096];
static char wbuf[FILE_SIZE];
static char* rbuf;
static int file_iters;
static uint64_t file_t0;
static uv_fs_t fsreq;
static uv_file fd;
static int64_t roff;

static void step_write_open(void);
static void on_read(uv_fs_t* r);

static void on_rclose(uv_fs_t* r) {
  uv_fs_req_cleanup(r);
  if (++file_iters == FILE_ITERS) {
    printf("file_us %llu ops %d bytes %d\n", (unsigned long long)(now_us() - file_t0), FILE_ITERS * 2, FILE_SIZE);
    return;
  }
  step_write_open();
}

static void do_read(void) {
  uv_buf_t b = uv_buf_init(rbuf + roff, (unsigned)(FILE_SIZE + 4096 - roff));
  uv_fs_read(loop, &fsreq, fd, &b, 1, roff, on_read);
}

static void on_read(uv_fs_t* r) {
  ssize_t n = r->result;
  uv_fs_req_cleanup(r);
  if (n > 0) {
    roff += n;
    do_read();
    return;
  }
  uv_fs_close(loop, &fsreq, fd, on_rclose);
}

static void on_fstat(uv_fs_t* r) {
  uv_fs_req_cleanup(r);
  roff = 0;
  do_read();
}

static void on_ropen(uv_fs_t* r) {
  fd = (uv_file)r->result;
  uv_fs_req_cleanup(r);
  uv_fs_fstat(loop, &fsreq, fd, on_fstat);
}

static void on_wclose(uv_fs_t* r) {
  uv_fs_req_cleanup(r);
  uv_fs_open(loop, &fsreq, path, O_RDONLY, 0, on_ropen);
}

static void on_write(uv_fs_t* r) {
  uv_fs_req_cleanup(r);
  uv_fs_close(loop, &fsreq, fd, on_wclose);
}

static void on_wopen(uv_fs_t* r) {
  fd = (uv_file)r->result;
  uv_fs_req_cleanup(r);
  uv_buf_t b = uv_buf_init(wbuf, sizeof(wbuf));
  uv_fs_write(loop, &fsreq, fd, &b, 1, 0, on_write);
}

static void step_write_open(void) {
  uv_fs_open(loop, &fsreq, path, O_WRONLY | O_CREAT | O_TRUNC, 0644, on_wopen);
}

static void run_file(void) {
  const char* dir = getenv("YO_BENCH_DIR");
  snprintf(path, sizeof(path), "%s/uv_io_bench_file", dir ? dir : "/tmp");
  memset(wbuf, 'x', sizeof(wbuf));
  rbuf = malloc(FILE_SIZE + 4096);
  file_iters = 0;
  file_t0 = now_us();
  step_write_open();
  uv_run(loop, UV_RUN_DEFAULT);
  free(rbuf);
}

int main(void) {
  loop = uv_default_loop();
  run_unix_echo(ECHO1_ROUNDS);
  run_echo(1, ECHO1_ROUNDS, "echo_1");
  run_echo(ECHOC_CONNS, ECHOC_ROUNDS, "echo_conc");
  run_timer();
  run_file();
  uv_loop_close(loop);
  return 0;
}
