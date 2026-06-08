#!/bin/bash

# ========================================
# 🪴 休息喝水提醒脚本
# 每个整点提醒喝水，双数整点增加休息提醒
# ========================================

HOUR=$(date +%H)
MINUTE=$(date +%M)
TOTAL_MIN=$((10#$HOUR * 60 + 10#$MINUTE))
CYCLE=$((TOTAL_MIN / 45))  # 每45分钟一个周期

case $((CYCLE % 3)) in
  0)
    # 第1周期：喝水提醒
    osascript -e "display notification \"💧 端起杯子喝口水吧！
多喝水皮肤好，精神也更集中 💪\" with title \"🥤 喝水时间到\" subtitle \"该补水啦！\" sound name \"default\""
    echo "[$(date)] 💧 喝水提醒已发送"
    ;;
  1)
    # 第2周期：休息提醒
    osascript -e "display notification \"🧘 站起来活动一下！
离开座位走走，看看远方，给眼睛放个假 🌿\" with title \"🚶 休息时间到\" subtitle \"该活动啦！\" sound name \"default\""
    echo "[$(date)] 🚶 休息提醒已发送"
    ;;
  2)
    # 第3周期：综合提醒
    osascript -e "display notification \"🌸 休息 + 喝水双重提醒
☕ 喝杯水
🧘 伸个懒腰
👀 眺望远方20秒\" with title \"🌟 综合健康提醒\" subtitle \"关爱自己～\" sound name \"default\""
    echo "[$(date)] 🌟 综合健康提醒已发送"
    ;;
esac
