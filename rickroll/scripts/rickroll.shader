// Rick Roll Mode Shaders
// For ET:Legacy custom server mod

// Dancing Rick Astley sprite sheet
// 2048x512 texture, 8x3 grid = 20 frames at 256x170 each
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

// Wheel frame/border (optional decorative element)
gfx/rickroll/wheel_frame
{
	nopicmip
	nomipmaps
	{
		map gfx/rickroll/wheel_frame.tga
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		rgbGen vertex
		alphaGen vertex
	}
}

// Screen overlay for darkening background
gfx/rickroll/overlay
{
	nopicmip
	nomipmaps
	{
		map $whiteimage
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		rgbGen vertex
		alphaGen vertex
	}
}

// Glow effect for "spotlight" curse
gfx/rickroll/player_glow
{
	nopicmip
	cull none
	{
		map gfx/rickroll/glow.tga
		blendFunc GL_ONE GL_ONE
		rgbGen entity
		tcMod rotate 30
	}
}

// Wheel selection highlight
gfx/rickroll/wheel_highlight
{
	nopicmip
	nomipmaps
	{
		map $whiteimage
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		rgbGen const ( 1.0 0.8 0.0 )
		alphaGen const 0.3
	}
}

// Frozen player effect - blue ice glow overlay
// Used for panzer freeze and narcolepsy effects
entityFrozen
{
	cull none
	nofog
	{
		map $whiteimage
		blendFunc GL_SRC_ALPHA GL_ONE
		rgbGen const ( 0.2 0.5 1.0 )
		alphaGen wave sin 0.3 0.2 0 2
	}
}

// God mode effect - pulsing golden glow
entityGodMode
{
	cull none
	nofog
	{
		map $whiteimage
		blendFunc GL_SRC_ALPHA GL_ONE
		rgbGen const ( 1.0 0.75 0.0 )
		alphaGen wave sin 0.4 0.35 0 1.5
	}
}
