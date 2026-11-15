"""fetch_targets.py: inventario -> una etiqueta por observación -> nombre del objetivo."""
import csv

import pytest

import fetch_targets as ft

INV = (
    "P,urn:nasa:pds:mars2020_pixl:data_oxides_pmc:ps__0125_0678032243_000rqa__00417120483005510000___j01::1.1\n"
    "P,urn:nasa:pds:mars2020_pixl:data_oxides_pmc:ps__0125_0678032243_000rqb__00417120483005510000___j01::1.1\n"
    "P,urn:nasa:pds:mars2020_pixl:data_oxides_pmc:ps__1212_0774560000_000rqa__05600002483005510000___j01::1.1\n"
    "S,urn:nasa:pds:context:basura\n"
)
URL = "https://pds.invalid/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/collection_data_oxides_pmc_inventory.csv"


def label(name):
    return f"<x><name>PIXL Individual Point Oxide Compositions: {name} (Sol 0125), Detector A</name></x>"


def test_one_observation_per_scan():
    obs = ft.observations(INV)
    assert list(obs) == ["0125_0678032243", "1212_0774560000"]
    assert obs["0125_0678032243"]["site"] == 4 and obs["0125_0678032243"]["drive"] == 1712
    assert obs["1212_0774560000"]["site"] == 56


def test_label_url_next_to_inventory():
    obs = ft.observations(INV)["0125_0678032243"]
    assert ft.label_url(URL, obs) == ("https://pds.invalid/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/"
                                      "sol_00125/ps__0125_0678032243_000rqa__00417120483005510000___j01.xml")


def test_target_from_label():
    assert ft.target_from_label(label("Apollo Temple")) == "Apollo Temple"
    assert ft.target_from_label("<x><name>Otra cosa</name></x>") is None


def test_resume_does_not_ask_again(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "DATA_DIR", tmp_path)
    (tmp_path / "raw" / "jezero").mkdir(parents=True)
    (tmp_path / "raw" / "jezero" / "collection_data_oxides_pmc_inventory.csv").write_text(INV)
    asked = []
    monkeypatch.setattr(ft, "get", lambda url: asked.append(url) or label("Naltsos"))
    entry = {"key": "pixl_inventory", "url": URL}
    assert ft.run_entry("jezero", entry)
    assert len(asked) == 2
    assert ft.run_entry("jezero", entry)
    assert len(asked) == 2   # la segunda corrida no pide nada
    rows = list(csv.DictReader(open(tmp_path / "raw" / "jezero" / "targets" / "pixl_inventory.csv")))
    assert [(r["sol"], r["site"], r["drive"], r["target"]) for r in rows] == \
        [("125", "4", "1712", "Naltsos"), ("1212", "56", "0", "Naltsos")]


def test_missing_inventory(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "DATA_DIR", tmp_path)
    assert ft.run_entry("jezero", {"key": "pixl_inventory", "url": URL}) is False


def test_failed_label_is_retried_next_run(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "DATA_DIR", tmp_path)
    (tmp_path / "raw" / "jezero").mkdir(parents=True)
    (tmp_path / "raw" / "jezero" / "collection_data_oxides_pmc_inventory.csv").write_text(INV)

    def boom(url):
        raise OSError("timeout")

    monkeypatch.setattr(ft, "get", boom)
    ft.run_entry("jezero", {"key": "pixl_inventory", "url": URL})
    monkeypatch.setattr(ft, "get", lambda url: label("Naltsos"))
    ft.run_entry("jezero", {"key": "pixl_inventory", "url": URL})
    rows = list(csv.DictReader(open(tmp_path / "raw" / "jezero" / "targets" / "pixl_inventory.csv")))
    assert len(rows) == 2
