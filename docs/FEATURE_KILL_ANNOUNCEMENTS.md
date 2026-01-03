# Kill Announcements Feature Plan

**Date:** January 2025
**Status:** In Progress
**Author:** CandyPants + Claude

---

## Overview

This feature adds three related systems to the ET:Legacy server:
1. **Custom GreatShot Quick Chat** - Replaces the existing GreatShot voice chat with 11 varied sound clips
2. **Killing Spree Announcements** - Tracks consecutive kills per-life and plays sounds/messages at milestones
3. **Multi-Kill Announcements** - Tracks rapid kills within a time window and plays sounds

---

## 1. Custom GreatShot Voice Chat

### Requirements
- Replace the existing 2 GreatShot sounds with 11 custom sounds
- Both allies and axis use the SAME sounds (no team-specific voices needed)
- Sounds are randomly selected when the quick chat is triggered

### Sound Files
Source: `/home/andy/Desktop/ET/sound/chat/greatshot/`
Destination: `src/etmain/sound/chat/greatshot/`

| Filename | Text |
|----------|------|
| `amazingshot.wav` | "Amazing shot!" |
| `bangingshot.wav` | "Banging shot!" |
| `beautifulshot.wav` | "Beautiful shot!" |
| `excellentshot.wav` | "Excellent shot!" |
| `goodshotfella.wav` | "Good shot, fella!" |
| `greatshot01.wav` | "Oh, great shot, buddy!" |
| `impressive.wav` | "Impressive!" |
| `niceshot.wav` | "Nice shot!" |
| `verynice01.wav` | "Well that was very nice, indeed!" |
| `verynice02.wav` | "Very nice!" |
| `wonderfulshot.wav` | "Wonderful shot!" |

### Files to Modify
- `src/etmain/scripts/wm_allies_chat.voice` - Update GreatShot section
- `src/etmain/scripts/wm_axis_chat.voice` - Update GreatShot section

### Voice File Format
```
GreatShot
{
    sound/chat/greatshot/amazingshot.wav    "Amazing shot!"
    sound/chat/greatshot/bangingshot.wav    "Banging shot!"
    ... (etc)
}
```

---

## 2. Killing Spree System

### Requirements
- Track consecutive kills per-life (resets on death)
- Announce at specific milestones with sound + colorful chat message
- Message goes to ALL human players
- Uses existing EV_OBITUARY event to detect kills

### Milestones

| Kills | Level | Phrase | Sound File |
|-------|-------|--------|------------|
| 10 | 1 | Killing Spree | `killspree1.wav` |
| 20 | 2 | Rampage | `killspree2.wav` |
| 30 | 3 | Dominating | `killspree3.wav` |
| 40 | 4 | Unstoppable | `killspree4.wav` |
| 50 | 5 | Godlike | `killspree5.wav` |
| 100 | 6 | WICKED SICK | `killspree6.wav` |

### Sound Files
Source: `/home/andy/Desktop/ET/sound/killingspree/`
Destination: `src/etmain/sound/killingspree/`

### Implementation Details

#### Data Tracking (in `cg_t` struct)
```c
// Killing spree tracking
int killSpreeCount;           // Current consecutive kills
int killSpreeClientNum;       // Who has the spree (for announcements)
```

#### Detection Point
In `CG_Obituary()` in `cg_event.c`:
- When `attacker != target` and attacker is a valid player
- Increment spree count for attacker
- Reset spree count when a player dies

#### Chat Message Format
```
^1[KILLING SPREE] ^7PlayerName ^3is on a ^5KILLING SPREE! ^7(10 kills)
^1[KILLING SPREE] ^7PlayerName ^3is on a ^1RAMPAGE! ^7(20 kills)
^1[KILLING SPREE] ^7PlayerName ^3is ^6DOMINATING! ^7(30 kills)
^1[KILLING SPREE] ^7PlayerName ^3is ^4UNSTOPPABLE! ^7(40 kills)
^1[KILLING SPREE] ^7PlayerName ^3is ^2GODLIKE! ^7(50 kills)
^1[KILLING SPREE] ^7PlayerName ^3is ^5W^1I^3C^2K^6E^4D ^5S^1I^3C^2K! ^7(100 kills)
```

---

## 3. Multi-Kill System

### Requirements
- Track rapid kills within a 3-second window
- Each successive kill within the window increases the combo
- Sound plays ONLY to the player getting the kills (not broadcast)
- No chat message, just sounds
- Resets if 3 seconds pass without a kill

### Combo Levels

| Combo | Kills | Sound File | Notes |
|-------|-------|------------|-------|
| 2 | Double Kill | `doublekill.wav` | 2 kills within 3 sec |
| 3 | Triple Kill | `triplekill.wav` | 3 kills within 3 sec |
| 4 | Multi Kill | `multikill.wav` | 4 kills within 3 sec |
| 5 | Ultra Kill | `ultrakill.wav` | 5 kills within 3 sec |
| 6 | Monster Kill | `monsterkill.wav` | 6 kills within 3 sec |
| 7 | Ludicrous Kill | `ludicrouskill.wav` | 7 kills within 3 sec |
| 8+ | Holy Shit | `holyshit.wav` | 8+ kills within 3 sec |

### Sound Files
Source: `/home/andy/Desktop/ET/sound/multikill/`
Destination: `src/etmain/sound/multikill/`

### Implementation Details

#### Data Tracking (in `cg_t` struct)
```c
// Multi-kill tracking
int multiKillCount;           // Current rapid kill count
int multiKillLastTime;        // Time of last kill (for 3-second window)
```

#### Logic
```c
#define MULTIKILL_TIMEOUT 3000  // 3 seconds in milliseconds

void CG_CheckMultiKill(int killerNum) {
    if (killerNum != cg.clientNum) return;  // Only track for local player

    int currentTime = cg.time;

    if (currentTime - cg.multiKillLastTime <= MULTIKILL_TIMEOUT) {
        cg.multiKillCount++;
    } else {
        cg.multiKillCount = 1;  // First kill in new window
    }

    cg.multiKillLastTime = currentTime;

    if (cg.multiKillCount >= 2) {
        CG_PlayMultiKillSound(cg.multiKillCount);
    }
}
```

---

## File Changes Summary

### New Sound Files to Copy
```
src/etmain/sound/
├── chat/
│   └── greatshot/           # 11 files
│       ├── amazingshot.wav
│       ├── bangingshot.wav
│       ├── beautifulshot.wav
│       ├── excellentshot.wav
│       ├── goodshotfella.wav
│       ├── greatshot01.wav
│       ├── impressive.wav
│       ├── niceshot.wav
│       ├── verynice01.wav
│       ├── verynice02.wav
│       └── wonderfulshot.wav
├── killingspree/            # 6 files
│   ├── killspree1.wav
│   ├── killspree2.wav
│   ├── killspree3.wav
│   ├── killspree4.wav
│   ├── killspree5.wav
│   └── killspree6.wav
└── multikill/               # 7 files
    ├── doublekill.wav
    ├── triplekill.wav
    ├── multikill.wav
    ├── ultrakill.wav
    ├── monsterkill.wav
    ├── ludicrouskill.wav
    └── holyshit.wav
```

### Voice Scripts
- `src/etmain/scripts/wm_allies_chat.voice` - Update GreatShot
- `src/etmain/scripts/wm_axis_chat.voice` - Update GreatShot

### C Source Code
- `src/src/cgame/cg_local.h` - Add tracking variables to `cg_t` and sound handles to `cgMedia_t`
- `src/src/cgame/cg_event.c` - Modify `CG_Obituary()` to track kills and trigger announcements
- `src/src/cgame/cg_main.c` - Register new sounds in media loading

---

## Task Checklist

- [x] Copy greatshot sounds to `src/etmain/sound/chat/greatshot/`
- [x] Copy killingspree sounds to `src/etmain/sound/killingspree/`
- [x] Copy multikill sounds to `src/etmain/sound/multikill/`
- [x] Update `wm_allies_chat.voice` with new GreatShot entries
- [x] Update `wm_axis_chat.voice` with new GreatShot entries
- [x] Add tracking variables to `cg_t` in `cg_local.h`
- [x] Add sound handles to `cgMedia_t` in `cg_local.h`
- [x] Register sounds in `CG_RegisterSounds()` in `cg_main.c`
- [x] Implement killing spree detection in `CG_Obituary()`
- [x] Implement multi-kill detection in `CG_Obituary()`
- [x] Implement killing spree reset on death
- [x] Add helper functions for sound playback
- [x] Update build-all.sh to include sounds and voice scripts
- [ ] Build and test locally
- [ ] Deploy to VPS and test on server

---

## Notes

- Killing spree messages appear in chat (alongside Panzerfest messages)
- Multi-kill sounds are LOCAL only (not broadcast to all players)
- All sounds need to be included in the pk3 file for clients to download
- The `build-all.sh` script should automatically include `etmain/sound/` in the pk3

---

## Testing Checklist

1. [ ] Connect to server and verify sound downloads
2. [ ] Test GreatShot quick chat (V > 5 > 3) - should play random sound
3. [ ] Get 10 kills in a row - should hear "Killing Spree" and see chat message
4. [ ] Kill 2 players rapidly - should hear "Double Kill" (only you)
5. [ ] Kill 3+ players with one rocket - should skip to appropriate multi-kill level
6. [ ] Die and verify spree count resets
7. [ ] Verify killing spree messages visible to all players
8. [ ] Verify multi-kill sounds NOT heard by other players
