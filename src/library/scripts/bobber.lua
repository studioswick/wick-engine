-- Bobber: floats the Part up and down. Anchor the Part first.
local part = script.Parent
local HEIGHT, SPEED = 1.2, 1.6
local baseY = part.Position.Y
local t = 0

game:GetService("RunService").Heartbeat:Connect(function(dt)
  t = t + dt
  local p = part.Position
  part.Position = Vector3.new(p.X, baseY + math.sin(t * SPEED) * HEIGHT, p.Z)
end)
