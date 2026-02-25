"""
DataPurge Broker Registry

Loads broker YAML definitions, validates them against the schema,
and provides query/filter capabilities.
"""

import json
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, date


@dataclass
class BrokerOptoutMethod:
    type: str  # email, web_form, api, postal, phone
    url: Optional[str] = None
    email_to: Optional[str] = None
    postal_address: Optional[str] = None
    phone_number: Optional[str] = None
    required_fields: list = field(default_factory=list)
    requires_id: bool = False
    requires_listing_url: bool = False
    steps: list = field(default_factory=list)
    template_id: Optional[str] = None


@dataclass
class Broker:
    id: str
    name: str
    domain: str
    category: str
    data_types: list = field(default_factory=list)
    aliases: list = field(default_factory=list)
    scan: dict = field(default_factory=dict)
    optout: dict = field(default_factory=dict)
    legal: dict = field(default_factory=dict)
    timing: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)

    @property
    def scannable(self) -> bool:
        return self.scan.get("scannable", False)

    @property
    def difficulty(self) -> str:
        return self.optout.get("difficulty", "unknown")

    @property
    def primary_method(self) -> Optional[BrokerOptoutMethod]:
        methods = self.optout.get("methods", [])
        if methods:
            return BrokerOptoutMethod(**methods[0])
        return None

    @property
    def email_method(self) -> Optional[BrokerOptoutMethod]:
        for m in self.optout.get("methods", []):
            if m["type"] == "email":
                return BrokerOptoutMethod(**m)
        return None

    @property
    def all_methods(self) -> list:
        return [BrokerOptoutMethod(**m) for m in self.optout.get("methods", [])]

    @property
    def last_verified(self) -> Optional[date]:
        v = self.meta.get("last_verified")
        if v:
            return date.fromisoformat(v) if isinstance(v, str) else v
        return None

    @property
    def confidence(self) -> float:
        return self.meta.get("confidence", 0.0)

    @property
    def supports_ccpa(self) -> bool:
        return self.legal.get("ccpa", False)

    @property
    def supports_gdpr(self) -> bool:
        return self.legal.get("gdpr", False)

    @property
    def relisting_likelihood(self) -> str:
        return self.timing.get("relisting_likelihood", "unknown")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "domain": self.domain,
            "category": self.category,
            "data_types": self.data_types,
            "aliases": self.aliases,
            "scan": self.scan,
            "optout": self.optout,
            "legal": self.legal,
            "timing": self.timing,
            "meta": self.meta,
        }

    def to_yaml(self) -> str:
        return yaml.dump(self.to_dict(), default_flow_style=False, sort_keys=False)


class BrokerRegistry:
    """Loads and queries the broker YAML database."""

    def __init__(self, brokers_dir: str | Path = None):
        self.brokers_dir = Path(brokers_dir) if brokers_dir else Path(__file__).parent.parent / "brokers"
        self.brokers: dict[str, Broker] = {}
        self._load_all()

    def _load_all(self):
        """Recursively load all .yaml files from the brokers directory."""
        if not self.brokers_dir.exists():
            return
        for yaml_file in self.brokers_dir.rglob("*.yaml"):
            # Skip schema/template files
            if yaml_file.parent.name.startswith("_"):
                continue
            try:
                broker = self._load_broker(yaml_file)
                self.brokers[broker.id] = broker
            except Exception as e:
                print(f"Warning: Failed to load {yaml_file}: {e}")

    def _load_broker(self, path: Path) -> Broker:
        with open(path) as f:
            data = yaml.safe_load(f)
        return Broker(**data)

    def get(self, broker_id: str) -> Optional[Broker]:
        return self.brokers.get(broker_id)

    def list_all(self) -> list[Broker]:
        return sorted(self.brokers.values(), key=lambda b: b.name)

    def count(self) -> int:
        return len(self.brokers)

    def filter(
        self,
        category: str = None,
        scannable: bool = None,
        has_email: bool = None,
        legal_basis: str = None,
        state: str = None,
        min_confidence: float = None,
        search: str = None,
    ) -> list[Broker]:
        """Filter brokers by various criteria."""
        results = list(self.brokers.values())

        if category:
            results = [b for b in results if b.category == category]

        if scannable is not None:
            results = [b for b in results if b.scannable == scannable]

        if has_email:
            results = [b for b in results if b.email_method is not None]

        if legal_basis:
            results = [b for b in results if b.legal.get(legal_basis)]

        if state:
            results = [
                b for b in results
                if state.lower() in [s.lower() for s in b.legal.get("state_laws", [])]
            ]

        if min_confidence is not None:
            results = [b for b in results if b.confidence >= min_confidence]

        if search:
            search_lower = search.lower()
            results = [
                b for b in results
                if search_lower in b.name.lower()
                or search_lower in b.domain.lower()
                or any(search_lower in a.lower() for a in b.aliases)
            ]

        return sorted(results, key=lambda b: b.name)

    def get_emailable(self) -> list[Broker]:
        """Get all brokers that accept email opt-out requests.
        This is the core list for the web visitor email drip."""
        return [b for b in self.list_all() if b.email_method]

    def get_scannable(self) -> list[Broker]:
        """Get all brokers with public search capability."""
        return [b for b in self.list_all() if b.scannable]

    def get_stale(self, days: int = 7) -> list[Broker]:
        """Get brokers not verified within the given number of days."""
        cutoff = date.today().replace(day=date.today().day - days) if days < date.today().day else date.today()
        results = []
        for b in self.list_all():
            if b.last_verified is None or b.last_verified < cutoff:
                results.append(b)
        return results

    def get_categories(self) -> dict[str, int]:
        """Count brokers per category."""
        cats = {}
        for b in self.brokers.values():
            cats[b.category] = cats.get(b.category, 0) + 1
        return dict(sorted(cats.items()))

    def get_stats(self) -> dict:
        """Overall registry statistics."""
        all_brokers = self.list_all()
        return {
            "total": len(all_brokers),
            "scannable": len([b for b in all_brokers if b.scannable]),
            "emailable": len(self.get_emailable()),
            "categories": self.get_categories(),
            "ccpa_applicable": len([b for b in all_brokers if b.supports_ccpa]),
            "gdpr_applicable": len([b for b in all_brokers if b.supports_gdpr]),
            "avg_confidence": sum(b.confidence for b in all_brokers) / len(all_brokers) if all_brokers else 0,
        }

    def export_json(self, path: str | Path = None) -> str:
        """Export the full registry as JSON (for API/client sync)."""
        data = {
            "version": datetime.now().strftime("%Y%m%d"),
            "updated_at": datetime.now().isoformat(),
            "broker_count": self.count(),
            "brokers": [b.to_dict() for b in self.list_all()],
        }
        json_str = json.dumps(data, indent=2, default=str)
        if path:
            Path(path).write_text(json_str)
        return json_str
