// Lee el calendario y los goleadores de la RFFM con un navegador invisible
// y guarda los datos en data.json. Si algo sale raro, NO toca data.json
// y deja pistas en la carpeta debug/ para poder arreglarlo.
import { chromium } from "playwright";
import fs from "node:fs";

const Q = "temporada=22&tipojuego=2&competicion=26738230&grupo=26738231";
const BASE = "https://www.rffm.es/competicion/";
const DEBUG = "debug";
fs.mkdirSync(DEBUG, { recursive: true });
// Copia de lo que se escribe en pantalla, para poder revisarlo luego
const LOG = [];
for (const k of ["log", "error"]) {
  const orig = console[k];
  console[k] = (...a) => { LOG.push(a.join(" ")); orig(...a); fs.writeFileSync(`${DEBUG}/log.txt`, LOG.join("\n")); };
}

const browser = await chromium.launch();
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

// ---------- LECTURA DE UN ACTA ----------
// Devuelve día, hora, campo y, si el partido se ha jugado, convocadas del Barajas y goles.
let volcado = false;
async function leerActa(p) {
  let ultimoError;
  for (let intento = 1; intento <= 2; intento++) try {
    await page.goto(p.acta, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes("TERRENO DE JUEGO"), null, { timeout: 45000 });
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => document.body.innerText);
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
    let convocadas = null, goles = null, localActa = null;
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
  const proximos = nuestros.filter((x) => !x.p.g).slice(0, 3);
  const sinDatos = nuestros.filter((x) => !previo[x.j.j] && !proximos.includes(x)).slice(0, 4);
  const jugados = nuestros.filter((x) => x.p.g && !(previo[x.j.j] && previo[x.j.j].convocadas) && !sinDatos.includes(x)).slice(0, 6);
  for (const { j, p } of [...proximos, ...sinDatos, ...jugados]) {
    try { detalles[j.j] = await leerActa(p); } catch {}
  }
  console.log(`Detalles de ${Object.keys(detalles).length} partidos del Barajas`);
}

// ---------- TEMPORADA ANTERIOR (se lee una vez y se guarda) ----------
const base = (t) => t.trim().replace(/\s+'[A-Z]'$/, "");
if (ok && !(anterior && anterior.v === 2)) {
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
              j.partidos.map((p) => ((p.local + p.visit).includes("C.D. BARAJAS") ? [p.local, p.visit, p.g, p.acta] : [p.local, p.visit, p.g])),
              j.descansa,
            ]),
          });
      }
    }
    anterior = { v: 2, temporada: "2025-2026", grupos, actas: (anterior && anterior.actas) || {} };
  } catch (e) {
    console.error("No se pudo leer la temporada anterior:", e.stack || e.message);
  }
}
// Actas de la temporada pasada: nuestros partidos contra rivales de este año (8 por pasada)
if (ok && anterior && anterior.v === 2) {
  const baseHoy = new Set(jornadas.flatMap((j) => j.partidos.flatMap((p) => [base(p.local), base(p.visit)])));
  anterior.actas = anterior.actas || {};
  const pendientes = anterior.grupos
    .flatMap((g) => g.jornadas.flatMap((j) => j[2]))
    .filter((m) => m[3] && m[2] && !(anterior.actas[m[3]] && anterior.actas[m[3]].v === 2) && baseHoy.has(base(m[0] === "C.D. BARAJAS" ? m[1] : m[0])))
    .slice(0, 10);
  for (const m of pendientes) {
    try {
      const r = await leerActa({ acta: m[3], local: m[0], visit: m[1], g: m[2] });
      anterior.actas[m[3]] = { v: 2, goles: r.goles, convocadas: r.convocadas, fecha: r.fecha };
    } catch {}
  }
  console.log(`Actas de la temporada pasada guardadas: ${Object.keys(anterior.actas).length}`);
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

fs.writeFileSync(`${DEBUG}/api.json`, JSON.stringify(api.slice(0, 40), null, 1).slice(0, 2_000_000));
await browser.close();

if (ok) {
  const data = {
    actualizado: new Date().toISOString(),
    fuente: "rffm.es",
    jornadas: jornadas.map((j) => [j.j, j.fecha, j.partidos.map((p) => [p.local, p.visit, p.g]), j.descansa]),
    goleadoras,
    detalles,
    anterior,
  };
  fs.writeFileSync("data.json", JSON.stringify(data));
  console.log("data.json actualizado");
} else {
  process.exitCode = 1;
}
