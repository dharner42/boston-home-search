# Kendall

A phone-friendly map of the drive around [The Kendall School](https://www.kendallschool.com/) at 577 Belmont Street, Belmont. On each visit the view flies in to the school, then pulls back while the streets light up in the order a car would reach them.

Streets are colored in three bands:

- **0–5 min** gold
- **5–10 min** coral
- **10–15 min** blue

The 15–20 minute streets are computed and stored, but they stay dark. That outer ring is there so a later listings layer can still label a pin with its drive time.

The basemap is [OpenFreeMap](https://openfreemap.org/) (dark), with CARTO Dark Matter as a fallback. Neither needs an API key. Map data is © OpenStreetMap contributors.

## Run it

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4731](http://127.0.0.1:4731). The drive-time files are already in `public/data/`, so the dev server does not rebuild them.

`?frame=start`, `?frame=mid`, and `?frame=end` hold the opening shot, the middle of the light-up, and the finished map. Leave the query off for the real animation. Replay is the button at the top right.

## How the times are computed

Free-flow only: `time = length / speed`.

- If the street has an OpenStreetMap `maxspeed` tag, that speed is used (`25 mph` and similar).
- Otherwise the speed comes from the highway class in `FREEFLOW_MPH` inside `scripts/generate_drive_times.py` (for example residential 25 mph, primary 35 mph, motorway 65 mph).
- One-way streets, including motorways and roundabouts, are honored.
- Service roads, parking aisles, and foot or bike paths are left out.
- Traffic lights and congestion are not modeled. A mile of 30 mph road is two minutes, even if it has three signals.

The anchor is OSM way [29580670](https://www.openstreetmap.org/way/29580670), the school building. The generator checks that the coordinate sits inside that footprint, then starts the route on the nearest drivable street (Belmont Street, a few meters off the door).

Routing is Dijkstra on the driveable graph, cut off at 20 minutes. The search area is a 42 km radius around the school, which is past the farthest point a 65 mph road can reach in that time. The script refuses to write output if the 20-minute network runs into the edge of that area.

Street geometry is bucketed every 5 seconds of drive time so the light can step along the roads, then simplified by about 4 meters for the phone. Details of the last run, including lengths and a few landmark checks, are in `public/data/method.json`.

### Rush hour later

In `scripts/generate_drive_times.py`:

- `GLOBAL_RUSH_MULTIPLIER` scales every street. `1.4` means 40% slower.
- `RUSH_FACTOR` does the same per highway class. A useful sketch is motorway `1.35`, primary `1.7`, secondary `1.55`, tertiary `1.4`, residential `1.25`.
- `INTERSECTION_DELAY_S` adds a fixed wait, in seconds, each time a route arrives at a junction. Leave it at `0` for pure free-flow.

Then regenerate. The map reads the new files; no app change is required.

## Regenerate the drive-time files

Requires [osmium-tool](https://osmcode.org/osmium-tool/) (`sudo apt install osmium-tool` on Debian or Ubuntu) and a Python 3.11+ venv.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/generate_drive_times.py
```

The first run downloads the Massachusetts OpenStreetMap extract (about 300 MB) into `data/cache/`, which is gitignored. Later runs reuse the clipped roads unless you pass `--force`.

| File | What it is |
| --- | --- |
| `public/data/streets.geojson` | Streets under 15 minutes. This is the file the map loads. |
| `public/data/streets-15-20.geojson` | The unlit 15–20 minute streets. Not fetched on page load. |
| `public/data/travel-grid.json` | About a 90 m grid of drive times out to 20 minutes, for pin labels. |
| `public/data/meta.json` | School coordinate, band colors, and the camera bounds. |
| `public/data/method.json` | Speeds, counts, and the landmark checks from the last run. |

Cell values in the grid are minutes × 10. `255` means the point is outside the 20-minute window or more than about 175 m from a reached road. `src/travel-time.ts` reads it.

## Listings, next

Do not add pins in this version. When rental and for-sale listings show up, drop them in `public/data/listings.json` (a job can overwrite that file a few times a day) and add a pin layer. Nothing else needs to change.

```json
[
  {
    "id": "123",
    "type": "rent",
    "price": 4200,
    "lon": -71.18,
    "lat": 42.39,
    "address": "12 Example St, Belmont, MA",
    "isNew": true,
    "url": "https://example.com/listing/123",
    "beds": 3,
    "baths": 1
  }
]
```

`type` is `"rent"` or `"sale"`. `price` is monthly rent, or the sale price, in dollars. A missing file is treated as no listings.

`src/listings.ts` already loads that file, joins each pin to the 20-minute grid, and returns GeoJSON. Drive time, price, type, and the new flag are properties on each feature (`driveMinutes`, `driveLabel`, `priceLabel`, `type`, `isNew`). The pin layer is the piece still to write:

```ts
import { prepareListingPins } from "./listings.ts"

const pins = await prepareListingPins()
map.addSource("listings", { type: "geojson", data: pins })
map.addLayer({
  id: "listings",
  type: "circle",
  source: "listings",
  paint: {
    "circle-color": ["match", ["get", "type"], "rent", "#FFC857", "sale", "#7EB6FF", "#ffffff"],
    "circle-radius": 6,
    "circle-stroke-width": 1.5,
    "circle-stroke-color": "#0b0e13",
  },
})
```

Use `driveLabel` and `priceLabel` as the text on the pin. `driveLabel` is `"20+ min"` when the place sits outside the grid.

## Install it

Boston Home Search is a standalone web app. On a phone: open the site, then Add to Home Screen (iPhone: Share, then Add to Home Screen; Android: the install prompt, or the browser menu). It opens full screen, dark status bar, and works in portrait or landscape.

The service worker, written into `dist/sw.js` at build time, precaches the app shell and the drive-time files so the map comes back quickly and still opens offline. `data/listings.json` is not precached. When the phone is online the worker always asks the network for that file first (it will be replaced a few times a day) and only falls back to the last copy if the network is down.

## Deploy

The site is static. Vercel (or any host that serves a folder) is enough.

```bash
npm run build
```

Publish the `dist/` directory. On Vercel, set the framework to Vite, build command `npm run build`, and output directory `dist`. There are no environment variables and no API key.

`vercel.json` caches the street files for a day and, once it exists, `listings.json` for five minutes so a thrice-daily refresh can show up without a redeploy.
