// Una nave dispara a cada cuadro con contribuciones; al impactar, el cuadro explota en píxeles
// y el contador suma lo destruido. Un SVG animado por año (claro y oscuro).
//
// Uso: node nave.mjs <usuario> <carpeta_salida> [README.md]
// Salida: <carpeta>/nave-<año>.svg y nave-<año>-dark.svg desde el año en que se creó la cuenta.
// Si se pasa un README, reescribe lo que hay entre <!-- NAVE:INICIO --> y <!-- NAVE:FIN -->
// con una pestaña desplegable por año (la del año en curso abierta).
// Sin dependencias: usa la misma página pública que dibuja la cuadrícula del perfil.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , USER = process.env.GITHUB_REPOSITORY_OWNER, OUT = "dist", README] = process.argv;
const BRANCH = "output"; // rama donde el workflow publica los SVG
if (!USER) throw new Error("Falta el usuario: node nave.mjs <usuario> <carpeta>");

// Geometría
const CELL = 11, GAP = 3, STEP = CELL + GAP;
const LEFT = 34, TOP = 64, RIGHT = 14, SHIP_AREA = 38;
const GRID_BOTTOM = TOP + 7 * STEP - GAP;
const SHIP_Y = GRID_BOTTOM + 20; // centro de la nave
const MUZZLE_Y = SHIP_Y - 8;     // punta del cañón

// Ritmo base en segundos (luego se escala para que cada año dure entre MIN_T y MAX_T)
const MOVE_PER_COL = 0.06, MIN_MOVE = 0.12; // desplazamiento de la nave
const BULLET_SPEED = 520;                   // px/s
const FIRE_GAP = 0.16;                      // entre disparos seguidos
const AIM = 0.06;                           // pausa tras llegar a una columna
const BLAST = 0.7;                          // duración de la explosión
const MIN_T = 12, MAX_T = 40, MAX_SLOWDOWN = 2.2;
const INTRO = 1, OUTRO = 3;                 // quieta antes de empezar / pausa al final

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const DIAS = { 1: "Lun", 3: "Mié", 5: "Vie" };

// Paleta del portafolio (ver GITHUB_PROFILE_README.md del proyecto Portafolio):
// azul petróleo + lima en oscuro, oliva sobre blanco en claro.
const TEMAS = {
  light: {
    bg: "#ffffff", border: "#d9dee1",
    levels: ["#eef1f2", "#dfe8a0", "#a3b52a", "#7d8d12", "#66740c"],
    ship: "#13222c", shipGlow: "#a3b52a", bullet: "#66740c", flash: "#13222c",
    text: "#13222c", muted: "#5b6f7b", accent: "#66740c",
  },
  dark: {
    bg: "#13222c", border: "#284352",
    levels: ["#1e3442", "#46603a", "#87a043", "#c3d64a", "#dcec6b"],
    ship: "#dcec6b", shipGlow: "#f3efe4", bullet: "#f3efe4", flash: "#ffffff",
    text: "#eef1f2", muted: "#97a8b2", accent: "#dcec6b",
  },
};

async function get(url, as) {
  const res = await fetch(url, { headers: { "User-Agent": "contribution-ship" } });
  if (!res.ok) throw new Error(`${res.status} en ${url}`);
  return as === "json" ? res.json() : res.text();
}

// Devuelve [{date, level, count}] del año pedido.
async function contribuciones(year) {
  const html = await get(`https://github.com/users/${USER}/contributions?from=${year}-01-01&to=${year}-12-31`);
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = m[2].match(/^(\d[\d,]*) contribution/);
    counts.set(m[1], n ? Number(n[1].replace(/,/g, "")) : 0);
  }
  const days = [];
  for (const m of html.matchAll(/<td\b[^>]*\bdata-date="[^"]+"[^>]*>/g)) {
    const attr = (name) => m[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
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

const cx = (col) => LEFT + col * STEP + CELL / 2;
const px = (col) => LEFT + col * STEP;
const py = (row) => TOP + row * STEP;
const r2 = (n) => Math.round(n * 100) / 100;
const plural = (n) => `${n} ${n === 1 ? "contribución" : "contribuciones"}`;

// Aleatorio estable por cuadro: el SVG solo cambia si cambian los datos.
function rng(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

// Plan de la batalla: columnas de izquierda a derecha y, en cada una, de abajo hacia arriba,
// así la bala solo cruza cuadros vacíos o ya destruidos. Tiempos en segundos.
function plan(cells) {
  const targets = cells
    .filter((c) => c.count > 0 || c.level > 0)
    .sort((a, b) => a.col - b.col || b.row - a.row);
  const ship = [{ t: 0, x: cx(0) }];
  const shots = [];
  let t = 0, col = 0;
  for (const c of targets) {
    if (c.col !== col) {
      const move = Math.max(MIN_MOVE, Math.abs(c.col - col) * MOVE_PER_COL);
      ship.push({ t, x: cx(col) }, { t: t + move, x: cx(c.col) });
      t += move + AIM;
      col = c.col;
    }
    const fire = t;
    const hit = fire + (MUZZLE_Y - (py(c.row) + CELL / 2)) / BULLET_SPEED;
    shots.push({ cell: c, fire, hit });
    t += FIRE_GAP;
  }
  const end = shots.length ? shots.at(-1).hit + BLAST : 0;
  ship.push({ t: Math.max(t, end), x: cx(col) });
  return { targets, ship, shots, end };
}

function svg(year, cells, theme, enCurso) {
  const T = TEMAS[theme];
  const cols = Math.max(53, ...cells.map((c) => c.col + 1));
  const W = LEFT + cols * STEP - GAP + RIGHT;
  const H = GRID_BOTTOM + SHIP_AREA;
  const total = cells.reduce((s, c) => s + c.count, 0);
  const { ship, shots, end } = plan(cells);

  // Escala de tiempo: años con poca actividad van más lento, años llenos más rápido.
  const k = end > 0 ? Math.min(MAX_SLOWDOWN, Math.max(MIN_T, Math.min(MAX_T, end)) / end) : 1;
  const dur = r2(INTRO + end * k + OUTRO);
  const f = (sec) => Math.min(1, Math.max(0, Math.round(((INTRO + sec * k) / dur) * 1e5) / 1e5));
  const loop = `dur="${dur}s" repeatCount="indefinite"`;
  const eps = 1e-4;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Space Grotesk','Segoe UI',Helvetica,Arial,sans-serif">`,
    `<title>${year}: ${plural(total)}</title>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${T.bg}" stroke="${T.border}"/>`,
    `<text x="${LEFT}" y="26" font-size="16" font-weight="700" fill="${T.accent}">${year}<tspan fill="${T.muted}" font-weight="400" font-size="12">${enCurso ? "  · en curso" : ""}</tspan></text>`,
  );

  // Contador: un texto por valor, visible solo entre un impacto y el siguiente.
  const marks = [{ t: 0, n: 0 }];
  let acc = 0;
  for (const s of shots) { acc += s.cell.count; marks.push({ t: f(s.hit), n: acc }); }
  marks.forEach((m, i) => {
    const next = marks[i + 1]?.t ?? 1;
    let anim = "";
    if (i === 0 && next < 1) anim = `values="1;0" keyTimes="0;${next}"`;
    else if (i > 0) anim = next < 1 ? `values="0;1;0" keyTimes="0;${m.t};${next}"` : `values="0;1" keyTimes="0;${m.t}"`;
    out.push(
      `<text x="${W - RIGHT}" y="26" text-anchor="end" font-size="13" fill="${T.muted}" opacity="${i === 0 ? 1 : 0}">${m.n} / ${plural(total)}` +
        (anim ? `<animate attributeName="opacity" ${anim} calcMode="discrete" ${loop}/>` : "") + `</text>`,
    );
  });

  // Meses y días.
  const seen = new Set();
  for (const c of cells) {
    if (!seen.has(c.month) && new Date(c.date + "T00:00:00Z").getUTCDate() <= 7) {
      seen.add(c.month);
      out.push(`<text x="${px(c.col)}" y="${TOP - 8}" font-size="10" fill="${T.muted}">${MESES[c.month]}</text>`);
    }
  }
  for (const [row, name] of Object.entries(DIAS)) {
    out.push(`<text x="${LEFT - 6}" y="${py(row) + CELL - 2}" text-anchor="end" font-size="9" fill="${T.muted}">${name}</text>`);
  }

  // Cuadros: al recibir el disparo destellan y quedan vacíos.
  const hitAt = new Map(shots.map((s) => [s.cell.date, s]));
  for (const c of cells) {
    const fill = T.levels[c.level] ?? T.levels[0];
    const s = hitAt.get(c.date);
    const anim = s
      ? `<animate attributeName="fill" values="${fill};${T.flash};${T.levels[0]}" keyTimes="0;${f(s.hit)};${Math.min(1, f(s.hit + 0.08))}" calcMode="discrete" ${loop}/>`
      : "";
    out.push(`<rect x="${px(c.col)}" y="${py(c.row)}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}">${anim}</rect>`);
  }

  // Explosión de píxeles: el cuadro se parte en 3×3 píxeles que salen volando y se apagan.
  for (const s of shots) {
    const c = s.cell, fill = T.levels[c.level] ?? T.levels[0];
    const rand = rng(c.date);
    const t0 = f(s.hit), t1 = Math.min(1, f(s.hit + BLAST));
    out.push(
      `<g opacity="0"><animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;${Math.max(0, t0 - eps)};${t0};${t1};1" ${loop}/>`,
    );
    for (let i = 0; i < 9; i++) {
      const bx = i % 3, by = Math.floor(i / 3);
      const dx = r2((bx - 1) * (6 + rand() * 8) + (rand() - 0.5) * 6);
      const dy = r2((by - 1) * (6 + rand() * 8) - 6 - rand() * 8); // empujados hacia arriba por la bala
      const size = 3;
      const color = i === 4 ? T.flash : fill;
      out.push(
        `<rect x="${px(c.col) + bx * 4}" y="${py(c.row) + by * 4}" width="${size}" height="${size}" fill="${color}">` +
          `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;${dx} ${dy};${dx} ${dy}" keyTimes="0;${t0};${t1};1" ${loop}/></rect>`,
      );
    }
    out.push(`</g>`);
  }

  // Balas: aparecen en el cañón, suben y desaparecen al impactar.
  for (const s of shots) {
    const x = r2(cx(s.cell.col) - 1), yEnd = r2(py(s.cell.row) + CELL / 2 - 3);
    const a = f(s.fire), b = f(s.hit);
    out.push(
      `<rect x="${x}" y="${MUZZLE_Y - 6}" width="2" height="6" rx="1" fill="${T.bullet}" opacity="0">` +
        `<animate attributeName="opacity" values="0;1;0" keyTimes="0;${a};${b}" calcMode="discrete" ${loop}/>` +
        `<animate attributeName="y" values="${MUZZLE_Y - 6};${MUZZLE_Y - 6};${yEnd};${yEnd}" keyTimes="0;${a};${b};1" ${loop}/></rect>`,
    );
  }

  // Nave: se desliza bajo la columna y retrocede un poquito con cada disparo.
  const frames = []; // {t (fracción), x, y}
  for (const p of ship) frames.push({ t: f(p.t), x: p.x, y: 0 });
  const xAt = (t) => {
    let prev = frames[0];
    for (const fr of frames) { if (fr.t > t) return prev.x + ((fr.x - prev.x) * (t - prev.t)) / (fr.t - prev.t || 1); prev = fr; }
    return prev.x;
  };
  for (const s of shots) {
    const a = f(s.fire), b = f(s.fire + 0.07);
    frames.push({ t: a, x: xAt(a), y: 2 }, { t: b, x: xAt(b), y: 0 });
  }
  frames.push({ t: 0, x: cx(0), y: 0 }, { t: 1, x: frames.at(-1)?.x ?? cx(0), y: 0 });
  frames.sort((p, q) => p.t - q.t);
  const kf = [];
  for (const fr of frames) if (!kf.length || fr.t > kf.at(-1).t) kf.push(fr);
  kf[0].t = 0; kf.at(-1).t = 1;
  kf.at(-1).x = ship.at(-1).x;
  out.push(
    `<g transform="translate(${cx(0)} ${SHIP_Y})">` +
      (shots.length
        ? `<animateTransform attributeName="transform" type="translate" values="${kf.map((p) => `${r2(p.x)} ${SHIP_Y + p.y}`).join(";")}" keyTimes="${kf.map((p) => p.t).join(";")}" ${loop}/>`
        : "") +
      `<path d="M0,-9 L2,-4 L7,3 L7,6 L2,4 L0,6 L-2,4 L-7,6 L-7,3 L-2,-4 Z" fill="${T.ship}"/>` +
      `<rect x="-1.5" y="-2" width="3" height="4" rx="1" fill="${T.bg}"/>` +
      `<rect x="-1" y="6" width="2" height="3" rx="1" fill="${T.shipGlow}" opacity="0.8">` +
      `<animate attributeName="height" values="3;5;3" dur="0.3s" repeatCount="indefinite"/></rect>` +
      `</g>`,
  );

  if (!shots.length) {
    out.push(`<text x="${W / 2}" y="${py(3) + 4}" text-anchor="middle" font-size="12" fill="${T.muted}">Sin contribuciones este año</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

// ── Principal ────────────────────────────────────────────────────────────────
const created = (await get(`https://api.github.com/users/${USER}`, "json")).created_at;
const firstYear = new Date(created).getUTCFullYear();
const thisYear = new Date().getUTCFullYear();
await mkdir(OUT, { recursive: true });

const resumen = [];
for (let y = thisYear; y >= firstYear; y--) {
  const cells = cuadricula(await contribuciones(y), y);
  const total = cells.reduce((s, c) => s + c.count, 0);
  await writeFile(join(OUT, `nave-${y}.svg`), svg(y, cells, "light", y === thisYear));
  await writeFile(join(OUT, `nave-${y}-dark.svg`), svg(y, cells, "dark", y === thisYear));
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
    `      <source media="(prefers-color-scheme: dark)" srcset="${base}/nave-${year}-dark.svg" />`,
    `      <source media="(prefers-color-scheme: light)" srcset="${base}/nave-${year}.svg" />`,
    `      <img alt="Nave destruyendo mis contribuciones de ${year}" src="${base}/nave-${year}-dark.svg" width="100%" />`,
    `    </picture>`,
    `  </p>`,
    `</details>`,
  ].join("\n")).join("\n\n");
  const md = await readFile(README, "utf8");
  const re = /(<!-- NAVE:INICIO[^>]*-->)[\s\S]*?(<!-- NAVE:FIN -->)/;
  if (!re.test(md)) throw new Error("El README no tiene los marcadores NAVE:INICIO / NAVE:FIN");
  await writeFile(README, md.replace(re, (_, a, b) => `${a}\n${bloque}\n${b}`));
  console.log("README actualizado");
}
