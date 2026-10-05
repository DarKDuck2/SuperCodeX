import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createGoogleCalendarService } from "../server/connectors/google-calendar.js";
import { registerGoogleCalendarRoutes } from "../server/connectors/google-calendar-routes.js";

const clientId = "1234567890-abc.apps.googleusercontent.com";
const scope = "https://www.googleapis.com/auth/calendar.events.readonly";

test("Google Calendar OAuth validates state, persists credentials, refreshes after restart and revokes", async () => {
  const dataDir = path.join(os.tmpdir(), `supercodex-calendar-${randomUUID()}`);
  let clock = Date.parse("2026-10-04T00:00:00Z");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(init?.body as string);
      if (body.get("grant_type") === "authorization_code") {
        assert.equal(body.get("code"), "one-time-code");
        assert.ok(body.get("code_verifier"));
        return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 120, scope });
      }
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-1");
      return Response.json({ access_token: "access-2", expires_in: 3600 });
    }
    if (url.includes("/calendar/v3/calendars/primary/events")) {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer access-2");
      const query = new URL(url).searchParams;
      assert.equal(query.get("maxResults"), "50");
      assert.equal(query.get("singleEvents"), "true");
      return Response.json({ items: [{ id: "event-1", summary: "Weekly sync", start: { dateTime: "2026-10-05T09:00:00Z" }, end: { dateTime: "2026-10-05T09:30:00Z" }, description: "must not reach model", htmlLink: "https://calendar.google.com/calendar/event?eid=123" }] });
    }
    assert.equal(url, "https://oauth2.googleapis.com/revoke");
    assert.equal(new URLSearchParams(init?.body as string).get("token"), "refresh-1");
    return new Response("", { status: 200 });
  };
  try {
    const service = createGoogleCalendarService({ dataDir, fetchImpl: fakeFetch as typeof fetch, now: () => clock });
    await service.initialize();
    await service.configure(clientId);
    const authorizationUrl = new URL(service.beginAuthorization("http://127.0.0.1:8787/"));
    assert.equal(authorizationUrl.searchParams.get("scope"), scope);
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/");
    await assert.rejects(service.completeAuthorization({ state: "wrong", code: "one-time-code" }), /状态无效/);
    const retryUrl = new URL(service.beginAuthorization("http://127.0.0.1:8787/"));
    await service.completeAuthorization({ state: retryUrl.searchParams.get("state")!, code: "one-time-code" });
    assert.deepEqual(service.status(), { configured: true, connected: true, clientId });
    const stored = await fs.readFile(path.join(dataDir, "google-calendar.json"), "utf8");
    assert.match(stored, /refresh-1/);
    assert.equal((await fs.stat(path.join(dataDir, "google-calendar.json"))).mode & 0o777, 0o600);
    clock += 180_000;
    const restarted = createGoogleCalendarService({ dataDir, fetchImpl: fakeFetch as typeof fetch, now: () => clock });
    await restarted.initialize();
    const events = await restarted.listEvents("2026-10-04T00:00:00Z", "2026-10-11T00:00:00Z");
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Weekly sync");
    assert.equal("description" in events[0], false);
    await assert.rejects(restarted.listEvents("2026-10-04T00:00:00Z", "2026-11-10T00:00:00Z"), /31 天/);
    assert.deepEqual(await restarted.disconnect(), { revoked: true });
    assert.equal(restarted.status().connected, false);
    assert.equal(calls.filter((call) => call.url.endsWith("/token")).length, 2);
    assert.equal((await fs.readFile(path.join(dataDir, "google-calendar.json"), "utf8")).includes("refresh-1"), false);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Google Calendar rejects missing read scope and expired OAuth state", async () => {
  const dataDir = path.join(os.tmpdir(), `supercodex-calendar-${randomUUID()}`);
  let clock = 1000;
  const fakeFetch = async () => Response.json({ access_token: "access", refresh_token: "refresh", scope: "openid", expires_in: 3600 });
  try {
    const service = createGoogleCalendarService({ dataDir, fetchImpl: fakeFetch as typeof fetch, now: () => clock });
    await service.configure(clientId);
    const first = new URL(service.beginAuthorization("http://127.0.0.1:8787/"));
    clock += 10 * 60_000 + 1;
    await assert.rejects(service.completeAuthorization({ state: first.searchParams.get("state")!, code: "code" }), /已过期/);
    const second = new URL(service.beginAuthorization("http://127.0.0.1:8787/"));
    await assert.rejects(service.completeAuthorization({ state: second.searchParams.get("state")!, code: "code" }), /未授予/);
    assert.equal(service.status().connected, false);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Google Calendar HTTP callback completes OAuth without returning credentials", async () => {
  const dataDir = path.join(os.tmpdir(), `supercodex-calendar-${randomUUID()}`);
  const fakeFetch = async () => Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", expires_in: 3600, scope });
  const service = createGoogleCalendarService({ dataDir, fetchImpl: fakeFetch as typeof fetch });
  const app = express();
  app.use(express.json());
  let port = 0;
  registerGoogleCalendarRoutes(app, service, () => port);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    port = address.port;
    const base = `http://127.0.0.1:${port}`;
    const configured = await fetch(`${base}/api/connectors/google-calendar`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    assert.equal(configured.status, 200);
    const started = await fetch(`${base}/api/connectors/google-calendar/start`, { method: "POST" });
    const { authorizationUrl } = await started.json() as { authorizationUrl: string };
    const oauth = new URL(authorizationUrl);
    assert.equal(oauth.searchParams.get("redirect_uri"), `${base}/`);
    const bad = await fetch(`${base}/?state=wrong&code=one-time-code`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.text()).includes("one-time-code"), false);
    const restarted = await fetch(`${base}/api/connectors/google-calendar/start`, { method: "POST" });
    const { authorizationUrl: secondUrl } = await restarted.json() as { authorizationUrl: string };
    const state = new URL(secondUrl).searchParams.get("state");
    const callback = await fetch(`${base}/?state=${encodeURIComponent(state!)}&code=one-time-code`);
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get("cache-control"), "no-store");
    const html = await callback.text();
    assert.equal(html.includes("secret-access"), false);
    assert.equal(html.includes("secret-refresh"), false);
    assert.equal(html.includes("one-time-code"), false);
    const status = await (await fetch(`${base}/api/connectors/google-calendar`)).json() as Record<string, unknown>;
    assert.equal(status.connected, true);
    assert.equal(JSON.stringify(status).includes("secret-"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("Google Calendar follows event pages and rejects incomplete trigger scans", async () => {
  const dataDir = path.join(os.tmpdir(), `supercodex-calendar-${randomUUID()}`);
  const pages: string[] = [];
  const event = (index: number) => ({ id: `event-${index}`, summary: `Event ${index}`, updated: "2026-10-04T00:00:00Z", start: { dateTime: "2026-10-05T09:00:00Z" }, end: { dateTime: "2026-10-05T09:30:00Z" } });
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/token")) return Response.json({ access_token: "access", refresh_token: "refresh", scope, expires_in: 3600 });
    const parsed = new URL(url);
    const pageToken = parsed.searchParams.get("pageToken") || "first";
    pages.push(pageToken);
    if (pageToken === "first") return Response.json({ items: Array.from({ length: 250 }, (_, index) => event(index)), nextPageToken: "second" });
    if (pageToken === "second") return Response.json({ items: Array.from({ length: 250 }, (_, index) => event(index + 250)), nextPageToken: "third" });
    return Response.json({ items: [event(500)] });
  };
  try {
    const service = createGoogleCalendarService({ dataDir, fetchImpl: fakeFetch as typeof fetch });
    await service.configure(clientId);
    const auth = new URL(service.beginAuthorization("http://127.0.0.1:8787/"));
    await service.completeAuthorization({ state: auth.searchParams.get("state")!, code: "code" });
    await assert.rejects(service.listEvents("2026-10-04T00:00:00Z", "2026-10-11T00:00:00Z", { maxEvents: 500, requireComplete: true }), /超过 500 条/);
    assert.deepEqual(pages, ["first", "second"]);
    pages.length = 0;
    const events = await service.listEvents("2026-10-04T00:00:00Z", "2026-10-11T00:00:00Z");
    assert.equal(events.length, 50);
    assert.deepEqual(pages, ["first"]);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
