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
#define INTRO_DURATION      800
#define WHEEL1_STOP_TIME    6000
#define WHEEL2_STOP_TIME    9000
#define WHEEL3_STOP_TIME    12000
#define ANIMATION_DURATION  18670
#define CELEBRATION_DURATION 3000

// Animation speeds
#define WHEEL_FAST_SPEED    15.0f
#define WHEEL_SLOW_SPEED    3.0f

// Intro strobe timings (drum hits)
static const int strobeTimings[] = {
	0, 150, 300, 450, 500, 650, 750, -1
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
                                   int elapsed, int stopTime, int wheelStopTime) {
	float x = baseX + cgs.wideXoffset;  // Apply widescreen offset
	float centerY = y + WHEEL_H / 2.0f;
	const char *displayText;
	float textWidth, textX, textY;
	float textScale = 0.22f;  // MUCH BIGGER text
	float slideOffset;
	float dt = cg.frametime / 1000.0f;

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
			CG_Text_Paint_Ext(textX, textY, textScale, textScale, textColor, displayText, 0, 0,
			                  ITEM_TEXTSTYLE_SHADOWED, &cgs.media.limboFont2);
		}

		// Next item
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

		// Previous item
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
	                       elapsed, WHEEL1_STOP_TIME - INTRO_DURATION, rr.wheel1StopTime);

	CG_RickRoll_DrawWheel(wheel2X, wheelsY, rr.effects, rr.effectCount,
	                       &rr.wheel2Offset, &rr.wheel2CurrentIdx, &rr.wheel2Speed,
	                       rr.wheel2Stopped, rr.resultEffect,
	                       elapsed, WHEEL2_STOP_TIME - INTRO_DURATION, rr.wheel2StopTime);

	CG_RickRoll_DrawWheel(wheel3X, wheelsY, rr.intensities, rr.intensityCount,
	                       &rr.wheel3Offset, &rr.wheel3CurrentIdx, &rr.wheel3Speed,
	                       rr.wheel3Stopped, rr.resultIntensity,
	                       elapsed, WHEEL3_STOP_TIME - INTRO_DURATION, rr.wheel3StopTime);

	CG_RickRoll_DrawResult(elapsed, resultY);

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
