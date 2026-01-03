/*
 * Rick Roll Mode - Client-side HUD rendering
 *
 * Displays animated Rick Astley sprite and spinning wheels
 * when rick roll event is triggered by server.
 *
 * Layout: Centered on screen (widescreen aware), Rick above wheels
 * Animation: Slide-through effect with rainbow title
 * Intro: Dramatic strobe effect synced to drum intro
 *
 * Copyright (C) 2024 ETMan Server
 */

#include "cg_local.h"

// External function for camera shake
extern void CG_StartShakeCamera(float param);

// Rick Roll state
typedef struct {
	qboolean    active;
	int         startTime;
	int         seed;
	int         phase;          // 0=intro, 1=spinning, 2=revealing, 3=result

	// Wheel data
	char        players[32][64];
	int         playerCount;
	char        effects[16][64];
	int         effectCount;
	char        intensities[8][64];
	int         intensityCount;

	// Results
	int         resultPlayer;
	char        resultPlayerName[64];
	char        resultEffect[64];
	char        resultIntensity[64];

	// Wheel animation state
	float       wheel1Offset;
	float       wheel2Offset;
	float       wheel3Offset;
	int         wheel1CurrentIdx;
	int         wheel2CurrentIdx;
	int         wheel3CurrentIdx;
	float       wheel1Speed;
	float       wheel2Speed;
	float       wheel3Speed;
	qboolean    wheel1Stopped;
	qboolean    wheel2Stopped;
	qboolean    wheel3Stopped;
	int         wheel1StopTime;
	int         wheel2StopTime;
	int         wheel3StopTime;

	// Celebration state
	qboolean    celebrationActive;
	int         celebrationStartTime;

	// Effect timer state
	qboolean    effectTimerActive;
	char        effectTimerName[64];
	char        effectDescription[128];
	int         effectTimerRemaining;
	int         effectTimerLastUpdate;

	// Effect ended notification
	qboolean    effectEndedActive;
	char        effectEndedName[64];
	int         effectEndedTime;

	// Frozen state during animation
	qboolean    playersFrozen;
} rickrollState_t;

// Confetti particle
typedef struct {
	float x, y;
	float vx, vy;
	vec4_t color;
	float size;
	qboolean active;
} confetti_t;

#define MAX_CONFETTI 150
static confetti_t confetti[MAX_CONFETTI];

static rickrollState_t rr;
static qhandle_t       rickShader = 0;
static qboolean        rickrollInitialized = qfalse;

// Configuration
#define RICK_FRAME_COUNT    20
#define RICK_FRAME_COLS     8
#define RICK_FRAME_ROWS     3
#define RICK_FRAME_TIME     100

// Layout dimensions
#define RICK_W              140.0f
#define RICK_H              105.0f

// Wheel dimensions - BIGGER
#define WHEEL_W             110.0f
#define WHEEL_H             60.0f
#define WHEEL_SPACING       15.0f
#define WHEEL_ITEM_H        50.0f

// Timing
#define INTRO_DURATION      1600    // Extended intro for strobe/pulse before graphic appears
#define WHEEL1_STOP_TIME    6800    // Adjusted for longer intro (was 6000 + 800)
#define WHEEL2_STOP_TIME    9800    // Adjusted for longer intro (was 9000 + 800)
#define WHEEL3_STOP_TIME    12800   // Adjusted for longer intro (was 12000 + 800)
#define ANIMATION_DURATION  18670   // Total stays the same - synced with music
#define CELEBRATION_DURATION 3000

// Animation speeds
#define WHEEL_FAST_SPEED    15.0f
#define WHEEL_SLOW_SPEED    3.0f

// Intro strobe timings (drum hits) - extended for longer intro
static const int strobeTimings[] = {
	0, 150, 300, 450, 500, 650, 750,
	900, 1050, 1200, 1350, 1500, 1650, 1800, -1
};

/*
 * Parse pipe-delimited string into array
 */
static int CG_RickRoll_ParseList(const char *str, char dest[][64], int maxItems) {
	int count = 0;
	const char *p = str;
	const char *start = str;

	while (*p && count < maxItems) {
		if (*p == '|') {
			int len = p - start;
			if (len > 63) len = 63;
			Q_strncpyz(dest[count], start, len + 1);
			count++;
			start = p + 1;
		}
		p++;
	}

	if (*start && count < maxItems) {
		Q_strncpyz(dest[count], start, 64);
		count++;
	}

	return count;
}

/*
 * Initialize confetti
 */
static void CG_RickRoll_InitConfetti(void) {
	int i;
	for (i = 0; i < MAX_CONFETTI; i++) {
		confetti[i].active = qfalse;
	}
}

/*
 * Spawn confetti across full widescreen
 */
static void CG_RickRoll_SpawnConfetti(void) {
	int i;
	float fullWidth = Ccg_WideX(SCREEN_WIDTH);

	for (i = 0; i < MAX_CONFETTI; i++) {
		confetti_t *p = &confetti[i];
		p->active = qtrue;
		p->x = (float)(rand() % (int)fullWidth);
		p->y = -20.0f - (rand() % 100);
		p->vx = (rand() % 200 - 100) / 50.0f;
		p->vy = 80.0f + (rand() % 120);
		p->size = 5.0f + (rand() % 10);

		switch (rand() % 6) {
			case 0: p->color[0] = 1.0f; p->color[1] = 0.2f; p->color[2] = 0.2f; break;
			case 1: p->color[0] = 1.0f; p->color[1] = 0.6f; p->color[2] = 0.0f; break;
			case 2: p->color[0] = 1.0f; p->color[1] = 1.0f; p->color[2] = 0.2f; break;
			case 3: p->color[0] = 0.2f; p->color[1] = 1.0f; p->color[2] = 0.2f; break;
			case 4: p->color[0] = 0.2f; p->color[1] = 0.6f; p->color[2] = 1.0f; break;
			case 5: p->color[0] = 0.8f; p->color[1] = 0.2f; p->color[2] = 1.0f; break;
		}
		p->color[3] = 1.0f;
	}
}

/*
 * Draw confetti
 */
static void CG_RickRoll_DrawConfetti(int elapsed) {
	int i;
	float dt = cg.frametime / 1000.0f;
	float fullWidth = Ccg_WideX(SCREEN_WIDTH);

	for (i = 0; i < MAX_CONFETTI; i++) {
		confetti_t *p = &confetti[i];
		if (!p->active) continue;

		p->x += p->vx * dt;
		p->y += p->vy * dt;
		p->vx += sin(elapsed / 200.0f + i) * 0.5f;

		if (p->y > SCREEN_HEIGHT - 100) {
			p->color[3] = (SCREEN_HEIGHT - p->y) / 100.0f;
		}

		if (p->y > SCREEN_HEIGHT + 20) {
			p->active = qfalse;
			continue;
		}

		CG_FillRect(p->x, p->y, p->size, p->size * 0.6f, p->color);
	}
}

/*
 * Initialize
 */
void CG_RickRoll_Init(void) {
	memset(&rr, 0, sizeof(rr));
	rickrollInitialized = qtrue;
	CG_RickRoll_InitConfetti();

	rickShader = trap_R_RegisterShaderNoMip("gfx/rickroll/rick_spritesheet");
	if (rickShader) {
		CG_Printf("^5[Rick Roll Mode] ^7Sprite sheet loaded\n");
	} else {
		CG_Printf("^5[Rick Roll Mode] ^3Warning: Sprite sheet not found\n");
	}
}

/*
 * Start animation
 */
void CG_RickRoll_Start(void) {
	const char *playersArg;
	const char *effectsArg;
	const char *intensitiesArg;

	memset(&rr, 0, sizeof(rr));

	rr.startTime = cg.time;
	rr.seed = atoi(CG_Argv(2));
	rr.playerCount = atoi(CG_Argv(3));
	rr.effectCount = atoi(CG_Argv(4));
	rr.intensityCount = atoi(CG_Argv(5));

	playersArg = CG_Argv(6);
	if (playersArg && playersArg[0]) {
		rr.playerCount = CG_RickRoll_ParseList(playersArg, rr.players, 32);
	}

	effectsArg = CG_Argv(7);
	if (effectsArg && effectsArg[0]) {
		rr.effectCount = CG_RickRoll_ParseList(effectsArg, rr.effects, 16);
	}

	intensitiesArg = CG_Argv(8);
	if (intensitiesArg && intensitiesArg[0]) {
		rr.intensityCount = CG_RickRoll_ParseList(intensitiesArg, rr.intensities, 8);
	}

	srand(rr.seed);
	rr.wheel1CurrentIdx = rand() % (rr.playerCount > 0 ? rr.playerCount : 1);
	rr.wheel2CurrentIdx = rand() % (rr.effectCount > 0 ? rr.effectCount : 1);
	rr.wheel3CurrentIdx = rand() % (rr.intensityCount > 0 ? rr.intensityCount : 1);

	rr.wheel1Speed = WHEEL_FAST_SPEED;
	rr.wheel2Speed = WHEEL_FAST_SPEED * 1.1f;
	rr.wheel3Speed = WHEEL_FAST_SPEED * 0.9f;

	rr.phase = 0;
	rr.active = qtrue;

	CG_Printf("^5[Rick Roll Mode] ^7Animation started!\n");
}

void CG_RickRoll_Wheel1(void) {
	Q_strncpyz(rr.resultPlayerName, CG_Argv(1), sizeof(rr.resultPlayerName));
	rr.wheel1Stopped = qtrue;
	rr.wheel1StopTime = cg.time;
}

void CG_RickRoll_Wheel2(void) {
	Q_strncpyz(rr.resultEffect, CG_Argv(1), sizeof(rr.resultEffect));
	rr.wheel2Stopped = qtrue;
	rr.wheel2StopTime = cg.time;
}

void CG_RickRoll_Wheel3(void) {
	Q_strncpyz(rr.resultIntensity, CG_Argv(1), sizeof(rr.resultIntensity));
	rr.wheel3Stopped = qtrue;
	rr.wheel3StopTime = cg.time;

	rr.celebrationActive = qtrue;
	rr.celebrationStartTime = cg.time;
	CG_RickRoll_SpawnConfetti();
}

void CG_RickRoll_Result(void) {
	rr.resultPlayer = atoi(CG_Argv(1));
	Q_strncpyz(rr.resultEffect, CG_Argv(2), sizeof(rr.resultEffect));
	Q_strncpyz(rr.resultIntensity, CG_Argv(3), sizeof(rr.resultIntensity));
	rr.phase = 3;
}

void CG_RickRoll_End(void) {
	rr.active = qfalse;
	rr.phase = 0;
	CG_Printf("^5[Rick Roll Mode] ^7Animation ended\n");
}

/*
 * Rainbow color
 */
static void CG_RickRoll_GetRainbowColor(int elapsed, float offset, vec4_t color) {
	float t = (float)elapsed / 500.0f + offset;
	float h = fmod(t, 1.0f);
	int hi = (int)(h * 6.0f) % 6;
	float f = h * 6.0f - (float)hi;
	float q = 1.0f - f;

	switch (hi) {
		case 0: color[0] = 1.0f; color[1] = f;    color[2] = 0.0f; break;
		case 1: color[0] = q;    color[1] = 1.0f; color[2] = 0.0f; break;
		case 2: color[0] = 0.0f; color[1] = 1.0f; color[2] = f;    break;
		case 3: color[0] = 0.0f; color[1] = q;    color[2] = 1.0f; break;
		case 4: color[0] = f;    color[1] = 0.0f; color[2] = 1.0f; break;
		case 5: color[0] = 1.0f; color[1] = 0.0f; color[2] = q;    break;
	}
	color[3] = 1.0f;
}

/*
 * Draw intro strobe - FULL SCREEN using proper widescreen coordinates
 */
static void CG_RickRoll_DrawIntro(int elapsed) {
	int i;
	float strobeIntensity = 0.0f;
	float fullWidth = Ccg_WideX(SCREEN_WIDTH);
	vec4_t strobeColor;
	vec4_t textColor;
	const char *text = "RICK ROLL!";
	float textWidth;
	float scale;
	float x;

	// Check strobe timing
	for (i = 0; strobeTimings[i] >= 0; i++) {
		int timeSinceHit = elapsed - strobeTimings[i];
		if (timeSinceHit >= 0 && timeSinceHit < 100) {
			float flash = 1.0f - (timeSinceHit / 100.0f);
			if (flash > strobeIntensity) {
				strobeIntensity = flash;
			}
		}
	}

	// Full-screen strobe - start at 0, cover full widescreen width
	if (strobeIntensity > 0) {
		int colorIndex = (elapsed / 80) % 4;
		switch (colorIndex) {
			case 0: strobeColor[0] = 1.0f; strobeColor[1] = 1.0f; strobeColor[2] = 1.0f; break;
			case 1: strobeColor[0] = 1.0f; strobeColor[1] = 0.3f; strobeColor[2] = 0.3f; break;
			case 2: strobeColor[0] = 0.3f; strobeColor[1] = 0.3f; strobeColor[2] = 1.0f; break;
			case 3: strobeColor[0] = 1.0f; strobeColor[1] = 1.0f; strobeColor[2] = 0.3f; break;
		}
		strobeColor[3] = strobeIntensity * 0.7f;

		// Fill from 0 to full widescreen width
		CG_FillRect(0, 0, fullWidth, SCREEN_HEIGHT, strobeColor);
	}

	// Big pulsing text - use Ccg_WideX(320) for true center
	scale = 0.5f + 0.1f * sin((float)elapsed / 50.0f);

	CG_RickRoll_GetRainbowColor(elapsed * 3, 0, textColor);

	textWidth = CG_Text_Width_Ext(text, scale, 0, &cgs.media.limboFont2);
	x = Ccg_WideX(320) - textWidth / 2.0f;

	CG_Text_Paint_Ext(x, SCREEN_HEIGHT / 2.0f, scale, scale, textColor, text, 0, 0,
	                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/*
 * Draw Rick sprite - centered using wideXoffset
 */
static void CG_RickRoll_DrawRick(int elapsed, float topY) {
	float u1, v1, u2, v2;
	int frame, frameCol, frameRow;
	float rickX;

	if (!rickShader) {
		return;
	}

	frame = (elapsed / RICK_FRAME_TIME) % RICK_FRAME_COUNT;
	frameCol = frame % RICK_FRAME_COLS;
	frameRow = frame / RICK_FRAME_COLS;

	u1 = (float)frameCol / (float)RICK_FRAME_COLS;
	v1 = (float)frameRow / (float)RICK_FRAME_ROWS;
	u2 = u1 + (1.0f / (float)RICK_FRAME_COLS);
	v2 = v1 + (1.0f / (float)RICK_FRAME_ROWS);

	// Center using wideXoffset - 320 is center of base 640 width
	rickX = 320 - RICK_W / 2.0f + cgs.wideXoffset;

	trap_R_SetColor(NULL);
	CG_DrawPicST(rickX, topY, RICK_W, RICK_H, u1, v1, u2, v2, rickShader);
}

/*
 * Draw wheel - MUCH BIGGER TEXT
 */
static void CG_RickRoll_DrawWheel(float baseX, float y, char items[][64], int itemCount,
                                   float *offset, int *currentIdx, float *speed,
                                   qboolean stopped, const char *result,
                                   int elapsed, int stopTime, int wheelStopTime,
                                   int wheelIndex) {
	float x = baseX + cgs.wideXoffset;  // Apply widescreen offset
	float centerY = y + WHEEL_H / 2.0f;
	const char *displayText;
	float textWidth, textX, textY;
	float textScale = 0.22f;  // MUCH BIGGER text
	float slideOffset;
	float dt = cg.frametime / 1000.0f;
	qboolean useRainbow = !stopped;  // Rainbow for all wheels while spinning

	vec4_t textColor = {1.0f, 1.0f, 1.0f, 1.0f};
	vec4_t dimTextColor = {0.5f, 0.5f, 0.5f, 0.6f};
	vec4_t highlightBg = {0.2f, 0.3f, 0.5f, 0.7f};
	vec4_t stoppedHighlightBg = {0.8f, 0.1f, 0.1f, 0.9f};
	vec4_t borderColor = {0.4f, 0.5f, 0.6f, 0.8f};
	vec4_t redBorder = {1.0f, 0.2f, 0.2f, 1.0f};

	if (itemCount == 0) {
		return;
	}

	if (!stopped) {
		float timeToStop = (float)(stopTime - elapsed) / 1000.0f;

		if (timeToStop > 2.0f) {
			*speed = WHEEL_FAST_SPEED;
		} else if (timeToStop > 0) {
			*speed = WHEEL_SLOW_SPEED + (timeToStop / 2.0f) * (WHEEL_FAST_SPEED - WHEEL_SLOW_SPEED);
		} else {
			*speed = WHEEL_SLOW_SPEED;
		}

		*offset += (*speed) * WHEEL_ITEM_H * dt;

		while (*offset >= WHEEL_ITEM_H) {
			*offset -= WHEEL_ITEM_H;
			*currentIdx = (*currentIdx + 1) % itemCount;
		}

		slideOffset = *offset;
	} else {
		slideOffset = 0;
	}

	// Background
	if (stopped) {
		int timeSinceStop = cg.time - wheelStopTime;
		float flash = 1.0f;
		if (timeSinceStop < 500) {
			flash = 0.7f + 0.3f * sin((float)timeSinceStop / 30.0f);
		}
		stoppedHighlightBg[3] = 0.9f * flash;
		CG_FillRect(x, y, WHEEL_W, WHEEL_H, stoppedHighlightBg);
		CG_DrawRect(x, y, WHEEL_W, WHEEL_H, 3, redBorder);
	} else {
		CG_FillRect(x, y, WHEEL_W, WHEEL_H, highlightBg);
		CG_DrawRect(x, y, WHEEL_W, WHEEL_H, 1, borderColor);
	}

	if (stopped && result && result[0]) {
		displayText = result;
	} else {
		displayText = items[*currentIdx];
	}

	textWidth = CG_Text_Width_Ext(displayText, textScale, 0, &cgs.media.limboFont2);
	textX = x + (WHEEL_W - textWidth) / 2.0f;

	if (!stopped) {
		textY = centerY + 7 - (WHEEL_ITEM_H / 2.0f) + slideOffset;

		if (textY > y && textY < y + WHEEL_H + 10) {
			if (useRainbow) {
				// Draw each character with rainbow color
				int i;
				float charX = textX;
				char charStr[2] = {0, 0};
				vec4_t rainbowColor;
				for (i = 0; displayText[i]; i++) {
					charStr[0] = displayText[i];
					CG_RickRoll_GetRainbowColor(elapsed, (float)i * 0.2f + (float)wheelIndex * 0.5f, rainbowColor);
					CG_Text_Paint_Ext(charX, textY, textScale, textScale, rainbowColor, charStr, 0, 0,
					                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
					charX += CG_Text_Width_Ext(charStr, textScale, 0, &cgs.media.limboFont2);
				}
			} else {
				CG_Text_Paint_Ext(textX, textY, textScale, textScale, textColor, displayText, 0, 0,
				                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
			}
		}

		// Next item (dimmed, no rainbow)
		{
			int nextIdx = (*currentIdx + 1) % itemCount;
			const char *nextText = items[nextIdx];
			float nextTextWidth = CG_Text_Width_Ext(nextText, textScale, 0, &cgs.media.limboFont2);
			float nextTextX = x + (WHEEL_W - nextTextWidth) / 2.0f;
			float nextTextY = textY - WHEEL_ITEM_H;

			if (nextTextY > y - 10) {
				CG_Text_Paint_Ext(nextTextX, nextTextY, textScale, textScale, dimTextColor, nextText, 0, 0,
				                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
			}
		}

		// Previous item (dimmed, no rainbow)
		{
			int prevIdx = (*currentIdx - 1 + itemCount) % itemCount;
			const char *prevText = items[prevIdx];
			float prevTextWidth = CG_Text_Width_Ext(prevText, textScale, 0, &cgs.media.limboFont2);
			float prevTextX = x + (WHEEL_W - prevTextWidth) / 2.0f;
			float prevTextY = textY + WHEEL_ITEM_H;

			if (prevTextY < y + WHEEL_H + 20) {
				CG_Text_Paint_Ext(prevTextX, prevTextY, textScale, textScale, dimTextColor, prevText, 0, 0,
				                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
			}
		}
	} else {
		textY = centerY + 7;
		CG_Text_Paint_Ext(textX, textY, textScale, textScale, textColor, displayText, 0, 0,
		                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
	}
}

/*
 * Draw rainbow title - use Ccg_WideX for centering
 */
static void CG_RickRoll_DrawTitle(int elapsed, float titleY) {
	float pulse;
	float scale;
	vec4_t titleColor;
	const char *title = "RICK ROLL!";
	int i;
	float charX;
	float totalWidth;
	float centerX;
	char charStr[2] = {0, 0};

	pulse = 0.5f + 0.5f * sin((float)elapsed / 150.0f);
	scale = 0.32f + 0.02f * pulse;

	totalWidth = CG_Text_Width_Ext(title, scale, 0, &cgs.media.limboFont2);
	centerX = Ccg_WideX(320);  // True widescreen center
	charX = centerX - totalWidth / 2.0f;

	for (i = 0; title[i]; i++) {
		charStr[0] = title[i];

		CG_RickRoll_GetRainbowColor(elapsed, (float)i * 0.15f, titleColor);

		titleColor[0] = titleColor[0] * 0.7f + 0.3f * pulse;
		titleColor[1] = titleColor[1] * 0.7f + 0.3f * pulse;
		titleColor[2] = titleColor[2] * 0.7f + 0.3f * pulse;

		CG_Text_Paint_Ext(charX, titleY, scale, scale, titleColor, charStr, 0, 0,
		                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

		charX += CG_Text_Width_Ext(charStr, scale, 0, &cgs.media.limboFont2);
	}
}

/*
 * Draw wheel labels - use wideXoffset
 */
static void CG_RickRoll_DrawLabels(float wheel1X, float wheel2X, float wheel3X, float labelY) {
	vec4_t labelColor = {0.7f, 0.8f, 0.9f, 0.9f};
	float labelScale = 0.13f;
	float textWidth;
	float x1 = wheel1X + cgs.wideXoffset;
	float x2 = wheel2X + cgs.wideXoffset;
	float x3 = wheel3X + cgs.wideXoffset;

	textWidth = CG_Text_Width_Ext("PLAYER", labelScale, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(x1 + (WHEEL_W - textWidth) / 2, labelY, labelScale, labelScale,
	                  labelColor, "PLAYER", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	textWidth = CG_Text_Width_Ext("EFFECT", labelScale, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(x2 + (WHEEL_W - textWidth) / 2, labelY, labelScale, labelScale,
	                  labelColor, "EFFECT", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	textWidth = CG_Text_Width_Ext("POWER", labelScale, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(x3 + (WHEEL_W - textWidth) / 2, labelY, labelScale, labelScale,
	                  labelColor, "POWER", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/*
 * Draw result text - use Ccg_WideX for centering
 */
static void CG_RickRoll_DrawResult(int elapsed, float resultY) {
	char resultText[256];
	float x;
	float scale = 0.18f;
	vec4_t resultColor;
	vec4_t subColor;
	const char *subtitle = "Never Gonna Give You Up!";
	float subScale = 0.12f;
	float centerX = Ccg_WideX(320);

	if (!rr.wheel3Stopped) {
		return;
	}

	if (rr.resultPlayerName[0] && rr.resultEffect[0] && rr.resultIntensity[0]) {
		Com_sprintf(resultText, sizeof(resultText), "%s -> %s @ %s",
		            rr.resultPlayerName, rr.resultEffect, rr.resultIntensity);
	} else {
		return;
	}

	CG_RickRoll_GetRainbowColor(elapsed, 0, resultColor);
	resultColor[0] = resultColor[0] * 0.5f + 0.5f;
	resultColor[1] = resultColor[1] * 0.5f + 0.5f;
	resultColor[2] = resultColor[2] * 0.5f + 0.5f;

	x = centerX - CG_Text_Width_Ext(resultText, scale, 0, &cgs.media.limboFont2) / 2.0f;
	CG_Text_Paint_Ext(x, resultY, scale, scale, resultColor, resultText, 0, 0,
	                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	CG_RickRoll_GetRainbowColor(elapsed, 0.5f, subColor);
	subColor[3] = 0.8f;

	x = centerX - CG_Text_Width_Ext(subtitle, subScale, 0, &cgs.media.limboFont2) / 2.0f;
	CG_Text_Paint_Ext(x, resultY + 20, subScale, subScale, subColor, subtitle, 0, 0,
	                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/*
 * Main draw function
 */
void CG_RickRoll_Draw(void) {
	int elapsed;
	float titleY, rickY, wheelsY, labelY, resultY;
	float wheel1X, wheel2X, wheel3X;
	float totalWheelsWidth;
	float fullWidth;

	if (!rr.active) {
		return;
	}

	elapsed = cg.time - rr.startTime;

	if (elapsed > ANIMATION_DURATION) {
		CG_RickRoll_End();
		return;
	}

	fullWidth = Ccg_WideX(SCREEN_WIDTH);

	// Intro phase
	if (elapsed < INTRO_DURATION) {
		CG_RickRoll_DrawIntro(elapsed);
		return;
	}

	elapsed -= INTRO_DURATION;

	// Calculate vertical layout - centered on screen
	{
		float titleHeight = 28;
		float totalHeight = titleHeight + 10 + RICK_H + 45 + WHEEL_H + 25 + 50;
		float startY = (SCREEN_HEIGHT - totalHeight) / 2.0f;

		titleY = startY + titleHeight;
		rickY = titleY + 10;
		wheelsY = rickY + RICK_H + 45;  // More gap to clear crosshair
		labelY = wheelsY - 5;
		resultY = wheelsY + WHEEL_H + 25;
	}

	// Wheel positions - centered at 320 (base coords, offset applied in draw functions)
	totalWheelsWidth = (WHEEL_W * 3) + (WHEEL_SPACING * 2);
	wheel1X = 320 - totalWheelsWidth / 2.0f;
	wheel2X = wheel1X + WHEEL_W + WHEEL_SPACING;
	wheel3X = wheel2X + WHEEL_W + WHEEL_SPACING;

	// Draw elements
	CG_RickRoll_DrawTitle(elapsed, titleY);
	CG_RickRoll_DrawRick(elapsed, rickY);
	CG_RickRoll_DrawLabels(wheel1X, wheel2X, wheel3X, labelY);

	CG_RickRoll_DrawWheel(wheel1X, wheelsY, rr.players, rr.playerCount,
	                       &rr.wheel1Offset, &rr.wheel1CurrentIdx, &rr.wheel1Speed,
	                       rr.wheel1Stopped, rr.resultPlayerName,
	                       elapsed, WHEEL1_STOP_TIME - INTRO_DURATION, rr.wheel1StopTime, 0);

	CG_RickRoll_DrawWheel(wheel2X, wheelsY, rr.effects, rr.effectCount,
	                       &rr.wheel2Offset, &rr.wheel2CurrentIdx, &rr.wheel2Speed,
	                       rr.wheel2Stopped, rr.resultEffect,
	                       elapsed, WHEEL2_STOP_TIME - INTRO_DURATION, rr.wheel2StopTime, 1);

	CG_RickRoll_DrawWheel(wheel3X, wheelsY, rr.intensities, rr.intensityCount,
	                       &rr.wheel3Offset, &rr.wheel3CurrentIdx, &rr.wheel3Speed,
	                       rr.wheel3Stopped, rr.resultIntensity,
	                       elapsed, WHEEL3_STOP_TIME - INTRO_DURATION, rr.wheel3StopTime, 2);

	CG_RickRoll_DrawResult(elapsed, resultY);

	// "Players Frozen" text below wheels (centered, widescreen safe)
	if (rr.playersFrozen) {
		float centerX = Ccg_WideX(SCREEN_WIDTH) / 2.0f;
		float frozenY = resultY + 35;  // Below the result text
		vec4_t frozenColor = { 0.5f, 0.8f, 1.0f, 0.85f };  // Light blue
		const char *frozenText = "Players are frozen while being RickRoll'd";
		float textW = CG_Text_Width_Ext(frozenText, 0.18f, 0, &cgs.media.limboFont2);

		CG_Text_Paint_Ext(centerX - textW / 2.0f, frozenY, 0.18f, 0.18f, frozenColor,
		                   frozenText, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
	}

	// Confetti
	if (rr.celebrationActive) {
		int celebElapsed = cg.time - rr.celebrationStartTime;
		int i;

		if (celebElapsed < CELEBRATION_DURATION && (celebElapsed / 200) % 3 == 0) {
			for (i = 0; i < MAX_CONFETTI; i++) {
				if (!confetti[i].active && rand() % 20 == 0) {
					confetti[i].active = qtrue;
					confetti[i].x = (float)(rand() % (int)fullWidth);
					confetti[i].y = -20.0f;
					confetti[i].vx = (rand() % 200 - 100) / 50.0f;
					confetti[i].vy = 80.0f + (rand() % 120);
				}
			}
		}

		CG_RickRoll_DrawConfetti(elapsed);
	}
}

qboolean CG_RickRoll_IsActive(void) {
	return rr.active;
}

/**
 * @brief Handle rickroll_timer command from server
 * Format: rickroll_timer <clientNum> <effectName> <remainingSeconds> [description]
 */
void CG_RickRoll_Timer(void) {
	int clientNum = Q_atoi(CG_Argv(1));
	const char *effectName = CG_Argv(2);
	int remaining = Q_atoi(CG_Argv(3));
	const char *description = CG_Argv(4);
	char *p;

	// Check if this timer is for us (-1 = all players, or our clientNum)
	if (clientNum != -1 && clientNum != cg.clientNum) {
		return;
	}

	rr.effectTimerActive = qtrue;
	Q_strncpyz(rr.effectTimerName, effectName, sizeof(rr.effectTimerName));

	// Convert underscores back to spaces for display
	for (p = rr.effectTimerName; *p; p++) {
		if (*p == '_') {
			*p = ' ';
		}
	}

	// Store description if provided
	if (description && description[0]) {
		Q_strncpyz(rr.effectDescription, description, sizeof(rr.effectDescription));
		// Convert underscores to spaces in description too
		for (p = rr.effectDescription; *p; p++) {
			if (*p == '_') {
				*p = ' ';
			}
		}
	}

	rr.effectTimerRemaining = remaining;
	rr.effectTimerLastUpdate = cg.time;
}

/**
 * @brief Handle rickroll_effect_end command
 * Format: rickroll_effect_end <clientNum>
 */
void CG_RickRoll_EffectEnd(void) {
	int clientNum = Q_atoi(CG_Argv(1));

	// Check if this is for us
	if (clientNum != -1 && clientNum != cg.clientNum) {
		return;
	}

	// Store the effect name for the ended notification
	Q_strncpyz(rr.effectEndedName, rr.effectTimerName, sizeof(rr.effectEndedName));
	rr.effectEndedActive = qtrue;
	rr.effectEndedTime = cg.time;

	rr.effectTimerActive = qfalse;
	rr.effectTimerRemaining = 0;
	rr.effectDescription[0] = '\0';
}

/**
 * @brief Handle rickroll_frozen command
 * Format: rickroll_frozen <0|1>
 */
void CG_RickRoll_Frozen(void) {
	int frozen = Q_atoi(CG_Argv(1));
	rr.playersFrozen = frozen ? qtrue : qfalse;
}

/**
 * @brief Handle rickroll_forceweapon command - forces weapon on client side
 * Format: rickroll_forceweapon <weaponNum> <durationMs>
 * - weaponNum=0: clear forced weapon
 * - duration=0: just sync weaponSelect without forcing (one-time switch)
 * - duration>0: force weapon and block switching for duration
 */
void CG_RickRoll_ForceWeapon(void) {
	int weapon = Q_atoi(CG_Argv(1));
	int duration = Q_atoi(CG_Argv(2));

	if (weapon > 0) {
		// Always sync the client's selected weapon to match server
		cg.weaponSelect = weapon;
		cg.weaponSelectTime = cg.time;

		if (duration > 0) {
			// Force mode: block weapon switching for duration
			cg.rickrollForcedWeapon = weapon;
			cg.rickrollForcedWeaponUntil = cg.time + duration;
		} else {
			// Sync mode: just update weaponSelect, no forcing
			cg.rickrollForcedWeapon = 0;
			cg.rickrollForcedWeaponUntil = 0;
		}
	} else {
		// Clear forced weapon
		cg.rickrollForcedWeapon = 0;
		cg.rickrollForcedWeaponUntil = 0;
	}
}

/**
 * @brief Check if weapon switching is blocked by rickroll effect
 */
qboolean CG_RickRoll_IsWeaponForced(void) {
	if (cg.rickrollForcedWeapon > 0 && cg.time < cg.rickrollForcedWeaponUntil) {
		return qtrue;
	}
	// Clear expired force
	if (cg.rickrollForcedWeapon > 0 && cg.time >= cg.rickrollForcedWeaponUntil) {
		cg.rickrollForcedWeapon = 0;
		cg.rickrollForcedWeaponUntil = 0;
	}
	return qfalse;
}

/**
 * @brief Handle rickroll_shake command - triggers camera shake (earthquake effect)
 * Format: rickroll_shake <intensity>
 * Intensity is a float (0.5 = mild, 1.0 = normal, 2.0 = strong, etc)
 */
void CG_RickRoll_Shake(void) {
	float intensity = atof(CG_Argv(1));

	if (intensity > 0) {
		// CG_StartShakeCamera takes a scale parameter
		// Typical explosion uses ~0.5-1.0, we'll allow up to 3.0 for strong earthquakes
		CG_StartShakeCamera(intensity);
	}
}

// Spin state for disoriented effect - temporary wobble that returns to normal
static float spinMaxAngle = 0;       // Maximum angle to spin to
static qboolean spinActive = qfalse;
static int spinStartTime = 0;
static int spinDuration = 800;       // Total duration (spin out + spin back)

/**
 * @brief Handle rickroll_spin command - temporary wobble effect
 * Format: rickroll_spin <maxAngle> <durationMs>
 * Creates a wobble: spins to maxAngle then back to 0
 * Does NOT affect movement, only visual
 */
void CG_RickRoll_Spin(void) {
	float angle = atof(CG_Argv(1));
	int duration = atoi(CG_Argv(2));

	if (duration <= 0) {
		duration = 800;  // default 800ms total
	}

	spinMaxAngle = angle;
	spinActive = qtrue;
	spinStartTime = cg.time;
	spinDuration = duration;
}

/**
 * @brief Update spin effect - called every frame from CG_DrawActiveFrame
 * Applies temporary wobble: spins out to max angle, then back to 0
 * Only affects visual rendering, not actual player view angles
 */
void CG_RickRoll_UpdateSpin(void) {
	float progress, currentOffset;

	if (!spinActive) {
		return;
	}

	// Calculate progress (0.0 to 1.0)
	progress = (float)(cg.time - spinStartTime) / (float)spinDuration;

	if (progress >= 1.0f) {
		// Wobble complete - back to normal
		spinActive = qfalse;
		spinMaxAngle = 0;
		return;
	}

	// Wobble curve: sin wave that goes 0 -> max -> 0
	// Use sin(progress * PI) for smooth out-and-back
	currentOffset = spinMaxAngle * sin(progress * M_PI);

	// Apply wobble offset to view (visual only)
	cg.refdefViewAngles[YAW] += currentOffset;
	AnglesToAxis(cg.refdefViewAngles, cg.refdef_current->viewaxis);
}

/**
 * @brief Reset spin effect - stops any active wobble
 * Called when disoriented effect ends
 */
void CG_RickRoll_SpinReset(void) {
	spinActive = qfalse;
	spinMaxAngle = 0;
}

/**
 * @brief Draw big countdown numbers (5, 4, 3, 2, 1) center screen
 * Zoom out and fade effect
 */
static void CG_RickRoll_DrawCountdown(void) {
	vec4_t color;
	char numText[8];
	float scale, alpha;
	float textWidth;
	float centerX, centerY;
	int elapsed;

	if (!rr.effectTimerActive || rr.effectTimerRemaining > 5 || rr.effectTimerRemaining <= 0) {
		return;
	}

	// Calculate time within this second (0-1000ms)
	elapsed = cg.time - rr.effectTimerLastUpdate;
	if (elapsed < 0) elapsed = 0;
	if (elapsed > 1000) elapsed = 1000;

	// Scale: starts at 1.0, zooms out to 0.3 over 800ms
	scale = 1.0f - (elapsed / 1000.0f) * 0.7f;
	if (scale < 0.3f) scale = 0.3f;

	// Alpha: full for 500ms, then fade out
	if (elapsed < 500) {
		alpha = 1.0f;
	} else {
		alpha = 1.0f - ((elapsed - 500) / 500.0f);
	}
	if (alpha < 0.0f) alpha = 0.0f;

	// Rainbow color cycling
	int colorPhase = (cg.time / 80) % 6;
	switch (colorPhase) {
		case 0: Vector4Set(color, 1.0f, 0.0f, 0.0f, alpha); break;
		case 1: Vector4Set(color, 1.0f, 1.0f, 0.0f, alpha); break;
		case 2: Vector4Set(color, 0.0f, 1.0f, 0.0f, alpha); break;
		case 3: Vector4Set(color, 0.0f, 1.0f, 1.0f, alpha); break;
		case 4: Vector4Set(color, 1.0f, 0.0f, 1.0f, alpha); break;
		case 5: Vector4Set(color, 1.0f, 1.0f, 1.0f, alpha); break;
	}

	Com_sprintf(numText, sizeof(numText), "%d", rr.effectTimerRemaining);

	// Use widescreen-aware center
	centerX = Ccg_WideX(SCREEN_WIDTH) / 2.0f;
	centerY = SCREEN_HEIGHT / 2.0f - 20.0f;

	textWidth = CG_Text_Width_Ext(numText, scale, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(centerX - textWidth / 2.0f, centerY + (scale * 20.0f), scale, scale, color,
		numText, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/**
 * @brief Draw "EFFECT ENDED" notification center screen
 */
static void CG_RickRoll_DrawEffectEnded(void) {
	vec4_t bgColor = { 0.0f, 0.0f, 0.0f, 0.0f };
	vec4_t textColor;
	float centerX, centerY;
	float textWidth;
	int elapsed;
	float alpha;
	char endedText[128];

	if (!rr.effectEndedActive) {
		return;
	}

	elapsed = cg.time - rr.effectEndedTime;

	// Show for 3 seconds total
	if (elapsed > 3000) {
		rr.effectEndedActive = qfalse;
		return;
	}

	// Fade in for first 200ms, hold, then fade out last 500ms
	if (elapsed < 200) {
		alpha = elapsed / 200.0f;
	} else if (elapsed > 2500) {
		alpha = 1.0f - ((elapsed - 2500) / 500.0f);
	} else {
		alpha = 1.0f;
	}

	// Green color for ended
	Vector4Set(textColor, 0.0f, 1.0f, 0.0f, alpha);
	bgColor[3] = alpha * 0.7f;

	Com_sprintf(endedText, sizeof(endedText), "%s ENDED", rr.effectEndedName);

	// Use widescreen-aware center
	centerX = Ccg_WideX(SCREEN_WIDTH) / 2.0f;
	centerY = SCREEN_HEIGHT / 2.0f - 40.0f;

	// Background box
	textWidth = CG_Text_Width_Ext(endedText, 0.35f, 0, &cgs.media.limboFont2);
	CG_FillRect(centerX - textWidth / 2.0f - 10.0f, centerY - 15.0f, textWidth + 20.0f, 30.0f, bgColor);

	// Text
	CG_Text_Paint_Ext(centerX - textWidth / 2.0f, centerY + 5.0f, 0.35f, 0.35f, textColor,
		endedText, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/**
 * @brief Draw the effect timer below the map timer
 * Includes effect name, timer, and persistent description
 */
void CG_RickRoll_DrawTimer(void) {
	vec4_t bgColor = { 0.0f, 0.0f, 0.0f, 0.7f };
	vec4_t labelColor = { 1.0f, 0.5f, 0.0f, 1.0f };  // Orange for RICKROLL label
	vec4_t descColor = { 0.8f, 0.8f, 0.8f, 0.9f };   // Light gray for description
	vec4_t timerColor;
	float x, y, w, h;
	float textWidth, labelWidth, descWidth;
	char timerText[32];
	int mins, secs;

	// Draw effect ended notification if active
	CG_RickRoll_DrawEffectEnded();

	if (!rr.effectTimerActive || rr.effectTimerRemaining <= 0) {
		return;
	}

	// Don't draw during main rickroll animation
	if (rr.active) {
		return;
	}

	// Draw big countdown at 5 seconds or less
	CG_RickRoll_DrawCountdown();

	// Timer color based on time remaining
	if (rr.effectTimerRemaining <= 5) {
		// Dramatic rainbow/flash effect when <= 5 seconds
		int flashPhase = (cg.time / 100) % 6;
		switch (flashPhase) {
			case 0: Vector4Set(timerColor, 1.0f, 0.0f, 0.0f, 1.0f); break;
			case 1: Vector4Set(timerColor, 1.0f, 1.0f, 0.0f, 1.0f); break;
			case 2: Vector4Set(timerColor, 0.0f, 1.0f, 0.0f, 1.0f); break;
			case 3: Vector4Set(timerColor, 0.0f, 1.0f, 1.0f, 1.0f); break;
			case 4: Vector4Set(timerColor, 1.0f, 0.0f, 1.0f, 1.0f); break;
			case 5: Vector4Set(timerColor, 1.0f, 1.0f, 1.0f, 1.0f); break;
		}
	} else if (rr.effectTimerRemaining <= 10) {
		Vector4Set(timerColor, 1.0f, 0.0f, 0.0f, 1.0f);
	} else {
		Vector4Set(timerColor, 0.0f, 1.0f, 0.0f, 1.0f);
	}

	// Format time
	mins = rr.effectTimerRemaining / 60;
	secs = rr.effectTimerRemaining % 60;
	Com_sprintf(timerText, sizeof(timerText), "%d:%02d", mins, secs);

	// Timer box - positioned below the map timer
	w = 42.0f;
	h = 14.0f;
	x = Ccg_WideX(SCREEN_WIDTH) - w - 8.0f;
	y = 188.0f;

	// "RICKROLL" label
	labelWidth = CG_Text_Width_Ext("RICKROLL", 0.14f, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(x + (w - labelWidth) / 2.0f, y - 2.0f, 0.14f, 0.14f, labelColor,
		"RICKROLL", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	// Background box
	CG_FillRect(x, y, w, h, bgColor);
	CG_DrawRect_FixedBorder(x, y, w, h, 1, timerColor);

	// Timer text
	textWidth = CG_Text_Width_Ext(timerText, 0.18f, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(x + (w - textWidth) / 2.0f, y + 11.0f, 0.18f, 0.18f, timerColor,
		timerText, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	// Draw effect description below timer (persistent reminder)
	if (rr.effectDescription[0]) {
		float descY = y + h + 4.0f;
		descWidth = CG_Text_Width_Ext(rr.effectDescription, 0.12f, 0, &cgs.media.limboFont2);

		// Right-align with timer box
		float descX = x + w - descWidth;

		// Background for readability
		CG_FillRect(descX - 3.0f, descY - 2.0f, descWidth + 6.0f, 12.0f, bgColor);

		CG_Text_Paint_Ext(descX, descY + 8.0f, 0.12f, 0.12f, descColor,
			rr.effectDescription, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
	}
}


/**
 * @brief Handle rocketmode command from server
 * Format: rocketmode <mode>
 * mode: 0=normal, 1=freeze, 2=homing
 */
void CG_RocketMode_Update(void) {
	int mode = atoi(CG_Argv(1));

	CG_Printf("^2[RocketMode] CG_RocketMode_Update called, mode=%d\n", mode);

	cg.rocketMode = mode;
	cg.rocketModeDisplayUntil = cg.time + 5000;  // Show for 5 seconds (then fade)
}

/**
 * @brief Draw rocket mode indicator on HUD when holding panzer
 * Called from CG_DrawActiveFrame or similar
 * Shows for 5 seconds after switching, then fades out over 1 second
 */
void CG_DrawRocketMode(void) {
	const char *modeText;
	vec4_t modeColor;
	vec4_t hintColor;
	float centerX, y, textWidth;
	float alpha = 1.0f;
	int elapsed;
	int displayDuration = 5000;  // 5 seconds display
	int fadeDuration = 1000;     // 1 second fade

	// Safety check
	if (!cg.snap) {
		return;
	}

	// Only show when player has panzer/bazooka equipped
	if (cg.snap->ps.weapon != WP_PANZERFAUST && cg.snap->ps.weapon != WP_BAZOOKA) {
		return;
	}

	// Check if we should still display (5 second timer + 1 second fade)
	if (cg.rocketModeDisplayUntil <= 0) {
		return;
	}

	elapsed = cg.time - (cg.rocketModeDisplayUntil - displayDuration);
	if (elapsed > displayDuration + fadeDuration) {
		return;  // Past display + fade time
	}

	// Calculate fade alpha (fade during last second)
	if (elapsed > displayDuration) {
		alpha = 1.0f - ((float)(elapsed - displayDuration) / fadeDuration);
		if (alpha < 0) alpha = 0;
	}

	// Set mode text and color
	// Mode values from server: 0=normal, 1=freeze, 2=homing, 3=freeze+homing
	switch (cg.rocketMode) {
		case 1:  // Freeze
			modeText = "FREEZE ROCKETS";
			Vector4Set(modeColor, 0.2f, 0.5f, 1.0f, alpha);  // Blue
			break;
		case 2:  // Homing
			modeText = "HOMING ROCKETS";
			Vector4Set(modeColor, 0.2f, 1.0f, 0.3f, alpha);  // Green
			break;
		case 3:  // Freeze + Homing
			modeText = "FREEZE+HOMING ROCKETS";
			Vector4Set(modeColor, 1.0f, 0.2f, 1.0f, alpha);  // Magenta/Purple
			break;
		default:  // Normal
			modeText = "NORMAL ROCKETS";
			Vector4Set(modeColor, 1.0f, 1.0f, 1.0f, alpha);  // White
			break;
	}

	// Draw centered above crosshair - use Ccg_WideX for proper widescreen centering
	centerX = Ccg_WideX(SCREEN_WIDTH) / 2.0f;
	y = SCREEN_HEIGHT / 2.0f - 60.0f;

	textWidth = CG_Text_Width_Ext(modeText, 0.25f, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(centerX - textWidth / 2.0f, y, 0.25f, 0.25f, modeColor,
		modeText, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

	// Draw hint below with same fade
	Vector4Set(hintColor, 1.0f, 1.0f, 1.0f, alpha * 0.7f);
	y += 15.0f;
	textWidth = CG_Text_Width_Ext("Press 3 again to cycle", 0.15f, 0, &cgs.media.limboFont2);
	CG_Text_Paint_Ext(centerX - textWidth / 2.0f, y, 0.15f, 0.15f, hintColor,
		"Press 3 again to cycle", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
}

/**
 * @brief Handle panzerfest_bonus command from server
 * Format: panzerfest_bonus <killStreakLevel> <survivalLevel> <panzerfestPhase> <timeLeft> <isTarget> <killCount> <killsNeeded> <fireRateMultiplier>
 */
void CG_PanzerfestBonus_Update(void) {
	int oldFireRate = cg.fireRateMultiplier;

	cg.killStreakLevel = atoi(CG_Argv(1));
	cg.survivalLevel = atoi(CG_Argv(2));
	cg.panzerfestPhase = atoi(CG_Argv(3));
	cg.panzerfestTimeLeft = atoi(CG_Argv(4));
	cg.isPanzerfestTarget = atoi(CG_Argv(5)) ? qtrue : qfalse;
	cg.panzerfestKillCount = atoi(CG_Argv(6));
	cg.panzerfestKillsNeeded = atoi(CG_Argv(7));
	cg.fireRateMultiplier = atoi(CG_Argv(8));

	// Default kills needed if not sent (backwards compatibility)
	if (cg.panzerfestKillsNeeded <= 0) {
		cg.panzerfestKillsNeeded = 30;
	}

	// Default fire rate if not sent (backwards compatibility)
	if (cg.fireRateMultiplier <= 0) {
		cg.fireRateMultiplier = 100;
	}

	// ETMan: Fire rate is now handled server-authoritatively.
	// The server directly modifies ps.weaponTime after Pmove, so the client
	// receives the correct value in the snapshot. No cache invalidation needed.
	// cg.fireRateMultiplier is still used for HUD display purposes.
}

/**
 * @brief Draw panzerfest/survival bonus bars on HUD
 * Shows kill streak fire rate level and survival speed level as bars
 * Positioned in bottom-left area, above the stamina bar
 */
void CG_DrawPanzerfestBonus(void) {
	float x, y, w, h;
	float barWidth;
	int i;
	vec4_t bgColor = { 0.0f, 0.0f, 0.0f, 0.5f };
	vec4_t borderColor = { 1.0f, 1.0f, 1.0f, 0.5f };
	vec4_t fireColor = { 1.0f, 0.3f, 0.0f, 0.9f };       // Orange/red for fire rate
	vec4_t speedColor = { 0.0f, 1.0f, 0.3f, 0.9f };      // Green for speed
	vec4_t segmentEmpty = { 0.2f, 0.2f, 0.2f, 0.6f };    // Dark gray for empty segments
	vec4_t labelColor = { 1.0f, 1.0f, 1.0f, 0.8f };
	vec4_t panzerfestColor;
	char text[32];

	// Don't draw if no bonuses, no kills, and not in panzerfest
	if (cg.killStreakLevel == 0 && cg.survivalLevel == 0 && cg.panzerfestPhase == 0 && cg.panzerfestKillCount == 0) {
		return;
	}

	// Position in bottom-right, just above the charge/stamina bar
	// Bar fits 6 segments perfectly: 6 segments * 10px + 5 gaps * 2px + 2px border = 72px
	// Layout from bottom to top: Kill Streak bar, Survival bar, then Panzerfest text
	float segmentW = 10.0f;    // Width of each segment
	float segmentGap = 2.0f;   // Gap between segments
	float border = 1.0f;       // Border thickness
	w = (segmentW * 6) + (segmentGap * 5) + (border * 2);  // = 72px total
	h = 10.0f;
	float textMargin = 28.0f;  // Space for multiplier text on left
	x = Ccg_WideX(SCREEN_WIDTH) - w - 4.0f;  // Right against screen edge (like clock)

	// Position above the charge bar (charge bar is around y=430-440)
	float baseY = SCREEN_HEIGHT - 115.0f;  // Clear above charge bar
	float barSpacing = 22.0f;  // Space between bar sections (label + bar)
	float labelWidth;
	float textX;  // For multiplier text on left

	// === KILL STREAK (Fire Rate) Bar - BOTTOM ===
	if (cg.killStreakLevel > 0 || cg.panzerfestPhase > 0) {
		y = baseY;

		// Bar first
		CG_FillRect(x, y, w, h, bgColor);
		CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

		// Draw 6 segments - perfectly fitted
		for (i = 0; i < 6; i++) {
			float segX = x + border + (i * (segmentW + segmentGap));
			float segY = y + border;
			float segH = h - (border * 2);

			if (i < cg.killStreakLevel) {
				if (cg.killStreakLevel == 6) {
					float pulse = 0.7f + 0.3f * sin((float)cg.time * 0.01f);
					fireColor[3] = pulse;
				}
				CG_FillRect(segX, segY, segmentW, segH, fireColor);
			} else {
				CG_FillRect(segX, segY, segmentW, segH, segmentEmpty);
			}
		}

		// Multiplier text to the LEFT of bar
		Com_sprintf(text, sizeof(text), "%dx", cg.killStreakLevel + 1);
		textX = x - 4.0f - CG_Text_Width_Ext(text, 0.13f, 0, &cgs.media.limboFont2);
		CG_Text_Paint_Ext(textX, y + 8.0f, 0.13f, 0.13f, fireColor,
			text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

		// Title centered above bar with kill count (tight)
		{
			int kills = cg.killStreakLevel * 5;
			Com_sprintf(text, sizeof(text), "KILLS (%d)", kills);
			labelWidth = CG_Text_Width_Ext(text, 0.11f, 0, &cgs.media.limboFont2);
			CG_Text_Paint_Ext(x + (w - labelWidth) / 2.0f, y - 2.0f, 0.11f, 0.11f, fireColor,
				text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
		}
	}

	// === SURVIVAL (Speed) Bar - ABOVE KILL STREAK ===
	if (cg.survivalLevel > 0 || cg.panzerfestPhase > 0) {
		y = baseY - barSpacing;

		// Bar first
		CG_FillRect(x, y, w, h, bgColor);
		CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

		// Draw 6 segments - perfectly fitted
		for (i = 0; i < 6; i++) {
			float segX = x + border + (i * (segmentW + segmentGap));
			float segY = y + border;
			float segH = h - (border * 2);

			if (i < cg.survivalLevel) {
				if (cg.survivalLevel == 6) {
					float pulse = 0.7f + 0.3f * sin((float)cg.time * 0.008f);
					speedColor[3] = pulse;
				}
				CG_FillRect(segX, segY, segmentW, segH, speedColor);
			} else {
				CG_FillRect(segX, segY, segmentW, segH, segmentEmpty);
			}
		}

		// Multiplier text to the LEFT of bar
		// +40% per level: Level 1=1.4x, Level 2=1.8x, ... Level 6=3.4x
		Com_sprintf(text, sizeof(text), "%.1fx", 1.0f + (cg.survivalLevel * 0.40f));
		textX = x - 4.0f - CG_Text_Width_Ext(text, 0.13f, 0, &cgs.media.limboFont2);
		CG_Text_Paint_Ext(textX, y + 8.0f, 0.13f, 0.13f, speedColor,
			text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

		// Title centered above bar with survival time (tight)
		{
			int survivalSecs = cg.survivalLevel * 30;
			Com_sprintf(text, sizeof(text), "SURVIVAL (%ds)", survivalSecs);
			labelWidth = CG_Text_Width_Ext(text, 0.11f, 0, &cgs.media.limboFont2);
			CG_Text_Paint_Ext(x + (w - labelWidth) / 2.0f, y - 2.0f, 0.11f, 0.11f, speedColor,
				text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
		}
	}

	// Panzerfest indicator position - above the survival bar, closer
	y = baseY - (barSpacing * 2) + 5.0f;

	// === PANZERFEST Indicator ===
	if (cg.panzerfestPhase > 0) {
		const char *phaseText;
		int mins, secs;

		// Dramatic color based on phase
		switch (cg.panzerfestPhase) {
			case 1:  // Boost
				phaseText = "PANZERFEST!";
				Vector4Set(panzerfestColor, 1.0f, 0.8f, 0.0f, 1.0f);  // Gold
				break;
			case 2:  // Both slowdown
				phaseText = "SLOWING...";
				Vector4Set(panzerfestColor, 1.0f, 0.5f, 0.0f, 1.0f);  // Orange
				break;
			case 3:  // Fire slowdown
				phaseText = "PENALIZED!";
				Vector4Set(panzerfestColor, 1.0f, 0.2f, 0.0f, 1.0f);  // Red-orange
				break;
			case 4:  // Survive
				phaseText = "SURVIVE!";
				Vector4Set(panzerfestColor, 1.0f, 0.0f, 0.0f, 1.0f);  // Red
				break;
			case 5:  // Victory
				phaseText = "LEGEND!";
				// Rainbow effect
				{
					int colorPhase = (cg.time / 100) % 6;
					switch (colorPhase) {
						case 0: Vector4Set(panzerfestColor, 1.0f, 0.0f, 0.0f, 1.0f); break;
						case 1: Vector4Set(panzerfestColor, 1.0f, 1.0f, 0.0f, 1.0f); break;
						case 2: Vector4Set(panzerfestColor, 0.0f, 1.0f, 0.0f, 1.0f); break;
						case 3: Vector4Set(panzerfestColor, 0.0f, 1.0f, 1.0f, 1.0f); break;
						case 4: Vector4Set(panzerfestColor, 0.0f, 0.0f, 1.0f, 1.0f); break;
						case 5: Vector4Set(panzerfestColor, 1.0f, 0.0f, 1.0f, 1.0f); break;
					}
				}
				break;
			default:
				phaseText = "";
				Vector4Set(panzerfestColor, 1.0f, 1.0f, 1.0f, 1.0f);
				break;
		}

		// Draw panzerfest label + timer combined, right-aligned to match bars
		if (cg.panzerfestTimeLeft > 0) {
			mins = cg.panzerfestTimeLeft / 60;
			secs = cg.panzerfestTimeLeft % 60;
			Com_sprintf(text, sizeof(text), "%s %d:%02d", phaseText, mins, secs);
		} else {
			Com_sprintf(text, sizeof(text), "%s", phaseText);
		}
		labelWidth = CG_Text_Width_Ext(text, 0.14f, 0, &cgs.media.limboFont2);
		CG_Text_Paint_Ext(x + w - labelWidth - 4.0f, y - 2.0f, 0.14f, 0.14f, panzerfestColor,
			text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);

		// Target indicator - also right-aligned
		if (cg.isPanzerfestTarget) {
			y -= 12.0f;
			labelWidth = CG_Text_Width_Ext("YOU ARE THE TARGET!", 0.10f, 0, &cgs.media.limboFont2);
			CG_Text_Paint_Ext(x + w - labelWidth, y - 2.0f, 0.10f, 0.10f, panzerfestColor,
				"YOU ARE THE TARGET!", 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
		}
	}

	// === PANZERFEST PROGRESS (always show kill count if > 0 and not in panzerfest) ===
	if (cg.panzerfestKillCount > 0 && cg.panzerfestPhase == 0 && cg.panzerfestKillsNeeded > 0) {
		vec4_t progressColor;
		float percentage = (float)cg.panzerfestKillCount / (float)cg.panzerfestKillsNeeded;

		// Color gradient: white -> yellow -> orange -> red as you get closer
		if (percentage >= 0.8f) {
			Vector4Set(progressColor, 1.0f, 0.0f, 0.0f, 1.0f);  // Red - almost there!
		} else if (percentage >= 0.6f) {
			Vector4Set(progressColor, 1.0f, 0.5f, 0.0f, 1.0f);  // Orange
		} else if (percentage >= 0.4f) {
			Vector4Set(progressColor, 1.0f, 1.0f, 0.0f, 1.0f);  // Yellow
		} else {
			Vector4Set(progressColor, 1.0f, 1.0f, 1.0f, 0.8f);  // White
		}

		// Draw "PANZERFEST X/30" text - right aligned to match bars, uses same y position
		Com_sprintf(text, sizeof(text), "PANZERFEST %d/%d", cg.panzerfestKillCount, cg.panzerfestKillsNeeded);
		labelWidth = CG_Text_Width_Ext(text, 0.14f, 0, &cgs.media.limboFont2);
		CG_Text_Paint_Ext(x + w - labelWidth - 4.0f, y - 2.0f, 0.14f, 0.14f, progressColor,
			text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
	}
}

/**
 * @brief Draw killing spree announcement on HUD
 * Shows big number + "Killing Spree!" text in upper-left with pulsing green glow
 * Display duration: 4 seconds with fade out
 * Style: Blocky text, green numbers (rainbow for top tiers)
 */
/**
 * @brief Draw text with thick black outline (draws text 4 times offset for outline, then main text)
 */
static void CG_DrawTextWithOutline(float x, float y, float scaleX, float scaleY, vec4_t color, const char *text, fontHelper_t *font, float outlineSize) {
	vec4_t blackColor = {0.0f, 0.0f, 0.0f, color[3]};

	// Draw black outline in 4 cardinal directions (reduced from 8 for performance)
	CG_Text_Paint_Ext(x - outlineSize, y, scaleX, scaleY, blackColor, text, 0, 0, 0, font);
	CG_Text_Paint_Ext(x + outlineSize, y, scaleX, scaleY, blackColor, text, 0, 0, 0, font);
	CG_Text_Paint_Ext(x, y - outlineSize, scaleX, scaleY, blackColor, text, 0, 0, 0, font);
	CG_Text_Paint_Ext(x, y + outlineSize, scaleX, scaleY, blackColor, text, 0, 0, 0, font);

	// Draw main text on top with shadow style for extra depth
	CG_Text_Paint_Ext(x, y, scaleX, scaleY, color, text, 0, 0, ITEM_TEXTSTYLE_SHADOWED, font);
}

/**
 * @brief Draw text centered horizontally with outline
 */
static void CG_DrawTextCenteredWithOutline(float centerX, float y, float scaleX, float scaleY, vec4_t color, const char *text, fontHelper_t *font, float outlineSize) {
	int textWidth = CG_Text_Width_Ext(text, scaleX, 0, font);
	float x = centerX - (textWidth / 2.0f);
	CG_DrawTextWithOutline(x, y, scaleX, scaleY, color, text, font, outlineSize);
}

/**
 * @brief Initialize confetti particles for 100 kill celebration
 * Simplified version - fewer particles, no rotation tracking
 */
void CG_InitConfetti(void) {
	int i;
	float wideWidth = Ccg_WideX(SCREEN_WIDTH);

	// Simple fixed colors - one per particle slot
	static vec4_t confettiColors[8] = {
		{1.0f, 0.0f, 0.0f, 1.0f},  // Red
		{0.0f, 1.0f, 0.0f, 1.0f},  // Green
		{0.0f, 0.0f, 1.0f, 1.0f},  // Blue
		{1.0f, 1.0f, 0.0f, 1.0f},  // Yellow
		{1.0f, 0.0f, 1.0f, 1.0f},  // Magenta
		{0.0f, 1.0f, 1.0f, 1.0f},  // Cyan
		{1.0f, 0.5f, 0.0f, 1.0f},  // Orange
		{1.0f, 1.0f, 1.0f, 1.0f},  // White
	};

	cg.confettiStartTime = cg.time;

	// Simple initialization - spread evenly across screen
	for (i = 0; i < MAX_CONFETTI; i++) {
		cg.confetti[i].x = wideWidth * ((float)i / MAX_CONFETTI);
		cg.confetti[i].y = -10.0f - (float)(i * 5);
		cg.confetti[i].velX = (i % 2 == 0) ? 0.5f : -0.5f;
		cg.confetti[i].velY = 2.0f + (float)(i % 3);
		cg.confetti[i].size = 6.0f;
		Vector4Copy(confettiColors[i % 8], cg.confetti[i].color);
	}
}

/**
 * @brief Update and draw confetti particles
 */
static void CG_DrawConfetti(float alpha) {
	int i;
	int elapsed;
	vec4_t color;
	float wideWidth = Ccg_WideX(SCREEN_WIDTH);

	if (cg.confettiStartTime == 0) {
		return;
	}

	elapsed = cg.time - cg.confettiStartTime;

	// Confetti lasts 5 seconds
	if (elapsed > 5000) {
		cg.confettiStartTime = 0;
		return;
	}

	// Update and draw each confetti piece
	for (i = 0; i < MAX_CONFETTI; i++) {
		// Update position
		cg.confetti[i].x += cg.confetti[i].velX;
		cg.confetti[i].y += cg.confetti[i].velY;

		// Wrap horizontally
		if (cg.confetti[i].x < -20) cg.confetti[i].x = wideWidth + 10;
		if (cg.confetti[i].x > wideWidth + 20) cg.confetti[i].x = -10;

		// Reset if fallen off bottom
		if (cg.confetti[i].y > 500) {
			cg.confetti[i].y = -20.0f;
		}

		// Draw confetti piece
		Vector4Copy(cg.confetti[i].color, color);
		color[3] = alpha;
		CG_FillRect(cg.confetti[i].x, cg.confetti[i].y, cg.confetti[i].size, cg.confetti[i].size * 0.6f, color);
	}
}

/**
 * @brief Trigger a test killing spree display (for rcon testing)
 */
void CG_TestKillingSpree(int kills) {
	int level = 0;
	static const int thresholds[] = { 10, 20, 30, 40, 50, 100 };
	int i;

	// Find the level for this kill count
	for (i = 0; i < 6; i++) {
		if (kills >= thresholds[i]) {
			level = i;
		}
	}

	cg.killSpreeDisplayTime = cg.time;
	cg.killSpreeDisplayKills = kills;
	cg.killSpreeDisplayLevel = level;
	Q_strncpyz(cg.killSpreeDisplayName, "TestPlayer", sizeof(cg.killSpreeDisplayName));

	// Confetti disabled - was causing crashes
	// if (kills >= 100) {
	// 	CG_InitConfetti();
	// }

	// Play sound
	if (level < 6) {
		trap_S_StartLocalSound(cgs.media.killingSpreeSounds[level], CHAN_LOCAL_SOUND);
	}
}

void CG_DrawKillingSpree(void) {
	float x, y;
	float alpha;
	float pulse;
	float textScale;
	float numberScale;
	float nameScale;
	int elapsed;
	int flashPhase;
	int textWidth;
	char killsText[16];
	char spreeText[32];
	vec4_t numberColor;
	vec4_t textColor;
	vec4_t nameColor;
	qboolean isCentered;
	float screenCenterX = Ccg_WideX(SCREEN_WIDTH) / 2.0f;  // Proper widescreen center
	float screenCenterY = SCREEN_HEIGHT / 2.0f;            // 240.0f

	// Spree names matching the thresholds
	static const char *spreeNames[] = {
		"Killing Spree!",
		"Rampage!",
		"Dominating!",
		"Unstoppable!",
		"GODLIKE!",
		"WICKED SICK!"
	};

	// Base sizes - smaller for levels 0-4 (5-25 kills), bigger for level 5 (50 kills)
	static const float levelNumberScales[] = { 1.1f, 1.1f, 1.1f, 1.1f, 1.1f, 1.8f };
	static const float levelTextScales[] = { 0.40f, 0.40f, 0.40f, 0.40f, 0.40f, 0.90f };
	static const float levelNameScales[] = { 0.26f, 0.26f, 0.26f, 0.26f, 0.26f, 0.50f };

	// Don't draw if no active spree display
	if (cg.killSpreeDisplayTime == 0) {
		// Still draw confetti if active
		CG_DrawConfetti(1.0f);
		return;
	}

	// Calculate elapsed time and alpha for fade
	elapsed = cg.time - cg.killSpreeDisplayTime;

	// Display for 4 seconds total, fade out last 1 second (longer for 50 kills)
	int displayTime = (cg.killSpreeDisplayLevel >= 5) ? 6000 : 4000;
	int fadeTime = 1000;

	if (elapsed > displayTime) {
		cg.killSpreeDisplayTime = 0;  // Reset display
		CG_DrawConfetti(1.0f);  // Keep drawing confetti
		return;
	}

	if (elapsed > (displayTime - fadeTime)) {
		alpha = 1.0f - ((float)(elapsed - (displayTime - fadeTime)) / fadeTime);
	} else {
		alpha = 1.0f;
	}

	// Draw confetti for 100 kills
	CG_DrawConfetti(alpha);

	// Flash effect - alternates between green and white every 100ms
	flashPhase = (cg.time / 100) % 2;

	// Get base scales for this level
	numberScale = levelNumberScales[cg.killSpreeDisplayLevel < 6 ? cg.killSpreeDisplayLevel : 5];
	textScale = levelTextScales[cg.killSpreeDisplayLevel < 6 ? cg.killSpreeDisplayLevel : 5];
	nameScale = levelNameScales[cg.killSpreeDisplayLevel < 6 ? cg.killSpreeDisplayLevel : 5];

	// Number pulses size (grow/shrink on 1 second cycle)
	pulse = 0.1f * sin((float)cg.time * 0.006283f);
	numberScale += pulse;

	// Only level 5 (50 kills) is centered on screen with rainbow
	isCentered = (cg.killSpreeDisplayLevel >= 5);

	// Default colors for levels 0-4: green/white flash for text, green for number
	if (flashPhase == 0) {
		Vector4Set(textColor, 0.0f, 1.0f, 0.0f, alpha);
	} else {
		Vector4Set(textColor, 1.0f, 1.0f, 1.0f, alpha);
	}
	Vector4Set(numberColor, 0.0f, 1.0f, 0.0f, alpha);
	Vector4Set(nameColor, 1.0f, 1.0f, 1.0f, alpha * 0.9f);

	// Level 5 (50 kills / WICKED SICK) gets rainbow effect
	if (cg.killSpreeDisplayLevel >= 5) {
		int colorPhase = (cg.time / 80) % 6;
		switch (colorPhase) {
			case 0: Vector4Set(numberColor, 1.0f, 0.0f, 0.0f, alpha); Vector4Set(textColor, 1.0f, 0.0f, 0.0f, alpha); break;
			case 1: Vector4Set(numberColor, 1.0f, 1.0f, 0.0f, alpha); Vector4Set(textColor, 1.0f, 1.0f, 0.0f, alpha); break;
			case 2: Vector4Set(numberColor, 0.0f, 1.0f, 0.0f, alpha); Vector4Set(textColor, 0.0f, 1.0f, 0.0f, alpha); break;
			case 3: Vector4Set(numberColor, 0.0f, 1.0f, 1.0f, alpha); Vector4Set(textColor, 0.0f, 1.0f, 1.0f, alpha); break;
			case 4: Vector4Set(numberColor, 0.0f, 0.0f, 1.0f, alpha); Vector4Set(textColor, 0.0f, 0.0f, 1.0f, alpha); break;
			case 5: Vector4Set(numberColor, 1.0f, 0.0f, 1.0f, alpha); Vector4Set(textColor, 1.0f, 0.0f, 1.0f, alpha); break;
		}
	}

	// Prepare text strings
	Com_sprintf(killsText, sizeof(killsText), "%d", cg.killSpreeDisplayKills);
	if (cg.killSpreeDisplayLevel < 6) {
		Q_strncpyz(spreeText, spreeNames[cg.killSpreeDisplayLevel], sizeof(spreeText));
	} else {
		Q_strncpyz(spreeText, "WICKED SICK!", sizeof(spreeText));
	}

	if (isCentered) {
		// CENTERED LAYOUT for 50 kills (WICKED SICK)
		// Number on top, spree text below, name below that - all centered

		// Calculate vertical positions (centered around screen center)
		float numberHeight = 50.0f * numberScale;
		float textHeight = 30.0f * textScale;
		float nameHeight = 20.0f * nameScale;
		float totalHeight = numberHeight + textHeight + nameHeight + 20.0f;  // 20px spacing
		float startY = screenCenterY - totalHeight / 2.0f + numberHeight;

		// Draw number (centered)
		CG_DrawTextCenteredWithOutline(screenCenterX, startY, numberScale, numberScale, numberColor, killsText, &cgs.media.impactFont, 2.5f);

		// Draw spree text below number (centered)
		CG_DrawTextCenteredWithOutline(screenCenterX, startY + textHeight + 15.0f, textScale, textScale, textColor, spreeText, &cgs.media.impactFont, 2.0f);

		// Draw player name below spree text (centered)
		textWidth = CG_Text_Width_Ext(cg.killSpreeDisplayName, nameScale, 0, &cgs.media.impactFont);
		CG_Text_Paint_Ext(screenCenterX - textWidth / 2.0f, startY + textHeight + nameHeight + 35.0f, nameScale, nameScale, nameColor, cg.killSpreeDisplayName, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.impactFont);
	} else {
		// UPPER-LEFT LAYOUT for 5/10/15/20/25 kills
		// Number on left, spree text and name to the right

		x = 10.0f;
		float textY = 190.0f;   // Text vertical position (spree text and name)
		float numberY = 212.0f; // Number vertical position (moved down from text)

		// Fixed text position based on number of digits
		float baseNumberScale = levelNumberScales[0];  // Base scale without pulse
		int fixedNumberWidth;
		float textX;

		if (cg.killSpreeDisplayKills < 10) {
			// Single digit (5)
			fixedNumberWidth = CG_Text_Width_Ext("5", baseNumberScale, 0, &cgs.media.impactFont);
			textX = x + fixedNumberWidth + 6.0f;
		} else if (cg.killSpreeDisplayKills < 20) {
			// 10, 15
			fixedNumberWidth = CG_Text_Width_Ext("15", baseNumberScale, 0, &cgs.media.impactFont);
			textX = x + fixedNumberWidth + 6.0f;
		} else {
			// 20, 25
			fixedNumberWidth = CG_Text_Width_Ext("25", baseNumberScale, 0, &cgs.media.impactFont);
			textX = x + fixedNumberWidth + 8.0f;
		}

		// Draw kill count number (pulses size)
		CG_DrawTextWithOutline(x, numberY, numberScale, numberScale, numberColor, killsText, &cgs.media.impactFont, 2.0f);

		// Draw spree text at fixed position
		CG_DrawTextWithOutline(textX, textY, textScale, textScale, textColor, spreeText, &cgs.media.impactFont, 1.5f);

		// Draw player name below spree text
		CG_Text_Paint_Ext(textX, textY + 20.0f, nameScale, nameScale, nameColor, cg.killSpreeDisplayName, 0, 0, ITEM_TEXTSTYLE_SHADOWED, &cgs.media.impactFont);
	}

	// Reset render state after all drawing to prevent artifacts
	trap_R_SetColor(NULL);
}

