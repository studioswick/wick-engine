# Wick Engine

A browser game engine by Wick Studios. Studio-style editor, Babylon.js rendering, Havok physics, Lua 5.5 scripting.
Pre-alpha.

## How it fits together

| Layer | Language | Lives in | Job |
|---|---|---|---|
| Core | C++ -> WebAssembly | `core/` | Lua VM host, sandbox limits (heap cap, per-script time budget), WickGuard safety policy |
| Script API | Lua | `core/wick_runtime.lua` | `Instance`, `Vector3`, `task`, signals, services. Embedded into the wasm at build time |
| Engine | JavaScript | `src/engine/` | Data model, Babylon scene, Havok bodies, spatial audio, Play/Stop sessions |
| Studio | JavaScript | `src/studio/` | Editor UI, Explorer, Properties, script editor |
| Projects | JavaScript | `src/project/` | Autosave, `.wick` files, demo project |

The browser only exposes WebGL, Havok and the DOM to JavaScript, so the C++ core owns everything that can run
away (scripts, memory, the safety policy) and JavaScript applies its decisions.

`index.html` is only a router. The studio DOM is built by `src/studio/shell.js`.

## Lua 5.5.1 import

Source: <https://github.com/lua/lua/releases/tag/v5.5.1>. Download the source zip of that tag and copy into
`core/third_party/lua/`:

- every `.c` and `.h` file from the **repository root** (the 5.5 repo keeps them at the top level, not in `src/`)
- **except** `lua.c`, `luac.c`, `onelua.c`, and `ltests.c` / `ltests.h` (if present)
- keep Lua's copyright notice with the sources (the MIT license text)

You do not need `Makefile`, `manual/` or `testes/`. `build.sh` compiles every `.c` it finds in that folder minus
the exclusions, so nothing needs to be listed by hand.

## Build

Needs the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) on your PATH.

```sh
./build.sh                       # writes wasm/wick_core.js and wasm/wick_core.wasm
python3 -m http.server 8080      # serve the repo root, open http://localhost:8080
```

Babylon.js and Havok load from `cdn.babylonjs.com` at runtime. Pin exact versions in `src/boot.js` (`LIBS`) once
you have tested a release.

## Deploy (GitHub Pages)

1. Repo Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Push to `main`. `.github/workflows/pages.yml` installs Emscripten, runs `build.sh` and publishes the site.

## Using the studio

- Right mouse drag looks, with W A S D Q E to fly (Shift is faster). Middle mouse pans. Wheel moves forward and back.
- Left click selects. Q W E R switch Select, Move, Rotate, Scale. F focuses the selection.
- Short right click opens the context menu. Explorer rows have the same menu.
- Ctrl+Z / Ctrl+Y undo and redo, Ctrl+C / V / D copy, paste, duplicate, F2 rename, Del delete, Ctrl+S saves a `.wick` file.
- Play runs every Script under Workspace and Scripts. Stop restores the project exactly as it was.
- The project autosaves to this browser. The demo loads on the first visit only. File > New Project starts fresh.

## WickGuard

During Play and while editing, frame time is measured every frame. If the device cannot keep up, graphics quality
steps down (High, Medium, Low, Minimal: render scale, MSAA, bloom, shadows). If scripts are the cause, or the
game is still unplayable at the lowest tier, or memory or physics limits are exceeded, the game is stopped and the
project is restored. Scripts that loop without `task.wait()` are killed after a short time budget instead of
freezing the tab. Limits: 2500 parts, 1500 physics bodies, 96 MB of Lua memory.
