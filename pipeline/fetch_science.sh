#!/usr/bin/env bash
# Descarga los productos científicos de ambos sitios (MAP-15 y MAP-16) y los sube a S3.
# Térmico: THEMIS IR día/noche (mosaicos controlados USGS en AWS Open Data), recortados al sitio.
# Espectral: CRISM MTRDR browse (resúmenes minerales proyectados), vía API de ODE.
# Químico: SuperCam LIBS MOC + PIXL óxidos (Jezero); ChemCam MOC + APXS (Gale).
# Geofísico: RIMFAX radargramas browse (Jezero). Más Mars 2020 rover places (ubicaciones).
# Uso: sudo -E bash pipeline/fetch_science.sh   (lee /etc/mapeando.env)
set -uo pipefail
set -a; [ -f /etc/mapeando.env ] && . /etc/mapeando.env; set +a
DATA_DIR=${DATA_DIR:-/data}
RAW=$DATA_DIR/raw
GEO=https://pds-geosciences.wustl.edu
THEMIS=https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics
MARS_LL="+proj=longlat +R=3396190 +no_defs"
log(){ echo "[$(date -u +%FT%TZ)] $*"; }
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MAX_RETRY=8 GDAL_HTTP_RETRY_DELAY=5

# sitio | bbox (lon_min lat_max lon_max lat_min, con 0.1° de margen) | cuadrángulo THEMIS
SITES=(
  "jezero|77.12 18.77 77.68 18.21|mc13_syrtis_major"
  "gale|137.02 -4.03 137.78 -5.20|mc23_aeolis"
)

for row in "${SITES[@]}"; do
  IFS='|' read -r site bbox quad <<< "$row"
  read -r lon0 lat1 lon1 lat0 <<< "$bbox"

  # --- Térmico: THEMIS ---
  mkdir -p "$RAW/$site/themis"
  for band in nir dir; do
    out="$RAW/$site/themis/${quad}_${band}_crop.tif"
    [ -s "$out" ] && { log "skip $out"; continue; }
    log "THEMIS $site $band"
    gdal_translate -q -projwin_srs "$MARS_LL" -projwin $lon0 $lat1 $lon1 $lat0 \
      -co COMPRESS=DEFLATE -co TILED=YES "/vsicurl/$THEMIS/${quad}_${band}/${quad}_${band}.tif" "$out" \
      || log "ERROR THEMIS $site $band"
    curl -sf -o "$RAW/$site/themis/${quad}_${band}_provenance.txt" "$THEMIS/${quad}_${band}/provenance.txt" || true
  done

  # --- Espectral: CRISM MTRDR browse ---
  mkdir -p "$RAW/$site/crism"
  log "CRISM $site"
  python3 - "$site" "$lon0" "$lat1" "$lon1" "$lat0" "$RAW/$site/crism" <<'EOF'
import json, os, subprocess, sys, urllib.request
site, lon0, lat1, lon1, lat0, outdir = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
q = ("https://oderest.rsl.wustl.edu/live2/?query=product&results=fp&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR"
     f"&westlon={lon0}&eastlon={lon1}&minlat={lat0}&maxlat={lat1}&output=JSON&limit=200")
d = json.load(urllib.request.urlopen(q, timeout=120))
prods = d["ODEResults"].get("Products", {}).get("Product", [])
prods = prods if isinstance(prods, list) else [prods]
index = []
for p in prods:
    files = p["Product_files"]["Product_file"]
    files = files if isinstance(files, list) else [files]
    got = []
    for f in files:
        name = f.get("FileName", "")
        if "_BR" in name.upper() and name.lower().endswith((".img", ".hdr", ".lbl", ".png")):
            dest = os.path.join(outdir, name.lower())
            if not os.path.exists(dest):
                subprocess.run(["curl", "-sf", "--retry", "5", "-o", dest, f["URL"]])
            got.append(name.lower())
    index.append({"pdsid": p.get("pdsid"), "center_lat": p.get("Center_latitude"),
                  "center_lon": p.get("Center_longitude"), "files": got})
json.dump(index, open(os.path.join(outdir, "index.json"), "w"), indent=1)
print(f"{site}: {len(index)} observaciones CRISM")
EOF
done

# --- Químico y geofísico: Jezero ---
J=$RAW/jezero
mkdir -p "$J/supercam" "$J/pixl" "$J/rimfax" "$J/rover_places"
log "SuperCam MOC"
for f in supercam_libs_moc.csv supercam_libs_moc.xml; do
  curl -sf --retry 5 -o "$J/supercam/$f" "$GEO/m2020/urn-nasa-pds-mars2020_supercam/data_derived_spectra/$f" || log "ERROR $f"
done
log "PIXL oxides"
wget -q -r -np -nH --cut-dirs=3 -R 'index.html*' -A 'csv,xml' -P "$J/pixl" "$GEO/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/"
log "RIMFAX browse radargrams"
wget -q -r -np -nH --cut-dirs=3 -R 'index.html*' -A 'png,jpg,xml,csv' -P "$J/rimfax" "$GEO/m2020/urn-nasa-pds-mars2020_rimfax/browse_radargram/"
log "Mars 2020 rover places (localizaciones)"
wget -q -r -np -nH --cut-dirs=3 -R 'index.html*' -A 'csv,xml' -P "$J/rover_places" "$GEO/m2020/urn-nasa-pds-mars2020_rover_places/data_localizations/"

# --- Químico: Gale ---
G=$RAW/gale
mkdir -p "$G/chemcam" "$G/apxs"
log "ChemCam MOC"
wget -q -r -np -nH --cut-dirs=4 -R 'index.html*' -P "$G/chemcam" "$GEO/msl/msl-m-chemcam-libs-4_5-rdr-v1/mslccm_1xxx/data/moc/"
log "APXS (índices, extras e inventario)"
for sub in index extras; do
  wget -q -r -np -nH --cut-dirs=4 -R 'index.html*' -P "$G/apxs" "$GEO/msl/msl-m-apxs-4_5-rdr-v1/mslapx_1xxx/$sub/"
done
curl -sf -o "$G/apxs/collection_data_inventory.csv" "$GEO/msl/msl-m-apxs-4_5-rdr-v1/mslapx_1xxx/data/collection_data_inventory.csv" || true

if [ -n "${BUCKET:-}" ]; then
  log "sync -> s3://$BUCKET/raw"
  aws s3 sync "$RAW" "s3://$BUCKET/raw" --only-show-errors
fi
log "SCIENCE_DONE"
du -sh "$RAW"/*/themis "$RAW"/*/crism "$J"/{supercam,pixl,rimfax,rover_places} "$G"/{chemcam,apxs} 2>/dev/null
