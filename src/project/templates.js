// Wick project templates: the starting points offered by File > New Project and Open Template.

import { buildDemo } from './demo.js';
import { insertBuiltinBundle } from '../engine/bundles.js';
import { libraryScriptSource } from '../engine/libscripts.js';

export const TEMPLATES = [
  { id: 'empty', name: 'Empty', description: 'No parts at all, only the services. Start from nothing.' },
  { id: 'baseplate', name: 'Bare Baseplate', description: 'A plain grey baseplate under a clear sky.' },
  { id: 'grass', name: 'Grass Baseplate', description: 'A baseplate of real grass: blades and wind on High and Medium graphics.' },
  { id: 'demo', name: 'Wick Demo', description: 'Materials, reflections, impact sounds, a brick wall and a cannonball launcher.' },
  { id: 'playground', name: 'Player Playground', description: 'The Player bundle on grass with stairs, a ramp, crates and coins to collect.' },
  { id: 'night', name: 'Night City', description: 'A lit street at night with neon, buildings, fog and stars.' },
  { id: 'ui', name: 'UI Starter', description: 'A main menu built from UI objects, with layouts, buttons and a script.' },
];

const COINS = `-- Coins: every Part in the Coins folder spins and is collected on touch.
local coins = workspace.Coins
_G.coins = 0
for _, coin in ipairs(coins:GetChildren()) do
  local angle = 0
  game:GetService("RunService").Heartbeat:Connect(function(dt)
    angle = (angle + 120 * dt) % 360
    if coin.Parent then coin.Rotation = Vector3.new(0, angle, 0) end
  end)
  coin.Touched:Connect(function()
    if not coin.Parent then return end
    _G.coins = _G.coins + 1
    print("Coins:", _G.coins, "of", #coins:GetChildren() + _G.coins)
    coin:Destroy()
  end)
end
`;

const MENU = `-- Main menu: the Play button hides the menu, the Quit button just prints.
local menu = game.Gui.MainMenu.Menu
local tweens = game:GetService("TweenService")

menu.Play.MouseButton1Click:Connect(function()
  tweens:Create(menu, TweenInfo.new(0.4, "Back", "In"), { Position = UDim2.fromScale(0.5, 1.6) }):Play()
end)
menu.Quit.MouseButton1Click:Connect(function() print("Quit pressed") end)
for _, button in ipairs({ menu.Play, menu.Quit }) do
  button.MouseEnter:Connect(function() tweens:Create(button, TweenInfo.new(0.15), { Size = UDim2.new(1, 0, 0, 52) }):Play() end)
  button.MouseLeave:Connect(function() tweens:Create(button, TweenInfo.new(0.15), { Size = UDim2.new(1, 0, 0, 46) }):Play() end)
end
`;

function ground(dm, texture) {
  const g = dm.workspace.children.find((c) => c.name === 'Baseplate');
  if (g && texture) dm.set(g, 'Texture', texture);
  return g;
}

function stairs(dm, parent, [x, z]) {
  const folder = dm.create('Folder', parent, { Name: 'Stairs' });
  for (let i = 0; i < 10; i++) {
    dm.create('Part', folder, { Name: `Step${i + 1}`, Size: [10, 1, 3], Position: [x, 0.5 + i, z + i * 3], Anchored: true, Material: 'Wood', Color: [1, 1, 1] });
  }
}

async function playground(dm) {
  dm.loadBlank('Player Playground');
  dm.set(dm.lighting, 'ClockTime', 15.5);
  const ws = dm.workspace;
  stairs(dm, ws, [18, -10]);
  dm.create('Part', ws, { Name: 'Ramp', Shape: 'Mesh', MeshId: 'wick://meshes/wedge', Size: [14, 5, 12], Position: [-18, 2.5, 6], Anchored: true, Material: 'Wood', Color: [1, 1, 1], Rotation: [0, 180, 0] });
  dm.create('Part', ws, { Name: 'Platform', Size: [14, 1, 14], Position: [18, 10.5, 26], Anchored: true, Material: 'Plastic', Texture: 'wick://textures/plates', Color: [1, 1, 1] });
  dm.create('Part', ws, { Name: 'Pillar', Shape: 'Cylinder', Size: [3, 12, 3], Position: [0, 6, 30], Anchored: true, Texture: 'wick://textures/brick', Color: [1, 1, 1] });
  await insertBuiltinBundle(dm, 'crate_pyramid', ws, [-4, 0, 10]);
  const coins = dm.create('Folder', ws, { Name: 'Coins' });
  [[8, 2, -6], [-8, 2, -6], [18, 12.5, 26], [0, 14, 30], [-18, 8, 6], [10, 2, 18]].forEach((p, i) => {
    dm.create('Part', coins, { Name: `Coin${i + 1}`, Shape: 'Cylinder', Size: [2, 0.4, 2], Position: p, Rotation: [90, 0, 0], Anchored: true, CanCollide: false, Material: 'Neon', Color: [1, 0.78, 0.2], CastShadow: false });
  });
  dm.create('Script', dm.scripts, { Name: 'Coins', Source: COINS });
  dm.create('Script', dm.scripts, { Name: 'HUD', Source: await libraryScriptSource('hud_example') });
  await insertBuiltinBundle(dm, 'player', ws, [0, 0, -22]);
  dm.emit('reset');
}

async function night(dm) {
  dm.loadBlank('Night City', { grass: false });
  const L = dm.lighting;
  dm.set(L, 'ClockTime', 22.5); dm.set(L, 'FogDensity', 0.0035); dm.set(L, 'CloudCoverage', 0.35); dm.set(L, 'Brightness', 1.4);
  const ws = dm.workspace;
  const base = ground(dm, 'wick://textures/concrete');
  dm.set(base, 'Color', [0.6, 0.6, 0.65]);
  dm.create('Part', ws, { Name: 'Road', Size: [14, 0.1, 120], Position: [0, 0.05, 0], Anchored: true, Color: [0.12, 0.12, 0.14], CastShadow: false });
  for (let i = -5; i <= 5; i++) dm.create('Part', ws, { Name: `Line${i}`, Size: [0.4, 0.12, 4], Position: [0, 0.07, i * 10], Anchored: true, Material: 'Neon', Color: [1, 0.85, 0.3], CastShadow: false });
  const city = dm.create('Folder', ws, { Name: 'Buildings' });
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1, h = 14 + ((i * 37) % 26), z = -50 + Math.floor(i / 2) * 18;
    const b = dm.create('Part', city, { Name: `Building${i + 1}`, Size: [14, h, 14], Position: [side * 20, h / 2, z], Anchored: true, Texture: 'wick://textures/concrete', Color: [0.55 + (i % 3) * 0.08, 0.57, 0.65] });
    dm.create('Part', city, { Name: `Sign${i + 1}`, Size: [0.3, 2, 8], Position: [side * 12.7, 6 + (i % 3) * 3, z], Anchored: true, Material: 'Neon', Color: [[0.2, 0.9, 1], [1, 0.25, 0.7], [0.5, 1, 0.4]][i % 3], CastShadow: false });
    void b;
  }
  for (let i = -2; i <= 2; i++) {
    await insertBuiltinBundle(dm, 'street_lamp', ws, [-8, 0, i * 22]);
    await insertBuiltinBundle(dm, 'street_lamp', ws, [8, 0, i * 22 + 11]);
  }
  await insertBuiltinBundle(dm, 'player', ws, [0, 0, -52]);
  dm.emit('reset');
}

function ui(dm) {
  dm.loadBlank('UI Starter', { grass: false });
  dm.set(dm.lighting, 'ClockTime', 11);
  const screen = dm.create('ScreenGui', dm.gui, { Name: 'MainMenu' });
  const menu = dm.create('Frame', screen, { Name: 'Menu', AnchorPoint: [0.5, 0.5], Position: [0.5, 0, 0.5, 0], Size: [0, 340, 0, 300], BackgroundColor: [0.09, 0.1, 0.14], BackgroundTransparency: 0.05 });
  dm.create('UICorner', menu, { CornerRadius: 18 });
  dm.create('UIStroke', menu, { Color: [0.96, 0.65, 0.14], Thickness: 2 });
  dm.create('UIPadding', menu, { PaddingTop: 24, PaddingBottom: 24, PaddingLeft: 28, PaddingRight: 28 });
  dm.create('UIListLayout', menu, { Padding: 14, HorizontalAlignment: 'Center' });
  dm.create('TextLabel', menu, { Name: 'Title', Size: [1, 0, 0, 56], Text: 'WICK GAME', TextSize: 34, Font: 'Display', TextColor: [0.96, 0.65, 0.14], LayoutOrder: 1 });
  dm.create('TextLabel', menu, { Name: 'Subtitle', Size: [1, 0, 0, 24], Text: 'Built with the Wick UI system', TextSize: 14, TextColor: [0.6, 0.65, 0.75], LayoutOrder: 2 });
  for (const [i, [name, text]] of [['Play', 'Play'], ['Quit', 'Quit']].entries()) {
    const b = dm.create('TextButton', menu, { Name: name, Size: [1, 0, 0, 46], Text: text, TextSize: 20, LayoutOrder: 3 + i, BackgroundColor: i ? [0.2, 0.22, 0.3] : [0.96, 0.65, 0.14], TextColor: i ? [0.9, 0.92, 1] : [0.1, 0.07, 0.02] });
    dm.create('UICorner', b, { CornerRadius: 10 });
  }
  dm.create('Script', dm.gui, { Name: 'MenuScript', Source: MENU });
  dm.emit('reset');
}

/** Replaces the contents of dm with a template. Resolves when it is ready. */
export async function buildTemplate(id, dm) {
  switch (id) {
    case 'empty': dm.loadBlank('Empty Project', { baseplate: false }); break;
    case 'baseplate': dm.loadBlank('Bare Baseplate', { grass: false }); break;
    case 'grass': dm.loadBlank('Grass Baseplate'); break;
    case 'demo': buildDemo(dm); break;
    case 'playground': await playground(dm); break;
    case 'night': await night(dm); break;
    case 'ui': ui(dm); break;
    default: throw new Error(`Unknown template "${id}"`);
  }
}
