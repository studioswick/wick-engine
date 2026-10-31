-- Coin pickup: when anything touches the Part it is collected. Put a Sound inside the Part to hear it.
-- Counts collected coins in _G.coins so other scripts (a HUD, for example) can read it.
local coin = script.Parent
_G.coins = _G.coins or 0
local collected = false

coin.Touched:Connect(function(other)
  if collected then return end
  collected = true
  _G.coins = _G.coins + 1
  print("Coins:", _G.coins)
  local sound = coin:FindFirstChild("Sound")
  if sound then
    sound:Play()
    coin.Transparency = 1
    coin.CanCollide = false
    task.delay(1, function() coin:Destroy() end)
  else
    coin:Destroy()
  end
end)
