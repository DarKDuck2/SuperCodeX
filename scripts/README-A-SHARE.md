# 📊 A股收盘行情自动推送

## 文件说明

| 文件 | 说明 |
|------|------|
| `a-share-report.mjs` | **基础版** — 获取行情并输出到终端 |
| `a-share-report-with-mail.mjs` | **邮件版** — 获取行情并通过邮件发送 |

## 快速使用

### 1️⃣ 手动运行测试

```bash
# 基础版
node scripts/a-share-report.mjs

# 邮件版（需先配置 .env）
node scripts/a-share-report-with-mail.mjs
```

### 2️⃣ 配置邮件推送（可选）

在项目根目录 `.env` 中添加：

```env
MAIL_HOST=smtp.qq.com
MAIL_PORT=465
MAIL_USER=your@qq.com
MAIL_PASS=你的邮箱授权码     # QQ邮箱需在设置中生成授权码，非登录密码
MAIL_TO=receiver@email.com
```

> 💡 各大邮箱 SMTP 配置：
> - **QQ邮箱**: smtp.qq.com:465，授权码在「设置-账户-POP3/IMAP」生成
> - **163邮箱**: smtp.163.com:465
> - **Gmail**: smtp.gmail.com:465（需App Password）
> - **Outlook**: smtp.office365.com:587

### 3️⃣ 设置每天15:00自动推送

```bash
# 编辑 crontab
crontab -e
```

添加以下任一行：

```cron
# ─── 基础版：输出到日志 ───
0 15 * * 1-5 cd /Users/a1021500689/Documents/SuperCodex && /usr/local/bin/node scripts/a-share-report.mjs >> /tmp/a-share.log 2>&1

# ─── 邮件版：自动发送邮件 ───
0 15 * * 1-5 cd /Users/a1021500689/Documents/SuperCodex && /usr/local/bin/node scripts/a-share-report-with-mail.mjs >> /tmp/a-share.log 2>&1
```

> 🔍 查看你的 node 路径：`which node`
> 
> `1-5` 表示仅交易日（周一至周五）运行。
> 如想每天运行（含周末），改为 `*`。

### 4️⃣ 查看推送日志

```bash
tail -f /tmp/a-share.log
```

## 效果预览

运行结果示例：

```
📊 A股收盘速报  2026-06-08
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏛️ 【主要指数】
  🔴 上证指数    3959.34    -1.70%
  🔴 深证成指   14821.19    -3.22%
  🔴 创业板指    3811.79    -3.69%
  🔴 国证2000   10551.92    -3.23%
  🔴 科创50      1596.57    -4.30%
  🔴 中证1000    8081.26    -3.11%

🔥 【热门板块 TOP10】
   1. 🟢 其他数字媒体     +12.42%
   2. 🟢 机器人            +3.76%
   ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 数据来源: 东方财富 | 自动推送 @ 15:00
```

## 数据说明

- **指数**: 上证指数、深证成指、创业板指、国证2000、科创50、中证1000
- **板块**: 东方财富行业板块涨幅TOP10
- **来源**: 东方财富公开行情API
- **时间**: 每个交易日 15:00 收盘后推送
