# Boston Home Search

A phone-friendly map of how far you can drive in a chosen number of minutes. It centers on one of three areas, flies in, then lets color crawl along every street the way a car would reach it:

- [The Kendall School](https://www.kendallschool.com/), 577 Belmont Street, Belmont
- Needham Center (Needham Town Hall, 1471 Highland Avenue)
- Wellesley Square (Wellesley Town Hall, 525 Washington Street)

On a first visit a picker asks which area to open. The choice is remembered, and the area button next to Filters switches at any time. The areas live in `src/areas.ts`.

Streets are colored in three bands that split the drive you asked for. The default is 15 minutes, so the bands are 0–5, 5–10, and 10–15. Times are **Tuesday morning traffic around 8:00**, not empty-road speed limits.

The basemap is [OpenFreeMap](https://openfreemap.org/) dark, with CARTO Dark Matter as a fallback. Mapbox supplies the Tuesday-morning drive times and the address search. Its dark style uses shader functions MapLibre cannot run, so the streets are drawn on the OpenFreeMap basemap. Map data is © OpenStreetMap contributors.

## Run it

```bash
npm install
# .env.local with VITE_MAPBOX_TOKEN=pk...  (already set on Vercel)
npm run dev
```

Open [http://127.0.0.1:4731](http://127.0.0.1:4731). The Kendall 15-minute drive is baked into `public/data/reach.bin`, so the first view does not call Mapbox. Another address or another duration is computed by `/api/reach` and cached.

`?frame=start`, `?frame=mid`, and `?frame=end` hold the opening shot, the middle of the crawl, and the finished map (they skip the picker). `?area=needham` opens an area directly, and `?reset=1` forgets the saved area and shows the picker again. A shareable link looks like `/?lat=42.37347&lng=-71.11894&min=10&q=Harvard%20Square&area=kendall`. The last search and area are remembered in localStorage.

Needham and Wellesley have no baked drive yet, so their first view goes through `/api/reach` (a couple of seconds, then cached). Bake them with `node --experimental-strip-types scripts/bake-default.ts needham` (and `wellesley`), which writes `reach-<area>.bin` and `method-<area>.json`. The app picks those files up without a code change.

## Why the times changed

The previous map used free-flow speed limits and ignored signals. A mile of 30 mph road was two minutes, even with three lights and a line of drop-off traffic. Checked against Mapbox Directions (`driving-traffic`, depart Tuesday 8:00 America/New_York) that was roughly two to three times too fast. Harvard Square was 6.5 minutes on the old map and 19.8 minutes in Tuesday traffic.

The new model still routes on the OpenStreetMap drive network (one-ways and posted speeds, from `server/graph.bin`). Each edge is scaled by a class multiplier, and surface-street intersections add a small delay. Those parameters are fit to Mapbox Directions samples around the origin, then any street that falls outside a Mapbox traffic isochrone is pushed out to that contour so the color bands agree with the isochrone. The same fitted times drive the crawl: each segment fills from the end reached first toward the other end.

| Place | Old free-flow | Tuesday 8:00 (Mapbox) | This map |
| --- | ---: | ---: | ---: |
| Harvard Square | 6.5 | 19.8 | 17.5 |
| Arlington Center | 7.1 | 16.1 | 15.9 |
| Waltham Common | 6.4 | 11.9 | 14.4 |
| Lexington Center | 13.1 | 22.0 | 27.5 |
| Boston Common | 13.4 | 30.0 | 33.3 |
| Cambridge Kendall Square | 11.4 | 31.6 | 27.7 |

Average absolute error against Mapbox on these six trips is about 3 minutes, versus about 12 minutes for the free-flow map. Lexington runs long; the Cambridge trips that used to look like a short hop are now in the right band. Full rows are in `public/data/comparison.json`.

## Any address, 5–30 minutes

The search box geocodes with Mapbox. Go computes a new spiderweb. Inside the Boston extract (about 42 km around the school) that is a shortest path on the prebuilt graph plus a handful of Mapbox calls, usually a couple of seconds. Outside it, the server reads OpenFreeMap road tiles for the isochrone and routes those. Results are cached on the CDN for 12 hours and in the browser after the first fetch.

Pins read the chosen area's file: `public/data/listings.json` (Kendall), `listings-needham.json`, or `listings-wellesley.json`. Their drive times are always the Tuesday 8:00 drive from that area, including after you search a different origin. The label on the map says “from Kendall School” (or the area's name) for that reason. Pins stay hidden until the street crawl finishes. Zoomed out, nearby pins collapse into a count; zoom in for each home and its drive time. The file is served with a no-cache header.

## Regenerate

The road graph needs [osmium-tool](https://osmcode.org/osmium-tool/) and the Massachusetts extract (the script downloads it):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/build_graph.py
```

Rebuild listings from one or more Zillow search dumps (`{ results: [...] }`). One run times every home from all three areas and writes each area's file. A home appears in every area it is within 20 minutes of. `-o` names the Kendall file; the others are written beside it. `--area needham` (repeatable) builds only some areas. The dumps need to cover all three areas, so include Needham/Wellesley searches alongside Belmont. Until an area is baked, its listings use the Kendall-fitted model and the summary says so. The script keeps sale single-families at or under $1,500,000 with 4 or more bedrooms, and rentals (single-family, townhouse, or multi-family, including a 4-bedroom unit in a building) at or under $9,000 a month with 4 or more bedrooms. Homes without coordinates are dropped. Each kept home is timed on `server/graph.bin` with each area's model (`public/data/method.json` for Kendall, `method-<area>.json` for the others), and anything over 20 minutes from an area is left out of that area's file. `firstSeen` is copied from the current listings file before it is replaced. New files are `{ generatedAt, listings }`. An older bare array still loads.

```bash
npx tsx scripts/build-listings.ts raw/*.json -o public/data/listings.json
```

A count of rows in, kept, and dropped by reason is printed to stderr. Redirecting stdout onto `public/data/listings.json` empties that file before `firstSeen` can be read; use `-o` so new-ness survives the next run.

Rebuild the baked Kendall drive, the comparison table, and the listings grid with `VITE_MAPBOX_TOKEN` set:

```bash
node --experimental-strip-types scripts/bake-default.ts
```

`scripts/generate_drive_times.py` still builds the old free-flow files if you want that baseline. The site does not load them.

## Install and deploy

Boston Home Search is a standalone web app. On a phone: open the site, then Add to Home Screen. The service worker precaches the shell. Drive-time files and Mapbox/OpenFreeMap tiles are cached after the first view. `data/listings.json` and `/api/reach` stay network-first.

```bash
npm run build
```

`vercel.json` sets Vite, `npm ci`, `npm run build`, and `dist`. The reach function includes `server/graph.bin`. Set `VITE_MAPBOX_TOKEN` for Production, Preview, and Development. Do not commit the token.
