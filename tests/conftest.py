import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.registry import BrokerRegistry  # noqa: E402
from server.templates import TemplateEngine  # noqa: E402


@pytest.fixture(scope="session")
def brokers_dir() -> Path:
    return ROOT / "brokers"


@pytest.fixture(scope="session")
def registry(brokers_dir) -> BrokerRegistry:
    return BrokerRegistry(brokers_dir)


@pytest.fixture(scope="session")
def schema() -> dict:
    return json.loads((ROOT / "schema" / "broker.schema.json").read_text())


@pytest.fixture(scope="session")
def yaml_files(brokers_dir) -> list[Path]:
    return sorted(brokers_dir.rglob("*.yaml"))


@pytest.fixture(scope="session")
def yaml_docs(yaml_files) -> dict[Path, dict]:
    return {f: yaml.safe_load(f.read_text()) for f in yaml_files}


@pytest.fixture(scope="session")
def engine() -> TemplateEngine:
    return TemplateEngine(ROOT / "templates")
