#!/bin/bash
# Deploy etpanel to Hetzner VPS

set -e

VPS_HOST="andy@5.78.83.59"
VPS_PATH="/home/andy/etpanel"

echo "🚀 Deploying etpanel to VPS..."

# Build backend
echo "📦 Building backend..."
cd backend
npm run build
cd ..

# Build frontend
echo "📦 Building frontend..."
cd frontend
npm run build
cd ..

# Sync to VPS
echo "📤 Syncing to VPS..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '*.log' \
  backend/ ${VPS_HOST}:${VPS_PATH}/backend/

# Copy production env file
echo "📋 Copying production environment..."
scp backend/.env.production ${VPS_HOST}:${VPS_PATH}/backend/.env

# Sync shared types
rsync -avz shared/ ${VPS_HOST}:${VPS_PATH}/shared/

# Sync frontend build
echo "📤 Syncing frontend..."
rsync -avz --delete frontend/dist/ ${VPS_HOST}:${VPS_PATH}/frontend/dist/

# Install deps and restart on VPS
echo "🔧 Installing deps and restarting service..."
ssh ${VPS_HOST} << 'EOF'
cd ~/etpanel/backend
npm install --production

# Kill existing process and restart
pkill -f 'node dist/index.js' 2>/dev/null || true
sleep 1
nohup node dist/index.js >> /tmp/etpanel.log 2>&1 &
sleep 2

# Verify it's running
if curl -s http://localhost:3000/health > /dev/null; then
  echo "✓ Backend running"
else
  echo "✗ Backend failed to start"
  tail -20 /tmp/etpanel.log
  exit 1
fi
EOF

echo "✅ Deploy complete!"
