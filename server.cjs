// server.cjs ✅ Express + RUNTIME_DIR + mutool + qpdf + IA + autocorrección retiros/depositos
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const pdfParse = require("pdf-parse");
const { spawn } = require("child_process");
const os = require("os");

// Electron app (para userData)
let electronApp = null;
try {
  ({ app: electronApp } = require("electron"));
} catch {}

// --------- seguridad de logs ----------
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));

// --------- fetch fallback ----------
const fetchFn =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

// -----------------------------------------------------
// ✅ Cargar key desde DEV (.env) o PROD (config.json)
// -----------------------------------------------------
function getUserDataPathSafe() {
  try {
    if (electronApp && typeof electronApp.getPath === "function") {
      return electronApp.getPath("userData");
    }
  } catch {}
  return null;
}

function tryLoadDotenvFrom(p) {
  try {
    if (p && fs.existsSync(p)) {
      dotenv.config({ path: p });
      console.log("[env] ✅ .env cargado desde:", p);
      return true;
    }
  } catch {}
  return false;
}

function tryLoadKeyFromConfigJson() {
  const userData = getUserDataPathSafe();
  if (!userData) return false;

  const cfgPath = path.join(userData, "config.json");
  try {
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const key = String(cfg?.OPENAI_API_KEY || "").trim();
    if (key) {
      process.env.OPENAI_API_KEY = key;
      console.log("[env] ✅ OPENAI_API_KEY cargada desde config.json");
      return true;
    }
  } catch (e) {
    console.warn("[env] ⚠️ No pude leer config.json:", e?.message || e);
  }
  return false;
}

function loadRuntimeSecrets() {
  // 1) si ya viene por env (main.js), listo
  if (process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()) return;

  // 2) DEV: .env junto al server
  tryLoadDotenvFrom(path.join(__dirname, ".env"));

  // 3) PROD: userData/config.json
  if (!process.env.OPENAI_API_KEY) tryLoadKeyFromConfigJson();

  // 4) fallback opcional: userData/.env
  if (!process.env.OPENAI_API_KEY) {
    const userData = getUserDataPathSafe();
    if (userData) tryLoadDotenvFrom(path.join(userData, ".env"));
  }
}
loadRuntimeSecrets();

// -----------------------------------------------------
const app = express();

// =====================================================
// Paths seguros (Electron) ✅ NO app.asar
// =====================================================
const BASE_DIR =
  process.env.RUNTIME_DIR ||
  (getUserDataPathSafe()
    ? path.join(getUserDataPathSafe(), "runtime")
    : path.join(process.cwd(), "runtime"));

const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const TMP_DIR = path.join(BASE_DIR, "tmp");
const PUBLIC_DIR = path.join(__dirname, "public");

for (const dir of [UPLOAD_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

// =====================================================
// Middleware
// =====================================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// =====================================================
// Multer
// =====================================================
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      String(file.originalname || "").toLowerCase().endsWith(".pdf");
    cb(ok ? null : new Error("Solo se permite PDF"), ok);
  },
});

// =====================================================
// Helpers
// =====================================================
function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function safeNumber(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return Number.isFinite(x) ? x : 0;

  let s = String(x).replace(/\$/g, "").replace(/\s/g, "").trim();
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  s = s.replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeMovimientos(result) {
  return (result?.movimientos || []).map((m) => ({
    fecha: String(m.fecha || "").trim(),
    concepto: String(m.concepto || "").trim(),
    retiros: safeNumber(m.retiros),
    depositos: safeNumber(m.depositos),
    saldo: safeNumber(m.saldo),
  }));
}

function dedupeMovimientos(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = [
      (r.fecha || "").trim(),
      (r.concepto || "").trim().toLowerCase(),
      String(r.retiros ?? 0),
      String(r.depositos ?? 0),
      String(r.saldo ?? 0),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// =====================================================
// ✅ Post-proceso inteligente (evita swap Retiros/Depósitos)
// =====================================================
function near(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol;
}

function clampMoney(n) {
  n = safeNumber(n);
  return n < 0 ? Math.abs(n) : n;
}

function scoreSwapNeed(rows) {
  let good = 0;
  let swappedWouldBeGood = 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];

    const s0 = safeNumber(prev.saldo);
    const s1 = safeNumber(cur.saldo);
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;

    const delta = s1 - s0;

    const r = clampMoney(cur.retiros);
    const d = clampMoney(cur.depositos);

    const expected = d - r;
    const expectedSwap = r - d;

    if (near(delta, expected, 0.5)) good++;
    if (near(delta, expectedSwap, 0.5)) swappedWouldBeGood++;
  }

  return { good, swappedWouldBeGood };
}

function fixRowBySaldo(prevSaldo, row) {
  const curSaldo = safeNumber(row.saldo);
  if (!Number.isFinite(prevSaldo) || !Number.isFinite(curSaldo)) return row;

  const delta = curSaldo - prevSaldo;

  const r = clampMoney(row.retiros);
  const d = clampMoney(row.depositos);

  if (r > 0 && d > 0) {
    if (delta > 0) {
      row.retiros = 0;
      row.depositos = Math.max(r, d);
    } else if (delta < 0) {
      row.depositos = 0;
      row.retiros = Math.max(r, d);
    }
    return row;
  }

  if (delta > 0 && r > 0 && d === 0) {
    row.depositos = r;
    row.retiros = 0;
  }

  if (delta < 0 && d > 0 && r === 0) {
    row.retiros = d;
    row.depositos = 0;
  }

  return row;
}

function postProcessMovimientos(movs) {
  const rows = movs.map((m) => ({
    ...m,
    retiros: clampMoney(m.retiros),
    depositos: clampMoney(m.depositos),
    saldo: clampMoney(m.saldo),
  }));

  const { good, swappedWouldBeGood } = scoreSwapNeed(rows);
  const doGlobalSwap = swappedWouldBeGood >= good + 3 && swappedWouldBeGood >= 5;

  if (doGlobalSwap) {
    for (const r of rows) {
      const tmp = r.retiros;
      r.retiros = r.depositos;
      r.depositos = tmp;
    }
  }

  for (let i = 1; i < rows.length; i++) {
    rows[i] = fixRowBySaldo(safeNumber(rows[i - 1].saldo), rows[i]);
  }

  for (const r of rows) {
    if (r.retiros > 0 && r.depositos > 0) {
      if (r.retiros >= r.depositos) r.depositos = 0;
      else r.retiros = 0;
    }
  }

  return rows;
}

// =====================================================
// BIN paths (dev vs packaged)
// =====================================================
function getBinPath(exeNameWin, exeNameUnix) {
  const exe = os.platform() === "win32" ? exeNameWin : exeNameUnix;
  const isPackaged = process.env.ELECTRON_IS_PACKAGED === "1";
  if (!isPackaged) return path.join(__dirname, "bin", exe);
  return path.join(process.resourcesPath, "bin", exe);
}

function getMutoolPath() {
  return getBinPath("mutool.exe", "mutool");
}
function getQpdfPath() {
  return getBinPath("qpdf.exe", "qpdf");
}

// =====================================================
// mutool: PDF -> PNG
// =====================================================
function renderWithMutool(pdfPath, page, outPng, dpi = 220) {
  return new Promise((resolve, reject) => {
    const mutool = getMutoolPath();
    if (!fs.existsSync(mutool)) return reject(new Error(`No encuentro mutool en: ${mutool}`));

    const args = ["draw", "-o", outPng, "-r", String(dpi), "-F", "png", pdfPath, String(page)];
    const p = spawn(mutool, args, { windowsHide: true });

    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPng)) return resolve(outPng);
      reject(new Error(`mutool falló (page ${page}). ${err}`.trim()));
    });
  });
}

async function renderPagesToImages(pdfPath, pages, { savePath, saveFilename, density }) {
  const out = [];
  for (const p of pages) {
    const outPng = path.join(savePath, `${saveFilename}-${p}.png`);
    const ok = await renderWithMutool(pdfPath, p, outPng, density || 220);
    out.push(ok);
  }
  return out;
}

// =====================================================
// qpdf decrypt (PDF protegido)
// =====================================================
function decryptPdfWithQpdf(inputPath, password, outPath) {
  return new Promise((resolve, reject) => {
    const qpdf = getQpdfPath();
    if (!fs.existsSync(qpdf)) return reject(new Error(`No encuentro qpdf en: ${qpdf}`));

    const pass = String(password ?? "").replace(/\r?\n/g, "").trim();
    const passFile = path.join(TMP_DIR, `qpdf-pass-${Date.now()}.txt`);
    fs.writeFileSync(passFile, pass, "utf8");

    const args = ["--password-file", passFile, "--decrypt", inputPath, outPath];
    const p = spawn(qpdf, args, { windowsHide: true });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      try { fs.unlinkSync(passFile); } catch {}

      if (code === 0 && fs.existsSync(outPath)) return resolve(outPath);

      const raw = (stderr || "").trim();
      const low = raw.toLowerCase();

      if (low.includes("invalid password") || low.includes("bad password")) {
        return reject(new Error("Password incorrecto (qpdf). Ojo: distingue mayúsculas/espacios."));
      }
      if (low.includes("not encrypted") || low.includes("unencrypted")) {
        return reject(new Error("El PDF NO estaba encriptado (qpdf)."));
      }
      reject(new Error(`No se pudo desencriptar con qpdf: ${raw || "sin detalle"}`));
    });
  });
}

async function isPdfEncrypted(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    await pdfParse(buf);
    return false;
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    return msg.includes("password") || msg.includes("encrypted") || msg.includes("security");
  }
}

// =====================================================
// OpenAI Responses API (strict JSON schema)
// =====================================================
function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      const t =
        (typeof part?.text === "string" && part.text) ||
        (typeof part?.output_text === "string" && part.output_text) ||
        "";
      if (t) chunks.push(t);
    }
  }
  return chunks.join("");
}

function tryParseJsonLoose(outText) {
  const s = outText.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return JSON.parse(s.slice(first, last + 1));
  }
  return JSON.parse(s);
}

async function openaiStructured({ content, schema, model = "gpt-5-mini" }) {
  if (!process.env.OPENAI_API_KEY) {
    const userData = getUserDataPathSafe();
    throw new Error(
      `Falta OPENAI_API_KEY. Ábre Config y pégala. (${userData ? path.join(userData, "config.json") : "sin userData"})`
    );
  }

  const payload = {
    model,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: schema.name,
        schema: schema.schema,
        strict: true,
      },
    },
  };

  const resp = await fetchFn("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error: ${errText}`);
  }

  const data = await resp.json();
  if (data.output_parsed) return data.output_parsed;

  const outText = extractOutputText(data).trim();
  return tryParseJsonLoose(outText);
}

// =====================================================
// Schemas
// =====================================================
function schemaMovimientos() {
  return {
    name: "estado_cuenta",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        movimientos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              fecha: { type: "string" },
              concepto: { type: "string" },
              retiros: { type: "number" },
              depositos: { type: "number" },
              saldo: { type: "number" },
            },
            required: ["fecha", "concepto", "retiros", "depositos", "saldo"],
          },
        },
      },
      required: ["movimientos"],
    },
  };
}

function schemaPages() {
  return {
    name: "paginas_movimientos",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pages: { type: "array", items: { type: "integer" } },
      },
      required: ["pages"],
    },
  };
}

function buildVisionImagesContent(imagePaths, extraText) {
  return [
    { type: "input_text", text: extraText },
    ...imagePaths.map((p) => ({
      type: "input_image",
      image_url: `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`,
    })),
  ];
}

// =====================================================
// Detect pages + extract
// =====================================================
async function detectTransactionPages(pdfPath, pageCount) {
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const batchSize = 6;
  const found = new Set();

  for (let i = 0; i < pages.length; i += batchSize) {
    const chunk = pages.slice(i, i + batchSize);

    const imgs = await renderPagesToImages(pdfPath, chunk, {
      savePath: TMP_DIR,
      saveFilename: "thumb",
      density: 140,
    });

    try {
      const schema = schemaPages();
      const content = buildVisionImagesContent(
        imgs,
        `Identifica cuáles páginas contienen una TABLA de movimientos bancarios
(con columnas tipo FECHA, CONCEPTO/DESCRIPCIÓN, RETIROS/CARGOS, DEPÓSITOS/ABONOS, SALDO).
Devuelve SOLO JSON con "pages": [números de página] usando los números REALES:
${chunk.join(", ")}`
      );

      const res = await openaiStructured({ content, schema });
      for (const p of res.pages || []) {
        if (Number.isInteger(p) && p >= 1 && p <= pageCount) found.add(p);
      }
    } finally {
      for (const p of imgs) cleanupFile(p);
    }
  }

  return Array.from(found).sort((a, b) => a - b);
}

async function extractMovimientosFromPages(pdfPath, pages) {
  const schema = schemaMovimientos();
  const groupSize = 2;
  let all = [];

  for (let i = 0; i < pages.length; i += groupSize) {
    const chunk = pages.slice(i, i + groupSize);

    const imgs = await renderPagesToImages(pdfPath, chunk, {
      savePath: TMP_DIR,
      saveFilename: "page",
      density: 260,
    });

    try {
      const content = buildVisionImagesContent(
        imgs,
        `Extrae la tabla de MOVIMIENTOS.
Reglas:
- Devuelve SOLO JSON del schema.
- Si falta un valor: 0.
- Cargo=retiros, Abono=depositos.
- NO inventes filas.`
      );

      const result = await openaiStructured({ content, schema });
      all = all.concat(normalizeMovimientos(result));
    } finally {
      for (const p of imgs) cleanupFile(p);
    }
  }

  return dedupeMovimientos(all);
}

// =====================================================
// Endpoint principal
// =====================================================
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  const uploadedPath = req.file?.path;
  let workingPdfPath = uploadedPath;

  try {
    // recargar secrets por si se guardó key hace segundos
    loadRuntimeSecrets();

    if (!req.file) return res.status(400).json({ ok: false, error: "No llegó archivo PDF." });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "Falta OPENAI_API_KEY. Abre Configuración y pégala.",
      });
    }

    const password = String(req.body?.password || "").replace(/\r?\n/g, "").trim();

    console.log("mutoolPath =", getMutoolPath());
    console.log("qpdfPath =", getQpdfPath());
    console.log("TMP_DIR =", TMP_DIR);

    const encrypted = await isPdfEncrypted(uploadedPath);

    if (encrypted) {
      if (!password) {
        return res.status(401).json({
          ok: false,
          error: "Este PDF está protegido. Escribe el password para procesarlo.",
        });
      }
      const decryptedPath = path.join(TMP_DIR, `decrypted-${Date.now()}.pdf`);
      workingPdfPath = await decryptPdfWithQpdf(uploadedPath, password, decryptedPath);
    }

    const buf = fs.readFileSync(workingPdfPath);
    const parsed = await pdfParse(buf);
    const pageCount = Number(parsed?.numpages || 0) || 0;
    if (!pageCount) throw new Error("No pude leer el número de páginas del PDF.");

    let pages = await detectTransactionPages(workingPdfPath, pageCount);
    if (!pages.length) pages = Array.from({ length: Math.min(6, pageCount) }, (_, i) => i + 1);

    let movimientos = await extractMovimientosFromPages(workingPdfPath, pages);
    movimientos = postProcessMovimientos(movimientos);

    return res.json({
      ok: true,
      encrypted,
      pages_detected: pages,
      movimientos,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "No se pudo procesar el PDF" });
  } finally {
    cleanupFile(uploadedPath);
    if (workingPdfPath && workingPdfPath !== uploadedPath) cleanupFile(workingPdfPath);
  }
});

// =====================================================
// start/stop (Electron)
// =====================================================
let serverInstance = null;

function startServer(port = process.env.PORT || 3000) {
  return new Promise((resolve, reject) => {
    try {
      if (serverInstance) return resolve(port);

      serverInstance = app.listen(port, () => {
        console.log("[server] ✅ running on", port);
        resolve(port);
      });

      serverInstance.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverInstance) return resolve();
    serverInstance.close(() => resolve());
  });
}

module.exports = { startServer, stopServer };
