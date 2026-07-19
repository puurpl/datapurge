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


def test_flagged_email_methods_excluded(registry):
    # User-reported dead/refused email channels (GH #1/#2) stay on record with
    # a status flag but must never be treated as a usable email method.
    flagged_ids = [
        "affinity-solutions", "catalist", "disqus", "complete-medical-lists",
        "client-command", "demandbase", "atdata", "blackbaud",
    ]
    emailable_ids = {b.id for b in registry.get_emailable()}
    for broker_id in flagged_ids:
        broker = registry.get(broker_id)
        assert broker is not None, f"{broker_id} missing from registry"
        raw_methods = broker.optout.get("methods", [])
        flagged = [m for m in raw_methods if m.get("type") == "email" and m.get("status")]
        assert flagged, f"{broker_id} should retain a flagged email method on record"
        assert broker.email_method is None, f"{broker_id} should have no usable email method"
        assert broker_id not in emailable_ids, f"{broker_id} should not be emailable"


def test_replacement_emails_active(registry):
    # Where the old address died/was refused, a verified successor address
    # becomes the usable email method; the old one stays flagged on record.
    replacements = {
        "attribits": "compliance@allgoodmediagroup.com",
        "cashmere": "security@cashmereai.com",
        "actioniq": "privacy@uniphore.com",
    }
    for broker_id, expected in replacements.items():
        broker = registry.get(broker_id)
        assert broker is not None, f"{broker_id} missing from registry"
        assert broker.email_method is not None, f"{broker_id} should have a usable email method"
        assert broker.email_method.email_to == expected, (
            f"{broker_id} email should be {expected}, got {broker.email_method.email_to}"
        )
        raw_methods = broker.optout.get("methods", [])
        assert any(m.get("type") == "email" and m.get("status") for m in raw_methods), (
            f"{broker_id} should still keep the flagged old email method on record"
        )


def test_status_flags_documented(registry):
    # Every status-flagged method must use a known flag and explain itself.
    valid = {"bounces", "not_accepted"}
    problems = []
    for broker in registry.brokers.values():
        for m in broker.optout.get("methods", []):
            status = m.get("status")
            if not status:
                continue
            if status not in valid:
                problems.append(f"{broker.id}: invalid status {status!r}")
            if not (m.get("notes") or "").strip():
                problems.append(f"{broker.id}: status {status!r} without notes")
    assert not problems, "Status-flag issues:\n" + "\n".join(problems)


def test_bisceince_typo_fixed(registry):
    # The imported dpo@bisceince.com typo (dead domain) is corrected.
    broker = registry.get("b-i-science-2009")
    assert broker is not None
    assert broker.email_method is not None
    assert broker.email_method.email_to == "privacy@biscience.com"


def test_ach_stays_emailable(registry):
    # ACH accepts email when a full postal address is included; stays queued.
    emailable_ids = {b.id for b in registry.get_emailable()}
    assert "ach-address-clearing-house" in emailable_ids
    broker = registry.get("ach-address-clearing-house")
    assert "address" in broker.email_method.required_fields
