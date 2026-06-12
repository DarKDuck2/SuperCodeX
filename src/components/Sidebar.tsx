import { AlarmClock, Bot, Globe2, Grid3X3, PanelLeft, PenLine, Search } from "lucide-react";
import type { ActiveView, ConversationSummary } from "../types";

type HistoryItem = ConversationSummary & {
  projectName: string;
};

type SidebarProps = {
  activeView: ActiveView;
  activeConversationId: string;
  historyItems: HistoryItem[];
  isCollapsed: boolean;
  unreadAutomationCount: number;
  onCreateTask: () => void;
  onLoadMessages: (conversationId: string) => void;
  onSelectView: (view: ActiveView) => void;
  onToggleCollapsed: () => void;
};

export function Sidebar({
  activeView,
  activeConversationId,
  historyItems,
  isCollapsed,
  unreadAutomationCount,
  onCreateTask,
  onLoadMessages,
  onSelectView,
  onToggleCollapsed
}: SidebarProps) {
  return (
    <aside className="sideRail">
      <div className="windowChrome">
        <button
          className={`sidebarIconButton ${activeView === "search" ? "active" : ""}`}
          type="button"
          title="搜索"
          onClick={() => onSelectView("search")}
        >
          <Search size={18} />
        </button>
        <button
          className="sidebarIconButton sidebarToggle"
          type="button"
          title={isCollapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onToggleCollapsed}
        >
          <PanelLeft size={18} />
        </button>
      </div>

      <div className="sideBrand">
        <div className="sideBrandMark">
          <Bot size={18} />
        </div>
        <div className="sideBrandText">
          <strong>SuperCodex</strong>
          <span>通用办公 Agent</span>
        </div>
      </div>

      <nav className="primaryNav">
        <button className={`navButton ${activeView === "home" ? "active" : ""}`} type="button" onClick={onCreateTask}>
          <PenLine size={19} />
          <span className="navText">新建任务</span>
          <kbd>⌘ K</kbd>
        </button>
        <button className={`navButton ${activeView === "skills" ? "active" : ""}`} type="button" onClick={() => onSelectView("skills")}>
          <Grid3X3 size={19} />
          <span className="navText">技能</span>
        </button>
        <button className={`navButton ${activeView === "automations" ? "active" : ""}`} type="button" onClick={() => onSelectView("automations")}>
          <AlarmClock size={19} />
          <span className="navText">定时任务</span>
          {unreadAutomationCount > 0 && <span className="navBadge">{unreadAutomationCount}</span>}
        </button>
        <button className={`navButton ${activeView === "webbridge" ? "active" : ""}`} type="button" onClick={() => onSelectView("webbridge")}>
          <Globe2 size={19} />
          <span className="navText">WebBridge</span>
        </button>
      </nav>

      <section className="sideSection">
        <div className="sideLabel">历史记录</div>
        <div className="historyList">
          {historyItems.length === 0 ? (
            <p className="sideHint">暂无历史对话</p>
          ) : (
            historyItems.map((conversation) => (
              <button
                className={`conversationItem ${conversation.id === activeConversationId ? "active" : ""}`}
                type="button"
                key={conversation.id}
                onClick={() => onLoadMessages(conversation.id)}
              >
                <span>
                  <strong>{conversation.title}</strong>
                  <small>{conversation.projectName}</small>
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
