"""Broker registry data integrity tests."""

from collections import Counter

import jsonschema


def test_all_files_load(registry, yaml_files):
    # BrokerRegistry._load_all swallows per-file errors and dedups by id,
    # so count equality catches both broken YAML and duplicate ids.
    assert registry.count() == len(yaml_files), (
        "Some broker YAML files failed to load or share an id "
        f"({registry.count()} loaded from {len(yaml_files)} files)"
    )


def test_unique_ids(yaml_docs):
    counts = Counter(doc["id"] for doc in yaml_docs.values())
    dups = {bid: n for bid, n in counts.items() if n > 1}
    assert not dups, f"Duplicate broker ids: {dups}"


def test_schema_validation(yaml_docs, schema):
    validator = jsonschema.Draft7Validator(schema)
    failures = []
    for path, doc in yaml_docs.items():
        for error in validator.iter_errors(doc):
            failures.append(f"{path.name}: {error.json_path}: {error.message}")
    assert not failures, "Schema violations:\n" + "\n".join(failures[:30])


def test_category_matches_directory(yaml_docs):
    mismatches = [
        f"{path}: category={doc['category']!r}"
        for path, doc in yaml_docs.items()
        if doc["category"] != path.parent.name
    ]
    assert not mismatches, "category != directory name:\n" + "\n".join(mismatches)


def test_defunct_excluded_from_emailable(registry):
    assert all(not b.is_defunct for b in registry.get_emailable())
    assert all(not b.is_defunct for b in registry.get_scannable())


def test_known_defunct_brokers_flagged(registry):
    # Regression anchors for AUDIT_REPORT CRITICAL-02/03
    for broker_id in ("mediamath", "oracle-data-cloud"):
        broker = registry.get(broker_id)
        assert broker is not None, f"{broker_id} missing from registry"
        assert broker.is_defunct, f"{broker_id} should be marked defunct"
