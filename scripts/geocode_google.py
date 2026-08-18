"""
Geocode a voter CSV (Street, First Name, Last Name, Address, City, State, Zip,
Phone, Sex, Age, Party, VANID) using the Google Maps Geocoding API, writing out
a copy of the CSV with `lat` and `lon` columns added. That output CSV is what
gets uploaded to the web app, so geocoding happens once, locally, ahead of time.

Usage:
    python3 scripts/geocode_google.py <input.csv> [-o output.csv]

Requires GOOGLE_MAPS_API_KEY (or google_maps_api_key) in the environment or a
.env file in the repo root.
"""
import argparse, csv, json, os, sys, time, urllib.parse, urllib.request

CACHE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "geocode_cache_google.json")


def load_env_file(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def get_api_key():
    repo_root = os.path.join(os.path.dirname(__file__), "..")
    load_env_file(os.path.join(repo_root, ".env"))
    key = os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("google_maps_api_key")
    if not key:
        sys.exit("No Google Maps API key found (set GOOGLE_MAPS_API_KEY, or add google_maps_api_key to .env)")
    return key


def addr_key(row):
    return f"{row['Address']}, {row['City']}, {row['State']} {row['Zip']}"


def load_cache():
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)


def geocode(addr, api_key):
    q = urllib.parse.urlencode({"address": addr, "key": api_key})
    url = f"https://maps.googleapis.com/maps/api/geocode/json?{q}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read())
    status = data.get("status")
    if status == "OK" and data.get("results"):
        loc = data["results"][0]["geometry"]["location"]
        return {"lat": loc["lat"], "lon": loc["lng"]}, None
    if status == "ZERO_RESULTS":
        return None, None  # permanent miss, safe to cache
    return None, status  # transient/error (e.g. OVER_QUERY_LIMIT, REQUEST_DENIED) - don't cache


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv")
    parser.add_argument("-o", "--out", help="Output CSV path (default: <input>_geocoded.csv)")
    args = parser.parse_args()

    root, ext = os.path.splitext(args.input_csv)
    out_path = args.out or f"{root}_geocoded{ext}"

    api_key = get_api_key()

    with open(args.input_csv, newline="") as f:
        rows = list(csv.DictReader(f))

    cache = load_cache()
    unique_addrs = sorted(set(addr_key(r) for r in rows))
    print(f"{len(unique_addrs)} unique addresses, {len(cache)} already cached")

    for i, addr in enumerate(unique_addrs):
        if addr in cache:
            continue
        try:
            coord, err = geocode(addr, api_key)
        except Exception as e:
            print(f"[{i+1}/{len(unique_addrs)}] ERR {addr}: {e}")
            continue  # transient - retry on next run, don't cache
        if coord:
            cache[addr] = coord
            print(f"[{i+1}/{len(unique_addrs)}] OK   {addr}")
        elif err:
            print(f"[{i+1}/{len(unique_addrs)}] SKIP {addr}: {err} (not cached, will retry next run)")
        else:
            cache[addr] = None
            print(f"[{i+1}/{len(unique_addrs)}] MISS {addr}")
        save_cache(cache)

    fieldnames = list(rows[0].keys()) + ["lat", "lon"]
    missing = 0
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            coord = cache.get(addr_key(row))
            out_row = dict(row)
            if coord:
                out_row["lat"] = coord["lat"]
                out_row["lon"] = coord["lon"]
            else:
                out_row["lat"] = ""
                out_row["lon"] = ""
                missing += 1
            writer.writerow(out_row)

    print(f"Wrote {len(rows)} rows to {out_path} ({missing} without coordinates)")


if __name__ == "__main__":
    main()
