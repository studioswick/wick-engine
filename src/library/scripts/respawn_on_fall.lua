-- Respawn on fall: puts the Part back where it began when it drops below the world. Works for any unanchored Part.
local part = script.Parent
local spawn = part.Position
local LIMIT = -100

game:GetService("RunService").Heartbeat:Connect(function()
  if part.Position.Y < LIMIT then
    part.Velocity = Vector3.zero
    part.Position = spawn
  end
end)
