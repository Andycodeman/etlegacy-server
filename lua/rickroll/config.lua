--[[
    Rick Roll Mode - Configuration
    All settings for the Rick Roll lottery system

    EFFECT CATEGORIES:
    - BLESSED (Green): Good effects that help the player
    - CURSED (Red): Bad effects that hinder the player
    - CHAOTIC (Yellow): Wild effects that affect everyone or are unpredictable

    POWER LEVELS (Wheel 3):
    - MILD: Subtle effect
    - MODERATE: Noticeable effect
    - STRONG: Significant effect
    - EXTREME: Major effect
    - LEGENDARY: Maximum chaos

    PLAYER SELECTION (Wheel 1):
    - Individual players OR "ALL PLAYERS" for mass effects

    POWER LEVEL MEANINGS vary by effect type:
    - Multiplier effects: 1.25x / 1.5x / 2.0x / 2.5x / 3.0x
    - Interval effects: 15s / 12s / 10s / 8s / 5s (telefrag, weapon roulette, butter fingers)
    - Fixed effects: Power level ignored (knife fight, adrenaline, blind, team shuffle)
]]--

rickroll = rickroll or {}

rickroll.config = {
    -- Master toggle (if false, rickroll system is completely disabled)
    enabled = true,

    -- Auto-trigger toggle (if false, rickroll only triggers via manual rcon commands)
    -- When autoTrigger=false but enabled=true, you can still use rickroll_test_cmd and rickroll_force
    autoTrigger = false,

    -- Trigger timing (milliseconds) - only used when autoTrigger=true
    interval = {
        min = 30000,    -- 30 seconds minimum between rolls (TESTING - change to 300000 for production)
        max = 60000     -- 60 seconds maximum (TESTING - change to 600000 for production)
    },
    warmupDelay = 10000,   -- 10 seconds warmup (TESTING - change to 120000 for production)

    -- Animation timing (milliseconds) - synced with 18.67s audio
    -- FULL INTRO (first roll of map)
    animationDuration = 18670,
    wheel1StopTime = 6000,    -- Player wheel stops at 6s
    wheel2StopTime = 9000,    -- Effect wheel stops at 9s
    wheel3StopTime = 12000,   -- Intensity wheel stops at 12s
    resultShowTime = 13000,   -- Show result at 13s

    -- QUICK MODE (subsequent rolls) - faster, no freeze, no music
    quickMode = {
        animationDuration = 5000,   -- 5 seconds total
        wheel1StopTime = 1500,      -- Player wheel stops at 1.5s
        wheel2StopTime = 2500,      -- Effect wheel stops at 2.5s
        wheel3StopTime = 3500,      -- Intensity wheel stops at 3.5s
        resultShowTime = 4000,      -- Show result at 4s
        flashDuration = 500,        -- Quick red flash at start
    },

    -- Effect duration (milliseconds)
    effectDuration = 60000,   -- Effects last 60 seconds

    -- Category weights (higher = more likely)
    weights = {
        blessed = 40,   -- Good effects
        cursed = 45,    -- Bad effects (slightly more likely for entertainment)
        chaotic = 15    -- Affects everyone
    },

    -- Weight for ALL PLAYERS selection (out of 100)
    allPlayersWeight = 50,  -- 50% chance to select ALL PLAYERS

    -- Include bots when ALL PLAYERS is selected?
    allPlayersIncludesBots = true,  -- true = bots get effects too, false = humans only

    -- Power level definitions
    -- Different effects interpret these differently (see powerMeanings below)
    -- Multipliers are significant: 2x to 5x for noticeable effects
    powerLevels = {
        { label = "MILD",      multiplier = 2.0, interval = 10000, color = "^2" },
        { label = "MODERATE",  multiplier = 2.5, interval = 8000,  color = "^3" },
        { label = "STRONG",    multiplier = 3.0, interval = 6000,  color = "^3" },
        { label = "EXTREME",   multiplier = 4.0, interval = 4000,  color = "^1" },
        { label = "LEGENDARY", multiplier = 5.0, interval = 2000,  color = "^6" }
    },

    -- Legacy intensities array (for backward compatibility)
    intensities = {2.0, 2.5, 3.0, 4.0, 5.0},

    -- Sound paths
    sounds = {
        music = "sound/rickroll/rickroll.wav",
        wheelStop = "sound/rickroll/wheel_stop.wav",  -- Optional
        fanfare = "sound/rickroll/fanfare.wav"        -- Optional
    },

    -- Visual settings
    freezePlayers = true,     -- Freeze all players during animation
    screenFlash = true,       -- Flash screen at start

    -- Protection settings
    protectSelected = true,   -- Make selected player invulnerable during roll
    samePlayerCooldown = 2,   -- Don't select same player X times in a row

    -- Debug
    debug = false,

    --=========================================================================
    -- PER-EFFECT INTERVAL OVERRIDES
    -- For effects with powerMeaning = "interval", these override the default
    -- powerLevels.interval values. Format: {MILD, MODERATE, STRONG, EXTREME, LEGENDARY}
    -- Values are in milliseconds.
    --=========================================================================
    effectIntervals = {
        -- CURSED
        butter_fingers = {15000, 12500, 10000, 7500, 5000},  -- 15s to 5s (needs time to reselect weapon)
        disoriented = {10000, 8000, 6000, 4000, 2000},       -- 10s to 2s
        marked = {10000, 8000, 6000, 4000, 2000},            -- 10s to 2s
        bouncy = {10000, 8000, 6000, 4500, 3000},            -- 10s to 3s

        -- CHAOTIC
        russian_roulette = {15000, 12500, 10000, 7500, 5000}, -- 15s to 5s (kills are harsh)
        team_switch = {60000, 50000, 40000, 30000, 20000},    -- 60s to 20s
        telefrag = {10000, 8000, 6000, 4000, 2000},           -- 10s to 2s
        weapon_roulette = {10000, 8000, 6000, 4000, 2000},    -- 10s to 2s
        fling = {10000, 8000, 6000, 4500, 3000},              -- 10s to 3s
        narcolepsy = {20000, 16250, 12500, 8750, 5000},       -- 20s to 5s between naps

        -- BLESSED
        medic_mode = {6000, 5000, 4000, 3000, 2000}           -- 6s to 2s
    }
}

--[[
    POWER MEANING TYPES

    Each effect uses power levels differently:
    - "multiplier": Uses multiplier value (1.25x to 3.0x)
    - "interval": Uses interval value from effectIntervals or default powerLevels
    - "percentage": Converts multiplier to percentage (25% to 75%)
    - "inverse": Inverse of multiplier (80% to 33%) for reductions
    - "fixed": Power level has no effect (always the same)
]]--
rickroll.powerMeanings = {
    -- BLESSED
    god_mode = "duration",      -- Multiplier affects how long god mode lasts
    caffeine_rush = "multiplier", -- Speed multiplier 150%-300% (renamed from super_speed)
    tank_mode = "multiplier",   -- Health multiplier 150%-300%
    regeneration = "multiplier", -- HP regen 10-25 HP every 2s
    adrenaline = "multiplier",  -- Adrenaline regen 10-25 every 2s
    medic_mode = "interval",    -- Health pack frequency 2-6s
    damage_boost = "multiplier", -- Damage multiplier

    -- CURSED
    tiny_legs = "inverse",      -- Speed reduction (per-player via C code)
    glass_cannon = "inverse",   -- Health reduction 80%-10%
    disoriented = "interval",   -- Spin frequency
    marked = "interval",        -- Location broadcast frequency
    butter_fingers = "interval", -- Drop frequency
    pistols_only = "fixed",     -- Just pistols
    bouncy = "interval",        -- Bounce frequency 10-3s
    slippery = "multiplier",    -- Ice skating mode 15x-30x friction reduction
    weak_hits = "inverse",      -- Damage reduction 80%-10%

    -- CHAOTIC
    knife_fight = "fixed",      -- Knives only (single or all)
    moon_mode = "inverse",      -- Gravity reduction 80%-50% (single or all)
    russian_roulette = "interval", -- Kill random player every 5-15s (global only)
    team_switch = "interval",   -- Team swap every 20-60s, restore on end (single or all)
    telefrag = "interval",      -- Teleport frequency
    weapon_roulette = "interval", -- Weapon change frequency 2-10s
    clone_wars = "fixed",       -- Psychological effect (disabled)
    fling = "interval",         -- Launch frequency 3-10s
    narcolepsy = "interval",    -- Sleep frequency (sleep duration = interval/3)
    panzer_freeze = "duration", -- Freeze duration 5-15 seconds
    projectile_speed = "multiplier", -- Projectile speed multiplier
    earthquake = "multiplier"   -- Intensity, duration, and interval all scale with power
}

--[[
    EFFECT DEFINITIONS

    Each effect needs:
    - id: unique identifier (used in code)
    - name: display name for wheel (keep short for UI)
    - description: shown when applied
    - color: ET color code for display
    - singlePlayerOnly: true if effect can't apply to ALL PLAYERS
    - isGlobal: true if effect inherently affects everyone (knife fight, etc)
]]--

rickroll.effects = {
    --=========================================================================
    -- BLESSED EFFECTS (Good for the player)
    --=========================================================================
    blessed = {
        {
            id = "god_mode",
            name = "GOD MODE",
            description = "You are INVINCIBLE!",
            color = "^2",
            singlePlayerOnly = true  -- Too powerful for ALL PLAYERS
        },
        {
            id = "caffeine_rush",
            name = "CAFFEINE RUSH",
            description = "You move FAST!",
            color = "^2"
        },
        {
            id = "tank_mode",
            name = "TANK MODE",
            description = "Health massively increased!",
            color = "^2"
        },
        {
            id = "regeneration",
            name = "REGENERATION",
            description = "Health regenerates over time!",
            color = "^2"
        },
        {
            id = "adrenaline",
            name = "ADRENALINE",
            description = "Adrenaline regenerates!",
            color = "^2"
        },
        {
            id = "medic_mode",
            name = "MEDIC MODE",
            description = "Health packs incoming!",
            color = "^2"
        },
        {
            id = "damage_boost",
            name = "DAMAGE BOOST",
            description = "Your hits deal more damage!",
            color = "^2"
        }
    },

    --=========================================================================
    -- CURSED EFFECTS (Bad for the player)
    --=========================================================================
    cursed = {
        {
            id = "tiny_legs",
            name = "TINY LEGS",
            description = "You move slower!",
            color = "^1"
        },
        {
            id = "glass_cannon",
            name = "GLASS CANNON",
            description = "One hit and you're dead!",
            color = "^1"
        },
        {
            id = "disoriented",
            name = "DISORIENTED",
            description = "Your view keeps spinning!",
            color = "^1"
        },
        {
            id = "marked",
            name = "MARKED",
            description = "Location broadcast to everyone!",
            color = "^1",
            singlePlayerOnly = true  -- Too many messages for ALL PLAYERS
        },
        {
            id = "butter_fingers",
            name = "BUTTER FINGERS",
            description = "Weapons randomly drop!",
            color = "^1"
        },
        {
            id = "pistols_only",
            name = "PISTOLS ONLY",
            description = "No big guns for you!",
            color = "^1"
        },
        {
            id = "bouncy",
            name = "BOUNCY",
            description = "Random knockback pushes!",
            color = "^1"
        },
        {
            id = "slippery",
            name = "SLIPPERY",
            description = "Ice skating mode!",
            color = "^1"
        },
        {
            id = "weak_hits",
            name = "WEAK HITS",
            description = "Your hits deal less damage!",
            color = "^1"
        }
    },

    --=========================================================================
    -- CHAOTIC EFFECTS (Affects everyone or is random)
    --=========================================================================
    chaotic = {
        {
            id = "knife_fight",
            name = "KNIFE FIGHT",
            description = "Guns are disabled!",
            color = "^3"
            -- Can target single player or all players
        },
        {
            id = "moon_mode",
            name = "MOON MODE",
            description = "Low gravity!",
            color = "^3"
            -- Can target single player or all players
        },
        {
            id = "russian_roulette",
            name = "RUSSIAN ROULETTE",
            description = "Someone dies periodically!",
            color = "^3",
            isGlobal = true  -- Always affects everyone (kills random player)
        },
        {
            id = "team_switch",
            name = "TEAM SWITCH",
            description = "Teams are swapped periodically!",
            color = "^3"
            -- Can target single player or all players
        },
        {
            id = "telefrag",
            name = "TELEFRAG",
            description = "Teleporting to enemies!",
            color = "^3"
        },
        {
            id = "weapon_roulette",
            name = "WEAPON ROULETTE",
            description = "Random weapons!",
            color = "^3"
        },
        -- DISABLED: Bots aren't smart enough to actually hunt players
        -- {
        --     id = "clone_wars",
        --     name = "CLONE WARS",
        --     description = "Bots are hunting you!",
        --     color = "^3",
        --     singlePlayerOnly = true  -- Can't target ALL PLAYERS
        -- },
        {
            id = "fling",
            name = "FLING",
            description = "Launched across the map!",
            color = "^3"
        },
        {
            id = "narcolepsy",
            name = "NARCOLEPSY",
            description = "Sudden nap attacks!",
            color = "^3"
        },
        {
            id = "panzer_freeze",
            name = "PANZER FREEZE",
            description = "Rockets freeze enemies!",
            color = "^4"
        },
        {
            id = "projectile_speed",
            name = "PROJECTILE SPEED",
            description = "Projectiles move faster/slower!",
            color = "^3"
        },
        {
            id = "earthquake",
            name = "EARTHQUAKE",
            description = "The ground is shaking!",
            color = "^3"
        }
    }
}

-- Special constant for ALL PLAYERS selection
rickroll.ALL_PLAYERS = -999

-- Get flat list of all effect names for wheel display
function rickroll.getAllEffectNames()
    local names = {}
    for _, effect in ipairs(rickroll.effects.blessed) do
        table.insert(names, effect.color .. effect.name)
    end
    for _, effect in ipairs(rickroll.effects.cursed) do
        table.insert(names, effect.color .. effect.name)
    end
    for _, effect in ipairs(rickroll.effects.chaotic) do
        table.insert(names, effect.color .. effect.name)
    end
    return names
end

-- Get effect by ID
function rickroll.getEffectById(effectId)
    for category, effects in pairs(rickroll.effects) do
        if type(effects) == "table" then
            for _, effect in ipairs(effects) do
                if effect.id == effectId then
                    return effect, category
                end
            end
        end
    end
    return nil
end

-- Get power level info by multiplier value
function rickroll.getPowerLevel(multiplier)
    for _, level in ipairs(rickroll.config.powerLevels) do
        if level.multiplier == multiplier then
            return level
        end
    end
    -- Default fallback
    return { label = string.format("%.2fx", multiplier), multiplier = multiplier, interval = 10000, color = "^7" }
end

-- Get power level labels for wheel display
function rickroll.getPowerLevelLabels()
    local labels = {}
    for _, level in ipairs(rickroll.config.powerLevels) do
        table.insert(labels, level.color .. level.label)
    end
    return labels
end

-- Get how power level applies to a specific effect
function rickroll.getPowerMeaning(effectId)
    return rickroll.powerMeanings[effectId] or "multiplier"
end

-- Get power index (1-5) from powerLevel
function rickroll.getPowerIndex(powerLevel)
    for i, level in ipairs(rickroll.config.powerLevels) do
        if level.multiplier == powerLevel.multiplier then
            return i
        end
    end
    return 3  -- Default to STRONG
end

-- Get the actual value to use based on power meaning
function rickroll.getPowerValue(effectId, powerLevel)
    local meaning = rickroll.getPowerMeaning(effectId)

    if meaning == "multiplier" then
        return powerLevel.multiplier
    elseif meaning == "interval" then
        -- Check for per-effect interval override first
        local effectIntervals = rickroll.config.effectIntervals and rickroll.config.effectIntervals[effectId]
        if effectIntervals then
            local powerIndex = rickroll.getPowerIndex(powerLevel)
            return effectIntervals[powerIndex] or powerLevel.interval
        end
        return powerLevel.interval
    elseif meaning == "percentage" then
        -- Convert multiplier to percentage (1.25 -> 25%, 3.0 -> 75%)
        return (powerLevel.multiplier - 1) / 2 * 100
    elseif meaning == "inverse" then
        -- Inverse for reductions (1.25 -> 80%, 3.0 -> 33%)
        return 1.0 / powerLevel.multiplier
    elseif meaning == "duration" then
        -- Multiplier affects duration (2x = 60s, 5x = 150s)
        return powerLevel.multiplier
    else -- "fixed"
        return 1.0
    end
end

-- Get display string for power level based on effect
function rickroll.getPowerDisplay(effectId, powerLevel)
    local meaning = rickroll.getPowerMeaning(effectId)

    if meaning == "fixed" then
        return ""  -- Don't show power for fixed effects
    elseif meaning == "interval" then
        -- Use per-effect interval if available
        local interval = rickroll.getPowerValue(effectId, powerLevel)
        return string.format("every %ds", interval / 1000)
    elseif meaning == "percentage" then
        local pct = (powerLevel.multiplier - 1) / 2 * 100
        return string.format("%.0f%%", pct)
    elseif meaning == "inverse" then
        local pct = (1.0 / powerLevel.multiplier) * 100
        return string.format("%.0f%%", pct)
    elseif meaning == "duration" then
        -- Show duration in seconds (base 30s * multiplier)
        return string.format("%.0fs", powerLevel.multiplier * 30)
    else -- multiplier
        return string.format("%.2fx", powerLevel.multiplier)
    end
end

-- Check if effect can be used with ALL PLAYERS
function rickroll.canApplyToAll(effect)
    -- Single player only effects can't target ALL
    if effect.singlePlayerOnly then
        return false
    end
    return true
end

-- Get effects available for a target (filters out singlePlayerOnly when ALL selected)
function rickroll.getAvailableEffects(isAllPlayers)
    local available = {
        blessed = {},
        cursed = {},
        chaotic = {}
    }

    for _, effect in ipairs(rickroll.effects.blessed) do
        if not isAllPlayers or rickroll.canApplyToAll(effect) then
            table.insert(available.blessed, effect)
        end
    end

    for _, effect in ipairs(rickroll.effects.cursed) do
        if not isAllPlayers or rickroll.canApplyToAll(effect) then
            table.insert(available.cursed, effect)
        end
    end

    for _, effect in ipairs(rickroll.effects.chaotic) do
        if not isAllPlayers or rickroll.canApplyToAll(effect) then
            table.insert(available.chaotic, effect)
        end
    end

    return available
end

return rickroll.config
