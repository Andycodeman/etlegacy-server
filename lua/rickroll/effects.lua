--[[
    Rick Roll Mode - Effect Application System
    Handles applying, tracking, and removing effects
]]--

rickroll = rickroll or {}
rickroll.effectSystem = {}

-- Apply effect to player
function rickroll.effectSystem.apply(clientNum, effect, category, intensity, duration)
    local now = et.trap_Milliseconds()
    local endTime = now + duration

    -- Store original values for restoration
    local originalValues = {}

    -- Apply based on effect type
    if effect.id == "speed_up" then
        -- Store in activeEffects, actual speed change handled via CVAR
        originalValues.speed = tonumber(et.trap_Cvar_Get("g_speed")) or 320
        -- Note: Per-player speed requires qagame modification
        -- For now, we'll announce it and track it

    elseif effect.id == "speed_down" then
        originalValues.speed = tonumber(et.trap_Cvar_Get("g_speed")) or 320

    elseif effect.id == "health_up" then
        local currentHealth = et.gentity_get(clientNum, "health") or 100
        originalValues.health = currentHealth
        local newHealth = math.floor(currentHealth * intensity)
        et.gentity_set(clientNum, "health", newHealth)

    elseif effect.id == "health_down" then
        local currentHealth = et.gentity_get(clientNum, "health") or 100
        originalValues.health = currentHealth
        local newHealth = math.floor(currentHealth / intensity)
        if newHealth < 1 then newHealth = 1 end
        et.gentity_set(clientNum, "health", newHealth)

    elseif effect.id == "regen" then
        -- Regen is handled in update loop
        originalValues.regen = true

    elseif effect.id == "damage_up" or effect.id == "damage_down" then
        -- Damage modifiers need qagame support
        originalValues.damage = true

    elseif effect.id == "glow" then
        -- Glow effect needs cgame shader support
        originalValues.glow = true

    elseif effect.id == "knife_fight" then
        -- Chaotic: affects everyone
        rickroll.effectSystem.applyKnifeFight(endTime)
        return true

    elseif effect.id == "low_grav" then
        -- Chaotic: global gravity change
        originalValues.gravity = tonumber(et.trap_Cvar_Get("g_gravity")) or 800
        local newGrav = math.floor(originalValues.gravity / intensity)
        et.trap_Cvar_Set("g_gravity", tostring(newGrav))

        -- Store as global effect
        rickroll.state.globalEffects["low_grav"] = {
            endTime = endTime,
            originalValue = originalValues.gravity
        }
        return true

    elseif effect.id == "speed_all" then
        -- Chaotic: global speed change
        originalValues.speed = tonumber(et.trap_Cvar_Get("g_speed")) or 320
        local newSpeed = math.floor(originalValues.speed * intensity)
        et.trap_Cvar_Set("g_speed", tostring(newSpeed))

        rickroll.state.globalEffects["speed_all"] = {
            endTime = endTime,
            originalValue = originalValues.speed
        }
        return true
    end

    -- Store active effect for this player
    rickroll.state.activeEffects[clientNum] = {
        effectId = effect.id,
        effectName = effect.name,
        category = category,
        endTime = endTime,
        intensity = intensity,
        originalValues = originalValues
    }

    -- Notify via configstring for cgame to render indicator
    rickroll.effectSystem.updateConfigstring(clientNum)

    return true
end

-- Apply knife fight to all players
function rickroll.effectSystem.applyKnifeFight(endTime)
    local maxClients = tonumber(et.trap_Cvar_Get("sv_maxclients")) or 64

    for clientNum = 0, maxClients - 1 do
        if et.gentity_get(clientNum, "inuse") == 1 then
            local team = et.gentity_get(clientNum, "sess.sessionTeam")
            if team == 1 or team == 2 then
                -- Strip to knife
                -- This is a simplified version - full weapon strip needs qagame
                et.trap_SendServerCommand(clientNum, 'cp "^1KNIFE FIGHT!"')
            end
        end
    end

    rickroll.state.globalEffects["knife_fight"] = {
        endTime = endTime,
        originalValue = nil
    }
end

-- Remove effect from player
function rickroll.effectSystem.remove(clientNum)
    local active = rickroll.state.activeEffects[clientNum]
    if not active then
        return
    end

    local orig = active.originalValues

    -- Restore original values
    if active.effectId == "health_up" or active.effectId == "health_down" then
        -- Don't restore health, just let it be
        -- (player might have taken damage)
    end

    -- Clear active effect
    rickroll.state.activeEffects[clientNum] = nil

    -- Update configstring
    rickroll.effectSystem.updateConfigstring(clientNum)

    -- Announce expiry
    local name = et.gentity_get(clientNum, "pers.netname") or "Player"
    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7%s^7\'s effect has worn off."',
        name
    ))
end

-- Remove global effect
function rickroll.effectSystem.removeGlobal(effectId)
    local global = rickroll.state.globalEffects[effectId]
    if not global then
        return
    end

    -- Restore original value
    if effectId == "low_grav" and global.originalValue then
        et.trap_Cvar_Set("g_gravity", tostring(global.originalValue))
    elseif effectId == "speed_all" and global.originalValue then
        et.trap_Cvar_Set("g_speed", tostring(global.originalValue))
    end

    rickroll.state.globalEffects[effectId] = nil

    et.trap_SendServerCommand(-1, string.format(
        'chat "^5[RICK ROLL] ^7Global effect ^3%s ^7has ended."',
        effectId
    ))
end

-- Update effect every frame
function rickroll.effectSystem.update(levelTime)
    local now = et.trap_Milliseconds()

    -- Check player effects
    for clientNum, data in pairs(rickroll.state.activeEffects) do
        if now >= data.endTime then
            rickroll.effectSystem.remove(clientNum)
        else
            -- Handle ongoing effects
            if data.effectId == "regen" then
                -- Regenerate 5 HP per second (called every ~50ms)
                local health = et.gentity_get(clientNum, "health")
                local maxHealth = 100 * data.intensity  -- Assume max is modified
                if health and health < maxHealth then
                    -- Add ~0.25 HP per frame (5 per second at 20fps)
                    local newHealth = math.min(health + 0.25, maxHealth)
                    et.gentity_set(clientNum, "health", math.floor(newHealth))
                end
            end
        end
    end

    -- Check global effects
    for effectId, data in pairs(rickroll.state.globalEffects) do
        if now >= data.endTime then
            rickroll.effectSystem.removeGlobal(effectId)
        end
    end
end

-- Update configstring for cgame (effect indicator)
function rickroll.effectSystem.updateConfigstring(clientNum)
    local active = rickroll.state.activeEffects[clientNum]

    if active then
        -- Format: effectId:endTime:intensity
        local value = string.format("%s:%d:%.2f",
            active.effectId,
            active.endTime,
            active.intensity
        )
        -- Use a custom configstring range (CS_RICKROLL_EFFECTS = 700+ or similar)
        -- For now, we'll use servercommands
    end
end

-- Get active effect for player (for cgame queries)
function rickroll.effectSystem.getActive(clientNum)
    return rickroll.state.activeEffects[clientNum]
end

-- Check if player has specific effect
function rickroll.effectSystem.hasEffect(clientNum, effectId)
    local active = rickroll.state.activeEffects[clientNum]
    return active and active.effectId == effectId
end

return rickroll.effectSystem
