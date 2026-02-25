# DataPurge

**Open-source data broker deletion at scale.** Exercise your privacy rights against hundreds of data brokers with minimal effort. Make it expensive for them to hold your data.

## What It Does

DataPurge maintains a community-driven database of data broker opt-out procedures and helps you contact every single one:

- **Web visitors**: Enter your name and email once. Get a queue of pre-filled opt-out emails to send, one by one. Or subscribe to a daily email drip that feeds you 3-5 brokers per day to contact.
- **CLI users**: Full automation — scan brokers for your data, auto-submit opt-out requests via email and web forms, monitor for re-listing, and re-submit automatically.
- **The registry**: A Claude-maintained database of broker opt-out procedures. Updated daily. Community contributions welcome.

## Philosophy

Data brokers profit from an asymmetry: it's trivially easy for them to collect your data and brutally hard for you to get it removed. DataPurge flips that. Every opt-out request a broker has to process costs them time and money. Every documented request creates a paper trail. Every explicit withdrawal of consent creates future legal liability as privacy laws evolve.

We don't wait to confirm presence. We send preemptive deletion demands to every broker. We cite every applicable law. We make their legal teams work for it.

## Quick Start

### Option 1: Web UI (No install)

Visit **[datapurge.org]** and start sending opt-out emails from your browser. Your data never touches our server — all template filling happens client-side.

### Option 2: Email Drip (No install)

Sign up at **[datapurge.org/drip]** and we'll send you 3-5 pre-filled opt-out emails per day. Just click the mailto: links and hit send. We'll get through all ~200+ brokers in a couple months.

### Option 3: CLI (Full automation)

```bash
# Install
pip install datapurge

# Initialize (generates encryption key for your PII)
datapurge init

# Add your identity
datapurge add-profile "Your Name"

# Pull the latest broker registry
datapurge pull

# Scan all brokers for your data
datapurge scan

# Send opt-out requests to everyone
datapurge purge

# Set up automatic monitoring
datapurge install-cron
```

## How the Registry is Maintained

A Claude-powered agent runs daily to:

1. **Process community reports** of new or broken broker procedures
2. **Verify existing entries** — re-checks broker opt-out pages for changes
3. **Discover new brokers** — searches state registries and privacy news
4. **Git commits all changes** — full version history and transparency

The agent uses web search to verify procedures and only auto-updates when confidence is above 80%. Low-confidence changes are flagged for manual review.

## Contributing

### Report a Broker

Found a data broker we're missing? Or an opt-out process that's changed?

- **Web**: Use the report form at [datapurge.org/report]
- **API**: `POST /api/v1/reports`
- **Git**: Add a YAML file to `brokers/` and submit a PR

### Broker YAML Format

```yaml
id: example-broker
name: Example Broker
domain: example.com
category: people-search
data_types: [name, address, phone, email]

scan:
  scannable: true
  method: web_search
  search_url: "https://example.com/search?q={first_name}+{last_name}"
  detection:
    - method: selector_present
      value: ".result-card"
      means: listed

optout:
  methods:
    - type: email
      email_to: privacy@example.com
      required_fields: [full_name, email]
      template_id: preemptive_blanket
  difficulty: easy

legal:
  ccpa: true
  state_laws: [california, virginia]

timing:
  relisting_likelihood: medium
  recheck_interval_days: 30

meta:
  added: "2026-02-25"
  confidence: 0.9
```

See `schema/broker.schema.json` for the full schema.

## Legal Templates

Every opt-out request includes:

- **Deletion demand** under all applicable laws
- **Right to Know request** — forces disclosure of what they held and who they shared it with
- **Explicit withdrawal of consent** — documented objection to all future processing
- **Pre-emptive objection** — even if they don't hold data now, the record exists
- **Non-compliance follow-up** — automated escalation when deadlines pass
- **Re-listing challenge** — documents willful re-addition of data after removal

Templates cite every plausibly applicable law. This is intentional — it's the broker's problem to determine which apply, and that determination costs them legal review time.

## API

```
GET  /api/v1/registry              # Full registry (for CLI sync)
GET  /api/v1/brokers               # Searchable broker list
GET  /api/v1/brokers/{id}          # Broker detail
GET  /api/v1/email-queue           # Email drip queue (templates with placeholders)
GET  /api/v1/templates             # Legal templates
GET  /api/v1/stats                 # Registry stats
POST /api/v1/reports               # Submit community report
POST /api/v1/mailing-list/signup   # Subscribe to email drip
```

## Self-Hosting

```bash
git clone https://github.com/you/datapurge
cd datapurge
pip install -e .

# Set up the daily agent
export ANTHROPIC_API_KEY="sk-ant-..."
crontab -e
# Add: 0 3 * * * cd /path/to/datapurge && ./datapurge-claude.sh

# Run the web server
uvicorn server.api:app --host 0.0.0.0 --port 8000
```

## License

AGPL-3.0 — If you use this code, you must share your improvements.
The broker registry YAML files are released under CC0 (public domain).
