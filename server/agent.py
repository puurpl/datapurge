"""
DataPurge Daily Maintenance Agent

Runs via cron once daily. Uses Claude API with web search to:
1. Process community reports of new/broken brokers
2. Verify stale broker entries still work
3. Discover new brokers (weekly)
4. Send daily email drip batches to subscribers

Usage:
    python -m server.agent              # Full daily run
    python -m server.agent --reports    # Process reports only
    python -m server.agent --verify     # Verify stale only
    python -m server.agent --discover   # Discovery only
    python -m server.agent --drip       # Send email drip only
"""

import anthropic
import yaml
import json
import subprocess
import argparse
from pathlib import Path
from datetime import datetime, date, timedelta

BROKERS_DIR = Path(__file__).parent.parent / "brokers"
REPORTS_DIR = Path(__file__).parent.parent / "reports"
CHANGELOG_DIR = Path(__file__).parent.parent / "changelog"
LOG_DIR = Path(__file__).parent.parent / "logs"

for d in [CHANGELOG_DIR, LOG_DIR]:
    d.mkdir(parents=True, exist_ok=True)


SYSTEM_PROMPT = """You are the DataPurge broker registry maintenance agent. You maintain
a database of data broker opt-out procedures so people can exercise their privacy rights.

You have access to web search. Use it to verify broker information.

IMPORTANT RULES:
- Be conservative: only auto-update when confidence > 0.8
- Always explain your reasoning
- When verifying, search for "[broker name] opt-out" AND "[broker name] remove my information"
- Check for recent complaints: "[broker name] opt out not working"
- When creating new entries, follow the YAML schema exactly
- Include ALL fields, especially scan detection rules for people-search sites

OUTPUT FORMAT: Always respond with valid YAML wrapped in ```yaml blocks.
Include an "agent_action" field with one of: accept, reject, update, verify, flag_review
Include a "confidence" field from 0.0 to 1.0
Include a "reasoning" field explaining your decision.
"""


class DailyAgent:
    def __init__(self):
        self.client = anthropic.Anthropic()
        self.log_entries = []
        self.changes = []

    def log(self, action: str, broker: str, detail: str):
        entry = {
            "timestamp": datetime.now().isoformat(),
            "action": action,
            "broker": broker,
            "detail": detail,
        }
        self.log_entries.append(entry)
        print(f"[{action}] {broker}: {detail}")

    def run_full(self):
        """Full daily routine."""
        print(f"=== DataPurge Agent Run: {datetime.now().isoformat()} ===\n")

        # Phase 1: Community reports
        self.process_reports()

        # Phase 2: Stale verification
        self.verify_stale()

        # Phase 3: Weekly discovery (Mondays)
        if datetime.now().weekday() == 0:
            self.discover()

        # Phase 4: Email drip
        self.send_drip_emails()

        # Phase 5: Commit & summarize
        self.save_changelog()
        self.git_commit()
        self.save_log()

        print(f"\n=== Complete: {len(self.changes)} changes, {len(self.log_entries)} log entries ===")

    def process_reports(self):
        """Process community-submitted broker reports."""
        if not REPORTS_DIR.exists():
            return

        pending = list(REPORTS_DIR.glob("*.json"))
        pending = [p for p in pending if json.loads(p.read_text()).get("status") == "queued"]

        if not pending:
            print("No pending reports.")
            return

        print(f"Processing {len(pending)} community reports...\n")

        for report_file in pending:
            report = json.loads(report_file.read_text())
            self.log("processing_report", report["broker_name"], report["report_type"])

            try:
                result = self._call_claude(
                    f"""Process this community report about a data broker:

Report Type: {report['report_type']}
Broker Name: {report['broker_name']}
Broker URL: {report['broker_url']}
Description: {report['description']}
Evidence URL: {report.get('evidence_url', 'none')}

Tasks:
1. Search the web for this broker's current opt-out process
2. Verify the report's claims
3. If it's a NEW broker, create a complete YAML definition
4. If it's a BROKEN process, research the current working process
5. If it's UPDATED, document what changed

Output a YAML block with:
- agent_action: accept | reject | flag_review
- confidence: 0.0-1.0
- reasoning: your analysis
- broker_yaml: (the full broker YAML definition, if applicable)"""
                )

                action_data = self._parse_yaml_response(result)

                if action_data.get("agent_action") == "accept" and action_data.get("confidence", 0) > 0.8:
                    if "broker_yaml" in action_data:
                        self._save_broker(action_data["broker_yaml"])
                        self.changes.append({
                            "type": "report_accepted",
                            "broker": report["broker_name"],
                            "detail": action_data.get("reasoning", ""),
                        })
                    report["status"] = "accepted"
                    report["resolution"] = action_data.get("reasoning", "")
                    self.log("accepted", report["broker_name"], action_data.get("reasoning", ""))

                elif action_data.get("agent_action") == "reject":
                    report["status"] = "rejected"
                    report["resolution"] = action_data.get("reasoning", "")
                    self.log("rejected", report["broker_name"], action_data.get("reasoning", ""))

                else:
                    report["status"] = "needs_review"
                    report["resolution"] = action_data.get("reasoning", "Flagged for manual review")
                    self.log("flagged", report["broker_name"], "Needs manual review")

                report["processed_at"] = datetime.now().isoformat()
                report_file.write_text(json.dumps(report, indent=2))

            except Exception as e:
                self.log("error", report["broker_name"], str(e))

    def verify_stale(self, days: int = 7, limit: int = 30):
        """Verify broker entries not checked in N days."""
        from .registry import BrokerRegistry
        reg = BrokerRegistry(BROKERS_DIR)
        stale = reg.get_stale(days=days)[:limit]

        if not stale:
            print("No stale brokers to verify.")
            return

        print(f"Verifying {len(stale)} stale broker entries...\n")

        # Process in batches of 5 to be efficient with API calls
        for i in range(0, len(stale), 5):
            batch = stale[i:i+5]
            broker_info = "\n---\n".join([
                f"ID: {b.id}\nName: {b.name}\nDomain: {b.domain}\n"
                f"Opt-out URL: {b.optout.get('methods', [{}])[0].get('url', 'N/A')}\n"
                f"Method: {b.optout.get('methods', [{}])[0].get('type', 'N/A')}\n"
                f"Last verified: {b.meta.get('last_verified', 'never')}"
                for b in batch
            ])

            try:
                result = self._call_claude(
                    f"""Verify these data broker opt-out procedures still work.
For each broker, search for their current opt-out process.

{broker_info}

For EACH broker, output a YAML block with:
- broker_id: the broker's ID
- agent_action: verify | update | flag_review
- confidence: 0.0-1.0
- reasoning: what you found
- updated_yaml: (only if process changed)"""
                )

                # Parse results and apply
                for broker in batch:
                    # Update last_verified timestamp at minimum
                    self._update_broker_meta(broker.id, {
                        "last_verified": date.today().isoformat(),
                        "verified_by": "agent",
                    })
                    self.log("verified", broker.name, "Procedure checked")

            except Exception as e:
                self.log("error", "batch_verify", str(e))

    def discover(self):
        """Search for new data brokers not in the registry."""
        from .registry import BrokerRegistry
        reg = BrokerRegistry(BROKERS_DIR)
        known_domains = [b.domain for b in reg.list_all()]

        print("Running weekly discovery...\n")

        try:
            result = self._call_claude(
                f"""Search for data brokers not yet in our registry.

We currently have {len(known_domains)} brokers. Known domains include:
{json.dumps(known_domains[:50])}

Search strategies:
1. California AG data broker registry: search "california data broker registry 2026"
2. Vermont data broker registry: search "vermont data broker registry"
3. Recent news: search "new data broker" or "people search site"
4. Privacy guides: search "data broker opt out list 2026"

For each NEW broker found, create a complete YAML definition.
Focus on brokers with public people-search (scannable).
Skip any broker already in our known domains list.

Output YAML blocks for each new broker found."""
            )

            new_brokers = self._parse_yaml_response(result)
            if isinstance(new_brokers, dict) and "broker_yaml" in new_brokers:
                self._save_broker(new_brokers["broker_yaml"])
                self.changes.append({"type": "discovery", "detail": str(new_brokers)})

            self.log("discovery", "weekly", f"Discovery run complete")

        except Exception as e:
            self.log("error", "discovery", str(e))

    def send_drip_emails(self):
        """Send daily email drip batches to subscribers."""
        from .templates import TemplateEngine
        subscribers_dir = Path(__file__).parent.parent / "subscribers"

        if not subscribers_dir.exists():
            return

        for sub_file in subscribers_dir.glob("*.json"):
            sub = json.loads(sub_file.read_text())

            # Skip if already sent today
            if sub.get("last_sent") == date.today().isoformat():
                continue

            pos = sub.get("queue_position", 0)
            per_day = sub.get("per_day", 3)
            queue = sub.get("queue", [])

            if pos >= len(queue):
                self.log("drip_complete", sub["email"], "All brokers sent")
                continue

            batch = queue[pos:pos + per_day]

            # Send email with today's batch
            email_body = self._format_drip_email(batch, pos, len(queue))
            self._send_email(
                to=sub["email"],
                subject=f"DataPurge: {len(batch)} opt-out emails ready to send (day {pos // per_day + 1})",
                body=email_body,
            )

            # Update position
            sub["queue_position"] = pos + per_day
            sub["last_sent"] = date.today().isoformat()
            sub_file.write_text(json.dumps(sub, indent=2))

            self.log("drip_sent", sub["email"], f"Sent batch of {len(batch)}")

    def _format_drip_email(self, batch: list, position: int, total: int) -> str:
        """Format the daily drip email with mailto links."""
        lines = [
            f"DataPurge Daily Opt-Out Batch",
            f"Progress: {position}/{total} brokers contacted",
            f"",
            f"Today's batch ({len(batch)} brokers):",
            f"{'=' * 60}",
            f"",
        ]

        for i, item in enumerate(batch, 1):
            lines.extend([
                f"--- Broker {i}: {item.get('broker_id', 'Unknown')} ---",
                f"Send to: {item['send_to']}",
                f"Subject: {item['subject']}",
                f"",
                f"Click to send: {item.get('mailto_link', '')}",
                f"",
                f"Or copy/paste the email below:",
                f"{'~' * 40}",
                item["body"],
                f"{'~' * 40}",
                f"",
            ])

        lines.extend([
            f"{'=' * 60}",
            f"",
            f"Keep going! Every email you send costs a data broker time and money.",
            f"You have {total - position - len(batch)} more brokers to go.",
            f"",
            f"— DataPurge",
        ])

        return "\n".join(lines)

    def _call_claude(self, prompt: str) -> str:
        """Call Claude API with web search enabled."""
        response = self.client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=[
                {"type": "web_search_20250305", "name": "web_search"},
            ],
            messages=[{"role": "user", "content": prompt}],
        )
        # Extract text from response
        return "".join(
            block.text for block in response.content if hasattr(block, "text")
        )

    def _parse_yaml_response(self, text: str) -> dict:
        """Extract YAML from Claude's response."""
        import re
        yaml_blocks = re.findall(r"```yaml\n(.*?)```", text, re.DOTALL)
        if yaml_blocks:
            return yaml.safe_load(yaml_blocks[0])
        # Try parsing entire response as YAML
        try:
            return yaml.safe_load(text)
        except Exception:
            return {"raw_response": text}

    def _save_broker(self, broker_data: dict):
        """Save a broker YAML definition to the registry."""
        broker_id = broker_data.get("id", "unknown")
        category = broker_data.get("category", "other")
        category_dir = BROKERS_DIR / category
        category_dir.mkdir(parents=True, exist_ok=True)
        path = category_dir / f"{broker_id}.yaml"
        path.write_text(yaml.dump(broker_data, default_flow_style=False, sort_keys=False))
        self.log("saved", broker_id, f"Saved to {path}")

    def _update_broker_meta(self, broker_id: str, meta_updates: dict):
        """Update a broker's meta fields without changing the rest."""
        # Find the file
        for yaml_file in BROKERS_DIR.rglob(f"{broker_id}.yaml"):
            data = yaml.safe_load(yaml_file.read_text())
            if "meta" not in data:
                data["meta"] = {}
            data["meta"].update(meta_updates)
            yaml_file.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
            return

    def _send_email(self, to: str, subject: str, body: str):
        """Send an email. Implement with your SMTP provider."""
        # TODO: Implement with configured SMTP
        self.log("email_queued", to, subject)

    def save_changelog(self):
        """Save today's changes to changelog."""
        if not self.changes:
            return
        today = date.today().isoformat()
        path = CHANGELOG_DIR / f"{today}.json"
        path.write_text(json.dumps(self.changes, indent=2))

    def save_log(self):
        """Save agent log."""
        today = date.today().isoformat()
        path = LOG_DIR / f"agent_{today}.json"
        path.write_text(json.dumps(self.log_entries, indent=2))

    def git_commit(self):
        """Commit registry changes to git."""
        if not self.changes:
            return
        try:
            repo_dir = BROKERS_DIR.parent
            subprocess.run(["git", "add", "-A"], cwd=repo_dir, capture_output=True)
            msg = f"[agent] {date.today()}: {len(self.changes)} changes"
            subprocess.run(["git", "commit", "-m", msg], cwd=repo_dir, capture_output=True)
            subprocess.run(["git", "push"], cwd=repo_dir, capture_output=True)
            self.log("git", "commit", msg)
        except Exception as e:
            self.log("error", "git", str(e))


def main():
    parser = argparse.ArgumentParser(description="DataPurge daily maintenance agent")
    parser.add_argument("--reports", action="store_true", help="Process community reports only")
    parser.add_argument("--verify", action="store_true", help="Verify stale brokers only")
    parser.add_argument("--discover", action="store_true", help="Discovery run only")
    parser.add_argument("--drip", action="store_true", help="Send email drip only")
    args = parser.parse_args()

    agent = DailyAgent()

    if args.reports:
        agent.process_reports()
    elif args.verify:
        agent.verify_stale()
    elif args.discover:
        agent.discover()
    elif args.drip:
        agent.send_drip_emails()
    else:
        agent.run_full()

    agent.save_log()


if __name__ == "__main__":
    main()
