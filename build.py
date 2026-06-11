#!/usr/bin/env python3
"""Build static JSON data files for the DataPurge web frontend."""

import sys
import json
import hashlib
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from server.registry import BrokerRegistry
from server.templates import TemplateEngine, STATE_LAW_PRIORITY, EU_COUNTRIES


def write_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text() == content:
        return False
    path.write_text(content)
    return True


def stamp_service_worker(web_dir: Path):
    """Set sw.js CACHE_NAME to a content hash of the site, so any deploy
    that changes a file busts every client's precache automatically.
    Deterministic: a no-change build leaves sw.js untouched."""
    sw_path = web_dir / "sw.js"
    h = hashlib.sha256()
    for f in sorted(web_dir.rglob("*")):
        if f.is_dir() or f == sw_path:
            continue
        h.update(str(f.relative_to(web_dir)).encode())
        h.update(f.read_bytes())
    digest = h.hexdigest()[:10]
    text = sw_path.read_text()
    new = re.sub(
        r"^const CACHE_NAME = '[^']*';",
        f"const CACHE_NAME = 'datapurge-{digest}';",
        text,
        count=1,
        flags=re.M,
    )
    if new != text:
        sw_path.write_text(new)
        print(f"Stamped sw.js cache name: datapurge-{digest}")
    else:
        print(f"sw.js cache name unchanged: datapurge-{digest}")


def main():
    web_dir = Path(__file__).parent / "web"
    output_dir = web_dir / "data"
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
    write_if_changed(
        output_dir / "templates.json",
        json.dumps(templates_data, indent=2, default=str),
    )
    print(f"Exported {len(engine.templates)} templates to web/data/templates.json")

    stamp_service_worker(web_dir)


if __name__ == "__main__":
    main()
