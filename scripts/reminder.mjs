#!/usr/bin/env node

/**
 * 🪴 SuperCodex 休息喝水提醒服务
 * 每45分钟循环提醒：喝水 → 休息 → 综合（喝水+休息+伸展）
 * 使用 macOS 原生通知
 */

import { execSync } from "child_process";

const INTERVAL_MS = 45 * 60 * 1000; // 45分钟

const reminders = [
  {
    title: "🥤 喝水时间到",
    subtitle: "该补水啦！",
    message: "💧 端起杯子喝口水吧！\n多喝水皮肤好，精神也更集中 💪",
  },
  {
    title: "🚶 休息时间到",
    subtitle: "该活动啦！",
    message: "🧘 站起来活动一下！\n离开座位走走，看看远方，给眼睛放个假 🌿",
  },
  {
    title: "🌟 综合健康提醒",
    subtitle: "关爱自己～",
    message:
      "🌸 休息 + 喝水双重提醒\n\n☕ 喝杯水\n🧘 伸个懒腰\n👀 眺望远方20秒",
  },
];

function sendNotification(reminder) {
  try {
    const script = `display notification "${reminder.message}" with title "${reminder.title}" subtitle "${reminder.subtitle}" sound name "default"`;
    execSync(`osascript -e ${JSON.stringify(script)}`);
    console.log(
      `[${new Date().toLocaleString()}] ✅ ${reminder.title} - 已发送`
    );
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] ❌ 发送失败:`, err.message);
  }
}

function runCycle() {
  const cycleIndex = Math.floor(Date.now() / INTERVAL_MS) % reminders.length;
  sendNotification(reminders[cycleIndex]);
}

// 首次运行
runCycle();

// 定时循环
setInterval(runCycle, INTERVAL_MS);

console.log(`🪴 休息喝水提醒服务已启动！
  ⏱  间隔: ${INTERVAL_MS / 1000 / 60} 分钟
  🔄 循环: ${reminders.map((r) => r.title).join(" → ")}
  📅 下次提醒: ${new Date(Date.now() + INTERVAL_MS).toLocaleString()}
  ⏹  按 Ctrl+C 停止`);
