/**
 * Exact GPX 1.1 generator & importer matching the DailiesMoves iOS app (`GPXExporter.swift`).
 * Local UI dates/times are converted to strict UTC ISO-8601 (`...Z`) timestamps on export.
 */

export function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dp = toRad(b.lat - a.lat);
  const dl = toRad(b.lon - a.lon);
  const s =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function polylineDistanceMeters(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Resamples a polyline so points are spaced roughly every `spacingMeters` (keeping exact start & end).
 */
export function resamplePolyline(points, spacingMeters = 15, maxPoints = 600) {
  if (!points || points.length < 2) return points ? [...points] : [];
  const total = polylineDistanceMeters(points);
  if (total < 1) return [points[0], points[points.length - 1]];

  const effectiveSpacing = Math.max(spacingMeters, total / maxPoints);
  const result = [{ lat: points[0].lat, lon: points[0].lon }];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    let prev = points[i - 1];
    const curr = points[i];
    let segLen = haversineMeters(prev, curr);
    if (segLen < 0.1) continue;

    while (carry + segLen >= effectiveSpacing) {
      const need = effectiveSpacing - carry;
      const t = need / segLen;
      const interp = {
        lat: prev.lat + (curr.lat - prev.lat) * t,
        lon: prev.lon + (curr.lon - prev.lon) * t,
      };
      result.push(interp);
      prev = interp;
      segLen = haversineMeters(prev, curr);
      carry = 0;
    }
    carry += segLen;
  }

  const last = points[points.length - 1];
  const prevOut = result[result.length - 1];
  if (haversineMeters(prevOut, last) > 1.5) {
    result.push({ lat: last.lat, lon: last.lon });
  } else {
    result[result.length - 1] = { lat: last.lat, lon: last.lon };
  }
  return result;
}

/**
 * Converts local day `"YYYY-MM-DD"`, local `"HH:mm"` (or `"HH:mm:ss"`), and timezone offset in minutes
 * (e.g. `+420` for UTC+7) into a UTC `Date`.
 */
export function localTimeToUTCDate(dayKey, timeStr, tzOffsetMinutes) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const parts = (timeStr || "00:00").split(":").map(Number);
  const hh = parts[0] || 0;
  const mm = parts[1] || 0;
  const ss = parts[2] || 0;
  const utcMs = Date.UTC(y, (m || 1) - 1, d || 1, hh, mm, ss) - tzOffsetMinutes * 60 * 1000;
  return new Date(utcMs);
}

export function toISO8601UTC(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Mirrors `DateFormatting.resolvedUTCExportDayKey` from the iOS app.
 */
export function resolveUTCExportDayKey(localDayKey, eventDates, tzOffsetMinutes, now = new Date()) {
  const nowLocalMs = now.getTime() + tzOffsetMinutes * 60 * 1000;
  const todayLocalKey = new Date(nowLocalMs).toISOString().slice(0, 10);
  const todayUTCKey = utcDayKey(now);

  if (localDayKey === todayLocalKey) {
    if (todayUTCKey < localDayKey) return todayUTCKey;
    if (eventDates.length > 0) {
      const unique = new Set(eventDates.map(utcDayKey));
      if (unique.size === 1) return [...unique][0];
    }
    return todayUTCKey;
  }

  if (eventDates.length > 0) {
    const unique = new Set(eventDates.map(utcDayKey));
    if (unique.size === 1) return [...unique][0];
  }

  const localNoonUTC = localTimeToUTCDate(localDayKey, "12:00", tzOffsetMinutes);
  return utcDayKey(localNoonUTC);
}

export function gpxActivityTypeSlug(name) {
  return (name || "move").trim().toLowerCase().replace(/\s+/g, "_");
}

function xmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates standard DailiesMoves GPX 1.1 XML with `<wpt>` for Stationary places and `<trk>` for Moves.
 */
export function generateDailiesGPX({ localDayKey, tzOffsetMinutes, segments, now = new Date() }) {
  const resolvedSegments = segments.map((seg) => {
    const startDate = localTimeToUTCDate(localDayKey, seg.startTime, tzOffsetMinutes);
    let endDate = localTimeToUTCDate(localDayKey, seg.endTime, tzOffsetMinutes);
    if (endDate <= startDate) {
      endDate = new Date(startDate.getTime() + 60 * 1000);
    }
    return { ...seg, startDate, endDate };
  });

  const eventDates = [];
  for (const s of resolvedSegments) {
    eventDates.push(s.startDate, s.endDate);
  }

  const utcDateKey = resolveUTCExportDayKey(localDayKey, eventDates, tzOffsetMinutes, now);
  const filename = `${utcDateKey}.gpx`;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx version="1.1" creator="DailiesMoves" xmlns="http://www.topografix.com/GPX/1/1" xmlns:dm="https://dailiesmoves.app/gpx/1">'
  );
  lines.push("  <metadata>");
  lines.push(`    <name>${xmlEscape(utcDateKey)}</name>`);
  lines.push(
    `    <desc>${xmlEscape(`Timeline for local day ${localDayKey} exported with UTC timestamps`)}</desc>`
  );
  lines.push(`    <time>${toISO8601UTC(now)}</time>`);
  lines.push("  </metadata>");

  // 1. Stationary waypoints (<wpt>)
  for (const seg of resolvedSegments) {
    if (seg.kind !== "stationary") continue;
    if (!Number.isFinite(seg.lat) || !Number.isFinite(seg.lon)) continue;
    const name = seg.name?.trim() || "Stationary";
    const startISO = toISO8601UTC(seg.startDate);
    const endISO = toISO8601UTC(seg.endDate);

    lines.push(`  <wpt lat="${seg.lat.toFixed(6)}" lon="${seg.lon.toFixed(6)}">`);
    lines.push(`    <time>${startISO}</time>`);
    lines.push(`    <name>${xmlEscape(name)}</name>`);
    lines.push(`    <desc>${xmlEscape(`Stationary: ${startISO} to ${endISO}`)}</desc>`);
    lines.push("    <type>stationary</type>");
    lines.push("    <extensions>");
    lines.push("      <dm:segmentType>stationary</dm:segmentType>");
    lines.push(`      <dm:startTime>${startISO}</dm:startTime>`);
    lines.push(`      <dm:endTime>${endISO}</dm:endTime>`);
    lines.push("    </extensions>");
    lines.push("  </wpt>");
  }

  // 2. Move tracks (<trk>)
  for (const seg of resolvedSegments) {
    if (seg.kind !== "move") continue;
    const displayName = seg.activityName?.trim() || "Move";
    const gpxType = gpxActivityTypeSlug(displayName);
    const startISO = toISO8601UTC(seg.startDate);
    const endISO = toISO8601UTC(seg.endDate);

    const pts = seg.points && seg.points.length >= 2 ? seg.points : [];
    const totalDist = polylineDistanceMeters(pts);
    const durationMs = Math.max(1000, seg.endDate.getTime() - seg.startDate.getTime());

    lines.push("  <trk>");
    lines.push(`    <name>${xmlEscape(displayName)}</name>`);
    lines.push(`    <type>${xmlEscape(gpxType)}</type>`);
    lines.push("    <extensions>");
    lines.push("      <dm:segmentType>move</dm:segmentType>");
    lines.push(`      <dm:startTime>${startISO}</dm:startTime>`);
    lines.push(`      <dm:endTime>${endISO}</dm:endTime>`);
    lines.push("    </extensions>");
    lines.push("    <trkseg>");

    if (pts.length >= 2) {
      let cumDist = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) cumDist += haversineMeters(pts[i - 1], pts[i]);
        const frac = totalDist > 0 ? cumDist / totalDist : i / (pts.length - 1);
        const ptDate = new Date(seg.startDate.getTime() + Math.round(frac * durationMs));
        lines.push(`      <trkpt lat="${pts[i].lat.toFixed(6)}" lon="${pts[i].lon.toFixed(6)}">`);
        if (Number.isFinite(pts[i].ele) && pts[i].ele !== 0) {
          lines.push(`        <ele>${pts[i].ele.toFixed(1)}</ele>`);
        }
        lines.push(`        <time>${toISO8601UTC(ptDate)}</time>`);
        lines.push("      </trkpt>");
      }
    } else if (pts.length === 1) {
      lines.push(`      <trkpt lat="${pts[0].lat.toFixed(6)}" lon="${pts[0].lon.toFixed(6)}">`);
      lines.push(`        <time>${startISO}</time>`);
      lines.push("      </trkpt>");
    }

    lines.push("    </trkseg>");
    lines.push("  </trk>");
  }

  lines.push("</gpx>");
  return {
    utcDateKey,
    filename,
    xml: lines.join("\n") + "\n",
  };
}

/**
 * Imports a DailiesMoves or Arc Timeline GPX 1.1 file back into editable segments.
 */
export function parseGPXToTimeline(xmlText, tzOffsetMinutes) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    throw new Error("Invalid GPX XML file.");
  }

  const toLocalHHMM = (isoStr) => {
    if (!isoStr) return "09:00";
    const dt = new Date(isoStr);
    if (Number.isNaN(dt.getTime())) return "09:00";
    const shifted = new Date(dt.getTime() + tzOffsetMinutes * 60 * 1000);
    return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
  };

  const toLocalDay = (isoStr) => {
    if (!isoStr) return null;
    const dt = new Date(isoStr);
    if (Number.isNaN(dt.getTime())) return null;
    const shifted = new Date(dt.getTime() + tzOffsetMinutes * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  };

  const rawItems = [];

  for (const wpt of doc.getElementsByTagName("wpt")) {
    const lat = Number(wpt.getAttribute("lat"));
    const lon = Number(wpt.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = wpt.getElementsByTagName("name")[0]?.textContent?.trim() || "Place";
    const startISO =
      wpt.getElementsByTagNameNS("*", "startTime")[0]?.textContent?.trim() ||
      wpt.getElementsByTagName("time")[0]?.textContent?.trim();
    const endISO = wpt.getElementsByTagNameNS("*", "endTime")[0]?.textContent?.trim();
    const startMs = startISO ? Date.parse(startISO) : Date.now();
    const endMs = endISO ? Date.parse(endISO) : startMs + 30 * 60 * 1000;

    rawItems.push({
      id: crypto.randomUUID(),
      kind: "stationary",
      name,
      lat,
      lon,
      startMs,
      endMs,
      startTime: toLocalHHMM(startISO),
      endTime: toLocalHHMM(endISO || new Date(endMs).toISOString()),
      dayCandidate: toLocalDay(endISO || startISO),
    });
  }

  for (const trk of doc.getElementsByTagName("trk")) {
    const name = trk.getElementsByTagName("name")[0]?.textContent?.trim() || "Move";
    const trkpts = [...trk.getElementsByTagName("trkpt")];
    const points = trkpts
      .map((pt) => ({
        lat: Number(pt.getAttribute("lat")),
        lon: Number(pt.getAttribute("lon")),
        time: pt.getElementsByTagName("time")[0]?.textContent?.trim() || null,
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    const startISO =
      trk.getElementsByTagNameNS("*", "startTime")[0]?.textContent?.trim() ||
      points[0]?.time;
    const endISO =
      trk.getElementsByTagNameNS("*", "endTime")[0]?.textContent?.trim() ||
      points[points.length - 1]?.time;
    const startMs = startISO ? Date.parse(startISO) : Date.now();
    const endMs = endISO ? Date.parse(endISO) : startMs + 10 * 60 * 1000;

    rawItems.push({
      id: crypto.randomUUID(),
      kind: "move",
      activityName: name,
      points: points.map(({ lat, lon }) => ({ lat, lon })),
      startMs,
      endMs,
      startTime: toLocalHHMM(startISO),
      endTime: toLocalHHMM(endISO),
      dayCandidate: toLocalDay(startISO),
    });
  }

  rawItems.sort((a, b) => a.startMs - b.startMs);

  // For Arc GPX files (which only put arrival <time> on <wpt>), infer end time from next item start.
  for (let i = 0; i < rawItems.length; i++) {
    if (rawItems[i].kind === "stationary" && i + 1 < rawItems.length) {
      const next = rawItems[i + 1];
      if (next.startMs > rawItems[i].startMs) {
        rawItems[i].endTime = next.startTime;
      }
    }
    if (rawItems[i].kind === "stationary" && i === 0 && rawItems[i].startMs < Date.parse(`${rawItems[i].dayCandidate}T00:00:00Z`) - tzOffsetMinutes * 60000) {
      rawItems[i].startTime = "00:00";
    }
  }

  const dayCounts = new Map();
  for (const item of rawItems) {
    if (item.dayCandidate) {
      dayCounts.set(item.dayCandidate, (dayCounts.get(item.dayCandidate) || 0) + 1);
    }
  }
  const detectedDay = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    localDayKey: detectedDay,
    segments: rawItems.map(({ startMs, endMs, dayCandidate, ...rest }) => rest),
  };
}
