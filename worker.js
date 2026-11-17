const DEFAULT_SYMBOLS = ["ASTS", "RKLB", "IONQ", "OKLO"];
const SCREENER_SYMBOLS = ["NVDA","AMD","TSLA","PLTR","SOFI","AVGO","HOOD","SMR","JOBY","ACHR","RKLB","ASTS","IONQ","OKLO","MSFT","AMZN","META","ARM","COIN","LUNR","LUNR","RDDT","MSTR","TEM","RGTI","QBTS","QUBT","HIMS","CRSP","RXRX","RKLB","LUNR","SPCE","ACHR","JOBY","ASTS","OKLO","IONQ","PLTR","APP","ORCL","CRM","NOW","PANW","CRWD","NET","SNOW","MU","TSM","ANET","GEV","CEG","VST","CCJ","LEU","UUUU","ONDS","LUNR","RDW","RKLB","SMR","NNE","QS","ENVX","ASTS","BBAI","SOUN","AI","PATH","AFRM","UPST","HOOD","COIN","MARA","HUT","CLSK","IBIT"];
const MAX_WATCHLIST = 50;
const ALLOWED_ORIGINS = new Set(["https://bombbomb725-debug.github.io"]);
const encoder = new TextEncoder();

function corsHeaders(origin) {
  const h = { "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization", "Access-Control-Max-Age":"86400", "Vary":"Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
}
function validSymbol(s) { return /^[A-Z][A-Z0-9.]{0,9}$/.test(s); }
function cleanSymbol(s) { return String(s||"").trim().toUpperCase(); }
function dbReady(env) { return Boolean(env.DB); }

async function verifyLineSignature(rawBody,signature,secret) {
  if(!signature||!secret)return false;
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=await crypto.subtle.sign("HMAC",key,rawBody);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))===signature;
}
function base64url(bytes) {
  let s=""; for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
async function signSession(payload,secret) {
  const head=base64url(encoder.encode(JSON.stringify({alg:"HS256",typ:"JWT"})));
  const body=base64url(encoder.encode(JSON.stringify(payload)));
  const data=head+"."+body;
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,encoder.encode(data));
  return data+"."+base64url(new Uint8Array(sig));
}
async function verifySession(token,secret) {
  try {
    const p=token.split("."); if(p.length!==3)return null;
    const data=p[0]+"."+p[1];
    const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const sig=Uint8Array.from(atob(p[2].replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-p[2].length%4)%4)),c=>c.charCodeAt(0));
    if(!await crypto.subtle.verify("HMAC",key,sig,encoder.encode(data)))return null;
    const payload=JSON.parse(atob(p[1].replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-p[1].length%4)%4)));
    return payload.exp>Date.now()/1000?payload:null;
  } catch { return null; }
}
async function authenticate(request,env) {
  if(!env.APP_SESSION_SECRET)return null;
  const auth=request.headers.get("Authorization")||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  const payload=await verifySession(token,env.APP_SESSION_SECRET);
  if(!payload?.sub)return null;
  const user=await env.DB.prepare("SELECT id,line_user_id,display_name,picture_url FROM users WHERE id=?").bind(payload.sub).first();
  return user||null;
}
async function lineIdTokenProfile(idToken,env) {
  if(!env.LINE_LOGIN_CHANNEL_ID)throw new Error("ยังไม่ได้ตั้ง LINE_LOGIN_CHANNEL_ID");
  const body=new URLSearchParams({id_token:idToken,client_id:env.LINE_LOGIN_CHANNEL_ID});
  const r=await fetch("https://api.line.me/oauth2/v2.1/verify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data=await r.json();
  if(!r.ok||!data.sub)throw new Error("ตรวจสอบ LINE ID Token ไม่ผ่าน");
  return data;
}
async function createOrUpdateUser(env,lineUserId,profile={}) {
  const id="line:"+lineUserId;
  const existing=await env.DB.prepare("SELECT id FROM users WHERE line_user_id=?").bind(lineUserId).first();
  await env.DB.prepare(`INSERT INTO users(id,line_user_id,display_name,picture_url,updated_at,last_seen_at)
    VALUES(?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(line_user_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,users.display_name),
    picture_url=COALESCE(excluded.picture_url,users.picture_url),updated_at=datetime('now'),last_seen_at=datetime('now')`)
    .bind(id,lineUserId,profile.name||null,profile.picture||null).run();
  if(!existing) {
    for(const symbol of DEFAULT_SYMBOLS) await env.DB.prepare("INSERT OR IGNORE INTO watchlist(user_id,symbol) VALUES(?,?)").bind(id,symbol).run();
  }
  return await env.DB.prepare("SELECT id,line_user_id,display_name,picture_url FROM users WHERE id=?").bind(id).first();
}
async function getWatchlist(env,userId) {
  const r=await env.DB.prepare("SELECT symbol,added_at FROM watchlist WHERE user_id=? ORDER BY added_at,symbol").bind(userId).all();
  return (r.results||[]).map(x=>x.symbol);
}
async function addWatch(env,userId,symbol) {
  const exists=await env.DB.prepare("SELECT 1 AS yes FROM watchlist WHERE user_id=? AND symbol=?").bind(userId,symbol).first();
  if(exists)return {ok:true,already:true,symbols:await getWatchlist(env,userId)};
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE user_id=?").bind(userId).first();
  if(count.n>=MAX_WATCHLIST)return {ok:false,error:"ครบจำนวนสูงสุด 50 หุ้นต่อคนแล้ว",symbols:await getWatchlist(env,userId)};
  await env.DB.prepare("INSERT INTO watchlist(user_id,symbol) VALUES(?,?)").bind(userId,symbol).run();
  return {ok:true,symbols:await getWatchlist(env,userId)};
}
async function removeWatch(env,userId,symbol) {
  await env.DB.prepare("DELETE FROM watchlist WHERE user_id=? AND symbol=?").bind(userId,symbol).run();
  await env.DB.prepare("DELETE FROM user_stock_state WHERE user_id=? AND symbol=?").bind(userId,symbol).run();
  return {ok:true,symbols:await getWatchlist(env,userId)};
}
async function lineReply(env,replyToken,text) {
  if(!replyToken||!env.LINE_CHANNEL_ACCESS_TOKEN)return;
  const r=await fetch("https://api.line.me/v2/bot/message/reply",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({replyToken,messages:[{type:"text",text:String(text).slice(0,4900)}]})});
  if(!r.ok)console.error("LINE_REPLY_FAILED",r.status,(await r.text()).slice(0,250));
}
async function linePush(env,userId,text) {
  const r=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({to:userId,messages:[{type:"text",text:String(text).slice(0,4900)}]})});
  if(!r.ok)throw new Error("LINE push failed "+r.status+" "+(await r.text()).slice(0,200));
}
function parseLineCommand(text) {
  const t=String(text||"").trim();
  let m=t.match(/^(?:เพิ่ม|add|\/add)\s+([A-Za-z][A-Za-z0-9.]{0,9})$/i); if(m)return {action:"add",symbol:cleanSymbol(m[1])};
  m=t.match(/^(?:ลบ|remove|\/remove)\s+([A-Za-z][A-Za-z0-9.]{0,9})$/i); if(m)return {action:"remove",symbol:cleanSymbol(m[1])};
  if(/^(?:รายการหุ้น|ดูหุ้น|list|\/list)$/i.test(t))return {action:"list"};
  if(/^(?:หุ้นแนะนำ|แนะนำหุ้น|ideas|\/ideas)$/i.test(t))return {action:"ideas"};
  return {action:"help"};
}
async function handleLineWebhook(request,env) {
  if(!env.LINE_CHANNEL_SECRET||!env.LINE_CHANNEL_ACCESS_TOKEN)return json({error:"LINE secrets are missing"},503);
  if(!dbReady(env))return json({error:"D1 binding DB is missing"},503);
  const raw=await request.arrayBuffer();
  if(!await verifyLineSignature(raw,request.headers.get("x-line-signature")||"",env.LINE_CHANNEL_SECRET))return json({error:"Invalid LINE signature"},401);
  let payload; try{payload=JSON.parse(new TextDecoder().decode(raw));}catch{return json({error:"Invalid JSON"},400);}
  for(const event of payload.events||[]) {
    const lineUserId=event.source?.userId;
    if(!lineUserId)continue;
    if(event.type==="unfollow")continue;
    const user=await createOrUpdateUser(env,lineUserId,{});
    if(event.type==="follow") {
      await lineReply(env,event.replyToken,"ยินดีต้อนรับสู่ AI Stock Watcher!\nเริ่มต้นติดตาม: ASTS, RKLB, IONQ, OKLO\n\nพิมพ์ “เพิ่ม NVDA” เพื่อเพิ่มหุ้น (สูงสุด 50 ตัว)\nพิมพ์ “ลบ NVDA” เพื่อลบ\nพิมพ์ “รายการหุ้น” เพื่อดูรายการ\nพิมพ์ “หุ้นแนะนำ” เพื่อดูหุ้นที่ Screener จัดอันดับ");
      continue;
    }
    if(event.type!=="message"||event.message?.type!=="text")continue;
    const cmd=parseLineCommand(event.message.text);
    if(cmd.action==="add") {
      const result=await addWatch(env,user.id,cmd.symbol);
      await lineReply(env,event.replyToken,result.ok?"เพิ่ม "+cmd.symbol+" ใน Watchlist แล้ว ("+result.symbols.length+"/50)":result.error);
    } else if(cmd.action==="remove") {
      const result=await removeWatch(env,user.id,cmd.symbol);
      await lineReply(env,event.replyToken,"ลบ "+cmd.symbol+" ออกจาก Watchlist แล้ว\nเหลือ "+result.symbols.length+" หุ้น");
    } else if(cmd.action==="list") {
      const symbols=await getWatchlist(env,user.id);
      await lineReply(env,event.replyToken,"Watchlist ของคุณ ("+symbols.length+"/50)\n"+(symbols.join(", ")||"ยังไม่มีหุ้น"));
    } else if(cmd.action==="ideas") {
      const rows=await env.DB.prepare("SELECT symbol,score,status,rationale FROM stock_ideas ORDER BY score DESC, symbol LIMIT 15").all();
      const lines=(rows.results||[]).map((x,i)=>(i+1)+". "+x.symbol+" · "+x.score+"/5 · "+x.status+" — "+(x.rationale||"คะแนนทางเทคนิค")).join("\n");
      await lineReply(env,event.replyToken,"หุ้นที่ Screener จัดอันดับ (ไม่ใช่คำแนะนำการลงทุน)\n"+(lines||"ยังไม่มีผลคัดกรอง รอรอบสแกน"));
    } else {
      await lineReply(env,event.replyToken,"คำสั่ง AI Stock Watcher\n• เพิ่ม NVDA\n• ลบ NVDA\n• รายการหุ้น\n• หุ้นแนะนำ\nสูงสุด 50 หุ้นต่อคน");
    }
  }
  return json({ok:true});
}
async function fetchMarket(env,symbols,timeframe="1Day") {
  if(!env.ALPACA_KEY||!env.ALPACA_SECRET)throw new Error("Worker secrets ALPACA_KEY / ALPACA_SECRET missing");
  const auth={"APCA-API-KEY-ID":env.ALPACA_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET};
  const base="https://data.alpaca.markets/v2",end=new Date(),start=new Date(end.getTime()-(timeframe==="4Hour"?45:140)*86400000);
  const u=new URL(base+"/stocks/bars");
  u.searchParams.set("symbols",symbols.join(","));u.searchParams.set("timeframe",timeframe);
  u.searchParams.set("start",start.toISOString());u.searchParams.set("end",end.toISOString());
  u.searchParams.set("limit","1000");u.searchParams.set("feed","iex");u.searchParams.set("sort","asc");u.searchParams.set("adjustment","raw");
  const [br,...tr]=await Promise.all([fetch(u,{headers:auth}),...symbols.map(s=>fetch(base+"/stocks/"+encodeURIComponent(s)+"/trades/latest?feed=iex",{headers:auth}))]);
  if(!br.ok)throw new Error("Alpaca bars "+br.status+": "+(await br.text()).slice(0,250));
  const bd=await br.json(),stocks={};
  for(let i=0;i<symbols.length;i++){let trade=null;if(tr[i].ok){const d=await tr[i].json();trade=d.trade||null;}stocks[symbols[i]]={bars:bd.bars?.[symbols[i]]||[],trade};}
  return {feed:"Alpaca IEX",timeframe,fetchedAt:new Date().toISOString(),stocks};
}
function ema(values,p) {
  if(values.length<p)return null;const k=2/(p+1);let v=values.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<values.length;i++)v=values[i]*k+v*(1-k);return v;
}
function emaSeries(values,p) {
  const out=Array(values.length).fill(null);if(values.length<p)return out;const k=2/(p+1);let v=values.slice(0,p).reduce((a,b)=>a+b,0)/p;out[p-1]=v;
  for(let i=p;i<values.length;i++){v=values[i]*k+v*(1-k);out[i]=v;}return out;
}
function rsi(values,p=14) {
  if(values.length<=p)return null;let g=0,l=0;
  for(let i=1;i<=p;i++){const d=values[i]-values[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/p,al=l/p;for(let i=p+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}
  return al===0?100:100-100/(1+ag/al);
}
function analyzeStatus(bars,price) {
  const done=bars.length&&bars.at(-1)?.t&&new Date(bars.at(-1).t).toISOString().slice(0,10)===new Date().toISOString().slice(0,10)?bars.slice(0,-1):bars;
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<55)return {status:"wait",label:"ข้อมูลย้อนหลังไม่พอ",score:0};
  const e20=ema(closes,20),e50=ema(closes,50),r=rsi(closes),s20=emaSeries(closes,20),s50=emaSeries(closes,50);
  const rising=s20.at(-1)>s20.at(-6)&&s50.at(-1)>s50.at(-6),trend=e20>e50&&rising&&closes.at(-1)>e20;
  const m12=emaSeries(closes,12),m26=emaSeries(closes,26),macd=closes.map((_,i)=>m12[i]!=null&&m26[i]!=null?m12[i]-m26[i]:null).filter(Number.isFinite);
  const sig=ema(macd,9),momentum=r>=50&&r<70&&macd.at(-1)>sig;
  const prior=done.slice(-21,-1),priorHigh=prior.length?Math.max(...prior.map(x=>Number(x.h))):null;
  const breakout=Number.isFinite(price)&&Number.isFinite(priorHigh)&&price>priorHigh;
  const vols=done.slice(-21,-1).map(x=>Number(x.v)).filter(Number.isFinite),avg=vols.length?vols.reduce((a,b)=>a+b,0)/vols.length:0;
  const vol=avg>0&&Number(done.at(-1)?.v)>=avg*1.3,confirmed=trend&&momentum,strong=confirmed&&breakout&&vol;
  const score=[trend,momentum,breakout,vol,macd.at(-1)>sig].filter(Boolean).length;
  return {status:strong?"buy":confirmed?"buy":r<45||(!trend&&price<e20&&e20<e50)?"risk":"wait",label:strong?"ขาขึ้นยืนยัน + เบรกเอาต์":confirmed?"BUY SIGNAL · แนวโน้มขาขึ้น":r<45?"แนวโน้มยังอ่อน":"รอการยืนยันแนวโน้ม",score};
}
async function scanAlerts(env) {
  if(!dbReady(env)||!env.LINE_CHANNEL_ACCESS_TOKEN)return;
  const rows=await env.DB.prepare("SELECT u.id AS user_id,u.line_user_id,w.symbol FROM watchlist w JOIN users u ON u.id=w.user_id ORDER BY u.id,w.symbol").all();
  const watch=(rows.results||[]);
  const symbols=[...new Set([...watch.map(x=>x.symbol),...SCREENER_SYMBOLS])],market={};
  for(let i=0;i<symbols.length;i+=50) {
    try { const d=await fetchMarket(env,symbols.slice(i,i+50));Object.assign(market,d.stocks); }
    catch(e){console.error("ALERT_SCAN_MARKET_ERROR",String(e));return;}
  }
  const checked=new Date().toISOString();
  // Refresh the shared, transparent technical screener universe once per scheduled scan.
  for(const symbol of [...new Set(SCREENER_SYMBOLS)]) {
    const data=market[symbol];if(!data)continue;
    const signal=analyzeStatus(data.bars||[],Number(data.trade?.p));
    await env.DB.prepare(`INSERT INTO stock_ideas(symbol,score,status,rationale,scanned_at)
      VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET score=excluded.score,status=excluded.status,
      rationale=excluded.rationale,scanned_at=excluded.scanned_at`)
      .bind(symbol,signal.score,signal.status,signal.label,checked).run();
  }
  if(!watch.length)return;
  for(const item of watch) {
    const data=market[item.symbol];if(!data)continue;
    const signal=analyzeStatus(data.bars||[],Number(data.trade?.p));
    const price=Number(data.trade?.p),old=await env.DB.prepare("SELECT status FROM user_stock_state WHERE user_id=? AND symbol=?").bind(item.user_id,item.symbol).first();
    if(!old) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_stock_state(user_id,symbol,status,status_label,score,last_price,checked_at) VALUES(?,?,?,?,?,?,?)").bind(item.user_id,item.symbol,signal.status,signal.label,signal.score,Number.isFinite(price)?price:null,checked).run();
      continue;
    }
    if(old.status===signal.status) {
      await env.DB.prepare("UPDATE user_stock_state SET status_label=?,score=?,last_price=?,checked_at=? WHERE user_id=? AND symbol=?").bind(signal.label,signal.score,Number.isFinite(price)?price:null,checked,item.user_id,item.symbol).run();
      continue;
    }
    const upd=await env.DB.prepare("UPDATE user_stock_state SET status=?,status_label=?,score=?,last_price=?,checked_at=? WHERE user_id=? AND symbol=? AND status=?").bind(signal.status,signal.label,signal.score,Number.isFinite(price)?price:null,checked,item.user_id,item.symbol,old.status).run();
    if((upd.meta?.changes||0)!==1)continue;
    const message="AI Stock Watcher · สถานะหุ้นเปลี่ยน\n"+item.symbol+" : "+old.status.toUpperCase()+" → "+signal.status.toUpperCase()+"\n"+signal.label+" · คะแนน "+signal.score+"/5\nราคา "+(Number.isFinite(price)?"$"+price.toFixed(2):"ไม่พบราคา")+"\nข้อมูล Alpaca IEX · สแกน "+checked;
    try {
      await linePush(env,item.line_user_id,message);
      await env.DB.prepare("INSERT INTO alert_events(user_id,symbol,old_status,new_status,message) VALUES(?,?,?,?,?)").bind(item.user_id,item.symbol,old.status,signal.status,message).run();
    } catch(e) { console.error("LINE_PUSH_ERROR",item.symbol,String(e)); }
  }
}
async function apiHandler(request,env,url,headers) {
  if(url.pathname==="/api/auth/line"&&request.method==="POST") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    if(!env.APP_SESSION_SECRET)return json({error:"APP_SESSION_SECRET missing"},503,headers);
    const body=await request.json().catch(()=>({}));if(!body.idToken)return json({error:"idToken is required"},400,headers);
    try {
      const profile=await lineIdTokenProfile(body.idToken,env),user=await createOrUpdateUser(env,profile.sub,{name:profile.name,picture:profile.picture});
      const token=await signSession({sub:user.id,exp:Math.floor(Date.now()/1000)+86400*14},env.APP_SESSION_SECRET);
      return json({token,user:{displayName:user.display_name,pictureUrl:user.picture_url},symbols:await getWatchlist(env,user.id)},200,headers);
    } catch(e){return json({error:e.message||"LINE login failed"},401,headers);}
  }
  if(url.pathname==="/api/ideas"&&request.method==="GET") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const rows=await env.DB.prepare("SELECT symbol,company_name,score,status,rationale,scanned_at FROM stock_ideas ORDER BY score DESC,symbol LIMIT 50").all();
    return json({ideas:rows.results||[]},200,headers);
  }
  if(url.pathname.startsWith("/api/")&&url.pathname!=="/api/market"&&url.pathname!=="/api/assets") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const user=await authenticate(request,env);if(!user)return json({error:"กรุณาเข้าสู่ระบบด้วย LINE ใหม่"},401,headers);
    if(url.pathname==="/api/me"&&request.method==="GET")return json({user:{displayName:user.display_name,pictureUrl:user.picture_url},symbols:await getWatchlist(env,user.id)},200,headers);
    if(url.pathname==="/api/watchlist"&&request.method==="GET")return json({symbols:await getWatchlist(env,user.id),max:MAX_WATCHLIST},200,headers);
    if(url.pathname==="/api/watchlist/add"&&request.method==="POST") {
      const body=await request.json().catch(()=>({})),symbol=cleanSymbol(body.symbol);
      if(!validSymbol(symbol))return json({error:"Ticker ไม่ถูกต้อง"},400,headers);
      const result=await addWatch(env,user.id,symbol);return json(result,result.ok?200:409,headers);
    }
    if(url.pathname==="/api/watchlist/remove"&&request.method==="POST") {
      const body=await request.json().catch(()=>({})),symbol=cleanSymbol(body.symbol);
      if(!validSymbol(symbol))return json({error:"Ticker ไม่ถูกต้อง"},400,headers);
      return json(await removeWatch(env,user.id,symbol),200,headers);
    }
  }
  if(url.pathname==="/api/assets"&&request.method==="GET") {
    const q=(url.searchParams.get("q")||"").trim().toUpperCase();if(!q||q.length>30)return json({assets:[]},200,headers);
    const auth={"APCA-API-KEY-ID":env.ALPACA_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET};
    const r=await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",{headers:auth});
    if(!r.ok)return json({error:"Alpaca asset search failed",status:r.status},502,headers);
    const all=await r.json(),assets=all.filter(a=>a.tradable&&a.exchange&&((a.symbol||"").toUpperCase().includes(q)||(a.name||"").toUpperCase().includes(q))).slice(0,20).map(a=>({symbol:a.symbol,name:a.name,exchange:a.exchange}));
    return json({assets},200,headers);
  }
  if(url.pathname==="/api/market"&&request.method==="GET") {
    const requested=(url.searchParams.get("symbols")||DEFAULT_SYMBOLS.join(",")).split(",").map(cleanSymbol).filter(validSymbol);
    const symbols=[...new Set(requested)],tf=(url.searchParams.get("timeframe")||"1Day").toLowerCase()==="4hour"?"4Hour":"1Day";
    if(!symbols.length)return json({error:"No supported symbols requested"},400,headers);
    if(symbols.length>50)return json({error:"Maximum 50 symbols per request",max:50},400,headers);
    try{return json(await fetchMarket(env,symbols,tf),200,headers);}
    catch(e){return json({error:"Market data request failed",detail:String(e).slice(0,300)},502,headers);}
  }
  return json({error:"Not found"},404,headers);
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get("Origin")||"",headers=corsHeaders(origin);
    if(url.pathname==="/line/webhook")return request.method==="POST"?handleLineWebhook(request,env):json({error:"Method not allowed"},405);
    if(request.method==="OPTIONS")return origin&&!ALLOWED_ORIGINS.has(origin)?json({error:"Origin not allowed"},403,headers):new Response(null,{status:204,headers});
    if(origin&&!ALLOWED_ORIGINS.has(origin))return json({error:"Origin not allowed",origin},403,headers);
    if(url.pathname==="/"&&request.method==="GET")return json({service:"AI Stock Watcher API",status:"ready",multiUser:true,d1:dbReady(env),maxWatchlist:MAX_WATCHLIST,feed:"Alpaca IEX",scheduledScan:"*/15 * * * *"},200,headers);
    if(request.method!=="GET"&&request.method!=="POST")return json({error:"Method not allowed"},405,headers);
    try{return await apiHandler(request,env,url,headers);}catch(e){console.error("API_ERROR",String(e));return json({error:"Internal API error",detail:String(e).slice(0,250)},500,headers);}
  },
  async scheduled(event,env,ctx) {
    ctx.waitUntil(scanAlerts(env));
  }
};
