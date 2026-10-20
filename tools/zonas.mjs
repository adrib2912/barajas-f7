// Límites de municipios de la Comunidad de Madrid y distritos de Madrid (OpenStreetMap), simplificados
import fs from "node:fs";
import { execSync } from "node:child_process";
const q = `[out:json][timeout:180];
area["boundary"="administrative"]["admin_level"="4"]["name"="Comunidad de Madrid"]->.cm;
(relation["boundary"="administrative"]["admin_level"="8"](area.cm);
 relation["boundary"="administrative"]["admin_level"="9"]["name"~"."](area.cm););
out geom;`;
const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "User-Agent": "barajas-f7" } });
const osm = await r.json();
fs.writeFileSync("/tmp/osm.json", JSON.stringify(osm));
execSync("npx -y osmtogeojson@3.0.0-beta.5 /tmp/osm.json > /tmp/zonas-raw.geojson", { stdio: "inherit", shell: "/bin/bash" });
const gj = JSON.parse(fs.readFileSync("/tmp/zonas-raw.geojson", "utf8"));
gj.features = gj.features.filter((f) => /Polygon/.test(f.geometry.type)).map((f) => ({ type: "Feature", properties: { n: f.properties.name, l: +f.properties.admin_level }, geometry: f.geometry }));
// Madrid ciudad se dibuja por distritos: quitamos el municipio entero
gj.features = gj.features.filter((f) => !(f.properties.l === 8 && f.properties.n === "Madrid"));
gj.features = gj.features.filter((f) => f.properties.l === 8 || f.properties.l === 9);
fs.writeFileSync("/tmp/zonas.geojson", JSON.stringify(gj));
execSync("npx -y mapshaper@0.6.102 /tmp/zonas.geojson -simplify 4% keep-shapes -o precision=0.0001 format=geojson zonas.json", { stdio: "inherit", shell: "/bin/bash" });
const out = JSON.parse(fs.readFileSync("zonas.json", "utf8"));
console.log("zonas:", out.features.length, "KB:", Math.round(fs.statSync("zonas.json").size / 1024));
