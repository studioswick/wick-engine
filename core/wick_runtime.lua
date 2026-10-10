-- Wick Engine scripting runtime.
-- Loaded once per Play session inside the WASM Lua VM. Game scripts run in a sandbox (`G`, bottom of file)
-- and never see the real globals. All engine access goes through one C function, host(op, id, a, b) -> string.

local host, slice, elapsed = __wick_host, __wick_slice, __wick_elapsed
__wick_host, __wick_slice, __wick_elapsed = nil, nil, nil
local getmt = debug.getmetatable -- ignores __metatable, so internal type checks keep working

local SEP = "\31"                -- separates items in encoded lists
local FIRST_SLICE, SLICE = 1000, 100  -- per-resume time budgets in ms (first run of a script, later resumes)
local FRAME_BUDGET = 35          -- ms of script work per frame before sleeping threads are pushed to the next frame

-- ---------------------------------------------------------------------------------------------
-- Value types
-- ---------------------------------------------------------------------------------------------

local V3, C3, InstanceMT = { __metatable = "locked" }, { __metatable = "locked" }, { __metatable = "locked" }
local Vector3, Color3 = {}, {}

function Vector3.new(x, y, z) return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, V3) end
Vector3.zero, Vector3.one = Vector3.new(0, 0, 0), Vector3.new(1, 1, 1)

local V3methods = {
  Dot = function(a, b) return a.X * b.X + a.Y * b.Y + a.Z * b.Z end,
  Cross = function(a, b)
    return Vector3.new(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X)
  end,
  Lerp = function(a, b, t)
    return Vector3.new(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t)
  end,
}

V3.__index = function(v, k)
  if k == "Magnitude" then
    return math.sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z)
  elseif k == "Unit" then
    local m = math.sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z)
    if m == 0 then return v end
    return Vector3.new(v.X / m, v.Y / m, v.Z / m)
  end
  return V3methods[k]
end
V3.__add = function(a, b) return Vector3.new(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
V3.__sub = function(a, b) return Vector3.new(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
V3.__unm = function(a) return Vector3.new(-a.X, -a.Y, -a.Z) end
V3.__mul = function(a, b)
  if type(a) == "number" then return Vector3.new(a * b.X, a * b.Y, a * b.Z) end
  if type(b) == "number" then return Vector3.new(a.X * b, a.Y * b, a.Z * b) end
  return Vector3.new(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
V3.__div = function(a, b)
  if type(b) == "number" then return Vector3.new(a.X / b, a.Y / b, a.Z / b) end
  return Vector3.new(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end
V3.__eq = function(a, b) return getmt(b) == V3 and a.X == b.X and a.Y == b.Y and a.Z == b.Z end
V3.__tostring = function(v) return string.format("%g, %g, %g", v.X, v.Y, v.Z) end

function Color3.new(r, g, b) return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, C3) end
function Color3.fromRGB(r, g, b) return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255) end
C3.__eq = function(a, b) return getmt(b) == C3 and a.R == b.R and a.G == b.G and a.B == b.B end
C3.__tostring = function(c) return string.format("%g, %g, %g", c.R, c.G, c.B) end

local function typeof(v)
  local mt = getmt(v)
  if mt == V3 then return "Vector3" end
  if mt == C3 then return "Color3" end
  if type(v) == "table" and rawget(v, "__id") then return "Instance" end
  return type(v)
end

-- ---------------------------------------------------------------------------------------------
-- Host value encoding (see src/engine/runtime.js for the JS side)
--   z nil | b0 b1 | n<number> | s<text> | v x,y,z | c r,g,b | i<instance id> | L<items joined by SEP>
-- ---------------------------------------------------------------------------------------------

local proxies = setmetatable({}, { __mode = "v" })

local function wrap(id)
  local p = proxies[id]
  if p == nil then
    p = setmetatable({ __id = id }, InstanceMT)
    proxies[id] = p
  end
  return p
end

local function encode(v)
  local t = type(v)
  if t == "nil" then return "z" end
  if t == "boolean" then return v and "b1" or "b0" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then error("number is NaN or infinite", 3) end
    return "n" .. string.format("%.17g", v)
  end
  if t == "string" then return "s" .. (v:gsub("[\0\31]", " ")) end
  if t == "table" then
    local mt = getmt(v)
    if mt == V3 then return string.format("v%.9g,%.9g,%.9g", v.X, v.Y, v.Z) end
    if mt == C3 then return string.format("c%.9g,%.9g,%.9g", v.R, v.G, v.B) end
    local id = rawget(v, "__id")
    if id then return "i" .. id end
  end
  error("cannot send a " .. typeof(v) .. " to the engine", 3)
end

local decode

local function decodeList(body)
  local out = {}
  if body == "" then return out end
  local n = 0
  for item in (body .. SEP):gmatch("(.-)" .. SEP) do
    n = n + 1
    out[n] = decode(item)
  end
  return out
end

decode = function(s)
  local tag, body = s:sub(1, 1), s:sub(2)
  if tag == "z" or tag == "" then return nil end
  if tag == "b" then return body == "1" end
  if tag == "n" then return tonumber(body) end
  if tag == "s" then return body end
  if tag == "v" then
    local x, y, z = body:match("^([^,]+),([^,]+),([^,]+)$")
    return Vector3.new(tonumber(x), tonumber(y), tonumber(z))
  end
  if tag == "c" then
    local r, g, b = body:match("^([^,]+),([^,]+),([^,]+)$")
    return Color3.new(tonumber(r), tonumber(g), tonumber(b))
  end
  if tag == "i" then return wrap(tonumber(body)) end
  if tag == "L" then return decodeList(body) end
  error("unreadable value from the engine", 0)
end

-- A failed host call returns "!message"; surface it at the script line that caused it.
local function call(op, id, a, b)
  local r = host(op, id or 0, a or "", b or "")
  if r:byte(1) == 33 then error(r:sub(2), 3) end
  return r
end

-- ---------------------------------------------------------------------------------------------
-- Scheduler: every script runs in a coroutine record { co, wake, since, started, dead }
-- ---------------------------------------------------------------------------------------------

local now = 0
local waiting = {}
local current
local WAIT, PARK = {}, {}
local spawn, resumeRec

local function logLine(level, msg) host("log", 0, level, tostring(msg)) end

resumeRec = function(rec, ...)
  if rec.dead then return end
  slice(rec.started and SLICE or FIRST_SLICE)
  rec.started = true
  local prev = current
  current = rec
  local ok, tag, arg = coroutine.resume(rec.co, ...)
  current = prev
  if not ok then
    rec.dead = true
    logLine("error", tag)
  elseif coroutine.status(rec.co) == "dead" then
    rec.dead = true
  elseif tag == WAIT then
    rec.since, rec.wake = now, now + arg
    waiting[#waiting + 1] = rec
  elseif tag ~= PARK then -- a bare coroutine.yield() in a script thread sleeps one frame
    rec.since, rec.wake = now, now
    waiting[#waiting + 1] = rec
  end
end

local function newRecord(fn, ...)
  if type(fn) ~= "function" then error("expected a function", 3) end
  local args = table.pack(...)
  return { co = coroutine.create(function() fn(table.unpack(args, 1, args.n)) end) }
end

spawn = function(fn, ...)
  local rec = newRecord(fn, ...)
  resumeRec(rec)
  return rec.co
end

local task = {}
task.spawn = spawn

function task.wait(t)
  if not current then error("task.wait can only be used inside a Wick script", 2) end
  return (coroutine.yield(WAIT, math.max(tonumber(t) or 0, 0)))
end

function task.defer(fn, ...)
  local rec = newRecord(fn, ...)
  rec.since, rec.wake = now, now
  waiting[#waiting + 1] = rec
  return rec.co
end

function task.delay(t, fn, ...)
  local args = table.pack(...)
  return spawn(function()
    task.wait(t)
    fn(table.unpack(args, 1, args.n))
  end)
end

-- ---------------------------------------------------------------------------------------------
-- Signals
-- ---------------------------------------------------------------------------------------------

local Connection = {}
Connection.__index = Connection
function Connection:Disconnect() self.Connected = false end

local Signal = {}
Signal.__index = Signal

local function newSignal(onFirstConnect)
  return setmetatable({ handlers = {}, waiters = {}, onFirstConnect = onFirstConnect }, Signal)
end

function Signal:Connect(fn)
  if type(fn) ~= "function" then error("Connect expects a function", 2) end
  if self.onFirstConnect then
    local first = self.onFirstConnect
    self.onFirstConnect = nil
    first()
  end
  local conn = setmetatable({ Connected = true, fn = fn }, Connection)
  self.handlers[#self.handlers + 1] = conn
  return conn
end

function Signal:Wait()
  if not current then error("Wait can only be used inside a Wick script", 2) end
  self.waiters[#self.waiters + 1] = current
  return coroutine.yield(PARK)
end

function Signal:Fire(...)
  local live, n = {}, 0
  for _, c in ipairs(self.handlers) do
    if c.Connected then n = n + 1; live[n] = c end
  end
  self.handlers = live
  for i = 1, n do
    if live[i].Connected then spawn(live[i].fn, ...) end
  end
  if #self.waiters > 0 then
    local w = self.waiters
    self.waiters = {}
    for _, rec in ipairs(w) do resumeRec(rec, ...) end
  end
end

-- ---------------------------------------------------------------------------------------------
-- Instances
-- ---------------------------------------------------------------------------------------------

local Camera = setmetatable({}, {
  __index = function(_, k) return decode(call("camget", 0, k)) end,
  __newindex = function() error("Camera is read-only", 2) end,
  __metatable = "locked",
})

local METHODS = {
  Destroy = true, Clone = true, GetChildren = true, GetDescendants = true, FindFirstChild = true,
  IsA = true, GetFullName = true, ApplyImpulse = true, Play = true, Stop = true,
}
local SIGNALS = { Touched = true }

local methodCache, instSignals = {}, {}

local function method(name)
  local f = methodCache[name]
  if not f then
    f = function(self, ...)
      local enc = {}
      for i = 1, select("#", ...) do enc[i] = encode((select(i, ...))) end
      return decode(call("call", rawget(self, "__id"), name, table.concat(enc, SEP)))
    end
    methodCache[name] = f
  end
  return f
end

local function instSignal(id, name)
  local bag = instSignals[id]
  if not bag then bag = {}; instSignals[id] = bag end
  local s = bag[name]
  if not s then
    s = newSignal(function() call("listen", id, name) end)
    bag[name] = s
  end
  return s
end

InstanceMT.__index = function(self, key)
  if METHODS[key] then return method(key) end
  if SIGNALS[key] then return instSignal(rawget(self, "__id"), key) end
  if key == "CurrentCamera" then return Camera end
  return decode(call("get", rawget(self, "__id"), key))
end
InstanceMT.__newindex = function(self, key, value)
  call("set", rawget(self, "__id"), key, encode(value))
end
InstanceMT.__tostring = function(self) return decode(call("get", rawget(self, "__id"), "Name")) end

local Instance = {}
function Instance.new(className, parent)
  if type(className) ~= "string" then error("Instance.new expects a class name", 2) end
  return decode(call("new", 0, className, encode(parent)))
end

-- ---------------------------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------------------------

local down = {}
local RunService = { Heartbeat = newSignal() }
local UserInputService = { InputBegan = newSignal(), InputEnded = newSignal() }
function UserInputService:IsKeyDown(key) return down[key] == true end

local root = decode(call("root", 0))
local services = { RunService = RunService, UserInputService = UserInputService }

local game = setmetatable({}, {
  __index = function(_, k)
    if k == "GetService" then
      return function(_, name) return services[name] or root[name] end
    end
    return root[k]
  end,
  __newindex = function(_, k, v) root[k] = v end,
  __tostring = function() return "Wick Game" end,
  __metatable = "locked",
})
local workspace = root.Workspace

-- ---------------------------------------------------------------------------------------------
-- Frame step and engine events
-- ---------------------------------------------------------------------------------------------

local function step(dt)
  now = now + dt
  local due, keep = {}, {}
  for _, rec in ipairs(waiting) do
    if not rec.dead then
      if rec.wake <= now then due[#due + 1] = rec else keep[#keep + 1] = rec end
    end
  end
  waiting = keep
  for _, rec in ipairs(due) do
    if elapsed() > FRAME_BUDGET then -- out of frame time: resume the rest next frame
      rec.wake = now
      waiting[#waiting + 1] = rec
    else
      resumeRec(rec, now - rec.since)
    end
  end
  RunService.Heartbeat:Fire(dt)
end

-- payload is a SEP-joined list of encoded values
local function event(name, payload)
  local args = decodeList(payload)
  if name == "touched" then
    local self, other = args[1], args[2]
    local bag = self and instSignals[rawget(self, "__id")]
    if bag and bag.Touched then bag.Touched:Fire(other) end
  elseif name == "input" then
    local began, key, kind = args[1] == "begin", args[2], args[3]
    down[key] = began or nil
    local input = { KeyCode = key, UserInputType = kind }
    if began then UserInputService.InputBegan:Fire(input) else UserInputService.InputEnded:Fire(input) end
  end
end

-- ---------------------------------------------------------------------------------------------
-- Sandbox
-- ---------------------------------------------------------------------------------------------

local function joinArgs(...)
  local t = {}
  for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
  return table.concat(t, "\t")
end

local G = {
  assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs, pcall = pcall, xpcall = xpcall,
  select = select, tonumber = tonumber, tostring = tostring, type = type, rawequal = rawequal, rawget = rawget,
  rawset = rawset, rawlen = rawlen, setmetatable = setmetatable, getmetatable = getmetatable, unpack = table.unpack,
  math = math, string = string, table = table, utf8 = utf8, coroutine = coroutine,
  os = { time = os.time, clock = os.clock, date = os.date },
  print = function(...) host("log", 0, "info", joinArgs(...)) end,
  warn = function(...) host("log", 0, "warn", joinArgs(...)) end,
  collectgarbage = function(opt) return opt == "count" and collectgarbage("count") or 0 end,
  typeof = typeof, task = task, game = game, workspace = workspace,
  Instance = Instance, Vector3 = Vector3, Color3 = Color3,
}
G._G = G

local function runScript(name, source)
  local env = setmetatable({}, { __index = G }) -- per-script globals; shared state goes through _G
  local fn, err = load(source, "=" .. name, "t", env)
  if not fn then
    logLine("error", err)
    return false
  end
  spawn(fn)
  return true
end

__wick_run, __wick_step, __wick_event = runScript, step, event
