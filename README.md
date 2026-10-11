# Wick Engine

A browser game engine by Wick Studios. Studio-style editor, Babylon.js rendering, Havok physics, Lua 5.5 scripting.
Pre-alpha, version **p0.2.0** (see Versioning below).

## How it fits together

| Layer | Language | Lives in | Job |
|---|---|---|---|
| Core | C++ -> WebAssembly | `core/` | Lua VM host, sandbox limits (heap cap, per-script time budget), WickGuard safety policy |
| Script API | Lua | `core/wick_runtime.lua` | `Instance`, `Vector3`, `task`, signals, services. Embedded into the wasm at build time |
| Engine | JavaScript | `src/engine/` | Data model, Babylon scene, materials and live reflections, Havok bodies, audio, Play/Pause/Stop sessions, WickGuard limits, hardware diagnostic |
| Library | JavaScript | `src/engine/library.js` | Built-in sounds and Wood/Grass textures, generated in code (no asset files) |
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

Babylon.js and Havok are served from this repo, in `core/third_party/`:

- `babylon.js` (the UMD build)
- `HavokPhsyics_umd.js` (keep the spelling, or change `LIBS` in `src/boot.js` if you rename it)
- `HavokPhysics.wasm` from the **same** `@babylonjs/havok` version. The UMD script does not contain the physics
  engine, it fetches this file from its own folder at start-up.

`boot.js` reports which of these is missing or wrong instead of failing with a reference error.

## Deploy (GitHub Pages)

1. Repo Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Push to `main`. `.github/workflows/pages.yml` installs Emscripten, runs `build.sh` and publishes the site,
   including `core/third_party/babylon.js` and the `Havok*` files (not the Lua sources).

## Using the studio

- WASD QE fly the camera at all times (Shift is faster). Right mouse drag looks, middle mouse pans, the wheel moves
  forward and back.
- Left click selects. 1 2 3 4 switch Select, Move, Rotate, Scale. F focuses the selection.
- Short right click opens the context menu. Explorer rows have the same menu.
- Ctrl+Z / Ctrl+Y undo and redo, Ctrl+C / V / D copy, paste, duplicate, F2 rename, Del delete, Ctrl+S saves a `.wick` file.
- Play runs every Script under Workspace and Scripts. Pause freezes scripts, physics and sound (the camera keeps
  flying). The game pauses by itself while the browser tab is hidden and resumes when you return. Stop restores the
  project exactly as it was.
- The project autosaves to this browser. The demo loads on the first visit only. File > New Project starts fresh.
- Help > Controls and Lua Reference has the scripting guide and a full API reference.

## Graphics, physics and sound

- **Reflections**: Metal and Glass reflect the real scene through live reflection probes (the nearest few reflective
  Parts get their own; everything else reflects a sky probe). Tiers below Medium have no reflections and Metal falls
  back to a plain glossy shine.
- **Materials**: Plastic, Metal, Glass, Neon, Wood, Grass. Wood and Grass use generated textures; `Color` tints them
  (white is natural). Each material has its own grip, bounce, rolling resistance and impact sound.
- **Physics**: gravity is multiplied by 3 internally (Workspace.Gravity 9.81 feels right at Wick's scale), parts have
  friction, rolling resistance and air drag.
- **Sound**: positional sounds fall off with distance (MaxDistance is the audible range), and impacts between parts
  are synthesised per pair of materials. Library sounds are `wick://sounds/<name>` (currently `hum`).
- **Lights**: PBR lights fall off with the inverse square of distance and are cut off at `Range`, so Brightness
  values run into the hundreds (limit 100000).

## WickGuard

During Play and while editing, frame time is measured every frame. If the device cannot keep up, graphics quality
steps down (High, Medium, Low, Minimal: render scale, MSAA, bloom, shadows, reflections, texture detail). If scripts
are the cause, or the game is still unplayable at the lowest tier, or memory or physics limits are exceeded, the
game is stopped and the project is restored. Scripts that loop without `task.wait()` are killed after a short time
budget instead of freezing the tab.

The first time Wick Engine starts it runs a **hardware diagnostic**: it renders the open project at each quality
tier, times a Lua workload, and reads core count and memory. The best smooth tier becomes the starting point of Auto
quality (it can still step down), and the limits below are calculated from the result. Run it again from
View > Graphics Quality > Run Hardware Diagnostic.

Limits (View > WickGuard Limits) all have a hardware-based default and can be edited or reset to the defaults:
parts per project, physics bodies, script memory, script time without waiting, script time per frame, the frame
rates that lower graphics and stop the game, and the frozen-frame time. Script limits apply on the next Play.

## Versioning

`src/version.js` holds the version, shown in Help > About and written into saved `.wick` files. Format:
`<stage><major>.<minor>.<patch>` where the stage is `p` pre-alpha, `a` alpha, `b` beta, or nothing for a release.
Major changes when saved projects or the scripting API break, minor is a round of features, patch is fixes only.
