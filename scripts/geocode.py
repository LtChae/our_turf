import csv, json, time, urllib.request, urllib.parse, sys

if len(sys.argv) != 2:
    sys.exit("usage: python3 scripts/geocode.py <input.csv>")

SRC = sys.argv[1]
OUT_CACHE = "data/geocode_cache.json"
OUT_VOTERS = "data/voters.json"

with open(SRC) as f:
    rows = list(csv.DictReader(f))

try:
    with open(OUT_CACHE) as f:
        cache = json.load(f)
except FileNotFoundError:
    cache = {}

def addr_key(row):
    return f"{row['Address']}, {row['City']}, {row['State']} {row['Zip']}"

unique_addrs = sorted(set(addr_key(r) for r in rows))
print(f"{len(unique_addrs)} unique addresses, {len(cache)} cached")

headers = {"User-Agent": "AdoptANeighborhoodCanvassApp/1.0 (personal campaign tool)"}

for i, addr in enumerate(unique_addrs):
    if addr in cache:
        continue
    q = urllib.parse.urlencode({"q": addr, "format": "json", "limit": 1})
    url = f"https://nominatim.openstreetmap.org/search?{q}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        if data:
            cache[addr] = {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"])}
            print(f"[{i+1}/{len(unique_addrs)}] OK  {addr}")
        else:
            cache[addr] = None
            print(f"[{i+1}/{len(unique_addrs)}] MISS {addr}")
    except Exception as e:
        print(f"[{i+1}/{len(unique_addrs)}] ERR {addr}: {e}")
        cache[addr] = None
    with open(OUT_CACHE, "w") as f:
        json.dump(cache, f, indent=2)
    time.sleep(1.1)

voters = []
missing = 0
for r in rows:
    key = addr_key(r)
    coord = cache.get(key)
    if not coord:
        missing += 1
        continue
    voters.append({
        "id": r["VANID"],
        "firstName": r["First Name"],
        "lastName": r["Last Name"],
        "address": r["Address"],
        "city": r["City"],
        "state": r["State"],
        "zip": r["Zip"],
        "phone": r["Phone"],
        "sex": r["Sex"],
        "age": r["Age"],
        "party": r["Party"],
        "lat": coord["lat"],
        "lon": coord["lon"],
    })

with open(OUT_VOTERS, "w") as f:
    json.dump(voters, f, indent=2)

print(f"Wrote {len(voters)} voters to {OUT_VOTERS}, {missing} missing geocode")
