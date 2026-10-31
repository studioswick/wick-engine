-- Day and night: makes a full day last two minutes, starting at dawn. Change DayLength to speed it up or slow it down.
local lighting = game.Lighting
lighting.ClockTime = 6
lighting.DayLength = 120 -- seconds for 24 hours of game time. 0 keeps the time fixed.
