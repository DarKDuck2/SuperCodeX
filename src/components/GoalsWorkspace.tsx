import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, CircleCheck, Clock3, FileText, Pause, Play, Plus, Sparkles, Target } from "lucide-react";
import type { Approval, Automation, Goal, GoalArtifact, Project } from "../types";
import { compareArtifactText } from "../lib/artifact-diff";

type Props = {
  goals: Goal[];
  approvals: Approval[];
  approvalMode: "auto" | "manual";
  automations: Automation[];
  projects: Project[];
  selectedGoalId: string;
  onSelect: (id: string) => void;
  onCreate: (input: { projectId: string; title: string; description: string }) => Promise<boolean>;
  onAddTask: (goalId: string, input: { title: string; instruction: string; schedule?: string; watchPath?: string; githubRepo?: string; calendarEvents?: boolean }) => Promise<boolean>;
  onUpdateTask: (goalId: string, taskId: string, input: { title: string; instruction: string }) => Promise<boolean>;
  onReorder: (goalId: string, taskIds: string[], expectedPlanRevision: number) => Promise<boolean>;
  onPlan: (goalId: string) => Promise<void>;
  onReview: (goalId: string) => Promise<void>;
  onSuggestionDecision: (goalId: string, reviewId: string, suggestionId: string, accept: boolean) => Promise<void>;
  onRun: (goalId: string, taskId: string) => Promise<void>;
  onStatus: (goalId: string, status: Goal["status"]) => Promise<void>;
  onCreateArtifact: (goalId: string, title: string, content: string) => Promise<GoalArtifact | undefined>;
  onUpdateArtifact: (goalId: string, artifactId: string, input: { expectedRevision: number; title: string; content: string }) => Promise<GoalArtifact | undefined>;
  onRestoreArtifact: (goalId: string, artifactId: string, expectedRevision: number, sourceRevision: number) => Promise<GoalArtifact | undefined>;
  onDeleteArtifact: (goalId: string, artifactId: string, expectedRevision: number) => Promise<boolean>;
  onDecision: (approvalId: string, approved: boolean) => Promise<void>;
  onOpenConversation: (id: string) => void;
};

const taskStatusText: Record<Goal["tasks"][number]["status"], string> = {
  planned: "待执行",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "已中断"
};

export function GoalsWorkspace(props: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskInstruction, setTaskInstruction] = useState("");
  const [taskSchedule, setTaskSchedule] = useState("");
  const [watchPath, setWatchPath] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [calendarEvents, setCalendarEvents] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = props.goals.find((goal) => goal.id === props.selectedGoalId) || props.goals[0];
  const [artifactDraft, setArtifactDraft] = useState<{ id: string; title: string; content: string; revision: number } | undefined>();
  const [artifactPreview, setArtifactPreview] = useState(false);
  const [historyRevision, setHistoryRevision] = useState<number | undefined>();
  const currentArtifact = selected?.artifacts?.find((item) => item.id === artifactDraft?.id);
  const selectedHistory = currentArtifact?.history?.find((version) => version.revision === historyRevision);
  const artifactDiff = useMemo(() => selectedHistory && currentArtifact
    ? compareArtifactText(selectedHistory.content, currentArtifact.content)
    : undefined, [selectedHistory?.content, currentArtifact?.content]);
  const artifactChangedElsewhere = Boolean(currentArtifact && artifactDraft && currentArtifact.revision !== artifactDraft.revision);
  const artifactDirty = Boolean(artifactDraft && (artifactDraft.id
    ? currentArtifact && (artifactDraft.title !== currentArtifact.title || artifactDraft.content !== currentArtifact.content)
    : artifactDraft.title || artifactDraft.content));
  const reorderableTasks = selected?.tasks.filter((task) => ["planned", "failed", "interrupted"].includes(task.status)) || [];
  const pendingApprovals = props.approvals.filter((approval) => approval.status === "pending");

  useEffect(() => {
    const first = selected?.artifacts?.[0];
    setArtifactDraft(first ? { id: first.id, title: first.title, content: first.content, revision: first.revision } : undefined);
    setArtifactPreview(false);
    setHistoryRevision(undefined);
  }, [selected?.id]);

  function selectArtifact(artifact: GoalArtifact) {
    if (artifactDirty && !window.confirm("当前文稿有未保存的修改，确定重新载入或切换？")) return;
    setArtifactDraft({ id: artifact.id, title: artifact.title, content: artifact.content, revision: artifact.revision });
    setArtifactPreview(false);
    setHistoryRevision(undefined);
  }

  function selectGoal(goalId: string) {
    if (selected?.id !== goalId && artifactDirty && !window.confirm("当前文稿有未保存的修改，确定切换目标？")) return;
    props.onSelect(goalId);
  }

  async function saveArtifact() {
    if (!selected || !artifactDraft?.title.trim()) return;
    setBusy(true);
    try {
      const saved = artifactDraft.id
        ? await props.onUpdateArtifact(selected.id, artifactDraft.id, { expectedRevision: artifactDraft.revision, title: artifactDraft.title.trim(), content: artifactDraft.content })
        : await props.onCreateArtifact(selected.id, artifactDraft.title.trim(), artifactDraft.content);
      if (saved) {
        setArtifactDraft({ id: saved.id, title: saved.title, content: saved.content, revision: saved.revision });
        setHistoryRevision(undefined);
      }
    } finally { setBusy(false); }
  }

  async function deleteArtifact() {
    if (!selected || !artifactDraft?.id || !window.confirm(`确定删除文稿「${artifactDraft.title}」？`)) return;
    setBusy(true);
    try {
      if (await props.onDeleteArtifact(selected.id, artifactDraft.id, artifactDraft.revision)) {
        const next = selected.artifacts?.find((item) => item.id !== artifactDraft.id);
        setArtifactDraft(next ? { id: next.id, title: next.title, content: next.content, revision: next.revision } : undefined);
        setHistoryRevision(undefined);
      }
    } finally { setBusy(false); }
  }

  async function restoreArtifact() {
    if (!selected || !artifactDraft?.id || !selectedHistory || artifactChangedElsewhere) return;
    if (!window.confirm(artifactDirty
      ? `当前修改尚未保存。确定丢弃修改，并将版本 ${selectedHistory.revision} 恢复为新版本？`
      : `确定将版本 ${selectedHistory.revision} 恢复为新版本？`)) return;
    setBusy(true);
    try {
      const restored = await props.onRestoreArtifact(selected.id, artifactDraft.id, artifactDraft.revision, selectedHistory.revision);
      if (restored) {
        setArtifactDraft({ id: restored.id, title: restored.title, content: restored.content, revision: restored.revision });
        setHistoryRevision(undefined);
        setArtifactPreview(false);
      }
    } finally { setBusy(false); }
  }

  function approvalSource(approval: Approval) {
    if (approval.goalId) return `目标：${props.goals.find((goal) => goal.id === approval.goalId)?.title || approval.goalId}`;
    if (approval.automationId) return `定时任务：${props.automations.find((automation) => automation.id === approval.automationId)?.title || approval.automationId}`;
    const conversation = props.projects.flatMap((project) => project.conversations).find((item) => item.id === approval.conversationId);
    return `会话：${conversation?.title || approval.conversationId || "未知"}`;
  }

  async function submitGoal(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (await props.onCreate({ projectId: projectId || props.projects[0]?.id || "", title: title.trim(), description: description.trim() })) {
        setTitle("");
        setDescription("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (!selected || !taskTitle.trim() || !taskInstruction.trim()) return;
    setBusy(true);
    try {
      if (await props.onAddTask(selected.id, { title: taskTitle.trim(), instruction: taskInstruction.trim(), schedule: taskSchedule.trim(), watchPath: watchPath.trim(), githubRepo: githubRepo.trim(), calendarEvents })) {
        setTaskTitle("");
        setTaskInstruction("");
        setTaskSchedule("");
        setWatchPath("");
        setGithubRepo("");
        setCalendarEvents(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveTask(taskId: string) {
    if (!selected || !editTitle.trim() || !editInstruction.trim()) return;
    setBusy(true);
    try {
      if (await props.onUpdateTask(selected.id, taskId, { title: editTitle.trim(), instruction: editInstruction.trim() })) {
        setEditingTaskId("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function moveTask(taskId: string, direction: -1 | 1) {
    if (!selected) return;
    const taskIds = reorderableTasks.map((task) => task.id);
    const index = taskIds.indexOf(taskId);
    const otherIndex = index + direction;
    if (index < 0 || otherIndex < 0 || otherIndex >= taskIds.length) return;
    [taskIds[index], taskIds[otherIndex]] = [taskIds[otherIndex], taskIds[index]];
    setBusy(true);
    try { await props.onReorder(selected.id, taskIds, selected.planRevision || 0); }
    finally { setBusy(false); }
  }

  async function runWithBusy(operation: () => Promise<void>) {
    setBusy(true);
    try { await operation(); }
    finally { setBusy(false); }
  }

  return (
    <section className="goalsWorkspace">
      <div className="goalsIntro">
        <Target size={22} />
        <div>
          <strong>让目标持续推进</strong>
          <p>把长期目标拆成可执行步骤。步骤在本地服务中后台运行，进展和结果会保留在目标下。</p>
        </div>
      </div>
      {props.approvalMode === "manual" && pendingApprovals.length > 0 && <section className="goalApprovals">
        <h2>等待你批准的操作</h2>
        {pendingApprovals.map((approval) => <article key={approval.id}>
          <strong>{approval.toolName} · {approvalSource(approval)}</strong>
          <code>{approval.summary}</code>
          <div><button type="button" onClick={() => props.onDecision(approval.id, false)}>拒绝</button><button type="button" onClick={() => props.onDecision(approval.id, true)}>批准这次操作</button></div>
        </article>)}
      </section>}
      <section className="goalApprovals">
        <h2>工具执行记录</h2>
        <p className="emptyText">{props.approvalMode === "auto" ? "操作默认自动放行，执行前后均会保存记录。" : "手动审批模式下，已处理的操作会保留在这里。"}</p>
        {props.approvals.filter((approval) => approval.status !== "pending").length === 0 && <p className="emptyText">暂无执行记录。</p>}
        {props.approvals.filter((approval) => approval.status !== "pending").slice(0, 30).map((approval) => <article key={approval.id}>
          <strong>{approval.toolName} · {approvalSource(approval)}</strong>
          <small>{approval.status === "approved" ? approval.executionStatus === "succeeded" ? "执行成功" : approval.executionStatus === "failed" ? "执行失败" : approval.executionStatus === "interrupted" ? "结果待核对" : "已放行，结果待确认" : approval.status === "rejected" ? "已拒绝" : "已取消"} · {approval.decisionSource === "automatic" ? "自动放行" : approval.decisionSource === "user" ? "人工处理" : "系统处理"} · {new Date(approval.executedAt || approval.decidedAt || approval.createdAt).toLocaleString("zh-CN")}</small>
          <details><summary>查看操作参数与结果</summary><code>{approval.summary}</code>{approval.resultSummary && <p>{approval.resultSummary}</p>}</details>
        </article>)}
      </section>
      <form className="goalCreateForm" onSubmit={submitGoal}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：持续跟进目标岗位与项目机会" maxLength={120} required />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="目标背景、限制条件、完成标准" maxLength={5000} rows={2} />
        <div className="goalFormFooter">
          <select value={projectId || props.projects[0]?.id || ""} onChange={(event) => setProjectId(event.target.value)}>
            {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button type="submit" disabled={busy || !props.projects.length}><Plus size={16} /> 创建目标</button>
        </div>
      </form>
      <div className="goalsColumns">
        <div className="goalList">
          <h2>目标列表</h2>
          {props.goals.length === 0 && <p className="emptyText">还没有长期目标。</p>}
          {props.goals.map((goal) => (
            <button type="button" key={goal.id} className={`goalListItem ${selected?.id === goal.id ? "selected" : ""}`} onClick={() => selectGoal(goal.id)}>
              <strong>{goal.title}</strong>
              <small>{goal.status === "active" ? "进行中" : goal.status === "paused" ? "已暂停" : "已完成"} · {goal.tasks.filter((task) => task.status === "completed").length}/{goal.tasks.length} 步完成</small>
            </button>
          ))}
        </div>
        {selected && (
          <div className="goalDetail">
            <div className="goalDetailHead">
              <div><h2>{selected.title}</h2><p>{selected.description || "暂无目标说明"}</p></div>
              <div className="goalActions">
                <button type="button" onClick={() => props.onOpenConversation(selected.conversationId)}>打开会话 <ArrowRight size={15} /></button>
                {selected.status === "active" ? <button type="button" onClick={() => props.onStatus(selected.id, "paused")}><Pause size={15} /> 暂停</button> : <button type="button" onClick={() => props.onStatus(selected.id, "active")}><Play size={15} /> 恢复</button>}
                {selected.status !== "completed" && <button type="button" onClick={() => props.onStatus(selected.id, "completed")}><CircleCheck size={15} /> 完成目标</button>}
              </div>
            </div>
            <div className="goalSectionHead"><h3>执行计划</h3><button type="button" disabled={busy || selected.status === "completed"} onClick={() => void runWithBusy(() => props.onPlan(selected.id))}><Sparkles size={15} /> AI 生成步骤</button></div>
            {reorderableTasks.length > 1 && <p className="goalOrderHint">用步骤右侧箭头调整未完成步骤的顺序；已完成、排队和运行中的步骤保留在原位置。</p>}
            <div className="goalTasks">
              {selected.tasks.length === 0 && <p className="emptyText">生成计划或手动添加第一个步骤。</p>}
              {selected.tasks.map((task, index) => (
                <article key={task.id} className="goalTask">
                  <div className="goalTaskTop"><strong>{index + 1}. {task.title}</strong><div className="goalTaskOrder"><span className={`goalTaskStatus ${task.status}`}>{taskStatusText[task.status]}</span>{selected.status !== "completed" && ["planned", "failed", "interrupted"].includes(task.status) && <><button type="button" aria-label={`上移 ${task.title}`} title="上移步骤" disabled={busy || reorderableTasks[0]?.id === task.id} onClick={() => void moveTask(task.id, -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`下移 ${task.title}`} title="下移步骤" disabled={busy || reorderableTasks[reorderableTasks.length - 1]?.id === task.id} onClick={() => void moveTask(task.id, 1)}><ArrowDown size={14} /></button></>}</div></div>
                  {editingTaskId === task.id ? <div className="goalTaskEdit">
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={120} aria-label="步骤名称" />
                    <textarea value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} maxLength={5000} rows={3} aria-label="执行说明" />
                    <div><button type="button" disabled={busy || !editTitle.trim() || !editInstruction.trim()} onClick={() => void saveTask(task.id)}>保存修改</button><button type="button" onClick={() => setEditingTaskId("")}>取消</button></div>
                  </div> : <p>{task.instruction}</p>}
                  {task.schedule && <small>定期执行：{task.schedule}{task.nextRunAt ? ` · 下次 ${new Date(task.nextRunAt).toLocaleString("zh-CN")}` : ""}</small>}
                  {task.fileTrigger && <small>文件变化时执行：{task.fileTrigger.path}</small>}
                  {task.githubReleaseTrigger && <small>GitHub 新 Release 时执行：{task.githubReleaseTrigger.repo} · 下次检查 {new Date(task.githubReleaseTrigger.nextCheckAt).toLocaleString("zh-CN")}{task.githubReleaseTrigger.lastError ? ` · 最近错误：${task.githubReleaseTrigger.lastError}` : ""}</small>}
                  {task.calendarEventTrigger && <small>日历新增或更新事件时执行 · 下次检查 {new Date(task.calendarEventTrigger.nextCheckAt).toLocaleString("zh-CN")}{task.calendarEventTrigger.lastError ? ` · 最近错误：${task.calendarEventTrigger.lastError}` : ""}</small>}
                  {task.result && <p className="goalTaskResult">{task.result}</p>}
                  {task.error && <p className="goalTaskError">{task.error}</p>}
                  {selected.status !== "completed" && ["planned", "failed", "interrupted"].includes(task.status) && editingTaskId !== task.id && <button type="button" onClick={() => { setEditingTaskId(task.id); setEditTitle(task.title); setEditInstruction(task.instruction); }}>修改步骤</button>}
                  {selected.status === "active" && task.status !== "queued" && task.status !== "running" && <button type="button" onClick={() => props.onRun(selected.id, task.id)}><Play size={14} /> {task.runCount ? "重新执行" : "后台执行"}</button>}
                </article>
              ))}
            </div>
            <div className="goalSectionHead"><h3>步骤复盘与后续建议</h3><button type="button" disabled={busy || !selected.tasks.some((task) => task.status === "completed")} onClick={() => void runWithBusy(() => props.onReview(selected.id))}><Sparkles size={15} /> 复盘最近步骤</button></div>
            <div className="goalReviews">
              {!selected.reviews?.length && <p className="emptyText">完成最后一个非定期步骤后，Agent 会提出可审查的后续建议。</p>}
              {selected.reviews?.slice(0, 5).map((review) => <article key={review.id} className="goalReview">
                <small>{selected.tasks.find((task) => task.id === review.taskId)?.title || "已完成步骤"} · 第 {review.runCount} 次执行 · {new Date(review.createdAt).toLocaleString("zh-CN")}</small>
                <p>{review.summary}</p>
                {review.suggestions.length === 0 && <small>暂无新的后续步骤</small>}
                {review.suggestions.map((suggestion) => <div className="goalSuggestion" key={suggestion.id}>
                  <strong>{suggestion.title}</strong>
                  <p>{suggestion.instruction}</p>
                  <small>理由：{suggestion.reason}</small>
                  {suggestion.status === "pending" && selected.status !== "completed" ? <div>
                    <button type="button" disabled={busy} onClick={() => void runWithBusy(() => props.onSuggestionDecision(selected.id, review.id, suggestion.id, true))}>加入计划</button>
                    <button type="button" disabled={busy} onClick={() => void runWithBusy(() => props.onSuggestionDecision(selected.id, review.id, suggestion.id, false))}>忽略</button>
                  </div> : <small>{suggestion.status === "accepted" ? "已加入计划" : suggestion.status === "dismissed" ? "已忽略" : "目标已完成"}</small>}
                </div>)}
              </article>)}
            </div>
            <div className="goalSectionHead"><h3>目标文稿</h3><button type="button" disabled={busy || (selected.artifacts?.length || 0) >= 12} onClick={() => { if (artifactDirty && !window.confirm("当前文稿有未保存的修改，确定新建？")) return; setArtifactDraft({ id: "", title: "", content: "", revision: 0 }); setArtifactPreview(false); setHistoryRevision(undefined); }}><Plus size={15} /> 新建文稿</button></div>
            <div className="goalArtifactWorkspace">
              <div className="goalArtifactList">
                {!selected.artifacts?.length && <p className="emptyText">还没有文稿。可以在这里新建，也可以让目标步骤持续更新报告或清单。</p>}
                {selected.artifacts?.map((artifact) => <button type="button" key={artifact.id} className={artifactDraft?.id === artifact.id ? "selected" : ""} onClick={() => selectArtifact(artifact)}><FileText size={15} /><span>{artifact.title}<small>版本 {artifact.revision} · {artifact.updatedBy === "agent" ? "Agent 更新" : "你更新"}</small></span></button>)}
              </div>
              {artifactDraft && <div className="goalArtifactEditor">
                <div className="goalArtifactEditorHead"><strong>{artifactDraft.id ? "编辑目标文稿" : "新建目标文稿"}</strong><div><button type="button" onClick={() => setArtifactPreview((value) => !value)}>{artifactPreview ? "编辑" : "预览"}</button>{artifactDraft.id && <button type="button" onClick={() => void deleteArtifact()} disabled={busy}>删除</button>}</div></div>
                {artifactChangedElsewhere && <p className="goalTaskError">文稿已在后台更新。保存前请重新载入，避免覆盖新内容。<button type="button" onClick={() => currentArtifact && selectArtifact(currentArtifact)}>重新载入</button></p>}
                {artifactPreview ? <div className="goalArtifactPreview"><h4>{artifactDraft.title || "未命名文稿"}</h4><p>{artifactDraft.content || "暂无内容"}</p></div> : <><input value={artifactDraft.title} onChange={(event) => setArtifactDraft((current) => current && { ...current, title: event.target.value })} maxLength={120} aria-label="文稿名称" placeholder="文稿名称" /><textarea value={artifactDraft.content} onChange={(event) => setArtifactDraft((current) => current && { ...current, content: event.target.value })} maxLength={30000} rows={12} aria-label="文稿内容" placeholder="在这里持续维护报告、清单或说明" /></>}
                <div className="goalArtifactFooter"><small>{artifactDraft.id ? `版本 ${artifactDraft.revision}` : "新文稿"} · {artifactDraft.content.length}/30000 字</small><button type="button" onClick={() => void saveArtifact()} disabled={busy || !artifactDraft.title.trim() || artifactChangedElsewhere}>保存文稿</button></div>
                {currentArtifact && <div className="goalArtifactHistory">
                  <div className="goalArtifactHistoryHead"><strong>历史版本</strong><small>保留最近 20 个旧版本；恢复会生成新版本</small></div>
                  {currentArtifact.history?.length ? <>
                    <div className="goalArtifactHistoryList">{currentArtifact.history.map((version) => <button type="button" key={version.revision} className={historyRevision === version.revision ? "selected" : ""} onClick={() => setHistoryRevision(version.revision)}>版本 {version.revision} · {version.updatedBy === "agent" ? "Agent 更新" : "你更新"} · {new Date(version.updatedAt).toLocaleString("zh-CN")}{version.restoredFromRevision ? ` · 从版本 ${version.restoredFromRevision} 恢复` : ""}</button>)}</div>
                    {selectedHistory && <div className="goalArtifactHistoricalPreview">
                      <div><strong>版本 {selectedHistory.revision}：{selectedHistory.title}</strong><button type="button" onClick={() => void restoreArtifact()} disabled={busy || artifactChangedElsewhere}>恢复为新版本</button></div>
                      <small>与当前保存的版本 {currentArtifact.revision} 对比{selectedHistory.title !== currentArtifact.title ? ` · 当前标题：${currentArtifact.title}` : ""}。红色为旧版内容，绿色为当前内容。</small>
                      {artifactDiff ? <div className="goalArtifactDiff">{artifactDiff.map((line, index) => <div key={index} className={`goalArtifactDiffLine ${line.kind}`}><span>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><code>{line.text || " "}</code></div>)}</div>
                        : <div className="goalArtifactSideBySide"><div><strong>版本 {selectedHistory.revision}</strong><p>{selectedHistory.content || "暂无内容"}</p></div><div><strong>当前版本 {currentArtifact.revision}</strong><p>{currentArtifact.content || "暂无内容"}</p></div></div>}
                    </div>}
                  </> : <small>保存修改后可在这里查看旧版本。</small>}
                </div>}
              </div>}
            </div>
            <div className="goalSectionHead"><h3>目标文件</h3><small>保存交付快照；超过 100 MB 的文件保留实时链接</small></div>
            <div className="goalFileList">
              {!selected.files?.length && <p className="emptyText">步骤生成的文件会保存在这里，便于从目标直接下载。</p>}
              {selected.files?.map((file) => <div key={file.id} className="goalFileEntry"><a href={`/api/goals/${selected.id}/files/${file.id}/content`} className="goalFileItem" title={file.path}>
                <FileText size={17} /><span><strong>{file.title}</strong><small>{file.path} · {(file.size / 1024).toFixed(1)} KB · {file.snapshotSha256 ? `快照版本 ${file.revision}` : "实时文件"} · {selected.tasks.find((task) => task.id === file.taskId)?.title || "目标步骤"} · {new Date(file.updatedAt).toLocaleString("zh-CN")}</small></span>
              </a>{Boolean(file.history?.length) && <div className="goalFileVersions"><small>旧版本</small>{file.history?.map((version) => <a key={version.revision} href={`/api/goals/${selected.id}/files/${file.id}/content?revision=${version.revision}`}>版本 {version.revision} · {version.title} · {new Date(version.updatedAt).toLocaleString("zh-CN")}</a>)}</div>}</div>)}
            </div>
            {selected.status !== "completed" && <form className="goalTaskForm" onSubmit={submitTask}>
              <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="步骤名称" maxLength={120} required />
              <textarea value={taskInstruction} onChange={(event) => setTaskInstruction(event.target.value)} placeholder="具体要完成什么、如何验证" rows={2} maxLength={5000} required />
              <input value={taskSchedule} onChange={(event) => setTaskSchedule(event.target.value)} placeholder="可选：每天 09:00 或每2小时" />
              <input value={watchPath} onChange={(event) => setWatchPath(event.target.value)} placeholder="可选：监听工作区内的文件路径，例如 docs/status.md" />
              <input value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="可选：监控公开 GitHub 仓库的 Release，例如 openai/openai-node" />
              <label className="goalTriggerCheckbox"><input type="checkbox" checked={calendarEvents} onChange={(event) => setCalendarEvents(event.target.checked)} />监控已连接的 Google 日历：未来七天新增或更新事件时执行</label>
              <button type="submit" disabled={busy}><Plus size={15} /> 添加步骤</button>
            </form>}
            <div className="goalSectionHead"><h3>活动记录</h3></div>
            <div className="goalActivity">
              {selected.activity.slice(0, 30).map((event) => <div key={event.id}><Clock3 size={14} /><span>{event.text}</span><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></div>)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
