import { FormEvent, useState } from "react";
import { Brain, Plus } from "lucide-react";
import type { Goal, MemoryCandidate, MemoryFact } from "../types";

type Props = {
  memories: MemoryFact[];
  candidates: MemoryCandidate[];
  goals: Goal[];
  onCreate: (input: { content: string; scope: MemoryFact["scope"]; goalId?: string; useMode: NonNullable<MemoryFact["useMode"]> }) => Promise<boolean>;
  onUpdate: (id: string, content: string) => Promise<boolean>;
  onUseMode: (id: string, useMode: NonNullable<MemoryFact["useMode"]>) => Promise<void>;
  onForget: (id: string) => Promise<void>;
  onDecideCandidate: (id: string, accept: boolean, content?: string) => Promise<void>;
};

export function MemoryWorkspace({ memories, candidates, goals, onCreate, onUpdate, onUseMode, onForget, onDecideCandidate }: Props) {
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryFact["scope"]>("personal");
  const [useMode, setUseMode] = useState<NonNullable<MemoryFact["useMode"]>>("relevant");
  const [goalId, setGoalId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editContent, setEditContent] = useState("");
  const [candidateEdits, setCandidateEdits] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    if (await onCreate({ content: content.trim(), scope, goalId: scope === "goal" ? goalId : undefined, useMode })) setContent("");
  }

  return <section className="memoryWorkspace">
    <div className="goalsIntro"><Brain size={22} /><div><strong>由你管理的记忆</strong><p>记录稳定的偏好和背景，决定每条记忆何时进入 Agent 上下文；你可以随时修改或忘记。</p></div></div>
    <form className="goalCreateForm" onSubmit={submit}>
      <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={3} maxLength={500} required placeholder="例如：我的报告默认使用中文，附上可核对的来源。" />
      <div className="goalFormFooter">
        <select value={scope} onChange={(event) => setScope(event.target.value as MemoryFact["scope"])}><option value="personal">跨会话范围</option><option value="goal">指定目标</option></select>
        {scope === "goal" && <select value={goalId} onChange={(event) => setGoalId(event.target.value)} required><option value="">选择目标</option>{goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select>}
        <select value={useMode} onChange={(event) => setUseMode(event.target.value as NonNullable<MemoryFact["useMode"]>)} aria-label="新记忆的使用方式"><option value="relevant">相关任务使用</option><option value="always">{scope === "goal" ? "目标内始终使用" : "始终提供给 Agent"}</option><option value="private">仅本地保存</option></select>
        <button type="submit"><Plus size={16} /> 记住</button>
      </div>
    </form>
    <div className="memoryList">
      <h3>待确认的记忆 {candidates.length ? `(${candidates.length})` : ""}</h3>
      {candidates.length === 0 && <p className="emptyText">对话中明确表达的长期偏好会在这里等待确认。</p>}
      {candidates.map((candidate) => <article key={candidate.id}>
        <small>来自用户原话 · 置信度 {Math.round(candidate.confidence * 100)}%</small>
        <textarea value={candidateEdits[candidate.id] ?? candidate.content} onChange={(event) => setCandidateEdits((current) => ({ ...current, [candidate.id]: event.target.value }))} maxLength={500} rows={2} aria-label="修正候选记忆" />
        <blockquote>“{candidate.sourceQuote}”</blockquote>
        <div><button type="button" onClick={() => void onDecideCandidate(candidate.id, true, candidateEdits[candidate.id] ?? candidate.content)}>记住</button><button type="button" onClick={() => void onDecideCandidate(candidate.id, false)}>忽略</button></div>
      </article>)}
    </div>
    <div className="memoryList">
      <h3>已保存的记忆</h3>
      {memories.length === 0 && <p className="emptyText">还没有保存的记忆。</p>}
      {memories.map((memory) => <article key={memory.id}>
        <small>{memory.scope === "personal" ? "跨会话范围" : `目标：${goals.find((goal) => goal.id === memory.goalId)?.title || "已移除"}`}</small>
        {editingId === memory.id ? <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} maxLength={500} rows={3} /> : <p>{memory.content}</p>}
        {memory.sourceQuote && <blockquote>来源原话：“{memory.sourceQuote}”</blockquote>}
        <select value={memory.useMode || "relevant"} onChange={(event) => void onUseMode(memory.id, event.target.value as NonNullable<MemoryFact["useMode"]>)} aria-label={`记忆使用方式：${memory.content.slice(0, 30)}`}><option value="relevant">相关任务使用</option><option value="always">{memory.scope === "goal" ? "目标内始终使用" : "始终提供给 Agent"}</option><option value="private">仅本地保存</option></select>
        <div>
          {editingId === memory.id ? <><button type="button" onClick={async () => { if (await onUpdate(memory.id, editContent.trim())) setEditingId(""); }}>保存</button><button type="button" onClick={() => setEditingId("")}>取消</button></> : <><button type="button" onClick={() => { setEditingId(memory.id); setEditContent(memory.content); }}>编辑</button><button type="button" onClick={() => { if (window.confirm("确定忘记这条记忆？")) void onForget(memory.id); }}>忘记</button></>}
        </div>
      </article>)}
    </div>
  </section>;
}
