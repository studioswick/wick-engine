-- Player controller: movement, procedural animation, IK and an orbit camera for the Wick player model.
-- Controls: W A S D or arrows move, Shift runs, Ctrl or C crouches, Space jumps, hold the right mouse button and drag
-- to turn the camera, mouse wheel zooms.
--
-- The model is a Model containing: Root (the invisible physics capsule), the limb Parts (Hips, Stomach, Chest, Neck,
-- Head and Left/Right UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot), and CameraRig. The limbs are Anchored and
-- posed here every frame, so you can recolor, retexture or reshape any of them freely. Lengths come from each
-- limb's Size.Y, so a longer leg Part just works.

local model = script.Parent
local root = model:FindFirstChild("Root")
local rig = model:FindFirstChild("CameraRig")
local cameraPoint = rig and rig:FindFirstChild("CameraPoint")
if not root then warn("PlayerController: the model needs a Part named Root") return end

local RunService = game:GetService("RunService")
local Input = game:GetService("UserInputService")

-- ---- tuning ----
local WALK, RUN, CROUCH_SPEED = 14, 24, 7
local ACCEL, DECEL, AIR_CONTROL = 110, 80, 0.35
local JUMP_SPEED = 19
local COYOTE, JUMP_BUFFER = 0.12, 0.12
local TURN_RATE = 720          -- degrees per second the body can turn
local CYCLE_LENGTH = 5.2       -- studs travelled per full walk cycle
local CAM_SENSITIVITY_X, CAM_SENSITIVITY_Y = 0.25, 0.2

-- ---- the rig ----
local function limb(name) local p = model:FindFirstChild(name) if not p then error("missing limb Part: " .. name) end return p end
local P = {}
for _, n in ipairs({ "Hips", "Stomach", "Chest", "Neck", "Head" }) do P[n] = limb(n) end
for _, side in ipairs({ "Left", "Right" }) do
  for _, n in ipairs({ "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot" }) do P[side .. n] = limb(side .. n) end
end
local rootHalf = root.Size.Y / 2
local hipsH, stomachH, chestH, neckH, headH = P.Hips.Size.Y, P.Stomach.Size.Y, P.Chest.Size.Y, P.Neck.Size.Y, P.Head.Size.Y
local upperLeg, lowerLeg, footH = P.LeftUpperLeg.Size.Y, P.LeftLowerLeg.Size.Y, P.LeftFoot.Size.Y
local upperArm, lowerArm = P.LeftUpperArm.Size.Y, P.LeftLowerArm.Size.Y
local hipSpread = P.Hips.Size.X * 0.3
local shoulderSpread = P.Chest.Size.X * 0.5 + P.LeftUpperArm.Size.X * 0.45

-- ---- maths ----
local rad, deg = math.rad, math.deg
local function clamp(x, lo, hi) return math.max(lo, math.min(hi, x)) end
local function approach(x, target, step) if x < target then return math.min(x + step, target) end return math.max(x - step, target) end
local function angleDiff(a, b) return (b - a + 180) % 360 - 180 end
local function smoothing(rate, dt) return 1 - math.exp(-rate * dt) end

-- Rotates v by the part rotation (pitch about X, yaw about Y, roll about Z, applied roll then pitch then yaw).
local function rot(v, pitch, yaw, roll)
  local cr, sr, cp, sp, cy, sy = math.cos(rad(roll)), math.sin(rad(roll)), math.cos(rad(pitch)), math.sin(rad(pitch)), math.cos(rad(yaw)), math.sin(rad(yaw))
  local x, y, z = v.X * cr - v.Y * sr, v.X * sr + v.Y * cr, v.Z
  y, z = y * cp - z * sp, y * sp + z * cp
  x, z = x * cy + z * sy, -x * sy + z * cy
  return Vector3.new(x, y, z)
end

-- Puts a Part (long axis Y) between two joints.
local function span(part, a, b)
  local d = b - a
  part.Position = (a + b) * 0.5
  part.Rotation = Vector3.new(deg(math.atan(math.sqrt(d.X * d.X + d.Z * d.Z), d.Y)), deg(math.atan(d.X, d.Z)), 0)
end

-- Two-bone IK: returns the middle joint (knee, elbow) and the end joint for a chain of lengths l1, l2 from `from`
-- toward `target`, with the middle joint pushed toward `pole`.
local function twoBone(from, target, l1, l2, pole)
  local to = target - from
  local dist = to.Magnitude
  if dist < 1e-4 then to, dist = Vector3.new(0, -1, 0), 1 end
  local reach = clamp(dist, math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001)
  local dir = to / dist
  local a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach)
  local h = math.sqrt(math.max(l1 * l1 - a * a, 0))
  local perp = pole - dir * pole:Dot(dir)
  if perp.Magnitude < 1e-4 then perp = Vector3.new(0, 0, 1) end
  return from + dir * a + perp.Unit * h, from + dir * reach
end

-- ---- state ----
local start = root.Position
local yaw, camYaw, camPitch, camDist, camDistNow = 0, 0, 18, 14, 14
local crouch, phase, lean, bob = 0, 0, 0, 0
local coyote, jumpBuffer, grounded = 0, 0, false
local sideLean, lastYaw = 0, 0
local head = Vector3.new(0, 0, 0)

Input.InputChanged:Connect(function(input)
  if input.UserInputType == "MouseMovement" then
    camYaw = camYaw + input.Delta.X * CAM_SENSITIVITY_X
    camPitch = clamp(camPitch + input.Delta.Y * CAM_SENSITIVITY_Y, -35, 70)
  elseif input.UserInputType == "MouseWheel" then
    camDist = clamp(camDist - input.Delta.Z * 1.5, 4, 32)
  end
end)
Input.InputBegan:Connect(function(input)
  if input.KeyCode == "Space" then jumpBuffer = JUMP_BUFFER end
end)

local function down(...) for _, k in ipairs({ ... }) do if Input:IsKeyDown(k) then return true end end return false end

local function groundBelow(x, y, z, reach)
  return workspace:Raycast(Vector3.new(x, y, z), Vector3.new(0, -reach, 0), root)
end

RunService.Heartbeat:Connect(function(dt)
  -- ---- input ----
  local ix = (down("D", "Right") and 1 or 0) - (down("A", "Left") and 1 or 0)
  local iz = (down("W", "Up") and 1 or 0) - (down("S", "Down") and 1 or 0)
  local mag = math.sqrt(ix * ix + iz * iz)
  if mag > 0 then ix, iz = ix / mag, iz / mag end
  local wantsRun, wantsCrouch = down("LeftShift", "RightShift"), down("LeftControl", "RightControl", "C")
  crouch = approach(crouch, wantsCrouch and 1 or 0, dt * 6)

  -- ---- ground ----
  local pos = root.Position
  local vel = root.Velocity
  local hit = groundBelow(pos.X, pos.Y, pos.Z, rootHalf + 0.35)
  grounded = hit ~= nil and vel.Y < 2
  coyote = grounded and COYOTE or math.max(coyote - dt, 0)
  jumpBuffer = math.max(jumpBuffer - dt, 0)

  -- ---- movement relative to the camera ----
  local fwd = Vector3.new(math.sin(rad(camYaw)), 0, math.cos(rad(camYaw)))
  local right = Vector3.new(math.cos(rad(camYaw)), 0, -math.sin(rad(camYaw)))
  local speed = (wantsCrouch and CROUCH_SPEED) or (wantsRun and RUN) or WALK
  local target = (right * ix + fwd * iz) * speed
  local current = Vector3.new(vel.X, 0, vel.Z)
  local diff = target - current
  local step = (mag > 0 and ACCEL or DECEL) * dt * (grounded and 1 or AIR_CONTROL)
  if diff.Magnitude <= step then current = target else current = current + diff.Unit * step end
  local vy = vel.Y
  if jumpBuffer > 0 and coyote > 0 then vy, coyote, jumpBuffer, grounded = JUMP_SPEED, 0, 0, false end
  root.Velocity = Vector3.new(current.X, vy, current.Z)

  local planar = current.Magnitude
  local moving = clamp(planar / 6, 0, 1)
  if planar > 1 then yaw = yaw + clamp(angleDiff(yaw, deg(math.atan(current.X, current.Z))), -TURN_RATE * dt, TURN_RATE * dt) end
  local turnRate = angleDiff(lastYaw, yaw) / math.max(dt, 1e-3)
  lastYaw = yaw
  sideLean = sideLean + (clamp(-turnRate * 0.03, -9, 9) * moving - sideLean) * smoothing(8, dt)
  lean = lean + (clamp(planar / RUN, 0, 1) * 11 - lean) * smoothing(6, dt)

  -- ---- body ----
  local floorY = hit and hit.Position.Y or (pos.Y - rootHalf)
  phase = phase + (grounded and planar or planar * 0.4) / CYCLE_LENGTH * math.pi * 2 * dt
  bob = bob + (math.abs(math.sin(phase)) * 0.14 * moving - bob) * smoothing(14, dt)
  local standing = footH + (upperLeg + lowerLeg) * 0.97
  local hipsY = (grounded and floorY or pos.Y - rootHalf + 0.15) + standing - crouch * (upperLeg + lowerLeg) * 0.32 - bob
  local base = Vector3.new(pos.X, hipsY, pos.Z)
  local breathe = math.sin(os.clock() * 1.6) * 0.6 * (1 - moving)

  -- Spine: every segment adds a little lean, so the torso bends instead of tilting as one slab.
  local spine = {
    { P.Hips, hipsH, 0.15 }, { P.Stomach, stomachH, 0.3 }, { P.Chest, chestH, 0.35 }, { P.Neck, neckH, 0.1 },
  }
  local pitchSoFar, rollSoFar = crouch * 8, 0
  local joint = base - Vector3.new(0, hipsH * 0.35, 0)
  local chestCentre, chestPitch, chestRoll
  for _, s in ipairs(spine) do
    local part, h, share = s[1], s[2], s[3]
    pitchSoFar = pitchSoFar + (lean + crouch * 14 + breathe) * share
    rollSoFar = rollSoFar + sideLean * share
    local up = rot(Vector3.new(0, 1, 0), pitchSoFar, yaw, rollSoFar)
    part.Position = joint + up * (h / 2)
    part.Rotation = Vector3.new(pitchSoFar, yaw, rollSoFar)
    if part == P.Chest then chestCentre, chestPitch, chestRoll = part.Position, pitchSoFar, rollSoFar end
    joint = joint + up * h
  end
  local headYaw = yaw + clamp(angleDiff(yaw, camYaw), -55, 55) * 0.7
  local headPitch = clamp(camPitch * 0.45, -25, 35)
  local headUp = rot(Vector3.new(0, 1, 0), headPitch, headYaw, 0)
  P.Head.Position = joint + headUp * (headH / 2 - 0.05)
  P.Head.Rotation = Vector3.new(headPitch, headYaw, 0)
  head = P.Head.Position

  -- Local axes of the body for placing joints.
  local bodyRight = rot(Vector3.new(1, 0, 0), 0, yaw, 0)
  local bodyFwd = rot(Vector3.new(0, 0, 1), 0, yaw, 0)
  local bodyUp = Vector3.new(0, 1, 0)

  -- ---- legs: gait with foot planting on whatever ground is under each foot ----
  local stride = (0.5 + crouch * 0.1) * 3 * moving
  for i, side in ipairs({ "Left", "Right" }) do
    local sign = i == 1 and -1 or 1
    local hip = base + bodyRight * (hipSpread * sign)
    local ph = phase + (i == 1 and 0 or math.pi)
    local swing = math.cos(ph) * stride
    local lift = math.max(0, math.sin(ph)) * (0.7 + 0.3 * (1 - crouch)) * moving
    local fx, fz = hip.X + bodyFwd.X * swing, hip.Z + bodyFwd.Z * swing
    local ankle
    if grounded then
      local g = groundBelow(fx, hipsY + 0.5, fz, standing + 2.2)
      ankle = Vector3.new(fx, (g and g.Position.Y or floorY) + footH + lift, fz)
    else
      ankle = hip - bodyUp * ((upperLeg + lowerLeg) * 0.82) + bodyFwd * (0.5 * clamp(vy / JUMP_SPEED, -1, 1) + 0.3 * sign * 0)
    end
    local knee, tip = twoBone(hip, ankle, upperLeg, lowerLeg, bodyFwd * 1 + bodyRight * sign * 0.25 + bodyUp * 0.1)
    span(P[side .. "UpperLeg"], hip, knee)
    span(P[side .. "LowerLeg"], knee, tip)
    local footPitch = -lift * 22 + (grounded and 0 or 12)
    P[side .. "Foot"].Position = tip - Vector3.new(0, footH * 0.5, 0) + bodyFwd * 0.25
    P[side .. "Foot"].Rotation = Vector3.new(footPitch, yaw, 0)
  end

  -- ---- arms: swing opposite the legs, hang loosely at rest, rise in the air ----
  for i, side in ipairs({ "Left", "Right" }) do
    local sign = i == 1 and -1 or 1
    local shoulder = chestCentre + rot(Vector3.new(sign * shoulderSpread, chestH * 0.36, 0), chestPitch, yaw, chestRoll)
    local ph = phase + (i == 1 and math.pi or 0)
    local reach = (upperArm + lowerArm) * 0.9
    local swing = math.cos(ph) * 1.4 * moving + math.sin(os.clock() * 1.3 + i) * 0.12 * (1 - moving)
    local hand
    if grounded then
      hand = shoulder - bodyUp * (reach * (1 - 0.1 * moving)) + bodyFwd * swing + bodyRight * sign * (0.25 + 0.15 * moving)
    else
      hand = shoulder + bodyUp * (reach * 0.25) + bodyFwd * (reach * 0.45) + bodyRight * sign * (reach * 0.55)
    end
    local elbow, tip = twoBone(shoulder, hand, upperArm, lowerArm, -bodyFwd * 0.8 + bodyRight * sign * 0.6 - bodyUp * 0.2)
    span(P[side .. "UpperArm"], shoulder, elbow)
    span(P[side .. "LowerArm"], elbow, tip)
    P[side .. "Hand"].Position = tip + (tip - elbow).Unit * (P[side .. "Hand"].Size.Y * 0.35)
    P[side .. "Hand"].Rotation = Vector3.new(0, yaw, 0)
  end

  -- ---- camera: orbit rig that pulls in when a wall is behind the player ----
  if rig then
    local anchor = head + Vector3.new(0, 0.6, 0)
    rig.Position = anchor
    rig.Rotation = Vector3.new(camPitch, camYaw, 0)
    if cameraPoint then
      local look = Vector3.new(math.cos(rad(camPitch)) * math.sin(rad(camYaw)), -math.sin(rad(camPitch)), math.cos(rad(camPitch)) * math.cos(rad(camYaw)))
      local wall = workspace:Raycast(anchor, -look * (camDist + 0.6), root)
      local allowed = wall and math.max(wall.Distance - 0.6, 1.5) or camDist
      camDistNow = camDistNow + (allowed - camDistNow) * smoothing(allowed < camDistNow and 25 or 6, dt)
      cameraPoint.Offset = Vector3.new(0, 0, -camDistNow)
    end
  end

  -- ---- fell out of the world ----
  if pos.Y < start.Y - 150 then
    root.Position = start
    root.Velocity = Vector3.zero
  end
end)
