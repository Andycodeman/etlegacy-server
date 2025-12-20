# Rick Roll Mode Assets

This directory contains assets for Rick Roll Mode that get packaged into a pk3 for client download.

## Structure

```
rickroll/
├── gfx/rickroll/
│   └── rick_spritesheet.tga   # 2048x512, 20-frame animation
├── sound/rickroll/
│   └── rickroll.wav           # 18.67s, "Never Gonna Give You Up"
└── scripts/
    └── rickroll.shader        # Shader definitions
```

## Building

```bash
./scripts/build-rickroll-pk3.sh
```

This creates `dist/rickroll_YYYYMMDD.pk3`

## Deployment

The pk3 is automatically included when running `./scripts/publish.sh`

## Asset Specifications

### rick_spritesheet.tga
- Dimensions: 2048x512
- Format: TGA with alpha
- Layout: 8 columns × 3 rows (20 frames used)
- Frame size: 256x170
- Animation: 10 FPS dancing loop

### rickroll.wav
- Duration: 18.67 seconds
- Format: PCM WAV, 16-bit, Stereo
- Sample rate: 22050 Hz
- Size: ~1.65 MB
