import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.resolve(process.cwd(), "data");
const RESPONSES_FILE = path.join(DATA_DIR, "survey_responses.json");
const SHEETS_SETTINGS_FILE = path.join(DATA_DIR, "sheet_settings.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface SheetSettings {
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  webhookUrl: string;
  lastUpdated: string;
}

function readSheetSettings(): SheetSettings {
  try {
    if (!fs.existsSync(SHEETS_SETTINGS_FILE)) {
      return {
        spreadsheetId: "",
        spreadsheetUrl: "",
        spreadsheetTitle: "",
        webhookUrl: "",
        lastUpdated: "",
      };
    }
    const content = fs.readFileSync(SHEETS_SETTINGS_FILE, "utf-8");
    return JSON.parse(content || "{}");
  } catch (err) {
    return {
      spreadsheetId: "",
      spreadsheetUrl: "",
      spreadsheetTitle: "",
      webhookUrl: "",
      lastUpdated: "",
    };
  }
}

function writeSheetSettings(settings: SheetSettings) {
  try {
    fs.writeFileSync(SHEETS_SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing sheet settings:", err);
  }
}

interface SavedResponse {
  id: string;
  submittedAt: string;
  personal: {
    hospital: string;
    name: string;
    age: string;
    gender: string;
    maritalStatus: string;
    profession: string;
    residence: string;
    experience: string;
    training: string;
  };
  answers: Record<string, number>;
  scores: {
    satisfaction: number;
    burnout: number;
    stress: number;
    satisfactionBand: string;
    burnoutBand: string;
    stressBand: string;
  };
}

function readResponses(): SavedResponse[] {
  try {
    if (!fs.existsSync(RESPONSES_FILE)) {
      return [];
    }
    const content = fs.readFileSync(RESPONSES_FILE, "utf-8");
    return JSON.parse(content || "[]");
  } catch (err) {
    console.error("Error reading responses file:", err);
    return [];
  }
}

function writeResponses(data: SavedResponse[]) {
  try {
    fs.writeFileSync(RESPONSES_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing responses file:", err);
  }
}

async function forwardToGoogleSheets(webhookUrl: string, payload: any) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("Google Sheets webhook response status:", res.status);
  } catch (err) {
    console.error("Failed to forward response to Google Sheets:", err);
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // POST: Record new survey response
  app.post("/api/survey-responses", async (req, res) => {
    try {
      const { personal, answers, scores, customWebhookUrl } = req.body;

      if (!personal || !answers || !scores) {
        return res.status(400).json({ error: "Missing required survey data." });
      }

      const newEntry: SavedResponse = {
        id: `rsp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        submittedAt: new Date().toISOString(),
        personal: {
          hospital: personal.hospital || "غير محدد",
          name: personal.name || "مشارك مجهل",
          age: String(personal.age || ""),
          gender: personal.gender || "",
          maritalStatus: personal.maritalStatus || "",
          profession: personal.profession || "",
          residence: personal.residence || "",
          experience: String(personal.experience || ""),
          training: personal.training || "",
        },
        answers,
        scores,
      };

      const existing = readResponses();
      existing.unshift(newEntry);
      writeResponses(existing);

      // Google Sheets sync if webhook URL exists
      const sheetSettings = readSheetSettings();
      const targetWebhook = customWebhookUrl || sheetSettings.webhookUrl || process.env.GOOGLE_SHEET_WEBHOOK_URL;
      if (targetWebhook) {
        forwardToGoogleSheets(targetWebhook, newEntry).catch(() => {});
      }

      res.status(201).json({
        success: true,
        message: "تم حفظ الاستبيان بنجاح",
        id: newEntry.id,
        syncedToSheets: !!targetWebhook,
      });
    } catch (err) {
      console.error("Error saving survey response:", err);
      res.status(500).json({ error: "تعذر حفظ الاستجابة في الخادم" });
    }
  });

  // GET: Sheet settings
  app.get("/api/settings/sheets", (_req, res) => {
    res.json(readSheetSettings());
  });

  // POST: Sheet settings
  app.post("/api/settings/sheets", (req, res) => {
    try {
      const { spreadsheetId, spreadsheetUrl, spreadsheetTitle, webhookUrl } = req.body;
      const current = readSheetSettings();
      const updated: SheetSettings = {
        spreadsheetId: spreadsheetId !== undefined ? spreadsheetId : current.spreadsheetId,
        spreadsheetUrl: spreadsheetUrl !== undefined ? spreadsheetUrl : current.spreadsheetUrl,
        spreadsheetTitle: spreadsheetTitle !== undefined ? spreadsheetTitle : current.spreadsheetTitle,
        webhookUrl: webhookUrl !== undefined ? webhookUrl : current.webhookUrl,
        lastUpdated: new Date().toISOString(),
      };
      writeSheetSettings(updated);
      res.json({ success: true, settings: updated });
    } catch (err) {
      res.status(500).json({ error: "Failed to save sheet settings" });
    }
  });

  // GET: Retrieve all responses (with optional filtering)
  app.get("/api/survey-responses", (req, res) => {
    try {
      const { profession, hospital, limit } = req.query;
      let data = readResponses();

      if (profession && typeof profession === "string") {
        data = data.filter((item) => item.personal.profession === profession);
      }
      if (hospital && typeof hospital === "string") {
        data = data.filter((item) => item.personal.hospital === hospital);
      }

      if (limit) {
        const count = parseInt(String(limit), 10);
        if (!isNaN(count)) {
          data = data.slice(0, count);
        }
      }

      res.json({
        total: data.length,
        responses: data,
      });
    } catch (err) {
      console.error("Error fetching responses:", err);
      res.status(500).json({ error: "Failed to read responses" });
    }
  });

  // GET: Aggregate statistics for researcher dashboard
  app.get("/api/survey-responses/stats", (_req, res) => {
    try {
      const data = readResponses();
      const total = data.length;

      if (total === 0) {
        return res.json({
          totalSubmissions: 0,
          averages: { satisfaction: 0, burnout: 0, stress: 0 },
          bands: {
            satisfaction: { low: 0, medium: 0, high: 0 },
            burnout: { low: 0, medium: 0, high: 0 },
            stress: { low: 0, medium: 0, high: 0 },
          },
          byProfession: [],
          byHospital: [],
        });
      }

      let sumSat = 0;
      let sumBo = 0;
      let sumSt = 0;

      const bands = {
        satisfaction: { low: 0, medium: 0, high: 0 },
        burnout: { low: 0, medium: 0, high: 0 },
        stress: { low: 0, medium: 0, high: 0 },
      };

      const profMap: Record<string, { count: number; sat: number; bo: number; st: number }> = {};
      const hospMap: Record<string, { count: number; sat: number; bo: number; st: number }> = {};

      for (const item of data) {
        const sat = item.scores?.satisfaction || 0;
        const bo = item.scores?.burnout || 0;
        const st = item.scores?.stress || 0;

        sumSat += sat;
        sumBo += bo;
        sumSt += st;

        // Bands tally
        if (sat <= 22) bands.satisfaction.low++;
        else if (sat <= 41) bands.satisfaction.medium++;
        else bands.satisfaction.high++;

        if (bo <= 22) bands.burnout.low++;
        else if (bo <= 41) bands.burnout.medium++;
        else bands.burnout.high++;

        if (st <= 22) bands.stress.low++;
        else if (st <= 41) bands.stress.medium++;
        else bands.stress.high++;

        // Profession tally
        const prof = item.personal.profession || "غير محدد";
        if (!profMap[prof]) profMap[prof] = { count: 0, sat: 0, bo: 0, st: 0 };
        profMap[prof].count++;
        profMap[prof].sat += sat;
        profMap[prof].bo += bo;
        profMap[prof].st += st;

        // Hospital tally
        const hosp = item.personal.hospital || "غير محدد";
        if (!hospMap[hosp]) hospMap[hosp] = { count: 0, sat: 0, bo: 0, st: 0 };
        hospMap[hosp].count++;
        hospMap[hosp].sat += sat;
        hospMap[hosp].bo += bo;
        hospMap[hosp].st += st;
      }

      const byProfession = Object.entries(profMap).map(([name, stat]) => ({
        name,
        count: stat.count,
        satisfaction: Math.round((stat.sat / stat.count) * 10) / 10,
        burnout: Math.round((stat.bo / stat.count) * 10) / 10,
        stress: Math.round((stat.st / stat.count) * 10) / 10,
      }));

      const byHospital = Object.entries(hospMap).map(([name, stat]) => ({
        name,
        count: stat.count,
        satisfaction: Math.round((stat.sat / stat.count) * 10) / 10,
        burnout: Math.round((stat.bo / stat.count) * 10) / 10,
        stress: Math.round((stat.st / stat.count) * 10) / 10,
      }));

      res.json({
        totalSubmissions: total,
        averages: {
          satisfaction: Math.round((sumSat / total) * 10) / 10,
          burnout: Math.round((sumBo / total) * 10) / 10,
          stress: Math.round((sumSt / total) * 10) / 10,
        },
        bands,
        byProfession,
        byHospital,
      });
    } catch (err) {
      console.error("Error generating stats:", err);
      res.status(500).json({ error: "Failed to generate stats" });
    }
  });

  // GET: CSV Export with Arabic UTF-8 BOM
  app.get("/api/survey-responses/export.csv", (_req, res) => {
    try {
      const data = readResponses();

      // Arabic CSV headers
      const headers = [
        "معرف_الاستجابة",
        "تاريخ_الإرسال",
        "المستشفى",
        "الاسم",
        "السن",
        "النوع",
        "الحالة_الاجتماعية",
        "الوظيفة",
        "محل_الإقامة",
        "سنوات_الخبرة",
        "دورات_تدريبية",
        "درجة_الرضا_بالتراحم_CS",
        "مستوى_الرضا",
        "درجة_الاحتراق_الوظيفي_BO",
        "مستوى_الاحتراق",
        "درجة_الضغط_الصادم_STS",
        "مستوى_الضغط",
        ...Array.from({ length: 30 }, (_, i) => `سؤال_${i + 1}`),
      ];

      const rows = data.map((r) => {
        const questionCols = Array.from({ length: 30 }, (_, i) => {
          return r.answers[i + 1] ?? r.answers[String(i + 1)] ?? "";
        });

        const line = [
          r.id,
          r.submittedAt,
          `"${(r.personal.hospital || "").replace(/"/g, '""')}"`,
          `"${(r.personal.name || "").replace(/"/g, '""')}"`,
          r.personal.age || "",
          r.personal.gender || "",
          r.personal.maritalStatus || "",
          `"${(r.personal.profession || "").replace(/"/g, '""')}"`,
          r.personal.residence || "",
          r.personal.experience || "",
          r.personal.training || "",
          r.scores.satisfaction,
          r.scores.satisfactionBand,
          r.scores.burnout,
          r.scores.burnoutBand,
          r.scores.stress,
          r.scores.stressBand,
          ...questionCols,
        ];
        return line.join(",");
      });

      // UTF-8 BOM prefix for Microsoft Excel
      const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=sanad_survey_responses_${Date.now()}.csv`);
      res.status(200).send(csvContent);
    } catch (err) {
      console.error("Error exporting CSV:", err);
      res.status(500).json({ error: "Failed to export CSV" });
    }
  });

  // POST: Test Google Sheets Webhook
  app.post("/api/settings/test-sheets", async (req, res) => {
    try {
      const { webhookUrl } = req.body;
      if (!webhookUrl) {
        return res.status(400).json({ error: "يرجى تزويد رابط الـ Webhook" });
      }

      const testPayload = {
        test: true,
        message: "اختبار اتصال نظام سند (SANAD) مع Google Sheets",
        timestamp: new Date().toISOString(),
      };

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload),
      });

      res.json({
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err?.message || "تعذر الوصول إلى الرابط المطلوب",
      });
    }
  });

  // Vite middleware in development, static files in production
  const isDev = process.env.NODE_ENV === "development";
  const distPath = path.resolve(process.cwd(), "dist");

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
