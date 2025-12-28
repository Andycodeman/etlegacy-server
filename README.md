# ET:Legacy Server - ETMan's Custom Build

Custom ET:Legacy server with Lua scripting for gameplay modifications.

## Quick Start

```bash
# Install dependencies (Ubuntu)
sudo apt-get install build-essential cmake git \
    libsdl2-dev libglew-dev libopenal-dev \
    libcurl4-openssl-dev libpng-dev libjpeg-dev \
    zlib1g-dev libminizip-dev libfreetype6-dev \
    liblua5.4-dev libsqlite3-dev

# Initialize submodule
git submodule update --init --recursive

# Build
./scripts/build.sh

# Deploy to local server
./scripts/deploy.sh

# Deploy to production
./scripts/publish.sh
```

## Project Structure

```
├── src/          # ET:Legacy source (submodule)
├── configs/      # Server configuration
├── lua/          # Custom Lua scripts
├── maps/         # Map pk3 files
├── waypoints/    # Omni-bot navigation
├── scripts/      # Build/deploy scripts
└── docs/         # Documentation
```

## Documentation

See [CLAUDE.md](CLAUDE.md) for detailed documentation.

## Connect

```
/connect et.etman.dev:27960
```

## License

ET:Legacy is licensed under GPLv3. Custom scripts in this repo are MIT licensed.
