-- Spinner: turns the Part this script sits in around its Y axis. Anchor the Part so physics does not fight the script.
local part = script.Parent
local SPEED = 90 -- degrees per second
local angle = part.Rotation.Y

game:GetService("RunService").Heartbeat:Connect(function(dt)
  angle = (angle + SPEED * dt) % 360
  part.Rotation = Vector3.new(part.Rotation.X, angle, part.Rotation.Z)
end)
