/**
 * preload.js — Secure bridge ระหว่าง Main Process และ Renderer
 * ใช้ contextBridge เพื่อความปลอดภัย
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("watcher", {
  // ── Config ─────────────────────────────────────────────────
  getConfig:    ()       => ipcRenderer.invoke("get-config"),
  saveConfig:   (cfg)    => ipcRenderer.send("save-config", cfg),

  // ── Capture Control ────────────────────────────────────────
  startCapture: (opts)   => ipcRenderer.send("start-capture", opts),
  stopCapture:  ()       => ipcRenderer.send("stop-capture"),
  setInterval:  (ms)     => ipcRenderer.send("set-interval", ms),

  // ── Region Selector ────────────────────────────────────────
  openRegionSelector: () => ipcRenderer.send("open-region-selector"),
  regionSelected: (region) => ipcRenderer.send("region-selected", region),
  regionCancel:   ()       => ipcRenderer.send("region-cancel"),

  // ── Events (Main → Renderer) ───────────────────────────────
  onConfigLoaded:    (fn) => ipcRenderer.on("config-loaded",    (_, d) => fn(d)),
  onConfigUpdated:   (fn) => ipcRenderer.on("config-updated",   (_, d) => fn(d)),
  onPreviewFrame:    (fn) => ipcRenderer.on("preview-frame",    (_, d) => fn(d)),
  onAnalysisResult:  (fn) => ipcRenderer.on("analysis-result",  (_, d) => fn(d)),
  onLog:             (fn) => ipcRenderer.on("log",              (_, d) => fn(d)),

  // ── Cleanup ────────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
