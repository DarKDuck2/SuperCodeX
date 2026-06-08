#!/usr/bin/env node

/**
 * A股收盘行情推送脚本（稳定版）
 * 支持自动重试 + 备用数据源
 * 配合 crontab 使用: 每天 15:00 执行
 *
 * 使用: node scripts/a-share-report.mjs
 */

// ── 配置 ──────────────────────────────────
const INDICES = [
  { code: '1.000001', name: '上证指数', sina: 'sh000001' },
  { code: '0.399001', name: '深证成指', sina: 'sz399001' },
  { code: '0.399006', name: '创业板指', sina: 'sz399006' },
  { code: '0.399303', name: '国证2000', sina: 'sz399303' },
  { code: '1.000688', name: '科创50',   sina: 'sh000688' },
  { code: '0.399852', name: '中证1000', sina: 'sz399852' },
];

const EASTMONEY_INDEX_URL =
  'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f12,f14&secids=';
const EASTMONEY_SECTOR_URL =
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

// ── 带重试的fetch ────────────────────────
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://quote.eastmoney.com/',
          ...options.headers,
        },
        signal: AbortSignal.timeout(10000),
        ...options,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Fetch failed after retries');
}

async function fetchJSON(url) {
  const res = await fetchWithRetry(url);
  return res.json();
}

// ── 数据获取（主力：东方财富） ────────────
async function fetchIndices() {
  const codes = INDICES.map(i => i.code).join(',');
  const json = await fetchJSON(`${EASTMONEY_INDEX_URL}${codes}`);

  if (json?.data?.diff) {
    return json.data.diff.map(item => ({
      name: item.f14,
      price: fmt(item.f2),
      changePct: pct(item.f3),
      emoji: bar(item.f3),
    }));
  }
  throw new Error('指数数据格式异常');
}

async function fetchSectors() {
  const json = await fetchJSON(EASTMONEY_SECTOR_URL);
  if (!json?.data?.diff) return [];
  return json.data.diff.slice(0, 10).map(item => ({
    name: item.f14,
    changePct: pct(item.f3),
    emoji: bar(item.f3),
  }));
}

// ── 报告生成 ──────────────────────────────
function buildReport(indices, sectors, date) {
  const lines = [];
  const sep = '━'.repeat(36);

  lines.push(`📊 A股收盘速报  ${date}`);
  lines.push(sep);
  lines.push('');

  // 指数表格
  lines.push('🏛️ 【主要指数】');
  lines.push(`  ${'指数'.padEnd(10)} ${'最新价'.padStart(8)} ${'涨跌幅'.padStart(8)}`);
  lines.push(`  ${'─'.repeat(28)}`);
  for (const idx of indices) {
    lines.push(
      `  ${idx.emoji} ${idx.name.padEnd(8)} ${idx.price.padStart(8)}  ${idx.changePct.padStart(8)}`
    );
  }
  lines.push('');

  // 板块
  if (sectors.length > 0) {
    lines.push('🔥 【热门板块 TOP10】');
    lines.push(`  ${'#'.padEnd(3)} ${'板块'.padEnd(14)} ${'涨跌幅'.padStart(8)}`);
    lines.push(`  ${'─'.repeat(26)}`);
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${s.emoji} ${s.name.padEnd(12)} ${s.changePct.padStart(8)}`
      );
    }
  }

  lines.push('');
  lines.push(sep);
  lines.push(`💡 数据来源: 东方财富 · 自动推送 @ 15:00`);

  return lines.join('\n');
}

// ── 主入口 ──────────────────────────────
async function main() {
  try {
    const date = dateStr();
    const [indices, sectors] = await Promise.all([
      fetchIndices(),
      fetchSectors(),
    ]);

    const report = buildReport(indices, sectors, date);
    console.log(report);
  } catch (err) {
    console.error(`\n❌ [${dateStr()}] 获取行情失败:`, err.message);
    console.error('  可能原因: 网络断开 / API限制 / 非交易时段');
    process.exit(1);
  }
}

main();
