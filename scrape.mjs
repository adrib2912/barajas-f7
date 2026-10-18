// Lee el calendario y los goleadores de la RFFM con un navegador invisible
// y guarda los datos en data.json. Si algo sale raro, NO toca data.json
// y deja pistas en la carpeta debug/ para poder arreglarlo.
import { chromium } from "playwright";
import fs from "node:fs";

const Q = "temporada=22&tipojuego=2&competicion=26738230&grupo=26738231";
const BASE = "https://www.rffm.es/competicion/";
const DEBUG = "debug";
fs.mkdirSync(DEBUG, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  locale: "es-ES",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
});

// Guardamos las respuestas JSON que use la web por dentro (sirven para mejorar esto más adelante)
const api = [];
page.on("response", async (r) => {
  const ct = r.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  try {
    const body = await r.json();
    api.push({ url: r.url(), body });
  } catch {}
});

async function abrir(ruta, espera) {
  await page.goto(BASE + ruta + "?" + Q, { waitUntil: "networkidle", timeout: 90000 });
  if (espera) await page.waitForFunction((t) => document.body.innerText.includes(t), espera, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

let ok = true;
let jornadas = [];
let goleadoras = [];

// ---------- CALENDARIO ----------
try {
  await abrir("calendario", "VER ACTA");
  fs.writeFileSync(`${DEBUG}/calendario.txt`, await page.evaluate(() => document.body.innerText));

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

  const nPart = jornadas.reduce((n, j) => n + j.partidos.length, 0);
  console.log(`Calendario: ${jornadas.length} jornadas, ${nPart} partidos`);
  if (jornadas.length < 10 || nPart < 50 || jornadas.some((j) => !j.fecha)) {
    ok = false;
    console.error("El calendario no tiene la forma esperada; no actualizo data.json.");
  }

  // Guardamos un acta de ejemplo para ver si trae campo y hora
  const conActa = jornadas.flatMap((j) => j.partidos).find((p) => p.acta);
  if (conActa) {
    try {
      await page.goto(conActa.acta, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(2000);
      fs.writeFileSync(`${DEBUG}/acta-ejemplo.txt`, conActa.acta + "\n\n" + (await page.evaluate(() => document.body.innerText)));
    } catch (e) {
      fs.writeFileSync(`${DEBUG}/acta-ejemplo.txt`, "Error: " + e.message);
    }
  }
} catch (e) {
  ok = false;
  console.error("Fallo leyendo el calendario:", e.message);
}

// ---------- GOLEADORAS ----------
try {
  await abrir("goleadores");
  const texto = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(`${DEBUG}/goleadores.txt`, texto);
  goleadoras = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tr")];
    return rows
      .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()))
      .filter((c) => c.length >= 3);
  });
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
  };
  fs.writeFileSync("data.json", JSON.stringify(data));
  console.log("data.json actualizado");
} else {
  process.exitCode = 1;
}
