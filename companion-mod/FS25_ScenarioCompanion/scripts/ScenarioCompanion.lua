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
                if #names < 40 then
                    local name = nil
                    if v.getFullName ~= nil then
                        local ok, n = pcall(function() return v:getFullName() end)
                        if ok then name = n end
                    end
                    table.insert(names, name or "vehicle")
                end
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
    setXMLInt(xml, ROOT .. ".vehicleCount", vcount)
    for i, n in ipairs(vnames) do
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

-- ---- FS mod lifecycle (addModEventListener) --------------------------------

function ScenarioCompanion:loadMap(name)
    self.lastHour = nil
    self.lastDay = nil
    pcall(function() self:write() end) -- initial snapshot
end

function ScenarioCompanion:update(dt)
    local env = g_currentMission ~= nil and g_currentMission.environment or nil
    if env == nil then return end
    local h = env.currentHour or 0
    if self.lastHour == nil or h ~= self.lastHour then
        self.lastHour = h
        pcall(function() self:write() end)
    end
    local day = env.currentDay or 0
    if self.lastDay == nil or day ~= self.lastDay then
        self.lastDay = day
        pcall(function() self:appendHistory(day) end)
    end
end

function ScenarioCompanion:deleteMap() end
function ScenarioCompanion:mouseEvent(posX, posY, isDown, isUp, button) end
function ScenarioCompanion:keyEvent(unicode, sym, modifier, isDown) end
function ScenarioCompanion:draw() end

addModEventListener(ScenarioCompanion)
