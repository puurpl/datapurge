#!/usr/bin/env python3
"""
Import brokers from the California Data Broker Registry CSV into YAML files.

Reads the official CPPA registry CSV (public government data) and creates
broker YAML files for entries not already in our registry.
"""

import csv
import re
import sys
import json
from pathlib import Path
from urllib.parse import urlparse

BROKERS_DIR = Path(__file__).parent / "brokers"
REGISTRY_JSON = Path(__file__).parent / "web" / "data" / "registry.json"
CA_CSV = Path(__file__).parent / "ca_registry.csv"


def load_existing_brokers():
    """Load all existing broker domains and emails to avoid duplicates."""
    domains = set()
    emails = set()
    ids = set()

    for yaml_file in BROKERS_DIR.rglob("*.yaml"):
        content = yaml_file.read_text()
        # Extract domain
        for line in content.splitlines():
            if line.startswith("domain:"):
                d = line.split(":", 1)[1].strip().strip("'\"").lower()
                domains.add(d)
            if line.startswith("id:"):
                ids.add(line.split(":", 1)[1].strip().strip("'\""))
            if "email_to:" in line:
                e = line.split(":", 1)[1].strip().strip("'\"").lower()
                emails.add(e)
            # Check aliases too
            if line.strip().startswith("- ") and "." in line:
                alias = line.strip().lstrip("- ").strip("'\"").lower()
                if "." in alias and " " not in alias:
                    domains.add(alias)

    return domains, emails, ids


def normalize_domain(url_or_domain):
    """Extract clean domain from URL or domain string."""
    if not url_or_domain:
        return ""
    url_or_domain = url_or_domain.strip().strip("'\"")
    if not url_or_domain.startswith("http"):
        url_or_domain = "https://" + url_or_domain
    try:
        parsed = urlparse(url_or_domain)
        domain = parsed.netloc or parsed.path
        domain = domain.lower().strip("/")
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


def make_id(name):
    """Generate a broker ID from the name."""
    # Remove common suffixes
    name = re.sub(r'\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Co\.?|Group|Holdings?)\s*$', '', name, flags=re.IGNORECASE)
    name = name.strip().strip(",").strip()
    # Convert to kebab-case
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    # Limit length
    if len(slug) > 40:
        slug = slug[:40].rsplit('-', 1)[0]
    return slug


def classify_broker(row):
    """Guess category from available fields."""
    name = (row.get("name", "") + " " + row.get("dba", "")).lower()
    website = row.get("website", "").lower()

    # Check regulatory fields for hints
    is_fcra = row.get("fcra", "").lower().startswith("yes")
    is_glba = row.get("glba", "").lower().startswith("yes")
    is_hipaa = row.get("hipaa", "").lower().startswith("yes")
    is_iippa = row.get("iippa", "").lower().startswith("yes")
    collects_geo = row.get("geolocation", "").lower().startswith("yes")
    collects_health = row.get("health_data", "").lower().startswith("yes")

    if is_hipaa or collects_health:
        return "health"
    if is_iippa:
        return "insurance"
    if is_glba:
        return "financial"
    if collects_geo:
        return "location-tracking"

    # Name-based classification
    people_keywords = ["people", "search", "lookup", "finder", "records", "background", "check", "verify", "screen"]
    if any(k in name for k in ["people search", "lookup", "peoplefind", "spokeo", "whitepages", "been verified"]):
        return "people-search"
    if any(k in name for k in ["background", "screening", "pre-employment", "checkr"]):
        return "background-check"
    if any(k in name for k in ["tenant", "rent", "apartment", "housing"]):
        return "tenant-screening"
    if any(k in name for k in ["market", "advertis", "ad tech", "programmatic", "dsp", "audience"]):
        return "marketing-list"
    if any(k in name for k in ["social", "scrape", "lead", "contact", "b2b", "sales intelligence"]):
        return "social-scraper"
    if any(k in name for k in ["location", "geo", "mobile", "gps", "proximity"]):
        return "location-tracking"
    if any(k in name for k in ["real estate", "property", "mortgage", "home"]):
        return "real-estate"
    if any(k in name for k in ["vehicle", "auto", "car", "driver"]):
        return "vehicle"
    if any(k in name for k in ["political", "voter", "campaign", "election"]):
        return "political"
    if any(k in name for k in ["employ", "payroll", "workforce", "job", "recruit"]):
        return "employment"
    if is_fcra:
        return "background-check"

    return "data-aggregator"


def is_valid_email(email):
    """Basic email validation."""
    return bool(re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email))


def parse_csv(csv_path):
    """Parse the CA Data Broker Registry CSV."""
    brokers = []

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        # Skip the first row (instructions)
        lines = f.readlines()

    # Find the header row (contains "Data broker" and "name")
    header_idx = None
    for i, line in enumerate(lines):
        # Handle non-breaking spaces and variations
        normalized = line.replace('\xa0', ' ')
        if "Data broker" in normalized and "name" in normalized and "DBA" in normalized:
            lines[i] = normalized  # Replace with normalized version
            header_idx = i
            break

    if header_idx is None:
        print("ERROR: Could not find header row in CSV")
        return []

    # Re-parse from header
    reader = csv.DictReader(lines[header_idx:])

    for row in reader:
        # Normalize all keys to handle non-breaking spaces
        row = {k.replace('\xa0', ' '): v for k, v in row.items()}

        name = row.get("Data broker name:", "").strip()
        if not name:
            continue

        dba = row.get("Doing Business As (DBA), if applicable:", "").strip()
        website = row.get("Data broker primary website:", "").strip()
        email = row.get("Data broker primary contact email address:", "").strip()

        # Find privacy URL by partial key match
        privacy_url = ""
        for key in row:
            if "exercise their CA" in key or "delete their personal information" in key:
                privacy_url = row[key].strip()
                break

        # Find regulatory fields by partial key match
        fcra = glba = hipaa = iippa = minors = geolocation = health_data = ""
        for key, val in row.items():
            kl = key.lower()
            if "fair credit reporting" in kl and "regulated" in kl:
                fcra = val.strip()
            elif "gramm-leach" in kl and "regulated" in kl:
                glba = val.strip()
            elif "hipaa" in kl and "regulated" in kl:
                hipaa = val.strip()
            elif "iippa" in kl and "regulated" in kl:
                iippa = val.strip()
            elif "collects personal information of minors" in kl:
                minors = val.strip()
            elif "precise geolocation" in kl and "collects" in kl:
                geolocation = val.strip()
            elif "reproductive health" in kl and "collects" in kl:
                health_data = val.strip()

        brokers.append({
            "name": name,
            "dba": dba,
            "website": website,
            "email": email,
            "privacy_url": privacy_url,
            "fcra": fcra,
            "glba": glba,
            "hipaa": hipaa,
            "iippa": iippa,
            "minors": minors,
            "geolocation": geolocation,
            "health_data": health_data,
        })

    return brokers


def generate_yaml(broker, category, broker_id, domain):
    """Generate YAML content for a broker."""
    name = broker["name"]
    dba = broker["dba"]
    email = broker["email"]
    website = broker["website"]
    privacy_url = broker["privacy_url"]

    display_name = dba if dba and dba != name else name
    aliases = []
    if dba and dba != name:
        aliases.append(name)

    # Build methods
    methods = []
    if email and is_valid_email(email):
        methods.append(f"""    - type: email
      email_to: "{email}"
      required_fields: [full_name, email]
      template_id: ccpa_maximum""")

    if privacy_url and privacy_url.startswith("http"):
        methods.append(f"""    - type: web_form
      url: "{privacy_url}"
      required_fields: [full_name, email]
      template_id: null
      notes: "CCPA rights page from CA Data Broker Registry filing." """)

    if not methods:
        return None  # Skip brokers with no contact method

    methods_yaml = "\n".join(methods)

    # Legal flags
    ccpa_flag = "true"  # They're registered as CA data broker
    fcra_flag = broker["fcra"].lower().startswith("yes")
    glba_flag = broker["glba"].lower().startswith("yes")

    # Data types based on category
    data_types_map = {
        "people-search": ["name", "address", "phone", "email"],
        "data-aggregator": ["name", "email", "online-activity", "demographics"],
        "marketing-list": ["name", "email", "demographics", "purchase-history"],
        "social-scraper": ["name", "email", "employment", "social-media"],
        "background-check": ["name", "address", "phone", "criminal-records"],
        "financial": ["name", "address", "financial", "credit-history"],
        "location-tracking": ["name", "location-history", "device-id"],
        "health": ["name", "health-data", "prescriptions"],
        "insurance": ["name", "address", "insurance-claims"],
        "tenant-screening": ["name", "address", "rental-history", "credit-history"],
        "employment": ["name", "employment", "salary-history"],
        "political": ["name", "address", "voter-registration"],
        "vehicle": ["name", "vehicle-records"],
        "real-estate": ["name", "address", "property-records"],
        "other": ["name", "email"],
    }
    data_types = data_types_map.get(category, ["name", "email"])
    data_types_yaml = "\n".join(f"  - {dt}" for dt in data_types)

    aliases_yaml = "[]"
    if aliases:
        aliases_yaml = "[" + ", ".join(f'"{a}"' for a in aliases) + "]"

    yaml_content = f"""id: {broker_id}
name: {display_name}
domain: {domain}
aliases: {aliases_yaml}
category: {category}
data_types:
{data_types_yaml}

scan:
  scannable: false
  reason: "Imported from California Data Broker Registry. Manual verification needed."

optout:
  methods:
{methods_yaml}
  difficulty: medium
  estimated_minutes: 10
  processing_days: 30
  legal_max_days: 45
  notes: "Registered California data broker. Imported from CPPA registry."

legal:
  ccpa: {ccpa_flag}
  gdpr: false
  registered_broker:
    california: true
  state_laws: [california]

timing:
  typical_removal_days: 30
  relisting_likelihood: medium
  recheck_interval_days: 180

meta:
  added: "2026-02-26"
  last_verified: "2026-02-26"
  verified_by: ca_data_broker_registry
  confidence: 0.70
  notes: "Source: California Data Broker Registry (CPPA). Auto-imported — verify opt-out details."
"""
    return yaml_content


def main():
    print("Loading existing brokers...")
    existing_domains, existing_emails, existing_ids = load_existing_brokers()
    print(f"  Found {len(existing_domains)} existing domains, {len(existing_ids)} IDs")

    print(f"\nParsing CA registry CSV...")
    ca_brokers = parse_csv(CA_CSV)
    print(f"  Found {len(ca_brokers)} entries in CA registry")

    created = 0
    skipped_no_contact = 0
    skipped_duplicate = 0
    skipped_no_domain = 0

    for broker in ca_brokers:
        domain = normalize_domain(broker["website"])
        if not domain:
            skipped_no_domain += 1
            continue

        # Check for duplicates
        if domain in existing_domains:
            skipped_duplicate += 1
            continue

        # Check email duplicates
        email = broker["email"].strip().lower()
        if email in existing_emails and email:
            skipped_duplicate += 1
            continue

        # Generate ID
        broker_id = make_id(broker["dba"] or broker["name"])
        if broker_id in existing_ids:
            # Try with domain
            broker_id = make_id(domain.split(".")[0])
            if broker_id in existing_ids:
                skipped_duplicate += 1
                continue

        # Classify
        category = classify_broker(broker)

        # Generate YAML
        yaml_content = generate_yaml(broker, category, broker_id, domain)
        if not yaml_content:
            skipped_no_contact += 1
            continue

        # Ensure directory exists
        cat_dir = BROKERS_DIR / category.replace("-", "-")
        # Map category to directory name
        dir_map = {
            "data-aggregator": "data-aggregators",
        }
        dir_name = dir_map.get(category, category)
        cat_dir = BROKERS_DIR / dir_name
        cat_dir.mkdir(parents=True, exist_ok=True)

        # Write file
        filename = f"{broker_id}.yaml"
        filepath = cat_dir / filename
        if filepath.exists():
            skipped_duplicate += 1
            continue

        filepath.write_text(yaml_content)
        existing_ids.add(broker_id)
        existing_domains.add(domain)
        if email:
            existing_emails.add(email)
        created += 1

    print(f"\nResults:")
    print(f"  Created: {created}")
    print(f"  Skipped (duplicate): {skipped_duplicate}")
    print(f"  Skipped (no contact): {skipped_no_contact}")
    print(f"  Skipped (no domain): {skipped_no_domain}")
    print(f"  Total in CA registry: {len(ca_brokers)}")


if __name__ == "__main__":
    main()
