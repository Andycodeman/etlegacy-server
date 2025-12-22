--[[
    Rick Roll Mode - Effect Application System
    Handles applying, tracking, and removing all gameplay effects

    EFFECT IMPLEMENTATION NOTES:
    - Effects can apply to single player OR all players
    - Power levels mean different things per effect (multiplier, interval, fixed)
    - Global effects (isGlobal=true) always affect everyone via CVARs
    - Interval-based effects (telefrag, weapon_roulette, butter_fingers) repeat
]]--

rickroll = rickroll or {}
rickroll.effectSystem = {}

-- Weapon IDs for reference (from bg_public.h weapon_t enum)
local WEAPON = {
    NONE = 0,
    KNIFE = 1,
    LUGER = 2,
    MP40 = 3,
    GRENADE = 4,              -- Axis grenade (GRENADE_LAUNCHER)
    PANZERFAUST = 5,
    FLAMETHROWER = 6,
    COLT = 7,
    THOMPSON = 8,
    GRENADE_US = 9,           -- Allied grenade (GRENADE_PINEAPPLE)
    STEN = 10,                -- Silenced sten sub-machinegun
    SYRINGE = 11,             -- MEDIC_SYRINGE
    AMMO = 12,
    ARTY = 13,
    SILENCER = 14,            -- Silenced luger
    DYNAMITE = 15,
    SMOKETRAIL = 16,
    MAPMORTAR = 17,
    -- 18 = VERYBIGEXPLOSION
    MEDKIT = 19,
    BINOCULARS = 20,
    PLIERS = 21,
    SMOKE_MARKER = 22,
    KAR98 = 23,               -- Axis rifle
    CARBINE = 24,             -- Allied rifle
    GARAND = 25,
    LANDMINE = 26,
    SATCHEL = 27,
    SATCHEL_DET = 28,
    SMOKE_BOMB = 29,
    MOBILE_MG42 = 30,         -- Axis mobile machinegun (unset)
    K43 = 31,
    FG42 = 32,
    DUMMY_MG42 = 33,
    MORTAR = 34,              -- Allied mortar
    AKIMBO_COLT = 35,
    AKIMBO_LUGER = 36,
    GPG40 = 37,               -- Axis riflegrenade
    M7 = 38,                  -- Allied riflegrenade
    SILENCED_COLT = 39,
    GARAND_SCOPE = 40,
    K43_SCOPE = 41,
    FG42_SCOPE = 42,
    MORTAR_SET = 43,
    MEDIC_ADRENALINE = 44,
    AKIMBO_SILENCEDCOLT = 45,
    AKIMBO_SILENCEDLUGER = 46,
    MOBILE_MG42_SET = 47,     -- Axis mobile machinegun (deployed)
    KNIFE_KABAR = 48,         -- Allied knife
    MOBILE_BROWNING = 49,     -- Allied mobile machinegun (unset)
    MOBILE_BROWNING_SET = 50, -- Allied mobile machinegun (deployed)
    MORTAR2 = 51,             -- Axis mortar
    MORTAR2_SET = 52,
    BAZOOKA = 53,             -- Allied panzerfaust
    MP34 = 54,                -- Axis Sten alternative
}

-- All available weapons for weapon roulette
local ALL_WEAPONS = {
    WEAPON.MP40, WEAPON.THOMPSON, WEAPON.PANZERFAUST, WEAPON.BAZOOKA,
    WEAPON.FLAMETHROWER, WEAPON.K43, WEAPON.GARAND, WEAPON.FG42,
    WEAPON.STEN, WEAPON.MP34, WEAPON.MOBILE_MG42, WEAPON.MOBILE_BROWNING
}

--=============================================================================
-- HELPER FUNCTIONS
--=============================================================================

-- Send force weapon command to client (for client-side weapon switching block)
-- This tells the client to block weapon switching for the specified duration
function rickroll.effectSystem.sendForceWeapon(clientNum, weaponNum, durationMs)
    et.trap_SendServerCommand(clientNum, string.format(
        'rickroll_forceweapon %d %d',
        weaponNum,
        durationMs
    ))
end

-- Clear force weapon on client
function rickroll.effectSystem.clearForceWeapon(clientNum)
    et.trap_SendServerCommand(clientNum, 'rickroll_forceweapon 0 0')
end

-- Give full ammo for all weapons in the roulette pool
-- Uses ps.ammo (reserve) and ps.ammoclip (loaded in gun) arrays
function rickroll.effectSystem.giveAllWeaponsAmmo(clientNum)
    -- All weapons that need ammo (including SET versions for mobile guns and mortars)
    local weaponsToFill = {
        WEAPON.KNIFE,
        WEAPON.LUGER,
        WEAPON.MP40,
        WEAPON.GRENADE,
        WEAPON.PANZERFAUST,
        WEAPON.FLAMETHROWER,
        WEAPON.COLT,
        WEAPON.THOMPSON,
        WEAPON.GRENADE_US,
        WEAPON.STEN,
        WEAPON.KAR98,
        WEAPON.CARBINE,
        WEAPON.GARAND,
        WEAPON.MOBILE_MG42,          -- ID 30 - Axis mobile MG (unset)
        WEAPON.MOBILE_MG42_SET,      -- ID 47 - Axis mobile MG (deployed)
        WEAPON.K43,
        WEAPON.FG42,
        WEAPON.MORTAR,               -- ID 34 - Allied mortar
        WEAPON.MORTAR_SET,           -- ID 43 - Allied mortar (deployed)
        WEAPON.MORTAR2,              -- ID 51 - Axis mortar
        WEAPON.MORTAR2_SET,          -- ID 52 - Axis mortar (deployed)
        WEAPON.MOBILE_BROWNING,      -- ID 49 - Allied mobile MG (unset)
        WEAPON.MOBILE_BROWNING_SET,  -- ID 50 - Allied mobile MG (deployed)
        WEAPON.BAZOOKA,              -- ID 53
        WEAPON.MP34,                 -- ID 54
    }

    -- Ammo amounts per weapon type (generous amounts)
    local ammoAmounts = {
        [WEAPON.KNIFE] = 1,
        [WEAPON.LUGER] = 999,
        [WEAPON.MP40] = 999,
        [WEAPON.GRENADE] = 10,
        [WEAPON.PANZERFAUST] = 10,
        [WEAPON.FLAMETHROWER] = 999,
        [WEAPON.COLT] = 999,
        [WEAPON.THOMPSON] = 999,
        [WEAPON.GRENADE_US] = 10,
        [WEAPON.STEN] = 999,
        [WEAPON.KAR98] = 999,
        [WEAPON.CARBINE] = 999,
        [WEAPON.GARAND] = 999,
        [WEAPON.MOBILE_MG42] = 999,
        [WEAPON.MOBILE_MG42_SET] = 999,
        [WEAPON.K43] = 999,
        [WEAPON.FG42] = 999,
        [WEAPON.MORTAR] = 20,
        [WEAPON.MORTAR_SET] = 20,
        [WEAPON.MORTAR2] = 20,
        [WEAPON.MORTAR2_SET] = 20,
        [WEAPON.MOBILE_BROWNING] = 999,
        [WEAPON.MOBILE_BROWNING_SET] = 999,
        [WEAPON.BAZOOKA] = 10,
        [WEAPON.MP34] = 999,
    }

    -- Clip amounts (loaded in gun)
    local clipAmounts = {
        [WEAPON.KNIFE] = 1,
        [WEAPON.LUGER] = 8,
        [WEAPON.MP40] = 32,
        [WEAPON.GRENADE] = 1,
        [WEAPON.PANZERFAUST] = 1,
        [WEAPON.FLAMETHROWER] = 200,
        [WEAPON.COLT] = 8,
        [WEAPON.THOMPSON] = 30,
        [WEAPON.GRENADE_US] = 1,
        [WEAPON.STEN] = 32,
        [WEAPON.KAR98] = 10,
        [WEAPON.CARBINE] = 10,
        [WEAPON.GARAND] = 8,
        [WEAPON.MOBILE_MG42] = 150,
        [WEAPON.MOBILE_MG42_SET] = 150,
        [WEAPON.K43] = 10,
        [WEAPON.FG42] = 20,
        [WEAPON.MORTAR] = 1,
        [WEAPON.MORTAR_SET] = 1,
        [WEAPON.MORTAR2] = 1,
        [WEAPON.MORTAR2_SET] = 1,
        [WEAPON.MOBILE_BROWNING] = 150,
        [WEAPON.MOBILE_BROWNING_SET] = 150,
        [WEAPON.BAZOOKA] = 1,
        [WEAPON.MP34] = 32,
    }

    -- Give ammo for all weapons
    for _, weaponId in ipairs(weaponsToFill) do
        local ammo = ammoAmounts[weaponId] or 999
        local clip = clipAmounts[weaponId] or 30

        -- Set reserve ammo
        et.gentity_set(clientNum, "ps.ammo", weaponId, ammo)
        -- Set loaded clip
        et.gentity_set(clientNum, "ps.ammoclip", weaponId, clip)
    end
end

--=============================================================================
-- EFFECT DESCRIPTIONS
-- Returns a human-readable description of what the effect does
--=============================================================================

function rickroll.effectSystem.getDescription(effectId, powerLevel, powerValue)
    local meaning = rickroll.getPowerMeaning(effectId)

    -- For multiplier effects, show actual percentage (2.0x = 200%)
    local speedPct = math.floor(powerValue * 100)
    -- For inverse effects, powerValue is already the fraction (e.g., 0.5 for 50%)
    local inversePct = math.floor(powerValue * 100)

    local descriptions = {
        -- BLESSED
        god_mode = string.format("Cannot take damage for %d seconds!", math.floor(powerValue * 30)),
        caffeine_rush = string.format("Movement speed boosted to %d%%!", speedPct),
        tank_mode = string.format("Health boosted to %d%%!", speedPct),
        regeneration = string.format("Regenerate %d HP every 2 seconds!", math.floor(10 * powerValue)),
        adrenaline = string.format("Adrenaline regenerates %d every 2 seconds!", math.floor(10 * powerValue)),
        medic_mode = string.format("Receive health pack every %.0f seconds!", powerValue / 1000),
        damage_boost = string.format("Your attacks deal %.1fx damage!", powerValue),
        homing_rockets = "Rockets home on enemies!",

        -- CURSED
        tiny_legs = string.format("Movement speed reduced to %d%%!", inversePct),
        glass_cannon = string.format("Health reduced to %d%% - fragile!", inversePct),
        disoriented = string.format("Screen spins every %.0f seconds!", powerValue / 1000),
        marked = string.format("Location revealed every %.0f seconds!", powerValue / 1000),
        butter_fingers = string.format("Drop weapon every %.0f seconds!", powerValue / 1000),
        pistols_only = "Forced to pistol only!",
        bouncy = string.format("Random knockback every %.0f seconds!", powerValue / 1000),
        slippery = string.format("Ice physics - %.0fx slippery!", powerValue),
        weak_hits = string.format("Your attacks deal only %d%% damage!", inversePct),

        -- CHAOTIC
        knife_fight = "Guns disabled - knives only!",
        moon_mode = string.format("Gravity reduced to %d%% - floaty jumps!", inversePct),
        russian_roulette = string.format("Random player dies every %.0f seconds!", powerValue / 1000),
        team_switch = string.format("Team swapped every %.0f seconds!", powerValue / 1000),
        telefrag = string.format("Teleport to random enemy every %.0f seconds!", powerValue / 1000),
        weapon_roulette = string.format("Weapon changes every %.0f seconds!", powerValue / 1000),
        clone_wars = "Bots are hunting you!",
        fling = string.format("Launched across map every %.0f seconds!", powerValue / 1000),
        narcolepsy = string.format("Sudden nap attacks every %.0f seconds!", powerValue / 1000),
        panzer_freeze = string.format("Rockets freeze enemies for %.0f seconds!", powerValue * 30),
        projectile_speed = string.format("Projectiles move at %.1fx speed!", powerValue),
        earthquake = string.format("Screen shake intensity %.1fx!", powerValue)
    }

    return descriptions[effectId] or "Unknown effect!"
end

--=============================================================================
-- CORE EFFECT APPLICATION
--=============================================================================

-- Apply effect to player(s)
-- If isAllPlayers is true, applies to all human players
function rickroll.effectSystem.apply(clientNum, effect, category, powerLevel, duration, isAllPlayers)
    local now = et.trap_Milliseconds()

    -- Get the appropriate power value for this effect
    local powerValue = rickroll.getPowerValue(effect.id, powerLevel)

    -- For "duration" type effects, the multiplier determines how long it lasts
    local meaning = rickroll.getPowerMeaning(effect.id)
    if meaning == "duration" then
        -- Special handling for god_mode: cap to 20-60 seconds (too powerful otherwise)
        if effect.id == "god_mode" then
            -- Map power levels: MILD=20s, MODERATE=30s, STRONG=40s, EXTREME=50s, LEGENDARY=60s
            local godDurations = {20, 30, 40, 50, 60}
            local powerIndex = 1
            for i, level in ipairs(rickroll.config.powerLevels) do
                if level.multiplier == powerLevel.multiplier then
                    powerIndex = i
                    break
                end
            end
            duration = godDurations[powerIndex] * 1000
        else
            -- Base duration is 30 seconds, so 2x = 60s, 5x = 150s
            duration = math.floor(powerValue * 30 * 1000)  -- Convert to milliseconds
        end
    end

    local endTime = now + duration

    -- Handle global effects (always affect everyone via CVARs)
    if effect.isGlobal then
        return rickroll.effectSystem.applyGlobal(effect, category, powerLevel, powerValue, endTime, clientNum)
    end

    -- Determine target players
    local targetPlayers = {}
    if isAllPlayers then
        -- Get all players for ALL PLAYERS mode (configurable whether to include bots)
        local allPlayers
        if rickroll.config.allPlayersIncludesBots then
            allPlayers = rickroll.selection.getAllPlayersIncludingBots()
        else
            allPlayers = rickroll.selection.getAllHumanPlayers()
        end
        for _, p in ipairs(allPlayers) do
            table.insert(targetPlayers, p.clientNum)
        end
    else
        -- Single player
        table.insert(targetPlayers, clientNum)
    end

    -- Apply to each target
    local successCount = 0
    for _, targetNum in ipairs(targetPlayers) do
        local success = rickroll.effectSystem.applyToPlayer(targetNum, effect, category, powerLevel, powerValue, endTime, isAllPlayers)
        if success then
            successCount = successCount + 1
        end
    end

    -- Announce to ALL (already shown in ui.lua during animation, no extra spam needed)

    return successCount > 0
end

-- Apply effect to a single player
-- isAllPlayers: if true, suppress individual spam messages (already announced globally)
function rickroll.effectSystem.applyToPlayer(clientNum, effect, category, powerLevel, powerValue, endTime, isAllPlayers)
    local originalValues = {}
    local success = false

    -- Remove any existing effect on this player first!
    if rickroll.state.activeEffects[clientNum] then
        et.G_Print(string.format("[RickRoll] Removing existing effect '%s' from client %d before applying new one\n",
            rickroll.state.activeEffects[clientNum].effectId, clientNum))
        rickroll.effectSystem.remove(clientNum, true)  -- silent removal
    end

    et.G_Print(string.format("[RickRoll] Applying effect '%s' to client %d\n", effect.id, clientNum))

    -- Route to appropriate handler based on effect ID
    local handler = rickroll.effectSystem.handlers[effect.id]
    if handler then
        -- Pass isAllPlayers to handler so it can suppress messages
        success, originalValues = handler.apply(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        et.G_Print(string.format("[RickRoll] Handler returned success=%s, originalValues=%s\n",
            tostring(success), tostring(originalValues ~= nil)))
    else
        et.G_Print(string.format("[RickRoll] ^3Warning: No handler for effect '%s'\n", effect.id))
        success = true
    end

    if not success then
        et.G_Print("[RickRoll] ^1Effect application FAILED\n")
        return false
    end

    -- Store active effect for this player
    rickroll.state.activeEffects[clientNum] = {
        effectId = effect.id,
        effectName = effect.name,
        category = category,
        endTime = endTime,
        powerLevel = powerLevel,
        powerValue = powerValue,
        originalValues = originalValues or {},
        isAllPlayers = isAllPlayers or false
    }

    et.G_Print(string.format("[RickRoll] Effect stored in activeEffects[%d]: %s until %d\n",
        clientNum, effect.id, endTime))

    -- Send effect command to client for cgame rendering
    rickroll.effectSystem.sendToClient(clientNum, effect.id, powerLevel, endTime - et.trap_Milliseconds())

    -- Show detailed description only if single player (not all players spam)
    if not isAllPlayers then
        local description = rickroll.effectSystem.getDescription(effect.id, powerLevel, powerValue)
        et.trap_SendServerCommand(clientNum, string.format(
            'cp "%s%s\n^7%s"',
            effect.color or "^7",
            effect.name,
            description
        ))
    end

    return true
end

-- Apply global effect (affects CVARs)
function rickroll.effectSystem.applyGlobal(effect, category, powerLevel, powerValue, endTime, triggeredBy)
    local originalValues = {}
    local success = false

    local handler = rickroll.effectSystem.handlers[effect.id]
    if handler then
        success, originalValues = handler.apply(triggeredBy, powerLevel, powerValue, endTime)
    else
        success = true
    end

    if not success then
        return false
    end

    -- Store as global effect
    rickroll.state.globalEffects[effect.id] = {
        effectId = effect.id,
        effectName = effect.name,
        category = category,
        endTime = endTime,
        powerLevel = powerLevel,
        powerValue = powerValue,
        originalValues = originalValues,
        triggeredBy = triggeredBy
    }

    -- Show detailed description to ALL players for global effects
    local description = rickroll.effectSystem.getDescription(effect.id, powerLevel, powerValue)
    et.trap_SendServerCommand(-1, string.format(
        'cp "%s%s\n^7%s"',
        effect.color or "^7",
        effect.name,
        description
    ))

    return true
end

-- Send effect info to client's cgame for visual rendering
function rickroll.effectSystem.sendToClient(clientNum, effectId, powerLevel, duration)
    et.trap_SendServerCommand(-1, string.format(
        'rickroll_effect %d "%s" "%s" %d',
        clientNum,
        effectId,
        powerLevel.label,
        duration
    ))
end

--=============================================================================
-- EFFECT HANDLERS
-- Each handler has:
--   apply(clientNum, powerLevel, powerValue, endTime) -> success, originalValues
--   remove(clientNum, originalValues) -> nil
--   update(clientNum, data, levelTime) -> nil (optional, for recurring effects)
--
-- powerValue is the pre-calculated value based on power meaning type:
--   - multiplier: 1.25 to 3.0
--   - interval: 15000 to 5000 (ms)
--   - percentage: 25 to 75
--   - inverse: 0.8 to 0.33
--   - fixed: 1.0
--=============================================================================

rickroll.effectSystem.handlers = {}

--=============================================================================
-- BLESSED EFFECTS
--=============================================================================

-- GOD MODE - Player takes no damage (FL_GODMODE = 16)
rickroll.effectSystem.handlers["god_mode"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local flags = et.gentity_get(clientNum, "flags") or 0
        original.flags = flags
        et.gentity_set(clientNum, "flags", flags | 16)  -- FL_GODMODE
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if original.flags ~= nil then
            local flags = et.gentity_get(clientNum, "flags") or 0
            et.gentity_set(clientNum, "flags", flags & ~16)
        end
    end
}

-- CAFFEINE RUSH - Movement speed increased 150%-300% (renamed from super_speed)
-- Uses per-player rickrollSpeedScale field (100 = normal, 150 = 1.5x speed, etc.)
rickroll.effectSystem.handlers["caffeine_rush"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.speedScale = et.gentity_get(clientNum, "rickrollSpeedScale") or 100

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 150%, 185%, 220%, 260%, 300%
        local speedScales = {150, 185, 220, 260, 300}
        local newScale = speedScales[powerIndex] or 200

        et.gentity_set(clientNum, "rickrollSpeedScale", newScale)

        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^2%s got CAFFEINE RUSH! (%d%% speed)"',
                name, newScale
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        et.gentity_set(clientNum, "rickrollSpeedScale", 100)
    end
}

-- TANK MODE - Massive health increase 150%-300%
rickroll.effectSystem.handlers["tank_mode"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local health = et.gentity_get(clientNum, "health") or 100
        original.health = health

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 150%, 185%, 220%, 260%, 300%
        local healthMultipliers = {1.5, 1.85, 2.2, 2.6, 3.0}
        local multiplier = healthMultipliers[powerIndex] or 2.0

        local newHealth = math.floor(health * multiplier)
        et.gentity_set(clientNum, "health", newHealth)
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Don't restore health
    end
}

-- REGENERATION - Health regenerates 10-25 HP every 2 seconds
rickroll.effectSystem.handlers["regeneration"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 10, 14, 18, 21, 25 HP per tick
        local regenAmounts = {10, 14, 18, 21, 25}
        original.regenAmount = regenAmounts[powerIndex] or 15
        original.maxHealth = 200  -- Cap at 200 HP max
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        -- Regenerate every 2 seconds
        if data.lastRegenTime == nil then
            data.lastRegenTime = levelTime
            return
        end

        local elapsed = levelTime - data.lastRegenTime
        if elapsed >= 2000 then  -- Every 2 seconds
            local health = et.gentity_get(clientNum, "health")
            local maxHealth = data.originalValues.maxHealth or 200
            local regenAmount = data.originalValues.regenAmount or 15

            if health and health > 0 and health < maxHealth then
                local newHealth = math.min(health + regenAmount, maxHealth)
                et.gentity_set(clientNum, "health", math.floor(newHealth))
            end
            data.lastRegenTime = levelTime
        end
    end
}

-- ADRENALINE - Adrenaline regenerates 10-25 every 2 seconds
rickroll.effectSystem.handlers["adrenaline"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 10, 14, 18, 21, 25 adrenaline per tick
        local regenAmounts = {10, 14, 18, 21, 25}
        original.regenAmount = regenAmounts[powerIndex] or 15

        -- Give initial adrenaline boost
        et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("adrenaline %d\n", clientNum))
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        -- Regenerate adrenaline every 2 seconds
        if data.lastRegenTime == nil then
            data.lastRegenTime = levelTime
            return
        end

        local elapsed = levelTime - data.lastRegenTime
        if elapsed >= 2000 then  -- Every 2 seconds
            local regenAmount = data.originalValues.regenAmount or 15
            -- ps.powerups[PW_ADRENALINE] is hard to set directly, so just give adrenaline cmd
            -- This gives full adrenaline - for partial we'd need to set the powerup timer
            et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("adrenaline %d\n", clientNum))
            data.lastRegenTime = levelTime
        end
    end
}

-- MEDIC MODE - Give health packs periodically
-- Interval configured in config.effectIntervals.medic_mode (default: 6s to 2s)
rickroll.effectSystem.handlers["medic_mode"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.healInterval = powerValue

        -- Give initial health boost
        local health = et.gentity_get(clientNum, "health") or 100
        et.gentity_set(clientNum, "health", math.min(health + 50, 200))

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.healInterval or 4000
        if data.lastHeal == nil or levelTime - data.lastHeal > interval then
            local health = et.gentity_get(clientNum, "health") or 100
            if health > 0 and health < 200 then
                local newHealth = math.min(health + 25, 200)
                et.gentity_set(clientNum, "health", newHealth)
            end
            data.lastHeal = levelTime
        end
    end
}

-- AMMO DUMP - REMOVED (server has unlimited ammo by default)

-- HEAVY WEAPONS - REMOVED (server has unlimited ammo, effect is redundant)

-- DAMAGE BOOST - Player deals more damage (multiplier)
rickroll.effectSystem.handlers["damage_boost"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- Store the damage multiplier for this player (will be checked in et_Damage hook)
        -- powerValue is the multiplier (2.0 to 5.0)
        rickroll.effectSystem.damageBoost = rickroll.effectSystem.damageBoost or {}
        rickroll.effectSystem.damageBoost[clientNum] = powerValue

        -- Only announce to everyone if single player effect
        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'bp "^2DAMAGE BOOST!\n^7%s deals ^2%.0fx^7 damage!"',
                name, powerValue
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if rickroll.effectSystem.damageBoost then
            rickroll.effectSystem.damageBoost[clientNum] = nil
        end
    end,
    update = function(clientNum, data, levelTime)
        -- Nothing to update, damage is handled in et_Damage hook
    end
}

-- HOMING ROCKETS - Panzerfaust/Bazooka rockets track nearest enemy
-- Uses C code: rickrollHomingRockets stores the cone angle in degrees
-- Power level affects how wide the homing cone is:
--   MILD (1):      45° cone - weak homing, must aim well
--   MODERATE (2):  60° cone - decent homing
--   STRONG (3):    90° cone - good homing
--   EXTREME (4):  120° cone - strong homing
--   LEGENDARY (5):150° cone - almost full hemisphere tracking
rickroll.effectSystem.handlers["homing_rockets"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.wasHoming = et.gentity_get(clientNum, "rickrollHomingRockets") or 0

        -- Get power index (1-5) from the powerLevel multiplier
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map power levels to cone angles (degrees)
        -- Higher power = wider cone = better tracking
        local coneAngles = {45, 60, 90, 120, 150}
        local coneAngle = coneAngles[powerIndex] or 90

        -- Store cone angle in rickrollHomingRockets (C code reads this)
        et.gentity_set(clientNum, "rickrollHomingRockets", coneAngle)

        -- Announce the effect with cone info
        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'bp "^2HOMING ROCKETS!\n^7%s\'s rockets seek enemies (%d° cone)!"',
                name, coneAngle
            ))
        end

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Disable homing mode
        et.gentity_set(clientNum, "rickrollHomingRockets", 0)
    end,
    update = function(clientNum, data, levelTime)
        -- Nothing to update, homing is handled entirely in C code (g_missile.c)
    end
}

--=============================================================================
-- CURSED EFFECTS
--=============================================================================

-- TINY LEGS - Speed reduced (inverse)
-- Uses per-player rickrollSpeedScale field (100 = normal, 50 = half speed, etc.)
rickroll.effectSystem.handlers["tiny_legs"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.speedScale = et.gentity_get(clientNum, "rickrollSpeedScale") or 100

        -- powerValue is inverse (0.5 to 0.2 for 2x to 5x slowdown)
        local newScale = math.floor(powerValue * 100)
        et.gentity_set(clientNum, "rickrollSpeedScale", newScale)

        -- Only announce to everyone if single player effect
        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^1%s got TINY LEGS! (%.0f%% speed)"',
                name, powerValue * 100
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Reset to normal speed
        et.gentity_set(clientNum, "rickrollSpeedScale", 100)
    end
}

-- GLASS CANNON - Low health 80%-10%
rickroll.effectSystem.handlers["glass_cannon"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local health = et.gentity_get(clientNum, "health") or 100
        original.health = health

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 80%, 60%, 40%, 25%, 10%
        local healthPercents = {0.8, 0.6, 0.4, 0.25, 0.1}
        local percent = healthPercents[powerIndex] or 0.5

        local newHealth = math.max(1, math.floor(health * percent))
        et.gentity_set(clientNum, "health", newHealth)
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end
}

-- DISORIENTED - Periodic screen wobble effect (interval)
-- Uses client-side rickroll_spin command for smooth wobble animation
-- Wobble spins screen then returns to normal - doesn't affect movement
rickroll.effectSystem.handlers["disoriented"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.spinInterval = powerValue  -- interval in ms (10s to 2s)
        original.isAllPlayers = isAllPlayers
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Reset spin when effect ends
        if isAllPlayers then
            et.trap_SendServerCommand(-1, 'rickroll_spin_reset')
        else
            et.trap_SendServerCommand(clientNum, 'rickroll_spin_reset')
        end
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.spinInterval or 10000
        local isAllPlayers = data.originalValues.isAllPlayers

        if data.lastSpin == nil or levelTime - data.lastSpin > interval then
            -- Random wobble amount in degrees (60 to 120 degrees, positive or negative)
            local spinAmount = math.random(60, 120)
            if math.random() > 0.5 then
                spinAmount = -spinAmount
            end

            -- Wobble duration: 800ms for full out-and-back motion
            local spinDuration = 800

            -- Send spin command to client(s)
            if isAllPlayers then
                et.trap_SendServerCommand(-1, string.format('rickroll_spin %.1f %d', spinAmount, spinDuration))
            else
                et.trap_SendServerCommand(clientNum, string.format('rickroll_spin %.1f %d', spinAmount, spinDuration))
            end

            data.lastSpin = levelTime
        end
    end
}

-- MARKED - Announce player location periodically (interval)
rickroll.effectSystem.handlers["marked"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.announceInterval = powerValue  -- interval in ms

        -- Only announce to everyone if single player effect
        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^1%s is MARKED! Location broadcast every %ds!"',
                name, powerValue / 1000
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.announceInterval or 10000
        if data.lastAnnounce == nil or levelTime - data.lastAnnounce > interval then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            local origin = et.gentity_get(clientNum, "ps.origin")
            local x = origin and origin[1] or 0
            local y = origin and origin[2] or 0

            -- Announce approximate location
            et.trap_SendServerCommand(-1, string.format(
                'chat "^1[MARKED] ^7%s is near coordinates (%.0f, %.0f)!"',
                name, x, y
            ))
            data.lastAnnounce = levelTime
        end
    end
}

-- BUTTER FINGERS - Drop weapon periodically (switch to knife)
-- Simply sets ps.weapon to knife - no forcing logic
-- Interval configured in config.effectIntervals.butter_fingers (default: 15s to 5s)
rickroll.effectSystem.handlers["butter_fingers"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.dropInterval = powerValue
        original.isAllPlayers = isAllPlayers
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Nothing to clean up
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.dropInterval or 10000

        -- Time for a new drop?
        if data.lastDrop == nil or levelTime - data.lastDrop > interval then
            -- Use server-side forcing for 500ms - this is handled in C code and
            -- will keep forcing knife until client syncs up
            et.gentity_set(clientNum, "ps.weapon", WEAPON.KNIFE)
            et.gentity_set(clientNum, "rickrollForcedWeapon", WEAPON.KNIFE)
            et.gentity_set(clientNum, "rickrollForcedWeaponUntil", levelTime + 500)

            -- Also tell client to sync its weaponSelect AND force for 500ms
            et.trap_SendServerCommand(clientNum, string.format('rickroll_forceweapon %d 500', WEAPON.KNIFE))

            -- Announce to affected player only
            et.trap_SendServerCommand(clientNum, 'cpm "^1You dropped your weapon!"')
            data.lastDrop = levelTime
        end
    end
}

-- PISTOLS ONLY - Force to pistol weapon (single player or all)
-- Uses BOTH server-side AND client-side weapon forcing (same as knife_fight)
rickroll.effectSystem.handlers["pistols_only"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local now = et.trap_Milliseconds()
        local duration = endTime - now

        original.isAllPlayers = isAllPlayers

        -- Helper to get pistol for a player based on team
        local function getPistolForPlayer(playerNum)
            local team = et.gentity_get(playerNum, "sess.sessionTeam")
            -- TEAM_AXIS = 1 uses LUGER (2), TEAM_ALLIES = 2 uses COLT (7)
            return (team == 1) and WEAPON.LUGER or WEAPON.COLT
        end

        if isAllPlayers then
            -- Force all players to their team's pistol
            local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
            for i = 0, maxClients - 1 do
                if et.gentity_get(i, "inuse") == 1 then
                    local team = et.gentity_get(i, "sess.sessionTeam")
                    if team == 1 or team == 2 then
                        local pistol = getPistolForPlayer(i)
                        et.gentity_set(i, "ps.weapon", pistol)
                        et.gentity_set(i, "rickrollForcedWeapon", pistol)
                        et.gentity_set(i, "rickrollForcedWeaponUntil", endTime)
                        rickroll.effectSystem.sendForceWeapon(i, pistol, duration)
                    end
                end
            end
        else
            -- Force single player to their team's pistol
            local pistol = getPistolForPlayer(clientNum)
            et.gentity_set(clientNum, "ps.weapon", pistol)
            et.gentity_set(clientNum, "rickrollForcedWeapon", pistol)
            et.gentity_set(clientNum, "rickrollForcedWeaponUntil", endTime)
            rickroll.effectSystem.sendForceWeapon(clientNum, pistol, duration)
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if isAllPlayers then
            local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
            for i = 0, maxClients - 1 do
                if et.gentity_get(i, "inuse") == 1 then
                    et.gentity_set(i, "rickrollForcedWeapon", 0)
                    et.gentity_set(i, "rickrollForcedWeaponUntil", 0)
                    rickroll.effectSystem.clearForceWeapon(i)
                end
            end
        else
            et.gentity_set(clientNum, "rickrollForcedWeapon", 0)
            et.gentity_set(clientNum, "rickrollForcedWeaponUntil", 0)
            rickroll.effectSystem.clearForceWeapon(clientNum)
        end
    end
}

-- BOUNCY - Random knockback pushes
-- Interval configured in config.effectIntervals.bouncy (default: 10s to 3s)
rickroll.effectSystem.handlers["bouncy"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.bounceInterval = powerValue
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.bounceInterval or 6000
        if data.lastBounce == nil or levelTime - data.lastBounce > interval then
            -- Push player in random direction with MUCH stronger force
            local vx = math.random(-800, 800)
            local vy = math.random(-800, 800)
            local vz = math.random(400, 800)  -- Strong upward bounce

            local curVel = et.gentity_get(clientNum, "ps.velocity")
            local curVx = curVel and curVel[1] or 0
            local curVy = curVel and curVel[2] or 0
            local curVz = curVel and curVel[3] or 0

            et.gentity_set(clientNum, "ps.velocity", {curVx + vx, curVy + vy, curVz + vz})
            data.lastBounce = levelTime
        end
    end
}

-- SLIPPERY - Ice physics via reduced friction 15x-30x (uses C code rickrollSlippery field)
rickroll.effectSystem.handlers["slippery"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.wasSlippery = et.gentity_get(clientNum, "rickrollSlippery") or 0

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 15, 19, 22, 26, 30 friction reduction
        local frictionLevels = {15, 19, 22, 26, 30}
        local frictionLevel = frictionLevels[powerIndex] or 22

        -- Set friction level in C code (rickrollSlippery now stores the friction multiplier)
        et.gentity_set(clientNum, "rickrollSlippery", frictionLevel)
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Disable ice physics
        et.gentity_set(clientNum, "rickrollSlippery", 0)
    end,
    update = function(clientNum, data, levelTime)
        -- Ice physics handled in C code (g_active.c via ps.friction)
    end
}

-- WEAK HITS - Player deals less damage 80%-10%
rickroll.effectSystem.handlers["weak_hits"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 80%, 60%, 40%, 25%, 10%
        local damagePercents = {0.8, 0.6, 0.4, 0.25, 0.1}
        local damagePercent = damagePercents[powerIndex] or 0.5

        rickroll.effectSystem.weakHits = rickroll.effectSystem.weakHits or {}
        rickroll.effectSystem.weakHits[clientNum] = damagePercent

        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            local pct = math.floor(damagePercent * 100)
            et.trap_SendServerCommand(-1, string.format(
                'bp "^1WEAK HITS!\n^7%s deals only ^1%d%%^7 damage!"',
                name, pct
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if rickroll.effectSystem.weakHits then
            rickroll.effectSystem.weakHits[clientNum] = nil
        end
    end,
    update = function(clientNum, data, levelTime)
        -- Nothing to update, damage is handled in et_Damage hook
    end
}

--=============================================================================
-- CHAOTIC EFFECTS
--=============================================================================

-- KNIFE FIGHT - Forced to knife (single player or all)
-- Uses BOTH server-side AND client-side weapon forcing
rickroll.effectSystem.handlers["knife_fight"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local now = et.trap_Milliseconds()
        local duration = endTime - now

        original.isAllPlayers = isAllPlayers

        if isAllPlayers then
            -- Force all players to knife
            local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
            for i = 0, maxClients - 1 do
                if et.gentity_get(i, "inuse") == 1 then
                    local team = et.gentity_get(i, "sess.sessionTeam")
                    if team == 1 or team == 2 then
                        et.gentity_set(i, "ps.weapon", WEAPON.KNIFE)
                        et.gentity_set(i, "rickrollForcedWeapon", WEAPON.KNIFE)
                        et.gentity_set(i, "rickrollForcedWeaponUntil", endTime)
                        rickroll.effectSystem.sendForceWeapon(i, WEAPON.KNIFE, duration)
                    end
                end
            end
        else
            -- Force single player to knife
            et.gentity_set(clientNum, "ps.weapon", WEAPON.KNIFE)
            et.gentity_set(clientNum, "rickrollForcedWeapon", WEAPON.KNIFE)
            et.gentity_set(clientNum, "rickrollForcedWeaponUntil", endTime)
            rickroll.effectSystem.sendForceWeapon(clientNum, WEAPON.KNIFE, duration)
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if isAllPlayers then
            local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
            for i = 0, maxClients - 1 do
                if et.gentity_get(i, "inuse") == 1 then
                    et.gentity_set(i, "rickrollForcedWeapon", 0)
                    et.gentity_set(i, "rickrollForcedWeaponUntil", 0)
                    rickroll.effectSystem.clearForceWeapon(i)
                end
            end
        else
            et.gentity_set(clientNum, "rickrollForcedWeapon", 0)
            et.gentity_set(clientNum, "rickrollForcedWeaponUntil", 0)
            rickroll.effectSystem.clearForceWeapon(clientNum)
        end
    end
}

-- MOON MODE - Low gravity 80%-50% (single player or all via global g_gravity)
rickroll.effectSystem.handlers["moon_mode"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.gravity = tonumber(et.trap_Cvar_Get("g_gravity")) or 800
        original.isAllPlayers = isAllPlayers

        -- Get power index (1-5)
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map to 80%, 72%, 65%, 57%, 50%
        local gravityPercents = {0.8, 0.72, 0.65, 0.57, 0.5}
        local percent = gravityPercents[powerIndex] or 0.65

        -- Moon mode always affects global gravity (even for single player)
        -- because per-player gravity isn't easily possible
        local newGrav = math.floor(original.gravity * percent)
        et.trap_Cvar_Set("g_gravity", tostring(newGrav))
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        if original.gravity then
            et.trap_Cvar_Set("g_gravity", tostring(original.gravity))
        end
    end
}

-- RUSSIAN ROULETTE - Random player dies periodically (global only)
-- Interval configured in config.effectIntervals.russian_roulette (default: 15s to 5s)
rickroll.effectSystem.handlers["russian_roulette"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.killInterval = powerValue

        -- Kill one player immediately on start
        rickroll.effectSystem.killRandomPlayer()

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.killInterval or 10000
        if data.lastKill == nil or levelTime - data.lastKill > interval then
            rickroll.effectSystem.killRandomPlayer()
            data.lastKill = levelTime
        end
    end
}

-- Helper function to kill a random player
function rickroll.effectSystem.killRandomPlayer()
    local players = {}
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for i = 0, maxClients - 1 do
        if et.gentity_get(i, "inuse") == 1 then
            local team = et.gentity_get(i, "sess.sessionTeam")
            local health = et.gentity_get(i, "health") or 0
            if (team == 1 or team == 2) and health > 0 then
                table.insert(players, i)
            end
        end
    end

    if #players > 0 then
        local victimNum = players[math.random(#players)]
        local victimName = et.gentity_get(victimNum, "pers.netname") or "Player"
        et.gentity_set(victimNum, "health", 0)

        et.trap_SendServerCommand(-1, string.format(
            'bp "^1RUSSIAN ROULETTE!\n^7%s ^1lost!"',
            victimName
        ))
    end
end

-- TEAM SWITCH - Swap teams periodically (single or all, restore on end)
-- Interval configured in config.effectIntervals.team_switch (default: 60s to 20s)
rickroll.effectSystem.handlers["team_switch"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.switchInterval = powerValue
        original.isAllPlayers = isAllPlayers
        original.originalTeams = {}

        -- Store original teams for restoration
        local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
        for i = 0, maxClients - 1 do
            if et.gentity_get(i, "inuse") == 1 then
                local team = et.gentity_get(i, "sess.sessionTeam")
                if team == 1 or team == 2 then
                    original.originalTeams[i] = team
                end
            end
        end

        -- Do initial swap
        rickroll.effectSystem.doTeamSwap(clientNum, isAllPlayers)

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Restore original teams
        if original.originalTeams then
            for playerNum, team in pairs(original.originalTeams) do
                if et.gentity_get(playerNum, "inuse") == 1 then
                    local targetTeam = (team == 1) and "axis" or "allies"
                    et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("forceteam %d %s\n", playerNum, targetTeam))
                end
            end
        end
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.switchInterval or 40000
        local isAllPlayers = data.originalValues.isAllPlayers
        if data.lastSwap == nil or levelTime - data.lastSwap > interval then
            rickroll.effectSystem.doTeamSwap(clientNum, isAllPlayers)
            data.lastSwap = levelTime
        end
    end
}

-- Helper function to swap teams
function rickroll.effectSystem.doTeamSwap(clientNum, isAllPlayers)
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    if isAllPlayers then
        for i = 0, maxClients - 1 do
            if et.gentity_get(i, "inuse") == 1 then
                local team = et.gentity_get(i, "sess.sessionTeam")
                if team == 1 then
                    et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("forceteam %d allies\n", i))
                elseif team == 2 then
                    et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("forceteam %d axis\n", i))
                end
            end
        end
    else
        local team = et.gentity_get(clientNum, "sess.sessionTeam")
        if team == 1 then
            et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("forceteam %d allies\n", clientNum))
        elseif team == 2 then
            et.trap_SendConsoleCommand(et.EXEC_APPEND, string.format("forceteam %d axis\n", clientNum))
        end
    end
end

-- TELEFRAG - Teleport to enemy periodically (interval)
rickroll.effectSystem.handlers["telefrag"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = { teleportInterval = powerValue }  -- powerValue is interval in ms

        -- Do initial teleport
        rickroll.effectSystem.doTelefrag(clientNum)

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.teleportInterval or 10000
        if data.lastTeleport == nil or levelTime - data.lastTeleport > interval then
            rickroll.effectSystem.doTelefrag(clientNum)
            data.lastTeleport = levelTime
        end
    end
}

-- Helper function for telefrag
-- Tries multiple positions around target to avoid walls/solid geometry
-- Uses et.trap_Trace to check if positions are valid
function rickroll.effectSystem.doTelefrag(clientNum)
    local myTeam = et.gentity_get(clientNum, "sess.sessionTeam")
    local enemyTeam = (myTeam == 1) and 2 or 1

    local enemies = {}
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64
    for i = 0, maxClients - 1 do
        if i ~= clientNum and et.gentity_get(i, "inuse") == 1 then
            local team = et.gentity_get(i, "sess.sessionTeam")
            local health = et.gentity_get(i, "health") or 0
            if team == enemyTeam and health > 0 then
                table.insert(enemies, i)
            end
        end
    end

    if #enemies > 0 then
        local targetNum = enemies[math.random(#enemies)]
        local targetName = et.gentity_get(targetNum, "pers.netname") or "Enemy"

        -- ps.origin returns a vec3 table {x, y, z}
        local targetOrigin = et.gentity_get(targetNum, "ps.origin")
        if targetOrigin then
            -- Try multiple offset positions around the target
            -- Distance of 56 units (slightly more than player width of ~32)
            local dist = 56
            local zOffset = 8  -- Small elevation to avoid minor ground issues

            -- Get target's facing direction (viewangles[2] is yaw in ET)
            local viewAngles = et.gentity_get(targetNum, "ps.viewangles")
            local yaw = viewAngles and viewAngles[2] or 0
            local yawRad = math.rad(yaw)

            -- Calculate direction vectors
            local forward = {math.cos(yawRad), math.sin(yawRad)}
            local right = {math.cos(yawRad + math.pi/2), math.sin(yawRad + math.pi/2)}

            -- Candidate positions: behind, left, right, front, corners
            local candidates = {
                -- Behind (preferred - surprise attack!)
                {targetOrigin[1] - forward[1] * dist, targetOrigin[2] - forward[2] * dist, targetOrigin[3] + zOffset},
                -- Left side
                {targetOrigin[1] - right[1] * dist, targetOrigin[2] - right[2] * dist, targetOrigin[3] + zOffset},
                -- Right side
                {targetOrigin[1] + right[1] * dist, targetOrigin[2] + right[2] * dist, targetOrigin[3] + zOffset},
                -- Front (last resort - they'll see you)
                {targetOrigin[1] + forward[1] * dist, targetOrigin[2] + forward[2] * dist, targetOrigin[3] + zOffset},
                -- Behind-left diagonal
                {targetOrigin[1] - forward[1] * dist * 0.7 - right[1] * dist * 0.7,
                 targetOrigin[2] - forward[2] * dist * 0.7 - right[2] * dist * 0.7,
                 targetOrigin[3] + zOffset},
                -- Behind-right diagonal
                {targetOrigin[1] - forward[1] * dist * 0.7 + right[1] * dist * 0.7,
                 targetOrigin[2] - forward[2] * dist * 0.7 + right[2] * dist * 0.7,
                 targetOrigin[3] + zOffset},
            }

            -- Player bounding box (standing)
            local mins = {-18, -18, -24}
            local maxs = {18, 18, 48}

            -- MASK_PLAYERSOLID = CONTENTS_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_BODY
            -- = 0x1 | 0x10000 | 0x2000000 = 33619969
            local MASK_PLAYERSOLID = 33619969

            -- Find first valid position using trap_Trace
            -- If startsolid is true, the position overlaps with solid geometry
            local newOrigin = nil
            for _, pos in ipairs(candidates) do
                -- Trace from pos to itself - checks if bounding box fits at that position
                local tr = et.trap_Trace(pos, mins, maxs, pos, -1, MASK_PLAYERSOLID)

                -- startsolid = false means position is clear
                if tr and not tr.startsolid then
                    newOrigin = pos
                    break
                end
            end

            -- Fallback: direct overlap with target (players push apart)
            if not newOrigin then
                newOrigin = {targetOrigin[1], targetOrigin[2], targetOrigin[3] + zOffset}
            end

            -- Set new position and clear velocity
            et.gentity_set(clientNum, "ps.origin", newOrigin)
            et.gentity_set(clientNum, "ps.velocity", {0, 0, 0})

            local myName = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'cpm "^3%s ^7teleported to ^1%s^7!"',
                myName, targetName
            ))
        end
    end
end

-- WEAPON ROULETTE - Random weapon periodically
-- Uses BOTH server-side AND client-side enforcement
-- Interval configured in config.effectIntervals.weapon_roulette (default: 10s to 2s)
rickroll.effectSystem.handlers["weapon_roulette"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        local now = et.trap_Milliseconds()
        local duration = endTime - now

        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.changeInterval = powerValue

        -- Give full ammo for ALL weapons so any random weapon works
        rickroll.effectSystem.giveAllWeaponsAmmo(clientNum)

        -- Give first random weapon using BOTH server and client mechanisms
        local weapon = ALL_WEAPONS[math.random(#ALL_WEAPONS)]
        et.gentity_set(clientNum, "rickrollForcedWeapon", weapon)
        et.gentity_set(clientNum, "rickrollForcedWeaponUntil", endTime)
        -- Tell client to block weapon switching for the full duration
        rickroll.effectSystem.sendForceWeapon(clientNum, weapon, duration)

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Clear forced weapon on both server and client
        et.gentity_set(clientNum, "rickrollForcedWeapon", 0)
        et.gentity_set(clientNum, "rickrollForcedWeaponUntil", 0)
        rickroll.effectSystem.clearForceWeapon(clientNum)
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.changeInterval or 6000
        if data.lastWeaponChange == nil or levelTime - data.lastWeaponChange > interval then
            -- Give full ammo for all weapons before switching
            rickroll.effectSystem.giveAllWeaponsAmmo(clientNum)

            -- Pick a random weapon and force it using BOTH server and client mechanisms
            local weapon = ALL_WEAPONS[math.random(#ALL_WEAPONS)]
            et.gentity_set(clientNum, "rickrollForcedWeapon", weapon)
            -- Send new weapon to client (blocks switching until next interval)
            rickroll.effectSystem.sendForceWeapon(clientNum, weapon, interval)
            data.lastWeaponChange = levelTime
        end
    end
}

-- CLONE WARS - Bots hunting announcement (fixed, singlePlayerOnly)
rickroll.effectSystem.handlers["clone_wars"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- Only announce if single player (this is singlePlayerOnly anyway)
        if not isAllPlayers then
            local victimName = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'bp "^3CLONE WARS!\n^7Bots are hunting %s!"',
                victimName
            ))
        end
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end
}

-- NARCOLEPSY - Fall asleep periodically (interval)
-- Uses rickrollFreezeUntil to freeze player (same mechanism as panzer freeze)
-- Interval configured in config.effectIntervals.narcolepsy (default: 20s to 5s)
-- Sleep duration scales with interval (shorter interval = shorter sleep for balance)
rickroll.effectSystem.handlers["narcolepsy"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.sleepInterval = powerValue
        -- Sleep duration is interval / 4 (so 20s interval = 5s sleep, 5s interval = 1.25s sleep)
        original.sleepDuration = math.floor(powerValue / 4)

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Make sure they're awake when effect ends - clear freeze
        et.gentity_set(clientNum, "rickrollFreezeUntil", 0)
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.sleepInterval or 12500
        local sleepDuration = data.originalValues.sleepDuration or 6000

        -- Check current freeze state
        local freezeUntil = et.gentity_get(clientNum, "rickrollFreezeUntil") or 0

        -- If not frozen and it's time to sleep
        if freezeUntil < levelTime then
            if data.lastSleep == nil or levelTime - data.lastSleep > interval then
                -- Fall asleep! Use the freeze mechanism
                et.gentity_set(clientNum, "rickrollFreezeUntil", levelTime + sleepDuration)
                et.trap_SendServerCommand(clientNum, 'cp "^3Zzz..."')
                data.lastSleep = levelTime
            end
        end
    end
}

-- FLING - Launch player(s) in random direction periodically (interval)
-- Interval configured in config.effectIntervals.fling (default: 10s to 3s)
rickroll.effectSystem.handlers["fling"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}
        original.isAllPlayers = isAllPlayers  -- Store for update function
        -- powerValue comes from getPowerValue() which uses config.effectIntervals
        original.flingInterval = powerValue

        -- Do initial fling
        rickroll.effectSystem.doFling(clientNum, isAllPlayers)

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers) end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.flingInterval or 6000
        if data.lastFling == nil or levelTime - data.lastFling > interval then
            rickroll.effectSystem.doFling(clientNum, data.originalValues.isAllPlayers)
            data.lastFling = levelTime
        end
    end
}

-- Helper function to fling a player
function rickroll.effectSystem.doFling(clientNum, isAllPlayers)
    -- Random horizontal direction
    local angle = math.random() * 2 * math.pi
    local horizontalSpeed = math.random(800, 1500)

    local vx = math.cos(angle) * horizontalSpeed
    local vy = math.sin(angle) * horizontalSpeed
    local vz = math.random(600, 1200)  -- Strong upward velocity

    et.gentity_set(clientNum, "ps.velocity", {vx, vy, vz})

    -- Only announce to everyone if single player effect
    if not isAllPlayers then
        local name = et.gentity_get(clientNum, "pers.netname") or "Player"
        et.trap_SendServerCommand(-1, string.format(
            'cpm "^3%s ^7got FLUNG!"',
            name
        ))
    end
end

-- PANZER FREEZE - Rockets freeze enemies instead of damaging them
-- Uses C code: rickrollPanzerFreeze (freeze duration in ms)
-- Duration: 5s (mild) to 15s (legendary)
rickroll.effectSystem.handlers["panzer_freeze"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5) from the powerLevel multiplier
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map power levels to freeze durations (5s to 15s)
        local freezeDurations = {5000, 7500, 10000, 12500, 15000}
        local freezeDuration = freezeDurations[powerIndex] or 10000
        original.freezeDuration = freezeDuration

        -- Set the freeze mode on the player (C code will handle the rocket impact)
        et.gentity_set(clientNum, "rickrollPanzerFreeze", freezeDuration)
        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        et.gentity_set(clientNum, "rickrollPanzerFreeze", 0)
    end
}

-- PROJECTILE SPEED - Changes speed of all projectiles (rockets, grenades, etc)
-- Uses C code: rickrollRocketSpeed (100 = normal, 200 = 2x speed, 50 = half speed)
-- Power level 1 = VERY SLOW (slower than walking), Power level 5 = INSTANT
rickroll.effectSystem.handlers["projectile_speed"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5) from the powerLevel multiplier
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map power levels to speed:
        -- 1 (MILD) = 5% speed (very slow, slower than walking)
        -- 2 (MODERATE) = 15% speed
        -- 3 (STRONG) = 100% speed (normal)
        -- 4 (EXTREME) = 500% speed (very fast)
        -- 5 (LEGENDARY) = 2000% speed (nearly instant)
        local speedPercents = {5, 15, 100, 500, 2000}
        local speedPercent = speedPercents[powerIndex] or 100

        original.speedPercent = speedPercent
        original.powerIndex = powerIndex

        et.gentity_set(clientNum, "rickrollRocketSpeed", speedPercent)

        -- Announce the effect type
        local speedType
        if powerIndex <= 2 then
            speedType = "^1SLOW MOTION"
        elseif powerIndex == 3 then
            speedType = "^7NORMAL"
        else
            speedType = "^2HYPERSPEED"
        end

        if not isAllPlayers then
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format('cpm "%s has %s ^7rockets!"', name, speedType))
        end

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        et.gentity_set(clientNum, "rickrollRocketSpeed", 100)
    end
}

-- EARTHQUAKE - Periodic screen shake
-- Power level determines intensity, duration, and interval
-- Level 1: Light tremors (0.3 intensity, every 8s)
-- Level 5: Massive quake (1.5 intensity, every 3s)
-- Can target single player or all players
rickroll.effectSystem.handlers["earthquake"] = {
    apply = function(clientNum, powerLevel, powerValue, endTime, isAllPlayers)
        local original = {}

        -- Get power index (1-5) from the powerLevel multiplier
        local powerIndex = 1
        for i, level in ipairs(rickroll.config.powerLevels) do
            if level.multiplier == powerLevel.multiplier then
                powerIndex = i
                break
            end
        end

        -- Map power levels to earthquake parameters:
        -- Level 1: 0.5 intensity, 8s interval (light tremor)
        -- Level 2: 0.75 intensity, 6.75s interval
        -- Level 3: 1.0 intensity, 5.5s interval
        -- Level 4: 1.25 intensity, 4.25s interval
        -- Level 5: 1.5 intensity, 3s interval (strong quake)
        local intensities = {0.5, 0.75, 1.0, 1.25, 1.5}
        local intervals = {8000, 6750, 5500, 4250, 3000}

        original.intensity = intensities[powerIndex] or 0.8
        original.shakeInterval = intervals[powerIndex] or 5000
        original.isAllPlayers = isAllPlayers
        original.clientNum = clientNum

        -- Do initial shake immediately
        if isAllPlayers then
            et.trap_SendServerCommand(-1, string.format('rickroll_shake %.2f', original.intensity))
        else
            et.trap_SendServerCommand(clientNum, string.format('rickroll_shake %.2f', original.intensity))
        end

        return true, original
    end,
    remove = function(clientNum, original, isAllPlayers)
        -- Nothing to clean up - shakes are temporary
    end,
    update = function(clientNum, data, levelTime)
        local interval = data.originalValues.shakeInterval or 5000
        local intensity = data.originalValues.intensity or 0.8
        local isAllPlayers = data.originalValues.isAllPlayers

        -- Time for a new shake?
        if data.lastShake == nil or levelTime - data.lastShake > interval then
            -- Send shake command to affected player(s)
            if isAllPlayers then
                et.trap_SendServerCommand(-1, string.format('rickroll_shake %.2f', intensity))
            else
                et.trap_SendServerCommand(clientNum, string.format('rickroll_shake %.2f', intensity))
            end
            data.lastShake = levelTime
        end
    end
}

--=============================================================================
-- EFFECT LIFECYCLE MANAGEMENT
--=============================================================================

-- Remove effect from player
-- silent: if true, don't announce (used when replacing with new effect)
function rickroll.effectSystem.remove(clientNum, silent)
    local active = rickroll.state.activeEffects[clientNum]
    if not active then return end

    local handler = rickroll.effectSystem.handlers[active.effectId]
    if handler and handler.remove then
        -- Pass isAllPlayers to handler so it can suppress individual messages
        handler.remove(clientNum, active.originalValues, active.isAllPlayers)
    end

    local wasAllPlayers = active.isAllPlayers
    rickroll.state.activeEffects[clientNum] = nil

    -- Announce effect ending (unless silent mode or it was all-players effect)
    if not silent then
        if wasAllPlayers then
            -- For all-players effects, only tell the specific player their effect ended
            et.trap_SendServerCommand(clientNum, 'cpm "^5[RICK ROLL] ^7Effect has worn off."')
        else
            -- For single-player effect, tell everyone
            local name = et.gentity_get(clientNum, "pers.netname") or "Player"
            et.trap_SendServerCommand(-1, string.format(
                'chat "^5[RICK ROLL] ^7%s^7\'s effect has worn off."',
                name
            ))
        end
    end

    et.trap_SendServerCommand(-1, string.format('rickroll_effect_end %d', clientNum))
end

-- Remove global effect
function rickroll.effectSystem.removeGlobal(effectId)
    local global = rickroll.state.globalEffects[effectId]
    if not global then return end

    local handler = rickroll.effectSystem.handlers[effectId]
    if handler and handler.remove then
        handler.remove(global.triggeredBy, global.originalValues)
    end

    rickroll.state.globalEffects[effectId] = nil

    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^3%s ^7has ended."',
        global.effectName
    ))
end

-- Update effects every frame
function rickroll.effectSystem.update(levelTime)
    local now = et.trap_Milliseconds()

    -- DEBUG: Log active effects count periodically
    if rickroll.effectSystem._lastDebugLog == nil or now - rickroll.effectSystem._lastDebugLog > 5000 then
        local count = 0
        for _ in pairs(rickroll.state.activeEffects) do count = count + 1 end
        if count > 0 then
            et.G_Print(string.format("[RickRoll] Active effects: %d\n", count))
            for cnum, d in pairs(rickroll.state.activeEffects) do
                et.G_Print(string.format("  - Client %d: %s (ends in %.1fs)\n",
                    cnum, d.effectId, (d.endTime - now) / 1000))
            end
        end
        rickroll.effectSystem._lastDebugLog = now
    end

    -- Check player effects
    for clientNum, data in pairs(rickroll.state.activeEffects) do
        if now >= data.endTime then
            rickroll.effectSystem.remove(clientNum)
        else
            -- Call handler's update function
            local handler = rickroll.effectSystem.handlers[data.effectId]
            if handler and handler.update then
                handler.update(clientNum, data, levelTime)
            end

            -- Send countdown timer to client (every second)
            rickroll.effectSystem.sendCountdown(clientNum, data, now)
        end
    end

    -- Check global effects
    for effectId, data in pairs(rickroll.state.globalEffects) do
        if now >= data.endTime then
            rickroll.effectSystem.removeGlobal(effectId)
        else
            local handler = rickroll.effectSystem.handlers[effectId]
            if handler and handler.update then
                handler.update(data.triggeredBy, data, levelTime)
            end

            -- Send countdown to all players for global effects
            rickroll.effectSystem.sendGlobalCountdown(data, now)
        end
    end
end

-- Send countdown timer to affected player(s)
function rickroll.effectSystem.sendCountdown(clientNum, data, now)
    -- Only update every second
    if data.lastCountdownUpdate == nil then
        data.lastCountdownUpdate = 0
    end

    if now - data.lastCountdownUpdate >= 1000 then
        local remaining = math.ceil((data.endTime - now) / 1000)
        if remaining > 0 then
            -- Send countdown command to client for cgame to display
            -- Replace spaces with underscores for command parsing
            local safeName = data.effectName:gsub(" ", "_")

            -- Get description for display
            local description = rickroll.effectSystem.getDescription(data.effectId, data.powerLevel, data.powerValue) or ""
            local safeDesc = description:gsub(" ", "_")

            local cmd = string.format('rickroll_timer %d %s %d %s', clientNum, safeName, remaining, safeDesc)
            et.trap_SendServerCommand(clientNum, cmd)

            -- Debug logging
            if remaining == 60 or remaining == 30 or remaining == 10 then
                et.G_Print(string.format("[RickRoll] Sending timer to client %d: %s\n", clientNum, cmd))
            end
        end
        data.lastCountdownUpdate = now
    end
end

-- Send countdown for global effects to all players
function rickroll.effectSystem.sendGlobalCountdown(data, now)
    if data.lastCountdownUpdate == nil then
        data.lastCountdownUpdate = 0
    end

    if now - data.lastCountdownUpdate >= 1000 then
        local remaining = math.ceil((data.endTime - now) / 1000)
        if remaining > 0 then
            -- Send to all players
            local safeName = data.effectName:gsub(" ", "_")

            -- Get description for display
            local description = rickroll.effectSystem.getDescription(data.effectId, data.powerLevel, data.powerValue) or ""
            local safeDesc = description:gsub(" ", "_")

            et.trap_SendServerCommand(-1, string.format(
                'rickroll_timer -1 %s %d %s',
                safeName,
                remaining,
                safeDesc
            ))
        end
        data.lastCountdownUpdate = now
    end
end

-- Query functions
function rickroll.effectSystem.getActive(clientNum)
    return rickroll.state.activeEffects[clientNum]
end

function rickroll.effectSystem.hasEffect(clientNum, effectId)
    local active = rickroll.state.activeEffects[clientNum]
    return active and active.effectId == effectId
end

function rickroll.effectSystem.hasGlobalEffect(effectId)
    return rickroll.state.globalEffects[effectId] ~= nil
end

return rickroll.effectSystem
