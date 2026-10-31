-- Moving platform: slides the Part back and forth between its start and start + TRAVEL. Anchor the Part.
local platform = script.Parent
local TRAVEL = Vector3.new(0, 0, 24) -- how far it moves from where it starts
local SECONDS = 4                    -- one way
local start = platform.Position
local t = 0

game:GetService("RunService").Heartbeat:Connect(function(dt)
  t = t + dt
  local u = (t / SECONDS) % 2                 -- 0 to 1 going out, 1 to 2 coming back
  local f = u < 1 and u or 2 - u
  local k = (1 - math.cos(math.pi * f)) / 2   -- eases at both ends
  platform.Position = start + TRAVEL * k
end)
