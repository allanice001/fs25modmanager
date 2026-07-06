--[[
ScenarioCompanion — telemetry MVP for the FS25 Mod Manager.

Every in-game hour it writes the player's live money / loan / calendar position
to `<savegame>/scenarioCompanion.xml`, which the manager reads to track a
scenario's progress in real time (no need to save-and-reload the game first).

Telemetry ONLY — it never changes gameplay.

NOTE: the exact Giants scripting globals (g_localPlayer, g_farmManager,
environment fields) can shift between FS25 patches. Everything below is guarded
with fallbacks + pcall so a mismatch degrades gracefully (writes zeros or skips)
instead of erroring in-game. If a field reads 0 that should not, check the names
against the current game scripts and adjust.
]]

ScenarioCompanion = {}

local FILE = "scenarioCompanion.xml"
local ROOT = "scenarioCompanion"
local HISTORY_FILE = "scenarioCompanionHistory.xml"
local HISTORY_ROOT = "scenarioCompanionHistory"
local HISTORY_CAP = 4000 -- ~11 in-game years of daily samples
local EVENTS_FILE = "scenarioCompanionEvents.xml"
local EVENTS_ROOT = "scenarioCompanionEvents"
local EVENTS_CAP = 500
local VERSION = 1

-- Best-effort resolution of the local player's farm id.
local function resolveFarmId()
    if g_localPlayer ~= nil and g_localPlayer.farmId ~= nil then
        return g_localPlayer.farmId
    end
    local m = g_currentMission
    if m ~= nil then
        if m.getFarmId ~= nil then
            local ok, id = pcall(function() return m:getFarmId() end)
            if ok and id ~= nil then return id end
        end
        if m.player ~= nil and m.player.farmId ~= nil then
            return m.player.farmId
        end
    end
    return 1
end

local function farmMoneyLoan(farmId)
    local money, loan = 0, 0
    if g_farmManager ~= nil and g_farmManager.getFarmById ~= nil then
        local farm = g_farmManager:getFarmById(farmId)
        if farm ~= nil then
            if farm.getBalance ~= nil then
                local ok, bal = pcall(function() return farm:getBalance() end)
                if ok and bal ~= nil then money = bal end
            elseif farm.money ~= nil then
                money = farm.money
            end
            loan = farm.loan or 0
        end
    end
    return money, loan
end

-- Is a vehicle actually OWNED (bought), not leased or a mission/contract rental?
local function isOwned(v)
    local owned = 1 -- PROPERTY_STATE_OWNED
    if Vehicle ~= nil and Vehicle.PROPERTY_STATE_OWNED ~= nil then
        owned = Vehicle.PROPERTY_STATE_OWNED
    end
    local ps = nil
    if v.getPropertyState ~= nil then
        local ok, s = pcall(function() return v:getPropertyState() end)
        if ok then ps = s end
    end
    if ps == nil then ps = v.propertyState end
    -- Unknown -> treat as owned (fallback); otherwise must equal OWNED.
    return ps == nil or ps == owned
end

-- The player's owned vehicles: returns (names[], count). Only counts bought
-- vehicles — excludes leased and mission/contract rentals. Best-effort across
-- FS25 API shapes.
local function ownedVehicles(farmId)
    local names, count = {}, 0
    local mission = g_currentMission
    if mission == nil then return names, count end
    local list = mission.vehicles
    if list == nil and mission.vehicleSystem ~= nil then
        list = mission.vehicleSystem.vehicles
    end
    if list == nil then return names, count end
    for _, v in pairs(list) do
        if type(v) == "table" then
            local owner = nil
            if v.getOwnerFarmId ~= nil then
                local ok, id = pcall(function() return v:getOwnerFarmId() end)
                if ok then owner = id end
            end
            if owner == nil then owner = v.ownerFarmId end
            if owner == farmId and isOwned(v) then
                count = count + 1
                local name = nil
                if v.getFullName ~= nil then
                    local ok, n = pcall(function() return v:getFullName() end)
                    if ok then name = n end
                end
                table.insert(names, name or "vehicle")
            end
        end
    end
    return names, count
end

function ScenarioCompanion:write()
    local mission = g_currentMission
    if mission == nil or mission.missionInfo == nil then return end
    local dir = mission.missionInfo.savegameDirectory
    if dir == nil then return end

    local farmId = resolveFarmId()
    local money, loan = farmMoneyLoan(farmId)

    local env = mission.environment or {}
    local day = env.currentDay or 0
    local monotonicDay = env.currentMonotonicDay or day
    local daysPerPeriod = env.daysPerPeriod or 1
    local period = env.currentPeriod or 0
    local hour = env.currentHour or 0

    local path = dir .. "/" .. FILE
    local xml = createXMLFile(ROOT, path, ROOT)
    if xml == nil or xml == 0 then return end
    setXMLInt(xml, ROOT .. "#version", VERSION)
    setXMLInt(xml, ROOT .. "#farmId", farmId)
    setXMLFloat(xml, ROOT .. ".money", money)
    setXMLFloat(xml, ROOT .. ".loan", loan)
    setXMLInt(xml, ROOT .. ".day", day)
    setXMLInt(xml, ROOT .. ".monotonicDay", monotonicDay)
    setXMLInt(xml, ROOT .. ".daysPerPeriod", daysPerPeriod)
    setXMLInt(xml, ROOT .. ".period", period)
    setXMLInt(xml, ROOT .. ".hour", hour)

    -- Owned vehicles: count + names, so the manager can track what's been bought.
    local vnames, vcount = ownedVehicles(farmId)
    self.vcount = vcount -- cached for the HUD so draw() needn't rescan each frame
    setXMLInt(xml, ROOT .. ".vehicleCount", vcount)
    for i, n in ipairs(vnames) do
        if i > 40 then break end
        setXMLString(xml, string.format("%s.vehicles.v(%d)#name", ROOT, i - 1), n)
    end

    setXMLString(xml, ROOT .. ".updatedBy", "FS25_ScenarioCompanion")
    saveXMLFile(xml)
    delete(xml)
end

-- Append one daily sample (day, cash, loan) to the history file, so the manager
-- can evaluate duration rules ("debt-free for N months") even across sessions.
function ScenarioCompanion:appendHistory(day)
    local mission = g_currentMission
    if mission == nil or mission.missionInfo == nil then return end
    local dir = mission.missionInfo.savegameDirectory
    if dir == nil then return end
    local path = dir .. "/" .. HISTORY_FILE

    local farmId = resolveFarmId()
    local cash, loan = farmMoneyLoan(farmId)
    local _, vcount = ownedVehicles(farmId)

    local xml, count = nil, 0
    if fileExists(path) then
        xml = loadXMLFile(HISTORY_ROOT, path)
        if xml ~= nil and xml ~= 0 then
            while hasXMLProperty(xml, string.format("%s.s(%d)", HISTORY_ROOT, count)) do
                count = count + 1
            end
            -- Don't re-record a day we already have (last sample's day).
            if count > 0 then
                local lastDay = getXMLInt(xml, string.format("%s.s(%d)#day", HISTORY_ROOT, count - 1))
                if lastDay == day then
                    delete(xml)
                    return
                end
            end
        end
    end
    if xml == nil or xml == 0 then
        xml = createXMLFile(HISTORY_ROOT, path, HISTORY_ROOT)
        count = 0
    end
    if xml == nil or xml == 0 then return end

    local key = string.format("%s.s(%d)", HISTORY_ROOT, count)
    setXMLInt(xml, key .. "#day", day)
    setXMLFloat(xml, key .. "#cash", cash)
    setXMLFloat(xml, key .. "#loan", loan)
    setXMLInt(xml, key .. "#veh", vcount)
    saveXMLFile(xml)
    delete(xml)
end

-- Append a bought/sold event (day, hour, kind, name) to the events file.
function ScenarioCompanion:logEvent(day, hour, kind, name)
    local mission = g_currentMission
    if mission == nil or mission.missionInfo == nil then return end
    local dir = mission.missionInfo.savegameDirectory
    if dir == nil then return end
    local path = dir .. "/" .. EVENTS_FILE

    local xml, count = nil, 0
    if fileExists(path) then
        xml = loadXMLFile(EVENTS_ROOT, path)
        if xml ~= nil and xml ~= 0 then
            while hasXMLProperty(xml, string.format("%s.e(%d)", EVENTS_ROOT, count)) do
                count = count + 1
            end
        end
    end
    if xml == nil or xml == 0 then
        xml = createXMLFile(EVENTS_ROOT, path, EVENTS_ROOT)
        count = 0
    end
    if xml == nil or xml == 0 or count >= EVENTS_CAP then
        if xml ~= nil and xml ~= 0 then delete(xml) end
        return
    end
    local key = string.format("%s.e(%d)", EVENTS_ROOT, count)
    setXMLInt(xml, key .. "#day", day)
    setXMLInt(xml, key .. "#hour", hour)
    setXMLString(xml, key .. "#kind", kind)
    setXMLString(xml, key .. "#name", name)
    saveXMLFile(xml)
    delete(xml)
end

-- Diff the owned-vehicle multiset against the last check and log bought/sold
-- events. The first check just seeds the baseline (no events for what you load
-- in with).
function ScenarioCompanion:checkPurchases(day, hour, farmId)
    local names = ownedVehicles(farmId)
    local cur = {}
    for _, n in ipairs(names) do cur[n] = (cur[n] or 0) + 1 end
    if self.lastOwned ~= nil then
        for n, c in pairs(cur) do
            local prev = self.lastOwned[n] or 0
            for _ = 1, c - prev do self:logEvent(day, hour, "bought", n) end
        end
        for n, c in pairs(self.lastOwned) do
            local now = cur[n] or 0
            for _ = 1, c - now do self:logEvent(day, hour, "sold", n) end
        end
    end
    self.lastOwned = cur
end

-- ---- FS mod lifecycle (addModEventListener) --------------------------------

function ScenarioCompanion:loadMap(name)
    self.lastHour = nil
    self.lastDay = nil
    self.hudVisible = true -- toggle with the J key (see keyEvent)
    pcall(function() self:write() end) -- initial snapshot
end

function ScenarioCompanion:update(dt)
    local env = g_currentMission ~= nil and g_currentMission.environment or nil
    if env == nil then return end
    local h = env.currentHour or 0
    if self.lastHour == nil or h ~= self.lastHour then
        self.lastHour = h
        pcall(function() self:write() end)
        pcall(function() self:checkPurchases(env.currentDay or 0, h, resolveFarmId()) end)
    end
    local day = env.currentDay or 0
    if self.lastDay == nil or day ~= self.lastDay then
        self.lastDay = day
        pcall(function() self:appendHistory(day) end)
    end
end

function ScenarioCompanion:deleteMap() end
function ScenarioCompanion:mouseEvent(posX, posY, isDown, isUp, button) end

-- Toggle the HUD with J (best-effort; the input constant may vary by patch).
function ScenarioCompanion:keyEvent(unicode, sym, modifier, isDown)
    if isDown and Input ~= nil and Input.KEY_j ~= nil and sym == Input.KEY_j then
        self.hudVisible = not self.hudVisible
    end
end

-- Minimal in-game HUD: money · loan · day · owned vehicles, top-left.
function ScenarioCompanion:draw()
    if not self.hudVisible or renderText == nil then return end
    local mission = g_currentMission
    if mission == nil then return end
    local farmId = resolveFarmId()
    local money, loan = farmMoneyLoan(farmId)
    local env = mission.environment or {}
    local day = env.currentDay or 0
    local vcount = self.vcount or 0

    local x, y, size = 0.013, 0.95, 0.016
    if setTextBold ~= nil then setTextBold(true) end
    if setTextColor ~= nil then setTextColor(1, 0.85, 0.2, 1) end
    renderText(x, y, size, "Scenario Companion")
    if setTextBold ~= nil then setTextBold(false) end
    if setTextColor ~= nil then setTextColor(1, 1, 1, 1) end
    local line = string.format(
        "$%s   loan $%s   day %d   vehicles %d",
        tostring(math.floor(money)), tostring(math.floor(loan)), day, vcount
    )
    renderText(x, y - 0.022, size * 0.9, line)
end

addModEventListener(ScenarioCompanion)
