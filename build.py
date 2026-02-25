#!/usr/bin/env python3
"""Build static JSON data files for the DataPurge web frontend."""

import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from server.registry import BrokerRegistry
from server.templates import TemplateEngine, STATE_LAW_PRIORITY, EU_COUNTRIES


def main():
    output_dir = Path(__file__).parent / "web" / "data"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Export registry
    brokers_dir = Path(__file__).parent / "brokers"
    reg = BrokerRegistry(brokers_dir)
    reg.export_json(output_dir / "registry.json")
    print(f"Exported {reg.count()} brokers to web/data/registry.json")

    # Export templates + selection logic
    templates_dir = Path(__file__).parent / "templates"
    engine = TemplateEngine(templates_dir)
    templates_data = {
        "templates": engine.templates,
        "state_law_priority": STATE_LAW_PRIORITY,
        "eu_countries": sorted(EU_COUNTRIES),
    }
    (output_dir / "templates.json").write_text(
        json.dumps(templates_data, indent=2, default=str)
    )
    print(f"Exported {len(engine.templates)} templates to web/data/templates.json")


if __name__ == "__main__":
    main()
