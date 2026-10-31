-- Jump pad: launches whatever lands on it. Anchor the Part. Tune POWER for a bigger or smaller bounce.
local pad = script.Parent
local POWER = 70

pad.Touched:Connect(function(other)
  if other.Anchored then return end
  local v = other.Velocity
  other.Velocity = Vector3.new(v.X, POWER, v.Z)
end)
