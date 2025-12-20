#!/bin/bash
#
# ET:Legacy Server - Connection Log Analyzer
# Shows player connections and any issues they encountered
#
# Usage:
#   ./check-connections.sh              # Last 2 hours
#   ./check-connections.sh 6h           # Last 6 hours
#   ./check-connections.sh 1d           # Last 1 day
#   ./check-connections.sh "2025-12-19" # Specific date

REMOTE_HOST="andy@5.78.83.59"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Parse time argument
TIME_ARG="${1:-2h}"

# Convert to journalctl format
case "$TIME_ARG" in
    *h) SINCE="--since '${TIME_ARG%h} hours ago'" ;;
    *d) SINCE="--since '${TIME_ARG%d} days ago'" ;;
    *-*) SINCE="--since '$TIME_ARG'" ;;
    *) SINCE="--since '$TIME_ARG hours ago'" ;;
esac

echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          ET:Legacy Connection Log Analyzer                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Time range:${NC} $TIME_ARG ago to now"
echo ""

# Get logs and process them
ssh "$REMOTE_HOST" "journalctl -u etserver $SINCE 2>/dev/null" | awk '
BEGIN {
    RED="\033[0;31m"
    GREEN="\033[0;32m"
    YELLOW="\033[1;33m"
    BLUE="\033[0;34m"
    CYAN="\033[0;36m"
    NC="\033[0m"

    pending_checksum = ""
    pending_checksum_time = ""
}

# Extract timestamp from every line
{
    timestamp = $1 " " $2 " " $3
}

# Get player name and info from userinfo (skip bots)
/Userinfo:.*\\name\\/ && !/OMNIBOT/ && !/localhost/ {
    # Extract name
    if (match($0, /\\name\\([^\\]+)\\/, arr)) {
        name = arr[1]
    } else if (match($0, /\\name\\([^\\]+)$/, arr)) {
        name = arr[1]
    }

    # Extract IP
    if (match($0, /\\ip\\([^\\]+)\\/, arr)) {
        ip = arr[1]
    } else if (match($0, /\\ip\\([^\\]+)$/, arr)) {
        ip = arr[1]
    }

    # Extract client version
    version = ""
    if (match($0, /\\etVersion\\([^\\]+)\\/, arr)) {
        version = arr[1]
    }
    if (version == "" && match($0, /\\cg_etVersion\\([^\\]+)\\/, arr)) {
        version = arr[1]
    }

    # Only track real players
    if (name != "" && name !~ /^\[BOT\]/) {
        # Create unique key for this connection attempt
        key = name "_" timestamp

        # If we already have this player from same timestamp, update
        # Otherwise check if this is a new connection
        found = 0
        for (k in player_name) {
            if (player_name[k] == name && player_time[k] == timestamp) {
                found = 1
                existing_key = k
                break
            }
        }

        if (!found) {
            # New connection attempt
            conn_count++
            key = conn_count
            player_name[key] = name
            player_time[key] = timestamp
            player_order[key] = conn_count
        } else {
            key = existing_key
        }

        player_ip[key] = ip
        player_version[key] = version
        current_player_key = key
    }
}

# Download redirect
/Redirecting client/ {
    if (match($0, /Redirecting client \047([^\047]+)\047/, arr)) {
        pname = arr[1]
        for (k in player_name) {
            if (player_name[k] == pname && !player_final[k]) {
                player_download[k] = 1
                if (match($0, /to (.+)$/, arr2)) {
                    player_download_file[k] = arr2[1]
                }
            }
        }
    }
}

# Checksum mismatch - store it, will be associated with next disconnect
/nChkSum1.*==/ {
    pending_checksum = $0
    pending_checksum_time = timestamp
}

# Client disconnect
/ClientDisconnect:/ {
    # If there was a pending checksum error at same timestamp, associate it
    if (pending_checksum != "" && pending_checksum_time == timestamp) {
        # Find most recent non-finalized player
        for (k in player_name) {
            if (!player_final[k]) {
                player_checksum_error[k] = pending_checksum
                player_kicked[k] = 1
                player_final[k] = 1
            }
        }
        pending_checksum = ""
    }
}

# Successful team join means they actually got in
/ClientUserinfoChanged:.*\\t\\[123]\\/ && !/OMNIBOT/ {
    # Player picked a team - they are in the game
    if (match($0, /n\\([^\\]+)\\/, arr)) {
        pname = arr[1]
        if (pname !~ /^\[BOT\]/) {
            for (k in player_name) {
                if (player_name[k] == pname && !player_kicked[k]) {
                    player_joined[k] = 1
                }
            }
        }
    }
}

END {
    printf "\n"
    printf CYAN "═══════════════════════════════════════════════════════════════\n" NC
    printf CYAN "                    PLAYER CONNECTIONS\n" NC
    printf CYAN "═══════════════════════════════════════════════════════════════\n" NC
    printf "\n"

    count = 0
    issues = 0

    # Sort by order
    for (k in player_name) {
        order[k] = player_order[k]
    }

    # Print in order
    for (i = 1; i <= conn_count; i++) {
        for (k in player_order) {
            if (player_order[k] == i) {
                count++
                name = player_name[k]

                printf BLUE "▸ %s" NC "\n", name
                printf "  Time:    %s\n", player_time[k]
                if (player_ip[k] != "") printf "  IP:      %s\n", player_ip[k]
                if (player_version[k] != "") printf "  Client:  %s\n", player_version[k]

                if (player_download[k]) {
                    printf "  Download: %s\n", player_download_file[k]
                }

                # Determine status
                if (player_checksum_error[k]) {
                    printf "  Status:  " RED "✗ KICKED - sv_pure checksum mismatch" NC "\n"
                    # Extract the actual checksum values
                    if (match(player_checksum_error[k], /nChkSum1 ([0-9-]+) == ([0-9-]+)/, arr)) {
                        printf "  Error:   Server expects %s, client has %s\n", arr[2], arr[1]
                    }
                    issues++
                } else if (player_joined[k]) {
                    printf "  Status:  " GREEN "✓ Joined successfully" NC "\n"
                } else if (player_download[k]) {
                    printf "  Status:  " YELLOW "? Downloaded pk3, may have disconnected" NC "\n"
                    issues++
                } else {
                    printf "  Status:  " YELLOW "? Connection attempt" NC "\n"
                }
                printf "\n"
            }
        }
    }

    if (count == 0) {
        printf YELLOW "No player connections found in this time range.\n" NC
        printf "Try a longer time range: ./check-connections.sh 6h\n"
    } else {
        printf CYAN "═══════════════════════════════════════════════════════════════\n" NC
        printf "Total connections: %d", count
        if (issues > 0) {
            printf "  |  " RED "Issues: %d" NC, issues
        }
        printf "\n"
        printf CYAN "═══════════════════════════════════════════════════════════════\n" NC
    }
}
'

echo ""
echo -e "${CYAN}Tips:${NC}"
echo "  - 'sv_pure checksum mismatch' = pk3 mismatch, player should delete their legacy/ folder cache"
echo "  - 'Downloaded pk3, may have disconnected' = download issue or player cancelled"
echo "  - Players using 'ET 2.60c' need ET:Legacy client from etlegacy.com"
echo ""
echo "  Check pk3 sync: ./scripts/publish.sh (validates checksums at end)"
