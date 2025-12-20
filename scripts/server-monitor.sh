#!/bin/bash
#
# ET Server Health Monitor
# ========================
#
# Purpose: Monitor server health and restart if down
# Player notifications are handled by Lua (more reliable)
#
# Configuration:
SERVER_HOST="127.0.0.1"
SERVER_PORT="27960"
NTFY_TOPIC="etman-server"
NTFY_URL="https://ntfy.sh"
CHECK_INTERVAL=15          # Seconds between health checks
LOG_FILE="/home/andy/etlegacy/et-monitor.log"

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
# Query server status via UDP (getstatus)
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
# Main health check loop
#
health_check_loop() {
    local consecutive_failures=0

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
    log "ET Server Health Monitor Starting"
    log "Server: $SERVER_HOST:$SERVER_PORT"
    log "Check Interval: ${CHECK_INTERVAL}s"
    log "========================================"

    # Test notification on startup
    notify "ET Monitor Started" "Server health monitoring active" "low"

    # Cleanup on exit
    trap "log 'Monitor stopped'; exit 0" SIGINT SIGTERM

    # Run health check loop
    health_check_loop
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
