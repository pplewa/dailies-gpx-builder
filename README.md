# Dailies GPX Studio

A minimal web studio for building, editing, and exporting **DailiesMoves**-compatible **GPX 1.1** daily timelines — deployed on Cloudflare Workers.

## Features
- **Drop & Search Stationary Pins**: Click anywhere on the map or search venues via OpenStreetMap Nominatim (`/api/search`), drag pins to fine-tune coordinates, and set local start/end times.
- **Auto-Route or Hand-Draw Moves**:
  - **Auto-Route** (`/api/route`): Generates real footpath, bike, or road routes between pins using OSRM, resampled to clean ~12–20m intervals with proportional UTC timestamps.
  - **Draw / Edit Path**: Click point-by-point on the map, drag white vertex handles to reshape, right-click a handle to remove it, or click **Snap to Road** to snap your sketched points onto real streets.
- **Exact DailiesMoves GPX 1.1 Format**: Emits `<wpt>` waypoints for Stationary stops (`<dm:segmentType>`, `<dm:startTime>`, `<dm:endTime>`) and `<trk>` tracks for Moves (`<name>`, `<type>`, UTC `<trkpt>` points) with strict UTC ISO-8601 timestamps and UTC-resolved `YYYY-MM-DD.gpx` filenames.
- **Import Existing GPX**: Open any DailiesMoves or Arc Timeline `.gpx` file to inspect, fix, redraw missing paths, and re-export.
- **Local Remembered Places & Custom Move Types**: Automatically saved in `localStorage`.

## Local Development & Deployment

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run dev
npm run deploy
```
