---
name: wick-engine
description: "Build games for Wick Engine as plain text files. Use this when asked to create or edit a Wick project: its object tree (tree.wtree), Lua scripts, UI, assets, lighting and camera, and to run it and read errors."
---

# Wick Engine: how to build a game as text files

Wick Engine is a browser game engine with a Roblox-Studio-style data model, Babylon.js rendering, Havok physics and
Lua scripting. A Wick project can be written entirely as text. You edit files; the Wick Studio (open in a browser,
in "Text-only Interface" mode) reloads them, plays the game, and writes everything the game printed, and every error,
back into the project folder where you can read it. You never need the graphical editor.

Read this whole file once. The last section is a generated reference of every class and property.

## 1. The loop

1. The human opens Wick Studio, chooses **View > Text-only Interface**, then **Open Folder** and picks the project folder
   (Chrome or Edge). An empty folder is filled with the current project. Without a folder connected, the human copies files
   in by hand: tell them which files you changed.
2. You create and edit files in that folder (section 2).
3. The Studio notices changes within about a second and reloads. If `tree.wtree` has errors it keeps the last working
   version and writes the errors to `.wick/output.log`.
4. To test, write a command into `.wick/command`:
   - `run` plays the game for 10 seconds then stops it, `run 30` plays for 30 seconds, `stop` stops, `reload` forces a reload.
   - The Studio clears the file after reading it.
5. Read `.wick/output.log`. It has timestamps and levels (`info`, `warn`, `error`): tree problems, `print` and `warn`
   output from scripts, Lua errors with file and line (`scripts/Door.lua:12: ...`), WickGuard stops, and `=== game started ===`
   and `=== game stopped ===` markers.
6. Fix, repeat. The log only contains the most recent 1500 lines. Never edit `.wick/output.log` yourself.

You cannot see the screen. Check behaviour with `print` statements and by reading the log. Put checks in scripts
(`print("coin collected", count)`), run, read. When something is visual (colors, layout), reason from the properties.

## 2. Project folder

```
wick.json            project name; options for imported assets
tree.wtree           the object tree: every Part, Folder, Light, Sound, Script, UI object
scripts/*.lua        Lua source. A Script line in the tree points at one of these with src=
assets/*             imported files: images, sounds, 3D models, .lua, .wickbundle
.wick/output.log     written by the Studio (read-only for you)
.wick/command        written by you: run / run <seconds> / stop / reload
SKILL.md             this file
```

Rules:

- Edit `tree.wtree`, `scripts/*.lua` and `assets/*`. Add as many script files as you like in any subfolder of `scripts/`.
- Every file under `assets/` is imported by its **name without extension, lowercased, with anything outside `a-z 0-9 _ -`
  replaced by `_`**. `assets/Brick Wall.PNG` becomes `asset://brick_wall`. Keep names unique. Replacing a file keeps its
  id, so references keep working.
- Do not rename or move `tree.wtree` or `wick.json`.

## 3. tree.wtree

One instance per line. Two spaces of indentation per level of nesting. Never tabs.

```
ClassName [Name] [Property=value ...]
```

- The four **services** are the roots and sit at indentation 0: `Workspace`, `Lighting`, `Scripts`, `Gui`. They always
  exist. Put their properties on their line: `Lighting ClockTime=18 FogDensity=0.003`.
- **Name** is optional and is the first thing after the class if it has no `=`. Bare when it is only letters, digits, `_ - .`;
  otherwise in double quotes: `Part "Left Door"`. Without a name the instance is called by its class.
- **Property=value**, no spaces around `=`. A value with spaces goes in quotes. `\"` and `\\` and `\n` work inside quotes.
- A line ending in `\` continues on the next line.
- A line starting with `#` is a comment (use `#` only as the first character of a line; `#ff0000` is a color after `=`).
- Child lines are indented under their parent line.
- Unlisted properties keep their defaults. Properties that only exist while playing (`Velocity`) cannot be written.

Value formats:

| Type | Write it as | Example |
|---|---|---|
| number | plain number | `Transparency=0.5` |
| boolean | `true` / `false` | `Anchored=true` |
| string / enum | bare word, or quoted | `Material=Wood`, `Text="Hello world"` |
| Vector3 | `x,y,z` no spaces | `Position=0,5,0` |
| Vector2 | `x,y` | `AnchorPoint=0.5,0.5` |
| UDim2 | `xScale,xOffset,yScale,yOffset` | `Size=0.5,0,0,48` is half the parent's width and 48 pixels tall |
| Color3 | `#rrggbb`, `rgb(255,128,0)`, or three numbers 0..1 | `Color=#ff8800`, `Color=1,0.5,0` |

Scripts: `Script Name src=scripts/File.lua`. `Disabled=true` stops one from running. A Script runs when the game
starts if it is anywhere under `Workspace`, `Scripts` or `Gui` (as an ancestor).

Typos are reported with suggestions in `.wick/output.log`, for example
`tree.wtree:4: Part has no property "Colour". Did you mean Color?`. A line with a problem is skipped; the rest still loads,
but the Studio only applies a tree with zero errors.

### Placement rules (violations are reported and the instance is left out)

- `PointLight` and `CameraPoint` must be a direct child of a `Part`.
- Only **one** `CameraPoint` can exist, and it must be inside `Workspace`.
- `ScreenGui` goes directly under the `Gui` service. UI objects (`Frame`, `TextLabel`, `TextButton`, `TextBox`,
  `ImageLabel`, `ImageButton`, `ScrollingFrame`) go inside a `ScreenGui` or another UI object. UI modifiers (`UICorner`,
  `UIStroke`, `UIPadding`, `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`, `UIScale`, `UIGradient`) go inside a UI object.
- `Part` and `Model` cannot be in `Gui`. A `Model` can only be used to group `Part`s and other `Model`s (the Studio
  enforces that when grouping; in a file you can put anything inside a Model, but keep it to Parts).
- A `Part` may contain other Parts, Lights, Sounds, Scripts.
- Directly under `Gui` only `ScreenGui`, `Folder` and `Script` are allowed.

### A small tree

```wtree
Workspace
  Part Baseplate Size=120,1,120 Position=0,-0.5,0 Anchored=true Material=Grass Color=#ffffff CastShadow=false
  Model House
    Part Floor Size=16,1,16 Position=0,0.5,30 Anchored=true Material=Wood Color=#ffffff
    Part Wall Size=16,8,1 Position=0,5,38 Anchored=true Color=#c9b79c
  Part Lamp Shape=Ball Size=1,1,1 Position=0,9,30 Anchored=true Material=Neon Color=#ffd27a
    PointLight Glow Brightness=200 Range=40
Lighting ClockTime=17.5 CloudCoverage=0.6
Scripts
  Script Main src=scripts/main.lua
Gui
```

## 4. Space, units and rotation

- Units are **studs**. A person is about 5.5 studs tall. Y is up. The coordinate system is left-handed: +X right, +Y up,
  +Z forward (away from the default camera).
- `Position` is the **center** of a Part. `Size` is its full width, height, depth. A Block at `Position=0,0.5,0` with
  `Size=4,1,4` sits exactly on top of a surface at y=0.
- `Rotation` is Euler angles in **degrees**, applied roll (Z) first, then pitch (X), then yaw (Y). For turning something
  to face a direction, set only the Y value.
- Gravity is `Workspace.Gravity` (default 9.81) and the engine multiplies it by 3 to suit stud scale. A jump of 19
  studs/second reaches about 6 studs.
- Physics runs at a fixed 60 steps per second regardless of frame rate, so results do not depend on lag.
- The baseplate in the templates is a Part 120 by 120 with its top at y=0.

## 5. Parts, shapes, materials, textures

- `Shape` is `Block`, `Ball`, `Cylinder` or `Mesh`. A Ball uses only `Size.X` as its diameter. A Cylinder's axis is Y;
  its diameter is the larger of `Size.X` and `Size.Z`.
- `Material`: `Plastic Metal Glass Neon Wood Grass`. Each has its own grip, bounce, rolling resistance and impact sound.
  `Neon` glows. `Metal` and `Glass` reflect the scene on Medium and High graphics. `Grass` grows real blades on Blocks on
  High and Medium and sways with `Lighting.WindStrength`.
- `Color` tints textures. White (`#ffffff`) shows a texture as it is. `Wood` and `Grass` materials use a built-in texture
  when `Texture` is empty.
- `Texture` is a string: empty, a library texture, an imported image, or the Void texture:
  - `wick://textures/brick` (also `wood grass concrete sand checker cobble plates`)
  - `asset://<id>` for an imported image
  - `wick://textures/void`: **unlit**. It ignores all lighting and fog and shows exactly `TextureColor`. Use it for flat
    graphics, skyboxes, UI-like surfaces. `TextureColor` only matters for Void.
- **Meshes**: `Shape=Mesh MeshId=wick://meshes/wedge` (also `cone pyramid torus`) or `MeshId=asset://<id>` for a file in
  `assets/` (`.obj .stl .ply .glb .gltf`). The mesh is stretched to `Size`, so for a model of known proportions pick a
  `Size` with the same proportions. Y is up in the file; if a model lies on its back it is Z-up (set
  `"assetOptions": {"<id>": {"zUp": true}}` in `wick.json`). `CollisionFidelity=Hull` gives a convex hull instead of
  a box. `.fbx` and Collada are not supported: convert to `.glb`.
- Physics: `Anchored=true` fixes a Part in place (scripts can still move it by setting `Position`). Unanchored Parts fall
  and collide. `CanCollide=false` makes a Part pass-through. `LockRotation=true` makes a body that never tips over.
  `Density`, `Friction`, `Bounciness` are per Part.
- The project part limit is about 1000 to 5000 depending on the device; the physics body limit is lower. Prefer fewer,
  bigger Parts. Anchored decoration is cheap, unanchored bodies are not.

## 6. Lighting, sky, clouds, wind

`Lighting` properties: `ClockTime` (0..24, 14 is afternoon, 0 midnight), `DayLength` (seconds for a full day while the
game runs; 0 freezes time), `Brightness`, `FogDensity`, `ShadowsEnabled`, `Bloom`, `CloudsEnabled`, `CloudCoverage`,
`CloudDensity`, `CloudHeight`, `WindStrength` (0..1), `WindDirection` (degrees), `MinGraphics`.

- Quality tiers are High, Medium, Low, Minimal. High has volumetric clouds and full grass, Medium lite clouds and lite
  grass, Low and Minimal a painted cloud sky and no blades. Devices step down automatically when they struggle.
- `MinGraphics` is the lowest tier the game will run at (`Minimal`, `Low`, `Medium` or `High`). Set it to protect the look:
  below it the game is stopped as unplayable instead of looking worse.
- Night shows stars and a moon; clouds and fog follow the sky.

## 7. Lua scripting

Scripts are **Lua 5.5**, not Luau and not Roblox Lua. Wick has a Roblox-like API on top of plain Lua.

Not available: type annotations (`local x: number`), `+=`/`-=` operators, `continue` (use `goto continue` and `::continue::`),
if-then-else expressions, backtick strings, `require`, `io`, `debug`, `package`, `load`.
Use `n = n + 1`, `string.format`, `..`.

Globals: `print warn assert error pcall xpcall select tonumber tostring type typeof ipairs pairs next rawget rawset
rawequal rawlen setmetatable getmetatable unpack collectgarbage("count")`, the `math string table utf8 coroutine`
libraries, `os.time os.clock os.date`, `_G`, `task`, `game`, `workspace`, `script`, `Instance`, `Vector3`, `Vector2`,
`UDim2`, `Color3`, `TweenInfo`. Each script has its own globals; share values between scripts through `_G`.

`script` is the Script instance, so `script.Parent` is what it sits in (a Part, Model, Folder).

### Safety rules (WickGuard)

- A loop that runs for about 100 ms without calling `task.wait()` is killed with an error naming its line. Every
  `while true do` must call `task.wait(...)`.
- Scripts share a per-frame time budget; if scripts use most of every frame the game is stopped.
- Memory is capped (tens of MB). Do not build unbounded tables. Destroy what you spawn.
- `print` is throttled to 300 lines per second.
- A script file is at most 200,000 characters.

### Instances

```lua
local part = Instance.new("Part")          -- no parent yet: not in the world
part.Name = "Crate"
part.Size = Vector3.new(2, 2, 2)
part.Color = Color3.fromRGB(255, 120, 40)
part.Material = "Wood"
part.Position = Vector3.new(0, 10, 0)
part.Parent = workspace                    -- now it exists

print(workspace.Crate == part)             -- children by name: workspace.Baseplate, game.Gui.HUD
print(part.ClassName, part:GetFullName())
part:GetChildren()  part:GetDescendants()  part:FindFirstChild("Name", true)
part:IsA("BasePart")                       -- "Part" is a BasePart; "GuiObject" for UI objects
local copy = part:Clone()                  -- no parent until you set one
part:Destroy()                             -- also destroys everything inside
```

Properties read and write with `.`. Wrong names or wrong value types raise an error with a message such as
`Position expects a Vector3`. `Instance.new("Part", parent)` also accepts the parent. The same placement rules as the tree
apply (a second CameraPoint, a Frame in the Workspace... raise an error).

Value types: `Vector3.new(x,y,z)` (`.X .Y .Z .Magnitude .Unit`, `:Dot :Cross :Lerp`, `+ - * /`, `==`, `Vector3.zero`,
`Vector3.one`), `Vector2.new(x,y)`, `Color3.new(r,g,b)` (0..1) and `Color3.fromRGB(r,g,b)`, `UDim2.new(xs,xo,ys,yo)`,
`UDim2.fromScale(x,y)`, `UDim2.fromOffset(x,y)` (read `u.X.Scale u.X.Offset u.Y.Scale u.Y.Offset`).
`typeof(x)` returns `"Vector3"`, `"Instance"`, ... .

### Time

```lua
local dt = task.wait(0.5)                  -- sleep this script; returns the time actually slept
task.spawn(function() print("runs now, in its own thread") end)
task.delay(2, function() print("runs after 2 seconds") end)
task.defer(function() print("runs next frame") end)
game:GetService("RunService").Heartbeat:Connect(function(dt) end)   -- every frame; dt is real elapsed seconds
```

`dt` is real time: if the game lags, dt gets bigger and motion becomes choppier, but the game does not slow down. Always
multiply movement by `dt`.

### Events

`signal:Connect(fn)` returns a connection (`:Disconnect()`, `.Connected`). `signal:Wait()` pauses until it fires.

| Event | Object | Arguments |
|---|---|---|
| `Touched` | Part | the other Part (fires when contact starts) |
| `RunService.Heartbeat` | service | dt |
| `UserInputService.InputBegan / InputEnded` | service | `input` with `.KeyCode` and `.UserInputType` |
| `UserInputService.InputChanged` | service | `{ UserInputType = "MouseMovement" or "MouseWheel", Delta = Vector3 }` |
| `MouseButton1Click`, `Activated`, `MouseButton1Down`, `MouseButton1Up`, `MouseButton2Click`, `MouseEnter`, `MouseLeave` | UI object | none |
| `Focused`, `FocusLost` | TextBox | `FocusLost(enterPressed)` |

Keys are named `"W"`, `"1"`, `"Space"`, `"LeftShift"`, `"RightShift"`, `"LeftControl"`, `"LeftAlt"`, `"Up"`, `"Down"`,
`"Left"`, `"Right"`, and mouse buttons `"MouseButton1"` (left), `"MouseButton2"` (right), `"MouseButton3"` (middle).
`UserInputService:IsKeyDown("W")`. `MouseMovement` deltas are delivered only while the **right mouse button is held**;
the wheel always reports (+1 up, -1 down).

### Physics and sound

```lua
part.Velocity = Vector3.new(0, 20, 0)              -- readable and writable while playing, never saved
part:ApplyImpulse(Vector3.new(0, 50, 0))
workspace.Gravity = 5

local hit = workspace:Raycast(origin, direction, ignoreInstance)   -- nil or { Instance, Position, Normal, Distance }
                                                                   -- direction's LENGTH is the reach
local sound = Instance.new("Sound", part)          -- inside a Part: positional
sound.SoundId = "wick://sounds/chime"              -- or asset://<id>, or an http(s) URL
sound:Play()  sound:Stop()
```

Collisions play impact sounds automatically from the two materials; do not script them.

Moving an **anchored** Part: set `Position`/`Rotation` every frame from Heartbeat. Moving an unanchored Part: set
`Velocity` or `ApplyImpulse`; setting `Position` teleports it.

### Camera

`workspace.CurrentCamera` is read-only (`Position`, `LookVector`, `FieldOfView`). To control the camera, add a **CameraPoint**
to a Part (one per project) and move that Part from a script. While the game runs, the camera sits at
`Part.Position + Offset` (Offset is in the Part's own axes) and, with `Lock=Part`, looks along the Part's +Z.
For third person: an invisible anchored Part, `CameraPoint Offset=0,0,-14`, and a script that sets that Part's `Position`
to the character and its `Rotation` to `Vector3.new(pitch, yaw, 0)` (positive pitch looks down). With `Lock=Position` the
camera follows the Part but the player can still look around with the right mouse button.
Without a CameraPoint the player flies a free camera with W A S D Q E.

### TweenService

```lua
local tween = game:GetService("TweenService"):Create(thing, TweenInfo.new(0.5, "Back", "Out"), { Position = goal })
tween.Completed:Connect(function() end)
tween:Play()   tween:Cancel()
```
Works on numbers, Color3, Vector3, Vector2, UDim2. Styles: `Linear Quad Cubic Sine Back`. Directions: `In Out InOut`.

## 8. User interface

UI objects live in a `ScreenGui` under `Gui` and draw over the game, in the player's window.

- `Position` and `Size` are UDim2: `xScale,xOffset,yScale,yOffset`. Scale is a fraction of the parent, offset is pixels.
  `Size=0.5,-20,0,48` is half the parent's width minus 20 pixels, 48 pixels tall.
- `AnchorPoint=0.5,0.5` makes `Position` refer to the object's center (centered: `Position=0.5,0,0.5,0 AnchorPoint=0.5,0.5`).
- `ZIndex` orders overlapping objects; higher is on top. `Visible=false` hides an object and its children.
  `ClipsDescendants=true` crops children. `Rotation` is degrees.
- Classes: `Frame` (a box), `TextLabel`, `TextButton`, `TextBox` (typing: read `.Text`), `ImageLabel`, `ImageButton`
  (`Image` is a texture id or `asset://<id>`, `ScaleType` = Stretch / Fit / Crop), `ScrollingFrame` (`CanvasSize`).
- Modifiers, as children of an object: `UICorner` (rounded), `UIStroke` (outline), `UIPadding`, `UIGradient`,
  `UIAspectRatioConstraint`, `UIScale`, and layouts `UIListLayout` / `UIGridLayout`. With a layout inside an object, its
  children ignore their own `Position` and are arranged in order of `LayoutOrder` (or `Name` with `SortOrder=Name`).
- Text: `Text`, `TextSize` (pixels), `TextColor`, `Font` (`Sans Serif Mono Display`), `TextXAlignment`, `TextYAlignment`,
  `TextWrapped`.
- Buttons with `AutoButtonColor=true` brighten on hover and darken when pressed.

```wtree
Gui
  ScreenGui HUD
    TextLabel Score Position=1,-16,0,16 AnchorPoint=1,0 Size=0,160,0,40 Text="Score: 0" TextSize=22 BackgroundTransparency=0.3
      UICorner CornerRadius=10
    Frame Menu Position=0.5,0,0.5,0 AnchorPoint=0.5,0.5 Size=0,320,0,200
      UIListLayout Padding=10 HorizontalAlignment=Center
      TextButton Play Size=1,0,0,44 Text=Play
```

```lua
local menu = game.Gui.HUD.Menu
menu.Play.MouseButton1Click:Connect(function() menu.Visible = false end)
game.Gui.HUD.Score.Text = "Score: " .. score
```

## 9. Library, bundles and the Player

- Sounds: `wick://sounds/hum chime coin click whoosh wind`. Textures: section 5. Meshes: `wick://meshes/wedge cone pyramid torus`.
- Ready-made scripts to copy are in the Studio's source: `src/library/scripts/` (`spinner bobber coin_pickup jump_pad
  moving_platform respawn_on_fall day_night hud_example player_controller`). They are plain Lua files; copy one into `scripts/`.
- The **Player** is a Model of 17 grey limb Parts (`Hips Stomach Chest Neck Head` and `Left/Right UpperArm LowerArm Hand
  UpperLeg LowerLeg Foot`), an invisible `Root` body, a `CameraRig` with a `CameraPoint`, and a `PlayerController` script
  (acceleration, run, crouch, coyote-time jump, procedural walk cycle with leg and arm IK, orbit camera). To use it in a
  text project, put the controller in `scripts/player_controller.lua` (copy from `src/library/scripts/`) and write the tree:

```wtree
Workspace
  Model Player
    Part Root Shape=Cylinder Size=1.8,5.8,1.8 Position=0,2.9,0 Transparency=1 CastShadow=false LockRotation=true Friction=0 Bounciness=0
    Part Hips Size=1.5,0.5,0.9 Anchored=true CanCollide=false Color=#a3a8b8
    Part Stomach Size=1.4,0.5,0.85 Anchored=true CanCollide=false Color=#a3a8b8
    Part Chest Size=1.7,0.9,0.95 Anchored=true CanCollide=false Color=#a3a8b8
    Part Neck Shape=Cylinder Size=0.4,0.35,0.4 Anchored=true CanCollide=false Color=#a3a8b8
    Part Head Size=1.2,1.2,1.2 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftUpperArm Shape=Cylinder Size=0.5,1.1,0.5 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftLowerArm Shape=Cylinder Size=0.45,1,0.45 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftHand Shape=Ball Size=0.5,0.5,0.5 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftUpperLeg Shape=Cylinder Size=0.62,1.2,0.62 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftLowerLeg Shape=Cylinder Size=0.55,1.15,0.55 Anchored=true CanCollide=false Color=#a3a8b8
    Part LeftFoot Size=0.7,0.3,1.1 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightUpperArm Shape=Cylinder Size=0.5,1.1,0.5 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightLowerArm Shape=Cylinder Size=0.45,1,0.45 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightHand Shape=Ball Size=0.5,0.5,0.5 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightUpperLeg Shape=Cylinder Size=0.62,1.2,0.62 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightLowerLeg Shape=Cylinder Size=0.55,1.15,0.55 Anchored=true CanCollide=false Color=#a3a8b8
    Part RightFoot Size=0.7,0.3,1.1 Anchored=true CanCollide=false Color=#a3a8b8
    Part CameraRig Size=0.5,0.5,0.5 Position=0,6,0 Transparency=1 Anchored=true CanCollide=false CastShadow=false
      CameraPoint Offset=0,0,-14 FieldOfView=70
    Script PlayerController src=scripts/player_controller.lua
```

  The controller poses the limbs every frame (their initial positions do not matter). Recolor or retexture any limb with
  its own `Color` / `Texture`; the controller never touches those. The Player's feet stand where the Root's collision
  cylinder stands: place the Root's `Position.Y` at ground height + 2.9.

## 10. Imported assets

Put files in `assets/`. Supported: images (`.png .jpg .jpeg .webp .gif .bmp .svg`), sounds (`.wav .mp3 .ogg .m4a .flac
.aac`), 3D models (`.obj .stl .ply .glb .gltf`, up to 250,000 triangles; `.gltf` must have its buffers embedded, so
prefer `.glb`), Lua (`.lua`) and bundles (`.wickbundle`). Max 64 MB per file. Reference them as `asset://<id>`:

```wtree
Part Crate Texture=asset://crate_diffuse
Part Statue Shape=Mesh MeshId=asset://statue Size=2,5,2
Sound Music SoundId=asset://theme Looped=true PlayOnStart=true Volume=0.4
```
```lua
local s = Instance.new("Sound", workspace); s.SoundId = "asset://click"; s:Play()
```

A reference to an asset that does not exist is reported as a warning in the log.

## 11. Exporting the finished game

The human uses **File > Export Game** in the Studio: it produces `game/game.wick` and `game/game.json` plus instructions
for publishing from a fork of the engine on GitHub Pages, or a standalone site zip. You do not need to produce these.
Do tell the human to export from the Studio once the project loads without errors.

## 12. Checklist before you say "done"

1. `.wick/output.log` shows `Project loaded.` with no `[error]` lines after your last change.
2. You ran the game with `run` and the log shows your `print` checks and no Lua errors.
3. Every `while true` loop has a `task.wait`.
4. Every `Script` line has a `src=` that exists.
5. Anything created from a script is destroyed when no longer needed.
6. Parts that must stay put have `Anchored=true`; parts a character walks through have `CanCollide=false`.
7. Names you look up in scripts (`workspace.Door`) match the tree exactly (case sensitive).

Common mistakes: forgetting `Parent` on `Instance.new`; writing `Position=0, 5, 0` with spaces (no spaces); `Color=255,0,0`
(use `#ff0000` or 0..1 numbers); `Size=4` (needs three numbers); looking up a child before it exists (use
`:FindFirstChild` or wait with `task.wait()`); multiplying by `dt` forgotten; a second `CameraPoint`; using `continue`.

## 13. A complete small game: coin run

`tree.wtree`:

```wtree
# Collect all the coins. Walk with the arrow keys is not used here: the ball is pushed with impulses.
Workspace
  Part Baseplate Size=80,1,80 Position=0,-0.5,0 Anchored=true Material=Grass Color=#ffffff CastShadow=false
  Part Ball Shape=Ball Size=3,3,3 Position=0,2,0 Material=Metal Color=#d8dce8 Friction=0.3 Bounciness=0.2
  Folder Coins
    Part Coin1 Shape=Cylinder Size=2,0.4,2 Position=10,1.5,0 Rotation=90,0,0 Anchored=true CanCollide=false Material=Neon Color=#ffc933
    Part Coin2 Shape=Cylinder Size=2,0.4,2 Position=-10,1.5,8 Rotation=90,0,0 Anchored=true CanCollide=false Material=Neon Color=#ffc933
    Part Coin3 Shape=Cylinder Size=2,0.4,2 Position=0,1.5,-14 Rotation=90,0,0 Anchored=true CanCollide=false Material=Neon Color=#ffc933
  Part Camera Size=0.5,0.5,0.5 Position=0,30,-40 Rotation=35,0,0 Transparency=1 Anchored=true CanCollide=false CastShadow=false
    CameraPoint FieldOfView=60
Lighting ClockTime=16 CloudCoverage=0.4
Scripts
  Script Game src=scripts/game.lua
Gui
  ScreenGui HUD
    TextLabel Score Position=0.5,0,0,14 AnchorPoint=0.5,0 Size=0,220,0,44 Text="Coins: 0 / 3" TextSize=24 BackgroundTransparency=0.25
      UICorner CornerRadius=12
```

`scripts/game.lua`:

```lua
local ball = workspace.Ball
local coins = workspace.Coins
local label = game.Gui.HUD.Score
local input = game:GetService("UserInputService")
local total, got = #coins:GetChildren(), 0

-- push the ball with the arrow keys
game:GetService("RunService").Heartbeat:Connect(function(dt)
  local push = Vector3.new(0, 0, 0)
  if input:IsKeyDown("Up") then push = push + Vector3.new(0, 0, 1) end
  if input:IsKeyDown("Down") then push = push + Vector3.new(0, 0, -1) end
  if input:IsKeyDown("Left") then push = push + Vector3.new(-1, 0, 0) end
  if input:IsKeyDown("Right") then push = push + Vector3.new(1, 0, 0) end
  if push.Magnitude > 0 then ball:ApplyImpulse(push.Unit * 260 * dt) end
end)

for _, coin in ipairs(coins:GetChildren()) do
  local spin = 0
  game:GetService("RunService").Heartbeat:Connect(function(dt)
    spin = (spin + 140 * dt) % 360
    if coin.Parent then coin.Rotation = Vector3.new(90, spin, 0) end
  end)
  coin.Touched:Connect(function(other)
    if other ~= ball or not coin.Parent then return end
    got = got + 1
    label.Text = "Coins: " .. got .. " / " .. total
    print("collected", coin.Name, got)
    coin:Destroy()
    if got == total then label.Text = "You win!" print("won") end
  end)
end
print("game ready,", total, "coins")
```
