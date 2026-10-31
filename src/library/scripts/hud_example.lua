-- HUD example: builds a small interface from code. A coin counter, and a button that tweens a panel open and shut.
-- You can also build interfaces by hand: Insert > UI in the Studio, then edit Position and Size in Properties.
local gui = Instance.new("ScreenGui", game.Gui)
gui.Name = "ExampleHud"

local counter = Instance.new("TextLabel", gui)
counter.Name = "CoinCounter"
counter.AnchorPoint = Vector2.new(1, 0)
counter.Position = UDim2.new(1, -16, 0, 16)         -- 16px from the top right corner
counter.Size = UDim2.fromOffset(150, 40)
counter.BackgroundColor = Color3.fromRGB(20, 24, 33)
counter.BackgroundTransparency = 0.2
counter.TextColor = Color3.fromRGB(255, 200, 80)
counter.TextSize = 20
counter.Text = "Coins: 0"
Instance.new("UICorner", counter).CornerRadius = 10

local panel = Instance.new("Frame", gui)
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.fromScale(0.5, 1.5)          -- starts below the screen
panel.Size = UDim2.fromOffset(320, 160)
Instance.new("UICorner", panel).CornerRadius = 14
local stroke = Instance.new("UIStroke", panel)
stroke.Color = Color3.fromRGB(245, 165, 36)
stroke.Thickness = 2
local list = Instance.new("UIListLayout", panel)
list.HorizontalAlignment = "Center"
list.VerticalAlignment = "Center"
local pad = Instance.new("UIPadding", panel)

local title = Instance.new("TextLabel", panel)
title.Size = UDim2.new(1, 0, 0, 40)
title.Text = "Hello from Lua"
title.TextSize = 22

local open = false
local button = Instance.new("TextButton", gui)
button.AnchorPoint = Vector2.new(0.5, 1)
button.Position = UDim2.new(0.5, 0, 1, -20)
button.Size = UDim2.fromOffset(160, 44)
button.Text = "Toggle panel"
Instance.new("UICorner", button).CornerRadius = 10

button.MouseButton1Click:Connect(function()
  open = not open
  local goal = open and UDim2.fromScale(0.5, 0.5) or UDim2.fromScale(0.5, 1.5)
  game:GetService("TweenService"):Create(panel, TweenInfo.new(0.45, "Back", "Out"), { Position = goal }):Play()
end)

game:GetService("RunService").Heartbeat:Connect(function()
  counter.Text = "Coins: " .. tostring(_G.coins or 0)
end)
