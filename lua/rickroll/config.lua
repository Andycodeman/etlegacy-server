--[[
    Rick Roll Mode - Configuration
    All settings for the Rick Roll lottery system
]]--

rickroll = rickroll or {}

rickroll.config = {
    -- Master toggle
    enabled = true,

    -- Trigger timing (milliseconds)
    interval = {
        min = 30000,    -- 30 seconds minimum between rolls (TESTING - change to 300000 for production)
        max = 60000     -- 60 seconds maximum (TESTING - change to 600000 for production)
    },
    warmupDelay = 10000,   -- 10 seconds warmup (TESTING - change to 120000 for production)

    -- Animation timing (milliseconds) - synced with 18.67s audio
    animationDuration = 18670,
    wheel1StopTime = 6000,    -- Player wheel stops at 6s
    wheel2StopTime = 9000,    -- Effect wheel stops at 9s
    wheel3StopTime = 12000,   -- Intensity wheel stops at 12s
    resultShowTime = 13000,   -- Show result at 13s

    -- Effect duration (milliseconds)
    effectDuration = 60000,   -- Effects last 60 seconds

    -- Category weights (higher = more likely)
    weights = {
        blessed = 50,   -- Good effects
        cursed = 40,    -- Bad effects
        chaotic = 10    -- Affects everyone
    },

    -- Intensity multipliers
    intensities = {1.25, 1.5, 2.0, 2.5, 3.0},

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
    debug = false
}

-- Effect definitions
rickroll.effects = {
    -- BLESSED (Good) effects
    blessed = {
        {
            id = "speed_up",
            name = "Super Speed",
            description = "Movement speed increased!",
            color = "^2",  -- Green
            apply = function(clientNum, intensity)
                -- Speed is handled via configstring/powerup
                return true
            end
        },
        {
            id = "health_up",
            name = "Tank Mode",
            description = "Maximum health doubled!",
            color = "^2",
            apply = function(clientNum, intensity)
                local maxHealth = et.gentity_get(clientNum, "health")
                local newMax = math.floor(maxHealth * intensity)
                et.gentity_set(clientNum, "health", newMax)
                return true
            end
        },
        {
            id = "regen",
            name = "Regeneration",
            description = "Health regenerates over time!",
            color = "^2",
            apply = function(clientNum, intensity)
                -- Handled in RunFrame
                return true
            end
        },
        {
            id = "damage_up",
            name = "Heavy Hitter",
            description = "Deal more damage!",
            color = "^2",
            apply = function(clientNum, intensity)
                -- Damage multiplier handled in qagame
                return true
            end
        }
    },

    -- CURSED (Bad) effects
    cursed = {
        {
            id = "speed_down",
            name = "Tiny Legs",
            description = "Movement speed reduced!",
            color = "^1",  -- Red
            apply = function(clientNum, intensity)
                return true
            end
        },
        {
            id = "health_down",
            name = "Glass Cannon",
            description = "Maximum health halved!",
            color = "^1",
            apply = function(clientNum, intensity)
                local health = et.gentity_get(clientNum, "health")
                local newHealth = math.floor(health / intensity)
                if newHealth < 1 then newHealth = 1 end
                et.gentity_set(clientNum, "health", newHealth)
                return true
            end
        },
        {
            id = "damage_down",
            name = "Pea Shooter",
            description = "Deal less damage!",
            color = "^1",
            apply = function(clientNum, intensity)
                return true
            end
        },
        {
            id = "glow",
            name = "Spotlight",
            description = "Everyone can see you!",
            color = "^1",
            apply = function(clientNum, intensity)
                return true
            end
        }
    },

    -- CHAOTIC (Affects everyone) effects
    chaotic = {
        {
            id = "knife_fight",
            name = "Knife Fight!",
            description = "Everyone loses their guns!",
            color = "^3",  -- Yellow
            apply = function(clientNum, intensity)
                -- Strip weapons from all players
                for i = 0, 63 do
                    if et.gentity_get(i, "inuse") == 1 then
                        local team = et.gentity_get(i, "sess.sessionTeam")
                        if team == 1 or team == 2 then
                            et.gentity_set(i, "ps.weapon", 1)  -- Knife
                        end
                    end
                end
                return true
            end
        },
        {
            id = "low_grav",
            name = "Moon Mode",
            description = "Low gravity for everyone!",
            color = "^3",
            apply = function(clientNum, intensity)
                local currentGrav = tonumber(et.trap_Cvar_Get("g_gravity")) or 800
                local newGrav = math.floor(currentGrav / intensity)
                et.trap_Cvar_Set("g_gravity", tostring(newGrav))
                return true
            end
        },
        {
            id = "speed_all",
            name = "Caffeine Rush",
            description = "Everyone is faster!",
            color = "^3",
            apply = function(clientNum, intensity)
                local currentSpeed = tonumber(et.trap_Cvar_Get("g_speed")) or 320
                local newSpeed = math.floor(currentSpeed * intensity)
                et.trap_Cvar_Set("g_speed", tostring(newSpeed))
                return true
            end
        }
    }
}

-- Get flat list of all effects for wheel display
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
        for _, effect in ipairs(effects) do
            if effect.id == effectId then
                return effect, category
            end
        end
    end
    return nil
end

return rickroll.config
