/**
 * ═══════════════════════════════════════════════════════════════
 *  Treebar Screen Watcher — main.js (Electron Main Process)
 *  จับภาพหน้าจอบริเวณที่กำหนด → Claude Vision → Firebase → ปิดบิล
 * ═══════════════════════════════════════════════════════════════
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");

// ── Config ───────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath("userData"), "watcher-config.json");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  return {
    captureRegion: null,      // { x, y, width, height } บริเวณที่จับภาพ
    captureInterval: 1000,    // ms — จับภาพทุกกี่ ms
    claudeModel: "claude-sonnet-4-20250514",
    confidenceThreshold: 95,
    timeWindowMinutes: 2,
    enabled: false,
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ── Windows ──────────────────────────────────────────────────
let mainWin  = null;
let overlayWin = null;   // หน้าต่างโปร่งใสสำหรับลากเลือกพื้นที่
let tray     = null;
let captureTimer = null;
let lastFrameHash = "";  // ป้องกันประมวลผลภาพเดิมซ้ำ

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 560,
    title: "Treebar Screen Watcher",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#0f172a",
    show: false,
  });

  mainWin.loadFile("index.html");

  mainWin.once("ready-to-show", () => {
    mainWin.show();
    // ส่ง config ให้ renderer ทันที
    mainWin.webContents.send("config-loaded", config);
  });

  mainWin.on("close", (e) => {
    if (config.minimizeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

// ── Tray ─────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("Treebar Screen Watcher");
  updateTrayMenu();

  tray.on("double-click", () => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: config.enabled ? "🟢 กำลังทำงาน — คลิกเพื่อหยุด" : "🔴 หยุดทำงาน — คลิกเพื่อเริ่ม",
      click: () => toggleCapture(!config.enabled),
    },
    { type: "separator" },
    { label: "เปิดหน้าต่างหลัก", click: () => { mainWin?.show(); mainWin?.focus(); } },
    { type: "separator" },
    { label: "ออกจากโปรแกรม", click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Overlay สำหรับเลือกพื้นที่ ─────────────────────────────
function openRegionSelector() {
  // ปิด overlay เก่าถ้ามี
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();

  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWin = new BrowserWindow({
    x: 0, y: 0,
    width, height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.loadFile("overlay.html");
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setIgnoreMouseEvents(false);

  // รับผลลัพธ์จาก overlay
  ipcMain.once("region-selected", (event, region) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    if (region) {
      config.captureRegion = region;
      saveConfig(config);
      mainWin?.webContents.send("config-updated", config);
      mainWin?.webContents.send("log", `✅ เลือกพื้นที่: ${region.width}×${region.height} px ที่ (${region.x}, ${region.y})`);
    }
  });

  ipcMain.once("region-cancel", () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  });
}

// ── Screen Capture ───────────────────────────────────────────
async function captureRegion() {
  if (!config.captureRegion) return null;

  try {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().bounds;

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: screenW, height: screenH },
    });

    if (!sources.length) return null;

    const thumb = sources[0].thumbnail;
    // ตัดเฉพาะ region ที่ต้องการ
    const { x, y, width, height } = config.captureRegion;
    const cropped = thumb.crop({ x, y, width, height });
    return cropped.toJPEG(85); // Buffer

  } catch (err) {
    console.error("[Capture] Error:", err.message);
    return null;
  }
}

// Simple hash เพื่อตรวจว่าภาพเปลี่ยนไปหรือไม่
function quickHash(buffer) {
  if (!buffer) return "";
  let h = 0;
  const step = Math.max(1, Math.floor(buffer.length / 500));
  for (let i = 0; i < buffer.length; i += step) {
    h = (h * 31 + buffer[i]) >>> 0;
  }
  return h.toString(16);
}

// ── Claude Vision API ────────────────────────────────────────
const VISION_PROMPT = `คุณเป็น AI ผู้เชี่ยวชาญด้านการอ่านข้อความแจ้งเตือนการโอนเงินบนหน้าจอ
จาก LINE, Krungthai Connext, KBank, SCB, BBL, PromptPay และ Mobile Banking ทุกธนาคาร

กฎการวิเคราะห์:
- มองหาข้อความแจ้งเตือนเงินเข้า/โอนเข้า/รับเงิน ใหม่ล่าสุดที่ปรากฏบนหน้าจอ
- คำสำคัญ: เงินเข้า, received, โอนเข้า, transfer, รับเงิน, credit, บาท, THB
- ต้องระบุจำนวนเงินเป็นตัวเลข (บาท/THB เท่านั้น) — ไม่ใช่เงินออก
- แยกชื่อผู้โอน เวลา และธนาคาร
- หากไม่พบการแจ้งเตือนเงินเข้าชัดเจน ให้ตอบ payment_detected: false
- รองรับภาษาไทยและอังกฤษ

ตอบเป็น JSON เท่านั้น ไม่มี markdown ไม่มีข้อความอื่น:
{"payment_detected":true|false,"amount":<number|null>,"sender":"<string|null>","time":"<HH:MM|null>","bank":"<string|null>","raw_text":"<string>","confidence":<0-100>,"reason":"<string>"}`;

async function analyzeWithClaude(imageBuffer, apiKey) {
  const base64 = imageBuffer.toString("base64");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 800,
      system: VISION_PROMPT,
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: base64 },
        }, {
          type: "text",
          text: "วิเคราะห์ภาพหน้าจอนี้ ตอบ JSON เท่านั้น",
        }],
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const raw  = data.content?.map(c => c.text || "").join("") || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Firebase Integration ─────────────────────────────────────
// ส่งผลลัพธ์ไปยัง Firestore collection "paymentDetections"
// App.js ของ POS จะ listen collection นี้และปิดบิลเอง
async function pushToFirebase(result, firebaseConfig) {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/paymentDetections`;
    const body = {
      fields: {
        payment_detected: { booleanValue: result.payment_detected },
        amount:           { doubleValue: result.amount || 0 },
        sender:           { stringValue: result.sender || "" },
        time:             { stringValue: result.time || "" },
        bank:             { stringValue: result.bank || "" },
        confidence:       { doubleValue: result.confidence || 0 },
        reason:           { stringValue: result.reason || "" },
        raw_text:         { stringValue: result.raw_text || "" },
        timestamp:        { stringValue: new Date().toISOString() },
        status:           { stringValue: "pending" },  // POS จะ set เป็น "processed"
      },
    };

    const res = await fetch(`${url}?key=${firebaseConfig.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Firebase ${res.status}`);
    return true;
  } catch (err) {
    console.error("[Firebase] Push error:", err.message);
    return false;
  }
}

// ── Capture Loop ─────────────────────────────────────────────
let isAnalyzing = false;   // ป้องกัน concurrent calls
let lastDetectedAmount = null;
let lastDetectedTime = null;

async function runCaptureCycle(apiKey, firebaseConfig) {
  if (isAnalyzing || !config.captureRegion || !config.enabled) return;
  isAnalyzing = true;

  try {
    const buffer = await captureRegion();
    if (!buffer) { isAnalyzing = false; return; }

    // ตรวจว่าภาพเปลี่ยนไปหรือไม่
    const hash = quickHash(buffer);
    if (hash === lastFrameHash) { isAnalyzing = false; return; }
    lastFrameHash = hash;

    // ส่งภาพ preview ให้ UI แสดง
    mainWin?.webContents.send("preview-frame", `data:image/jpeg;base64,${buffer.toString("base64")}`);

    // วิเคราะห์กับ Claude
    const result = await analyzeWithClaude(buffer, apiKey);

    mainWin?.webContents.send("analysis-result", result);

    if (!result.payment_detected || !result.amount) {
      isAnalyzing = false;
      return;
    }

    // ป้องกัน detect ซ้ำภายใน 30 วินาที (amount + time เหมือนกัน)
    const detKey = `${result.amount}_${result.time}`;
    if (detKey === lastDetectedAmount && lastDetectedTime && Date.now() - lastDetectedTime < 30000) {
      isAnalyzing = false;
      return;
    }
    lastDetectedAmount = detKey;
    lastDetectedTime   = Date.now();

    mainWin?.webContents.send("log", `💰 พบการโอนเงิน ฿${result.amount} (${result.confidence}%) — ${result.sender || "?"} @ ${result.time || "--:--"}`);

    // Push ไป Firebase → POS จะรับและปิดบิล
    const pushed = await pushToFirebase(result, firebaseConfig);
    if (pushed) {
      mainWin?.webContents.send("log", `☁️ ส่งข้อมูลไป Firebase เรียบร้อย — รอ POS ปิดบิล`);
    }

  } catch (err) {
    mainWin?.webContents.send("log", `❌ Error: ${err.message}`);
    console.error("[Cycle]", err);
  }

  isAnalyzing = false;
}

// ── Start / Stop ─────────────────────────────────────────────
function toggleCapture(enable, apiKey, firebaseConfig) {
  config.enabled = enable;
  saveConfig(config);
  updateTrayMenu();

  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }

  if (enable) {
    mainWin?.webContents.send("log", `🚀 เริ่มจับภาพทุก ${config.captureInterval}ms`);
    captureTimer = setInterval(
      () => runCaptureCycle(apiKey, firebaseConfig),
      config.captureInterval
    );
  } else {
    mainWin?.webContents.send("log", "⏹️ หยุดจับภาพ");
  }

  mainWin?.webContents.send("config-updated", config);
}

// ── IPC handlers ─────────────────────────────────────────────
ipcMain.handle("get-config",  () => config);
ipcMain.handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 200, height: 150 } });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

ipcMain.on("open-region-selector", () => openRegionSelector());

ipcMain.on("save-config", (event, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig(config);
  mainWin?.webContents.send("config-updated", config);
});

ipcMain.on("start-capture", (event, { apiKey, firebaseConfig }) => {
  toggleCapture(true, apiKey, firebaseConfig);
});

ipcMain.on("stop-capture", () => {
  toggleCapture(false);
});

ipcMain.on("set-interval", (event, ms) => {
  config.captureInterval = ms;
  saveConfig(config);
});

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();
  createTray();

  // Shortcut หยุด/เริ่มด่วน
  globalShortcut.register("CommandOrControl+Shift+W", () => {
    toggleCapture(!config.enabled);
  });
});

app.on("will-quit", () => {
  if (captureTimer) clearInterval(captureTimer);
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // ไม่ quit เมื่อปิดหน้าต่าง — ยังทำงานใน tray
  if (process.platform !== "darwin") {
    // ถ้าไม่มี tray ค่อย quit
    if (!tray) app.quit();
  }
});
