// public/app.js
let selectedFile = null;
let movimientos = [];
let filtered = [];

// DOM
const fileInput = document.getElementById("fileInput");
const btnPick = document.getElementById("btnPick");
const btnUpload = document.getElementById("btnUpload");
const btnExport = document.getElementById("btnExport");
const btnClear = document.getElementById("btnClear");

const fileName = document.getElementById("fileName");
const statusEl = document.getElementById("status");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");

const pdfPassword = document.getElementById("pdfPassword");
const searchInput = document.getElementById("searchInput");
const tableBody = document.getElementById("tableBody");
const rowCount = document.getElementById("rowCount");

const offlineBanner = document.getElementById("offlineBanner");

// -------------------------
// UI helpers
// -------------------------
function setStatus(msg, type = "info") {
  statusEl.textContent = msg;

  statusEl.classList.remove(
    "border-slate-800",
    "border-emerald-600",
    "border-red-600",
    "border-amber-500"
  );

  if (type === "ok") statusEl.classList.add("border-emerald-600");
  else if (type === "error") statusEl.classList.add("border-red-600");
  else if (type === "warn") statusEl.classList.add("border-amber-500");
  else statusEl.classList.add("border-slate-800");
}

function setLoading(isLoading, text = "No cierres la app ni el navegador.") {
  loadingText.textContent = text;
  loadingOverlay.classList.toggle("hidden", !isLoading);

  // bloquear interacción
  document.body.style.pointerEvents = isLoading ? "none" : "auto";
  loadingOverlay.style.pointerEvents = "auto";
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtMoney(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTable(rows) {
  tableBody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-900/40 transition";

    tr.innerHTML = `
      <td class="px-4 py-3 whitespace-nowrap text-slate-200">${escapeHtml(r.fecha)}</td>
      <td class="px-4 py-3 text-slate-100">${escapeHtml(r.concepto)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-slate-200">${fmtMoney(r.retiros)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-slate-200">${fmtMoney(r.depositos)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-slate-200">${fmtMoney(r.saldo)}</td>
    `;
    tableBody.appendChild(tr);
  }

  rowCount.textContent = String(rows.length);
  btnExport.disabled = rows.length === 0;
}

function applyFilter() {
  const q = (searchInput.value || "").trim().toLowerCase();
  if (!q) {
    filtered = movimientos.slice();
  } else {
    filtered = movimientos.filter((r) => {
      const s = `${r.fecha} ${r.concepto} ${r.retiros} ${r.depositos} ${r.saldo}`.toLowerCase();
      return s.includes(q);
    });
  }
  renderTable(filtered);
}

function downloadCSV(rows) {
  const header = ["fecha", "concepto", "retiros", "depositos", "saldo"];
  const lines = [header.join(",")];

  for (const r of rows) {
    const line = [
      `"${String(r.fecha || "").replaceAll('"', '""')}"`,
      `"${String(r.concepto || "").replaceAll('"', '""')}"`,
      Number(r.retiros || 0),
      Number(r.depositos || 0),
      Number(r.saldo || 0),
    ].join(",");
    lines.push(line);
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "movimientos.csv";
  a.click();

  URL.revokeObjectURL(url);
}

// -------------------------
// Network status
// -------------------------
function updateOnlineStatus() {
  const offline = !navigator.onLine;
  offlineBanner.classList.toggle("hidden", !offline);

  if (offline) {
    setStatus("⚠️ Sin internet. No se puede procesar IA.", "warn");
  }
}

window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);
updateOnlineStatus();

// Evitar cerrar durante proceso
window.addEventListener("beforeunload", (e) => {
  if (!loadingOverlay.classList.contains("hidden")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// -------------------------
// Events
// -------------------------
btnPick.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] || null;
  if (!selectedFile) {
    fileName.textContent = "No has seleccionado nada";
    btnUpload.disabled = true;
    return;
  }

  fileName.textContent = selectedFile.name;
  btnUpload.disabled = false;
  setStatus("Listo ✅ (archivo seleccionado).", "ok");
});

btnClear.addEventListener("click", () => {
  selectedFile = null;
  fileInput.value = "";
  fileName.textContent = "No has seleccionado nada";
  movimientos = [];
  filtered = [];
  searchInput.value = "";
  renderTable([]);
  btnUpload.disabled = true;
  btnExport.disabled = true;
  setStatus("Listo.", "info");
});

searchInput.addEventListener("input", applyFilter);

btnExport.addEventListener("click", () => {
  downloadCSV(filtered.length ? filtered : movimientos);
});

// -------------------------
// Upload & process
// -------------------------
btnUpload.addEventListener("click", async () => {
  if (!selectedFile) return;

  if (!navigator.onLine) {
    alert("Sin internet. Conéctate para poder procesar.");
    setStatus("⚠️ Sin internet.", "warn");
    return;
  }

  setLoading(true, "Subiendo PDF y procesando…");
  setStatus("Procesando…", "info");

  try {
    const formData = new FormData();
    formData.append("pdf", selectedFile);

    const pass = (pdfPassword.value || "").trim();
    formData.append("password", pass);

    const resp = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = await resp.json().catch(() => ({}));

    // PDF protegido
    if (resp.status === 401) {
      setLoading(false);
      setStatus(data?.error || "PDF protegido. Escribe el password y reintenta.", "warn");
      pdfPassword.focus();
      return;
    }

    if (!resp.ok) {
      throw new Error(data?.error || "Error procesando PDF.");
    }

    movimientos = Array.isArray(data.movimientos) ? data.movimientos : [];
    filtered = movimientos.slice();
    applyFilter();

    setLoading(false);

    const modo = data?.modo ? String(data.modo) : "vision";
    setStatus(`Listo ✅ (${modo}). Filas: ${movimientos.length}`, movimientos.length ? "ok" : "warn");

    // Tip si salió vacío
    if (movimientos.length === 0) {
      alert(
        "Se procesó pero salió 0 filas.\n\n" +
        "Causas comunes:\n" +
        "• El PDF es escaneado muy borroso\n" +
        "• El PDF está protegido y falta/está mal el password\n" +
        "• En Electron el server no puede escribir en tmp/uploads (permisos)\n\n" +
        "Si estás en Electron: aplica el fix de RUNTIME_DIR (AppData) en main/server."
      );
    }
  } catch (err) {
    setLoading(false);
    setStatus(`❌ ${err.message}`, "error");
    alert(err.message);
  }
});
