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
    setXMLString(xml, ROOT .. ".updatedBy", "FS25_ScenarioCompanion")
    saveXMLFile(xml)
    delete(xml)
end

-- ---- FS mod lifecycle (addModEventListener) --------------------------------

function ScenarioCompanion:loadMap(name)
    self.lastHour = nil
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
end

function ScenarioCompanion:deleteMap() end
function ScenarioCompanion:mouseEvent(posX, posY, isDown, isUp, button) end
function ScenarioCompanion:keyEvent(unicode, sym, modifier, isDown) end
function ScenarioCompanion:draw() end

addModEventListener(ScenarioCompanion)
