# Firing Rate Bug Investigation

**Date:** 2025-12-28
**Issue:** Kill streak firing rate bonus only works for first 2 rockets, then reverts to default

## Problem Summary

When a player gets kills, they should get progressively faster firing rate (up to 7x at level 6). However:
- First 2 rockets fire at the correct faster rate
- Then it drops back to default firing rate
- Releasing and re-pressing fire causes same pattern: 2 fast, then slow
- This happens at ALL levels, including panzerfest mode (which forces 7x rate)

The survival mode SPEED bonus works perfectly (same Lua code pattern), but firing rate does not.

## Previous Fix Attempts

From memory: "server-authoritative-fire-rate-fix-dec2024" - Attempted to rewrite fire rate handling to be server-authoritative like JayMod. Incomplete information on what was tried.

---

# PART 1: JayMod Implementation Analysis

## 1.1 fireRateMultiplier Definition

**Search Term:** `fireRateMultiplier`

### Findings:

**Location:** `src/bgame/bg_public.h:718` (inside `pmoveExt_t` struct)

```c
// Kill streak fire rate multiplier (1.0 = normal, <1.0 = faster, >1.0 = slower for bots)
float       fireRateMultiplier;
// Kill streak bonus level (0-6, for HUD display)
int         killStreakBonusLevel;
```

The `pmoveExt_t` struct also contains:
- `panzerfestMultiplier` (float) - for panzerfest phases
- `panzerfestDelay` (int) - for panzerfest slowdown
- `movementMultiplier` (float) - for survival speed bonus
- `survivalBonusLevel` (int) - for HUD display

**Key insight:** `pmoveExt_t` is NOT networked - it's set separately on server and client!

---

## 1.2 addTime / weaponTime in bg_pmove

**Search Term:** `addTime` in bg_pmove context

### Findings:

**Location:** `src/bgame/bg_pmove.cpp:5198-5210`

```cpp
// Kill streak/Bot: Apply fire rate multiplier to ALL weapons
// fireRateMultiplier < 1.0 = faster (kill streak bonus)
// fireRateMultiplier > 1.0 = slower (bot penalty)
// fireRateMultiplier = 1.0 = normal
if (pm->pmext->fireRateMultiplier != 1.0f && pm->pmext->fireRateMultiplier > 0.0f) {
    addTime = (int)(addTime * pm->pmext->fireRateMultiplier);
    if (addTime < 50) addTime = 50; // Minimum 50ms between shots
}

pm->ps->weaponTime += addTime;
```

**Key insight:** The check `fireRateMultiplier > 0.0f` means if it's 0, the multiplier is NOT applied. This is intentional - client initializes to 0 (via memset), so client prediction does NOT apply the multiplier!

---

## 1.3 STAT_KILLSTREAK and Bonus Functions

**Search Term:** `STAT_KILLSTREAK`, `killStreakBonus`, `G_BonusGetFireRateMultiplier`

### Findings:

**Definition:** `src/bgame/bg_public.h:817`
```cpp
STAT_KILLSTREAK_BONUS,  // Kill streak fire rate bonus level (0-6)
```

**G_BonusGetFireRateMultiplier:** `src/game/g_survival.cpp:335-382`
```cpp
float G_BonusGetFireRateMultiplier( int clientNum ) {
    // ... validation ...

    // Check if this is a bot - bots fire slower
    if ( ent->r.svFlags & SVF_BOT ) {
        return cvars::bg_botFireRateMultiplier.fvalue;
    }

    // If kill streak system is disabled, no bonus
    if ( !cvars::bg_killStreakEnabled.ivalue ) {
        return 1.0f;
    }

    // If panzerfest target, return 1.0 (no kill streak bonus)
    if ( level.panzerfest.active && clientNum == level.panzerfest.targetClientNum ) {
        return 1.0f;
    }

    bonusLevel = ent->client->killStreakBonusLevel;

    // At max bonus (6), fire rate is 1/7 of default (7x faster)
    // multiplier = 1 / (1 + bonusLevel)
    multiplier = 1.0f / (float)( 1 + bonusLevel );

    return multiplier;
}
```

**Server sets STAT:** `src/game/g_active.cpp:1508`
```cpp
client->ps.stats[STAT_KILLSTREAK_BONUS] = ent->client->killStreakBonusLevel;
```

This stat IS networked to client and used for HUD display (`cg_draw.cpp:1616`).

---

## 1.4 pmext Struct and Server/Client Setting

**Search Term:** `pmext`, `pmoveExt_t`

### Findings:

#### SERVER-SIDE (g_active.cpp:1501-1508):
```cpp
// Panzerfest: Set fire rate multiplier and delay for this client
client->pmext.panzerfestMultiplier = G_PanzerfestGetFireRateMultiplier( ent - g_entities );
client->pmext.panzerfestDelay = G_PanzerfestGetFireRateDelay( ent - g_entities );

// Kill streak fire rate multiplier (or bot slow-down)
client->pmext.fireRateMultiplier = G_BonusGetFireRateMultiplier( ent - g_entities );
client->pmext.killStreakBonusLevel = ent->client->killStreakBonusLevel;
client->ps.stats[STAT_KILLSTREAK_BONUS] = ent->client->killStreakBonusLevel;
```

#### CLIENT-SIDE (cg_playerstate.cpp:244):
```cpp
// clear pmext
memset( &cg.pmext, 0, sizeof(cg.pmext) );
```

**CRITICAL FINDING:** On client, `fireRateMultiplier` is initialized to 0.0f (via memset), and **NEVER set to a meaningful value**!

#### Client Prediction (cg_predict.cpp):
- Line 936: `pmoveExt_t pmext;` - local variable declared (uninitialized, becomes 0 from stack in debug builds)
- Line 991: `cg_pmove.pmext = &pmext;` - uses local pmext
- Line 1042: `memcpy(&oldpmext[current & CMD_MASK], &cg.pmext, sizeof(pmoveExt_t));` - saves cg.pmext
- Line 1282: `memcpy(&pmext, &oldpmext[cmdNum & CMD_MASK], sizeof(pmoveExt_t));` - restores from saved
- Line 1378: `memcpy( &cg.pmext, &pmext, sizeof(pmoveExt_t) );` - copies back to cg.pmext

**BUT:** The saved `cg.pmext.fireRateMultiplier` is always 0.0f! So client prediction sees 0.0f, which makes `fireRateMultiplier > 0.0f` FALSE, so no multiplier is applied!

---

## 1.5 CVAR Syncing (CS_JAYMODINFO)

**Search Term:** `CS_JAYMODINFO`

### Findings:

**Definition:** `src/bgame/bg_public.h:381`
```cpp
#define CS_JAYMODINFO  40
```

Used to sync server CVARs to clients via configstring. The client reads this in `cg_servercmds.cpp:240` and `cg_main.cpp:2948`.

**However:** `fireRateMultiplier` is NOT synced via CS_JAYMODINFO. Instead:
- Server calculates it per-frame in g_active.cpp
- Server sets `client->pmext.fireRateMultiplier` before calling Pmove()
- Client does NOT have access to this value!

---

## 1.6 Client Prediction - THE KEY INSIGHT

**Search Term:** `cg_predict`, prediction in context of weaponTime

### Findings:

JayMod's approach is **SERVER-AUTHORITATIVE for fire rate**:

1. **Server** sets `client->pmext.fireRateMultiplier` before Pmove() (g_active.cpp:1506)
2. **Server** runs Pmove() which applies the multiplier to `addTime`
3. **Server** sends `ps->weaponTime` to client (this IS networked)
4. **Client** runs Pmove() but with `fireRateMultiplier = 0.0f`
5. **Client prediction** calculates a DIFFERENT weaponTime (no multiplier)
6. When server's weaponTime arrives, client sees discrepancy
7. Client **snaps to server's value** on next snapshot

**Why "2 fast then slow" pattern:**
- Shot 1: Client predicts normal time, server sends fast time → client snaps to fast
- Shot 2: Client still has snapshot's fast weaponTime → fires fast
- Shot 3+: Client prediction adds full addTime (no multiplier), pulls away from server
- The prediction error causes "stuttering" between server's fast rate and client's slow rate

**JayMod works because:**
- Server is authoritative on weaponTime
- Client prediction is "wrong" but gets corrected by snapshots
- The prediction mismatch causes some jitter but ultimately server wins

---

## 1.7 ammoTable Modifications

**Search Term:** `ammoTableMP`, `ammoTable`

### Findings:

JayMod has `bg_jaymod.cpp` with ammoTable modifications, but these are for weapon stats, not fire rate multiplier. The fire rate multiplier is applied AFTER reading base `addTime` from the ammo table.

---

# PART 2: ET:Legacy Implementation Analysis

## 2.1 Current Fire Rate Code

### Findings:

**bg_pmove.c:4196-4202:**
```c
if (pm->pmext && pm->pmext->fireRateMultiplier > 0.0f && pm->pmext->fireRateMultiplier != 1.0f)
{
    addTime = (int)(addTime * pm->pmext->fireRateMultiplier);
    if (addTime < 50)  // Minimum 50ms between shots to prevent overflow
    {
        addTime = 50;
    }
}
```

Same pattern as JayMod - check for `> 0.0f` and `!= 1.0f`.

**g_active.c:649-659 and 1617-1630 (both SpectatorThink and ClientThink_real):**
```c
// rickrollFireRateMultiplier: 100 = normal, 200 = 2x faster, 700 = 7x faster
// ALSO sync to ps.stats[STAT_FIRERATE_MUL] so client can match for prediction!
if (client->rickrollFireRateMultiplier > 0 && client->rickrollFireRateMultiplier != 100)
{
    client->pmext.fireRateMultiplier = 100.0f / (float)client->rickrollFireRateMultiplier;
    client->ps.stats[STAT_FIRERATE_MUL] = client->rickrollFireRateMultiplier;
}
else
{
    client->pmext.fireRateMultiplier = 1.0f;
    client->ps.stats[STAT_FIRERATE_MUL] = 100;
}
client->pmext.fireRateDelay = client->rickrollFireRateDelay;
```

**Key difference from JayMod:** ET:Legacy syncs the multiplier via `STAT_FIRERATE_MUL`!

---

## 2.2 pmext Handling

### Findings:

**pmoveExt_t in bg_public.h:600:**
```c
float fireRateMultiplier;      ///< Fire rate multiplier (1.0 = normal, 0.5 = 2x faster, 0.14 = 7x faster)
```

**STAT_FIRERATE_MUL in bg_public.h:716:**
```c
STAT_FIRERATE_MUL              ///< ETMan: fire rate multiplier (100 = normal, 200 = 2x faster, etc.)
```

So server stores integer (100=normal, 200=2x faster) in stats[], and converts to float multiplier.

---

## 2.3 Client Prediction

### Findings:

**cg_predict.c:1123-1137 (at start of prediction):**
```c
// ETMan: Read fire rate from playerState stats (synced from server)
// This ensures client prediction uses SAME fire rate as server!
// STAT_FIRERATE_MUL: 100 = normal, 200 = 2x faster, 700 = 7x faster
{
    int fireRateMul = cg.snap->ps.stats[STAT_FIRERATE_MUL];
    if (fireRateMul > 0 && fireRateMul != 100)
    {
        cg.pmext.fireRateMultiplier = 100.0f / (float)fireRateMul;
    }
    else
    {
        cg.pmext.fireRateMultiplier = 1.0f;
    }
    cg.pmext.fireRateDelay = 0;
}
```

**cg_predict.c:1444-1457 (inside prediction loop):**
```c
// ETMan: Read fire rate from playerState stats (synced from server)
// This ensures client prediction uses SAME fire rate as server!
{
    int fireRateMul = cg_pmove.ps->stats[STAT_FIRERATE_MUL];
    if (fireRateMul > 0 && fireRateMul != 100)
    {
        pmext.fireRateMultiplier = 100.0f / (float)fireRateMul;
    }
    else
    {
        pmext.fireRateMultiplier = 1.0f;
    }
    pmext.fireRateDelay = 0;
}
```

**This looks correct!** The client IS reading STAT_FIRERATE_MUL and setting fireRateMultiplier...

---

# PART 3: Comparison and Root Cause

## 3.1 Key Differences

| Aspect | JayMod | ET:Legacy | Issue? |
|--------|--------|-----------|--------|
| Server sets pmext.fireRateMultiplier | YES (g_active.cpp:1506) | YES (g_active.c:651) | No |
| Server syncs to playerState | NO (just pmext) | YES (STAT_FIRERATE_MUL) | Should help! |
| Client reads from stats | NO | YES (cg_predict.c:1127) | Should work! |
| Client sets pmext.fireRateMultiplier | NO (stays 0.0f) | YES (cg_predict.c:1130) | Should work! |
| bg_pmove applies multiplier | YES (>0 && !=1) | YES (same check) | Same |

## 3.2 Root Cause Analysis

**The ET:Legacy implementation LOOKS correct, but the bug persists. Let me dig deeper...**

Possible issues:
1. **Timing of STAT_FIRERATE_MUL update** - Is the stat being set BEFORE Pmove() on server?
2. **Snapshot timing** - Is the stat arriving in time for client prediction?
3. **Prediction loop issue** - Is the pmext being overwritten during the loop?
4. **oldpmext restoration** - Is the saved pmext overwriting the fresh calculation?

Let me check the prediction loop more carefully...

**AHA! Line 1442:**
```c
Com_Memcpy(&pmext, &oldpmext[cmdNum & cg.cmdMask], sizeof(pmoveExt_t));
```

This RESTORES pmext from `oldpmext[]`, which was saved BEFORE we set fireRateMultiplier!

Then at line 1450 we set `pmext.fireRateMultiplier`... but this is AFTER the restore, so it should work.

**WAIT - look at the order:**
1. Line 1442: Restore pmext from oldpmext (contains OLD values)
2. Line 1447-1456: Set fireRateMultiplier from stats (OVERWRITES with correct value)
3. Line 1467: Run Pmove() - should have correct value

This should work... unless the STAT is not being updated correctly on server.

**Let me check if STAT_FIRERATE_MUL persists across Pmove:**
- Server sets `client->ps.stats[STAT_FIRERATE_MUL]` in g_active.c
- Then calls Pmove()
- Does Pmove modify stats[]?

Need to check if bg_pmove.c modifies stats[STAT_FIRERATE_MUL]...

---

## 3.3 POTENTIAL ROOT CAUSE IDENTIFIED

**Issue:** The `oldpmext[]` array is restored BEFORE setting fireRateMultiplier at line 1442.

BUT there's a subtle bug in the optimized prediction path!

Looking at line 1461:
```c
if (cg_optimizePrediction.integer)
{
    // if we need to predict this command, or we've run out of space in the saved states queue
    if (cmdNum >= predictCmd || (stateIndex + 1) % MAX_BACKUP_STATES == cg.backupStateTop)
    {
        // run the Pmove
        Pmove(&cg_pmove);
```

When `cg_optimizePrediction` is ON and we're replaying old commands (not predicting new ones), we might skip the Pmove entirely and use cached states!

**The issue:** When replaying from backup states, the backup states were saved with OLD weaponTime values calculated with OLD fireRateMultiplier. The fireRateMultiplier correction at line 1450 only affects NEW predictions!

**Need to investigate:**
1. What happens when `cmdNum < predictCmd`? (replaying cached states)
2. Are backup states saved AFTER Pmove runs?
3. Does the backup state include the modified weaponTime?

---

## 3.3 Recommended Fix

**(Investigation ongoing - need to trace through optimized prediction code)**

Potential fixes:
1. **Disable cg_optimizePrediction** - Test if bug disappears
2. **Force prediction recalculation** when STAT_FIRERATE_MUL changes
3. **Invalidate backup states** when fire rate changes
4. **Server-authoritative approach** - Don't try to match on client at all (like JayMod)

---

# PART 4: Deeper Dive - Prediction Optimization Analysis

## 4.1 Stats Array and STAT_FIRERATE_MUL

**MAX_STATS:** 16 (defined in `q_shared.h:1242`)

**STAT_FIRERATE_MUL:** Index 10 in statIndex_t enum (within bounds)

**statIndex_t enum (bg_public.h:704-717):**
```c
typedef enum
{
    STAT_HEALTH = 0,       // 0
    STAT_KEYS,             // 1
    STAT_DEAD_YAW,         // 2
    STAT_MAX_HEALTH,       // 3
    STAT_PLAYER_CLASS,     // 4
    STAT_XP,               // 5
    STAT_PS_FLAGS,         // 6
    STAT_AIRLEFT,          // 7
    STAT_SPRINTTIME,       // 8
    STAT_ANTIWARP_DELAY,   // 9
    STAT_FIRERATE_MUL      // 10  <-- Our new stat
} statIndex_t;
```

## 4.2 CG_PredictionOk - Mismatch Detection

**Location:** `cg_predict.c:753-930`

This function compares predicted playerState vs server snapshot to detect prediction errors.

**Key checks:**
- Line 784-791: `weaponTime` mismatch → error code 5 (forces full re-predict)
- Line 863-873: `stats[]` mismatch (except STAT_ANTIWARP_DELAY) → error code 19

**Important:** When STAT_FIRERATE_MUL changes, it SHOULD trigger error 19 and force re-prediction!

## 4.3 Backup State Flow

**When backup states are saved (cg_predict.c:1479):**
```c
cg.backupStates[stateIndex] = *cg_pmove.ps;  // After Pmove() runs
```

**When backup states are restored:**
1. Line 1258: `*cg_pmove.ps = cg.backupStates[i];` (when finding matching state)
2. Line 1495: `*cg_pmove.ps = cg.backupStates[stateIndex];` (when replaying)

## 4.4 Key Observation: Playback Branch Skips Pmove

**The playback path (lines 1484-1499):**
```c
else
{
    numPlayedBack++; // debug code

    // play back the command from the saved states
    *cg_pmove.ps = cg.backupStates[stateIndex];

    // go to the next element in the saved states array
    stateIndex = (stateIndex + 1) % MAX_BACKUP_STATES;
}
```

When replaying from backup:
1. We set `pmext.fireRateMultiplier` at line 1450 (correct value)
2. **BUT we never run Pmove()** in this branch!
3. The playerState is restored directly from backup
4. The pmext change has NO EFFECT

**This is BY DESIGN** - backup states should already have correct weaponTime.

## 4.5 The Real Problem - Timing of Stats Changes

**Scenario that causes the bug:**

Frame 1:
- Server: Player has 0 kills, STAT_FIRERATE_MUL = 100
- Pmove runs with fireRateMultiplier = 1.0
- weaponTime = 4000 (default panzer reload)
- Backup saved with weaponTime = 4000, STAT_FIRERATE_MUL = 100

Frame 2:
- Server: Player gets kill, STAT_FIRERATE_MUL = 200
- NEW snapshot arrives with updated stats
- CG_PredictionOk compares backup (100) vs snapshot (200)
- **Mismatch detected!** Error 19 → full re-predict
- Pmove runs with fireRateMultiplier = 0.5
- weaponTime = 2000 (fast!)
- This works correctly!

Frame 3+:
- No new snapshot yet
- cg_optimizePrediction replays from backup
- Backup has weaponTime from Frame 2 (correct!)
- No Pmove needed, just restore

**SO WHY DOES IT BREAK?**

The bug description says "first 2 shots are fast, then slow". This suggests:
1. First shot: Correct (server authoritative)
2. Second shot: Correct (backup state from Frame 2)
3. Third shot onwards: WRONG

**Hypothesis:** The backup state system might be getting corrupted, or there's a timing issue where the STAT update isn't propagated correctly to all backup states.

---

# PART 5: Critical Discovery - The Bug Location

## 5.1 The Two Paths Through Prediction

**Path A: New Snapshot Arrives**
1. Line 1179: `cg.predictedPlayerState = cg.snap->ps` (copy from snapshot)
2. Line 1230+: If `cg.physicsTime != cg.lastPhysicsTime` (new snapshot)
3. Line 1237-1269: Loop through backup states looking for match
4. Line 1242: `CG_PredictionOk(&cg.predictedPlayerState, &cg.backupStates[i])`
   - This compares SNAPSHOT state vs OLD backup
   - Line 865: Compares `stats[]` (except STAT_ANTIWARP_DELAY)
   - If stats differ → returns error 19 → full re-predict
5. If backup matches, line 1258: `*cg_pmove.ps = cg.backupStates[i]`
   - **BUG?: This copies OLD stats into cg_pmove.ps!**

**Path B: Same Snapshot, Incremental Predict**
1. Line 1217: `cg.physicsTime == cg.lastPhysicsTime`
2. Line 1219: `predictCmd = cg.lastPredictedCommand + 1`
3. Skip the backup state matching
4. Just predict the newest command

## 5.2 The Actual Bug (FINALLY FOUND!)

**The issue is at line 1258:**
```c
*cg_pmove.ps = cg.backupStates[i];
```

When a new snapshot arrives and we find a "matching" backup state:
1. `cg.predictedPlayerState` has NEW `stats[STAT_FIRERATE_MUL] = 200` (from snapshot)
2. We find backup state `i` that "matches" (commandTime matches)
3. `CG_PredictionOk` says it's OK (maybe stats comparison is broken?)
4. **Line 1258 overwrites `*cg_pmove.ps`** with the backup state!
5. Now `cg_pmove.ps->stats[STAT_FIRERATE_MUL] = 100` (OLD value!)
6. Later at line 1447, we read this OLD value
7. Fire rate prediction is WRONG

**Why "2 fast then slow":**
- Shot 1: Server sends correct fast weaponTime → client snaps to it
- Shot 2: Still using server's value from snapshot → fires fast
- Shot 3: Client runs prediction with OLD fireRateMultiplier → slow
- Shot 4+: Same pattern - prediction calculates wrong, server corrects

## 5.3 Why CG_PredictionOk Doesn't Catch It

Looking more carefully at the flow:

1. `CG_PredictionOk(&cg.predictedPlayerState, &cg.backupStates[i])`
   - `ps1 = cg.predictedPlayerState` (NEW from snapshot)
   - `ps2 = cg.backupStates[i]` (OLD prediction)

2. At line 865:
   ```c
   if (ps2->stats[i] != ps1->stats[i] && i != STAT_ANTIWARP_DELAY)
   ```

**This SHOULD detect the mismatch!** If ps1 has 200 and ps2 has 100, it should return 19.

**Possible reasons it's not working:**
1. The backup state's commandTime doesn't match → no backup state found → full re-predict (should be OK)
2. The backup state IS found and stats DO match (timing issue - Lua sets it late?)
3. Some other code path is bypassing this check

## 5.4 The Lua Timing Hypothesis

**JayMod vs ET:Legacy difference:**

**JayMod (C-only):**
- g_survival.cpp computes fire rate in C
- g_active.cpp calls `G_BonusGetFireRateMultiplier()` EVERY frame BEFORE Pmove
- Fire rate is always up-to-date when Pmove runs

**ET:Legacy (Lua-based):**
- Lua script sets `rickrollFireRateMultiplier` via `et.gentity_set()`
- g_active.c reads this value and sets `client->ps.stats[STAT_FIRERATE_MUL]`
- But when does Lua run relative to g_active.c?

**Lua hooks execute at specific times:**
- `et_RunFrame()` - end of each server frame
- `et_Obituary()` - on kill

If `et_Obituary()` sets the fire rate, but that runs AFTER g_active.c has already processed the player... the new fire rate won't be in the current snapshot!

**The timeline:**
1. Server frame N: Player fires, kills enemy
2. g_active.c runs: reads `rickrollFireRateMultiplier = 100` (old)
3. Sets `stats[STAT_FIRERATE_MUL] = 100` (old)
4. Pmove runs
5. Snapshot built with old fire rate
6. Lua `et_Obituary()` runs: sets `rickrollFireRateMultiplier = 200` (new!)
7. Server frame N ends

8. Server frame N+1:
9. g_active.c runs: reads `rickrollFireRateMultiplier = 200` (new)
10. Sets `stats[STAT_FIRERATE_MUL] = 200` (new)
11. Pmove runs with correct fire rate
12. Snapshot built with new fire rate

**Client sees:**
- Snapshot N: old fire rate in stats, but server's weaponTime might already be fast?
- Snapshot N+1: new fire rate in stats

**This could explain the 2-shot delay!**

---

# ROOT CAUSE SUMMARY

## Primary Issue: Lua Timing
The Lua script sets `rickrollFireRateMultiplier` in `et_Obituary()`, which runs AFTER the current frame's Pmove has already executed. This means:
1. The kill happens in frame N
2. Frame N's Pmove uses OLD fire rate
3. Lua sets NEW fire rate
4. Frame N+1's Pmove uses NEW fire rate
5. There's a 1-frame delay before fire rate takes effect

## Secondary Issue: Backup State Stats Overwrite
When `*cg_pmove.ps = cg.backupStates[i]` runs, it overwrites the stats from the snapshot. If the stats ARE different, `CG_PredictionOk` should catch it, but if there's a timing issue where the backup and snapshot have the SAME stats (because Lua hasn't set it yet), the bug slips through.

---

# RECOMMENDED FIX

## Option 1: Move Fire Rate to C (Like JayMod)
- Implement `G_BonusGetFireRateMultiplier()` in C
- Call it from g_active.c BEFORE Pmove
- Remove Lua fire rate handling
- **Pros:** Consistent with JayMod, no timing issues
- **Cons:** Need to port kill streak tracking to C

## Option 2: Force Stats Update Before Pmove
- In g_active.c, after Lua hooks run, re-sync the fire rate
- Call the Lua function directly to get current fire rate before Pmove

## Option 3: Server-Only Fire Rate (Ignore Client Prediction)
- Don't sync STAT_FIRERATE_MUL to client
- Let server be authoritative on weaponTime
- Client will have prediction errors but server wins
- **Pros:** Simple, guaranteed to work
- **Cons:** Possible visual jitter on client

## Option 4: Immediate STAT Update in Lua
- Have Lua directly set `client.ps.stats[STAT_FIRERATE_MUL]`
- But this may not be possible via et.gentity_set()

---

# NEXT STEPS

1. **Add debug logging** on server to verify timing of fire rate changes
2. **Test with `cg_showmiss 8`** to see if stats mismatches are detected
3. **Test with `cg_optimizePrediction 0`** - eliminates backup state system
4. **Consider porting fire rate to pure C** like JayMod

---

# APPENDIX: Key Code Locations

## Server-Side
- `g_active.c:1616-1630` - Sets fireRateMultiplier and STAT before Pmove
- `lua/panzerfest_survival.lua:285` - Sets rickrollFireRateMultiplier on kill

## Client-Side
- `cg_predict.c:1127-1136` - Reads STAT_FIRERATE_MUL, sets pmext.fireRateMultiplier
- `cg_predict.c:1447-1456` - Same, inside prediction loop
- `cg_predict.c:1258` - Copies backup state (may overwrite stats)
- `cg_predict.c:865` - Stats mismatch detection

## Shared (bgame)
- `bg_pmove.c:4196-4202` - Applies fireRateMultiplier to addTime
- `bg_public.h:600` - pmoveExt_t.fireRateMultiplier definition
- `bg_public.h:716` - STAT_FIRERATE_MUL definition
