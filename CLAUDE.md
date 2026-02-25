# CLAUDE.md — DataPurge Project Instructions

## Project Overview

DataPurge is an open-source tool that helps people exercise their privacy rights
by automating data broker opt-out requests. It has two main components:

1. **Central Server** — Hosts the broker registry, web UI, API, and runs a daily
   Claude-powered maintenance agent that keeps broker procedures up to date.

2. **CLI Client** — Users install locally to scan brokers for their data, auto-submit
   opt-out requests, and monitor for re-listing. PII never leaves the user's machine.

## Architecture

```
datapurge/
├── brokers/          # YAML broker definitions (the core asset)
├── templates/        # Legal email/letter templates
├── schema/           # JSON Schema for validation
├── server/           # Central server (FastAPI + Claude agent)
│   ├── api.py        # REST API + email drip system
│   ├── agent.py      # Daily cron maintenance agent
│   ├── registry.py   # Broker registry library
│   ├── templates.py  # Template engine
│   └── web/          # Web UI (Jinja2 templates + static)
├── client/           # CLI client (user installs this)
└── docs/             # Documentation
```

## Key Design Principles

- **PII never touches the server.** Templates have {placeholders} that are filled client-side.
- **The broker YAML database is the core product.** Everything else is execution against it.
- **Legal templates maximize pressure and future liability.** Every template includes
  consent withdrawal, disclosure demands, and paper trail creation.
- **The daily Claude agent maintains the registry.** It processes community reports,
  verifies stale entries, and discovers new brokers. It uses web search.
- **Preemptive requests are the default.** Don't wait to confirm presence — send
  deletion demands to every broker regardless. This costs brokers more.

## Adding Brokers

Broker YAML files go in `brokers/{category}/`. See `schema/broker.schema.json` for
the full schema. Key fields:

- `id`: unique slug
- `scan`: how to check if someone is listed (for scannable brokers)
- `optout.methods[]`: each method (email, web_form, postal, etc.) with full procedure
- `legal`: which laws apply
- `timing`: expected processing time and re-listing likelihood

## Running the Agent

```bash
# Full daily run
python -m server.agent

# Process community reports only
python -m server.agent --reports

# Verify stale brokers
python -m server.agent --verify

# Weekly discovery
python -m server.agent --discover
```

## Development Commands

```bash
# Run server locally
uvicorn server.api:app --reload --port 8000

# Run tests
pytest

# Lint
ruff check .

# Export registry as JSON
python -c "from server.registry import BrokerRegistry; BrokerRegistry().export_json('registry.json')"
```

## When Adding New Features

- Always consider the "web visitor" path: can someone use this without installing anything?
- Email-based methods are preferred because they create paper trails
- Every broker contact should include consent withdrawal language
- Templates should reference every plausibly applicable law — make the broker's legal team sort it out
- Test broker YAML files against the JSON Schema before committing

## Strategic Notes

The goal is to make it as expensive as possible for data brokers to operate.
Every request they process costs money. Every paper trail creates liability.
Every consent withdrawal may become legally enforceable as laws change.
Volume matters — even if individual requests are ignored, the aggregate
operational cost of processing thousands of requests hurts their margins.
