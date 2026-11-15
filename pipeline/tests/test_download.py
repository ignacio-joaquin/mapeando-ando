"""download.fetch: User-Agent siempre y backoff largo ante 429/503 (skill mapeando-geodata)."""
import subprocess

import pytest

import download


class FakeCurl:
    """Devuelve (returncode, http_code) en orden y anota cada comando."""

    def __init__(self, *results):
        self.results = list(results)
        self.cmds = []

    def __call__(self, cmd, **_):
        self.cmds.append(cmd)
        rc, code = self.results.pop(0)
        return subprocess.CompletedProcess(cmd, rc, stdout=code)


@pytest.fixture
def sleeps(monkeypatch):
    got = []
    monkeypatch.setattr(download.time, "sleep", got.append)
    monkeypatch.setattr(download, "polite_wait", lambda url: None)
    return got


def test_sends_user_agent(tmp_path, monkeypatch, sleeps):
    curl = FakeCurl((0, "200"))
    monkeypatch.setattr(download.subprocess, "run", curl)
    download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    cmd = curl.cmds[0]
    assert cmd[cmd.index("-A") + 1] == download.UA
    assert "--retry" not in cmd          # los reintentos son del loop, no de curl


def test_503_waits_the_long_backoff(tmp_path, monkeypatch, sleeps):
    monkeypatch.setattr(download.subprocess, "run", FakeCurl((22, "503"), (22, "429"), (0, "200")))
    download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    assert sleeps == [download.BACKOFF_S, download.BACKOFF_S]


def test_404_fails_without_retrying(tmp_path, monkeypatch, sleeps):
    curl = FakeCurl((22, "404"))
    monkeypatch.setattr(download.subprocess, "run", curl)
    with pytest.raises(RuntimeError, match="HTTP 404"):
        download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    assert len(curl.cmds) == 1 and sleeps == []


def test_complete_file_is_success(tmp_path, monkeypatch, sleeps):
    monkeypatch.setattr(download.subprocess, "run", FakeCurl((33, "416")))
    download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")


def test_gives_up_after_backoff_tries(tmp_path, monkeypatch, sleeps):
    monkeypatch.setattr(download.subprocess, "run",
                        FakeCurl(*[(22, "503")] * (download.BACKOFF_TRIES + 1)))
    with pytest.raises(RuntimeError, match="HTTP 503"):
        download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    assert len(sleeps) == download.BACKOFF_TRIES


@pytest.mark.parametrize("code", ["500", "502", "504"])
def test_transient_5xx_retries_short(tmp_path, monkeypatch, sleeps, code):
    # Antes los reintentaba curl --retry; ahora el loop, con la espera corta de red.
    monkeypatch.setattr(download.subprocess, "run", FakeCurl((22, code), (0, "200")))
    download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    assert sleeps == [download.NET_RETRY_S]


def test_transient_5xx_gives_up(tmp_path, monkeypatch, sleeps):
    monkeypatch.setattr(download.subprocess, "run", FakeCurl(*[(22, "502")] * (download.NET_TRIES + 1)))
    with pytest.raises(RuntimeError, match="HTTP 502"):
        download.fetch("https://pds-geosciences.wustl.edu/x.csv", tmp_path / "x.csv")
    assert len(sleeps) == download.NET_TRIES
