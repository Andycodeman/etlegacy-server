#!/bin/bash
#
# ET Server Monitor Script
# ========================
#
# Features:
# 1. Monitors server health via UDP query - restarts if down
# 2. Sends notifications via ntfy.sh
# 3. Notifies when players connect (with list of other players)
#
# Configuration:
RCON_PASSWORD="emma01"
SERVER_HOST="127.0.0.1"
SERVER_PORT="27960"
NTFY_TOPIC="etman-server"
NTFY_TOPIC_PLAYERS="etman-server-player-connected"
NTFY_URL="https://ntfy.sh"
CHECK_INTERVAL=15          # Seconds between health checks
LOG_FILE="/home/andy/etlegacy/et-monitor.log"

# State tracking
declare -A KNOWN_PLAYERS      # Track players we have already notified about (persists across map changes)
declare -A CLIENT_ID_TO_NAME  # Map client slot IDs to player names
CURRENT_MAP=""                # Track current map to detect map changes

#
# Logging
#
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

#
# Send notification via ntfy
#
notify() {
    local title="$1"
    local message="$2"
    local priority="${3:-default}"  # default, low, high, urgent
    local topic="${4:-$NTFY_TOPIC}"

    curl -s -o /dev/null \
        -H "Title: $title" \
        -H "Priority: $priority" \
        -H "Tags: video_game" \
        -d "$message" \
        "$NTFY_URL/$topic" &

    log "NOTIFY [$topic]: [$priority] $title - $message"
}

#
# Send rcon command to server
#
rcon() {
    local cmd="$1"
    echo -e "\xff\xff\xff\xffrcon $RCON_PASSWORD $cmd" | \
        nc -u -w2 "$SERVER_HOST" "$SERVER_PORT" 2>/dev/null | \
        tr -d '\xff' | tail -c +5
}

#
# Query server status via UDP (getstatus) and return player list
#
get_server_status() {
    echo -e "\xff\xff\xff\xffgetstatus" | \
        nc -u -w3 "$SERVER_HOST" "$SERVER_PORT" 2>/dev/null
}

#
# Check if server is alive
# Returns 0 if server responds, 1 if not
#
check_server_alive() {
    local response
    response=$(get_server_status)

    if [[ -n "$response" && "$response" == *"sv_hostname"* ]]; then
        return 0
    else
        return 1
    fi
}

#
# Get list of human players currently on server
#
get_human_players() {
    local response
    response=$(get_server_status)

    # Parse player lines (format: score ping "name")
    # Filter out bots (they have 0 ping typically, but better to check name)
    echo "$response" | grep -E '^[0-9]+ [0-9]+ "' | while read -r line; do
        # Extract player name from between quotes
        if [[ "$line" =~ \"([^\"]+)\" ]]; then
            local name="${BASH_REMATCH[1]}"
            # Skip bots
            if [[ "$name" != *"[BOT]"* ]]; then
                echo "$name"
            fi
        fi
    done
}

#
# Restart the ET server
#
restart_server() {
    log "Restarting ET server..."
    sudo systemctl restart etserver
    sleep 5

    if check_server_alive; then
        log "Server restarted successfully"
        notify "ET Server Restarted" "Server was down and has been automatically restarted" "high"
        return 0
    else
        log "ERROR: Server failed to restart!"
        notify "ET Server FAILED to Restart" "Manual intervention required!" "urgent"
        return 1
    fi
}

#
# Handle player connection and send notification
#
handle_player_connect() {
    local player_name="$1"

    # Skip bots
    if [[ "$player_name" == *"[BOT]"* ]]; then
        return
    fi

    # Skip if we already notified about this player
    if [[ -n "${KNOWN_PLAYERS[$player_name]}" ]]; then
        log "Player $player_name already known, skipping notification"
        return
    fi

    # Mark as known
    KNOWN_PLAYERS[$player_name]=1

    # Get list of other human players
    local other_players=""
    local player_count=0
    while IFS= read -r p; do
        if [[ -n "$p" && "$p" != "$player_name" ]]; then
            if [[ -n "$other_players" ]]; then
                other_players="$other_players, $p"
            else
                other_players="$p"
            fi
            player_count=$((player_count + 1))
        fi
    done < <(get_human_players)

    # Build notification message
    local message
    if [[ -n "$other_players" ]]; then
        message="Also online: $other_players ($player_count other player(s))"
    else
        message="First player on the server!"
    fi

    log "Player connected: $player_name - $message"
    notify "Player Connected: $player_name" "$message" "default" "$NTFY_TOPIC_PLAYERS"
}

#
# Monitor server logs for events
#
monitor_logs() {
    log "Starting log monitor..."

    # Use journalctl to follow server logs
    sudo journalctl -u etserver -f -n 0 --no-pager 2>/dev/null | while read -r line; do
        # ===================
        # Player connection detection
        # ===================
        # Trigger on "entered the game" broadcast message
        if [[ "$line" == *'entered the game'* ]]; then
            # Extract player name from: broadcast: print "NAME entered the game\n"
            local player_name
            player_name=$(echo "$line" | sed -n 's/.*broadcast: print "\([^"]*\) entered the game.*/\1/p')

            if [[ -n "$player_name" ]]; then
                handle_player_connect "$player_name"
            fi
        fi

        # ===================
        # Track client ID to player name mapping
        # ===================
        # ClientUserinfoChanged: 0 n\ETMan\t\3\...
        if [[ "$line" == *'ClientUserinfoChanged:'* ]]; then
            local client_id player_name
            client_id=$(echo "$line" | sed -n 's/.*ClientUserinfoChanged: \([0-9]*\).*/\1/p')
            player_name=$(echo "$line" | grep -oP 'n\\[^\\]+' | sed 's/n\\//')

            if [[ -n "$client_id" && -n "$player_name" ]]; then
                CLIENT_ID_TO_NAME[$client_id]="$player_name"
            fi
        fi

        # ===================
        # Player disconnect detection - remove from known players
        # ===================
        # ClientDisconnect: 0
        if [[ "$line" == *'ClientDisconnect:'* ]]; then
            local client_id player_name
            client_id=$(echo "$line" | sed -n 's/.*ClientDisconnect: \([0-9]*\).*/\1/p')
            player_name="${CLIENT_ID_TO_NAME[$client_id]}"

            if [[ -n "$player_name" ]]; then
                unset "KNOWN_PLAYERS[$player_name]"
                unset "CLIENT_ID_TO_NAME[$client_id]"
                log "Player disconnected: $player_name (slot $client_id, removed from known players)"
            fi
        fi
    done
}

#
# Main health check loop
#
health_check_loop() {
    local consecutive_failures=0

    log "Starting health check loop (interval: ${CHECK_INTERVAL}s)..."

    while true; do
        if check_server_alive; then
            if [[ $consecutive_failures -gt 0 ]]; then
                log "Server recovered after $consecutive_failures failed checks"
            fi
            consecutive_failures=0
        else
            consecutive_failures=$((consecutive_failures + 1))
            log "Server check failed ($consecutive_failures consecutive)"

            # After 2 consecutive failures, restart
            if [[ $consecutive_failures -ge 2 ]]; then
                notify "ET Server Down" "Server not responding, attempting restart..." "urgent"
                restart_server
                consecutive_failures=0
            fi
        fi

        sleep "$CHECK_INTERVAL"
    done
}

#
# Main entry point
#
main() {
    log "========================================"
    log "ET Server Monitor Starting"
    log "Server: $SERVER_HOST:$SERVER_PORT"
    log "NTFY Topic: $NTFY_TOPIC"
    log "NTFY Players Topic: $NTFY_TOPIC_PLAYERS"
    log "Check Interval: ${CHECK_INTERVAL}s"
    log "========================================"

    # Test notification on startup
    notify "ET Monitor Started" "Server monitoring is now active" "low"

    # Start log monitor in background
    monitor_logs &
    LOG_MONITOR_PID=$!

    # Cleanup on exit
    trap "kill $LOG_MONITOR_PID 2>/dev/null; log 'Monitor stopped'; exit 0" SIGINT SIGTERM

    # Run health check loop in foreground
    health_check_loop
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
