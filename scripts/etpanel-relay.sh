#!/bin/bash
#
# ETPanel Event Relay Daemon
# Reads game events from etpanel_events.json and sends them to the ETPanel API
#
# Usage:
#   ./etpanel-relay.sh              # Run in foreground
#   ./etpanel-relay.sh --daemon     # Run as background daemon
#
# The script watches the event file and sends events to the API via curl.
# Events are removed from the file after successful submission.
#

set -e

# Configuration
# NOTE: ET:Legacy writes to fs_homepath (~/.etlegacy), NOT the server basepath!
EVENT_FILE="/home/andy/.etlegacy/legacy/legacy/etpanel_events.json"
API_URL="https://etpanel.etman.dev/api"
API_KEY="214f3ddbb1098e5709661f5ace51dc21"
POLL_INTERVAL=2  # seconds
LOG_FILE="/home/andy/etlegacy/etpanel-relay.log"

# Logging
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_debug() {
    if [ "$DEBUG" = "1" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [DEBUG] $1" | tee -a "$LOG_FILE"
    fi
}

# Send event to API
send_event() {
    local event_type="$1"
    local json_data="$2"
    local endpoint=""

    case "$event_type" in
        player_connect)
            endpoint="/game/player-connect"
            ;;
        player_disconnect)
            endpoint="/game/player-disconnect"
            ;;
        kill)
            endpoint="/game/kill"
            ;;
        death)
            endpoint="/game/death"
            ;;
        chat)
            endpoint="/game/chat"
            ;;
        round_end)
            endpoint="/game/round-end"
            ;;
        *)
            log "Unknown event type: $event_type"
            return 1
            ;;
    esac

    log_debug "Sending $event_type to $API_URL$endpoint"

    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -H "X-Api-Key: $API_KEY" \
        -d "$json_data" \
        "${API_URL}${endpoint}" 2>/dev/null)

    http_code=$(echo "$response" | tail -n1)

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        log_debug "Event sent successfully: $event_type"
        return 0
    else
        log "Failed to send event: $event_type (HTTP $http_code)"
        return 1
    fi
}

# Process event file
process_events() {
    if [ ! -f "$EVENT_FILE" ]; then
        return 0
    fi

    local temp_file="${EVENT_FILE}.tmp"
    local failed_file="${EVENT_FILE}.failed"

    # Read and process each line
    while IFS= read -r line || [ -n "$line" ]; do
        if [ -z "$line" ]; then
            continue
        fi

        # Extract event type from JSON
        local event_type
        event_type=$(echo "$line" | grep -o '"event_type":"[^"]*"' | cut -d'"' -f4)

        if [ -z "$event_type" ]; then
            log "Invalid event (no event_type): $line"
            continue
        fi

        # Try to send the event
        if send_event "$event_type" "$line"; then
            log "Sent: $event_type"
        else
            # Keep failed events for retry
            echo "$line" >> "$failed_file"
        fi
    done < "$EVENT_FILE"

    # Clear the processed file
    > "$EVENT_FILE"

    # Merge failed events back if any
    if [ -f "$failed_file" ]; then
        cat "$failed_file" >> "$EVENT_FILE"
        rm -f "$failed_file"
    fi
}

# Main loop
main() {
    log "ETPanel Event Relay started"
    log "Watching: $EVENT_FILE"
    log "API: $API_URL"

    while true; do
        process_events
        sleep "$POLL_INTERVAL"
    done
}

# Handle arguments
case "${1:-}" in
    --daemon)
        log "Starting in daemon mode..."
        nohup "$0" >> "$LOG_FILE" 2>&1 &
        echo "Daemon started with PID $!"
        exit 0
        ;;
    --stop)
        pkill -f "etpanel-relay.sh" && log "Daemon stopped" || echo "No daemon running"
        exit 0
        ;;
    --status)
        if pgrep -f "etpanel-relay.sh" > /dev/null; then
            echo "Relay daemon is running"
            pgrep -f "etpanel-relay.sh"
        else
            echo "Relay daemon is not running"
        fi
        exit 0
        ;;
    --debug)
        DEBUG=1
        main
        ;;
    *)
        main
        ;;
esac
