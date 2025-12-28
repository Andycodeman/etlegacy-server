# JayMod Features to Port to ET:Legacy

This document tracks JayMod features that players love which are not natively available in ET:Legacy. These are candidates for porting via C code modifications or Lua scripting.

**Last Updated:** 2024-12-20

---

## Priority Legend

| Priority | Meaning |
|----------|---------|
| 🔴 HIGH | Players frequently request, high impact |
| 🟡 MEDIUM | Nice to have, moderate impact |
| 🟢 LOW | Quality of life, lower priority |

## Implementation Method

| Method | Description |
|--------|-------------|
| **C Mod** | Requires modifying ET:Legacy C source code |
| **Lua** | Can be implemented with Lua scripting |
| **Hybrid** | C for core mechanics, Lua for configuration/events |

---

## 🔴 HIGH PRIORITY FEATURES

### 1. Adrenaline Sharing
**Method:** C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Medics can share adrenaline with living teammates instead of only using it on themselves.

**How it works:**
- Alt-fire (right-click) switches syringe to "share mode"
- Syringe visually points outward instead of toward self
- Use on teammate to give them adrenaline buff
- Configurable duration via `g_adrenalineTime` CVAR

**Why players love it:**
- Turns medics into team force multipliers
- Tactical - buff teammates before objective rushes
- Teamwork-focused gameplay

**JayMod CVARs:**
- `g_medics` (bitflag 16) - Enable adrenaline sharing
- `g_adrenalineTime` - Duration in seconds (default 10, JayMod allowed 999)

**Files to modify:**
- `src/game/g_weapon.c` - Weapon_AdrenalineSyringe function
- `src/game/bg_pmove.c` - Movement/powerup logic
- `src/cgame/` - Visual indicator for share mode

---

### 2. Poison Syringes
**Method:** C Mod
**Difficulty:** Hard
**Status:** ❌ Not Started

**Description:**
Blue-colored syringe weapon (slot #4) that poisons enemies on contact.

**How it works:**
- Separate weapon from heal/revive syringe
- Poke enemies to apply poison effect
- Poison deals 10 HP damage every 1.5 seconds
- Causes vision swaying/distortion (cumulative with multiple hits)
- Players can self-cure using health packs (medics cannot self-cure)
- Awards 0.2 Medic XP per poison tick

**Why players love it:**
- Gives medics offensive capability
- Area denial - poisoned enemies must retreat
- Skill-based (need to get close)

**JayMod implementation:**
- New weapon type `WP_POISON_SYRINGE`
- Poison status effect with duration tracking
- Visual distortion shader on poisoned clients

---

### 3. Goomba Kills
**Method:** C Mod (possibly Hybrid)
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Landing on an enemy's head deals damage based on fall distance. Named after Mario Bros.

**How it works:**
- Detect when player lands on enemy hitbox from above
- Calculate damage based on fall velocity
- Attacker takes reduced/no fall damage (enemy cushions fall)
- Play unique "goomba.wav" sound effect
- Award Battle Sense XP for goomba kills

**Why players love it:**
- Hilarious and satisfying kills
- Adds vertical combat awareness
- High risk/reward gameplay
- Punishes campers under ledges
- Style points!

**JayMod implementation:**
- Check collision with enemy heads during PM_CrashLand
- Damage calculation based on fall speed
- Sound effect trigger

---

### 4. Corpse Dragging
**Method:** C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Hold activate key while looking at a dead player to drag their corpse.

**How it works:**
- Approach dead teammate/enemy body
- Hold activate key (F by default)
- Body attaches and follows player movement
- Release to drop body

**Why players love it:**
- Drag teammates to safe spots for revive
- Tactical positioning of corpses
- Deny enemy uniform theft (drag friendly corpses away)
- Move bodies out of doorways/chokepoints

---

## 🟡 MEDIUM PRIORITY FEATURES

### 5. Throwing Knives
**Method:** C Mod
**Difficulty:** Hard
**Status:** ❌ Not Started

**Description:**
Knives can be thrown using alt-fire with physics-based trajectory.

**How it works:**
- Alt-fire to throw knife
- Hold button 0-1 second to control throw distance
- Knives inherit player momentum (strafing affects trajectory)
- Optional poison effect on impact
- Limited knife count (like grenades)

**JayMod CVARs:**
- Poison knife option
- Throw distance scaling

---

### 6. Panzerfest Mode
**Method:** Lua
**Difficulty:** Easy
**Status:** 🟡 Design Doc Exists (`PANZERFEST.md`)

**Description:**
Kill streak triggers "everyone vs one" hunting mode.

**How it works:**
- Player gets 10-kill streak (configurable via `g_panzerfestKills`)
- All other players switch to opposing team to hunt them
- Target gets 4x fire rate boost for 30 seconds
- Gradual fire rate slowdown after boost period
- Mode ends on target death or timeout
- 60-second cooldown before next trigger

**Lua implementation path:**
- Track kills in `et_Obituary`
- Team swap via `et.trap_SendConsoleCommand`
- Fire rate modification via entity manipulation
- Timer management in `et_RunFrame`

---

### 7. Live Uniform Stealing (Covert Ops)
**Method:** C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Covert Ops can steal uniforms from living enemies by approaching from behind.

**How it works:**
- Covert Ops sneaks behind enemy
- Must maintain rear position for ~2 seconds
- Successfully steals uniform without killing enemy
- More tactical than killing for uniform

---

### 8. Class Stealing
**Method:** C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Stand over dead teammate and hold activate to take their class.

**How it works:**
- Approach dead teammate's body
- Hold activate key
- Lose current class abilities/weapons
- Gain dead teammate's class and primary weapon (empty magazine)
- Must find ammo for new weapon

---

### 9. Playdead
**Method:** C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Fake death to avoid enemy detection.

**How it works:**
- Activate playdead command
- Player falls into death pose
- Hitbox adjusts to prone position
- Cannot move or attack while playing dead
- Enemy may walk past thinking you're dead

---

### 10. M97 Shotgun
**Method:** C Mod
**Difficulty:** Hard
**Status:** ❌ Not Started

**Description:**
Pump-action 6-shot shotgun available to all classes except Covert Ops.

**How it works:**
- Winchester M1897 pump-action shotgun
- 6-round capacity
- Unique reload: shells loaded one at a time, can interrupt
- Extremely effective in close quarters
- Balanced fire rate (configurable)

**JayMod CVARs:**
- `team_maxM97s` - Limit per team
- Fire rate configuration

---

## 🟢 LOW PRIORITY FEATURES

### 11. Custom Hitsounds
**Method:** Lua
**Difficulty:** Easy
**Status:** ❌ Not Started

**Description:**
Different sounds play for different hit locations.

**Sound categories:**
- Head hit
- Body/torso hit
- Limb hit (arms/legs)
- Friendly fire (different tone)

**Lua implementation:**
- Hook into damage events
- Play appropriate sound based on hit location
- Client-side preference CVAR

---

### 12. Killstreak Announcements
**Method:** Lua
**Difficulty:** Easy
**Status:** ❌ Not Started

**Description:**
Unreal Tournament-style announcements for kill streaks.

**Announcements:**
- "Killing Spree" (5 kills)
- "Rampage" (10 kills)
- "Dominating" (15 kills)
- "Unstoppable" (20 kills)
- "Godlike" (25 kills)

**Lua implementation:**
- Track kills per player in `et_Obituary`
- Reset on death
- Play sound/show message at thresholds

---

### 13. Custom XP Thresholds
**Method:** Lua or C Mod
**Difficulty:** Easy-Medium
**Status:** ❌ Not Started

**Description:**
Per-class skill level XP requirements.

**JayMod CVARs:**
- `g_levels_medic` - Medic XP thresholds
- `g_levels_engineer` - Engineer XP thresholds
- `g_levels_fieldops` - Field Ops XP thresholds
- `g_levels_covertops` - Covert Ops XP thresholds
- `g_levels_soldier` - Soldier XP thresholds

---

### 14. XP-Based Team Shuffle
**Method:** Lua
**Difficulty:** Easy
**Status:** ❌ Not Started

**Description:**
Admin command to shuffle teams balanced by total XP.

**Implementation:**
- `!shuffle` command
- Calculate total XP per player
- Redistribute to balance team XP totals

---

### 15. Fine-Grained Weapon Limits
**Method:** Lua or C Mod
**Difficulty:** Medium
**Status:** ❌ Not Started

**Description:**
Per-weapon limits instead of just per-class.

**JayMod CVARs:**
- `team_maxPanzers`
- `team_maxFlamers`
- `team_maxMG42s`
- `team_maxMortars`
- `team_maxGrenLaunchers`

---

### 16. Double Jump (Enhanced)
**Method:** Already in ET:Legacy
**Difficulty:** N/A
**Status:** ✅ Available via `g_misc` flag 2

**Note:** ET:Legacy already has this! Enable with:
```
set g_misc "2"  // or add 2 to existing flags
```

---

### 17. Extended Adrenaline Duration
**Method:** Lua or C Mod
**Difficulty:** Easy
**Status:** ❌ Not Started

**Description:**
Allow adrenaline to last longer than default 10 seconds.

**JayMod CVAR:**
- `g_adrenalineTime 999` - Duration in seconds

---

## Already Available in ET:Legacy

These features exist natively - no porting needed:

| Feature | How to Enable |
|---------|---------------|
| Double Jump | `g_misc` flag 2 |
| Unlimited Sprint | `g_misc` flag 8 |
| Panzer War | `g_misc` flag 32 |
| Shove | `g_misc` flag 1 |
| No Fall Damage | `g_misc` flag 4 |
| No Self Damage | `g_misc` flag 16 |
| Adrenaline (self) | Native medic skill |
| Lua Scripting | `lua_modules` CVAR |

---

## Implementation Notes

### C Mod Workflow
1. Modify source in `~/projects/et/etlegacy/src/`
2. Build with `./scripts/build-all.sh`
3. Deploy with `./scripts/publish.sh`
4. Test on server

### Lua Workflow
1. Edit scripts in `~/projects/et/etlegacy/lua/`
2. Deploy with `./scripts/publish.sh`
3. Restart server or use `/lua_reload`

### Testing
- Local server: `~/etlegacy/`
- Production VPS: `et.etman.dev:27960`
- Always test locally first!

---

## References

- [JayMod GitHub](https://github.com/budjb/jaymod)
- [JayMod Documentation](https://jaymod.clanfu.org/)
- [ET:Legacy Lua API](https://legacy.etlegacy.com/docs/lua/)
- [ET:Legacy GitHub](https://github.com/etlegacy/etlegacy)
- Local JayMod source: `~/projects/et/jaymod/`
