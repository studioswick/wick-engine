// Wick Engine core: hosts the Lua VM that runs game scripts.
// Enforces the sandbox limits (heap cap, per-resume time budget) and exposes one string-based host call to JS.
// The scripting API itself lives in wick_runtime.lua, which is embedded at build time (see build.sh).

extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}

#include <algorithm>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define WICK_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

static double wickNow() { return emscripten_get_now(); }

// JS side: Module.wickHost(op, id, a, b) returns a string. The result is cached in JS and copied out in a second call,
// so replies of any length work without a fixed buffer.
EM_JS(int, wick_js_invoke, (const char* op, int id, const char* a, const char* b), {
  const reply = Module.wickHost(UTF8ToString(op), id, UTF8ToString(a), UTF8ToString(b));
  Module.wickHostReply = reply;
  return lengthBytesUTF8(reply);
});
EM_JS(void, wick_js_fetch, (char* dst, int capacity), {
  stringToUTF8(Module.wickHostReply, dst, capacity);
});
#else
// Native builds (used for tests) supply their own wick_js_invoke / wick_js_fetch.
#include <chrono>
#define WICK_EXPORT extern "C"
extern "C" int wick_js_invoke(const char* op, int id, const char* a, const char* b);
extern "C" void wick_js_fetch(char* dst, int capacity);
static double wickNow() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}
#endif

static const char kRuntimeSource[] =
#include "wick_runtime.inc"
;

namespace {

constexpr int kHookInterval = 5000;      // VM instructions between time checks
constexpr double kFirstRunBudgetMs = 1000;
constexpr double kEventBudgetMs = 100;
constexpr double kStepBudgetMs = 200;    // outer guard; the scheduler gives each script its own slice

// Allocator wrapper that enforces a heap cap. Lua runs a full GC and retries before surfacing a failure.
struct HeapMeter {
  lua_Alloc inner = nullptr;
  void* innerUd = nullptr;
  size_t used = 0;
  size_t cap = 0;
  bool refused = false;
};

HeapMeter g_heap;
lua_State* g_L = nullptr;
double g_sliceStart = 0;
double g_sliceBudgetMs = kStepBudgetMs;
double g_stepStart = 0;
double g_lastStepMs = 0;
bool g_fatal = false;

void* meteredAlloc(void* ud, void* ptr, size_t osize, size_t nsize) {
  auto* m = static_cast<HeapMeter*>(ud);
  const size_t old = ptr ? osize : 0;  // osize is a type tag when ptr is null
  if (nsize == 0) {
    m->used -= std::min(m->used, old);
    return m->inner(m->innerUd, ptr, osize, 0);
  }
  if (nsize > old && m->used + (nsize - old) > m->cap) {
    m->refused = true;
    return nullptr;
  }
  void* p = m->inner(m->innerUd, ptr, osize, nsize);
  if (p) m->used = m->used - std::min(m->used, old) + nsize;
  return p;
}

void budgetHook(lua_State* L, lua_Debug*) {
  if (wickNow() - g_sliceStart > g_sliceBudgetMs) {
    luaL_where(L, 0);  // level 0 is the script function being interrupted, so the message names its line
    lua_pushfstring(L, "script ran for over %d ms without waiting. Add task.wait() inside long loops.",
                    static_cast<int>(g_sliceBudgetMs));
    lua_concat(L, 2);
    lua_error(L);
  }
}

void logLine(const char* level, const char* msg) { wick_js_invoke("log", 0, level, msg); }

// host(op, id, a, b) -> string
int hostCall(lua_State* L) {
  const char* op = luaL_checkstring(L, 1);
  const int id = static_cast<int>(luaL_checkinteger(L, 2));
  const char* a = luaL_checkstring(L, 3);
  const char* b = luaL_checkstring(L, 4);
  const int len = wick_js_invoke(op, id, a, b);
  std::string reply(static_cast<size_t>(len) + 1, '\0');
  wick_js_fetch(&reply[0], len + 1);
  lua_pushlstring(L, reply.data(), static_cast<size_t>(len));
  return 1;
}

int hostSlice(lua_State* L) {
  g_sliceStart = wickNow();
  g_sliceBudgetMs = luaL_checknumber(L, 1);
  return 0;
}

int hostElapsed(lua_State* L) {
  lua_pushnumber(L, wickNow() - g_stepStart);
  return 1;
}

// A refused allocation only ends the VM if memory is still nearly full after Lua's emergency GC.
void checkHeap() {
  if (g_heap.refused) {
    if (g_heap.used > g_heap.cap / 10 * 9) g_fatal = true;
    g_heap.refused = false;
  }
}

// Calls the function already on the stack with `nargs` arguments under the given time budget.
int invoke(int nargs, double budgetMs) {
  g_sliceStart = wickNow();
  g_sliceBudgetMs = budgetMs;
  const int rc = lua_pcall(g_L, nargs, 0, 0);
  if (rc != LUA_OK) {
    const char* msg = lua_tostring(g_L, -1);
    logLine("error", msg ? msg : "script failed with a non-text error");
    lua_settop(g_L, -2);
  }
  checkHeap();
  return rc;
}

}  // namespace

WICK_EXPORT void wick_vm_close() {
  if (g_L) lua_close(g_L);
  g_L = nullptr;
}

// Returns 0 on success. heapMB caps total Lua memory.
WICK_EXPORT int wick_vm_open(int heapMB) {
  wick_vm_close();
  g_fatal = false;
  g_L = luaL_newstate();
  if (!g_L) return 1;

  g_heap = HeapMeter{};
  g_heap.inner = lua_getallocf(g_L, &g_heap.innerUd);
  g_heap.cap = static_cast<size_t>(std::max(heapMB, 4)) * 1024 * 1024;
  lua_setallocf(g_L, meteredAlloc, &g_heap);

  luaL_openlibs(g_L);
  lua_pushcfunction(g_L, hostCall);
  lua_setglobal(g_L, "__wick_host");
  lua_pushcfunction(g_L, hostSlice);
  lua_setglobal(g_L, "__wick_slice");
  lua_pushcfunction(g_L, hostElapsed);
  lua_setglobal(g_L, "__wick_elapsed");
  lua_sethook(g_L, budgetHook, LUA_MASKCOUNT, kHookInterval);

  g_stepStart = wickNow();
  if (luaL_loadbufferx(g_L, kRuntimeSource, sizeof(kRuntimeSource) - 1, "=wick_runtime", nullptr) != LUA_OK ||
      invoke(0, kFirstRunBudgetMs) != LUA_OK) {
    const char* msg = lua_gettop(g_L) > 0 ? lua_tostring(g_L, -1) : nullptr;
    if (msg) logLine("error", msg);
    wick_vm_close();
    return 2;
  }
  return 0;
}

// Compiles and starts one script. Returns 0 if it started.
WICK_EXPORT int wick_vm_run(const char* chunkName, const char* source) {
  if (!g_L) return -1;
  g_stepStart = wickNow();
  lua_getglobal(g_L, "__wick_run");
  lua_pushstring(g_L, chunkName);
  lua_pushstring(g_L, source);
  return invoke(2, kFirstRunBudgetMs);
}

// Advances timers and fires Heartbeat. Returns 0 ok, 1 script error (already logged), 2 fatal (heap exhausted).
WICK_EXPORT int wick_vm_step(double dtSeconds) {
  if (!g_L) return -1;
  g_stepStart = wickNow();
  lua_getglobal(g_L, "__wick_step");
  lua_pushnumber(g_L, dtSeconds);
  const int rc = invoke(1, kStepBudgetMs);
  g_lastStepMs = wickNow() - g_stepStart;
  return g_fatal ? 2 : (rc == LUA_OK ? 0 : 1);
}

// Delivers an engine event (touched, input) to Lua. payload is a list of encoded values.
WICK_EXPORT void wick_vm_event(const char* name, const char* payload) {
  if (!g_L) return;
  g_stepStart = wickNow();
  lua_getglobal(g_L, "__wick_event");
  lua_pushstring(g_L, name);
  lua_pushstring(g_L, payload);
  invoke(2, kEventBudgetMs);
}

WICK_EXPORT double wick_vm_last_ms() { return g_lastStepMs; }
WICK_EXPORT double wick_vm_heap_bytes() { return static_cast<double>(g_heap.used); }
WICK_EXPORT int wick_vm_fatal() { return g_fatal ? 1 : 0; }
