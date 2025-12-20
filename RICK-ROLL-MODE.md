# 🎸 RICK ROLL MODE - Implementation Plan

## Overview

**Rick Roll Mode** is a lottery/jackpot feature for ET:Legacy that randomly triggers during gameplay, displaying a slot-machine style interface with dancing Rick Astley, spinning wheels, and the iconic "Never Gonna Give You Up" music. Random players receive random effects (buffs or debuffs) for configurable durations.

---

## 🎬 The Experience

```
TRIGGER EVENT
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  🔴🟡🟢🔵 SCREEN FLASHES 🔵🟢🟡🔴                                │
│                                                                 │
│  ♫ "We're no strangers to love..." ♫                           │
│                                                                 │
│         ┌─────────────────────────────────────┐                 │
│         │    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │                 │
│         │    ░░  DANCING RICK ASTLEY   ░░    │                 │
│         │    ░░    (20 frame loop)     ░░    │                 │
│         │    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │                 │
│         └─────────────────────────────────────┘                 │
│                                                                 │
│    ┌──────────┐    ┌──────────┐    ┌──────────┐                │
│    │ PLAYER   │    │  EFFECT  │    │ INTENSITY│                │
│    │ spinning │    │ spinning │    │ spinning │                │
│    └──────────┘    └──────────┘    └──────────┘                │
│                                                                 │
│            ♫ "Never gonna give you up!" ♫                       │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
EFFECT APPLIED - Timer starts (configurable duration)
```

---

## 📁 Project Structure

```
etlegacy/
├── rickroll/                          # Asset staging directory
│   ├── gfx/rickroll/
│   │   └── rick_spritesheet.tga       # ✅ CREATED - 2048x512, 20 frames
│   ├── sound/rickroll/
│   │   └── rickroll.wav               # ✅ CREATED - 18.67s, 22050Hz stereo
│   └── scripts/
│       └── rickroll.shader            # Shader definitions
│
├── src/cgame/                         # C mod changes
│   ├── cg_rickroll.c                  # NEW - Rick Roll rendering
│   └── cg_local.h                     # Add rickroll declarations
│
├── lua/                               # Lua scripts
│   └── rickroll/
│       ├── main.lua                   # Main entry point
│       ├── config.lua                 # Configuration table
│       ├── effects.lua                # Effect definitions & application
│       ├── trigger.lua                # Trigger system (timer-based)
│       ├── selection.lua              # Player/effect wheel logic
│       └── ui.lua                     # HUD communication
│
└── configs/
    └── rickroll.cfg                   # Server CVAR configuration
```

---

## 🖼️ Asset Specifications

### Sprite Sheet: `rick_spritesheet.tga`
| Property | Value |
|----------|-------|
| Dimensions | 2048 x 512 |
| Layout | 8 columns × 3 rows |
| Frame size | 256 x 170 (with padding) |
| Frame count | 20 frames (positions 0-19) |
| Animation | ~10 FPS loop |
| Format | 32-bit TGA with alpha |

### Audio: `rickroll.wav`
| Property | Value |
|----------|-------|
| Duration | 18.67 seconds |
| Sample rate | 22050 Hz |
| Channels | Stereo |
| Bit depth | 16-bit PCM |
| File size | 1.65 MB |

---

## ⚙️ Configuration Options (CVARs)

```cfg
// Rick Roll Mode Configuration

// Master toggle
set rickroll_enabled "1"              // 0 = disabled, 1 = enabled

// Trigger settings
set rickroll_interval_min "300"       // Minimum seconds between triggers (5 min)
set rickroll_interval_max "600"       // Maximum seconds between triggers (10 min)
set rickroll_warmup_delay "120"       // Don't trigger in first 2 min of map

// Duration settings
set rickroll_effect_duration "60"     // How long effects last (seconds)
set rickroll_animation_duration "18"  // How long the animation plays (match audio)

// Effect probabilities (weights, higher = more likely)
set rickroll_weight_blessed "50"      // Good effects
set rickroll_weight_cursed "40"       // Bad effects
set rickroll_weight_chaotic "10"      // Affects everyone

// Audio
set rickroll_volume "0.8"             // Music volume (0.0 - 1.0)
set rickroll_sounds "1"               // Play sound effects

// Visual
set rickroll_flash "1"                // Screen flash on trigger
set rickroll_freeze "1"               // Freeze players during animation
```

---

## 🎰 Effect Definitions

### BLESSED (Good Effects) 🟢
| ID | Name | Description | Implementation |
|----|------|-------------|----------------|
| `speed_up` | Super Speed | 1.5x movement speed | `g_speed` modifier |
| `health_up` | Tank Mode | 2x max health + heal to full | `maxHealth` + heal |
| `damage_up` | Heavy Hitter | 1.5x damage dealt | Damage multiplier |
| `ammo_inf` | Unlimited Ammo | Infinite ammo for duration | Ammo refill loop |
| `regen` | Regeneration | Heal 5 HP/sec | Periodic heal |
| `vampire` | Vampiric | Heal on damage dealt | Damage callback |
| `armor_up` | Damage Resist | Take 50% less damage | Damage reduction |
| `jump_up` | Moon Boots | 2x jump height | `pm_jumpheight` |

### CURSED (Bad Effects) 🔴
| ID | Name | Description | Implementation |
|----|------|-------------|----------------|
| `speed_down` | Tiny Legs | 0.5x movement speed | `g_speed` modifier |
| `health_down` | Glass Cannon | 0.5x max health | `maxHealth` reduction |
| `damage_down` | Pea Shooter | 0.5x damage dealt | Damage multiplier |
| `drunk` | Drunk Mode | Screen wobble/blur | View angle modification |
| `glow` | Spotlight | Player glows/visible through walls | Shader effect |
| `jump_down` | Lead Boots | 0.5x jump height | `pm_jumpheight` |
| `reverse` | Reverse Controls | Inverted movement | Input modification |
| `foggy` | Tunnel Vision | Reduced FOV | `cg_fov` reduction |

### CHAOTIC (Affects Everyone) 🟡
| ID | Name | Description | Implementation |
|----|------|-------------|----------------|
| `knife_fight` | Knife Fight! | Everyone loses guns | Weapon strip |
| `panzer_party` | Panzer Party | Everyone gets panzer | Weapon give |
| `low_grav` | Low Gravity | Reduced gravity for all | `g_gravity` |
| `speed_all` | Caffeine Rush | Everyone 1.5x speed | Global `g_speed` |
| `melee_only` | Brawl Time | Melee damage 3x, guns 0.25x | Damage modifiers |

### SPECIAL (Rare) ⭐
| ID | Name | Description | Implementation |
|----|------|-------------|----------------|
| `godmode` | Invincible | Cannot take damage | God mode flag |
| `shrink` | Mini Me | Half size (visual only) | Model scale |
| `giant` | Giant | Double size (visual only) | Model scale |
| `invisible` | Ghost | Invisible but can attack | Alpha shader |
| `rick_rolled` | RICK ROLLED | All of the above bad effects | Combo effect |

---

## 🛠️ Implementation Phases

### Phase 1: Core Lua System ⏱️ ~2-3 hours
**Goal:** Working trigger, player selection, and effect application (text-only feedback)

```lua
-- lua/rickroll/main.lua
rickroll = {}

-- Load modules
dofile("legacy/lua/rickroll/config.lua")
dofile("legacy/lua/rickroll/effects.lua")
dofile("legacy/lua/rickroll/trigger.lua")
dofile("legacy/lua/rickroll/selection.lua")
dofile("legacy/lua/rickroll/ui.lua")

function et_InitGame(levelTime, randomSeed, restart)
    rickroll.trigger.init()
    et.G_Print("^5[Rick Roll Mode]^7 Initialized\n")
end

function et_RunFrame(levelTime)
    rickroll.trigger.check(levelTime)
    rickroll.effects.update(levelTime)
end
```

**Deliverables:**
- [ ] Timer-based random trigger system
- [ ] Random player selection from active players
- [ ] Random effect selection with weights
- [ ] Effect application (health, speed, damage modifiers)
- [ ] Effect duration tracking and removal
- [ ] Console/chat announcements

### Phase 2: Audio Integration ⏱️ ~1 hour
**Goal:** Play music and synchronize with events

```lua
-- Play the rick roll music globally
function rickroll.ui.playMusic()
    et.G_globalSound("sound/rickroll/rickroll.wav")
end
```

**Deliverables:**
- [ ] Global sound playback on trigger
- [ ] Additional sound effects (wheel stop, fanfare, sad trombone)
- [ ] Volume configuration

### Phase 3: Shader & pk3 Setup ⏱️ ~1 hour
**Goal:** Package assets properly for ET:Legacy

```shader
// scripts/rickroll.shader
gfx/rickroll/rick_spritesheet
{
    nopicmip
    nomipmaps
    {
        map gfx/rickroll/rick_spritesheet.tga
        blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
        rgbGen vertex
        alphaGen vertex
    }
}
```

**Deliverables:**
- [ ] Shader definitions for sprite sheet
- [ ] Wheel frame graphics (optional)
- [ ] pk3 packaging script
- [ ] HTTP download server setup

### Phase 4: cgame HUD Integration ⏱️ ~4-6 hours
**Goal:** Visual overlay with animated Rick and spinning wheels

**New file: `src/cgame/cg_rickroll.c`**
```c
// Rick Roll Mode HUD rendering
typedef struct {
    qboolean active;
    int startTime;
    int phase;           // 0=flash, 1=spin, 2=reveal, 3=done
    int selectedPlayer;
    int selectedEffect;
    int selectedIntensity;
    int wheel1StopTime;
    int wheel2StopTime;
    int wheel3StopTime;
} rickrollState_t;

static rickrollState_t rr;

void CG_RickRoll_Draw(void) {
    if (!rr.active) return;

    int elapsed = cg.time - rr.startTime;

    // Draw darkened background
    CG_FillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, colorDarkOverlay);

    // Draw animated Rick (sprite sheet frame selection)
    int frame = (elapsed / 100) % 20;  // 10 FPS
    float u1 = (frame % 8) * 0.125f;   // 1/8 = 0.125
    float v1 = (frame / 8) * 0.333f;   // 1/3 = 0.333
    float u2 = u1 + 0.125f;
    float v2 = v1 + 0.333f;

    CG_DrawStretchPic(rickX, rickY, rickW, rickH, u1, v1, u2, v2, rickShader);

    // Draw spinning wheels
    CG_RickRoll_DrawWheel(wheel1X, wheel1Y, &rr.playerWheel, rr.wheel1StopTime);
    CG_RickRoll_DrawWheel(wheel2X, wheel2Y, &rr.effectWheel, rr.wheel2StopTime);
    CG_RickRoll_DrawWheel(wheel3X, wheel3Y, &rr.intensityWheel, rr.wheel3StopTime);
}
```

**Deliverables:**
- [ ] Rick sprite sheet animation rendering
- [ ] Three spinning wheels with text
- [ ] Wheel slowdown physics (ease-out)
- [ ] Screen flash effect
- [ ] Player freeze during animation
- [ ] Server→client communication for state

### Phase 5: Polish & Testing ⏱️ ~2-3 hours
**Goal:** Refinement and edge cases

**Deliverables:**
- [ ] Audio/visual timing synchronization
- [ ] Multiple resolution support
- [ ] Performance optimization
- [ ] Edge cases (player disconnect during roll, map change, etc.)
- [ ] Spectator handling
- [ ] Team balance considerations

---

## 🔌 Server↔Client Communication

The server (Lua) controls game logic, the client (cgame) handles visuals.

### Server → Client Commands
```
rickroll_start <startTime> <seed>
    // Client begins animation, uses seed for deterministic wheel positions

rickroll_result <playerId> <effectId> <intensity>
    // After animation, apply the result

rickroll_end
    // Clean up UI state
```

### Client → Server (not needed for v1)
Later: could add player input for "pull the lever" mechanic

---

## 📋 Lua Module Details

### config.lua
```lua
rickroll.config = {
    enabled = true,

    -- Timing
    interval = {min = 300, max = 600},  -- 5-10 minutes
    warmupDelay = 120,                   -- 2 min warmup
    effectDuration = 60,                 -- 1 minute effects
    animationDuration = 18,              -- Match audio length

    -- Wheel stop times (seconds into animation)
    wheel1Stop = 6,   -- Player wheel
    wheel2Stop = 9,   -- Effect wheel
    wheel3Stop = 12,  -- Intensity wheel

    -- Weights
    weights = {
        blessed = 50,
        cursed = 40,
        chaotic = 10
    },

    -- Intensities (multipliers)
    intensities = {1.25, 1.5, 2.0, 2.5, 3.0},

    -- Audio
    soundEnabled = true,
    musicPath = "sound/rickroll/rickroll.wav"
}
```

### effects.lua
```lua
rickroll.effects = {
    active = {},  -- {clientNum = {effect, endTime, intensity}}
}

function rickroll.effects.apply(clientNum, effectId, intensity, duration)
    local effect = rickroll.effects.definitions[effectId]
    if not effect then return false end

    -- Store active effect
    rickroll.effects.active[clientNum] = {
        id = effectId,
        endTime = et.trap_Milliseconds() + (duration * 1000),
        intensity = intensity,
        originalValues = {}  -- Store values to restore later
    }

    -- Apply effect
    effect.apply(clientNum, intensity)

    return true
end

function rickroll.effects.remove(clientNum)
    local active = rickroll.effects.active[clientNum]
    if not active then return end

    local effect = rickroll.effects.definitions[active.id]
    if effect and effect.remove then
        effect.remove(clientNum, active.originalValues)
    end

    rickroll.effects.active[clientNum] = nil
end

function rickroll.effects.update(levelTime)
    local now = et.trap_Milliseconds()
    for clientNum, data in pairs(rickroll.effects.active) do
        if now >= data.endTime then
            rickroll.effects.remove(clientNum)
            rickroll.ui.announce(clientNum, "effect_expired")
        end
    end
end
```

### trigger.lua
```lua
rickroll.trigger = {
    nextTriggerTime = 0,
    lastTriggerTime = 0
}

function rickroll.trigger.init()
    rickroll.trigger.scheduleNext()
end

function rickroll.trigger.scheduleNext()
    local cfg = rickroll.config
    local delay = math.random(cfg.interval.min, cfg.interval.max) * 1000
    rickroll.trigger.nextTriggerTime = et.trap_Milliseconds() + delay
end

function rickroll.trigger.check(levelTime)
    if not rickroll.config.enabled then return end

    local now = et.trap_Milliseconds()

    -- Check warmup
    if levelTime < (rickroll.config.warmupDelay * 1000) then return end

    -- Check if it's time
    if now >= rickroll.trigger.nextTriggerTime then
        rickroll.trigger.fire()
        rickroll.trigger.scheduleNext()
    end
end

function rickroll.trigger.fire()
    -- Select random player
    local players = rickroll.selection.getEligiblePlayers()
    if #players == 0 then return end

    local selectedPlayer = players[math.random(#players)]

    -- Select random effect
    local effect = rickroll.selection.pickEffect()

    -- Select random intensity
    local intensity = rickroll.selection.pickIntensity()

    -- Start the show!
    rickroll.ui.startAnimation(selectedPlayer, effect, intensity)

    -- Schedule effect application (after animation)
    rickroll.trigger.pendingResult = {
        player = selectedPlayer,
        effect = effect,
        intensity = intensity,
        applyTime = et.trap_Milliseconds() + (rickroll.config.animationDuration * 1000)
    }
end
```

### selection.lua
```lua
rickroll.selection = {}

function rickroll.selection.getEligiblePlayers()
    local players = {}
    for clientNum = 0, 63 do
        local team = et.gentity_get(clientNum, "sess.sessionTeam")
        -- Only include players on Axis or Allies (not spectators)
        if team == 1 or team == 2 then
            table.insert(players, clientNum)
        end
    end
    return players
end

function rickroll.selection.pickEffect()
    local weights = rickroll.config.weights
    local total = weights.blessed + weights.cursed + weights.chaotic
    local roll = math.random(total)

    local category
    if roll <= weights.blessed then
        category = "blessed"
    elseif roll <= weights.blessed + weights.cursed then
        category = "cursed"
    else
        category = "chaotic"
    end

    -- Pick random effect from category
    local effects = rickroll.effects.byCategory[category]
    return effects[math.random(#effects)]
end

function rickroll.selection.pickIntensity()
    local intensities = rickroll.config.intensities
    return intensities[math.random(#intensities)]
end
```

### ui.lua
```lua
rickroll.ui = {}

function rickroll.ui.startAnimation(player, effect, intensity)
    -- Play music globally
    et.G_globalSound(rickroll.config.musicPath)

    -- Send command to all clients to start animation
    local seed = math.random(999999)
    et.trap_SendServerCommand(-1, string.format(
        "rickroll_start %d %d",
        et.trap_Milliseconds(),
        seed
    ))

    -- Freeze all players (optional)
    if rickroll.config.freezePlayers then
        rickroll.ui.freezeAll(true)
    end

    -- Store for later
    rickroll.ui.pending = {
        player = player,
        effect = effect,
        intensity = intensity
    }
end

function rickroll.ui.announce(clientNum, eventType)
    local name = et.gentity_get(clientNum, "pers.netname")
    local msg

    if eventType == "selected" then
        msg = string.format("^5[RICK ROLL]^7 %s ^7has been RICK ROLLED!", name)
    elseif eventType == "effect_applied" then
        local data = rickroll.effects.active[clientNum]
        local effectName = rickroll.effects.definitions[data.id].name
        msg = string.format("^5[RICK ROLL]^7 %s ^7got: ^3%s ^7(%.1fx) for %ds!",
            name, effectName, data.intensity, rickroll.config.effectDuration)
    elseif eventType == "effect_expired" then
        msg = string.format("^5[RICK ROLL]^7 %s^7's effect has worn off.", name)
    end

    if msg then
        et.trap_SendServerCommand(-1, "chat \"" .. msg .. "\"")
    end
end
```

---

## 🔧 cgame Modifications

### Files to Modify

**cg_local.h** - Add declarations:
```c
// Rick Roll Mode
extern vmCvar_t cg_rickrollEnabled;

typedef struct {
    qboolean active;
    int startTime;
    int seed;
    int phase;
    char players[64][MAX_NAME_LENGTH];
    int playerCount;
    char effects[32][64];
    int effectCount;
    float intensities[8];
    int intensityCount;
    int result_player;
    int result_effect;
    int result_intensity;
} rickrollState_t;

extern rickrollState_t rickrollState;

void CG_RickRoll_Start(int startTime, int seed);
void CG_RickRoll_Result(int player, int effect, int intensity);
void CG_RickRoll_End(void);
void CG_RickRoll_Draw(void);
qhandle_t CG_RickRoll_GetShader(void);
```

**cg_draw.c** - Add to HUD drawing:
```c
// In CG_Draw2D() or appropriate location
if (rickrollState.active) {
    CG_RickRoll_Draw();
}
```

**cg_servercmds.c** - Handle server commands:
```c
// In CG_ServerCommand()
if (!strcmp(cmd, "rickroll_start")) {
    int startTime = atoi(CG_Argv(1));
    int seed = atoi(CG_Argv(2));
    CG_RickRoll_Start(startTime, seed);
    return;
}
if (!strcmp(cmd, "rickroll_result")) {
    // ... handle result
    return;
}
```

### New File: cg_rickroll.c
```c
#include "cg_local.h"

rickrollState_t rickrollState;
static qhandle_t rickShader;
static qhandle_t wheelShader;

// Wheel configuration
#define WHEEL_SPIN_SPEED 50.0f
#define WHEEL_DECEL 0.95f
#define RICK_FRAME_TIME 100  // 10 FPS

// Screen positions (normalized 640x480)
#define RICK_X 220
#define RICK_Y 40
#define RICK_W 200
#define RICK_H 133

#define WHEEL_Y 200
#define WHEEL_W 120
#define WHEEL_H 160
#define WHEEL1_X 100
#define WHEEL2_X 260
#define WHEEL3_X 420

void CG_RickRoll_Init(void) {
    rickShader = trap_R_RegisterShader("gfx/rickroll/rick_spritesheet");
    // wheelShader = trap_R_RegisterShader("gfx/rickroll/wheel_frame");
    memset(&rickrollState, 0, sizeof(rickrollState));
}

void CG_RickRoll_Start(int startTime, int seed) {
    rickrollState.active = qtrue;
    rickrollState.startTime = startTime;
    rickrollState.seed = seed;
    rickrollState.phase = 0;

    // Initialize player list from current clients
    rickrollState.playerCount = 0;
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (cgs.clientinfo[i].infoValid &&
            cgs.clientinfo[i].team != TEAM_SPECTATOR) {
            Q_strncpyz(rickrollState.players[rickrollState.playerCount],
                       cgs.clientinfo[i].name, MAX_NAME_LENGTH);
            rickrollState.playerCount++;
        }
    }

    // Initialize effects list
    // (These should match server-side definitions)
    // ... populate effects array
}

static void CG_RickRoll_DrawRick(int elapsed) {
    // Calculate current frame (20 frames, 100ms each)
    int frame = (elapsed / RICK_FRAME_TIME) % 20;

    // Calculate UV coordinates for sprite sheet
    // Sheet is 8x3, each frame is 256x170 in 2048x512 texture
    float frameU = (frame % 8) / 8.0f;
    float frameV = (frame / 8) / 3.0f;
    float frameUEnd = frameU + (1.0f / 8.0f);
    float frameVEnd = frameV + (1.0f / 3.0f);

    // Draw Rick
    trap_R_DrawStretchPic(RICK_X, RICK_Y, RICK_W, RICK_H,
                          frameU, frameV, frameUEnd, frameVEnd,
                          rickShader);
}

static void CG_RickRoll_DrawWheel(int x, int y, char items[][64],
                                   int itemCount, int stopTime, int elapsed) {
    // Wheel spinning logic
    float position;

    if (stopTime > 0 && elapsed >= stopTime) {
        // Wheel has stopped - show final position
        // Use seed to determine final position
        position = (rickrollState.seed % itemCount);
    } else {
        // Wheel is spinning - calculate position based on time
        float speed = WHEEL_SPIN_SPEED;
        if (stopTime > 0) {
            // Slowing down
            float remaining = (stopTime - elapsed) / 1000.0f;
            speed *= remaining / 6.0f;  // Ease out over last 6 seconds
        }
        position = fmod(elapsed * speed / 1000.0f, itemCount);
    }

    // Draw visible items (3 visible at once)
    int centerIdx = (int)position % itemCount;
    float offset = position - (int)position;

    // Draw wheel frame
    vec4_t wheelBg = {0.1f, 0.1f, 0.1f, 0.8f};
    CG_FillRect(x, y, WHEEL_W, WHEEL_H, wheelBg);

    // Draw items
    vec4_t textColor = {1.0f, 1.0f, 1.0f, 1.0f};
    int itemHeight = WHEEL_H / 3;

    for (int i = -1; i <= 1; i++) {
        int idx = (centerIdx + i + itemCount) % itemCount;
        float itemY = y + (i + 1) * itemHeight - (offset * itemHeight);

        if (itemY >= y && itemY < y + WHEEL_H) {
            // Highlight center item
            if (i == 0) {
                vec4_t highlight = {0.3f, 0.3f, 0.0f, 0.5f};
                CG_FillRect(x, y + itemHeight, WHEEL_W, itemHeight, highlight);
            }

            CG_Text_Paint(x + 10, itemY + itemHeight/2 + 5, 0.25f,
                         textColor, items[idx], 0, 0, ITEM_TEXTSTYLE_SHADOWED);
        }
    }

    // Draw selection indicator
    vec4_t indicatorColor = {1.0f, 0.8f, 0.0f, 1.0f};
    CG_DrawRect(x, y + itemHeight, WHEEL_W, itemHeight, 2, indicatorColor);
}

void CG_RickRoll_Draw(void) {
    if (!rickrollState.active) return;

    int elapsed = cg.time - rickrollState.startTime;

    // Check if animation is complete (18 seconds)
    if (elapsed > 18000) {
        rickrollState.active = qfalse;
        return;
    }

    // Draw darkened background
    vec4_t overlay = {0.0f, 0.0f, 0.0f, 0.7f};
    CG_FillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, overlay);

    // Draw "RICK ROLL MODE" title with flash effect
    vec4_t titleColor;
    if (elapsed < 500) {
        // Flash white at start
        float flash = 1.0f - (elapsed / 500.0f);
        Vector4Set(titleColor, 1.0f, 1.0f, 1.0f, flash);
        CG_FillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, titleColor);
    }

    Vector4Set(titleColor, 1.0f, 0.3f, 0.3f, 1.0f);
    CG_Text_Paint(SCREEN_WIDTH/2 - 100, 30, 0.5f, titleColor,
                  "RICK ROLL MODE", 0, 0, ITEM_TEXTSTYLE_SHADOWEDMORE);

    // Draw dancing Rick
    CG_RickRoll_DrawRick(elapsed);

    // Calculate wheel stop times
    int wheel1Stop = 6000;   // Player wheel stops at 6s
    int wheel2Stop = 9000;   // Effect wheel stops at 9s
    int wheel3Stop = 12000;  // Intensity wheel stops at 12s

    // Draw wheels
    // Note: In real implementation, need proper item arrays
    static char playerItems[64][64];
    static char effectItems[32][64];
    static char intensityItems[8][64] = {
        "1.25x", "1.5x", "2.0x", "2.5x", "3.0x", "1.25x", "1.5x", "2.0x"
    };

    // Populate player items from state
    for (int i = 0; i < rickrollState.playerCount && i < 64; i++) {
        Q_strncpyz(playerItems[i], rickrollState.players[i], 64);
    }

    CG_RickRoll_DrawWheel(WHEEL1_X, WHEEL_Y, playerItems,
                          rickrollState.playerCount, wheel1Stop, elapsed);
    // ... draw other wheels

    // Draw result text after all wheels stop
    if (elapsed > wheel3Stop + 1000) {
        vec4_t resultColor = {0.0f, 1.0f, 0.0f, 1.0f};
        CG_Text_Paint(SCREEN_WIDTH/2 - 150, SCREEN_HEIGHT - 60, 0.35f,
                     resultColor, "Never gonna give you up!",
                     0, 0, ITEM_TEXTSTYLE_SHADOWEDMORE);
    }
}

void CG_RickRoll_End(void) {
    rickrollState.active = qfalse;
}
```

---

## 📦 pk3 Packaging

### Directory Structure for pk3
```
rickroll.pk3 (zip archive)
├── gfx/
│   └── rickroll/
│       └── rick_spritesheet.tga
├── scripts/
│   └── rickroll.shader
└── sound/
    └── rickroll/
        └── rickroll.wav
```

### Build Script
```bash
#!/bin/bash
# scripts/build-rickroll-pk3.sh

cd /home/andy/projects/et/etlegacy/rickroll

# Create pk3 (it's just a zip)
zip -r ../dist/rickroll.pk3 \
    gfx/ \
    scripts/ \
    sound/

echo "Created rickroll.pk3"
ls -la ../dist/rickroll.pk3
```

---

## 🧪 Testing Checklist

### Phase 1 - Core
- [ ] Trigger fires after configured interval
- [ ] Random player selected from active players only
- [ ] Random effect selected with proper weighting
- [ ] Effect applies correctly (verify health/speed changes)
- [ ] Effect removes after duration
- [ ] Console messages display correctly

### Phase 2 - Audio
- [ ] Music plays globally on trigger
- [ ] Volume is appropriate
- [ ] Audio file loads from pk3

### Phase 3 - Visuals
- [ ] Shader loads correctly
- [ ] Rick sprite animates at ~10 FPS
- [ ] Screen darkens during animation
- [ ] Wheels spin and slow down

### Phase 4 - Integration
- [ ] Animation syncs with audio
- [ ] Wheels stop at correct times
- [ ] Result matches server selection
- [ ] Effect applies after animation ends
- [ ] Multiple resolutions work

### Edge Cases
- [ ] Player disconnects during roll (select new player)
- [ ] Map changes during roll (clean up)
- [ ] Only 1 player online (still works)
- [ ] Spectators not selected
- [ ] Effect on player who dies (persists through respawn?)

---

## 🚀 Quick Start Commands

```bash
# Build the pk3
cd /home/andy/projects/et/etlegacy
./scripts/build-rickroll-pk3.sh

# Build cgame with rick roll support
./scripts/build-all.sh mod

# Deploy everything
./scripts/publish.sh

# Test locally (force trigger via rcon)
/rcon rickroll_trigger

# Check status
/rcon rickroll_status
```

---

## 📝 Notes & Considerations

1. **Performance**: The sprite sheet animation should be efficient, but test on lower-end machines

2. **Network**: Keep server→client commands minimal; use seed for deterministic wheel positions

3. **Fairness**: Consider adding protection so same player can't be selected twice in a row

4. **Customization**: All timing, effects, and weights should be configurable for server admins

5. **Extensibility**: Design effect system to easily add new effects later

6. **Sound licensing**: Using ~19 seconds of copyrighted music on a private game server is likely fine under fair use for parody/entertainment, but not for commercial use

---

## 🎯 MVP Definition

**Minimum Viable Product** (what we ship first):
1. ✅ Random timer trigger
2. ✅ Random player selection
3. ✅ Random effect selection (3-5 effects)
4. ✅ Effect application & duration
5. ✅ Audio playback
6. ✅ Basic HUD text (can skip cgame graphics for v1)
7. ✅ Chat announcements

**Nice to Have** (Phase 2+):
- Animated Rick sprite
- Spinning wheel graphics
- Screen flash effects
- Player freeze during animation
- More effects
- Special combos
