// Búsqueda puntual de coordenadas de los campos (OpenStreetMap / Nominatim), 1 petición por segundo
import fs from "node:fs";
const Q = {
  "C.D. BARAJAS": ["Campo de Fútbol Nuestra Señora de la Soledad, Barajas, Madrid", "Calle Ayerbe, Barajas, Madrid"],
  "A.D. MADRID SUR": ["Campo de fútbol José Durán, Madrid", "José Durán, Puente de Vallecas, Madrid"],
  "S.A.D. COLEGIO SAN GABRIEL": ["Colegio San Gabriel, Alcalá de Henares", "Avenida de los Pasionistas, Alcalá de Henares"],
  "C.D. ALGETE": ["Polideportivo Duque de Algete, Algete", "Duque de Algete, Algete"],
  "C.D. NUEVO PUERTA BONITA DE CARABANCHEL": ["Canódromo, Carabanchel, Madrid", "Parque del Antiguo Canódromo, Madrid"],
  "A.D. EL REAL DE MANZANARES": ["campo de fútbol, Manzanares el Real", "Polideportivo, Manzanares el Real"],
  "C.F. SAN AGUSTIN DE GUADALIX": ["Polideportivo Municipal, San Agustín del Guadalix", "campo de fútbol, San Agustín del Guadalix"],
  "ESC.FUT. EL OLIVO DE COSLADA": ["Campo de fútbol Barrio del Puerto, Coslada", "Barrio del Puerto, Coslada"],
  "CDB FUTBOL FEMENINO OLYMPIA LAS ROZAS": ["Recinto Ferial, Las Rozas de Madrid", "campo de fútbol Recinto Ferial Las Rozas"],
  "C.D. SANFER19": ["Santiago del Pino, San Fernando de Henares", "Polideportivo Santiago del Pino, San Fernando de Henares"],
  "A.D. VILLAVICIOSA DE ODON 'B'": ["Campo de fútbol, Villaviciosa de Odón", "Polideportivo, Villaviciosa de Odón"],
  "C.D. FUTBOL TRES CANTOS": ["La Foresta, Tres Cantos", "Polideportivo La Foresta, Tres Cantos"],
  "ESCUELA MUNICIPAL DE COBEÑA": ["Polideportivo La Dehesa, Cobeña", "La Dehesa, Cobeña"],
};
const out = {};
for (const [t, qs] of Object.entries(Q)) {
  out[t] = [];
  for (const q of qs) {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=4&countrycodes=es&q=" + encodeURIComponent(q), { headers: { "User-Agent": "barajas-f7 (github.com/adrib2912/barajas-f7)" } });
    const j = await r.json().catch(() => []);
    out[t].push({ q, res: j.map((x) => [x.lat, x.lon, x.class + "/" + x.type, x.display_name]) });
    await new Promise((s) => setTimeout(s, 1200));
  }
}
fs.mkdirSync("debug", { recursive: true });
fs.writeFileSync("debug/geo.json", JSON.stringify(out, null, 1));
