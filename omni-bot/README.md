# ETMan Omni-Bot Customizations

This folder contains custom Omni-Bot scripts for ETMan's ET:Legacy server.

## Quick Reference

| Setting | File | Default | Description |
|---------|------|---------|-------------|
| `ETMAN_DISABLE_AMMO` | `et/scripts/et_autoexec.gm` | `1` (disabled) | Toggle bot ammo pack dropping |

## Ammo Dispensing Toggle

Bot ammo pack dropping is controlled by a single flag in `et/scripts/et_autoexec.gm`:

```gm
global ETMAN_DISABLE_AMMO = 1;  // 1 = disabled, 0 = enabled
```

### To DISABLE ammo drops (default):
```gm
global ETMAN_DISABLE_AMMO = 1;
```
- Field Ops bots will NOT drop ammo packs at spawn
- Field Ops bots will NOT give themselves ammo
- Field Ops bots will NOT respond to "need ammo" voice commands
- Field Ops CAN still use airstrikes and artillery
- Medics still deliver health packs normally

### To ENABLE ammo drops:
```gm
global ETMAN_DISABLE_AMMO = 0;
```
- Full original Omni-Bot behavior restored
- Bots will drop ammo packs at spawn and on request

**After changing, restart the server for changes to take effect.**

## Modified Files

These goal scripts check the `ETMAN_DISABLE_AMMO` flag:

| File | Purpose |
|------|---------|
| `et/scripts/goals/goal_dispenseammo.gm` | Dropping ammo at spawn |
| `et/scripts/goals/goal_supplyself.gm` | Field Ops giving themselves ammo |
| `et/scripts/goals/goal_deliversupplies.gm` | Responding to "need ammo" voice |
| `et/scripts/goals/goal_askforammo.gm` | Bots saying "need ammo" voice spam |

## Class Configuration

All classes are enabled in `et/scripts/et_autoexec.gm`:

```gm
countAxis[CLASS.SOLDIER] = 99;
countAxis[CLASS.MEDIC] = 99;
countAxis[CLASS.ENGINEER] = 99;
countAxis[CLASS.COVERTOPS] = 99;
countAxis[CLASS.FIELDOPS] = 99;

countAllies[CLASS.SOLDIER] = 99;
countAllies[CLASS.MEDIC] = 99;
countAllies[CLASS.ENGINEER] = 99;
countAllies[CLASS.COVERTOPS] = 99;
countAllies[CLASS.FIELDOPS] = 99;
```

Bots need Engineers for dynamite/repairs, Medics for revives, etc.

## Waypoints

Custom waypoints for maps are in `et/nav/`:
- `baserace.gm`, `baserace.way`, `baserace_goals.gm`
- `capuzzo.gm`, `capuzzo.way`, `capuzzo_goals.gm`
- `snatch3.gm`, `snatch3.way`, `snatch3_goals.gm`
- etc.

## Deployment

These files are synced to VPS via `scripts/publish.sh`:
- `omni-bot/et/scripts/*.gm` -> synced
- `omni-bot/et/scripts/goals/*.gm` -> synced
- `omni-bot/et/nav/*.gm` and `*.way` -> synced

## Troubleshooting

### Bots still dropping ammo after disabling
1. Make sure `ETMAN_DISABLE_AMMO = 1` in `et/scripts/et_autoexec.gm`
2. Restart the server: `ssh andy@5.78.83.59 "sudo systemctl restart etserver"`
3. Verify files synced: `ssh andy@5.78.83.59 "head -20 ~/etlegacy/omni-bot/et/scripts/goals/goal_dispenseammo.gm"`

### Want to enable ammo drops for testing
1. Edit `et/scripts/et_autoexec.gm`
2. Change `global ETMAN_DISABLE_AMMO = 1;` to `global ETMAN_DISABLE_AMMO = 0;`
3. Run `./scripts/publish.sh`

## References

- [Omni-Bot Wiki](https://omnibot-enemy-territory.fandom.com/wiki/)
- [Omni-Bot GitHub](https://github.com/jswigart/omni-bot)
- [Fearless Assassins](https://fearless-assassins.com/)
