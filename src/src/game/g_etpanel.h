/*
 * ET:Legacy - ETMan ETPanel Stats Module
 * Copyright (C) 2024 ETMan
 *
 * Non-blocking HTTP stats reporting to ETPanel API.
 * Uses fork() + curl for fire-and-forget HTTP POST.
 */

#ifndef G_ETPANEL_H
#define G_ETPANEL_H

#include "g_local.h"

// CVARs for ETPanel configuration (same names as existing Lua config)
extern vmCvar_t etpanel_enabled;
extern vmCvar_t etpanel_api_url;
extern vmCvar_t etpanel_api_key;
extern vmCvar_t etpanel_debug;

// Initialize ETPanel system (call from G_InitGame)
void G_ETPanel_Init(void);

// Player events
void G_ETPanel_PlayerConnect(int clientNum, qboolean firstTime, qboolean isBot);
void G_ETPanel_PlayerDisconnect(int clientNum);
void G_ETPanel_PlayerBegin(int clientNum);

// Kill event
void G_ETPanel_Kill(int victim, int killer, int meansOfDeath);

// Round/map events
void G_ETPanel_RoundEnd(int winner);
void G_ETPanel_MapEnd(void);

// Chat event (optional)
void G_ETPanel_Chat(int clientNum, int mode, const char *message);

#endif // G_ETPANEL_H
