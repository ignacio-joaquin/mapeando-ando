# Mapa Marciano

*English · [Español](README.es.md)*

A survival map for a spacewalk (EVA) on the surface of Mars, built on real NASA data. Made by team **Mapeando Ando** for the NASA Space Apps Challenge 2026, challenge *Interplanetary Survival Guide: Martian Map*.

**Demo:** <http://3.22.102.116/> (no HTTPS: we don't have a domain yet). The app's interface is in Spanish.

**Space Apps project page:** link pending, added once the project is published.

> **Educational prototype, not flight software.** The numbers help you understand what limits an EVA, not plan a real one. The app says so on screen too.

The detailed method documents in [`docs/`](docs/) are in Spanish. This README summarizes everything needed to trace each number back to its source.

## Contents

- [What it does](#what-it-does)
- [How to read each number](#how-to-read-each-number)
- [NASA data we use](#nasa-data-we-use)
- [Model assumptions](#model-assumptions)
- [How to run it](#how-to-run-it)
- [Repository layout](#repository-layout)
- [Use of AI](#use-of-ai)
- [Credits](#credits)

## What it does

It answers the questions of someone standing on Mars, helmet on and short on time:

| Question | What the app shows |
|---|---|
| Can I step here? | Slope and terrain hazard at 1 m (slope + roughness + loose soil from THEMIS). The "impassable" cutoff is the same on the map and in the planner: 25°. |
| Which way do I go, and how do I get back? | 4D planner: you mark the habitat, the stops, the destination and the departure time. The API finds the **safest** route, not the shortest: A\* over slope, shadow at the time you pass and line of sight to the habitat. The return trip is included by default. |
| Will my O2 and battery last? | Suit consumption leg by leg (Pandolf adapted to 0.38 g), with the load you choose to carry. |
| How much radiation will I accumulate? | Dose budget for the traverse, based on the dose measured by Curiosity's RAD. |
| How much daylight is left? | Hour-by-hour shadows computed from the terrain and SPICE ephemerides, with a Sun slider on the map. |
| Can the habitat hear me? | Where there is radio line of sight to the habitat, and how many minutes in a row you walk without it. |
| Where do I take cover? | Shelters (places with little visible sky) and walking minutes to the nearest one. |
| How do I find my way without GPS? | Directions for each stretch based on the landscape ("head toward the hill at 12 o'clock, about 8 min"), using craters and hills visible from 1.7 m eye height, and the Sun and your shadow to confirm the heading. |

Everything ends in a **GO / CAUTION / NO-GO** verdict that names the limit that governs (for example, "limited by: return before sunset") and in how many stress scenarios the route still holds. There is also a first-person horizon view from each stop (Three.js over the real terrain) and a training mode whose lessons are graded against the planner's real response.

Two sites: **Jezero** (Perseverance) and **Gale** (Curiosity). Adding another one means adding a JSON file to `sites/`.

## How to read each number

Every number in the app carries a badge with its provenance, mission and instrument (for example `MRO HiRISE · DERIVED` or `MSL RAD · MODELED`). The tooltip shows the resolution, the source and the assumptions.

| Badge | Meaning | Example |
|---|---|---|
| **OBSERVED** | Measured by an instrument. | HiRISE DTM elevation, mass of an Apollo tool |
| **DERIVED** | Deterministic calculation from observed data. | Slope, shadow at a given time, crater position |
| **MODELED** | Comes from a model with assumptions, and the assumptions are shown. | O2 used, accumulated dose, minutes to shelter |
| **ASSUMED** | Value chosen by the team, with no citable source yet. | 25° maximum slope, 10 minutes in a row without contact |

If a value is missing, the app says it is missing (`value: null`): it never fills the gap with an estimate. With partial data it still answers, says what it could not evaluate, and the verdict drops to CAUTION.

## NASA data we use

What gets downloaded is declared in [`sites/*.json`](sites/) and in the `pipeline/fetch_*` scripts. Downloads are targeted, one request at a time per server, honoring the PDS `Crawl-delay` (10 s).

| Data | Source | Mission · instrument | Resolution | Badge in the app | Used for |
|---|---|---|---|---|---|
| Jezero topography | [Mars 2020 TRN HiRISE DTM](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif) (USGS), ~21 × 21 km | MRO · HiRISE | 1 m | OBSERVED (elevation) → DERIVED (slope, hillshade, contours, hazard) | The base for almost everything: route, shadows, shelters, contact, 3D relief |
| Gale topography | [Gale merged DEM v3](https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif) (USGS) | MRO · HiRISE; CTX, HRSC and MOLA where there is no HiRISE stereo | 1 m grid (less real detail in filled areas) | same | same |
| Global topography | [MOLA + HRSC blended DEM v2](https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif) (USGS), cropped per site | MGS · MOLA + Mars Express · HRSC | 200 m | OBSERVED → DERIVED | Far horizon: the crater rim's shadow, visible sky for the dose model and distant relief in the first-person horizon |
| Jezero imagery | [HiRISE orthomosaic](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif) (USGS) | MRO · HiRISE | 25 cm (served at up to ~0.64 m/px) | OBSERVED | Map background |
| Gale imagery | [HiRISE LRGB color mosaic](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif) (USGS) | MRO · HiRISE | — | OBSERVED | Map background |
| Ephemerides | [NAIF SPICE generic kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/): `naif0012.tls`, `pck00011.tpc`, `de440s.bsp` and the latest `mar*.bsp` | NASA/JPL · NAIF | — | DERIVED | Sun position for shadows, sunrise and sunset |
| Thermal | THEMIS nighttime IR controlled mosaics (USGS): [Syrtis Major](https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_nir/mc13_syrtis_major_nir.tif) and [Aeolis](https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc23_aeolis_nir/mc23_aeolis_nir.tif) | Mars Odyssey · THEMIS | 100 m | OBSERVED (8-bit relative brightness, not temperature) → MODELED (loose soil) | Rock or sand? Raises the hazard from "low" to "medium" where the soil is probably loose |
| Radiation | [RAD surface dose](https://doi.org/10.1126/science.1244797): 0.64 ± 0.12 mSv/day (Hassler et al. 2014; [`reference/rad_surface_dose.json`](reference/rad_surface_dose.json)) | MSL Curiosity · RAD | a single measurement at Gale; the layer is at 100 m | MODELED | Dose budget for the traverse |
| Subsurface ice | [SWIM 2.0](https://swim.psi.edu/), 0–1 m ice consistency composite | Odyssey (neutrons), MGS TES and THEMIS (thermal), MRO (geomorphology and SHARAD radar) | ~3 km | MODELED | Is there ice nearby? At both sites it changes no decision, so the layer is hidden on the map |
| Spectral | CRISM MTRDR (summary-parameter browse products) through the PDS Geosciences [Orbital Data Explorer](https://ode.rsl.wustl.edu/mars/) | MRO · CRISM | that of the MTRDR product | DERIVED | Mineral signals as possible destinations: a hint from orbit, not an identification |
| Place names | [IAU/USGS Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/) | IAU · USGS | — | DERIVED | Named landmarks for directions and search |
| Craters | [Robbins & Hynek 2012 crater database](https://astrogeology.usgs.gov/pygeoapi/collections/mars/robbinsv1) (USGS OGC API) | Mars Odyssey · THEMIS (the daytime mosaic the database was built on) | craters ≥ 1 km | DERIVED | Unnamed landmarks for orientation |
| Rover traverse | MMGIS waypoints: [Perseverance](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), [Ingenuity](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/m20_heli_waypoints.json) and [Curiosity](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) | Mars 2020 · MSL | — | DERIVED | Known places to search and plan (rover positions, Ingenuity airfields) |
| Samples | [Three Forks sample tube locations](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_sample_depot_three_forks/miscellaneous/sample_metadata/sample_tube_locations.csv) (PDS Geosciences) | Mars 2020 | rover position when each tube was dropped | DERIVED | The sample depot as a destination |
| Science targets | Observation lists in PDS Geosciences: [SuperCam](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_supercam/data_observation_log/m2020_scam_masterlist.csv) and [PIXL](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/collection_data_oxides_pmc_inventory.csv) at Jezero; [ChemCam](https://pds-geosciences.wustl.edu/msl/msl-m-chemcam-libs-4_5-rdr-v1/mslccm_1xxx/document/msl_ccam_obs.csv) and APXS ([sols 0–3076](https://pds-geosciences.wustl.edu/msl/urn-nasa-pds-msl_apxs_supplement_sols_0_3076/data/ds01_2021je007171r.csv), [3054–3712](https://pds-geosciences.wustl.edu/msl/urn-nasa-pds-msl_apxs_supplement_sols_3054_3712/data/ds01_2024.csv)) at Gale | Mars 2020 · SuperCam, PIXL; MSL · ChemCam, APXS | position measured by APXS, or the rover's position when measuring (flagged if it was more than 10 m away) | DERIVED | Named destinations where the rover measured something |
| Tool masses | Apollo 16 and 17 tools (Allton 1989, JSC-23454; *Apollo Lunar Surface Journal*) | Apollo | — | OBSERVED (measured mass), assuming a Mars kit would weigh the same | How much O2 does carrying the drill cost? |

Local solar time and season (Ls) come from NASA GISS's [Mars24](https://www.giss.nasa.gov/tools/mars24/) algorithm (Allison & McEwen 2000), the same one in the API and in the browser. A check against SPICE (`pipeline/check_mars24.py`) is in place, but its reference output is not in the repo yet.

**Downloaded but not used yet.** These are on the server, but no pipeline step processes them yet, so the app shows "missing data" where they would go: MEDA (Mars 2020) and REMS (MSL) for current conditions, DONKI space-weather alerts (WSA-Enlil), RIMFAX radargrams, the crustal magnetic field from Langlais et al. 2019, SuperCam, ChemCam and PIXL chemistry, and daytime THEMIS. Rover photos for each stop have a defined API contract, but the endpoint is not implemented. Details (in Spanish) in [`docs/infra y setup.md`](docs/infra%20y%20setup.md#4-datos).

## Model assumptions

Every number that does not come from a measurement is listed here. The **ASSUMED** ones were chosen by the team and are open to discussion: changing one means editing one line of code and the row of the doc that explains it. In the planner's settings tab ("Ajustes") a user can change the limits and weights for a route (except the maximum slope), and the verdict then states that it was computed with user settings.

### Verdict limits (`api/safety.py`)

Breaking any one of them means NO-GO. They don't offset each other. Details in [`docs/seguridad.md`](docs/seguridad.md).

| Limit | Value | Badge of the value | How it is measured on the route |
|---|---|---|---|
| Maximum slope | **25°** | ASSUMED | The slope that cannot be avoided in each A\* cell (the f-th highest of its f × f pixels): a steep strip crossing the cell blocks it, a single loose rock does not |
| O2 reserve on return | **20%** of capacity | MODELED (suit capacity; the 20% is ours) | O2 used according to Pandolf |
| Battery reserve on return | **20%** | MODELED (same) | Fixed electrical draw of the suit |
| Back before sunset | **30 min** margin | MODELED (sunset from the shadow stack; the margin is ours). ASSUMED when there is no stack | Traverse duration vs. sunset over the real terrain |
| Minutes in a row without contact | **10 min** (briefing default) | ASSUMED | Longest stretch without line of sight to the habitat, including stops |
| Dose per EVA | **0.5 mSv** (under review) | ASSUMED | Average dose rate along the route × time outside |
| Calories | not defined | — | Computed and shown, but not counted in the verdict |

- **Score** = 100 × the smallest margin among the limits (margin = 1 − used / limit). The limit that gives that minimum is the limiting factor shown in the UI.
- **CAUTION** if the score is below 20, if the route fails any stress scenario, or if a limit could not be fully evaluated. **GO** otherwise.
- **Robustness:** the same route, with the path unchanged, evaluated again leaving 30 min late, walking 20% slower and carrying 10% more load. "Dust storm" and "nearest shelter unavailable" are listed as **not evaluable**: we have no model that computes them, and we don't make up their effect.

### Choosing the route: A\* cost (`api/planner.py`)

```text
cost = Σ cells Δt · (1 + Σ_k w_k · r_k(cell, arrival time))
```

`Δt` is the walking time and each `r_k` goes from 0 to 1 in the cell, **at the time you arrive**: that is what makes the planner 4D. Active weights: slope (w = 2), shadow at that time (w = 1) and no line of sight to the habitat (w = 1). Roughness, loose soil and terrain-dependent radiation have weights, but the A\* does not read them yet. The weights are the team's.

### Terrain hazard (`pipeline/terrain_layers.py`)

The class is the worse of the slope class and the roughness class (σ of the detrended DTM over 5 m). Details and the reasoning behind each cutoff (in Spanish) in [`docs/terreno.md`](docs/terreno.md).

| Class | Slope | Roughness σ | ≈ steps of |
|---|---|---|---|
| low | < 10° | < 0.15 m | < 0.3 m |
| medium | 10–20° | 0.15–0.25 m | 0.3–0.5 m |
| high | 20–25° | 0.25–0.40 m | 0.5–0.8 m |
| impassable | ≥ 25° | ≥ 0.40 m | ~1 m or more |

- The 25° cutoff is a team decision, not taken from the literature. For reference, Apollo astronauts walked on slopes below 15° (Iqbal et al. 2024).
- **Loose soil (THEMIS, MODELED):** the coldest 20% at night within the site, only if that percentile is at least 5 DN away from the median. It raises "low" to "medium", never higher: 100 m data is enough to warn, not to block. Both numbers are ours.
- Slope is computed with the true pixel size on the sphere (radius 3,396,190 m): at Jezero, `gdaldem` gave 28.7° where the slope is actually 30°.
- A 1 m DTM cannot see rocks smaller than ~3–5 m, and its vertical precision is in the tens of cm.

### Suit and consumables (`api/consumables.py`)

Pandolf et al. (1977) with the downhill correction from Santee et al. (2001), integrated every 10 m over the DTM and adapted to 0.38 g: the load and walking terms scale with gravity and the standing term does not (our hypothesis). Defaults are those of the ISS EMU suit. Formula, endpoint contract and sources (in Spanish) in [`docs/consumibles del traje.md`](docs/consumibles%20del%20traje.md).

| Parameter | Value | Status |
|---|---|---|
| Astronaut mass | 80 kg | to be verified |
| Suit mass with life support | 127 kg (EMU, ~280 lb) | to be verified |
| Gravity | 0.38 g | confirmed |
| Terrain factor (Pandolf's η) | 1.1 (compacted regolith ≈ dirt road) | our assumption |
| Walking speed | 0.8 m/s (~2.9 km/h), fixed | our assumption |
| Energy per liter of O2 | 20.1 kJ/L | confirmed |
| Available O2 | 0.55 kg (primary PLSS O2, excluding the emergency supply) | to be verified |
| Battery | 446.9 Wh (16.8 V × 26.6 Ah), 90% usable | capacity to be verified; efficiency is our assumption |
| Fixed electrical draw | 55 W | our assumption |

With these values, walking on flat ground burns ~600 W, the O2 lasts ~3.6 h and the battery ~7.3 h: **O2 is the limiting resource**. Model limits: Pandolf was validated up to ±25% grade (~14°) and with loads lighter than a suit, so it probably overestimates; it does not model the stiffness of a pressurized suit; and walking speed does not change with slope or load. The equipment load uses Apollo tool masses (OBSERVED); a manually entered load is ASSUMED.

### Radiation (`pipeline/radiation.py`)

```text
dose(cell) = H0 × visible_sky(cell) / visible_sky(Bradbury Landing)
```

H0 = 0.64 ± 0.12 mSv/day (26.7 µSv/h), the dose equivalent RAD measured at Gale between August 2012 and June 2013. Visible sky comes from the horizon out to 60 km (the DTM nearby, the 200 m DEM farther out) and is normalized at the spot where RAD measured. Because the dose changes from place to place **less than RAD's own uncertainty** (±19%), it is shown as a traverse budget and does not enter the A\* cost. Limits: the isotropic model overestimates terrain shielding (it is a bound), and H0 does not vary with the solar cycle, the season or solar storms. Details in [`docs/radiation.md`](docs/radiation.md).

### Light and shadow (`pipeline/illumination.py`)

Sun position from SPICE at the site center, and shadow tracing over the 1 m DTM plus the 200 m DEM out to 100 km (the crater rim), including Mars' curvature. A stack of masks every hour of local solar time. Assumptions: point Sun (no penumbra), no refraction or dust, no diffuse light, and a single Sun position for the whole site (error below ±0.2° at Jezero, ±0.5° at Gale). If the requested date was not precomputed, the stack from another sol in the **same season** (|ΔLs| ≤ 2°, at most 0.9° of declination) is used and the result becomes MODELED; if there is none, light is left unevaluated and the verdict says so. Details in [`docs/illumination.md`](docs/illumination.md).

### Contact with the habitat (`api/contact.py`, `api/viewshed.py`)

Radio by direct line of sight only, with no relays or diffraction. Habitat antenna 3 m above the ground and suit antenna at 2 m, accounting for Mars' curvature. The DTM is averaged for the calculation, so obstacles smaller than a cell are not seen. A stretch with no visibility data does not count as "no contact": if it could break the limit, the verdict stays at CAUTION.

### Shelters (`pipeline/shelter.py`)

An emergency shelter for 2–3 people: places with **≤ 85%** visible sky (strong shelter: **≤ 75%**), slope below 25° and at least 10 m², computed at 2 m. It is geometric cover, not a computed dose, and both thresholds are ours. Minutes to shelter use Tobler's hiking function (1993) scaled to 0.8 m/s on flat ground (MODELED). Details in [`docs/refugios.md`](docs/refugios.md).

### Landmark navigation (`api/directions.py`)

Each leg is split into stretches wherever the heading turns more than 30°. For each stretch, the app picks the landmark best seen from 1.7 m eye height (line of sight over the DTM nearby and the 200 m DEM farther out), favoring what lies ahead, what is large and what cannot be confused with a similar feature. The Sun is used to confirm the heading only between 3° and 65° of elevation. If nothing is visible, the direction falls back to "follow the Sun" or a compass heading and says why: **a landmark is never made up**.

## How to run it

**Requirements:** Python 3.12, system GDAL (on Ubuntu 24.04: `gdal-bin` and `python3-gdal`; the pipeline uses `gdaldem`, `gdal2tiles` and `ogr2ogr`) and Node 22. The full data takes tens of GB and hours to download: the Jezero orthomosaic alone is 7.4 GB.

### Frontend only

```bash
cd web
npm install
npm run dev            # http://localhost:5173
```

Without a backend it starts in **sample mode**: local test data and a red banner warning that no value is a measurement. To use a real backend, copy `web/.env.example` to `web/.env.local` and set `VITE_API_TARGET` to the server address: Vite proxies `/api` and `/tiles` to it.

### The API

```bash
python3.12 -m venv .venv-api
.venv-api/bin/pip install -r api/requirements.txt
DATA_DIR=/data .venv-api/bin/uvicorn api.main:app --port 8000     # from the repo root
```

Without data the API still answers: `/api/health` works, and queries for a site without data return 404 or `value: null` with a note (the frontend handles both). The API does not serve `/tiles/`: on the server, nginx does that with [`deploy/nginx.conf`](deploy/nginx.conf), which also puts `/api/` on the same origin.

### The data pipeline

```bash
python3.12 -m venv --system-site-packages .venv-pipeline     # uses the system GDAL
.venv-pipeline/bin/pip install -r pipeline/requirements.txt -r pipeline/requirements-dev.txt
export DATA_DIR=/data                                           # any folder with enough space

# 1. Download (hours; resumes if interrupted)
.venv-pipeline/bin/python pipeline/download.py         # everything in sites/*.json → raw/ + manifest.json
.venv-pipeline/bin/python pipeline/fetch_extras.py     # Robbins, SWIM, DONKI, Langlais (NASA_API_KEY optional)
bash pipeline/fetch_science.sh                         # THEMIS and CRISM
.venv-pipeline/bin/python pipeline/fetch_targets.py    # PIXL target names (~20 min because of the Crawl-delay)

# 2. Precompute, per site (jezero, gale)
.venv-pipeline/bin/python pipeline/precompute.py --site jezero --prueba   # 2 × 2 km crop for a quick test
.venv-pipeline/bin/python pipeline/precompute.py --site jezero            # relief, hazard, thermal, dose, water and tiles
.venv-pipeline/bin/python pipeline/shelter.py --site jezero               # shelters
.venv-pipeline/bin/python pipeline/illumination.py --site jezero --start 2026-11-15T00:00:00 --sols 1
.venv-pipeline/bin/python pipeline/shadow_tiles.py --site jezero          # hourly shadow tiles
.venv-pipeline/bin/python pipeline/places.py --site jezero                # places for search and landmarks
```

`precompute.py --ortho` adds the orthoimage (the most expensive step: hours). Outputs go to `$DATA_DIR/output/<site>/`, each layer with an index (`terrain.json`, `shelter.json`) stating its provenance, its resolution and whether it succeeded; the map only turns on the layers the index marks as ready. Nothing writes inside the repo.

### Tests

```bash
.venv-pipeline/bin/python -m pytest pipeline/tests     # with MAPEANDO_KERNELS=<kernels folder> it also runs the SPICE tests
.venv-api/bin/pip install pytest httpx && .venv-api/bin/python -m pytest api/tests
cd web && npm run build                                 # typecheck + build, the same thing CI runs
```

The server, auto-deploy and team access are documented (in Spanish) in [`docs/infra y setup.md`](docs/infra%20y%20setup.md).

## Repository layout

| Folder | Contents |
|---|---|
| `sites/` | One JSON per site (Jezero, Gale) + `common.json`: what gets downloaded and from where. |
| `pipeline/` | Python that downloads and precomputes (rasterio, numpy, spiceypy, GDAL). The heavy work happens here, never inside a request. |
| `api/` | FastAPI: inventory, point queries, 4D planner (`/api/route`), consumables, contact and shadows. It only reads precomputed outputs. |
| `web/` | React 19 + MapLibre GL + Three.js (Vite). It only draws. |
| `reference/` | Versioned reference tables (RAD surface dose). |
| `docs/` | Methods, assumptions and contracts, in Spanish. Start with [`context.md`](docs/context.md). |
| `deploy/` | Server bootstrap, nginx, systemd and auto-deploy. |

Documentation by topic (in Spanish): [`seguridad.md`](docs/seguridad.md) (verdict and route), [`consumibles del traje.md`](docs/consumibles%20del%20traje.md) (suit consumables), [`terreno.md`](docs/terreno.md) (terrain), [`radiation.md`](docs/radiation.md), [`illumination.md`](docs/illumination.md), [`refugios.md`](docs/refugios.md) (shelters), [`educacion.md`](docs/educacion.md) (training mode) and [`frontend y backend.md`](docs/frontend%20y%20backend.md).

## Use of AI

Space Apps allows AI tools and asks teams to state where and how they used them. This is what we did:

- **In development, yes.** We coded with **Claude Code** (Anthropic) as an assistant: it wrote and reviewed a good part of the code, tests and documentation, always at the request of a team member who reviews its work. As of 2026-11-15, about two out of three commits list it as co-author (`Co-Authored-By`). This English README was also translated with its help. The instructions we gave it are in the repo, in plain sight: [`CLAUDE.md`](CLAUDE.md), [`docs/context.md`](docs/context.md) and the skills in [`.claude/skills/`](.claude/skills/), including "don't make up data" and "respect the PDS Crawl-delay".
- **In the data, no.** No scientific number was generated by an AI: every value comes from a dataset in the table above, from a published model (Pandolf, Tobler, SPICE, Mars24) or from a team assumption labeled ASSUMED. The limits and thresholds were decided by the team.
- **In the app, no.** There is no AI at runtime: neither the API nor the frontend calls a language model. The route comes from a deterministic A\* search and the verdict from fixed rules documented in [`docs/seguridad.md`](docs/seguridad.md).

## Credits

### Data

- **NASA/JPL-Caltech:** Mars Reconnaissance Orbiter, Mars 2020 (Perseverance and Ingenuity), Mars Science Laboratory (Curiosity), Mars Odyssey, MMGIS and NAIF SPICE.
- **HiRISE:** NASA/JPL-Caltech/University of Arizona. **CRISM:** NASA/JPL-Caltech/JHUAPL. **THEMIS:** NASA/JPL-Caltech/Arizona State University. **MOLA:** NASA/GSFC (Mars Global Surveyor). **RAD:** NASA/JPL-Caltech/SwRI.
- **HRSC:** ESA/DLR/FU Berlin (Mars Express).
- **USGS Astrogeology Science Center:** DTM and image mosaics of Jezero and Gale, the MOLA + HRSC DEM, THEMIS controlled mosaics, the planetary nomenclature gazetteer (with the IAU Working Group for Planetary System Nomenclature) and the Robbins crater database service.
- **PDS Geosciences Node** (Washington University in St. Louis): Orbital Data Explorer and the Mars 2020 and MSL products.
- **SWIM:** Subsurface Water Ice Mapping, Planetary Science Institute.
- **Mars24:** NASA Goddard Institute for Space Studies.
- **Apollo:** NASA JSC tool catalog (Allton 1989) and the *Apollo Lunar Surface Journal*.

Using public NASA data does not imply that NASA endorses this project.

### Software

MapLibre GL JS, React, Three.js, Zod, Zustand, Tailwind CSS and Vite in the frontend (with OpenMapTiles label fonts); FastAPI and uvicorn in the API; GDAL, rasterio, NumPy, SciPy, scikit-image and SpiceyPy in the pipeline.

### References

- Hassler, D. M. et al. (2014). Mars' surface radiation environment measured with the Mars Science Laboratory's Curiosity rover. *Science* 343(6169), 1244797.
- Pandolf, K. B. et al. (1977). Predicting energy expenditure with loads while standing or walking very slowly. *Journal of Applied Physiology* 43(4).
- Santee, W. R. et al. (2001). A proposed model for load carriage on sloped terrain. *Aviation, Space, and Environmental Medicine* 72(6).
- Soule, R. G. & Goldman, R. F. (1972). Terrain coefficients for energy cost prediction. *Journal of Applied Physiology* 32(5).
- Tobler, W. (1993). *Three presentations on geographical analysis and modeling*. NCGIA Technical Report 93-1.
- Zakšek, K., Oštir, K. & Kokalj, Ž. (2011). Sky-view factor as a relief visualization technique. *Remote Sensing* 3(2).
- Robbins, S. J. & Hynek, B. M. (2012). A new global database of Mars impact craters ≥1 km: 1. Database creation, properties, and parameters. *Journal of Geophysical Research: Planets* 117.
- Fergason, R. L. et al. (2006). High-resolution thermal inertia derived from the Thermal Emission Imaging System (THEMIS): Thermal model and applications. *Journal of Geophysical Research* 111, E12004.
- Viviano-Beck, C. E. et al. (2014). Revised CRISM spectral parameters and summary products based on the currently detected mineral diversity on Mars. *Journal of Geophysical Research: Planets* 119.
- Allison, M. & McEwen, M. (2000). A post-Pathfinder evaluation of areocentric solar coordinates with improved timing recipes for Mars seasonal/diurnal climate studies. *Planetary and Space Science* 48.
- Allton, J. H. (1989). *Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers*. JSC-23454, NASA Johnson Space Center.
- Iqbal et al. (2024). *Acta Astronautica* (slopes walked during Apollo).
- Sutton, S. S. et al. (2022). *Remote Sensing* 14, 2403 (HiRISE DTM precision).

### Team

**Mapeando Ando** · NASA Space Apps Challenge 2026

- Castro Maria del Pilar
- Cejas Dana
- Joaquin Ignacio
- Guido Pacienzia
- Mariano Perrone
- Lucas Ruberto Ruiz

---

*Educational prototype, not flight software.*
