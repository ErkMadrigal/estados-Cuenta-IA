// public/app.js ✅ completo (tabla + config + upload + export XLSX) + FIX Failed to fetch

// -------------------------
// DOM
// -------------------------
const btnPick = document.getElementById("btnPick");
const btnUpload = document.getElementById("btnUpload");
const pdfInput = document.getElementById("pdfInput");
const passwordInput = document.getElementById("passwordInput");
const fileName = document.getElementById("fileName");
const statusBox = document.getElementById("statusBox");
const loadingOverlay = document.getElementById("loadingOverlay");

// Result UI
const tableWrap = document.getElementById("tableWrap");
const movCount = document.getElementById("movCount");
const btnToggleRaw = document.getElementById("btnToggleRaw");
const rawBox = document.getElementById("rawBox");

// Export
const btnExportXlsx = document.getElementById("btnExportXlsx");
let lastMovimientos = [];

// Config modal
const btnConfig = document.getElementById("btnConfig");
const configModal = document.getElementById("configModal");
const btnConfigClose = document.getElementById("btnConfigClose");
const apiKeyInput = document.getElementById("apiKeyInput");
const btnSaveKey = document.getElementById("btnSaveKey");
const btnShowKey = document.getElementById("btnShowKey");
const btnOpenConfigFolder = document.getElementById("btnOpenConfigFolder");
const configMsg = document.getElementById("configMsg");

// -------------------------
// helpers UI
// -------------------------
function setLoading(v) {
  if (!loadingOverlay) return;
  loadingOverlay.classList.toggle("hidden", !v);
}

function setStatus(text, type = "info") {
  statusBox.textContent = text;
  const base = "rounded-2xl border bg-black/30 p-4 text-sm ";
  if (type === "error") statusBox.className = base + "border-red-900/60 text-red-300";
  else if (type === "ok") statusBox.className = base + "border-emerald-900/60 text-emerald-300";
  else if (type === "warn") statusBox.className = base + "border-yellow-900/60 text-yellow-200";
  else statusBox.className = base + "border-slate-800 text-slate-300";
}

function hasNative() {
  return typeof window !== "undefined" && window.native;
}

function money(n) {
  const x = Number(n || 0);
  try {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(x);
  } catch {
    return String(x.toFixed(2));
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// -------------------------
// ✅ URL backend REAL (evita Failed to fetch)
// -------------------------
async function getUploadUrl() {
  // Electron: usar puerto real
  if (hasNative()) {
    const r = await window.native.getPort().catch(() => null);
    const port = r?.ok ? r.port : null;
    if (port) return `http://127.0.0.1:${port}/api/upload`;
  }
  // fallback navegador
  return new URL("/api/upload", window.location.origin).toString();
}

// -------------------------
// Tabla render
// -------------------------
function renderTable(movs = []) {
  if (!tableWrap) return;

  movCount.textContent = String(movs.length || 0);

  if (btnExportXlsx) btnExportXlsx.disabled = !(movs && movs.length);

  if (!movs.length) {
    tableWrap.innerHTML = `<div class="text-slate-400 text-sm">Sin movimientos.</div>`;
    return;
  }

  tableWrap.innerHTML = `
    <table class="min-w-full text-sm">
      <thead class="sticky top-0 bg-slate-950/90 backdrop-blur border-b border-slate-800">
        <tr class="text-slate-300">
          <th class="text-left py-2 px-2 w-[110px]">Fecha</th>
          <th class="text-left py-2 px-2">Concepto</th>
          <th class="text-right py-2 px-2 w-[140px]">Retiros</th>
          <th class="text-right py-2 px-2 w-[140px]">Depósitos</th>
          <th class="text-right py-2 px-2 w-[140px]">Saldo</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-800/60">
        ${movs
          .map((m) => {
            const r = Number(m.retiros || 0);
            const d = Number(m.depositos || 0);
            const s = Number(m.saldo || 0);

            return `
              <tr class="hover:bg-white/5">
                <td class="py-2 px-2 text-slate-200 whitespace-nowrap">${escapeHtml(m.fecha)}</td>
                <td class="py-2 px-2 text-slate-100">${escapeHtml(m.concepto)}</td>
                <td class="py-2 px-2 text-right ${r > 0 ? "text-red-300" : "text-slate-400"} whitespace-nowrap">${money(r)}</td>
                <td class="py-2 px-2 text-right ${d > 0 ? "text-emerald-300" : "text-slate-400"} whitespace-nowrap">${money(d)}</td>
                <td class="py-2 px-2 text-right text-slate-200 whitespace-nowrap">${money(s)}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

// Toggle JSON crudo (si lo activas)
btnToggleRaw?.addEventListener("click", () => {
  if (!rawBox) return;
  const isHidden = rawBox.classList.contains("hidden");
  rawBox.classList.toggle("hidden", !isHidden);
  btnToggleRaw.textContent = isHidden ? "Ocultar JSON" : "Ver JSON";
});

// -------------------------
// Exportar XLSX
// -------------------------
btnExportXlsx?.addEventListener("click", () => {
  if (!lastMovimientos.length) return alert("No hay movimientos para exportar");
  if (typeof XLSX === "undefined") return alert("No se cargó la librería XLSX. Revisa el <script> CDN.");

  const rows = lastMovimientos.map((m) => ({
    Fecha: m.fecha ?? "",
    Concepto: m.concepto ?? "",
    Retiros: Number(m.retiros || 0),
    Depositos: Number(m.depositos || 0),
    Saldo: Number(m.saldo || 0),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 12 }, { wch: 50 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Movimientos");

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `estado_cuenta_${stamp}.xlsx`);
});

// -------------------------
// Config modal
// -------------------------
function openConfig(msgText = "") {
  if (!configModal) return;
  configModal.classList.remove("hidden");
  configModal.classList.add("flex");
  configMsg.textContent = msgText || "";
}

function closeConfig() {
  if (!configModal) return;
  configModal.classList.add("hidden");
  configModal.classList.remove("flex");
  configMsg.textContent = "";
}

btnConfig?.addEventListener("click", () => openConfig());
btnConfigClose?.addEventListener("click", closeConfig);

configModal?.addEventListener("click", (e) => {
  if (e.target === configModal) closeConfig();
});

btnShowKey?.addEventListener("click", () => {
  if (!apiKeyInput) return;
  if (apiKeyInput.type === "password") {
    apiKeyInput.type = "text";
    btnShowKey.textContent = "Ocultar";
  } else {
    apiKeyInput.type = "password";
    btnShowKey.textContent = "Mostrar";
  }
});

btnOpenConfigFolder?.addEventListener("click", async () => {
  if (!hasNative()) return alert("No estás en Electron / preload no cargó.");
  await window.native.openConfigFolder();
});

btnSaveKey?.addEventListener("click", async () => {
  if (!hasNative()) return alert("No estás en Electron / preload no cargó.");

  const key = (apiKeyInput.value || "").trim();
  if (!key) {
    configMsg.textContent = "⚠️ API Key vacía.";
    return;
  }

  configMsg.textContent = "Guardando…";
  const r = await window.native.setApiKey(key);
  if (!r.ok) {
    configMsg.textContent = "❌ " + (r.error || "No se pudo guardar");
    return;
  }

  configMsg.textContent = "Reiniciando servidor…";
  const rr = await window.native.restartServer();
  if (!rr.ok) {
    configMsg.textContent = "✅ Guardada, pero no pude reiniciar server: " + (rr.error || "");
    return;
  }

  configMsg.textContent = "✅ Listo. Ya puedes procesar PDFs.";
  closeConfig();
});

// Auto-abrir si falta key
(async () => {
  if (!hasNative()) return;
  const r = await window.native.configGet().catch(() => null);
  if (r?.ok && !r?.config?.hasKey) openConfig("⚠️ Falta la API Key. Pégala para continuar.");
})();

// -------------------------
// File picking
// -------------------------
btnPick?.addEventListener("click", () => pdfInput?.click());

pdfInput?.addEventListener("change", () => {
  const f = pdfInput.files?.[0];
  fileName.textContent = f ? f.name : "Ninguno";
  btnUpload.disabled = !f;

  lastMovimientos = [];
  renderTable([]);
  if (rawBox) rawBox.textContent = "";
  if (rawBox) rawBox.classList.add("hidden");
  if (btnToggleRaw) btnToggleRaw.textContent = "Ver JSON";

  setStatus(f ? "PDF listo para procesar." : "Listo.", "info");
});

// -------------------------
// Upload
// -------------------------
btnUpload?.addEventListener("click", async () => {
  const file = pdfInput.files?.[0];
  if (!file) return;

  setLoading(true);
  setStatus("Procesando…", "info");
  lastMovimientos = [];
  renderTable([]);
  if (rawBox) rawBox.textContent = "";

  try {
    const UPLOAD_URL = await getUploadUrl();

    const fd = new FormData();
    fd.append("pdf", file);
    const pass = (passwordInput.value || "").trim();
    if (pass) fd.append("password", pass);

    const resp = await fetch(UPLOAD_URL, { method: "POST", body: fd });

    let data = null;
    try { data = await resp.json(); } catch {}

    if (!resp.ok) {
      const msg = data?.error || `HTTP ${resp.status}`;
      setStatus(`❌ ${msg}`, "error");

      if (String(msg).includes("OPENAI_API_KEY") || String(msg).toLowerCase().includes("api key")) {
        if (hasNative()) openConfig("⚠️ Falta la API Key. Pégala y guarda.");
      }

      alert(msg);
      return;
    }

    setStatus("✅ Listo", "ok");

    const movs = Array.isArray(data?.movimientos) ? data.movimientos : [];
    lastMovimientos = movs;

    renderTable(movs);
    if (rawBox) rawBox.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    const msg = err?.message || String(err);
    setStatus(`❌ ${msg}`, "error");
    alert(msg);
  } finally {
    setLoading(false);
  }
});
