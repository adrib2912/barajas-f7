// Campos de fútbol (OpenStreetMap) cerca de cada punto aproximado
import fs from "node:fs";
const P = { BAR: [40.4712, -3.5775], OLI: [40.4195, -3.5701], OLY: [40.5096, -3.8913], VIL: [40.3549, -3.8981], TCA: [40.6126, -3.7067], SGA: [40.5078, -3.3876], SAG: [40.6799, -3.6190] };
const out = {};
for (const [k, [la, lo]] of Object.entries(P)) {
  const q = `[out:json][timeout:25];(nwr(around:900,${la},${lo})[leisure=pitch][sport~"soccer"];nwr(around:900,${la},${lo})[leisure~"stadium|sports_centre"];);out center tags;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "User-Agent": "barajas-f7" } });
  const j = await r.json().catch((e) => ({ elements: [], err: String(e) }));
  out[k] = (j.elements || []).map((e) => [(e.center || e).lat, (e.center || e).lon, e.tags.leisure, e.tags.name || "", e.tags.sport || "", e.tags.surface || ""]);
  await new Promise((s) => setTimeout(s, 3000));
}
fs.writeFileSync("debug/geo2.json", JSON.stringify(out, null, 1));
