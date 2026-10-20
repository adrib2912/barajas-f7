// Lee el calendario y los goleadores de la RFFM con un navegador invisible
// y guarda los datos en data.json. Si algo sale raro, NO toca data.json
// y deja pistas en la carpeta debug/ para poder arreglarlo.
import { chromium } from "playwright";
import fs from "node:fs";
import { escribirCalendario } from "./ics.mjs";

const Q = "temporada=22&tipojuego=2&competicion=26738230&grupo=26738231";
const BASE = "https://www.rffm.es/competicion/";
const DEBUG = "debug";
const INICIO = Date.now();
const minutos = () => (Date.now() - INICIO) / 60000;
// MODO=rapida: solo lo que cambia durante la semana (calendario, resultados, clasificación, goleadoras
// y las actas de la jornada actual y la siguiente). MODO=completa: además todo lo demás (temporada
// pasada, dorsales de partidos viejos, horarios de otros equipos...).
const RAPIDA = (process.env.MODO || "completa") === "rapida";
const HOY = new Date().toISOString().slice(0, 10);
const masDias = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
fs.mkdirSync(DEBUG, { recursive: true });
// Copia de lo que se escribe en pantalla, para poder revisarlo luego
const LOG = [];
for (const k of ["log", "error"]) {
  const orig = console[k];
  console[k] = (...a) => { LOG.push(a.join(" ")); orig(...a); fs.writeFileSync(`${DEBUG}/log.txt`, LOG.join("\n")); };
}

// En GitHub ya viene Google Chrome instalado: usarlo ahorra casi un minuto de descarga
let browser;
try { browser = await chromium.launch(process.env.CANAL ? { channel: process.env.CANAL } : {}); }
catch (e) { console.error("No se pudo abrir", process.env.CANAL, "- uso Chromium:", e.message.split("\n")[0]); browser = await chromium.launch(); }
console.log(`Modo ${RAPIDA ? "rápido" : "completo"}`);
const page = await browser.newPage({
  locale: "es-ES",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
});

// Bloqueamos anuncios, imágenes y webs de terceros: va mucho más rápido y no se queda colgado
await page.route("**/*", (route) => {
  const req = route.request();
  const host = new URL(req.url()).hostname;
  if (!host.endsWith("rffm.es") || ["image", "media", "font"].includes(req.resourceType())) return route.abort();
  return route.continue();
});

// Guardamos las respuestas JSON que use la web por dentro (sirven para mejorar esto más adelante)
const api = [];
page.on("response", async (r) => {
  const ct = r.headers()["content-type"] || "";
  if (!ct.includes("json") || !r.url().includes("rffm.es/api")) return;
  try {
    const body = await r.json();
    api.push({ url: r.url(), body });
  } catch {}
});

async function abrir(ruta, espera, q = Q) {
  await page.goto(BASE + ruta + "?" + q, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (espera) await page.waitForFunction((t) => document.body.innerText.includes(t), espera, { timeout: 60000 });
  if (!espera) await page.waitForFunction(() => /Jugador|Goles|RESULTADOS/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

let ok = true;
let jornadas = [];
let goleadoras = [];

// Lee la página de calendario que esté abierta y devuelve las jornadas
async function leerCalendario() {
  const jornadas = [];
  const items = await page.evaluate(() => {
    const all = [...document.querySelectorAll("body *")];
    const txt = (el) => (el.innerText || "").trim();
    const nActas = (el) => (txt(el).match(/VER ACTA/gi) || []).length;
    const out = [];

    // Cabeceras "JORNADA n" con su fecha "n (dd-mm-aaaa)"
    for (const el of all) {
      if (el.children.length === 0 && /^JORNADA\s+\d+$/i.test(txt(el))) {
        let box = el;
        while (box.parentElement && !/\(\d\d-\d\d-\d{4}\)/.test(txt(box)) && nActas(box.parentElement) === 0) box = box.parentElement;
        const f = txt(box).match(/\((\d\d)-(\d\d)-(\d{4})\)/);
        out.push({ el, tipo: "j", j: +txt(el).match(/\d+/)[0], fecha: f ? `${f[3]}-${f[2]}-${f[1]}` : null });
      }
    }
    // Filas de partido: el bloque más grande que contiene un solo "VER ACTA"
    for (const el of all) {
      if (!/^VER ACTA$/i.test(txt(el))) continue;
      if ([...el.children].some((c) => /VER ACTA/i.test(txt(c)))) continue;
      let row = el;
      while (row.parentElement && nActas(row.parentElement) === 1) row = row.parentElement;
      const a = el.closest("a") || el.querySelector("a");
      out.push({ el: row, tipo: "m", lineas: txt(row).split("\n").map((s) => s.trim()).filter(Boolean), acta: a ? a.href : null });
    }
    out.sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // quitar duplicados de filas
    const seen = new Set();
    return out
      .filter((o) => (seen.has(o.el) ? false : seen.add(o.el)))
      .map(({ el, ...rest }) => rest);
  });

  let cur = null;
  for (const it of items) {
    if (it.tipo === "j") {
      cur = { j: it.j, fecha: it.fecha, partidos: [], descansa: [] };
      jornadas.push(cur);
      continue;
    }
    if (!cur) continue;
    const L = it.lineas.filter((s) => !/^VER ACTA$/i.test(s));
    const iScore = L.findIndex((s) => /^(\d+\s*-\s*\d+|-)$/.test(s));
    if (iScore < 0) continue;
    const local = L.slice(0, iScore).join(" ");
    const visit = L.slice(iScore + 1).join(" ");
    const g = L[iScore].match(/(\d+)\s*-\s*(\d+)/);
    if (/No asignado/i.test(local)) cur.descansa.push(visit);
    else if (/No asignado/i.test(visit)) cur.descansa.push(local);
    else cur.partidos.push({ local, visit, g: g ? [+g[1], +g[2]] : null, acta: it.acta });
  }

  return jornadas;
}

// ---------- CALENDARIO ----------
try {
  await abrir("calendario", "VER ACTA");
  fs.writeFileSync(`${DEBUG}/calendario.txt`, await page.evaluate(() => document.body.innerText));

  jornadas = await leerCalendario();

  const nPart = jornadas.reduce((n, j) => n + j.partidos.length, 0);
  console.log(`Calendario: ${jornadas.length} jornadas, ${nPart} partidos`);
  if (jornadas.length < 10 || nPart < 50 || jornadas.some((j) => !j.fecha)) {
    ok = false;
    console.error("El calendario no tiene la forma esperada; no actualizo data.json.");
  }

  // Guardamos un acta de ejemplo para ver si trae campo y hora
  const conActa =
    jornadas.flatMap((j) => j.partidos).find((p) => p.acta && !p.g && (p.local + p.visit).includes("BARAJAS")) ||
    jornadas.flatMap((j) => j.partidos).find((p) => p.acta);
  if (conActa) {
    try {
      await page.goto(conActa.acta, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page
        .waitForFunction(() => /ARBITR|CAMPO|ESTADIO|INSTALACI|HORA/i.test(document.querySelector("main")?.innerText || document.body.innerText.slice(0, 20000)), null, { timeout: 25000 })
        .catch(() => {});
      await page.waitForTimeout(5000);
      fs.writeFileSync(`${DEBUG}/acta-ejemplo.html`, await page.content());
      fs.writeFileSync(`${DEBUG}/acta-ejemplo.txt`, conActa.acta + "\n\n" + (await page.evaluate(() => document.body.innerText)));
    } catch (e) {
      fs.writeFileSync(`${DEBUG}/acta-ejemplo.txt`, "Error: " + e.message);
    }
  }
} catch (e) {
  ok = false;
  console.error("Fallo leyendo el calendario:", e.message);
}

// La RFFM publica los horarios oficiales el lunes de la semana del partido a las 9:00 (hora de Madrid).
// fechaJornada es el sábado del fin de semana de la jornada.
function yaOficial(fechaJornada) {
  if (!fechaJornada) return false;
  const [y, m, d] = fechaJornada.split("-").map(Number);
  const lunes = new Date(Date.UTC(y, m - 1, d - 5, 8, 0)); // 9:00 en Madrid en invierno, 10:00 en verano (margen)
  return Date.now() >= lunes.getTime();
}

// Escudos de los clubes tal como los publica la RFFM (solo guardamos la dirección de la imagen)
const ESCUDOS = (() => { try { return JSON.parse(fs.readFileSync("data.json", "utf8")).escudos || {}; } catch { return {}; } })();
async function leerEscudos() {
  try {
    const html = await page.content();
    const re = /equipo_(local|visitante)\\?":\\?"([^"\\]+)\\?",\\?"escudo_\1\\?":\\?"([^"\\]+)/g;
    for (const m of html.matchAll(re)) {
      const eq = m[2].trim(), url = m[3].trim();
      if (eq && /^\/pnfg\/pimg\//.test(url)) ESCUDOS[eq] = "https://appweb.rffm.es" + encodeURI(url);
    }
  } catch {}
}

// ---------- LECTURA DE UN ACTA ----------
// Devuelve día, hora, campo y, si el partido se ha jugado, convocadas del Barajas y goles.
let volcado = false;
async function leerActa(p, intentos = 2, espera = 45000) {
  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) try {
    await page.goto(p.acta, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes("TERRENO DE JUEGO"), null, { timeout: espera });
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => document.body.innerText);
    await leerEscudos();
    const L = t.split("\n").map((x) => x.trim()).filter(Boolean);
    const fh = t.match(/(\d\d)-(\d\d)-(\d{4})\s*\/\s*(\d{1,2}:\d\d)/);
    const iT = L.indexOf("TERRENO DE JUEGO");
    const campo = iT >= 0 && L[iT + 1] && !/^Patrocinador/i.test(L[iT + 1]) ? L[iT + 1] : null;
    const CAB = ["SUSTITUCIONES", "JUGADORES", "CUERPO TÉCNICO", "GOLES", "TARJETAS", "ÁRBITROS", "TERRENO DE JUEGO"];
    const secciones = {};
    let actual = null;
    const iRes = L.findIndex((x) => x === "RESULTADO");
    for (const x of L.slice(iRes >= 0 ? iRes : 0)) {
      if (CAB.includes(x)) { actual = x; secciones[x] = []; continue; }
      if (/^Patrocinador/i.test(x)) break;
      if (actual) secciones[actual].push(x);
    }
    if (p.g && !volcado) {
      volcado = true;
      fs.writeFileSync(`${DEBUG}/acta-jugado.txt`, p.acta + "\n\n" + L.slice(iRes >= 0 ? iRes - 4 : 0).join("\n"));
    }
    let convocadas = null, goles = null, localActa = null, dorsales = null;
    if (p.g) {
      const lds = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent));
      for (const t of lds) {
        try {
          const ev = JSON.parse(t);
          if (ev["@type"] !== "SportsEvent") continue;
          localActa = (ev.homeTeam?.name || "").trim() === "C.D. BARAJAS";
          const nuestra = localActa ? ev.homeTeam : ev.awayTeam;
          convocadas = (nuestra?.members || []).map((m) => m.name);
        } catch {}
      }
      // El acta manda: a veces el partido se juega con local y visitante cambiados
      const somosLocal = localActa !== null ? localActa : p.local.trim() === "C.D. BARAJAS";
      // Dorsales: cada fila de jugadoras es [dorsal local, nombre local, nombre visitante, dorsal visitante]
      dorsales = {};
      const filas = await page.evaluate(() => {
        const out = [];
        const links = [...document.querySelectorAll('a[href^="/fichajugador/"]')];
        const vistos = new Set();
        for (const a of links) {
          let row = a.parentElement;
          while (row && row.parentElement && row.querySelectorAll('a[href^="/fichajugador/"]').length < 2 && !/^\s*\d+\s*$/.test(row.firstElementChild?.innerText || "")) row = row.parentElement;
          if (!row || vistos.has(row)) continue;
          vistos.add(row);
          out.push(row.innerText.split("\n").map((x) => x.trim()).filter((x) => x && !/^\(\d+'\)$/.test(x)));
        }
        return out;
      });
      for (const f of filas) {
        for (const n of convocadas || []) {
          const i = f.indexOf(n);
          if (i < 0) continue;
          const d = somosLocal ? f[i - 1] : f[i + 1];
          if (/^\d{1,2}$/.test(d || "")) dorsales[n] = +d;
        }
      }
      goles = [];
      const G = secciones["GOLES"] || [];
      let prev = [0, 0];
      for (let i = 0; i < G.length; i++) {
        const m = G[i].match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) continue;
        const sc = [+m[1], +m[2]];
        const min = (G[i + 1] || "").match(/^\((\d+)'\)$/);
        const nombre = min ? G[i + 2] : G[i + 1];
        const nuestro = (sc[0] > prev[0]) === somosLocal;
        const propia = nuestro ? !(convocadas || []).includes(nombre) : (convocadas || []).includes(nombre);
        goles.push({ min: min ? +min[1] : null, nombre, nuestro, propia, marcador: sc });
        prev = sc;
      }
    }
    return {
      ...(convocadas ? { convocadas } : {}),
      ...(goles ? { goles } : {}),
      ...(dorsales && Object.keys(dorsales).length ? { dorsales } : {}),
      fecha: fh ? `${fh[3]}-${fh[2]}-${fh[1]}` : null,
      hora: fh && fh[4] !== "00:00" ? fh[4] : null,
      campo,
    };
  } catch (e) {
    ultimoError = e;
    console.error(`Acta ${p.acta} (intento ${intento}): ${e.message.split("\n")[0]}`);
  }
  throw ultimoError;
}

// ---------- DETALLES DE NUESTROS PARTIDOS ----------
let previo = {};
let anterior = null;
try { const d = JSON.parse(fs.readFileSync("data.json", "utf8")); previo = d.detalles || {}; anterior = d.anterior || null; } catch {}
const detalles = { ...previo };
if (ok) {
  // Para ir rápido solo abrimos: los próximos 3 partidos sin resultado, hasta 4 sin datos
  // y hasta 6 jugados cuyo acta (goles y convocadas) aún no tengamos.
  const nuestros = jornadas
    .map((j) => ({ j, p: j.partidos.find((x) => (x.local + x.visit).includes("C.D. BARAJAS") && x.acta) }))
    .filter((x) => x.p);
  const proximos = nuestros.filter((x) => !x.p.g).slice(0, RAPIDA ? 2 : 3);
  const sinDatos = nuestros.filter((x) => !previo[x.j.j] && !proximos.includes(x)).slice(0, 4);
  const jugados = nuestros.filter((x) => x.p.g && !(previo[x.j.j] && previo[x.j.j].dorsales) && !sinDatos.includes(x)).slice(0, 6);
  // En modo rápido: los dos próximos y el último jugado si aún no tenemos sus goles y convocadas
  const lista = RAPIDA
    ? [...proximos, ...nuestros.filter((x) => x.p.g && x.j.fecha >= masDias(-10) && !(previo[x.j.j] && previo[x.j.j].dorsales))]
    : [...proximos, ...sinDatos, ...jugados];
  for (const { j, p } of lista) {
    try {
      const nuevo = await leerActa(p);
      const viejo = previo[j.j] || {};
      // Si ya había día y hora oficiales y la RFFM los cambia, lo apuntamos
      const cambios = [...(viejo.cambios || [])];
      nuevo.of = yaOficial(j.fecha);
      if (viejo.of && viejo.hora && nuevo.hora && (viejo.hora !== nuevo.hora || viejo.fecha !== nuevo.fecha))
        cambios.push({ antes: { fecha: viejo.fecha, hora: viejo.hora }, ahora: { fecha: nuevo.fecha, hora: nuevo.hora }, visto: new Date().toISOString() });
      if (viejo.of && viejo.campo && nuevo.campo && viejo.campo !== nuevo.campo)
        cambios.push({ antes: { campo: viejo.campo }, ahora: { campo: nuevo.campo }, visto: new Date().toISOString() });
      detalles[j.j] = { ...nuevo, ...(cambios.length ? { cambios } : {}) };
      if (cambios.length > (viejo.cambios || []).length) console.log(`Cambio en la jornada ${j.j}:`, JSON.stringify(cambios.at(-1)));
    } catch {}
  }
  console.log(`Detalles de ${Object.keys(detalles).length} partidos del Barajas`);
}

// ---------- TEMPORADA ANTERIOR (se lee una vez y se guarda) ----------
const base = (t) => t.trim().replace(/\s+'[A-Z]'$/, "");
if (ok && !RAPIDA && !(anterior && anterior.v === 3)) {
  try {
    const equiposHoy = new Set(jornadas.flatMap((j) => j.partidos.flatMap((p) => [p.local, p.visit])));
    await abrir("calendario", "VER ACTA");
    const api = async (ruta) => {
      const txt = await page.evaluate(async (r) => { const x = await fetch(r, { headers: { accept: "application/json" } }); return x.status + " " + (await x.text()); }, ruta);
      const sp = txt.indexOf(" ");
      try { return JSON.parse(txt.slice(sp + 1)); } catch { throw new Error(`${ruta} -> ${txt.slice(0, 300)}`); }
    };
    const comps = await api("/api/competitions?temporada=21&tipojuego=2");
    const femSenior = comps.filter((c) => /FEMENINO/i.test(c.nombre) && /SENIOR|AFICIONAD/i.test(c.nombre));
    console.log("Competiciones 2025-26:", femSenior.map((c) => c.nombre).join(" | "));
    const baseHoy = new Set([...equiposHoy].map(base));
    const grupos = [];
    for (const c of femSenior) {
      const gs = await api("/api/groups?competicion=" + c.codigo);
      for (const g of gs) {
        await abrir("calendario", "VER ACTA", `temporada=21&tipojuego=2&competicion=${c.codigo}&grupo=${g.codigo}`);
        const js = await leerCalendario();
        const equipos = new Set(js.flatMap((j) => j.partidos.flatMap((p) => [p.local, p.visit])));
        const comunes = [...equipos].filter((e) => baseHoy.has(base(e)));
        console.log(`  ${c.nombre} ${g.nombre}: ${js.length} jornadas, ${comunes.length} equipos de este año`);
        if (comunes.length)
          grupos.push({
            competicion: c.nombre,
            grupo: g.nombre,
            jornadas: js.map((j) => [
              j.j, j.fecha,
              j.partidos.map((p) => [p.local, p.visit, p.g, p.acta]),
              j.descansa,
            ]),
          });
      }
    }
    anterior = { v: 3, temporada: "2025-2026", grupos, actas: (anterior && anterior.actas) || {} };
  } catch (e) {
    console.error("No se pudo leer la temporada anterior:", e.stack || e.message);
  }
}
// Actas de la temporada pasada: nuestros partidos contra rivales de este año (8 por pasada)
if (ok && !RAPIDA && anterior && anterior.v >= 2) {
  const baseHoy = new Set(jornadas.flatMap((j) => j.partidos.flatMap((p) => [base(p.local), base(p.visit)])));
  anterior.actas = anterior.actas || {};
  const pendientes = anterior.grupos
    .flatMap((g) => g.jornadas.flatMap((j) => j[2]))
    .filter((m) => m[3] && m[2] && (m[0] === "C.D. BARAJAS" || m[1] === "C.D. BARAJAS") && !(anterior.actas[m[3]] && anterior.actas[m[3]].v === 2) && baseHoy.has(base(m[0] === "C.D. BARAJAS" ? m[1] : m[0])))
    .slice(0, 10);
  for (const m of pendientes) {
    if (minutos() > 7) break;
    try {
      const r = await leerActa({ acta: m[3], local: m[0], visit: m[1], g: m[2] });
      anterior.actas[m[3]] = { v: 2, goles: r.goles, convocadas: r.convocadas, fecha: r.fecha };
    } catch {}
  }
  console.log(`Actas de la temporada pasada guardadas: ${Object.keys(anterior.actas).length}`);
}

// ---------- HORARIOS DE TODOS LOS PARTIDOS (para saber a qué hora suele jugar cada equipo en casa) ----------
let horarios = {};
try { horarios = JSON.parse(fs.readFileSync("data.json", "utf8")).horarios || {}; } catch {}
if (ok) {
  const limite = new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10);
  const hoyIso = new Date().toISOString().slice(0, 10);
  // Esta temporada: partidos ya jugados o de los próximos días (cuando la RFFM ya ha puesto la hora)
  const deEsta = jornadas.flatMap((j) => j.partidos.map((p) => ({ p, fecha: j.fecha })))
    .sort((x, y) => (x.fecha >= hoyIso) === (y.fecha >= hoyIso) ? 0 : x.fecha >= hoyIso ? -1 : 1)
    .filter(({ p, fecha }) => p.acta && fecha <= limite && (!horarios[p.acta] || (!horarios[p.acta][2] && fecha >= hoyIso) || (horarios[p.acta][1] >= hoyIso)))
    .filter(({ fecha }) => !RAPIDA || (fecha >= masDias(-3) && fecha <= masDias(9)))
    .map(({ p, fecha }) => ({ ...p, fechaJ: fecha }));
  // Temporada pasada: todos los partidos de los grupos con equipos de este año
  // Temporada pasada: solo los partidos EN CASA de equipos que este año son rivales nuestros
  const baseHoyH = new Set(jornadas.flatMap((j) => j.partidos.flatMap((p) => [base(p.local), base(p.visit)])));
  const deAnterior = (anterior && anterior.grupos ? anterior.grupos : []).flatMap((g) => g.jornadas.flatMap((j) => j[2]))
    .filter((m) => m[3] && m[2] && !horarios[m[3]] && baseHoyH.has(base(m[0]))).map((m) => ({ acta: m[3], local: m[0], visit: m[1], g: null }));
  console.log(`Horarios pendientes: ${deEsta.length} de esta temporada, ${deAnterior.length} de la pasada`);
  const limiteMin = +(process.env.MINUTOS || 13);
  for (const p of RAPIDA ? deEsta.slice(0, 7) : [...deEsta.slice(0, 16), ...deAnterior.slice(0, limiteMin > 13 ? 400 : 30)]) {
    if (minutos() > limiteMin) { console.log("Tiempo agotado para horarios; seguimos en la próxima pasada"); break; }
    try {
      const r = await leerActa({ ...p, g: null }, 1, 20000);
      const v = horarios[p.acta];
      // [local, fecha, hora, cambio anterior {fecha, hora} si la RFFM lo ha movido]
      // v[4] = 1 si cuando se leyó ya era oficial; solo entonces un cambio cuenta como "cambio"
      const cambio = v && v[4] && v[2] && r.hora && (v[1] !== r.fecha || v[2] !== r.hora) ? { fecha: v[1], hora: v[2] } : (v && v[3]) || null;
      const of = p.fechaJ ? (yaOficial(p.fechaJ) ? 1 : 0) : 1;
      horarios[p.acta] = [p.local, r.fecha, r.hora, cambio, of];
    } catch {}
  }
  console.log(`Horarios guardados: ${Object.keys(horarios).length}`);
}

// ---------- CLASIFICACIÓN OFICIAL ----------
let clasif = null;
try { clasif = JSON.parse(fs.readFileSync("data.json", "utf8")).clasif || null; } catch {}
if (ok) {
  try {
    await abrir("clasificaciones", null);
    await page.waitForFunction(() => /C\.D\. BARAJAS/.test(document.body.innerText) && /\d+\s+\d+\s+\d+/.test(document.body.innerText), null, { timeout: 40000 });
    await page.waitForTimeout(1500);
    const texto = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(`${DEBUG}/clasificacion.txt`, texto);
    const equipos = [...new Set(jornadas.flatMap((j) => j.partidos.flatMap((p) => [p.local, p.visit])))]
      .sort((a, b) => b.length - a.length);
    // Tras el nombre de cada equipo vienen sus números: puntos, jugados, ganados, empatados, perdidos, GF, GC...
    const filas = [];
    for (const t of equipos) {
      const esc = t.replace(/[.*+?^${}()|[\]\\']/g, (c) => "\\" + c);
      const m = texto.match(new RegExp(esc + "[\\s\\S]{0,40}?((?:\\d+\\s+){6}\\d+)"));
      if (!m) continue;
      const n = m[1].trim().split(/\s+/).map(Number);
      filas.push({ t, idx: m.index, pts: n[0], pj: n[1], g: n[2], e: n[3], p: n[4], gf: n[5], gc: n[6] });
    }
    filas.sort((a, b) => a.idx - b.idx);
    // Comprobaciones: estén todos, jugados = G+E+P y puntos coherentes (puede haber sanciones, se toleran)
    const coherente = filas.length === equipos.length && filas.every((f) => f.pj === f.g + f.e + f.p && f.pts <= 3 * f.g + f.e);
    if (coherente) {
      clasif = filas.map(({ idx, ...f }) => f);
      console.log(`Clasificación oficial: ${clasif.length} equipos, líder ${clasif[0].t} con ${clasif[0].pts}`);
    } else console.error(`Clasificación oficial no válida (${filas.length}/${equipos.length} equipos); se mantiene la anterior`);
  } catch (e) {
    console.error("No se pudo leer la clasificación oficial:", e.message.split("\n")[0]);
  }
}

// ---------- OTRAS CLASIFICACIONES: el otro grupo de este año y los dos grupos del año pasado ----------
// Solo la tabla final (o actual). La del año pasado se lee una vez y se guarda.
function leerTabla(texto, equipos) {
  const filas = [];
  for (const t of [...equipos].sort((a, b) => b.length - a.length)) {
    const esc = t.replace(/[.*+?^${}()|[\]\\']/g, (c) => "\\" + c);
    const m = texto.match(new RegExp(esc + "[\\s\\S]{0,40}?((?:\\d+\\s+){6}\\d+)"));
    if (!m) continue;
    const n = m[1].trim().split(/\s+/).map(Number);
    filas.push({ t, idx: m.index, pts: n[0], pj: n[1], g: n[2], e: n[3], p: n[4], gf: n[5], gc: n[6] });
  }
  filas.sort((a, b) => a.idx - b.idx);
  const ok = filas.length === equipos.length && filas.every((f) => f.pj === f.g + f.e + f.p && f.pts <= 3 * f.g + f.e);
  return ok ? filas.map(({ idx, ...f }) => f) : null;
}
let tablas = [];
try { tablas = JSON.parse(fs.readFileSync("data.json", "utf8")).tablas || []; } catch {}
const faltaAnterior = !tablas.some((x) => x.temporada === "2025-2026");
if (ok && (!RAPIDA || faltaAnterior || !tablas.length)) {
  try {
    await abrir("calendario", "VER ACTA");
    const api = async (ruta) => page.evaluate(async (r) => (await fetch(r, { headers: { accept: "application/json" } })).json(), ruta);
    const pedir = [];
    for (const g of await api("/api/groups?competicion=26738230"))
      if (String(g.codigo) !== "26738231") pedir.push({ temporada: "2026-2027", grupo: g.nombre, q: `temporada=22&tipojuego=2&competicion=26738230&grupo=${g.codigo}` });
    if (faltaAnterior) {
      const comps = (await api("/api/competitions?temporada=21&tipojuego=2")).filter((c) => /PRIMERA FEMENINO SENIOR/i.test(c.nombre));
      for (const c of comps) for (const g of await api("/api/groups?competicion=" + c.codigo))
        pedir.push({ temporada: "2025-2026", grupo: g.nombre, q: `temporada=21&tipojuego=2&competicion=${c.codigo}&grupo=${g.codigo}` });
    }
    const nuevas = [];
    for (const x of pedir) {
      try {
        await abrir("calendario", "JORNADA", x.q);
        const js = await leerCalendario();
        const equipos = [...new Set(js.flatMap((j) => j.partidos.flatMap((p) => [p.local, p.visit])))];
        await abrir("clasificaciones", null, x.q);
        await page.waitForFunction(() => /\d+\s+\d+\s+\d+/.test(document.body.innerText), null, { timeout: 40000 });
        await page.waitForTimeout(1500);
        let filas = leerTabla(await page.evaluate(() => document.body.innerText), equipos);
        let fuente = "oficial";
        if (!filas) { // Si no se puede leer la oficial, se calcula con los resultados
          const S = {}; const add = (t) => (S[t] ??= { t, pts: 0, pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0 });
          js.forEach((j) => j.partidos.forEach((p) => { add(p.local); add(p.visit); if (!p.g) return; const H = S[p.local], A = S[p.visit];
            H.pj++; A.pj++; H.gf += p.g[0]; H.gc += p.g[1]; A.gf += p.g[1]; A.gc += p.g[0];
            if (p.g[0] > p.g[1]) { H.g++; A.p++; H.pts += 3 } else if (p.g[0] < p.g[1]) { A.g++; H.p++; A.pts += 3 } else { H.e++; A.e++; H.pts++; A.pts++ } }));
          filas = Object.values(S); fuente = "calculada";
        }
        filas.sort((a, b) => b.pts - a.pts || (b.gf - b.gc) - (a.gf - a.gc) || b.gf - a.gf);
        nuevas.push({ temporada: x.temporada, grupo: x.grupo, fuente, filas });
        console.log(`Tabla ${x.temporada} ${x.grupo}: ${filas.length} equipos (${fuente})`);
      } catch (e) { console.error(`Tabla ${x.temporada} ${x.grupo}:`, e.message.split("\n")[0]); }
    }
    tablas = [...tablas.filter((t) => !nuevas.some((n) => n.temporada === t.temporada && n.grupo === t.grupo)), ...nuevas];
  } catch (e) { console.error("Otras clasificaciones:", e.message.split("\n")[0]); }
}

// ---------- GOLEADORAS ----------
try {
  await abrir("goleadores");
  const texto = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(`${DEBUG}/goleadores.txt`, texto);
  // Bloques: NOMBRE / EQUIPO / Grupo n / goles / (nP)
  const L = texto.split("\n").map((x) => x.trim()).filter(Boolean);
  const ini = L.findIndex((x, i) => x === "Jugador" && L[i + 1] === "Equipo");
  if (ini >= 0) {
    for (let i = ini + 4; i + 3 < L.length; ) {
      if (/^Grupo\s/i.test(L[i + 2]) && /^\d+$/.test(L[i + 3])) {
        const pen = /^\((\d+)P\)$/i.exec(L[i + 4] || "");
        goleadoras.push({ n: L[i], eq: L[i + 1], g: +L[i + 3], p: pen ? +pen[1] : 0 });
        i += pen ? 5 : 4;
      } else if (goleadoras.length) break;
      else i++;
    }
  }
  console.log(`Goleadoras: ${goleadoras.length} filas`);
} catch (e) {
  console.error("No se pudieron leer las goleadoras:", e.message);
}

// ---------- PLANTILLA (ficha del equipo en la RFFM: todas las jugadoras con licencia) ----------
const EQUIPO_BARAJAS = "24025221"; // código del equipo en la RFFM (sale en las actas: codigo_equipo_...)
let plantilla = null;
try { plantilla = JSON.parse(fs.readFileSync("data.json", "utf8")).plantilla || null; } catch {}
try {
  await page.goto(`https://www.rffm.es/fichaequipo/${EQUIPO_BARAJAS}?temporada=22`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => /JUGADORES \(\d+\)/.test(document.body.innerText), null, { timeout: 40000 });
  await page.waitForTimeout(800);
  const L = (await page.evaluate(() => document.body.innerText)).split("\n").map((x) => x.trim()).filter(Boolean);
  const i = L.findIndex((x) => /^JUGADORES \(\d+\)$/.test(x));
  const n = +L[i].match(/\d+/)[0];
  const lista = [];
  for (const x of L.slice(i + 1)) { if (!/^[^,]+,\s*\S/.test(x) || x !== x.toUpperCase()) break; lista.push(x); }
  if (lista.length === n && n > 0) { plantilla = lista; console.log(`Plantilla: ${n} jugadoras`); }
  else console.error(`Plantilla rara (${lista.length} de ${n}); se mantiene la anterior`);
} catch (e) { console.error("No se pudo leer la plantilla:", e.message.split("\n")[0]); }

// Copia del escudo del Barajas (nuestro club) para dibujarlo en el pecho de nuestra camiseta
if (ESCUDOS["C.D. BARAJAS"] && !fs.existsSync("escudo-barajas.jpg")) {
  try {
    const r = await page.request.get(ESCUDOS["C.D. BARAJAS"], { timeout: 30000 });
    if (r.ok()) { fs.writeFileSync("escudo-barajas.jpg", await r.body()); console.log("Escudo del Barajas guardado"); }
    else console.error("Escudo del Barajas:", r.status());
  } catch (e) { console.error("No se pudo bajar el escudo del Barajas:", e.message.split("\n")[0]); }
}

fs.writeFileSync(`${DEBUG}/api.json`, JSON.stringify(api.slice(0, 40), null, 1).slice(0, 2_000_000));
await browser.close();

if (ok) {
  const data = {
    actualizado: new Date().toISOString(),
    fuente: "rffm.es",
    jornadas: jornadas.map((j) => [j.j, j.fecha, j.partidos.map((p) => [p.local, p.visit, p.g, p.acta]), j.descansa]),
    goleadoras,
    detalles,
    anterior,
    horarios,
    clasif,
    escudos: ESCUDOS,
    plantilla,
    tablas,
  };
  fs.writeFileSync("data.json", JSON.stringify(data));
  console.log("data.json actualizado");
  try { console.log(`calendario.ics: ${escribirCalendario(data)} partidos`); } catch (e) { console.error("No se pudo escribir el calendario:", e.message); }
} else {
  process.exitCode = 1;
}
