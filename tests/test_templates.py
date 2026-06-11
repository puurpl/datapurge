"""Template selection and interpolation tests (mirrors web/js/templates.js)."""

import re

import pytest

from server.registry import Broker
from server.templates import STATE_LAW_PRIORITY, UserIdentity


def make_broker(**legal) -> Broker:
    return Broker(
        id="test-broker",
        name="Test Broker",
        domain="test-broker.example",
        category="other",
        legal=legal,
    )


def make_user(**kwargs) -> UserIdentity:
    defaults = {"full_name": "Jane Doe", "email": "jane@example.com"}
    defaults.update(kwargs)
    return UserIdentity(**defaults)


class TestSelectBestTemplate:
    def test_eu_country_gets_gdpr(self, engine):
        user = make_user(country="DE")
        assert engine.select_best_template(user, make_broker(gdpr=True)) == "gdpr_maximum"

    def test_uk_gets_gdpr(self, engine):
        user = make_user(country="GB")
        assert engine.select_best_template(user, make_broker()) == "gdpr_maximum"

    def test_california_ccpa_broker(self, engine):
        user = make_user(state="California")
        assert engine.select_best_template(user, make_broker(ccpa=True)) == "ccpa_maximum"

    def test_california_non_ccpa_broker(self, engine):
        # Falls through to STATE_LAW_PRIORITY, which still maps CA to ccpa_maximum
        user = make_user(state="California")
        assert engine.select_best_template(user, make_broker(ccpa=False)) == "ccpa_maximum"

    def test_mapped_state_gets_omnibus(self, engine):
        user = make_user(state="Texas")
        assert engine.select_best_template(user, make_broker()) == "us_omnibus"

    def test_unmapped_state_gets_omnibus(self, engine):
        user = make_user(state="Wyoming")
        assert engine.select_best_template(user, make_broker()) == "us_omnibus"

    def test_no_state_gets_omnibus(self, engine):
        user = make_user()
        assert engine.select_best_template(user, make_broker()) == "us_omnibus"


def test_state_law_priority_templates_exist(engine):
    referenced = set(STATE_LAW_PRIORITY.values()) | {
        "gdpr_maximum",
        "ccpa_maximum",
        "us_omnibus",
        "preemptive_blanket",
        "noncompliance_notice",
    }
    missing = referenced - set(engine.templates)
    assert not missing, f"Referenced templates missing from templates.yaml: {missing}"


# Fields supplied by UserIdentity.to_dict() plus the extra_fields the app
# provides for follow-up/escalation templates. A placeholder outside this
# whitelist would survive interpolation and ship as literal "{foo}" in a
# legal request email.
KNOWN_EXTRA_FIELDS = {
    "additional_emails",
    "broker_name",
    "broker_domain",
    "original_request_date",
    "request_reference_id",
    "days_elapsed",
    "legal_deadline_days",
    "followup_date",
    "previous_deletion_date",
    "previous_request_dates",
    "deletion_history",
    "relist_count",
}


def test_all_placeholders_are_known_fields(engine):
    known = set(make_user().to_dict()) | KNOWN_EXTRA_FIELDS
    failures = []
    for tid, template in engine.templates.items():
        text = template.get("subject", "") + template.get("body", "")
        for placeholder in set(re.findall(r"\{(\w+)\}", text)):
            if placeholder not in known:
                failures.append(f"{tid}: unknown placeholder {{{placeholder}}}")
    assert not failures, "\n".join(failures)


@pytest.mark.parametrize("template_id", ["ccpa_maximum", "gdpr_maximum", "us_omnibus", "preemptive_blanket"])
def test_fill_leaves_no_placeholders(engine, template_id):
    user = make_user(
        first_name="Jane",
        last_name="Doe",
        phone="555-0100",
        street="1 Main St",
        city="Austin",
        state="Texas",
        zip_code="78701",
        dob="1990-01-01",
    )
    filled = engine.fill_template(
        template_id, user, make_broker(ccpa=True, gdpr=True),
        extra_fields={"additional_emails": ""},
    )
    leftovers = re.findall(r"\{\w+\}", filled.subject + filled.body)
    assert not leftovers, f"Unfilled placeholders in {template_id}: {leftovers}"
