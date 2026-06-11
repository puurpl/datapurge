"""Registry JSON export tests (what build.py ships to web/data/)."""

import json


def test_export_structure(registry, tmp_path):
    out = tmp_path / "registry.json"
    registry.export_json(out)
    data = json.loads(out.read_text())

    assert data["broker_count"] == registry.count()
    assert len(data["brokers"]) == registry.count()
    assert data["version"] == data["updated_at"].replace("-", "")

    expected_keys = {
        "id", "name", "domain", "category", "data_types",
        "aliases", "scan", "optout", "legal", "timing", "meta",
    }
    for broker in data["brokers"][:5]:
        assert set(broker) == expected_keys

    mediamath = next(b for b in data["brokers"] if b["id"] == "mediamath")
    assert mediamath["meta"]["defunct"] is True


def test_export_deterministic(registry, tmp_path):
    # Cache-busting in build.py hashes the export; a wall-clock timestamp
    # here would churn every client's precache on every deploy.
    first = registry.export_json(tmp_path / "a.json")
    second = registry.export_json(tmp_path / "b.json")
    assert first == second
    assert (tmp_path / "a.json").read_text() == (tmp_path / "b.json").read_text()
