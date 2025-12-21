/*
 * Rick Roll Mode - Header
 *
 * Client-side declarations for Rick Roll Mode rendering
 *
 * Copyright (C) 2024 ETMan Server
 */

#ifndef CG_RICKROLL_H
#define CG_RICKROLL_H

// Initialize Rick Roll rendering system
void CG_RickRoll_Init(void);

// Handle server commands
void CG_RickRoll_Start(void);
void CG_RickRoll_Wheel1(void);
void CG_RickRoll_Wheel2(void);
void CG_RickRoll_Wheel3(void);
void CG_RickRoll_Result(void);
void CG_RickRoll_End(void);
void CG_RickRoll_Timer(void);
void CG_RickRoll_EffectEnd(void);

// Draw the Rick Roll overlay (call from CG_Draw2D)
void CG_RickRoll_Draw(void);

// Draw the effect timer HUD element
void CG_RickRoll_DrawTimer(void);

// Check if Rick Roll animation is currently active
qboolean CG_RickRoll_IsActive(void);

// Command hash values for server command parsing
// Generated with BG_StringHashValue()
#define RICKROLL_START_HASH     190698  // "rickroll_start"
#define RICKROLL_WHEEL1_HASH    193940  // "rickroll_wheel1"
#define RICKROLL_WHEEL2_HASH    194073  // "rickroll_wheel2"
#define RICKROLL_WHEEL3_HASH    194206  // "rickroll_wheel3"
#define RICKROLL_RESULT_HASH    205740  // "rickroll_result"
#define RICKROLL_END_HASH       158276  // "rickroll_end"
#define RICKROLL_TIMER_HASH     189000  // "rickroll_timer"
#define RICKROLL_EFFECT_END_HASH 254256 // "rickroll_effect_end"

#endif // CG_RICKROLL_H
