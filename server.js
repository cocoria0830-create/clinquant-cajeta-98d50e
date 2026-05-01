const https = require('https');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

// ====== 자동매매 설정 ======
const MAX_COINS = 50;       // 거래량 상위 50개 코인
const BUY_RSI = 40;         // RSI 이하면 매수
const SELL_RSI = 60;        // RSI 이상이면 매도
const STOP_LOSS = -3.0;     // 손절 라인 -3%
const BUY_AMOUNT = 5000;    // 1회 매수금액 (원)
const MAX_PER_COIN = 0.3;   // 코인당 최대 잔고 비율 30%
const INTERVAL_MS = 60 * 1000; // 1분마다 실행

let autoLog = [];
let isRunning = false;
let coinList = [];
let buyPrices = {};         // 코인별 매수 평균가
let startBalance = 0;       // 오늘 시작 잔고
let startTime = new Date(); // 시작 시간

function log(msg) {
  const time = new Date().toLocaleTimeString('ko-KR');
  const entry = `[${time}] ${msg}`;
  autoLog.unshift(entry);
  if(autoLog.length > 300) autoLog.pop();
  console.log(entry);
}

function generateToken(accessKey, secretKey, queryStr) {
  const payload = { access_key: accessKey, nonce: crypto.randomUUID() };
  if(queryStr) {
    payload.query_hash = crypto.createHash('sha512').update(queryStr).digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function upbitRequest(method, path, queryStr, bodyObj, accessKey, secretKey) {
  return new Promise((resolve, reject) => {
    const token = generateToken(accessKey, secretKey, queryStr||'');
    const fullPath = path + (queryStr ? '?'+queryStr : '');
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: 'api.upbit.com',
      path: fullPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if(bodyStr) req.write(bodyStr);
    req.end();
  });
}

function publicRequest(path) {
  return new Promise((resolve, reject) => {
    https.get('https://api.upbit.com'+path, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve([]); }
      });
    }).on('error', reject);
  });
}

async function loadTopCoins() {
  try {
    const markets = await publicRequest('/v1/market/all?isDetails=false');
    const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
    const chunks = [];
    for(let i=0; i<krwMarkets.length; i+=100) chunks.push(krwMarkets.slice(i, i+100));
    let tickers = [];
    for(const chunk of chunks) {
      const data = await publicRequest(`/v1/ticker?markets=${chunk.join(',')}`);
      if(Array.isArray(data)) tickers = tickers.concat(data);
      await new Promise(r => setTimeout(r, 300));
    }
    tickers.sort((a,b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
    coinList = tickers.slice(0, MAX_COINS).map(t => t.market);
    log(`✅ 상위 ${coinList.length}개 코인 로드 완료!`);
  } catch(e) {
    log(`❌ 코인 목록 로드 실패: ${e.message}`);
    coinList = ['KRW-BTC','KRW-ETH','KRW-XRP','KRW-SOL','KRW-DOGE'];
  }
}

function calcRSI(prices, period=14) {
  if(prices.length < period+1) return null;
  const recent = prices.slice(-period-1);
  let gains=0, losses=0;
  for(let i=1; i<recent.length; i++) {
    const diff = recent[i] - recent[i-1];
    if(diff>0) gains+=diff; else losses+=Math.abs(diff);
  }
  if(losses===0) return 100;
  const rs = (gains/period) / (losses/period);
  return 100 - (100/(1+rs));
}

async function runAutoTrade() {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if(!accessKey || !secretKey) { log('❌ API 키가 없어요!'); return; }
  if(coinList.length === 0) { await loadTopCoins(); }

  try {
    const accounts = await upbitRequest('GET', '/v1/accounts', '', null, accessKey, secretKey);
    if(!Array.isArray(accounts)) { log('❌ 잔고 조회 실패'); return; }

    const krwAccount = accounts.find(a => a.currency === 'KRW');
    let krwBalance = krwAccount ? parseFloat(krwAccount.balance) : 0;

    // 시작 잔고 기록
    if(startBalance === 0) startBalance = krwBalance;

    // 전체 자산 계산 (KRW + 보유 코인 현재가)
    let totalAsset = krwBalance;
    for(const acc of accounts) {
      if(acc.currency !== 'KRW') {
        const ticker = await publicRequest(`/v1/ticker?markets=KRW-${acc.currency}`);
        if(Array.isArray(ticker) && ticker[0]) {
          totalAsset += parseFloat(acc.balance) * ticker[0].trade_price;
        }
      }
    }

    // 수익률 계산
    const profitRate = startBalance > 0 ? ((totalAsset - startBalance) / startBalance * 100) : 0;
    log(`💰 KRW: ₩${Math.round(krwBalance).toLocaleString()} | 총자산: ₩${Math.round(totalAsset).toLocaleString()} | 수익률: ${profitRate.toFixed(2)}%`);

    // 매일 자정에 시작 잔고 갱신
    const now = new Date();
    if(now.getHours() === 0 && now.getMinutes() === 0) {
      startBalance = totalAsset;
      log(`🔄 일일 시작 잔고 갱신: ₩${Math.round(startBalance).toLocaleString()}`);
    }

    let buyCount = 0, sellCount = 0;

    for(const market of coinList) {
      try {
        const candles = await publicRequest(`/v1/candles/minutes/5?market=${market}&count=200`);
        if(!Array.isArray(candles) || candles.length < 20) continue;

        const prices = candles.reverse().map(c => c.trade_price);
        const rsi = calcRSI(prices);
        const ma5 = prices.slice(-5).reduce((a,b)=>a+b,0)/5;
        const ma20 = prices.slice(-20).reduce((a,b)=>a+b,0)/20;
        const currentPrice = prices[prices.length-1];
        if(rsi === null) continue;

        const coinName = market.split('-')[1];
        const coinAccount = accounts.find(a => a.currency === coinName);
        const holdingQty = coinAccount ? parseFloat(coinAccount.balance) : 0;
        const holdingValue = holdingQty * currentPrice;
        const avgBuyPrice = coinAccount ? parseFloat(coinAccount.avg_buy_price) : 0;

        // 손절 체크 (-3% 이하)
        if(holdingQty > 0 && avgBuyPrice > 0) {
          const pnlRate = (currentPrice - avgBuyPrice) / avgBuyPrice * 100;
          if(pnlRate <= STOP_LOSS) {
            log(`🛑 손절! ${coinName} 수익률:${pnlRate.toFixed(2)}%`);
            const orderBody = { market, side:'ask', volume:String(holdingQty), ord_type:'market' };
            const queryStr = Object.keys(orderBody).map(k=>`${k}=${encodeURIComponent(orderBody[k])}`).join('&');
            const order = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
            if(order.uuid) { log(`✅ 손절 완료! ${coinName}`); sellCount++; }
            continue;
          }
        }

        // 매수 조건: RSI < 40, MA5 > MA20
        if(rsi < BUY_RSI && ma5 > ma20 && krwBalance >= BUY_AMOUNT) {
          if(holdingValue < krwBalance * MAX_PER_COIN) {
            log(`🟢 매수! ${coinName} RSI:${rsi.toFixed(1)}`);
            const orderBody = { market, side:'bid', price:String(BUY_AMOUNT), ord_type:'price' };
            const queryStr = Object.keys(orderBody).map(k=>`${k}=${encodeURIComponent(orderBody[k])}`).join('&');
            const order = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
            if(order.uuid) {
              log(`✅ 매수 완료! ${coinName} ₩${BUY_AMOUNT.toLocaleString()}`);
              krwBalance -= BUY_AMOUNT;
              buyCount++;
            } else {
              log(`❌ 매수 실패: ${JSON.stringify(order)}`);
            }
          }
        }

        // 매도 조건: RSI > 60, MA5 < MA20
        if(rsi > SELL_RSI && ma5 < ma20 && holdingQty > 0) {
          log(`🔴 매도! ${coinName} RSI:${rsi.toFixed(1)}`);
          const orderBody = { market, side:'ask', volume:String(holdingQty), ord_type:'market' };
          const queryStr = Object.keys(orderBody).map(k=>`${k}=${encodeURIComponent(orderBody[k])}`).join('&');
          const order = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
          if(order.uuid) {
            log(`✅ 매도 완료! ${coinName}`);
            sellCount++;
          } else {
            log(`❌ 매도 실패: ${JSON.stringify(order)}`);
          }
        }

        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        log(`❌ ${market} 오류: ${e.message}`);
      }
    }

    log(`✅ 완료! 매수:${buyCount}건 매도:${sellCount}건 수익률:${profitRate.toFixed(2)}%`);

    // 1시간마다 코인 목록 갱신
    if(new Date().getMinutes() === 0) await loadTopCoins();

  } catch(e) {
    log(`❌ 오류: ${e.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  const parsedUrl = url.parse(req.url, true);
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;

  if(parsedUrl.pathname==='/' || parsedUrl.pathname==='/balance') {
    try {
      const data = await upbitRequest('GET','/v1/accounts','',null,accessKey,secretKey);
      res.setHeader('Content-Type','application/json');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  if(parsedUrl.pathname==='/log') {
    const profitRate = startBalance > 0 ? '계산중...' : '시작 전';
    res.setHeader('Content-Type','application/json');
    res.writeHead(200);
    res.end(JSON.stringify({logs:autoLog, running:isRunning, coins:coinList.length, startBalance}));
    return;
  }

  if(parsedUrl.pathname==='/ip') {
    https.get('https://api.ipify.org?format=json',(ipRes)=>{
      let data='';
      ipRes.on('data',chunk=>data+=chunk);
      ipRes.on('end',()=>{res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(data);});
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({error:'Not found'}));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  log(`🚀 서버 시작! 포트: ${PORT}`);
  await loadTopCoins();
  await runAutoTrade();
  isRunning = true;
  setInterval(runAutoTrade, INTERVAL_MS);
});
