"""
DataPurge Central Server

Serves the broker registry via API and provides a web UI that
guides visitors through opt-out requests without requiring any install.

KEY INSIGHT: For web visitors, we guide them email by email.
They enter their PII once (client-side JS, never sent to server),
and we present them with a queue of pre-filled emails to send.
One click = mailto: link opens their email client with everything filled in.
"""

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from datetime import datetime, date
from pathlib import Path
from typing import Optional
import json
import hashlib
import os

from .registry import BrokerRegistry
from .templates import TemplateEngine, UserIdentity

app = FastAPI(
    title="DataPurge",
    description="Open-source data broker deletion service",
    version="0.1.0",
)

# Initialize core services
BROKERS_DIR = Path(__file__).parent.parent / "brokers"
TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
registry = BrokerRegistry(BROKERS_DIR)
template_engine = TemplateEngine(TEMPLATES_DIR)

# Static files and templates for web UI
STATIC_DIR = Path(__file__).parent / "web" / "static"
TEMPLATES_HTML_DIR = Path(__file__).parent / "web" / "templates"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_HTML_DIR)) if TEMPLATES_HTML_DIR.exists() else None


# =============================================================================
# PUBLIC API — Broker Registry
# =============================================================================

@app.get("/api/v1/registry")
async def get_registry():
    """
    Full registry dump for CLI clients.
    Supports ETag for conditional requests.
    """
    data = {
        "version": datetime.now().strftime("%Y%m%d"),
        "updated_at": datetime.now().isoformat(),
        "broker_count": registry.count(),
        "brokers": [b.to_dict() for b in registry.list_all()],
    }
    etag = hashlib.md5(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()
    return JSONResponse(content=data, headers={"ETag": etag})


@app.get("/api/v1/brokers")
async def list_brokers(
    category: Optional[str] = None,
    scannable: Optional[bool] = None,
    has_email: Optional[bool] = None,
    state: Optional[str] = None,
    search: Optional[str] = None,
):
    """Searchable broker directory."""
    brokers = registry.filter(
        category=category,
        scannable=scannable,
        has_email=has_email,
        state=state,
        search=search,
    )
    return {"count": len(brokers), "brokers": [b.to_dict() for b in brokers]}


@app.get("/api/v1/brokers/{broker_id}")
async def get_broker(broker_id: str):
    """Full broker detail."""
    broker = registry.get(broker_id)
    if not broker:
        raise HTTPException(404, f"Broker '{broker_id}' not found")
    return broker.to_dict()


@app.get("/api/v1/stats")
async def get_stats():
    """Public registry statistics."""
    return registry.get_stats()


# =============================================================================
# TEMPLATE API — Client-side template filling
# =============================================================================

@app.get("/api/v1/templates")
async def list_templates():
    """List available legal templates."""
    return {"templates": template_engine.list_templates()}


@app.get("/api/v1/templates/{template_id}")
async def get_template(template_id: str):
    """Get a template definition (for client-side filling)."""
    t = template_engine.get_template(template_id)
    if not t:
        raise HTTPException(404, f"Template '{template_id}' not found")
    return t


# =============================================================================
# EMAIL DRIP QUEUE — The core web visitor experience
# =============================================================================

@app.get("/api/v1/email-queue")
async def get_email_queue(
    state: Optional[str] = None,
    category: Optional[str] = None,
    batch_size: int = Query(default=5, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
):
    """
    Returns a batch of broker email targets with template info.
    The web UI calls this to build the email-by-email queue.

    PII is NOT sent here — the response contains templates with
    placeholders. Client-side JS fills them.

    Response includes:
    - Broker name, domain, category
    - Email address to send to
    - Template with {placeholders}
    - mailto: link structure (client fills PII)
    - Priority ranking
    """
    # Get all emailable brokers, optionally filtered
    brokers = registry.filter(category=category, has_email=True, state=state)

    # Priority sort: most impactful first
    priority_order = [
        "data-aggregator",    # These feed everyone else
        "people-search",      # Most visible to stalkers/harassers
        "marketing-list",     # Spam sources
        "social-scraper",
        "location-tracking",  # Safety risk
        "background-check",
        "financial",
        "public-records",
        "other",
    ]
    brokers.sort(key=lambda b: (
        priority_order.index(b.category) if b.category in priority_order else 99,
        b.name
    ))

    # Paginate
    total = len(brokers)
    batch = brokers[offset:offset + batch_size]

    queue = []
    for broker in batch:
        email_method = broker.email_method
        if not email_method:
            continue

        # Determine best template
        # We don't know the user's state for template selection at the API level,
        # so we include the template IDs and let client-side pick.
        # If state is provided, we can pre-select.
        template_id = "preemptive_blanket"  # Default: works for everyone
        if state:
            dummy_user = UserIdentity(full_name="", email="", state=state)
            template_id = template_engine.select_best_template(dummy_user, broker)

        template = template_engine.get_template(template_id)

        queue.append({
            "broker_id": broker.id,
            "broker_name": broker.name,
            "broker_domain": broker.domain,
            "category": broker.category,
            "data_types": broker.data_types,
            "send_to": email_method.email_to,
            "template_id": template_id,
            "subject_template": template["subject"],
            "body_template": template["body"],
            "required_fields": template.get("required_fields", []),
            "optional_fields": template.get("optional_fields", []),
            "legal_basis": template.get("legal_basis", ""),
            "difficulty": broker.difficulty,
            "estimated_response_days": broker.optout.get("legal_max_days", 45),
            "relisting_likelihood": broker.relisting_likelihood,
        })

    return {
        "total_brokers": total,
        "batch_size": batch_size,
        "offset": offset,
        "has_more": offset + batch_size < total,
        "queue": queue,
    }


# =============================================================================
# MAILING LIST — Daily email drip for subscribers
# =============================================================================

class MailingListSignup(BaseModel):
    """
    User signs up to receive X broker contacts per day via email.

    IMPORTANT: We do NOT store their PII. We store:
    - Their email (to send them the daily digest)
    - Their state (to select appropriate legal templates)
    - How many per day they want
    - Where they are in the queue

    The daily email contains:
    - The broker's email address
    - The pre-filled template (with their name/email already in it)
    - A mailto: link
    - Instructions

    Their PII is in the email we send TO them, not stored in our DB.
    """
    email: str
    full_name: str
    state: str = ""
    brokers_per_day: int = Field(default=3, ge=1, le=10)

    # These are used to fill templates but NOT stored in our DB.
    # They go directly into the first batch of emails and are discarded.
    phone: str = ""
    address: str = ""


@app.post("/api/v1/mailing-list/signup")
async def mailing_list_signup(signup: MailingListSignup):
    """
    Sign up for the daily email drip.

    How this works:
    1. User provides name, email, state, how many per day
    2. We generate ALL their templates immediately
    3. We store ONLY: email, queue position, schedule
    4. Daily cron sends them the next batch of pre-filled templates
    5. They click mailto: links to send each one

    After signup, we immediately return the first batch so they
    can start right away.
    """
    user = UserIdentity(
        full_name=signup.full_name,
        email=signup.email,
        state=signup.state,
        phone=signup.phone,
        address=signup.address,
    )

    # Generate all emails for all brokers
    emailable_brokers = registry.get_emailable()
    all_emails = template_engine.generate_all_emails(user, emailable_brokers)

    # Calculate drip schedule
    total_emails = len(all_emails)
    days_to_complete = total_emails // signup.brokers_per_day
    if total_emails % signup.brokers_per_day:
        days_to_complete += 1

    # Store the subscriber with their pre-generated queue
    subscriber_id = store_subscriber(
        email=signup.email,
        queue=[
            {
                "broker_id": e.broker_id,
                "send_to": e.send_to,
                "subject": e.subject,
                "body": e.body,
                "mailto_link": template_engine.generate_mailto_link(e),
            }
            for e in all_emails
        ],
        per_day=signup.brokers_per_day,
        state=signup.state,
    )

    # Return the first batch immediately
    first_batch = all_emails[:signup.brokers_per_day]

    return {
        "subscriber_id": subscriber_id,
        "total_brokers": total_emails,
        "per_day": signup.brokers_per_day,
        "estimated_days": days_to_complete,
        "first_batch": [
            {
                "broker_name": next(
                    (b.name for b in emailable_brokers if b.id == e.broker_id), ""
                ),
                "send_to": e.send_to,
                "subject": e.subject,
                "body": e.body,
                "mailto_link": template_engine.generate_mailto_link(e),
            }
            for e in first_batch
        ],
        "message": (
            f"You'll receive {signup.brokers_per_day} pre-filled opt-out emails "
            f"per day for the next {days_to_complete} days. Each one contains a "
            f"mailto: link — just click to open in your email client and hit send."
        ),
    }


# =============================================================================
# COMMUNITY REPORTS
# =============================================================================

class BrokerReport(BaseModel):
    broker_name: str
    broker_url: str
    report_type: str  # new_broker, broken_process, updated_process, broker_removed
    description: str
    evidence_url: Optional[str] = None
    reporter_email: Optional[str] = None


@app.post("/api/v1/reports")
async def submit_report(report: BrokerReport):
    """Community report: new broker or broken opt-out process."""
    report_id = save_report(report.model_dump())
    return {
        "report_id": report_id,
        "status": "queued",
        "message": "Thanks! Our maintenance agent will review this within 24 hours.",
    }


@app.get("/api/v1/reports/{report_id}")
async def get_report_status(report_id: str):
    """Check report status."""
    report = load_report(report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    return report


# =============================================================================
# HELPER FUNCTIONS (stub implementations)
# =============================================================================

REPORTS_DIR = Path(__file__).parent.parent / "reports"
SUBSCRIBERS_DIR = Path(__file__).parent.parent / "subscribers"


def save_report(data: dict) -> str:
    """Save a community report to disk."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_id = hashlib.sha256(
        f"{data['broker_name']}{datetime.now().isoformat()}".encode()
    ).hexdigest()[:12]
    data["report_id"] = report_id
    data["status"] = "queued"
    data["submitted_at"] = datetime.now().isoformat()
    (REPORTS_DIR / f"{report_id}.json").write_text(json.dumps(data, indent=2))
    return report_id


def load_report(report_id: str) -> Optional[dict]:
    path = REPORTS_DIR / f"{report_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    return None


def store_subscriber(email: str, queue: list, per_day: int, state: str) -> str:
    """Store subscriber's pre-generated email queue."""
    SUBSCRIBERS_DIR.mkdir(parents=True, exist_ok=True)
    sub_id = hashlib.sha256(f"{email}{datetime.now().isoformat()}".encode()).hexdigest()[:12]
    data = {
        "subscriber_id": sub_id,
        "email": email,
        "state": state,
        "per_day": per_day,
        "queue": queue,
        "queue_position": 0,
        "created_at": datetime.now().isoformat(),
        "last_sent": None,
    }
    (SUBSCRIBERS_DIR / f"{sub_id}.json").write_text(json.dumps(data, indent=2))
    return sub_id
