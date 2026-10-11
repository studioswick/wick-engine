// Studio dialogs: Help (controls, scripting guide, API reference, safety), About, the WickGuard limits editor
// and the busy dialog shown during the hardware diagnostic. The API reference is generated from the same class
// schema the engine uses, so it cannot drift from what scripts can actually do.

import { CLASS_DEFS, propList, MATERIALS, SURFACES } from '../engine/datamodel.js';
import { LIMIT_DEFS } from '../engine/guard.js';
import { TIERS } from '../engine/world.js';
import { RATINGS } from '../engine/diagnostic.js';
import { soundId, WICK_SOUNDS } from '../engine/library.js';
import { WICK_VERSION, WICK_STAGE } from '../version.js';
import { h, infoDialog, modal, toast } from './ui.js';

const code = (text) => h('pre', {}, text);
const para = (text, cls = '') => h('p', cls ? { class: cls } : {}, text);
const table = (rows, head) => h('table', { class: 'wk-ref' },
  head ? h('tr', {}, head.map((c) => h('th', {}, c))) : null,
  rows.map((r) => h('tr', {}, r.map((c, i) => h('td', i === 0 ? { class: 'wk-kbd-cell' } : {}, c)))));

function tabbed(sections) {
  const body = h('div', { class: 'wk-help-body is-selectable' });
  const buttons = sections.map((s, i) => h('button', { class: 'wk-help-tab', onclick: () => show(i) }, s.title));
  function show(i) {
    buttons.forEach((b, j) => b.classList.toggle('is-active', i === j));
    body.replaceChildren(...sections[i].build());
    body.scrollTop = 0;
  }
  show(0);
  return h('div', { class: 'wk-help' }, h('div', { class: 'wk-help-tabs' }, buttons), body);
}

// ---------------------------------------------------------------- Help

function controls() {
  return [
    h('h4', {}, 'Viewport'),
    table([
      ['W A S D Q E', 'Fly the camera (forward, left, back, right, down, up). Hold Shift to go faster. Always active, in the editor and while playing.'],
      ['Right mouse drag', 'Look around.'],
      ['Middle mouse drag', 'Pan the camera.'],
      ['Mouse wheel', 'Move forward and back.'],
      ['Left click', 'Select a Part.'],
      ['1  2  3  4', 'Select, Move, Rotate and Scale tools.'],
      ['F', 'Focus the camera on the selection.'],
      ['Short right click', 'Opens the context menu (copy, duplicate, delete, insert...). Explorer rows have the same menu.'],
    ]),
    h('h4', {}, 'Editing'),
    table([
      ['Ctrl+Z / Ctrl+Y', 'Undo and redo.'],
      ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy, paste and duplicate.'],
      ['F2, Del', 'Rename and delete.'],
      ['Ctrl+S', 'Save the project to a .wick file. It also autosaves in this browser.'],
    ]),
    h('h4', {}, 'Play, Pause and Stop'),
    para('Play runs every Script under Workspace and Scripts. Pause freezes scripts, physics and sound while you keep flying the camera; press Resume to continue. The game also pauses by itself when you switch to another browser tab and resumes when you come back. Stop ends the game and restores the project exactly as it was.'),
  ];
}

function scripting() {
  return [
    h('h4', {}, 'The language'),
    para('Scripts are Lua 5.5 with a Roblox-style engine API (Instance, Vector3, task, events). Wick runs plain Lua, not Roblox\'s Luau dialect, so Luau-only syntax does not work:'),
    table([
      ['No type annotations', 'Write local x = 5, not local x: number = 5.'],
      ['No +=, -=, ...', 'Write n = n + 1.'],
      ['No continue', 'Use goto continue and a ::continue:: label, or restructure the loop.'],
      ['No if-then-else expressions', 'Use the and / or idiom, or a normal if statement.'],
      ['No `backtick ${strings}`', 'Use string.format or the .. operator.'],
    ]),
    para('Lua 5.5 also has integer and float number subtypes, // integer division, bitwise operators and goto.', 'wk-muted'),
    h('h4', {}, 'Where scripts run'),
    para('A Script runs when you press Play if it lives anywhere under Workspace or the Scripts service and is not Disabled. Each script has its own globals; share values between scripts through _G. Scripts run side by side as coroutines: a script that loops must call task.wait() (see Safety) or it is stopped after a short time.'),
    h('h4', {}, 'Instances'),
    code(`local part = Instance.new("Part")        -- created without a parent: invisible until you set Parent
part.Name = "Crate"
part.Size = Vector3.new(2, 2, 2)
part.Color = Color3.fromRGB(255, 120, 40)
part.Material = "Wood"                   -- ${MATERIALS.join(" ")}
part.Position = Vector3.new(0, 10, 0)
part.Parent = workspace

print(workspace.Crate == part)           -- children can be read by name
print(part.ClassName, part:GetFullName())
local clone = part:Clone()               -- clones start with no parent
part:Destroy()                           -- destroying a Part also destroys everything inside it`),
    h('h4', {}, 'Events'),
    code(`part.Touched:Connect(function(other)       -- another Part started touching this one
  print(part.Name, "hit", other.Name)
end)

local conn = game:GetService("RunService").Heartbeat:Connect(function(dt)
  -- every frame; dt is seconds since the last frame
end)
conn:Disconnect()

local input = game:GetService("UserInputService")
input.InputBegan:Connect(function(key)
  print(key.KeyCode, key.UserInputType)    -- "W" "Keyboard", "MouseButton1" "Mouse"
end)
print(input:IsKeyDown("LeftShift"))
local key = input.InputEnded:Wait()          -- Wait() pauses the script until the event fires`),
    h('h4', {}, 'Timing'),
    code(`task.wait(1)                       -- sleep this script for 1 second, returns the time actually waited
task.spawn(function() ... end)     -- run a function now in its own thread
task.delay(2, function() ... end)  -- run a function after 2 seconds
task.defer(function() ... end)     -- run a function on the next frame`),
    h('h4', {}, 'Physics and sound'),
    code(`part.Velocity = Vector3.new(0, 20, 0)     -- set or read the speed of a moving part (not saved)
part:ApplyImpulse(Vector3.new(0, 50, 0))  -- kick a part (mass makes heavy parts react less)
workspace.Gravity = 5                     -- read or change gravity

local hum = Instance.new("Sound", part)       -- a Sound inside a Part is positional
hum.SoundId = "${soundId('hum')}"
hum.Looped = true
hum:Play()`),
    para(`Gravity is multiplied by 3 inside the engine, so the default 9.81 feels right at Wick's scale. Parts also get friction, bounce, rolling resistance and air drag from their Material, and collisions play an impact sound that depends on both materials, so scripts never have to play those.`),
    h('h4', {}, 'Examples'),
    code(`-- Spin an anchored part (anchor it so physics does not fight the script)
local fan = workspace.Fan
local angle = 0
game:GetService("RunService").Heartbeat:Connect(function(dt)
  angle = (angle + 90 * dt) % 360
  fan.Rotation = Vector3.new(0, angle, 0)
end)`),
    code(`-- A coin that disappears when something touches it
local coin = workspace.Coin
coin.Touched:Connect(function(other)
  print("collected by", other.Name)
  coin:Destroy()
end)`),
    code(`-- Rain crates, keeping at most 40 alive
local crates = Instance.new("Folder", workspace)
crates.Name = "Crates"
while true do
  local crate = Instance.new("Part")
  crate.Size = Vector3.new(2, 2, 2)
  crate.Material = "Wood"
  crate.Color = Color3.new(1, 1, 1)
  crate.Position = Vector3.new(math.random(-6, 6), 30, math.random(-6, 6))
  crate.Parent = crates
  if #crates:GetChildren() > 40 then crates:GetChildren()[1]:Destroy() end
  task.wait(0.5)
end`),
    code(`-- Push a ball with the arrow keys (WASD fly the camera)
local ball = workspace.Ball
local input = game:GetService("UserInputService")
game:GetService("RunService").Heartbeat:Connect(function()
  if input:IsKeyDown("Up") then ball:ApplyImpulse(Vector3.new(0, 0, 30)) end
  if input:IsKeyDown("Down") then ball:ApplyImpulse(Vector3.new(0, 0, -30)) end
  if input:IsKeyDown("Left") then ball:ApplyImpulse(Vector3.new(-30, 0, 0)) end
  if input:IsKeyDown("Right") then ball:ApplyImpulse(Vector3.new(30, 0, 0)) end
end)`),
  ];
}

const TYPE_NAMES = { number: 'number', boolean: 'boolean', string: 'string', source: 'string', enum: 'string', vector3: 'Vector3', color: 'Color3' };

function fmtDefault(def) {
  if (def.type === 'vector3') return `Vector3.new(${def.default.join(', ')})`;
  if (def.type === 'color') return `Color3.new(${def.default.join(', ')})`;
  if (def.type === 'source') return '(script text)';
  return def.type === 'string' || def.type === 'enum' ? `"${def.default}"` : String(def.default);
}

function note(def) {
  if (def.type === 'enum') return def.options.join(', ');
  if (def.runtime) return 'Only exists while the game runs; never saved.';
  if (def.type === 'number' && def.min !== undefined) return `${def.min} to ${def.max}`;
  return '';
}

function reference() {
  const classes = Object.entries(CLASS_DEFS).filter(([name]) => name !== 'DataModel');
  return [
    h('h4', {}, 'Globals'),
    para('Available to scripts: print, warn, assert, error, pcall, xpcall, select, tonumber, tostring, type, typeof, ipairs, pairs, next, rawget, rawset, rawequal, rawlen, setmetatable, getmetatable, unpack, collectgarbage("count"), the math, string, table, utf8 and coroutine libraries, os.time, os.clock, os.date, _G, task, game, workspace, Instance, Vector3 and Color3. There is no io, require, load, debug or package: scripts only reach the engine through the API below.'),
    h('h4', {}, 'Vector3 and Color3'),
    table([
      ['Vector3.new(x, y, z)', 'A position, size or direction. Also Vector3.zero and Vector3.one.'],
      ['v.X  v.Y  v.Z', 'Components.'],
      ['v.Magnitude  v.Unit', 'Length, and the same direction with length 1.'],
      ['v:Dot(o)  v:Cross(o)  v:Lerp(o, t)', 'Dot product, cross product, and interpolation (t from 0 to 1).'],
      ['+  -  *  /  unary -  ==', 'Vector maths. * and / also take a number.'],
      ['Color3.new(r, g, b)', 'Red, green and blue from 0 to 1.'],
      ['Color3.fromRGB(r, g, b)', 'The same from 0 to 255.'],
      ['c.R  c.G  c.B', 'Components. Colors compare with ==.'],
      ['typeof(x)', '"Vector3", "Color3", "Instance", or the plain Lua type.'],
    ]),
    h('h4', {}, 'Every Instance'),
    table([
      ['Name, ClassName, Parent', 'ClassName is read-only. Setting Parent moves the instance (nil removes it from the world).'],
      ['inst.ChildName', 'A child with that name, e.g. workspace.Wall.'],
      ['inst:GetChildren()', 'A list of direct children.'],
      ['inst:GetDescendants()', 'A list of every child, grandchild and so on.'],
      ['inst:FindFirstChild(name, recursive)', 'The first child called name, or nil. Pass true to search all descendants.'],
      ['inst:IsA(className)', 'True for the class itself and "Instance" ("BasePart" matches Parts).'],
      ['inst:GetFullName()', 'Dotted path such as Workspace.Wall.Brick_0_0.'],
      ['inst:Clone()', 'A copy with all children, with no parent.'],
      ['inst:Destroy()', 'Removes it and its descendants. Using a destroyed instance raises an error.'],
      ['part:ApplyImpulse(Vector3)', 'Parts only: a sudden push.'],
      ['sound:Play()  sound:Stop()', 'Sounds only.'],
      ['part.Touched', 'Parts only: event, fires with the other Part when contact starts.'],
    ]),
    h('h4', {}, 'Services and events'),
    table([
      ['game:GetService("RunService").Heartbeat', 'Fires every frame with dt in seconds.'],
      ['game:GetService("UserInputService")', 'InputBegan and InputEnded (fire with an input table: KeyCode, UserInputType), and IsKeyDown(name).'],
      ['game:GetService("Workspace" | "Lighting" | "Scripts")', 'The built-in services. game.Workspace works too, and workspace is a shortcut.'],
      ['workspace.CurrentCamera', 'Read-only Position and LookVector of the camera.'],
      ['signal:Connect(fn)', 'Returns a connection with :Disconnect() and .Connected.'],
      ['signal:Wait()', 'Pauses this thread until the event fires and returns its arguments.'],
      ['task.wait  spawn  delay  defer', 'See the scripting guide.'],
    ]),
    h('h4', {}, 'Key and button names'),
    para('Letters ("W"), digits ("1"), "Space", "LeftShift", "RightShift", "LeftControl", "RightControl", "LeftAlt", "RightAlt", "Up", "Down", "Left", "Right", and the mouse buttons "MouseButton1" (left), "MouseButton2" (right), "MouseButton3" (middle).'),
    ...classes.flatMap(([name, def]) => [
      h('h4', {}, name),
      para(def.service ? `A service: reach it as game.${name}${name === 'Workspace' ? ' or workspace' : ''}. It cannot be created or destroyed.` : `Create with Instance.new("${name}", parent).`, 'wk-muted'),
      table(propList(name).map(([prop, d]) => [prop, `${TYPE_NAMES[d.type]}, default ${fmtDefault(d)}`, note(d)]), ['Property', 'Type', 'Notes']),
    ]),
    h('h4', {}, 'Materials'),
    table(MATERIALS.map((m) => [m, `Friction x${SURFACES[m].grip}, bounce x${SURFACES[m].bounce}, rolling resistance ${SURFACES[m].roll}`]), ['Material', 'How it behaves']),
    h('h4', {}, 'Wick library'),
    para(`Built-in assets you can use without any files. Sounds: ${WICK_SOUNDS.map(soundId).join(', ')}. Wood and Grass materials use textures generated by the library as well.`),
  ];
}

function safety(ctx) {
  const v = ctx.limits.values;
  return [
    h('h4', {}, 'WickGuard'),
    para('WickGuard keeps a heavy project from taking the browser tab down with it. Every frame it checks frame time, script time, memory and body count.'),
    table([
      ['Graphics quality', 'Auto steps down through High, Medium, Low and Minimal (render scale, anti-aliasing, bloom, shadows, live reflections and texture detail) when frames stay slow. You can also lock a tier from the quality button.'],
      ['Scripts', 'A script that runs too long without task.wait() is stopped with an error naming its line. If scripts are what use most of each frame, the game is stopped instead of lowering graphics, because that would not help.'],
      ['Stopping', 'The game is stopped, and the project restored, for a frozen frame, running out of memory, too many physics bodies, or an unplayable frame rate at the lowest quality.'],
      ['Tab hidden', 'The game pauses while the tab is hidden and resumes on return, so a background tab is never mistaken for a crash.'],
    ]),
    h('h4', {}, 'Your current limits'),
    para(`The first time Wick Engine starts it measures this device, and the limits below are calculated from the result${ctx.limits.hardware.measured ? '' : ' (not measured yet, so typical values are used)'}. Change them or reset them to the calculated defaults any time.`),
    table(LIMIT_DEFS.map((d) => [d.label, `${v[d.key]}${d.unit ? ` ${d.unit}` : ''}${d.key in ctx.limits.overrides ? ' (edited)' : ''}`, d.help]), ['Limit', 'Value', '']),
    h('button', { class: 'wk-btn', onclick: ctx.onEditLimits }, 'Edit limits...'),
    h('h4', {}, 'Fixed limits'),
    para('Scripts are 200,000 characters at most. The Output panel and print are throttled so a log flood cannot freeze the page.'),
  ];
}

export function showHelp(ctx) {
  infoDialog('Controls and Lua Reference', tabbed([
    { title: 'Controls', build: controls },
    { title: 'Scripting', build: scripting },
    { title: 'Reference', build: reference },
    { title: 'Safety', build: () => safety(ctx) },
  ]), 780);
}

// ---------------------------------------------------------------- About

export function showAbout({ world, limits, partCount, projectName }) {
  const hw = limits.hardware;
  infoDialog('About Wick Engine', [
    h('div', { class: 'wk-version' }, `Version ${WICK_VERSION}`, h('span', { class: 'wk-muted' }, ` (${WICK_STAGE})`)),
    para('Wick Engine is a browser game engine by Wick Studios, in early development. It runs entirely in your browser: nothing is uploaded, and projects are stored in this browser or in .wick files you save.'),
    h('h4', {}, 'How it works'),
    table([
      ['Rendering', `Babylon.js ${globalThis.BABYLON.Engine.Version}: physically based materials, real-time reflections, shadows and bloom.`],
      ['Physics', 'Havok rigid bodies, with friction, bounce and drag from each Material.'],
      ['Scripting', 'Lua 5.5 compiled to WebAssembly, sandboxed with time and memory limits.'],
      ['Audio', 'Babylon Audio Engine V2: positional sound and impact sounds synthesised per pair of materials.'],
      ['Safety', 'WickGuard (C++ policy running in the same WebAssembly module).'],
    ]),
    h('h4', {}, 'This device'),
    table([
      ['Graphics', world.gpuName],
      ['Baseline quality', hw.measured ? `${TIERS[hw.tier].name} (${RATINGS[hw.tier]}), performance score ${Math.round(hw.score * 100)} of 100` : 'Not measured yet'],
      ['Running at', `${TIERS[world.tier].name}`],
      ['Processor', hw.measured ? `${hw.cores} logical cores${hw.memGB ? `, ${hw.memGB} GB memory` : ''}` : 'Not measured yet'],
      ['Project', `${projectName}: ${partCount} of ${limits.values.maxParts} Parts`],
    ]),
    h('h4', {}, 'Versioning'),
    para('Versions read stage, major, minor, patch: p = pre-alpha, a = alpha, b = beta, no letter = release. Major changes when saved projects or the scripting API break, minor is a round of features, patch is fixes only. Saved .wick files record the version that wrote them.', 'wk-muted'),
    h('h4', {}, 'Credits'),
    para('Babylon.js (Apache 2.0), Havok Physics for Babylon.js, and Lua (MIT license, Lua.org, PUC-Rio).', 'wk-muted'),
  ], 560);
}

// ---------------------------------------------------------------- WickGuard limits

/** Editor for the WickGuard limits. onApply(values) saves; onReset() restores the hardware-based defaults. */
export function showLimitsDialog({ limits, onApply, onReset }) {
  const current = limits.values, defaults = limits.defaults;
  const inputs = Object.fromEntries(LIMIT_DEFS.map((d) => [d.key, h('input', {
    class: 'wk-input wk-num', type: 'number', value: current[d.key], min: d.min, max: d.max, step: 1,
    onkeydown: (e) => e.stopPropagation(),
  })]));
  const rows = LIMIT_DEFS.map((d) => h('tr', { title: d.help },
    h('td', {}, d.label),
    h('td', {}, inputs[d.key]),
    h('td', { class: 'wk-muted' }, d.unit),
    h('td', { class: 'wk-muted' }, `default ${defaults[d.key]}`)));
  const hw = limits.hardware;
  modal({
    title: 'WickGuard limits',
    width: 560,
    content: [
      para(hw.measured
        ? `Defaults are calculated from this device (${hw.gpu}, ${hw.cores} cores, performance score ${Math.round(hw.score * 100)} of 100). Change any value, or reset them all.`
        : 'The hardware diagnostic has not run yet, so the defaults are typical values. Run it from View > Graphics Quality.'),
      h('table', { class: 'wk-limits' }, rows),
      para('Hover a row to see what it does. Script limits take effect the next time you press Play.', 'wk-muted'),
    ],
    buttons: [
      { label: 'Reset to Defaults', action: () => { onReset(); toast('WickGuard limits reset to defaults'); } },
      { label: 'Cancel', cancel: true },
      {
        label: 'Save', primary: true,
        action: () => {
          const values = {};
          for (const d of LIMIT_DEFS) {
            const n = Number(inputs[d.key].value);
            if (!Number.isFinite(n) || n < d.min || n > d.max) {
              toast(`${d.label} must be between ${d.min} and ${d.max}`, 'warn');
              inputs[d.key].focus();
              return false;
            }
            values[d.key] = n;
          }
          onApply(values);
          toast('WickGuard limits saved');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- busy dialog

/** A dialog that cannot be dismissed; used while the hardware diagnostic runs. */
export function busyDialog(title, text) {
  const line = h('div', { class: 'wk-splash-text' }, text);
  const overlay = h('div', { class: 'wk-overlay' },
    h('div', { class: 'wk-dialog', role: 'dialog', 'aria-modal': 'true', style: 'width:420px' },
      h('div', { class: 'wk-dialog-title' }, title),
      h('div', { class: 'wk-dialog-body' }, line, h('div', { class: 'wk-busy' }, h('div', { class: 'wk-busy-bar' })))));
  document.body.append(overlay);
  return { set: (t) => { line.textContent = t; }, close: () => overlay.remove() };
}
