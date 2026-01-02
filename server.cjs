// server.cjs ✅ Express backend (para Electron) + rutas seguras + startServer()
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const pdfParse = require("pdf-parse");
const { fromPath: pdf2picFromPath } = require("pdf2pic");

dotenv.config();

const app = express();

// -----------------------------
// Paths seguros (Electron + pkg)
// -----------------------------
const IS_PKG = typeof process.pkg !== "undefined";
// Nota: En Electron, process.execPath apunta a electron.exe, pero sirve para ubicar un base dir.
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;

// Carpetas runtime
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const TMP_DIR = path.join(BASE_DIR, "tmp");

// Front incluido
const PUBLIC_DIR = path.join(__dirname, "public");

// Crear folders si no existen
for (const dir of [UPLOAD_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// -----------------------------
// Middleware
// -----------------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// CORS simple (si un día separas)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -----------------------------
// Multer
// -----------------------------
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

// -----------------------------
// Helpers
// -----------------------------
function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function safeNumber(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return Number.isFinite(x) ? x : 0;

  let s = String(x).replace(/\$/g, "").replace(/\s/g, "").trim();

  // "1.234,56" => 1234.56
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // "1,234.56" => 1234.56
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

function isScannedLike(text, fileSizeBytes) {
  const t = (text || "").trim();
  if (!t) return true;

  const len = t.length;
  const letters = (t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  const digits = (t.match(/[0-9]/g) || []).length;
  const printableRatio = (letters + digits) / Math.max(1, len);
  const bigPdf = fileSizeBytes > 1.5 * 1024 * 1024;
  const dateCount =
    (t.match(
      /\b(20\d{2}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]20\d{2})\b/g
    ) || []).length;

  return len < 800 || (bigPdf && len < 3000) || printableRatio < 0.25 || dateCount < 3;
}

// -----------------------------
// OpenAI Responses API (strict JSON schema)
// -----------------------------
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
    throw new Error("Falta OPENAI_API_KEY en .env");
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

  const resp = await fetch("https://api.openai.com/v1/responses", {
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

// -----------------------------
// Schemas
// -----------------------------
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

// -----------------------------
// PDF -> Images helpers
// -----------------------------
async function renderPagesToImages(pdfPath, pages, opts) {
  const converter = pdf2picFromPath(pdfPath, opts);
  const imagePaths = [];

  for (const p of pages) {
    try {
      const res = await converter(p);
      if (res?.path) imagePaths.push(res.path);
    } catch {}
  }
  return imagePaths;
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

async function detectTransactionPages(pdfPath, pageCount) {
  const lowOpts = {
    density: 90,
    saveFilename: "thumb",
    savePath: TMP_DIR,
    format: "png",
    width: 800,
    height: 1100,
  };

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const batchSize = 6;
  const found = new Set();

  for (let i = 0; i < pages.length; i += batchSize) {
    const chunk = pages.slice(i, i + batchSize);
    const imgs = await renderPagesToImages(pdfPath, chunk, lowOpts);
    if (!imgs.length) continue;

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
  const highOpts = {
    density: 280,
    saveFilename: "page",
    savePath: TMP_DIR,
    format: "png",
    width: 1700,
    height: 2200,
  };

  const schema = schemaMovimientos();
  const groupSize = 2;
  let all = [];

  for (let i = 0; i < pages.length; i += groupSize) {
    const chunk = pages.slice(i, i + groupSize);
    const imgs = await renderPagesToImages(pdfPath, chunk, highOpts);
    if (!imgs.length) continue;

    try {
      const content = buildVisionImagesContent(
        imgs,
        `Extrae la tabla de MOVIMIENTOS.
Reglas:
- Devuelve SOLO JSON del schema.
- Ignora anotaciones manuscritas.
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

// -----------------------------
// Endpoints
// -----------------------------
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No llegó archivo PDF." });

    const fileSize = req.file.size || 0;

    const buffer = fs.readFileSync(uploadedPath);
    const parsed = await pdfParse(buffer);
    const text = (parsed?.text || "").trim();
    const scanned = isScannedLike(text, fileSize);

    const pageCount = Number(parsed?.numpages || 0) || 0;

    let pages = [];
    if (pageCount > 0) pages = await detectTransactionPages(uploadedPath, pageCount);
    if (!pages.length) pages = [1, 2, 3, 4, 5, 6];

    const movimientos = await extractMovimientosFromPages(uploadedPath, pages);

    return res.json({
      ok: true,
      modo: scanned ? "vision_scanned" : "vision",
      pages_detected: pages,
      movimientos,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error procesando PDF" });
  } finally {
    cleanupFile(uploadedPath);
  }
});

// Para cerrar server desde Electron
let serverInstance = null;

function startServer(port = process.env.PORT || 3000) {
  return new Promise((resolve, reject) => {
    try {
      if (serverInstance) return resolve(port);

      serverInstance = app.listen(port, () => resolve(port));
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
