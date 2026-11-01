-- Player controller: movement, procedural animation with planted feet and two-bone IK, and an orbit camera for the Wick
-- player model.
-- Controls: W A S D or arrows move, Shift runs, Ctrl or C crouches, Space jumps (hold it for a higher jump), hold the
-- right mouse button and drag to turn the camera, mouse wheel zooms.
--
-- The model is a Model containing: Root (the invisible physics capsule), the limb Parts (Hips, Stomach, Chest, Neck,
-- Head and Left/Right UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot), and CameraRig. The limbs are Anchored and
-- posed here every frame, so you can recolor, retexture or reshape any of them freely. Lengths come from each limb's
-- Size.Y (the foot's length from Size.Z), so a longer leg Part just works.

local model = script.Parent
local root = model:FindFirstChild("Root")
local rig = model:FindFirstChild("CameraRig")
local cameraPoint = rig and rig:FindFirstChild("CameraPoint")
if not root then warn("PlayerController: the model needs a Part named Root") return end

local RunService = game:GetService("RunService")
local Input = game:GetService("UserInputService")

-- ---- tuning ----
local WALK, RUN, CROUCH_SPEED = 6, 13, 3          -- studs per second (the model is 5.6 studs tall)
local ACCEL, DECEL, AIR_CONTROL = 70, 80, 0.5
local TURN_RATE = 540                             -- degrees per second the body can turn
local JUMP_HEIGHT = 4.5
local RISE_GRAVITY, FALL_GRAVITY, CUT_GRAVITY = 80, 130, 240 -- studs/s^2 rising, falling, and rising after Space is let go
local COYOTE, JUMP_BUFFER = 0.1, 0.12
local STEP_HEIGHT = 1.3                           -- tallest ledge that is walked up without jumping
local CAM_SENSITIVITY_X, CAM_SENSITIVITY_Y = 0.25, 0.2
local GRAVITY_SCALE = 3                           -- the engine multiplies Workspace.Gravity by this
local JUMP_SPEED = math.sqrt(2 * RISE_GRAVITY * JUMP_HEIGHT)

-- ---- the rig ----
local function limb(name) local p = model:FindFirstChild(name) if not p then error("missing limb Part: " .. name) end return p end
local P = {}
for _, n in ipairs({ "Hips", "Stomach", "Chest", "Neck", "Head" }) do P[n] = limb(n) end
for _, side in ipairs({ "Left", "Right" }) do
  for _, n in ipairs({ "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot" }) do P[side .. n] = limb(side .. n) end
end
local rootHalf, rootRadius = root.Size.Y / 2, root.Size.X / 2
local hipsH, stomachH, chestH, neckH, headH = P.Hips.Size.Y, P.Stomach.Size.Y, P.Chest.Size.Y, P.Neck.Size.Y, P.Head.Size.Y
local upperLeg, lowerLeg = P.LeftUpperLeg.Size.Y, P.LeftLowerLeg.Size.Y
local footH, footLen = P.LeftFoot.Size.Y, P.LeftFoot.Size.Z
local upperArm, lowerArm = P.LeftUpperArm.Size.Y, P.LeftLowerArm.Size.Y
local legLen, armLen = upperLeg + lowerLeg, upperArm + lowerArm
local ankleBack = footLen * 0.23                   -- the ankle sits this far behind the foot's centre
local hipSpread = P.Hips.Size.X * 0.3
local footSpread = hipSpread * 1.1
local shoulderSpread = P.Chest.Size.X * 0.5 + P.LeftUpperArm.Size.X * 0.45
local standing = footH + legLen * 0.92             -- hip height above the ground in a relaxed stance
local maxReach = legLen * 0.985

-- ---- maths ----
local rad, deg = math.rad, math.deg
local UP = Vector3.new(0, 1, 0)
local function clamp(x, lo, hi) return math.max(lo, math.min(hi, x)) end
local function approach(x, target, step) if x < target then return math.min(x + step, target) end return math.max(x - step, target) end
local function angleDiff(a, b) return (b - a + 180) % 360 - 180 end
local function smoothing(rate, dt) return 1 - math.exp(-rate * dt) end
local function smooth01(t) return t * t * (3 - 2 * t) end

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

-- One foot through a gait cycle (p from 0 to 1). The stance part moves the foot backward at exactly the body's speed,
-- so it stays put on the ground; the swing part carries it forward on an arc. Returns how far ahead of the hip the foot
-- is, how high it is lifted, its toe-down pitch in degrees, and whether it is on the ground.
local function gaitFoot(p, duty, stride, lift)
  if p < duty then
    local u = p / duty
    local pitch = -9 * (1 - smooth01(clamp(u * 3, 0, 1))) + 30 * smooth01(clamp((u - 0.62) / 0.38, 0, 1))
    return stride * (0.5 - u), 0, pitch, true
  end
  local u = (p - duty) / (1 - duty)
  local v = smooth01(u)
  return stride * (v - 0.5), lift * math.sin(math.pi * u), 30 - 39 * v, false
end

local function groundAt(x, z, feetY)
  local h = workspace:Raycast(Vector3.new(x, feetY + 2.2, z), Vector3.new(0, -5.5, 0), root)
  if h then return h.Position.Y, h.Normal end
  return feetY, UP
end

-- ---- state ----
local start = root.Position
local yaw, camYaw, camPitch, camDist, camDistNow = 0, 0, 18, 12, 12
local crouch, phase, lean, sideLean, lastYaw = 0, 0, 0, 0, 0
local coyote, jumpBuffer, grounded, airTime, stepTimer = 0, 0, false, 0, 0
local air, landDip, flight, prevVy = 0, 0, 0, 0
local leadLeg = 1
local hipsY = start.Y - rootHalf + standing
local camAnchorY = start.Y
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

RunService.Heartbeat:Connect(function(dt)
  dt = math.min(dt, 0.1)

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
  local feetY = pos.Y - rootHalf
  local hit = workspace:Raycast(pos, Vector3.new(0, -(rootHalf + 0.4), 0), root)
  local wasGrounded = grounded
  stepTimer = math.max(stepTimer - dt, 0)
  grounded = (hit ~= nil and vel.Y < 3) or stepTimer > 0
  if grounded then airTime, coyote = 0, COYOTE else airTime, coyote = airTime + dt, math.max(coyote - dt, 0) end
  jumpBuffer = math.max(jumpBuffer - dt, 0)
  if grounded and not wasGrounded and prevVy < -8 then landDip = math.max(landDip, clamp(-prevVy / 45, 0.2, 1)) end
  landDip = landDip * math.exp(-9 * dt)

  -- ---- movement relative to the camera ----
  local fwd = Vector3.new(math.sin(rad(camYaw)), 0, math.cos(rad(camYaw)))
  local right = Vector3.new(math.cos(rad(camYaw)), 0, -math.sin(rad(camYaw)))
  local speed = (wantsCrouch and CROUCH_SPEED) or (wantsRun and RUN) or WALK
  local target = (right * ix + fwd * iz) * speed
  local current = Vector3.new(vel.X, 0, vel.Z)
  local diff = target - current
  local step = (mag > 0 and ACCEL or DECEL) * dt * (grounded and 1 or AIR_CONTROL)
  if diff.Magnitude <= step then current = target else current = current + diff.Unit * step end

  -- ---- jumping and gravity: extra pull on top of the engine's, strongest when falling or when Space is let go ----
  local vy = vel.Y
  if jumpBuffer > 0 and coyote > 0 then
    vy, coyote, jumpBuffer, grounded, stepTimer = JUMP_SPEED, 0, 0, false, 0
    leadLeg = phase < 0.5 and 1 or 2
  end
  if not grounded then
    local g = vy > 0 and (down("Space") and RISE_GRAVITY or CUT_GRAVITY) or FALL_GRAVITY
    vy = math.max(vy - math.max(0, g - workspace.Gravity * GRAVITY_SCALE) * dt, -90)
  end

  -- ---- stepping up a ledge: lift the capsule over it, because a flat-bottomed cylinder would stop at the riser ----
  if grounded and stepTimer <= 0 and hit and hit.Normal.Y > 0.95 and current.Magnitude > 2 then
    local ahead = pos + current.Unit * (rootRadius + 0.45)
    local top = workspace:Raycast(Vector3.new(ahead.X, feetY + STEP_HEIGHT + 0.25, ahead.Z), Vector3.new(0, -(STEP_HEIGHT + 0.25), 0), root)
    if top and top.Normal.Y > 0.9 then
      local rise = top.Position.Y - feetY
      if rise > 0.5 and rise <= STEP_HEIGHT then
        root.Position = Vector3.new(pos.X, pos.Y + rise + 0.03, pos.Z)
        pos, feetY, vy, stepTimer = root.Position, feetY + rise + 0.03, 0, 0.12
      end
    end
  end
  root.Velocity = Vector3.new(current.X, vy, current.Z)
  prevVy = vy

  -- ---- facing ----
  local planar = current.Magnitude
  local moving = clamp(planar / 3, 0, 1)
  local rf = clamp((planar - WALK) / (RUN - WALK), 0, 1)           -- 0 walking, 1 running flat out
  if planar > 1 then yaw = yaw + clamp(angleDiff(yaw, deg(math.atan(current.X, current.Z))), -TURN_RATE * dt, TURN_RATE * dt) end
  local turnRate = angleDiff(lastYaw, yaw) / math.max(dt, 1e-3)
  lastYaw = yaw
  sideLean = sideLean + (clamp(-turnRate * 0.02, -7, 7) * moving - sideLean) * smoothing(8, dt)
  lean = lean + (clamp(planar / RUN, 0, 1) * 10 - lean) * smoothing(6, dt)
  air = air + (((not grounded and airTime > 0.12) and 1 or 0) - air) * smoothing(16, dt)

  -- ---- gait: the cycle length follows speed, so a planted foot never slides ----
  local duty = 0.62 - 0.22 * rf                                     -- share of the cycle each foot is on the ground
  local stride = (2.6 + 0.6 * rf) * clamp(0.35 + 0.65 * planar / WALK, 0.35, 1)
  local lift = 0.4 + 0.7 * rf
  if grounded then phase = (phase + planar / (stride / duty) * dt) % 1 end
  local sway = math.cos(phase * 2 * math.pi)
  local twistC, twistP = -sway * (4 + 8 * rf) * moving, sway * (2.5 + 5 * rf) * moving

  local sinY, cosY = math.sin(rad(yaw)), math.cos(rad(yaw))
  local bodyFwd, bodyRight, bodyUp = Vector3.new(sinY, 0, cosY), Vector3.new(cosY, 0, -sinY), UP
  local baseX, baseZ = pos.X, pos.Z

  -- Where each foot goes, and the highest the hips may be for the planted ones to still reach the ground.
  local feet, limitY, stanceCount = {}, math.huge, 0
  for i = 1, 2 do
    local sign = i == 1 and -1 or 1
    local off, rise, toe, planted = gaitFoot((phase + (i == 2 and 0.5 or 0)) % 1, duty, stride, lift)
    off, rise, toe = off * moving, rise * moving, toe * moving
    local fx = baseX + bodyRight.X * sign * footSpread + bodyFwd.X * off
    local fz = baseZ + bodyRight.Z * sign * footSpread + bodyFwd.Z * off
    local gy, n = groundAt(fx, fz, feetY)
    local pitch = toe + clamp(deg(math.atan(n:Dot(bodyFwd), n.Y)), -35, 35)
    local c, s = math.cos(rad(pitch)), math.sin(rad(pitch))
    local ankleY = gy + footH * c + footLen * 0.5 * math.abs(s) + ankleBack * s
    feet[i] = { x = fx, z = fz, gy = gy, pitch = pitch, ankleY = ankleY + rise }
    if planted then
      stanceCount = stanceCount + 1
      local hx, hz = baseX + bodyRight.X * sign * hipSpread, baseZ + bodyRight.Z * sign * hipSpread
      local dh = math.sqrt((fx - hx) ^ 2 + (fz - hz) ^ 2)
      limitY = math.min(limitY, ankleY + math.sqrt(math.max(maxReach * maxReach - dh * dh, 0.04)))
    end
  end

  -- ---- pelvis height ----
  flight = approach(flight, (stanceCount == 0 and moving > 0.5) and 1 or 0, dt * 10)
  local groundMean = (feet[1].gy + feet[2].gy) / 2
  local relaxed = groundMean + standing * (1 - 0.08 * rf) - crouch * legLen * 0.3 - landDip * legLen * 0.28 + flight * rf * 0.22
  local onGround = math.min(relaxed, limitY)
  local hipsTarget = onGround + (feetY + standing * 0.9 - onGround) * air
  if hipsTarget < hipsY then hipsY = hipsTarget else hipsY = hipsY + (hipsTarget - hipsY) * smoothing(18, dt) end
  local base = Vector3.new(baseX, hipsY, baseZ)
  local breathe = math.sin(os.clock() * 1.6) * 0.6 * (1 - moving)

  -- ---- spine: every segment adds a little lean and twist, so the torso bends instead of tilting as one slab ----
  local spine = {
    { P.Hips, hipsH, 0.15, twistP }, { P.Stomach, stomachH, 0.3, (twistP + twistC) * 0.5 },
    { P.Chest, chestH, 0.35, twistC }, { P.Neck, neckH, 0.1, twistC * 0.5 },
  }
  local pitchSoFar, rollSoFar = crouch * 8, 0
  local joint = base - Vector3.new(0, hipsH * 0.35, 0)
  local chestCentre, chestPitch, chestYaw, chestRoll
  for _, s in ipairs(spine) do
    local part, h, share, twist = s[1], s[2], s[3], s[4]
    pitchSoFar = pitchSoFar + (lean + crouch * 14 + landDip * 14 + breathe) * share
    rollSoFar = rollSoFar + sideLean * share
    local segYaw = yaw + twist
    local up = rot(UP, pitchSoFar, segYaw, rollSoFar)
    part.Position = joint + up * (h / 2)
    part.Rotation = Vector3.new(pitchSoFar, segYaw, rollSoFar)
    if part == P.Chest then chestCentre, chestPitch, chestYaw, chestRoll = part.Position, pitchSoFar, segYaw, rollSoFar end
    joint = joint + up * h
  end
  local headYaw = yaw + clamp(angleDiff(yaw, camYaw), -55, 55) * 0.7
  local headPitch = clamp(camPitch * 0.45, -25, 35)
  local headUp = rot(UP, headPitch, headYaw, 0)
  P.Head.Position = joint + headUp * (headH / 2 - 0.05)
  P.Head.Rotation = Vector3.new(headPitch, headYaw, 0)
  head = P.Head.Position

  -- ---- legs: planted feet, or a tucked pose in the air ----
  local rising = clamp(vy / JUMP_SPEED * 1.2, -1, 1)
  local tuck = clamp(0.5 + 0.5 * rising, 0, 1)
  for i, side in ipairs({ "Left", "Right" }) do
    local sign = i == 1 and -1 or 1
    local hip = base + rot(Vector3.new(sign * hipSpread, 0, 0), 0, yaw + twistP, sideLean * 0.3)
    local f = feet[i]
    local ankle, pitch = Vector3.new(f.x, f.ankleY, f.z), f.pitch
    if air > 0.001 then
      local lead = i == leadLeg and 1 or 0.25
      local airAnkle = hip - bodyUp * (legLen * (0.9 - 0.3 * tuck * lead)) + bodyFwd * (0.6 * tuck * (i == leadLeg and 1 or -0.5) + 0.2 * (1 - tuck))
      ankle = ankle:Lerp(airAnkle, air)
      pitch = pitch + (12 * tuck - pitch) * air
    end
    local knee, tip = twoBone(hip, ankle, upperLeg, lowerLeg, bodyFwd + bodyRight * (sign * 0.25) + bodyUp * 0.1)
    span(P[side .. "UpperLeg"], hip, knee)
    span(P[side .. "LowerLeg"], knee, tip)
    P[side .. "Foot"].Position = tip - rot(Vector3.new(0, footH * 0.5, -ankleBack), pitch, yaw, 0)
    P[side .. "Foot"].Rotation = Vector3.new(pitch, yaw, 0)
  end

  -- ---- arms: swing opposite the legs, bend more when running, rise in the air ----
  for i, side in ipairs({ "Left", "Right" }) do
    local sign = i == 1 and -1 or 1
    local shoulder = chestCentre + rot(Vector3.new(sign * shoulderSpread, chestH * 0.36, 0), chestPitch, chestYaw, chestRoll)
    local swing = (i == 1 and -sway or sway) * (0.9 + 0.9 * rf) * moving + math.sin(os.clock() * 1.3 + i) * 0.1 * (1 - moving)
    local reach = armLen * (0.9 - 0.3 * rf)
    local hand = shoulder - bodyUp * (reach - 0.5 * math.max(swing, 0) * (0.5 + rf)) + bodyFwd * swing + bodyRight * sign * (0.3 + 0.15 * moving)
    if air > 0.001 then
      local airHand = shoulder + bodyUp * (armLen * 0.2) + bodyFwd * (armLen * 0.35) + bodyRight * sign * (armLen * 0.55)
      hand = hand:Lerp(airHand, air)
    end
    local elbow, tip = twoBone(shoulder, hand, upperArm, lowerArm, -bodyFwd * 0.8 + bodyRight * sign * 0.6 - bodyUp * 0.2)
    span(P[side .. "UpperArm"], shoulder, elbow)
    span(P[side .. "LowerArm"], elbow, tip)
    P[side .. "Hand"].Position = tip + (tip - elbow).Unit * (P[side .. "Hand"].Size.Y * 0.35)
    P[side .. "Hand"].Rotation = Vector3.new(0, yaw, 0)
  end

  -- ---- camera: orbit rig that pulls in when a wall is behind the player ----
  if rig then
    camAnchorY = camAnchorY + (pos.Y + rootHalf * 0.85 - camAnchorY) * smoothing(grounded and 14 or 30, dt)
    local anchor = Vector3.new(pos.X, camAnchorY, pos.Z)
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
