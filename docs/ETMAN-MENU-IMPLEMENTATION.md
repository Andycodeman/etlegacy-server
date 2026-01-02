# ETMan Menu System Implementation Plan

## Overview
Add ETMan features to the ET:Legacy UI with proper menu integration, browser URL opening, and improved user onboarding.

## Goals
1. Add "8. ETMan Sounds" to vsay quick message menus
2. Create ETMan main menu accessible from ESC menu (Voice, Sounds, Register, Website, Help)
3. Enable browser auto-open for registration with code in URL
4. Update welcome message to inform users about ETMan features

---

## Task 1: Add ETMan Sounds to Vsay Menus

### Files to Modify
- `src/etmain/ui/wm_quickmessageAlt.menu` (numbered version - primary)
- `src/etmain/ui/wm_quickmessage.menu` (letter version)

### Changes

**wm_quickmessageAlt.menu** - Add after line 89 (after "7. Objectives"):
```c
QM_MENU_ITEM( _("8. ETMan Sounds"), exec "soundmenu"; close wm_quickmessageAlt, "8", 7 )
```

**wm_quickmessage.menu** - Add after line 90 (after "O. Objectives"):
```c
QM_MENU_ITEM( _("E. ETMan Sounds"), exec "soundmenu"; close wm_quickmessage, "e", 7 )
```

### Notes
- The `soundmenu` command already exists in `cg_consolecmds.c:3488`
- Uses `QM_MENU_ITEM` (not `_TEAM`) since sounds are for everyone

---

## Task 2: Add CG_OPENURL Syscall to cgame

### Why Needed
- UI module has `trap_openURL()` via `UI_OPENURL` syscall
- cgame module does NOT have this - we need to add it
- Required for opening browser from registration flow

### Files to Modify

**src/src/cgame/cg_public.h** - Add to cgameImport_t enum (around line 200):
```c
CG_OPENURL,  // Open URL in system browser
```

**src/src/cgame/cg_syscalls.c** - Add new function:
```c
/**
 * @brief trap_OpenURL
 * @param[in] url
 */
void trap_OpenURL(const char *url)
{
    SystemCall(CG_OPENURL, url);
}
```

**src/src/cgame/cg_local.h** - Add declaration (around line 3500):
```c
void trap_OpenURL(const char *url);
```

**src/src/client/cl_cgame.c** - Add handler in CL_CgameSystemCalls():
```c
case CG_OPENURL:
    CL_OpenURL(VMA(1));
    return 0;
```

---

## Task 3: Modify Registration Flow

### Current Behavior
- `/etman register` sends request to server
- Server generates code, sends back `VOICE_RESP_REGISTER_CODE`
- Client displays message in console with code

### New Behavior
- Server sends back JUST the code (modify response format)
- Client receives code, constructs URL: `https://etpanel.etman.dev/register?code=XXXXXX`
- Client calls `trap_OpenURL()` to open browser
- Also displays message in console as backup

### Files to Modify

**src/src/cgame/cg_etman.c** - Modify VOICE_RESP_REGISTER_CODE handler (~line 1570):
```c
case VOICE_RESP_REGISTER_CODE:
{
    /* Registration code response - open browser with code */
    char url[256];
    char code[16];

    /* Message format from server: just the 6-char code */
    Q_strncpyz(code, message, sizeof(code));

    /* Construct URL with code */
    Com_sprintf(url, sizeof(url), "https://etpanel.etman.dev/register?code=%s", code);

    /* Open browser */
    trap_OpenURL(url);

    /* Also show in console as backup */
    CG_Printf("\n^2========================================\n");
    CG_Printf("^3Registration code: ^5%s\n", code);
    CG_Printf("^7Browser should open automatically.\n");
    CG_Printf("^7If not, visit: ^5%s\n", url);
    CG_Printf("^2========================================\n\n");
    break;
}
```

**etman-server/sound_manager.c** - Modify registration response (~line 1433):
```c
/* Send just the code, not the full message */
sendResponseToClient(clientId, VOICE_RESP_REGISTER_CODE, code);
```

### ETPanel Frontend
- Add `/register` route that reads `?code=XXX` query param
- Pre-fill the code field
- If user is logged in, auto-submit

---

## Task 4: Create ETMan Main Menu

### New Files to Create

**src/etmain/ui/etman_main.menu**:
```c
#include "ui/menudef.h"
#include "ui/menumacros.h"

#define WINDOW_X        16
#define WINDOW_Y        16
#define WINDOW_WIDTH    200
#define WINDOW_HEIGHT   176
#define GROUP_NAME      "grpETManMain"

menuDef {
    name        "etman_main"
    visible     0
    fullscreen  0
    rect        WINDOW_X WINDOW_Y WINDOW_WIDTH WINDOW_HEIGHT
    style       WINDOW_STYLE_FILLED

    onEsc {
        close etman_main ;
    }

    WINDOW( _("ETMAN"), 50 )

    BUTTONEXT( 6, 32, WINDOW_WIDTH-12, 18, _("VOICE SETTINGS"), .3, 14,
        close etman_main ; open options_voice,
        tooltip _("Configure voice chat settings") )

    BUTTONEXT( 6, 56, WINDOW_WIDTH-12, 18, _("SOUND MENU"), .3, 14,
        close etman_main ; exec "soundmenu",
        tooltip _("Open custom sounds menu") )

    BUTTONEXT( 6, 80, WINDOW_WIDTH-12, 18, _("REGISTER / LINK"), .3, 14,
        close etman_main ; exec "etman register",
        tooltip _("Link your account to ETPanel for custom sounds") )

    BUTTONEXT( 6, 104, WINDOW_WIDTH-12, 18, _("ETPANEL WEBSITE"), .3, 14,
        close etman_main ; uiScript validate_openURL "https://etpanel.etman.dev",
        tooltip _("Open ETPanel in your browser") )

    BUTTONEXT( 6, 128, WINDOW_WIDTH-12, 18, _("HELP"), .3, 14,
        close etman_main ; exec "etman help",
        tooltip _("Show ETMan commands help") )

    BUTTONEXT( 6, 152, WINDOW_WIDTH-12, 18, _("BACK"), .3, 14,
        close etman_main ; open ingame_main,
        tooltip _("Return to main menu") )
}
```

### Files to Modify

**src/etmain/ui/menus.txt** - Add after ingame menus (around line 92):
```c
loadMenu { "ui/etman_main.menu" }
```

**src/etmain/ui/ingame_main.menu** - Add ETMAN button (before DISCONNECT):
```c
BUTTONEXT( 6, 128, WINDOW_WIDTH-12, 18, _("ETMAN"), .3, 14,
    close ingame_main ; open etman_main,
    tooltip _("ETMan custom features - sounds, voice, registration") )
```

Note: This requires adjusting Y positions of DISCONNECT and EXIT buttons (shift down by 24).

---

## Task 5: Update Welcome Message

### File to Modify
**lua/main.lua** - Update et_ClientConnect (~line 399):

```lua
-- Welcome message for new human players
if firstTime == 1 and isBot == 0 then
    -- Delayed welcome message (after 2 seconds)
    et.trap_SendServerCommand(clientNum,
        'cp "^3Welcome to ETMan\'s Server!\n' ..
        '^7Press ^2V ^7then ^28 ^7for custom sounds\n' ..
        '^7Press ^2ESC ^7> ^2ETMAN ^7to register & more\n' ..
        '^5Visit: ^7etpanel.etman.dev"')

    -- Also show in console for reference
    et.trap_SendServerCommand(clientNum,
        'print "^3=== ETMan Custom Server ===\n' ..
        '^7Custom sounds: Press V then 8, or /etman\n' ..
        '^7Register: ESC > ETMAN > Register, or /etman register\n' ..
        '^7Website: https://etpanel.etman.dev\n' ..
        '^3=============================\n"')
end
```

---

## Build & Deploy Checklist

1. [ ] Modify vsay menus (wm_quickmessage.menu, wm_quickmessageAlt.menu)
2. [ ] Add CG_OPENURL syscall (cg_public.h, cg_syscalls.c, cg_local.h, cl_cgame.c)
3. [ ] Modify registration handler in cg_etman.c
4. [ ] Modify server response in etman-server/sound_manager.c
5. [ ] Create etman_main.menu
6. [ ] Update menus.txt to load etman_main.menu
7. [ ] Modify ingame_main.menu to add ETMAN button
8. [ ] Update welcome message in lua/main.lua
9. [ ] Build: `./scripts/build-all.sh`
10. [ ] Deploy: `./scripts/publish.sh`
11. [ ] Test on ETPanel: Add /register route with code param support

---

## Testing Plan

1. **Vsay Menu Test**
   - Press V → see "8. ETMan Sounds" option
   - Press 8 → sound menu opens

2. **ESC Menu Test**
   - Press ESC → see ETMAN button
   - Click ETMAN → ETMan menu opens
   - Test each button (Voice, Sounds, Register, Website, Help, Back)

3. **Registration Test**
   - Type `/etman register` or use menu
   - Browser should open to `etpanel.etman.dev/register?code=XXXXXX`
   - Code should be pre-filled

4. **Welcome Message Test**
   - Connect to server
   - See welcome message with instructions
   - Verify console also shows info

---

## Files Summary

### Modified Files
- `src/etmain/ui/wm_quickmessage.menu`
- `src/etmain/ui/wm_quickmessageAlt.menu`
- `src/etmain/ui/ingame_main.menu`
- `src/etmain/ui/menus.txt`
- `src/src/cgame/cg_public.h`
- `src/src/cgame/cg_syscalls.c`
- `src/src/cgame/cg_local.h`
- `src/src/client/cl_cgame.c`
- `src/src/cgame/cg_etman.c`
- `etman-server/sound_manager.c`
- `lua/main.lua`

### New Files
- `src/etmain/ui/etman_main.menu`
