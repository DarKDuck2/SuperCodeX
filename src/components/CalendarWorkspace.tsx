import { CalendarDays, ExternalLink, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type Status = { configured: boolean; connected: boolean; clientId: string };
type Event = { id: string; summary: string; start: string; end: string; location?: string; htmlLink?: string };

export function CalendarWorkspace() {
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revocationWarning, setRevocationWarning] = useState("");
  const connectedRef = useRef(false);

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    return payload as T;
  }

  async function refresh(syncClientId = false, reloadEvents = true) {
    const next = await request<Status>("/api/connectors/google-calendar");
    setStatus(next);
    if (syncClientId) setClientId(next.clientId);
    if (next.connected && (reloadEvents || !connectedRef.current)) {
      const payload = await request<{ events: Event[] }>("/api/connectors/google-calendar/events");
      setEvents(payload.events);
    } else if (!next.connected) setEvents([]);
    connectedRef.current = next.connected;
  }

  useEffect(() => {
    void refresh(true).catch((cause) => setError((cause as Error).message));
    const timer = window.setInterval(() => { void refresh(false, false).catch((cause) => setError((cause as Error).message)); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const next = await request<Status>("/api/connectors/google-calendar", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, ...(clientSecret ? { clientSecret } : {}) })
      });
      setStatus(next); setClientSecret("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function connect() {
    setBusy(true); setError("");
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const { authorizationUrl } = await request<{ authorizationUrl: string }>("/api/connectors/google-calendar/start", { method: "POST" });
      if (popup) popup.location.replace(authorizationUrl);
      else window.location.assign(authorizationUrl);
    } catch (cause) { popup?.close(); setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(""); setRevocationWarning("");
    try {
      const result = await request<{ revoked: boolean }>("/api/connectors/google-calendar", { method: "DELETE" });
      if (!result.revoked) setRevocationWarning("本地凭据已清除，但 Google 撤销请求未成功。请在 Google 账号的第三方连接设置中手动撤销。");
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="calendarWorkspace">
    <div className="goalsIntro"><CalendarDays size={22} /><div><strong>Google 日历 · 只读</strong><p>连接主日历后，可查看未来七天日程，也可让 Agent 回答日程相关问题。连接器不会创建或修改事件。</p></div></div>
    <form className="calendarConnectForm" onSubmit={(event) => void save(event)}>
      <label>桌面应用 OAuth Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="...apps.googleusercontent.com" required /></label>
      <label>Client Secret（可选）<input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} type="password" placeholder="仅当 Google 客户端需要时填写" /></label>
      <button type="submit" disabled={busy}>保存连接配置</button>
    </form>
    <p className="calendarHint">先在 Google Cloud Console 启用 Calendar API，创建“桌面应用”OAuth 客户端，并将测试账号加入同意屏幕。授权将在系统浏览器中完成。</p>
    <div className="calendarActions">
      <span>{status?.connected ? "已连接" : status?.configured ? "已配置，待授权" : "未配置"}</span>
      <button type="button" disabled={busy || !status?.configured} onClick={() => void connect()}>{status?.connected ? "重新授权" : "连接 Google 日历"}</button>
      {status?.connected && <><button type="button" disabled={busy} onClick={() => void refresh().catch((cause) => setError((cause as Error).message))}><RefreshCw size={15} /> 刷新</button><button type="button" disabled={busy} onClick={() => void disconnect()}><Unplug size={15} /> 断开连接</button></>}
    </div>
    {error && <p className="calendarError" role="alert">{error}</p>}
    {revocationWarning && <p className="calendarError" role="alert">{revocationWarning}</p>}
    {status?.connected && <div className="calendarEvents"><h3>未来七天</h3>{events.length === 0 ? <p className="emptyText">这个时间段没有日程。</p> : events.map((item) => <article key={item.id}><strong>{item.summary}</strong><span>{item.start} → {item.end}</span>{item.location && <span>{item.location}</span>}{item.htmlLink && <a href={item.htmlLink} target="_blank" rel="noopener noreferrer">在 Google 日历查看 <ExternalLink size={13} /></a>}</article>)}</div>}
  </section>;
}
