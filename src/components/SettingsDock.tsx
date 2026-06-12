import { Check, KeyRound } from "lucide-react";
import type { FormEvent } from "react";
import type { ApiSettings } from "../types";

type SettingsDockProps = {
  settings: ApiSettings;
  status: "idle" | "saving" | "saved" | "error";
  onSubmit: (event: FormEvent) => void;
  onChange: (settings: ApiSettings) => void;
  onStatusReset: () => void;
};

export function SettingsDock({ settings, status, onSubmit, onChange, onStatusReset }: SettingsDockProps) {
  function update(patch: Partial<ApiSettings>) {
    onStatusReset();
    onChange({ ...settings, ...patch });
  }

  return (
    <form className="settingsDock" aria-label="API 设置" onSubmit={onSubmit}>
      <label className="field">
        <span>Base URL</span>
        <input
          type="text"
          value={settings.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label className="field">
        <span>API Key</span>
        <div className="secretInput">
          <KeyRound size={16} />
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder="留空则保留后端已有密钥"
          />
        </div>
      </label>
      <label className="field">
        <span>Model</span>
        <input
          type="text"
          value={settings.model}
          onChange={(event) => update({ model: event.target.value })}
          placeholder="gpt-4.1 / deepseek-chat / ..."
        />
      </label>
      <div className="settingsActions">
        <span className={`settingsStatus ${status}`}>
          {status === "saving" ? "保存中..." : status === "saved" ? "已保存" : status === "error" ? "保存失败" : ""}
        </span>
        <button className="confirmButton" type="submit" disabled={status === "saving"}>
          <Check size={16} />
          确认
        </button>
      </div>
    </form>
  );
}
