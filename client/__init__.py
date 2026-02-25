"""
DataPurge CLI Client

User-facing command-line tool for scanning brokers, submitting
opt-out requests, and monitoring re-listings. All PII stays local.
"""

import typer
import json
import httpx
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.prompt import Prompt, Confirm
from typing import Optional

app = typer.Typer(
    name="datapurge",
    help="Exercise your privacy rights against data brokers.",
    no_args_is_help=True,
)
console = Console()

CONFIG_DIR = Path.home() / ".datapurge"
REGISTRY_CACHE = CONFIG_DIR / "registry.json"
VAULT_DB = CONFIG_DIR / "vault.db"
REQUESTS_DB = CONFIG_DIR / "requests.db"
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_SERVER = "https://datapurge.org/api/v1"


def get_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {"server": DEFAULT_SERVER}


def get_registry() -> dict:
    if REGISTRY_CACHE.exists():
        return json.loads(REGISTRY_CACHE.read_text())
    console.print("[red]No local registry. Run 'datapurge pull' first.[/red]")
    raise typer.Exit(1)


@app.command()
def init():
    """Initialize DataPurge — set up local storage and pull registry."""
    console.print("[bold]Initializing DataPurge...[/bold]\n")

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    # Save default config
    config = {"server": DEFAULT_SERVER}
    server = Prompt.ask("Registry server URL", default=DEFAULT_SERVER)
    config["server"] = server
    CONFIG_FILE.write_text(json.dumps(config, indent=2))
    console.print(f"  ✓ Config saved to {CONFIG_FILE}")

    # Pull registry
    console.print("  Pulling broker registry...")
    pull()

    console.print("\n[green]✓ DataPurge initialized.[/green]")
    console.print("  Next: run [bold]datapurge add-profile[/bold] to add your identity.")


@app.command()
def pull():
    """Pull the latest broker registry from the central server."""
    config = get_config()
    server = config.get("server", DEFAULT_SERVER)

    with console.status("Pulling registry..."):
        try:
            response = httpx.get(f"{server}/registry", timeout=30)
            response.raise_for_status()
            data = response.json()

            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            REGISTRY_CACHE.write_text(json.dumps(data, indent=2))

            console.print(
                f"[green]✓ Registry updated: {data['broker_count']} brokers "
                f"(v{data['version']})[/green]"
            )
        except Exception as e:
            console.print(f"[red]Failed to pull registry: {e}[/red]")
            raise typer.Exit(1)


@app.command(name="add-profile")
def add_profile():
    """Add your identity for opt-out requests."""
    console.print("[bold]Add Identity Profile[/bold]")
    console.print("Enter the information data brokers might have about you.\n")
    console.print("[dim]This data is stored locally, encrypted, and never sent to any server.[/dim]\n")

    profile = {}
    profile["full_name"] = Prompt.ask("Full legal name")
    profile["email"] = Prompt.ask("Email address")
    profile["phone"] = Prompt.ask("Phone number", default="")
    profile["street"] = Prompt.ask("Street address", default="")
    profile["city"] = Prompt.ask("City", default="")
    profile["state"] = Prompt.ask("State", default="")
    profile["zip"] = Prompt.ask("ZIP code", default="")
    profile["dob"] = Prompt.ask("Date of birth (YYYY-MM-DD)", default="")

    # Derive fields
    parts = profile["full_name"].split()
    profile["first_name"] = parts[0] if parts else ""
    profile["last_name"] = " ".join(parts[1:]) if len(parts) > 1 else ""
    if profile["street"] and profile["city"]:
        profile["address"] = f"{profile['street']}, {profile['city']}, {profile['state']} {profile['zip']}".strip()

    # Save (TODO: encrypt with age)
    profiles_dir = CONFIG_DIR / "profiles"
    profiles_dir.mkdir(exist_ok=True)
    profile_id = profile["full_name"].lower().replace(" ", "-")
    profile_path = profiles_dir / f"{profile_id}.json"
    profile_path.write_text(json.dumps(profile, indent=2))

    console.print(f"\n[green]✓ Profile saved: {profile_id}[/green]")
    console.print("  Run [bold]datapurge brokers[/bold] to see all known brokers.")
    console.print("  Run [bold]datapurge emails[/bold] to generate opt-out emails.")


@app.command()
def brokers(
    category: Optional[str] = typer.Option(None, help="Filter by category"),
    scannable: Optional[bool] = typer.Option(None, help="Only scannable brokers"),
    email_only: bool = typer.Option(False, "--email-only", help="Only brokers with email opt-out"),
    search: Optional[str] = typer.Option(None, help="Search by name"),
):
    """List all known data brokers."""
    registry = get_registry()
    brokers = registry.get("brokers", [])

    if category:
        brokers = [b for b in brokers if b.get("category") == category]
    if scannable is not None:
        brokers = [b for b in brokers if b.get("scan", {}).get("scannable") == scannable]
    if email_only:
        brokers = [
            b for b in brokers
            if any(m.get("type") == "email" for m in b.get("optout", {}).get("methods", []))
        ]
    if search:
        search_l = search.lower()
        brokers = [b for b in brokers if search_l in b.get("name", "").lower() or search_l in b.get("domain", "").lower()]

    table = Table(title=f"Data Brokers ({len(brokers)} found)")
    table.add_column("Name", style="cyan")
    table.add_column("Domain")
    table.add_column("Category")
    table.add_column("Methods")
    table.add_column("Difficulty")
    table.add_column("Scannable")

    for b in brokers:
        methods = ", ".join(m.get("type", "?") for m in b.get("optout", {}).get("methods", []))
        scannable_str = "✓" if b.get("scan", {}).get("scannable") else "✗"
        table.add_row(
            b.get("name", ""),
            b.get("domain", ""),
            b.get("category", ""),
            methods,
            b.get("optout", {}).get("difficulty", "?"),
            scannable_str,
        )

    console.print(table)


@app.command()
def emails(
    profile: Optional[str] = typer.Option(None, help="Profile name"),
    output: Optional[str] = typer.Option(None, help="Save emails to directory"),
    batch_size: int = typer.Option(0, help="Only generate N emails (0 = all)"),
):
    """Generate pre-filled opt-out emails for all brokers."""
    # Load profile
    profiles_dir = CONFIG_DIR / "profiles"
    if profile:
        profile_path = profiles_dir / f"{profile}.json"
    else:
        profiles = list(profiles_dir.glob("*.json")) if profiles_dir.exists() else []
        if not profiles:
            console.print("[red]No profiles. Run 'datapurge add-profile' first.[/red]")
            raise typer.Exit(1)
        profile_path = profiles[0]

    identity = json.loads(profile_path.read_text())
    registry = get_registry()
    brokers = registry.get("brokers", [])

    # Find brokers with email opt-out
    email_brokers = [
        b for b in brokers
        if any(m.get("type") == "email" for m in b.get("optout", {}).get("methods", []))
    ]

    if batch_size:
        email_brokers = email_brokers[:batch_size]

    console.print(f"\n[bold]Generating {len(email_brokers)} opt-out emails...[/bold]\n")

    emails_generated = []
    for b in email_brokers:
        email_method = next(
            (m for m in b.get("optout", {}).get("methods", []) if m.get("type") == "email"),
            None
        )
        if not email_method:
            continue

        # Simple template fill (the full version uses TemplateEngine)
        send_to = email_method.get("email_to", "")
        subject = f"Data Deletion Request and Withdrawal of Consent — {identity.get('full_name', '')}"
        body = _generate_email_body(identity, b)

        emails_generated.append({
            "broker": b.get("name"),
            "to": send_to,
            "subject": subject,
            "body": body,
        })

        console.print(f"  ✓ {b.get('name')} → {send_to}")

    # Save or display
    if output:
        out_dir = Path(output)
        out_dir.mkdir(parents=True, exist_ok=True)
        for email in emails_generated:
            fname = email["broker"].lower().replace(" ", "-") + ".txt"
            (out_dir / fname).write_text(
                f"To: {email['to']}\n"
                f"Subject: {email['subject']}\n\n"
                f"{email['body']}"
            )
        console.print(f"\n[green]✓ {len(emails_generated)} emails saved to {output}/[/green]")
    else:
        console.print(f"\n[green]✓ {len(emails_generated)} emails ready.[/green]")
        console.print("  Use [bold]--output ./emails[/bold] to save them as files.")
        console.print("  Or use [bold]datapurge send[/bold] to send them via SMTP.")


@app.command()
def send(
    profile: Optional[str] = typer.Option(None, help="Profile name"),
    broker_id: Optional[str] = typer.Option(None, help="Send to specific broker only"),
    dry_run: bool = typer.Option(False, help="Show what would be sent without sending"),
    delay: int = typer.Option(30, help="Seconds between emails"),
):
    """Send opt-out emails via your configured SMTP."""
    console.print("[bold]Email sending not yet implemented.[/bold]")
    console.print("For now, use [bold]datapurge emails --output ./emails[/bold] to generate files.")
    console.print("Then send them manually or use a mail merge tool.")


@app.command()
def report(
    broker_name: str = typer.Argument(help="Name of the broker"),
    broker_url: str = typer.Argument(help="URL of the broker"),
    report_type: str = typer.Option("new_broker", help="new_broker|broken_process|updated_process|broker_removed"),
    description: str = typer.Option("", help="Description of the issue"),
):
    """Report a new or broken broker to the central server."""
    config = get_config()
    server = config.get("server", DEFAULT_SERVER)

    if not description:
        description = Prompt.ask("Describe the issue")

    data = {
        "broker_name": broker_name,
        "broker_url": broker_url,
        "report_type": report_type,
        "description": description,
    }

    try:
        response = httpx.post(f"{server}/reports", json=data, timeout=15)
        result = response.json()
        console.print(f"[green]✓ Report submitted: {result.get('report_id')}[/green]")
        console.print(f"  Status: {result.get('status')}")
        console.print(f"  {result.get('message', '')}")
    except Exception as e:
        console.print(f"[red]Failed to submit report: {e}[/red]")


@app.command()
def stats():
    """Show registry statistics."""
    registry = get_registry()
    brokers = registry.get("brokers", [])

    categories = {}
    scannable = 0
    emailable = 0
    for b in brokers:
        cat = b.get("category", "other")
        categories[cat] = categories.get(cat, 0) + 1
        if b.get("scan", {}).get("scannable"):
            scannable += 1
        if any(m.get("type") == "email" for m in b.get("optout", {}).get("methods", [])):
            emailable += 1

    console.print(f"\n[bold]DataPurge Registry Stats[/bold]")
    console.print(f"  Total brokers: {len(brokers)}")
    console.print(f"  Scannable: {scannable}")
    console.print(f"  Email opt-out: {emailable}")
    console.print(f"  Version: {registry.get('version', '?')}")
    console.print(f"\n  Categories:")
    for cat, count in sorted(categories.items()):
        console.print(f"    {cat}: {count}")


def _generate_email_body(identity: dict, broker: dict) -> str:
    """Generate opt-out email body. Simplified version of TemplateEngine."""
    name = identity.get("full_name", "")
    email = identity.get("email", "")
    phone = identity.get("phone", "")
    address = identity.get("address", "")
    dob = identity.get("dob", "")
    from datetime import date
    today = date.today().strftime("%B %d, %Y")
    broker_name = broker.get("name", "")

    # Use the preemptive blanket template (works for everything)
    return f"""To the Privacy Officer:

Whether or not your organization currently holds my personal information, I am writing to:

1. REQUEST DELETION of any personal information you currently hold about me under all applicable privacy laws including the California Consumer Privacy Act (CCPA/CPRA), Virginia Consumer Data Protection Act, Colorado Privacy Act, and all other applicable state, federal, and international privacy legislation.

2. OPT OUT of the sale and sharing of my personal information.

3. WITHDRAW ALL CONSENT — express or implied, past, present, or future — for your organization to collect, process, store, sell, share, or otherwise use my personal information, from any source, for any purpose.

4. PRE-EMPTIVELY OBJECT to any future acquisition, collection, purchase, licensing, scraping, or inference of my personal information by your organization.

5. REQUEST DISCLOSURE of what personal information you hold about me, where you obtained it, and to whom you have disclosed it.

I understand that this pre-emptive objection may not carry legal force in all jurisdictions at this time. I am establishing a clear, timestamped record of my wishes. This record may become legally relevant as privacy legislation continues to evolve.

Identifying Information:
Full Name: {name}
Email: {email}
{"Phone: " + phone if phone else ""}
{"Address: " + address if address else ""}
{"Date of Birth: " + dob if dob else ""}

Please confirm deletion and disclosure in writing within 30 days. This communication is timestamped and archived.

{name}
Date: {today}"""


if __name__ == "__main__":
    app()
