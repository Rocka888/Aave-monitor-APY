// Раз в час записывает APY по вашим позициям в data/history.json.
// Запускается из GitHub Actions (см. record.yml). Нужен Node 18+ (встроенный fetch).
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.v3.aave.com/graphql';
const FILE = process.env.HISTORY_PATH || 'data/history.json';

// key = сеть-токен (те же ключи использует страница), names = допустимые названия токена в Aave
const POSITIONS = [
  {key:'43114-USDC', chainId:43114, names:['USDC']},
  {key:'10-USDC',    chainId:10,    names:['USDC']},
  {key:'1-USDC',     chainId:1,     names:['USDC']},
  {key:'1-USDG',     chainId:1,     names:['USDG']},
  {key:'137-USDT',   chainId:137,   names:['USDT','USDT0','USD₮0']},
  {key:'43114-USDT', chainId:43114, names:['USDT']},
];

// от полного запроса к простому, если какое-то поле не поддерживается
const VARIANTS = [
  `supplyInfo{apy{formatted} total{value}} borrowInfo{availableLiquidity{usd}}`,
  `supplyInfo{apy{formatted}} borrowInfo{availableLiquidity{usd}}`,
];

const num = x => {
  const n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function gql(query) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query}),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
  return j.data;
}

async function fetchChain(chainId) {
  let lastErr;
  for (const v of VARIANTS) {
    try {
      const q = `{ markets(request:{chainIds:[${chainId}]}) { reserves { underlyingToken{symbol} ${v} isFrozen isPaused } } }`;
      const d = await gql(q);
      return d.markets.flatMap(m => m.reserves);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// та же логика выбора, что на странице: нужный токен; активный пул в приоритете, затем самый крупный.
// Замороженные и приостановленные пулы тоже пишем: проценты в них продолжают начисляться.
function pick(reserves, names) {
  const want = names.map(s => s.toUpperCase());
  const c = reserves
    .filter(r => r.underlyingToken && want.includes(r.underlyingToken.symbol.toUpperCase()))
    .map(r => {
      const s = r.supplyInfo || {}, b = r.borrowInfo || {};
      return {
        apy: num(s.apy && s.apy.formatted),
        size: num(s.total && s.total.value) || num(b.availableLiquidity && b.availableLiquidity.usd) || 0,
        off: (r.isPaused ? 2 : 0) + (r.isFrozen ? 1 : 0),
      };
    })
    .filter(x => x.apy != null)
    .sort((a, b) => (a.off - b.off) || (b.size - a.size));
  return c.length ? c[0].apy : null;
}

function write(hist) {
  const head = JSON.stringify({v: hist.v, keys: hist.keys});
  const rows = hist.rows.map(r => JSON.stringify(r)).join(',\n');
  fs.mkdirSync(path.dirname(FILE), {recursive: true});
  fs.writeFileSync(FILE, head.slice(0, -1) + ',"rows":[\n' + rows + '\n]}\n');
}

async function main() {
  const chains = [...new Set(POSITIONS.map(p => p.chainId))];
  const data = {};
  await Promise.all(chains.map(async id => {
    try { data[id] = await fetchChain(id); }
    catch (e) { console.error('Сеть', id, 'не ответила:', e.message); data[id] = null; }
  }));

  const vals = {};
  let ok = 0;
  for (const p of POSITIONS) {
    const apy = data[p.chainId] ? pick(data[p.chainId], p.names) : null;
    vals[p.key] = apy;
    if (apy != null) ok++;
    console.log(p.key, apy);
  }
  if (!ok) { console.error('Нет данных ни по одной позиции, запись пропущена'); process.exit(1); }

  let hist = {v: 1, keys: POSITIONS.map(p => p.key), rows: []};
  if (fs.existsSync(FILE)) {
    try { hist = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.error('Файл истории повреждён, останавливаюсь'); process.exit(1); }
  }
  // новые позиции добавляются колонками в конец, старые данные не трогаем
  for (const p of POSITIONS) if (!hist.keys.includes(p.key)) hist.keys.push(p.key);

  hist.rows.push([Math.floor(Date.now() / 1000), ...hist.keys.map(k => (vals[k] != null ? vals[k] : null))]);
  write(hist);
  console.log('Записано строк всего:', hist.rows.length);
}

main().catch(e => { console.error(e); process.exit(1); });
