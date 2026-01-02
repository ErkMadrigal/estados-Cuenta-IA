const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("tbody");
const exportBtn = document.getElementById("exportBtn");
const modeBadge = document.getElementById("modeBadge");
const searchInput = document.getElementById("searchInput");

const loadingOverlay = document.getElementById("loadingOverlay");
const offlineBanner = document.getElementById("offlineBanner");

let lastRows = [];
let filteredRows = [];
let isProcessing = false;

function money(n) {
  const num = Number(n || 0);
  return num.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(msg, kind = "info") {
  const map = { info: "text-slate-300", ok: "text-emerald-400", err: "text-rose-400" };
  statusEl.className = `mt-4 text-sm ${map[kind] || map.info}`;
  statusEl.textContent = msg;
}

function setProcessing(state) {
  isProcessing = state;
  loadingOverlay.classList.toggle("hidden", !state);

  // Bloquea interacción con dropzone durante procesamiento
  dropzone.classList.toggle("opacity-60", state);
  dropzone.classList.toggle("pointer-events-none", state);

  if (state) setStatus("Procesando… no cierres la página ni el navegador.", "info");
}

// Evitar que cierre si está procesando
window.addEventListener("beforeunload", (e) => {
  if (!isProcessing) return;
  e.preventDefault();
  e.returnValue = "";
});

// Offline/online alerts
function updateOnlineState() {
  const online = navigator.onLine;
  offlineBanner.classList.toggle("hidden", online);

  if (!online) {
    setStatus("⚠️ Sin conexión a internet. Vuelve a conectarte para continuar.", "err");
  } else {
    if (!isProcessing && lastRows.length) setStatus("Conectado ✅", "ok");
  }
}
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
updateOnlineState();

// Render
function render(rows) {
  filteredRows = rows || [];

  tbody.innerHTML = filteredRows.map(r => `
    <tr class="hover:bg-slate-900/60">
      <td class="p-3 whitespace-nowrap">${escapeHTML(r.fecha)}</td>
      <td class="p-3 min-w-[360px]">${escapeHTML(r.concepto)}</td>
      <td class="p-3 whitespace-nowrap">${money(r.retiros)}</td>
      <td class="p-3 whitespace-nowrap">${money(r.depositos)}</td>
      <td class="p-3 whitespace-nowrap">${money(r.saldo)}</td>
    </tr>
  `).join("");

  exportBtn.classList.toggle("hidden", filteredRows.length === 0);
}

// CSV export (exporta lo filtrado si hay búsqueda)
function toCSV(rows) {
  const header = ["fecha","concepto","retiros","depositos","saldo"];
  const esc = (s) => `"${String(s ?? "").replaceAll(`"`, `""`)}"`;
  const lines = [
    header.join(","),
    ...rows.map(r => [r.fecha, r.concepto, r.retiros, r.depositos, r.saldo].map(esc).join(","))
  ];
  return lines.join("\n");
}

exportBtn.addEventListener("click", () => {
  const rowsToExport = (searchInput.value.trim() ? filteredRows : lastRows);
  const csv = toCSV(rowsToExport);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "movimientos.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// Buscador
function applySearch() {
  const q = (searchInput.value || "").trim().toLowerCase();
  if (!q) {
    render(lastRows);
    return;
  }

  const match = (r) => {
    const s = [
      r.fecha,
      r.concepto,
      String(r.retiros ?? ""),
      String(r.depositos ?? ""),
      String(r.saldo ?? "")
    ].join(" ").toLowerCase();
    return s.includes(q);
  };

  render(lastRows.filter(match));
}
searchInput.addEventListener("input", applySearch);

// Upload
async function uploadPDF(file) {
  if (!navigator.onLine) {
    offlineBanner.classList.remove("hidden");
    setStatus("⚠️ No tienes internet. Conéctate y vuelve a intentar.", "err");
    return;
  }

  setProcessing(true);
  render([]);
  modeBadge.classList.add("hidden");

  try {
    const fd = new FormData();
    fd.append("pdf", file);

    const res = await fetch("/api/upload", { method: "POST", body: fd });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data.ok) throw new Error(data.error || "Error");

    modeBadge.textContent = `modo: ${data.modo}`;
    modeBadge.classList.remove("hidden");

    lastRows = data.movimientos || [];
    searchInput.value = "";
    render(lastRows);

    setStatus(`Listo ✅ (${data.modo}). Filas: ${lastRows.length}`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(`❌ ${err.message || "Error"}`, "err");
  } finally {
    setProcessing(false);
  }
}

dropzone.addEventListener("click", () => {
  if (isProcessing) return;
  fileInput.click();
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (isProcessing) return;
  dropzone.classList.add("ring-2", "ring-emerald-500/60");
});
dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("ring-2", "ring-emerald-500/60");
});
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("ring-2", "ring-emerald-500/60");
  if (isProcessing) return;

  const file = e.dataTransfer.files?.[0];
  if (file) uploadPDF(file);
});

fileInput.addEventListener("change", () => {
  if (isProcessing) return;
  const file = fileInput.files?.[0];
  if (file) uploadPDF(file);
});
