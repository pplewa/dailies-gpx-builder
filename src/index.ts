/**
 * Dailies GPX Studio — Cloudflare Worker
 *
 * Serves static assets via `env.ASSETS` and provides lightweight, CORS-safe
 * routing (OSRM) and place search (Nominatim) endpoints for building GPX 1.1 timelines.
 */

interface RoutePoint {
  lat: number;
  lon: number;
}

interface NominatimItem {
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
}

interface OsrmResponse {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      coordinates?: Array<[number, number]>;
    };
  }>;
}

const JSON_HEADERS: HeadersInit = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/**
 * Validates `coords` query parameter formatted as `lon1,lat1;lon2,lat2;...`
 */
function parseCoordPairs(raw: string): RoutePoint[] | null {
  const parts = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 25) return null;

  const points: RoutePoint[] = [];
  for (const part of parts) {
    const [lonStr, latStr] = part.split(",");
    const lon = Number(lonStr);
    const lat = Number(latStr);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return null;
    }
    points.push({ lat, lon });
  }
  return points;
}

async function fetchOsrmRoute(url: string): Promise<{
  coordinates: RoutePoint[];
  distanceMeters: number;
  durationSeconds: number;
} | null> {
  const resp = await fetch(url, {
    headers: { "user-agent": "DailiesGPXStudio/1.0 (+https://github.com/pplewa/dailies-gpx-builder)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as OsrmResponse;
  const route = data.routes?.[0];
  const rawCoords = route?.geometry?.coordinates;
  if (!rawCoords || rawCoords.length < 2) return null;

  return {
    coordinates: rawCoords.map(([lon, lat]) => ({ lat, lon })),
    distanceMeters: route.distance ?? 0,
    durationSeconds: route.duration ?? 0,
  };
}

async function handleRoute(url: URL): Promise<Response> {
  const profileParam = (url.searchParams.get("profile") ?? "foot").toLowerCase();
  const coordsParam = url.searchParams.get("coords") ?? "";
  const points = parseCoordPairs(coordsParam);
  if (!points) {
    return jsonResponse({ error: "Invalid coords parameter. Expected lon,lat;lon,lat" }, 400);
  }

  const coordString = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

  // Dedicated OSM.de profiles support distinct foot, bike, and car graphs; fallback to project-osrm.
  const primaryBase: Record<string, string> = {
    foot: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
    walking: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
    bike: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
    biking: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
    car: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
    scooter: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
    driving: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  };

  const fallbackProfile =
    profileParam === "foot" || profileParam === "walking"
      ? "foot"
      : profileParam === "bike" || profileParam === "biking"
        ? "bike"
        : "driving";

  const candidateUrls = [
    `${primaryBase[profileParam] ?? primaryBase.foot}/${coordString}?overview=full&geometries=geojson&steps=false`,
    `https://router.project-osrm.org/route/v1/${fallbackProfile}/${coordString}?overview=full&geometries=geojson&steps=false`,
  ];

  for (const candidate of candidateUrls) {
    try {
      const routed = await fetchOsrmRoute(candidate);
      if (routed) {
        return jsonResponse({
          provider: candidate.includes("openstreetmap.de") ? "osm-de" : "osrm",
          profile: profileParam,
          ...routed,
        });
      }
    } catch {
      // Try next upstream router
    }
  }

  return jsonResponse({ error: "Routing providers unavailable; use straight or drawn path instead." }, 502);
}

async function handleSearch(url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return jsonResponse({ results: [] });
  }

  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "7",
    addressdetails: "1",
  });

  // Bias search softly around the current map viewport when coordinates are provided.
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const delta = 0.12;
    params.set("viewbox", `${(lon - delta).toFixed(4)},${(lat + delta).toFixed(4)},${(lon + delta).toFixed(4)},${(lat - delta).toFixed(4)}`);
  }

  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: {
        "user-agent": "DailiesGPXStudio/1.0 (+https://github.com/pplewa/dailies-gpx-builder)",
        "accept-language": "en",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return jsonResponse({ error: `Search failed (${resp.status})`, results: [] }, 502);
    }

    const raw = (await resp.json()) as NominatimItem[];
    const results = raw
      .map((item) => {
        const parsedLat = Number(item.lat);
        const parsedLon = Number(item.lon);
        if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) return null;
        const shortName = item.name?.trim() || (item.display_name?.split(",")[0]?.trim() ?? "Place");
        return {
          name: shortName,
          displayName: item.display_name ?? shortName,
          lat: parsedLat,
          lon: parsedLon,
          category: item.type ?? item.class ?? "place",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return jsonResponse({ results });
  } catch {
    return jsonResponse({ error: "Place search timed out", results: [] }, 504);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/api/health") {
        return jsonResponse({ ok: true, service: "dailies-gpx-builder" });
      }
      if (url.pathname === "/api/route") {
        return handleRoute(url);
      }
      if (url.pathname === "/api/search") {
        return handleSearch(url);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
