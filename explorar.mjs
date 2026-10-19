// Exploración puntual de la web de la RFFM (rutas disponibles y ficha de equipo)
import { chromium } from "playwright";
import fs from "node:fs";
const out = [];
const log = (...a) => { out.push(a.join(" ")); console.log(...a); };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ locale: "es-ES" });
await page.route("**/*", (r) => { const h = new URL(r.request().url()).hostname; if (!h.endsWith("rffm.es") || ["image", "media", "font"].includes(r.request().resourceType())) return r.abort(); return r.continue(); });
const apis = new Set();
page.on("request", (r) => { if (r.url().includes("/api/")) apis.add(r.url()); });
await page.goto("https://www.rffm.es/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);
const rutas = await page.evaluate(() => (window.__BUILD_MANIFEST && window.__BUILD_MANIFEST.sortedPages) || Object.keys(window.__BUILD_MANIFEST || {}));
log("RUTAS:", JSON.stringify(rutas));
// Intentos de ficha de equipo / club
const prueba = [
  "/fichaequipo/24025221", "/equipo/24025221", "/competicion/equipo?codigo_equipo=24025221&temporada=22",
  "/ficha-equipo/24025221", "/club/24025221", "/fichaclub/42740",
];
for (const r of (rutas || []).filter((x) => /equipo|club|plantilla|jugador/i.test(x))) prueba.push(r.replace(/\[[^\]]+\]/g, r.includes("club") ? "42740" : r.includes("jugador") ? "x" : "24025221"));
for (const ruta of [...new Set(prueba)]) {
  try {
    const resp = await page.goto("https://www.rffm.es" + ruta + (ruta.includes("?") ? "" : "?temporada=22"), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    const t = await page.evaluate(() => document.body.innerText);
    log(`\n=== ${ruta} [${resp && resp.status()}] ${t.length} chars`);
    log(t.slice(0, 2500));
  } catch (e) { log(`\n=== ${ruta} ERROR ${e.message.split("\n")[0]}`); }
}
log("\nAPIS:", [...apis].join("\n"));
fs.mkdirSync("debug", { recursive: true });
fs.writeFileSync("debug/explorar.txt", out.join("\n"));
await browser.close();
