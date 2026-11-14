import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Para importar `api` como paquete corriendo pytest desde cualquier carpeta.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api import main  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """DATA_DIR vacío: el caso "la descarga todavía no terminó"."""
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def write_manifest(data_dir):
    def _write(manifest: dict) -> None:
        (data_dir / "manifest.json").write_text(json.dumps(manifest))

    return _write


@pytest.fixture
def client():
    return TestClient(main.app)
