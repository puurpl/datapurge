# DataPurge

**Open-source data broker deletion at scale.** Exercise your privacy rights against hundreds of data brokers with minimal effort. Make it expensive for them to hold your data.

## What It Does

DataPurge maintains a community-driven database of data broker opt-out procedures and helps you contact every single one:

- **One-click mass mailing**: Enter your info once. DataPurge generates legally-cited opt-out emails for 700+ brokers and lets you BCC them all in a single click.
- **Jurisdiction-aware templates**: Automatically selects the strongest legal template based on your location — CCPA, GDPR, state privacy laws, or blanket federal coverage.
- **Multi-profile support**: Manage separate identities (different names, emails, locations) with independent progress tracking.
- **Free monitoring pipeline**: Track response deadlines, verify removal from broker search pages, generate noncompliance notices for overdue brokers.
- **Works offline**: Installable as a PWA — your data never leaves your browser.

## Try It

Visit **[datapurge.iamnottheproduct.com](https://datapurge.iamnottheproduct.com)** and start sending opt-out emails from your browser.

Your data never touches any server — all template filling happens client-side in your browser.

## Philosophy

Data brokers profit from an asymmetry: it's trivially easy for them to collect your data and brutally hard for you to get it removed. DataPurge flips that. Every opt-out request a broker has to process costs them time and money. Every documented request creates a paper trail. Every explicit withdrawal of consent creates future legal liability as privacy laws evolve.

We don't wait to confirm presence. We send preemptive deletion demands to every broker. We cite every applicable law. We make their legal teams work for it.

## How It Works

1. **Enter your info** — Name, email, and optionally your location (for stronger legal coverage). Everything stays in your browser's local storage.
2. **Send opt-out emails** — DataPurge generates jurisdiction-specific legal templates and lets you BCC all brokers at once via your email client. Or send them one by one.
3. **Track progress** — Monitor response deadlines, verify removal from broker search pages, and send noncompliance notices when brokers miss their legal deadlines.

## Privacy

- **PII never leaves your browser.** Templates use `{placeholders}` that are filled client-side only.
- **No accounts, no tracking.** The site is static HTML/CSS/JS served via Cloudflare Pages.
- **Data stored in localStorage.** Persists across sessions. Clear it anytime from the app.
- **Open source.** Inspect every line of code.

## Legal Templates

Every opt-out request includes:

- **Deletion demand** under all applicable laws (CCPA, GDPR, state privacy acts)
- **Burden of proof on the broker** — they must search all systems, not dismiss based on name mismatch
- **Right to review** ambiguous records (CCPA § 1798.110, GDPR Article 15)
- **Dual-jurisdiction coverage** — cites laws applicable to both consumer's and broker's location
- **Explicit withdrawal of consent** — documented objection to all future processing
- **Structured response demands** with specific deadlines (45 days CCPA, 30 days GDPR)
- **Enforcement warning** — references CPPA, FTC, and DPA complaint escalation
- **Non-compliance follow-up** — automated escalation notices when deadlines pass

## The Broker Registry

The `brokers/` directory contains YAML definitions for 700+ data brokers organized by category. Each file includes opt-out contact info, applicable laws, data types collected, and search URLs for verification.

### Contributing a Broker

Add a YAML file to `brokers/{category}/` and submit a PR:

```yaml
id: example-broker
name: Example Broker
domain: example.com
category: people-search
data_types: [name, address, phone, email]

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
```

See `schema/broker.schema.json` for the full schema.

## Development

### Build the static site data

```bash
pip install pyyaml
python3 build.py
```

This exports broker YAMLs and legal templates into `web/data/registry.json` and `web/data/templates.json`.

### Serve locally

```bash
cd web && python3 -m http.server 8080
```

### Deploy

The site is deployed to Cloudflare Pages from the `web/` directory. Any push to `main` triggers a deploy.

## Architecture

```
web/                          Static site (Cloudflare Pages)
├── index.html                Landing page
├── app.html                  SPA (hash routing)
├── manifest.json             PWA manifest
├── sw.js                     Service worker (offline support)
├── icon.svg                  App icon
├── css/style.css             Design system
├── js/
│   ├── app.js                Router, views, profile management
│   ├── store.js              Multi-profile PII & progress (localStorage)
│   ├── templates.js          Template selection & interpolation
│   ├── queue.js              Email queue, mass BCC, location notices
│   └── progress.js           Deadline tracking, verification, monitoring
└── data/                     Generated by build.py
    ├── registry.json          Broker database
    └── templates.json         Legal templates

brokers/                      YAML broker definitions (the core asset)
templates/                    Legal email templates (templates.yaml)
server/                       Python backend (registry, templates, build tooling)
```

## Acknowledgements

Made possible by the support and collaboration of **Kristine Socall**, **[Gifted Dreamers](https://gifteddreamers.org)** and **[Digital Disconnections](https://digitaldisconnections.com)**.

## License

MIT — Free to use, modify, and distribute with attribution.
The broker registry YAML files are released under CC0 (public domain).
