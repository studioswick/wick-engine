#!/usr/bin/env bash
# Builds core/ (Lua 5.5.1 + Wick VM + WickGuard) to wasm/wick_core.js and wasm/wick_core.wasm.
# Needs the Emscripten SDK on PATH (emcc, em++). GitHub Actions runs this for the Pages deploy.
set -euo pipefail
cd "$(dirname "$0")"

LUA_DIR=core/third_party/lua
OUT=wasm
BUILD=build

command -v emcc >/dev/null || { echo "emcc not found. Install and activate the Emscripten SDK first: https://emscripten.org/docs/getting_started/downloads.html" >&2; exit 1; }
[ -f "$LUA_DIR/lua.h" ] || { echo "Lua sources are missing from $LUA_DIR. See README.md, section 'Lua 5.5.1 import'." >&2; exit 1; }

mkdir -p "$OUT" "$BUILD/lua"

# wick_vm.cpp includes the Lua runtime as a raw string literal.
{ echo 'R"WICKLUA('; cat core/wick_runtime.lua; echo ')WICKLUA"'; } > "$BUILD/wick_runtime.inc"

# Lua errors use longjmp; the wasm exception-handling lowering keeps that fast and small.
COMMON=(-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm)

objs=()
for f in "$LUA_DIR"/*.c; do
  case "$(basename "$f")" in lua.c|luac.c|onelua.c|ltests.c) continue ;; esac
  o="$BUILD/lua/$(basename "${f%.c}").o"
  emcc "${COMMON[@]}" -I"$LUA_DIR" -c "$f" -o "$o"
  objs+=("$o")
done

em++ "${COMMON[@]}" -std=c++17 -I"$LUA_DIR" -I"$BUILD" \
  core/wick_vm.cpp core/wick_guard.cpp "${objs[@]}" -o "$OUT/wick_core.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWickCore -sENVIRONMENT=web \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8

echo "Built $OUT/wick_core.js and $OUT/wick_core.wasm"

# files.json lists every file the site serves. The service worker caches all of them for offline use, and
# File > Export Game > Standalone Site uses it to package the engine.
{ find index.html manifest.json sw.js SKILL.md style src wasm icons game -type f 2>/dev/null || true
  ls core/third_party/babylon.js core/third_party/Havok* 2>/dev/null || true; } | sort \
  | awk 'BEGIN { printf "[" } { printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 } END { print "]" }' > files.json
echo "Wrote files.json ($(grep -o '","' files.json | wc -l | tr -d ' ') + 1 files)"
