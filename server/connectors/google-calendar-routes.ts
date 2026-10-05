import type express from "express";
import type { GoogleCalendarService } from "./google-calendar.js";

export function registerGoogleCalendarRoutes(app: express.Express, service: GoogleCalendarService, listeningPort: () => number) {
  app.get("/api/connectors/google-calendar", (_req, res) => { res.json(service.status()); });

  app.put("/api/connectors/google-calendar", async (req, res) => {
    try {
      const { clientId, clientSecret } = req.body as { clientId?: unknown; clientSecret?: unknown };
      if (typeof clientId !== "string" || (clientSecret !== undefined && typeof clientSecret !== "string")) {
        res.status(400).json({ error: "OAuth Client ID 或 Secret 无效" }); return;
      }
      res.json(await service.configure(clientId, clientSecret));
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  app.post("/api/connectors/google-calendar/start", (_req, res) => {
    try {
      const redirectUri = `http://127.0.0.1:${listeningPort()}/`;
      res.json({ authorizationUrl: service.beginAuthorization(redirectUri) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  // Google documents the desktop loopback redirect as the origin root, including its dynamic port.
  app.get("/", async (req, res) => {
    const { state, code, error } = req.query;
    if (typeof state !== "string" || (typeof code !== "string" && typeof error !== "string")) {
      res.status(404).end(); return;
    }
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    try {
      await service.completeAuthorization({ state, code: typeof code === "string" ? code : undefined, error: typeof error === "string" ? error : undefined });
      res.type("html").send("<!doctype html><html lang=zh><meta charset=utf-8><title>日历已连接</title><body style='font:16px system-ui;padding:32px'><h1>Google 日历已连接</h1><p>可以关闭此页面并返回 SuperCodex。</p></body></html>");
    } catch {
      res.status(400).type("html").send("<!doctype html><html lang=zh><meta charset=utf-8><title>授权失败</title><body style='font:16px system-ui;padding:32px'><h1>授权未完成</h1><p>请返回 SuperCodex 重新连接。</p></body></html>");
    }
  });

  app.get("/api/connectors/google-calendar/events", async (req, res) => {
    try {
      const timeMin = typeof req.query.timeMin === "string" ? req.query.timeMin : new Date().toISOString();
      const timeMax = typeof req.query.timeMax === "string" ? req.query.timeMax : new Date(Date.now() + 7 * 86_400_000).toISOString();
      res.json({ events: await service.listEvents(timeMin, timeMax) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  app.delete("/api/connectors/google-calendar", async (_req, res) => {
    res.json(await service.disconnect());
  });
}
