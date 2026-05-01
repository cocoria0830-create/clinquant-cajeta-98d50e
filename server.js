const https = require('https');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

// ====== 자동매매 설정 ======
const MAX_COINS = 50;      // 거래량 상위 50개 코인
const BUY_RSI = 30;        // RSI 이하면 매수
const SELL_RSI = 70;       // RSI 이상이면 매도
const BUY_AMOUNT = 5000;   // 1회 매수금액 (원)
const MAX_PER_COIN = 0.3;  // 코인당 최대 잔고 비율 (30%)
const INTERVAL_MS = 1 * 60 * 1000; // 1분마다 실행

let autoLog = [];
let isRunning = false;
let coinList = [];

function log(msg) {
  const time = new Date().toLocaleTimeString('ko-KR');
  const entry = `[${time}] ${msg}`;
  autoLog.unshift(entry);
  if(autoLog.length > 200) autoLog.pop();
  console.log(entry);
}

// ====== JWT 생성 ======
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

// ====== Upbit API 호출 ======
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

// ====== 공개 API 호출 ======
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

// ====== 거래량 상위 코인 목록 가져오기 ======
async function loadTopCoins() {
  try {
    // 전체 KRW 마켓 코인 목록
    const markets = await publicRequest('/v1/market/all?isDetails=false');
    const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);

    // 티커로 거래량 조회 (한번에 최대 100개)
    const chunks = [];
    for(let i=0; i<krwMarkets.length; i+=100) {
      chunks.push(krwMarkets.slice(i, i+100));
    }

    let tickers = [];
    for(const chunk of chunks) {
      const data = await publicRequest(`/v1/ticker?markets=${chunk.join(',')}`);
      if(Array.isArray(data)) tickers = tickers.concat(data);
      await new Promise(r => setTimeout(r, 200));
    }

    // 거래대금 기준 정렬 후 상위 50개
    tickers.sort((a,b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
    coinList = tickers.slice(0, MAX_COINS).map(t => t.market);
    log(`✅ 상위 ${coinList.length}개 코인 로드 완료!`);
    log(`📋 ${coinList.slice(0,10).join(', ')} ...`);
  } catch(e) {
    log(`❌ 코인 목록 로드 실패: ${e.message}`);
    coinList = ['KRW-BTC','KRW-ETH','KRW-XRP','KRW-SOL','KRW-DOGE'];
  }
}

// ====== RSI 계산 ======
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

// ====== 자동매매 실행 ======
async function runAutoTrade() {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if(!accessKey || !secretKey) { log('❌ API 키가 없어요!'); return; }
  if(coinList.length === 0) { await loadTopCoins(); }

  log(`🔍 ${coinList.length}개 코인 분석 시작...`);

  try {
    // 잔고 조회
    const accounts = await upbitRequest('GET', '/v1/accounts', '', null, accessKey, secretKey);
    if(!Array.isArray(accounts)) { log('❌ 잔고 조회 실패'); return; }

    const krwAccount = accounts.find(a => a.currency === 'KRW');
    let krwBalance = krwAccount ? parseFloat(krwAccount.balance) : 0;
    log(`💰 KRW 잔고: ₩${Math.round(krwBalance).toLocaleString('ko-KR')}`);

    let buyCount = 0, sellCount = 0;

    // 각 코인 분석
    for(const market of coinList) {
      try {
        // 5분봉 캔들 200개 조회
        const candles = await publicRequest(`/v1/candles/minutes/5?market=${market}&count=200`);
        if(!Array.isArray(candles) || candles.length < 20) continue;

        const prices = candles.reverse().map(c => c.trade_price);
        const rsi = calcRSI(prices);
        const ma5 = prices.slice(-5).reduce((a,b)=>a+b,0)/5;
        const ma20 = prices.slice(-20).reduce((a,b)=>a+b,0)/20;
        const currentPrice = prices[prices.length-1];

        if(rsi===null) continue;

        const coinName = market.split('-')[1];
        const coinAccount = accounts.find(a => a.currency === coinName);
        const holdingQty = coinAccount ? parseFloat(coinAccount.balance) : 0;
        const holdingValue = holdingQty * currentPrice;

        // 매수 조건
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

        // 매도 조건
        if(rsi > SELL_RSI && ma5 < ma20 && holdingQty > 0) {
          log(`🔴 매도! ${coinName} RSI:${rsi.toFixed(1)}`);
          const orderBody = { market, side:'ask', volume:String(holdingQty), ord_type:'market' };
          const queryStr = Object.keys(orderBody).map(k=>`${k}=${encodeURIComponent(orderBody[k])}`).join('&');
          const order = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
          if(order.uuid) {
            log(`✅ 매도 완료! ${coinName} ${holdingQty}`);
            sellCount++;
          } else {
            log(`❌ 매도 실패: ${JSON.stringify(order)}`);
          }
        }

        await new Promise(r => setTimeout(r, 100)); // API 속도 제한
      } catch(e) {
        log(`❌ ${market} 오류: ${e.message}`);
      }
    }

    log(`✅ 분석 완료! 매수:${buyCount}건 매도:${sellCount}건`);

    // 1시간마다 코인 목록 갱신
    if(new Date().getMinutes() === 0) {
      await loadTopCoins();
    }

  } catch(e) {
    log(`❌ 오류: ${e.message}`);
  }
}

// ====== HTTP 서버 ======
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  const parsedUrl = url.parse(req.url, true);
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;

  // 잔고 조회
  if(parsedUrl.pathname==='/' || parsedUrl.pathname==='/balance') {
    try {
      const data = await upbitRequest('GET','/v1/accounts','',null,accessKey,secretKey);
      res.setHeader('Content-Type','application/json');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // 로그 조회
  if(parsedUrl.pathname==='/log') {
    res.setHeader('Content-Type','application/json');
    res.writeHead(200);
    res.end(JSON.stringify({logs:autoLog, running:isRunning, coins:coinList.length}));
    return;
  }

  // IP 확인
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
  runAutoTrade();
  isRunning = true;
  setInterval(runAutoTrade, INTERVAL_MS);
});
