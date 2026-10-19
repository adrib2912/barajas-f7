// Calendario de los partidos del Barajas para suscribirse desde el móvil (calendario.ics).
// Cuando la RFFM publica o cambia un horario, el calendario de cada una se actualiza solo.
import fs from "node:fs";

const US = "C.D. BARAJAS";
const SHORT = {"C.D. BARAJAS":"Barajas","A.D. MADRID SUR":"Madrid Sur","S.A.D. COLEGIO SAN GABRIEL":"Colegio San Gabriel","C.D. ALGETE":"Algete","C.D. NUEVO PUERTA BONITA DE CARABANCHEL":"Nuevo Puerta Bonita","A.D. EL REAL DE MANZANARES":"El Real de Manzanares","C.F. SAN AGUSTIN DE GUADALIX":"San Agustín de Guadalix","ESC.FUT. EL OLIVO DE COSLADA":"El Olivo de Coslada","CDB FUTBOL FEMENINO OLYMPIA LAS ROZAS":"Olympia Las Rozas","C.D. SANFER19":"Sanfer19","A.D. VILLAVICIOSA DE ODON 'B'":"Villaviciosa de Odón B","C.D. FUTBOL TRES CANTOS":"Tres Cantos","ESCUELA MUNICIPAL DE COBEÑA":"E.M. Cobeña"};
const sn = (t) => SHORT[t] || t;
const APP = "https://adrib2912.github.io/barajas-f7/";

// Hora de Madrid -> instante UTC (tiene en cuenta horario de verano/invierno)
function madridUTC(fecha, hora) {
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = hora.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const comoMadrid = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (comoMadrid - guess));
}
const utc = (dt) => dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dia = (iso) => iso.replace(/-/g, "");
const masDia = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const txt = (s) => String(s).replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
const campoLimpio = (c) => c.replace(/\((h\.?a\.?|hn|t)\)/i, "").replace(/\s+/g, " ").trim().toLowerCase()
  .replace(/(^|[\s\-.(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Del|La|Las|El|Los|Y)(?= )/g, (m) => m.toLowerCase())
  .replace(/\bF7\b/i, "F7").replace(/\bNtra\. Sra\./i, "Ntra. Sra.");
// Lunes de la semana del partido a las 9:00 (Madrid): desde ahí el horario es oficial
const oficial = (fechaJ) => Date.now() >= madridUTC(masDia(fechaJ, -5), "09:00").getTime();

export function escribirCalendario(data, ruta = "calendario.ics") {
  const ahora = utc(new Date());
  const ev = [];
  for (const [j, fechaJ, ms] of data.jornadas) {
    const m = ms.find((x) => x[0] === US || x[1] === US);
    if (!m) continue;
    const [local, visit, g] = m;
    const d = (data.detalles || {})[j] || {};
    const titulo = g ? `${sn(local)} ${g[0]} - ${g[1]} ${sn(visit)}` : `${sn(local)} - ${sn(visit)}`;
    const lugar = d.campo ? campoLimpio(d.campo) : "";
    const L = ["BEGIN:VEVENT", `UID:barajas-f7-j${j}@adrib2912.github.io`, `DTSTAMP:${ahora}`];
    if (d.fecha && d.hora && (g || oficial(fechaJ))) {
      const ini = madridUTC(d.fecha, d.hora);
      L.push(`DTSTART:${utc(ini)}`, `DTEND:${utc(new Date(ini.getTime() + 3600e3))}`,
        `SUMMARY:${txt(`⚽ ${titulo} · J${j}`)}`,
        `DESCRIPTION:${txt(g ? `Jornada ${j}. Resultado final.\n${APP}` : `Jornada ${j}. Horario oficial de la RFFM.\n${APP}`)}`);
    } else {
      // Aún sin horario oficial: todo el fin de semana
      L.push(`DTSTART;VALUE=DATE:${dia(fechaJ)}`, `DTEND;VALUE=DATE:${dia(masDia(fechaJ, 2))}`,
        `SUMMARY:${txt(`⚽ ${titulo} · J${j} · por confirmar`)}`,
        `DESCRIPTION:${txt(`Jornada ${j}. Día y hora por confirmar${d.hora && d.fecha ? ` (previsto ${d.fecha.split("-").reverse().join("/")} a las ${d.hora})` : ""}. La RFFM publica los horarios el lunes de la semana del partido.\n${APP}`)}`,
        "TRANSP:TRANSPARENT");
    }
    if (lugar) L.push(`LOCATION:${txt(lugar)}`);
    L.push(`URL:${APP}`, "END:VEVENT");
    ev.push(L.join("\r\n"));
  }
  const cal = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Barajas F7//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Barajas F7", "X-WR-TIMEZONE:Europe/Madrid", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n";
  fs.writeFileSync(ruta, cal);
  return ev.length;
}

// Se puede lanzar a mano: node ics.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = escribirCalendario(JSON.parse(fs.readFileSync("data.json", "utf8")));
  console.log(`calendario.ics: ${n} partidos`);
}
