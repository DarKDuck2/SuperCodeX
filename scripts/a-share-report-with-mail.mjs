#!/usr/bin/env node

/**
 * A股收盘行情推送脚本（邮件版）
 * 抓取行情后通过邮件发送
 *
 * 使用前先配置环境变量:
 *   MAIL_USER=your@email.com
 *   MAIL_PASS=your_password_or_app_password
 *   MAIL_TO=receiver@email.com
 *   MAIL_HOST=smtp.qq.com (或 smtp.gmail.com 等)
 *   MAIL_PORT=465
 *
 * 配合 crontab 每天 15:00 执行
 */

import { createTransport } from 'nodemailer';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname });

// ── 配置 ──────────────────────────────────
const INDICES = [
  { code: '1.000001', name: '上证指数' },
  { code: '0.399001', name: '深证成指' },
  { code: '0.399006', name: '创业板指' },
  { code: '0.399303', name: '国证2000' },
  { code: '1.000688', name: '科创50' },
  { code: '0.399852', name: '中证1000' },
];

const INDEX_API =
  'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f169,f170,f171';

const HOT_SECTORS_URL =
  'https://push2.eastmoney.com/api/qt/clist/get?cb=&pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f4,f12,f14';

// ── 工具函数 ──────────────────────────────
const fmt = (n, d = 2) => (n === undefined || isNaN(n) ? '—' : Number(n).toFixed(d));
const pct = v => {
  if (v === undefined || isNaN(v)) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const bar = v => (v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪');
const dateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── 数据获取 ──────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: 'https://quote.eastmoney.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchIndices() {
  const codes = INDICES.map(i => i.code).join(',');
  const json = await fetchJSON(`${INDEX_API}&secids=${codes}`);
  if (!json?.data?.diff) throw new Error('指数数据异常');
  return json.data.diff.map(item => ({
    name: item.f14,
    price: fmt(item.f2),
    change: fmt(item.f4),
    changePct: pct(item.f3),
    emoji: bar(item.f3),
  }));
}

async function fetchSectors() {
  const json = await fetchJSON(HOT_SECTORS_URL);
  if (!json?.data?.diff) return [];
  return json.data.diff.slice(0, 10).map(item => ({
    name: item.f14,
    changePct: pct(item.f3),
    emoji: bar(item.f3),
  }));
}

// ── 构建HTML报告 ──────────────────────────
function buildHTML(indices, sectors, date) {
  const indexRows = indices
    .map(i => `<tr><td>${i.emoji}</td><td>${i.name}</td><td align="right">${i.price}</td><td align="right" style="color:${i.changePct.startsWith('+') ? '#e74c3c' : '#27ae60'}">${i.changePct}</td></tr>`)
    .join('\n');

  const sectorRows = sectors
    .map((s, idx) => `<tr><td>${idx + 1}</td><td>${s.emoji}</td><td>${s.name}</td><td align="right" style="color:${s.changePct.startsWith('+') ? '#e74c3c' : '#27ae60'}">${s.changePct}</td></tr>`)
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, PingFang SC, Helvetica Neue, sans-serif; padding: 20px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .date { color: #888; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: #f5f6fa; padding: 10px 12px; text-align: left; font-size: 13px; color: #666; }
  td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  .footer { margin-top: 20px; color: #aaa; font-size: 12px; }
  .red { color: #e74c3c; }
  .green { color: #27ae60; }
</style></head>
<body>
  <h1>📊 A股收盘速报</h1>
  <div class="date">${date} · 每日15:00自动推送</div>

  <h3>🏛️ 主要指数</h3>
  <table>
    <tr><th></th><th>指数</th><th align="right">最新价</th><th align="right">涨跌幅</th></tr>
    ${indexRows}
  </table>

  <h3>🔥 热门板块 TOP10</h3>
  <table>
    <tr><th>#</th><th></th><th>板块</th><th align="right">涨跌幅</th></tr>
    ${sectorRows}
  </table>

  <div class="footer">数据来源: 东方财富 · SuperCodex 自动推送</div>
</body>
</html>`;
}

// ── 邮件发送 ──────────────────────────────
async function sendMail(html, text, date) {
  const { MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_TO } = process.env;

  if (!MAIL_USER || !MAIL_PASS || !MAIL_TO) {
    console.log('⚠️  邮件环境变量未配置，仅输出到终端。');
    console.log(`💡 如需邮件推送，请在 .env 中设置:\n`);
    console.log('  MAIL_HOST=smtp.qq.com');
    console.log('  MAIL_PORT=465');
    console.log('  MAIL_USER=your@qq.com');
    console.log('  MAIL_PASS=你的邮箱授权码');
    console.log('  MAIL_TO=receiver@email.com\n');
    return;
  }

  const transporter = createTransport({
    host: MAIL_HOST || 'smtp.qq.com',
    port: Number(MAIL_PORT) || 465,
    secure: true,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });

  await transporter.sendMail({
    from: `"A股收盘速报" <${MAIL_USER}>`,
    to: MAIL_TO,
    subject: `📊 A股收盘速报 ${date}`,
    html,
    text,
  });

  console.log('✅ 邮件已发送至:', MAIL_TO);
}

// ── 主流程 ──────────────────────────────
async function main() {
  try {
    const date = dateStr();
    const [indices, sectors] = await Promise.all([fetchIndices(), fetchSectors()]);

    // 纯文本版本
    const sep = '━'.repeat(36);
    const textLines = [
      `📊 A股收盘速报  ${date}`,
      sep,
      '\n🏛️ 【主要指数】',
      ...indices.map(i => `  ${i.emoji} ${i.name.padEnd(8)} ${i.price.padStart(8)}  ${i.changePct.padStart(8)}`),
      '\n🔥 【热门板块 TOP10】',
      ...sectors.map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.emoji} ${s.name.padEnd(12)} ${s.changePct.padStart(8)}`),
      `\n${sep}`,
      '💡 数据来源: 东方财富 | 自动推送 @ 15:00',
    ];
    const text = textLines.join('\n');

    // HTML版本
    const html = buildHTML(indices, sectors, date);

    // 输出到终端
    console.log(text);

    // 发送邮件
    await sendMail(html, text, date);
  } catch (err) {
    console.error('❌ 获取行情失败:', err.message);
    process.exit(1);
  }
}

main();
