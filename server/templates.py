"""
DataPurge Template Engine

Fills legal templates with user PII and selects the strongest
applicable legal template for each broker based on user's location.
"""

import yaml
import re
from pathlib import Path
from datetime import date, datetime
from dataclasses import dataclass
from typing import Optional


@dataclass
class FilledTemplate:
    template_id: str
    broker_id: str
    subject: str
    body: str
    send_to: str
    method: str  # email, postal
    legal_basis: str
    required_fields_missing: list


@dataclass
class UserIdentity:
    """User's PII for filling templates. Stays client-side."""
    full_name: str
    email: str
    first_name: str = ""
    last_name: str = ""
    phone: str = ""
    address: str = ""
    street: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = ""
    dob: str = ""
    country: str = "US"

    def __post_init__(self):
        if not self.first_name and " " in self.full_name:
            parts = self.full_name.split()
            self.first_name = parts[0]
            self.last_name = " ".join(parts[1:])
        if self.street and self.city and self.state and not self.address:
            self.address = f"{self.street}, {self.city}, {self.state} {self.zip_code}".strip()

    def to_dict(self) -> dict:
        return {
            "full_name": self.full_name,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "street": self.street,
            "city": self.city,
            "state": self.state,
            "zip": self.zip_code,
            "dob": self.dob,
            "date": date.today().strftime("%B %d, %Y"),
        }


# State -> strongest applicable law mapping
STATE_LAW_PRIORITY = {
    "california": "ccpa_maximum",
    "virginia": "us_omnibus",    # VCDPA doesn't have specific templates yet, use omnibus
    "colorado": "us_omnibus",
    "connecticut": "us_omnibus",
    "utah": "us_omnibus",
    "iowa": "us_omnibus",
    "indiana": "us_omnibus",
    "tennessee": "us_omnibus",
    "montana": "us_omnibus",
    "texas": "us_omnibus",
    "oregon": "us_omnibus",
    "delaware": "us_omnibus",
    "new jersey": "us_omnibus",
    "new hampshire": "us_omnibus",
    "nebraska": "us_omnibus",
    "minnesota": "us_omnibus",
    "maryland": "us_omnibus",
}


class TemplateEngine:
    """Loads templates and fills them with user data."""

    def __init__(self, templates_dir: str | Path = None):
        self.templates_dir = Path(templates_dir) if templates_dir else Path(__file__).parent.parent / "templates"
        self.templates = {}
        self._load_templates()

    def _load_templates(self):
        templates_file = self.templates_dir / "templates.yaml"
        if templates_file.exists():
            with open(templates_file) as f:
                data = yaml.safe_load(f)
            self.templates = data.get("templates", {})

    def get_template(self, template_id: str) -> Optional[dict]:
        return self.templates.get(template_id)

    def list_templates(self) -> list[str]:
        return list(self.templates.keys())

    def select_best_template(self, user: UserIdentity, broker) -> str:
        """
        Select the strongest applicable legal template for a broker
        based on user's state and broker's legal exposure.

        Strategy: Use the most aggressive template the law supports.
        For states with specific privacy laws, use CCPA-style maximum pressure.
        For other states, use the omnibus template that cites ALL laws.
        The omnibus template is actually very effective because it forces
        the broker to determine which laws apply — that's THEIR legal cost.
        """
        # GDPR users get the GDPR nuclear option
        if user.country != "US" or broker.supports_gdpr:
            if user.country in ("UK", "GB") or user.country in EU_COUNTRIES:
                return "gdpr_maximum"

        # California residents get CCPA maximum pressure
        user_state = user.state.lower() if user.state else ""
        if user_state == "california" and broker.supports_ccpa:
            return "ccpa_maximum"

        # Any state with privacy laws: use omnibus (cites everything)
        if user_state in STATE_LAW_PRIORITY:
            return STATE_LAW_PRIORITY[user_state]

        # No specific state law? Omnibus still works — it cites CCPA
        # which applies to brokers doing business in CA regardless of
        # where the consumer lives (if broker meets thresholds).
        # Making the broker figure out if they're covered = their cost.
        return "us_omnibus"

    def fill_template(
        self,
        template_id: str,
        user: UserIdentity,
        broker=None,
        extra_fields: dict = None,
    ) -> FilledTemplate:
        """Fill a template with user PII."""

        template = self.templates.get(template_id)
        if not template:
            raise ValueError(f"Unknown template: {template_id}")

        fields = user.to_dict()
        if extra_fields:
            fields.update(extra_fields)

        # Fill subject
        subject = self._interpolate(template["subject"], fields)

        # Fill body
        body = self._interpolate(template["body"], fields)

        # Determine send-to
        send_to = ""
        method = "email"
        if broker:
            email_method = broker.email_method
            if email_method:
                send_to = email_method.email_to

        # Check for missing required fields
        missing = []
        for f in template.get("required_fields", []):
            if not fields.get(f):
                missing.append(f)

        return FilledTemplate(
            template_id=template_id,
            broker_id=broker.id if broker else "",
            subject=subject,
            body=body,
            send_to=send_to,
            method=method,
            legal_basis=template.get("legal_basis", ""),
            required_fields_missing=missing,
        )

    def fill_for_broker(self, user: UserIdentity, broker) -> FilledTemplate:
        """Auto-select best template and fill it for a specific broker."""
        template_id = self.select_best_template(user, broker)
        return self.fill_template(template_id, user, broker)

    def generate_all_emails(self, user: UserIdentity, brokers: list) -> list[FilledTemplate]:
        """
        Generate filled emails for ALL brokers that accept email.
        This is the core function for the email drip system.

        Returns them in priority order:
        1. Biggest/most dangerous brokers first
        2. Brokers known to hold user's data type
        3. Everything else
        """
        emails = []
        for broker in brokers:
            if broker.email_method:
                filled = self.fill_for_broker(user, broker)
                if not filled.required_fields_missing:
                    emails.append(filled)

        # Sort: data aggregators first (they share with everyone),
        # then people-search, then everything else
        priority = {
            "data-aggregator": 0,
            "people-search": 1,
            "marketing-list": 2,
            "social-scraper": 3,
            "background-check": 4,
            "location-tracking": 5,
            "financial": 6,
            "public-records": 7,
            "other": 8,
        }
        emails.sort(key=lambda e: priority.get(
            next((b.category for b in brokers if b.id == e.broker_id), "other"), 99
        ))

        return emails

    def generate_mailto_link(self, filled: FilledTemplate) -> str:
        """Generate a mailto: link that opens the user's email client."""
        import urllib.parse
        params = {
            "subject": filled.subject,
            "body": filled.body,
        }
        query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        return f"mailto:{filled.send_to}?{query}"

    def _interpolate(self, text: str, fields: dict) -> str:
        """Replace {field_name} placeholders with values."""
        def replacer(match):
            key = match.group(1)
            return str(fields.get(key, f"{{{key}}}"))
        return re.sub(r"\{(\w+)\}", replacer, text)


EU_COUNTRIES = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    # EEA
    "IS", "LI", "NO",
}
