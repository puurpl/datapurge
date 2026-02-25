#!/usr/bin/env bash
# datapurge-claude.sh — Wrapper script for Claude Code
#
# This script is called by cron to use Claude Code for
# maintaining the broker registry. It wraps the agent.py
# functionality with Claude Code's full capabilities.
#
# Usage:
#   ./datapurge-claude.sh                  # Full daily maintenance
#   ./datapurge-claude.sh reports          # Process community reports
#   ./datapurge-claude.sh verify           # Verify stale brokers
#   ./datapurge-claude.sh discover         # Find new brokers
#   ./datapurge-claude.sh add-broker URL   # Research and add a specific broker
#
# Cron example:
#   0 3 * * * cd /path/to/datapurge && ./datapurge-claude.sh >> logs/claude-code.log 2>&1

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

log() {
    echo "[$TIMESTAMP] $*" | tee -a "$LOG_DIR/claude-code-$DATE.log"
}

# Ensure we're in the git repo
if [ ! -d .git ]; then
    log "ERROR: Not a git repository. Run from the datapurge project root."
    exit 1
fi

# Pull latest changes
log "Pulling latest changes..."
git pull --rebase 2>/dev/null || true

MODE="${1:-full}"

case "$MODE" in

    full)
        log "Starting full daily maintenance..."
        
        # Run the Python agent which calls Claude API directly
        python -m server.agent 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        
        # Validate all broker YAML files
        log "Validating broker definitions..."
        python -c "
from server.registry import BrokerRegistry
reg = BrokerRegistry('brokers')
print(f'Registry loaded: {reg.count()} brokers')
stats = reg.get_stats()
for k, v in stats.items():
    print(f'  {k}: {v}')
" 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        
        # Export registry JSON for API
        log "Exporting registry JSON..."
        python -c "
from server.registry import BrokerRegistry
BrokerRegistry('brokers').export_json('registry.json')
print('registry.json exported')
"
        
        # Commit and push
        if [ -n "$(git status --porcelain)" ]; then
            log "Committing changes..."
            git add -A
            git commit -m "[agent] Daily maintenance: $DATE" \
                -m "$(cat "$LOG_DIR/agent-$DATE.log" | tail -20)"
            git push
            log "Changes pushed."
        else
            log "No changes to commit."
        fi
        ;;

    reports)
        log "Processing community reports..."
        python -m server.agent --reports 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        ;;

    verify)
        log "Verifying stale brokers..."
        python -m server.agent --verify 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        ;;

    discover)
        log "Running broker discovery..."
        python -m server.agent --discover 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        ;;

    add-broker)
        URL="${2:-}"
        if [ -z "$URL" ]; then
            echo "Usage: $0 add-broker <broker-url>"
            exit 1
        fi
        log "Researching broker: $URL"
        
        # Use Claude Code to research and create the broker definition
        # This is where Claude Code shines — it can browse the site,
        # figure out the opt-out process, and create the YAML
        claude --print "Research the data broker at $URL. 
Visit their website, find their opt-out/removal process, and create a 
complete broker YAML definition following the schema in schema/broker.schema.json.
Save the YAML file to the appropriate category directory under brokers/.
Include scan detection rules if the broker has public people search.
Set confidence based on how certain you are about the procedure." \
            2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        ;;

    drip)
        log "Sending daily email drip..."
        python -m server.agent --drip 2>&1 | tee -a "$LOG_DIR/agent-$DATE.log"
        ;;

    *)
        echo "Usage: $0 {full|reports|verify|discover|add-broker|drip}"
        exit 1
        ;;

esac

log "Done."
