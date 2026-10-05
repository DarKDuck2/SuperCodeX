import { Bell } from "lucide-react";
import type { AttentionItem, AttentionSnapshot } from "../types";

type Props = {
  snapshot: AttentionSnapshot;
  permission: NotificationPermission | "unsupported";
  onMode: (mode: AttentionSnapshot["mode"]) => Promise<void>;
  onRead: (id: string) => Promise<void>;
  onReadAll: () => Promise<void>;
  onEnableDesktop: () => Promise<void>;
  onOpen: (item: AttentionItem) => void;
};

export function AttentionWorkspace({ snapshot, permission, onMode, onRead, onReadAll, onEnableDesktop, onOpen }: Props) {
  return <section className="attentionWorkspace">
    <div className="goalsIntro"><Bell size={22} /><div><strong>需要你关注的进展</strong><p>审批、失败、中断和后续建议会优先提醒；普通完成记录保留在这里。</p></div></div>
    <div className="attentionControls">
      <label>提醒强度 <select value={snapshot.mode} onChange={(event) => void onMode(event.target.value as AttentionSnapshot["mode"])}>
        <option value="off">关闭主动提醒</option><option value="important">仅重要事项</option><option value="all">所有进展</option>
      </select></label>
      {permission === "default" && <button type="button" onClick={() => void onEnableDesktop()}>启用桌面通知</button>}
      {permission === "granted" && <small>桌面通知已启用，后台标签页出现新提醒时显示。</small>}
      {permission === "denied" && <small>浏览器已关闭桌面通知，可在浏览器设置中修改。</small>}
      <button type="button" onClick={() => void onReadAll()} disabled={!snapshot.items.some((item) => !item.read)}>全部标为已读</button>
    </div>
    <div className="attentionList">
      {snapshot.items.length === 0 && <p className="emptyText">目前没有需要查看的进展。</p>}
      {snapshot.items.map((item) => <article key={item.id} className={item.read ? "read" : "unread"}>
        <div><strong>{item.title}</strong><small>{item.priority === "important" ? "重要" : "普通"} · {new Date(item.createdAt).toLocaleString("zh-CN")}</small></div>
        <p>{item.summary}</p>
        <div><button type="button" onClick={() => onOpen(item)}>查看</button>{!item.read && <button type="button" onClick={() => void onRead(item.id)}>标为已读</button>}</div>
      </article>)}
    </div>
  </section>;
}
