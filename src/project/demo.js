// Wick Engine demo project, loaded on a first visit. It shows Babylon's PBR materials, shadows and bloom,
// Havok rigid bodies, a Lua-driven beacon with positional audio, and a cannonball launcher.

const LAUNCHER = `-- Launcher: press Space or left-click in the viewport to fire a ball from the camera.
local camera = workspace.CurrentCamera
local input = game:GetService("UserInputService")
local shots = Instance.new("Folder", workspace)
shots.Name = "Shots"
local MAX_SHOTS = 30

local function launch()
  local ball = Instance.new("Part")
  ball.Name = "Cannonball"
  ball.Shape = "Ball"
  ball.Size = Vector3.new(1.6, 1.6, 1.6)
  ball.Material = "Metal"
  ball.Color = Color3.fromRGB(235, 190, 70)
  ball.Density = 8
  ball.Bounciness = 0.1
  ball.Position = camera.Position + camera.LookVector * 3
  ball.Parent = shots
  ball.Velocity = camera.LookVector * 70

  local thud = Instance.new("Sound")
  thud.SoundId = "wick://tone/thud"
  thud.Volume = 1
  thud.Parent = ball
  ball.Touched:Connect(function()
    thud:Play()
  end)

  -- Keep the scene tidy: remove old shots.
  local all = shots:GetChildren()
  if #all > MAX_SHOTS then
    all[1]:Destroy()
  end
  task.delay(12, function()
    ball:Destroy()
  end)
end

input.InputBegan:Connect(function(key)
  if key.KeyCode == "Space" or key.KeyCode == "MouseButton1" then
    launch()
  end
end)

print("Wick demo running. Press Space or click to fire a ball.")
`;

const BEACON = `-- Beacon: bobs and spins the glowing sphere. It is Anchored, so the script moves it directly.
local beacon = workspace.Beacon
local t = 0

game:GetService("RunService").Heartbeat:Connect(function(dt)
  t = t + dt
  beacon.Position = Vector3.new(0, 11 + math.sin(t * 1.5) * 1.2, 10)
  beacon.Rotation = Vector3.new((t * 40) % 360, (t * 70) % 360, 0)
end)
`;

export function buildDemo(dm) {
  dm.loadBlank('Wick Engine Demo');
  const ws = dm.workspace;
  dm.set(dm.lighting, 'ClockTime', 16.5); // golden hour
  dm.set(dm.lighting, 'Brightness', 1.7);

  const ground = ws.children[0];
  dm.set(ground, 'Name', 'Ground');
  dm.set(ground, 'Size', [160, 1, 160]);
  dm.set(ground, 'Color', [0.3, 0.44, 0.3]);
  dm.set(ground, 'Friction', 0.9);

  // A staggered brick wall: easy for the cannonballs to knock down.
  const wall = dm.create('Folder', ws, { Name: 'Wall' });
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const shade = 0.55 + ((col * 7 + row * 3) % 5) * 0.045;
      dm.create('Part', wall, {
        Name: `Brick_${row}_${col}`,
        Size: [2, 1, 1],
        Position: [-5 + col * 2 + (row % 2) * 1, 0.5 + row, 0],
        Color: [shade, shade * 0.42, shade * 0.3],
        Friction: 0.7,
        Bounciness: 0.05,
      });
    }
  }

  // Materials showcase.
  dm.create('Part', ws, { Name: 'GlassPane', Size: [5, 7, 0.4], Position: [9, 3.5, -5], Anchored: true, Material: 'Glass', Color: [0.5, 0.8, 1], CastShadow: false });
  dm.create('Part', ws, { Name: 'NeonBar', Shape: 'Cylinder', Size: [0.6, 12, 0.6], Position: [-9, 6, -6], Anchored: true, Material: 'Neon', Color: [0.2, 0.9, 1] });
  dm.create('Part', ws, { Name: 'ChromeBall', Shape: 'Ball', Size: [3, 3, 3], Position: [-10, 1.5, -2], Material: 'Metal', Color: [0.85, 0.87, 0.9], Bounciness: 0.3 });
  dm.create('Part', ws, { Name: 'Ramp', Size: [10, 0.8, 8], Position: [-16, 2.2, 10], Rotation: [0, 0, -22], Anchored: true, Material: 'Wood', Color: [0.62, 0.42, 0.24] });

  const balls = dm.create('Folder', ws, { Name: 'Balls' });
  const drops = [
    ['RedBall', [-16, 9, 10], [0.9, 0.18, 0.18], 'Plastic', 0.8],
    ['GreenBall', [-14, 13, 10], [0.2, 0.95, 0.4], 'Neon', 0.6],
    ['WoodBall', [-17, 17, 10], [0.7, 0.5, 0.3], 'Wood', 0.35],
    ['BlueBall', [6, 16, -10], [0.25, 0.4, 0.95], 'Plastic', 0.7],
  ];
  for (const [name, position, color, material, bounce] of drops) {
    dm.create('Part', balls, { Name: name, Shape: 'Ball', Size: [2.2, 2.2, 2.2], Position: position, Color: color, Material: material, Bounciness: bounce });
  }

  // Beacon: neon sphere with a light and a looping positional hum.
  const beacon = dm.create('Part', ws, { Name: 'Beacon', Shape: 'Ball', Size: [3, 3, 3], Position: [0, 11, 10], Anchored: true, Material: 'Neon', Color: [1, 0.55, 0.15], CastShadow: false });
  dm.create('PointLight', beacon, { Color: [1, 0.6, 0.25], Brightness: 8, Range: 45 });
  dm.create('Sound', beacon, { Name: 'Hum', SoundId: 'wick://tone/hum', Looped: true, PlayOnStart: true, Volume: 0.6, MaxDistance: 70 });

  dm.create('Script', dm.scripts, { Name: 'Launcher', Source: LAUNCHER });
  dm.create('Script', dm.scripts, { Name: 'Beacon', Source: BEACON });
}
