// Genera una serpiente animada por año con contador de contribuciones.
// Uso: node serpiente.mjs <usuario> <carpeta_salida> [README.md]
// Salida: <carpeta>/snake-<año>.svg y snake-<año>-dark.svg para cada año desde que existe la cuenta.
// Si se pasa un README, reescribe lo que hay entre <!-- SERPIENTE:INICIO --> y <!-- SERPIENTE:FIN -->
// con una pestaña desplegable por año (la del año en curso abierta).
// Sin dependencias: usa la misma página pública que dibuja la cuadrícula del perfil.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , USER = process.env.GITHUB_REPOSITORY_OWNER, OUT = "dist", README] = process.argv;
const BRANCH = "output"; // rama donde el workflow publica los SVG
if (!USER) throw new Error("Falta el usuario: node serpiente.mjs <usuario> <carpeta>");

const CELL = 11, GAP = 3, STEP = CELL + GAP;
const LEFT = 34, TOP = 64, RIGHT = 14, BOTTOM = 14;
const SNAKE_LEN = 5;
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const DIAS = { 1: "Lun", 3: "Mié", 5: "Vie" };

// Paleta del portafolio (ver GITHUB_PROFILE_README.md del proyecto Portafolio):
// azul petróleo + lima en oscuro, oliva sobre blanco en claro.
const TEMAS = {
  light: {
    bg: "#ffffff", border: "#d9dee1",
    levels: ["#eef1f2", "#dfe8a0", "#a3b52a", "#7d8d12", "#66740c"],
    eaten: "#eef1f2", snake: "#1e3442", head: "#0d1a22",
    text: "#13222c", muted: "#5b6f7b", accent: "#66740c",
  },
  dark: {
    bg: "#13222c", border: "#284352",
    levels: ["#1e3442", "#46603a", "#87a043", "#c3d64a", "#dcec6b"],
    eaten: "#1e3442", snake: "#d9d3c3", head: "#f3efe4",
    text: "#eef1f2", muted: "#97a8b2", accent: "#dcec6b",
  },
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "contribution-snake" } });
  if (!res.ok) throw new Error(`${res.status} en ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "contribution-snake" } });
  if (!res.ok) throw new Error(`${res.status} en ${url}`);
  return res.text();
}

// Devuelve [{date, level, count}] del año pedido.
async function contribuciones(year) {
  const html = await getText(
    `https://github.com/users/${USER}/contributions?from=${year}-01-01&to=${year}-12-31`,
  );
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = m[2].match(/^(\d[\d,]*) contribution/);
    counts.set(m[1], n ? Number(n[1].replace(/,/g, "")) : 0);
  }
  const days = [];
  for (const m of html.matchAll(/<td\b[^>]*\bdata-date="[^"]+"[^>]*>/g)) {
    const tag = m[0];
    const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const date = attr("data-date");
    if (!date.startsWith(String(year))) continue;
    const level = Number(attr("data-level") ?? 0);
    days.push({ date, level, count: counts.get(attr("id")) ?? (level > 0 ? 1 : 0) });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

// Coloca cada día en (columna = semana, fila = día de la semana, domingo arriba).
function cuadricula(days, year) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const offset = jan1.getUTCDay();
  return days.map((d) => {
    const t = new Date(d.date + "T00:00:00Z");
    const idx = Math.round((t - jan1) / 86400000) + offset;
    return { ...d, col: Math.floor(idx / 7), row: t.getUTCDay(), month: t.getUTCMonth() };
  });
}

// Recorrido: siempre al cuadro con contribuciones más cercano, paso a paso por la cuadrícula.
function recorrido(cells) {
  const pending = cells.filter((c) => c.count > 0 || c.level > 0);
  let pos = { col: 0, row: 0 };
  const path = [{ ...pos }];
  const eats = []; // {cell, step}
  while (pending.length) {
    let best = 0, bestD = Infinity;
    pending.forEach((c, i) => {
      const d = Math.abs(c.col - pos.col) + Math.abs(c.row - pos.row);
      if (d < bestD || (d === bestD && c.col < pending[best].col)) { best = i; bestD = d; }
    });
    const target = pending.splice(best, 1)[0];
    while (pos.col !== target.col || pos.row !== target.row) {
      if (pos.row !== target.row && (pos.col === target.col || path.length % 2)) {
        pos.row += Math.sign(target.row - pos.row);
      } else {
        pos.col += Math.sign(target.col - pos.col);
      }
      path.push({ ...pos });
    }
    eats.push({ cell: target, step: path.length - 1 });
  }
  return { path, eats };
}

const px = (col) => LEFT + col * STEP;
const py = (row) => TOP + row * STEP;
const r3 = (n) => Math.round(n * 1000) / 1000;
const plural = (n) => `${n} ${n === 1 ? "contribución" : "contribuciones"}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function svg(year, cells, theme, enCurso) {
  const T = TEMAS[theme];
  const cols = Math.max(53, ...cells.map((c) => c.col + 1));
  const W = LEFT + cols * STEP - GAP + RIGHT;
  const H = TOP + 7 * STEP - GAP + BOTTOM;
  const total = cells.reduce((s, c) => s + c.count, 0);
  const { path, eats } = recorrido(cells);

  // Tiempo: cada paso dura lo mismo; la serpiente recorre todo y luego se queda quieta un rato.
  const moves = path.length - 1;
  const tick = Math.min(0.12, Math.max(0.035, 30 / Math.max(moves, 1)));
  const moveTime = moves * tick;
  const pause = 3;
  const dur = r3(moveTime + pause + 1);
  const endFrac = r3(moveTime / dur);
  const startDelay = 1 / dur; // 1 s quieta antes de arrancar
  // Momento (fracción del ciclo) en que la cabeza llega al paso `step`.
  const timeOf = (step) => r3(startDelay + (step / Math.max(moves, 1)) * (endFrac - startDelay));

  const d = "M" + path.map((p) => `${px(p.col) + CELL / 2},${py(p.row) + CELL / 2}`).join("L");
  const anim = (extra) => `dur="${dur}s" repeatCount="indefinite" ${extra}`;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Space Grotesk','Segoe UI',Helvetica,Arial,sans-serif">`,
    `<title>${year}: ${plural(total)}</title>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${T.bg}" stroke="${T.border}"/>`,
    `<text x="${LEFT}" y="26" font-size="16" font-weight="700" fill="${T.accent}">${year}<tspan fill="${T.muted}" font-weight="400" font-size="12">${enCurso ? "  · en curso" : ""}</tspan></text>`,
  );

  // Contador: un texto por valor, cada uno visible solo en su tramo de tiempo.
  const steps = [{ t: 0, n: 0 }];
  let acc = 0;
  for (const e of eats) { acc += e.cell.count; steps.push({ t: timeOf(e.step), n: acc }); }
  const label = (n) => `${n} / ${plural(total)}`;
  steps.forEach((s, i) => {
    const next = steps[i + 1]?.t ?? 1;
    const vals = s.t === 0 ? (next >= 1 ? "1" : "1;0") : next >= 1 ? "0;1" : "0;1;0";
    const kt = s.t === 0 ? (next >= 1 ? "0" : `0;${next}`) : next >= 1 ? `0;${s.t}` : `0;${s.t};${next}`;
    out.push(
      `<text x="${W - RIGHT}" y="26" text-anchor="end" font-size="13" fill="${T.muted}" opacity="${s.t === 0 ? 1 : 0}">${esc(label(s.n))}` +
        (vals === "1" ? "" : `<animate attributeName="opacity" values="${vals}" keyTimes="${kt}" calcMode="discrete" ${anim("")}/>`) +
        `</text>`,
    );
  });

  // Etiquetas de meses y días.
  const seen = new Set();
  for (const c of cells) {
    if (c.row === 0 || !seen.has(c.month)) {
      if (!seen.has(c.month) && new Date(c.date + "T00:00:00Z").getUTCDate() <= 7) {
        seen.add(c.month);
        out.push(`<text x="${px(c.col)}" y="${TOP - 8}" font-size="10" fill="${T.muted}">${MESES[c.month]}</text>`);
      }
    }
  }
  for (const [row, name] of Object.entries(DIAS)) {
    out.push(`<text x="${LEFT - 6}" y="${py(row) + CELL - 2}" text-anchor="end" font-size="9" fill="${T.muted}">${name}</text>`);
  }

  // Cuadros: los que tienen contribuciones cambian de color cuando la serpiente se los come.
  const eatAt = new Map(eats.map((e) => [e.cell.date, timeOf(e.step)]));
  for (const c of cells) {
    const fill = T.levels[c.level] ?? T.levels[0];
    const t = eatAt.get(c.date);
    out.push(
      `<rect x="${px(c.col)}" y="${py(c.row)}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}">` +
        (t !== undefined
          ? `<animate attributeName="fill" values="${fill};${T.eaten}" keyTimes="0;${t}" calcMode="discrete" ${anim("")}/>`
          : "") +
        `</rect>`,
    );
  }

  // Serpiente: todos los segmentos salen del primer cuadro; el segmento i arranca i pasos
  // después de la cabeza y va a la misma velocidad, así la serpiente "crece" al empezar.
  if (moves > 0) {
    out.push(`<path id="camino" d="${d}" fill="none" stroke="none"/>`);
    const stepFrac = (endFrac - startDelay) / moves;
    for (let i = SNAKE_LEN - 1; i >= 0; i--) {
      const size = r3(CELL - i * 1.2);
      const color = i === 0 ? T.head : T.snake;
      const start = r3(startDelay + i * stepFrac);
      const motion = i < moves
        ? `<animateMotion ${anim(`calcMode="linear" keyPoints="0;0;${r3((moves - i) / moves)};${r3((moves - i) / moves)}" keyTimes="0;${start};${endFrac};1"`)}><mpath href="#camino"/></animateMotion>`
        : `<animateMotion ${anim(`keyPoints="0;0" keyTimes="0;1"`)}><mpath href="#camino"/></animateMotion>`;
      out.push(
        `<rect x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" rx="${r3(size / 3)}" fill="${color}" opacity="${r3(1 - i * 0.12)}">${motion}</rect>`,
      );
    }
  }

  if (!eats.length) {
    out.push(`<text x="${W / 2}" y="${py(3) + 4}" text-anchor="middle" font-size="12" fill="${T.muted}">Sin contribuciones este año</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

const created = (await getJSON(`https://api.github.com/users/${USER}`)).created_at;
const firstYear = new Date(created).getUTCFullYear();
const thisYear = new Date().getUTCFullYear();
await mkdir(OUT, { recursive: true });

const resumen = [];
for (let y = thisYear; y >= firstYear; y--) {
  const cells = cuadricula(await contribuciones(y), y);
  const total = cells.reduce((s, c) => s + c.count, 0);
  for (const theme of ["light", "dark"]) {
    const name = theme === "light" ? `snake-${y}.svg` : `snake-${y}-dark.svg`;
    await writeFile(join(OUT, name), svg(y, cells, theme, y === thisYear));
  }
  resumen.push({ year: y, total });
  console.log(`${y}: ${plural(total)}`);
}
await writeFile(join(OUT, "resumen.json"), JSON.stringify(resumen, null, 2));

if (README) {
  const base = `https://raw.githubusercontent.com/${USER}/${USER}/${BRANCH}`;
  const bloque = resumen.map(({ year, total }) => [
    `<details${year === thisYear ? " open" : ""}>`,
    `  <summary><b>${year}</b> · ${plural(total)}${year === thisYear ? " (en curso)" : ""}</summary>`,
    `  <p align="center">`,
    `    <picture>`,
    `      <source media="(prefers-color-scheme: dark)" srcset="${base}/snake-${year}-dark.svg" />`,
    `      <source media="(prefers-color-scheme: light)" srcset="${base}/snake-${year}.svg" />`,
    `      <img alt="Serpiente comiéndose mis contribuciones de ${year}" src="${base}/snake-${year}-dark.svg" width="100%" />`,
    `    </picture>`,
    `  </p>`,
    `</details>`,
  ].join("\n")).join("\n\n");
  const md = await readFile(README, "utf8");
  const re = /(<!-- SERPIENTE:INICIO[^>]*-->)[\s\S]*?(<!-- SERPIENTE:FIN -->)/;
  if (!re.test(md)) throw new Error("El README no tiene los marcadores SERPIENTE:INICIO / SERPIENTE:FIN");
  await writeFile(README, md.replace(re, (_, a, b) => `${a}\n${bloque}\n${b}`));
  console.log("README actualizado");
}
