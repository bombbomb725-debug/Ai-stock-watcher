const MAX_WATCHLIST = 50;
const ALLOWED_ORIGINS = new Set(["https://bombbomb725-debug.github.io"]);
const encoder = new TextEncoder();
// 50-symbol discovery universe from recent public @StockSavvyShay X-post tracking (90-day window).
// These are mentions/watchlist candidates, not all explicit buy recommendations.
const SHAY_STOCK_UNIVERSE = ["NVDA","RKLB","META","NBIS","GOOGL","AMZN","MU","AMD","IREN","CRWV","PLTR","TSLA","ONDS","SKHY","ASTS","AVGO","INTC","TSM","CIFR","CRWD","MRVL","BE","ORCL","AAPL","VRT","SNDK","CRDO","SOFI","CBRS","AEHR","LITE","NVTS","ON","ARM","SNOW","QCOM","AAOI","GEV","DELL","MELI","WULF","NOW","APP","IONQ","ASML","VPG","ZETA","CORMA","PANW","NEA"];
const SHAY_SOURCE_UPDATED_AT = "2026-11-17";
const SHAY_LAST_REVIEWED_AT = "2026-11-19";

function corsHeaders(origin) {
  const h = { "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization", "Access-Control-Max-Age":"86400", "Vary":"Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
}
function validSymbol(s) { return /^(?:[A-Z][A-Z0-9.]{0,9}|[A-Z0-9]{1,8}\.BK)$/.test(s); }
function cleanSymbol(s) { return String(s||"").trim().toUpperCase(); }
function isThaiSymbol(s) { return /^[A-Z0-9]{1,8}\.BK$/.test(String(s||"").toUpperCase()); }
let thaiSecuritiesCache=null,thaiSecuritiesCacheAt=0;
async function getThaiSecurities() {
  if(thaiSecuritiesCache&&Date.now()-thaiSecuritiesCacheAt<21600000)return thaiSecuritiesCache;
  const r=await fetch("https://raw.githubusercontent.com/lumduan/thai-securities-data/main/thai_securities_compact_th.json");
  if(!r.ok)throw new Error("Thai directory HTTP "+r.status);
  const data=await r.json();if(!Array.isArray(data))throw new Error("Thai directory format invalid");
  thaiSecuritiesCache=data;thaiSecuritiesCacheAt=Date.now();return data;
}
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
async function sha256Hex(value) {
  const digest=await crypto.subtle.digest("SHA-256",encoder.encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
function randomToken(bytes=32) {
  const data=crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}
function randomPairCode() {
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const data=crypto.getRandomValues(new Uint8Array(10));
  return Array.from(data,b=>alphabet[b&31]).join("");
}
async function ensureLinkTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS web_link_sessions (token_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, user_id INTEGER, expires_at INTEGER NOT NULL, code_expires_at INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)").run();
}
async function authenticate(request,env) {
  const auth=request.headers.get("Authorization")||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token)return null;
  const tokenHash=await sha256Hex(token);
  const row=await env.DB.prepare("SELECT u.id,u.line_user_id,u.display_name FROM web_link_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(tokenHash,Math.floor(Date.now()/1000)).first();
  return row||null;
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
  // Existing LINE users need only one lookup; do not issue a no-op UPDATE + SELECT.
  const user=await env.DB.prepare("SELECT id,line_user_id,display_name FROM users WHERE line_user_id=?").bind(lineUserId).first();
  if(user) {
    if(profile.name && profile.name!==user.display_name) {
      await env.DB.prepare("UPDATE users SET display_name=? WHERE line_user_id=?").bind(profile.name,lineUserId).run();
      user.display_name=profile.name;
    }
    return user;
  }
  await env.DB.prepare("INSERT INTO users(line_user_id,display_name) VALUES(?,?)").bind(lineUserId,profile.name||null).run();
  const created=await env.DB.prepare("SELECT id,line_user_id,display_name FROM users WHERE line_user_id=?").bind(lineUserId).first();
  if(!created)throw new Error("สร้างข้อมูลผู้ใช้ใน D1 ไม่สำเร็จ");
  return created;
}
async function normalizeSymbols(env,symbols) {
  const input=[...new Set((symbols||[]).map(cleanSymbol))];
  const knownThai=new Set(["UVAN"]);
  const bare=input.filter(s=>/^[A-Z0-9]{1,8}$/.test(s));
  if(!bare.length)return input;
  let thai=knownThai;
  try {
    const directory=await getThaiSecurities();
    thai=new Set([...knownThai,...directory.map(x=>String(x.symbol||"").toUpperCase())]);
  } catch(e) {
    console.warn("THAI_SYMBOL_RESOLUTION_UNAVAILABLE",String(e));
  }
  return input.map(s=>thai.has(s)?s+".BK":s);
}
async function normalizeSymbol(env,symbol) {
  return (await normalizeSymbols(env,[symbol]))[0]||cleanSymbol(symbol);
}
async function getWatchlist(env,userId) {
  const r=await env.DB.prepare("SELECT symbol FROM watchlist WHERE user_id=? ORDER BY COALESCE(added_at,created_at),symbol").bind(userId).all();
  const raw=(r.results||[]).map(x=>cleanSymbol(x.symbol));
  // Watchlist symbols are normalized when added. Avoid a remote Thai-directory
  // lookup on every list request; repair the one known legacy bare ticker locally.
  const normalized=raw.map(s=>s==="UVAN"?"UVAN.BK":s);
  for(let i=0;i<raw.length;i++) {
    if(normalized[i]!==raw[i]) {
      await env.DB.prepare("UPDATE watchlist SET symbol=? WHERE user_id=? AND symbol=?").bind(normalized[i],userId,raw[i]).run();
    }
  }
  return [...new Set(normalized)];
}
async function addWatch(env,userId,symbol,market="AUTO") {
  market=String(market||"AUTO").toUpperCase();
  if(market==="US") {
    symbol=cleanSymbol(symbol);
    if(!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)||isThaiSymbol(symbol))throw new Error("Ticker หุ้นสหรัฐฯ ไม่ถูกต้อง");
  } else if(market==="THAI") {
    symbol=cleanSymbol(symbol).replace(/\.BK$/,"")+".BK";
    if(!isThaiSymbol(symbol))throw new Error("Ticker หุ้นไทยไม่ถูกต้อง");
  } else {
    symbol=await normalizeSymbol(env,symbol);
  }
  await getWatchlist(env,userId);
  const exists=await env.DB.prepare("SELECT 1 AS yes FROM watchlist WHERE user_id=? AND symbol=?").bind(userId,symbol).first();
  if(exists)return {ok:true,already:true,symbols:await getWatchlist(env,userId)};
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE user_id=?").bind(userId).first();
  if(count.n>=MAX_WATCHLIST)return {ok:false,error:"ครบจำนวนสูงสุด 50 หุ้นต่อคนแล้ว",symbols:await getWatchlist(env,userId)};
  await env.DB.prepare("INSERT INTO watchlist(user_id,symbol) VALUES(?,?)").bind(userId,symbol).run();
  return {ok:true,symbols:await getWatchlist(env,userId)};
}
async function removeWatch(env,userId,symbol) {
  symbol=await normalizeSymbol(env,symbol);
  await getWatchlist(env,userId);
  await env.DB.prepare("DELETE FROM watchlist WHERE user_id=? AND symbol=?").bind(userId,symbol).run();
  await env.DB.prepare("DELETE FROM user_stock_state WHERE user_id=? AND symbol=?").bind(userId,symbol).run();
  return {ok:true,symbols:await getWatchlist(env,userId)};
}

function richMenuFont() {
  const rows={
    A:"01110/10001/10001/11111/10001/10001/10001",B:"11110/10001/10001/11110/10001/10001/11110",
    C:"01111/10000/10000/10000/10000/10000/01111",D:"11110/10001/10001/10001/10001/10001/11110",
    E:"11111/10000/10000/11110/10000/10000/11111",F:"11111/10000/10000/11110/10000/10000/10000",
    G:"01111/10000/10000/10111/10001/10001/01111",H:"10001/10001/10001/11111/10001/10001/10001",
    I:"11111/00100/00100/00100/00100/00100/11111",J:"00111/00010/00010/00010/10010/10010/01100",
    K:"10001/10010/10100/11000/10100/10010/10001",L:"10000/10000/10000/10000/10000/10000/11111",
    M:"10001/11011/10101/10101/10001/10001/10001",N:"10001/11001/10101/10011/10001/10001/10001",
    O:"01110/10001/10001/10001/10001/10001/01110",P:"11110/10001/10001/11110/10000/10000/10000",
    Q:"01110/10001/10001/10001/10101/10010/01101",R:"11110/10001/10001/11110/10100/10010/10001",
    S:"01111/10000/10000/01110/00001/00001/11110",T:"11111/00100/00100/00100/00100/00100/00100",
    U:"10001/10001/10001/10001/10001/10001/01110",V:"10001/10001/10001/10001/10001/01010/00100",
    W:"10001/10001/10001/10101/10101/10101/01010",X:"10001/10001/01010/00100/01010/10001/10001",
    Y:"10001/10001/01010/00100/00100/00100/00100",Z:"11111/00001/00010/00100/01000/10000/11111",
    " ":"00000/00000/00000/00000/00000/00000/00000"
  };
  return Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.split("/").map(x=>x.split("").map(Number))]));
}
function richMenuPng() {
  const w=2500,h=1686,pixels=new Uint8Array(w*h*3),font=richMenuFont();
  const rgb=(x,y,c)=>{if(x<0||y<0||x>=w||y>=h)return;const i=(y*w+x)*3;pixels[i]=c[0];pixels[i+1]=c[1];pixels[i+2]=c[2];};
  const rect=(x0,y0,x1,y1,c)=>{for(let y=Math.max(0,y0);y<Math.min(h,y1);y++)for(let x=Math.max(0,x0);x<Math.min(w,x1);x++)rgb(x,y,c);};
  const disk=(cx,cy,r,c)=>{for(let y=-r;y<=r;y++)for(let x=-r;x<=r;x++)if(x*x+y*y<=r*r)rgb(cx+x,cy+y,c);};
  const line=(x0,y0,x1,y1,c,t=16)=>{const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let err=dx-dy,x=x0,y=y0;for(;;){disk(x,y,Math.floor(t/2),c);if(x===x1&&y===y1)break;const e=2*err;if(e>-dy){err-=dy;x+=sx;}if(e<dx){err+=dx;y+=sy;}}};
  const text=(str,cx,top,scale,color)=>{const chars=[...str],cw=6*scale,total=chars.length*cw-scale,left=Math.round(cx-total/2);chars.forEach((ch,i)=>{const g=font[ch]||font[" "];g.forEach((row,yy)=>row.forEach((v,xx)=>{if(v)rect(left+i*cw+xx*scale,top+yy*scale,left+i*cw+(xx+1)*scale,top+(yy+1)*scale,color);}));});};
  rect(0,0,w,h,[9,18,33]);
  const labels=["MY WATCHLIST","ADD STOCK","REMOVE STOCK","BUY ZONE","AI PICKS","ALERTS"];
  const accents=[[83,139,235],[49,177,139],[225,91,105],[58,159,207],[161,119,221],[220,165,69]];
  const cw=Math.floor(w/3),ch=Math.floor(h/2),white=[240,246,255];
  for(let i=0;i<6;i++){
    const r=Math.floor(i/3),c=i%3,x0=c*cw,y0=r*ch,x1=(c+1)*cw,y1=(r+1)*ch,accent=accents[i];
    rect(x0+22,y0+22,x1-22,y1-22,[17,33,55]);
    rect(x0+22,y0+22,x1-22,y0+28,[35,56,82]);
    rect(x0+22,y1-28,x1-22,y1-22,[35,56,82]);
    const cx=Math.floor((x0+x1)/2),cy=y0+300;
    disk(cx,cy,118,[Math.floor(accent[0]*.22),Math.floor(accent[1]*.22),Math.floor(accent[2]*.22)]);
    for(let a=0;a<360;a+=1){const rad=a*Math.PI/180;rgb(Math.round(cx+114*Math.cos(rad)),Math.round(cy+114*Math.sin(rad)),accent);}
    if(i===0){line(cx-58,cy+50,cx-58,cy-42,white);line(cx,cy+50,cx,cy-4,white);line(cx+58,cy+50,cx+58,cy-70,white);line(cx-78,cy+65,cx+78,cy+65,white);}
    else if(i===1||i===2){line(cx-62,cy,cx+62,cy,white,20);if(i===1)line(cx,cy-62,cx,cy+62,white,20);}
    else if(i===3){line(cx-70,cy+45,cx-22,cy-8,white);line(cx-22,cy-8,cx+14,cy+20,white);line(cx+14,cy+20,cx+70,cy-52,white);}
    else if(i===4){disk(cx,cy,67,white);disk(cx,cy,45,[Math.floor(accent[0]*.22),Math.floor(accent[1]*.22),Math.floor(accent[2]*.22)]);line(cx-76,cy+76,cx-25,cy+24,white);line(cx-25,cy+24,cx+4,cy+42,white);line(cx+4,cy+42,cx+72,cy-38,white);}
    else {disk(cx,cy-8,66,white);disk(cx,cy-8,48,[Math.floor(accent[0]*.22),Math.floor(accent[1]*.22),Math.floor(accent[2]*.22)]);rect(cx-15,cy+35,cx+16,cy+67,white);disk(cx,cy+80,14,white);line(cx,cy-95,cx,cy-75,white);line(cx-92,cy-42,cx-72,cy-32,white);line(cx+92,cy-42,cx+72,cy-32,white);}
    text(labels[i],cx,y0+535,10,white);
    text("AI STOCK WATCHER",cx,y0+640,4,[135,157,185]);
  }
  rect(cw-2,12,cw+2,h-12,[39,58,82]);rect(2*cw-2,12,2*cw+2,h-12,[39,58,82]);rect(12,ch-2,w-12,ch+2,[39,58,82]);
  const raw=new Uint8Array(h*(1+w*3));let p=0;
  for(let y=0;y<h;y++){raw[p++]=0;const start=y*w*3;raw.set(pixels.subarray(start,start+w*3),p);p+=w*3;}
  return new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
}
function pngChunk(type,data) {
  const name=encoder.encode(type),out=new Uint8Array(12+data.length),view=new DataView(out.buffer);
  view.setUint32(0,data.length);out.set(name,4);out.set(data,8);
  let crc=0xffffffff;for(let i=4;i<8+data.length;i++){crc^=out[i];for(let j=0;j<8;j++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;}
  view.setUint32(8+data.length,(crc^0xffffffff)>>>0);return out;
}
async function makeRichMenuImage() {
  const compressed=new Uint8Array(await new Response(await richMenuPng()).arrayBuffer());
  const ihdr=new Uint8Array(13),v=new DataView(ihdr.buffer);v.setUint32(0,2500);v.setUint32(4,1686);ihdr[8]=8;ihdr[9]=2;
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk("IHDR",ihdr),pngChunk("IDAT",compressed),pngChunk("IEND",new Uint8Array())];
  const size=parts.reduce((n,x)=>n+x.length,0),out=new Uint8Array(size);let off=0;for(const x of parts){out.set(x,off);off+=x.length;}return out;
}
async function ensureRichMenu(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS line_bot_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  const saved=await env.DB.prepare("SELECT value FROM line_bot_settings WHERE key='rich_menu_id'").first();
  if(saved?.value)return saved.value;
  const headers={"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN};
  const listRes=await fetch("https://api.line.me/v2/bot/richmenu/list",{headers});
  if(!listRes.ok)throw new Error("LINE rich menu list "+listRes.status+": "+(await listRes.text()).slice(0,250));
  const listed=await listRes.json();
  let menu=(listed.richmenus||[]).find(x=>x.name==="AI Stock Watcher · 6 Buttons");
  if(!menu){
    const areas=[],actions=["ดูหุ้นของฉัน","เพิ่มหุ้น","ลบหุ้น","ราคาเข้าซื้อ","หุ้นน่าสนใจ","ตั้งค่าแจ้งเตือน"];
    const widths=[833,834,833];
    for(let i=0;i<6;i++){const row=Math.floor(i/3),col=i%3;const x=col===0?0:col===1?833:1667;areas.push({bounds:{x,y:row*843,width:widths[col],height:843},action:{type:"message",label:actions[i],text:actions[i]}});}
    const create=await fetch("https://api.line.me/v2/bot/richmenu",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({size:{width:2500,height:1686},selected:true,name:"AI Stock Watcher · 6 Buttons",chatBarText:"เมนู AI Stock",areas})});
    if(!create.ok)throw new Error("LINE rich menu create "+create.status+": "+(await create.text()).slice(0,300));
    menu=await create.json();
  }
  const image=await makeRichMenuImage();
  const upload=await fetch("https://api-data.line.me/v2/bot/richmenu/"+menu.richMenuId+"/content",{method:"POST",headers:{...headers,"Content-Type":"image/png"},body:image});
  if(!upload.ok)throw new Error("LINE rich menu image "+upload.status+": "+(await upload.text()).slice(0,300));
  const set=await fetch("https://api.line.me/v2/bot/user/all/richmenu/"+menu.richMenuId,{method:"POST",headers});
  if(!set.ok)throw new Error("LINE set default rich menu "+set.status+": "+(await set.text()).slice(0,300));
  await env.DB.prepare("INSERT INTO line_bot_settings(key,value) VALUES('rich_menu_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(menu.richMenuId).run();
  return menu.richMenuId;
}

function watchlistQuickReply(symbols) {
  const items=(symbols||[]).slice(0,13).map(symbol=>({
    type:"action",
    action:{type:"message",label:symbol,text:"ลบ "+symbol}
  }));
  return items.length?{items}:undefined;
}
function stockActionConfirmQuickReply() {
  return {items:[
    {type:"action",action:{type:"message",label:"ยืนยัน",text:"ยืนยัน"}},
    {type:"action",action:{type:"message",label:"ยกเลิก",text:"ยกเลิก"}}
  ]};
}
async function ensurePendingStockActionTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS line_pending_stock_actions (user_id INTEGER PRIMARY KEY, action TEXT NOT NULL, symbols_json TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)").run();
}
async function lineReply(env,replyToken,text,quickReply) {
  if(!replyToken||!env.LINE_CHANNEL_ACCESS_TOKEN)return;
  const message={type:"text",text:String(text).slice(0,4900)};
  if(quickReply?.items?.length)message.quickReply=quickReply;
  const r=await fetch("https://api.line.me/v2/bot/message/reply",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({replyToken,messages:[message]})});
  if(!r.ok)console.error("LINE_REPLY_FAILED",r.status,(await r.text()).slice(0,250));
}
async function lineReplyFlex(env,replyToken,contents,altText="AI Stock Watcher · Watchlist") {
  if(!replyToken||!env.LINE_CHANNEL_ACCESS_TOKEN)return false;
  const message={type:"flex",altText,contents};
  try {
    const r=await fetch("https://api.line.me/v2/bot/message/reply",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({replyToken,messages:[message]})});
    if(r.ok)return true;
    const detail=(await r.text()).slice(0,300);
    console.error("LINE_FLEX_REPLY_FAILED",r.status,detail);
    await lineReply(env,replyToken,"ระบบแสดงการ์ดหุ้นไม่สำเร็จ ("+r.status+") กรุณาลองพิมพ์ “รายการหุ้น” อีกครั้ง");
    return false;
  } catch(e) {
    console.error("LINE_FLEX_REPLY_ERROR",String(e));
    await lineReply(env,replyToken,"ระบบแสดงการ์ดหุ้นขัดข้อง กรุณาลองพิมพ์ “รายการหุ้น” อีกครั้ง");
    return false;
  }
}
function stockChartImageUrl(bars) {
  const all=(bars||[]).map(x=>Number(x.c)).filter(Number.isFinite);
  if(all.length<2)return null;
  const e20=emaSeries(all,20),e50=emaSeries(all,50),n=Math.min(24,all.length);
  const values=all.slice(-n),a20=e20.slice(-n),a50=e50.slice(-n);
  const config={type:"line",data:{labels:values.map((_,i)=>i+1),datasets:[
    {label:"Price",data:values,borderColor:"#55A7FF",borderWidth:2,pointRadius:0,fill:false},
    {label:"EMA20",data:a20,borderColor:"#F2B84B",borderWidth:1,pointRadius:0,fill:false,spanGaps:true},
    {label:"EMA50",data:a50,borderColor:"#B58BEB",borderWidth:1,pointRadius:0,fill:false,spanGaps:true}
  ]},options:{legend:{display:false},scales:{xAxes:[{display:false}],yAxes:[{ticks:{maxTicksLimit:3}}]}}};
  const url="https://quickchart.io/chart?width=600&height=220&format=png&c="+encodeURIComponent(JSON.stringify(config));
  return url.length<=2000?url:null;
}
function stockEntryPlan(bars,timezone="America/New_York") {
  const last=bars[bars.length-1];
  const localDate=d=>new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  const done=last?.t&&localDate(new Date(last.t))===localDate(new Date())?bars.slice(0,-1):bars;
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<20)return null;
  const e20=ema(closes,20);
  if(!Number.isFinite(e20))return null;
  const tr=[];
  for(let i=1;i<done.length;i++){
    const h=Number(done[i].h),l=Number(done[i].l),pc=Number(done[i-1].c);
    if([h,l,pc].every(Number.isFinite))tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  if(tr.length<14)return null;
  const atr=tr.slice(-14).reduce((a,b)=>a+b,0)/14;
  const lows=done.slice(-20).map(b=>Number(b.l)).filter(Number.isFinite);
  const support=lows.length?Math.min(...lows):e20-atr;
  const low=Math.max(e20-.35*atr,e20*.985);
  const high=e20+.15*atr;
  const stop=Math.min(support,e20-1.2*atr);
  const risk=Math.max(high-stop,atr*.5);
  return {low,high,stop,target:high+2*risk};
}
function thaiStockFlexBubble(symbol) {
  const ticker=String(symbol).replace(/\.BK$/i,"");
  const url="https://www.tradingview.com/chart/?symbol="+encodeURIComponent("SET:"+ticker);
  return {type:"bubble",size:"kilo",body:{type:"box",layout:"vertical",backgroundColor:"#10243A",paddingAll:"16px",contents:[
    {type:"text",text:ticker,size:"3xl",weight:"bold",color:"#FFFFFF"},
    {type:"text",text:"หุ้นไทย · SET/mai",size:"sm",color:"#A9B8CC"},
    {type:"text",text:"กราฟ TradingView เท่านั้น",size:"md",weight:"bold",color:"#F2C46D",margin:"lg"},
    {type:"text",text:"ยังไม่มีข้อมูล OHLC ฟรีที่ยืนยันได้ จึงไม่คำนวณ RSI/MACD/ADX หรือแจ้งเตือนสัญญาณ",size:"xs",color:"#A9B8CC",wrap:true,margin:"sm"}
  ]},footer:{type:"box",layout:"vertical",paddingAll:"12px",contents:[{type:"button",style:"primary",color:"#2877C7",action:{type:"uri",label:"เปิดกราฟ",uri:url}}]}};
}
function watchlistStatusBubble(symbol,state,dashboardUrl) {
  const thai=isThaiSymbol(symbol),currency=thai?"฿":"$";
  const price=Number(state?.last_price);
  const priceText=Number.isFinite(price)&&price>0?currency+price.toFixed(2):"ยังไม่มีราคาล่าสุด";
  const status=state?.status_label||"รอข้อมูลสแกนรอบแรก";
  const score=state?.score===null||state?.score===undefined?"—/5":Number(state.score)+"/5";
  const checked=state?.checked_at?new Date(state.checked_at).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"}):"รอรอบสแกน";
  const tone=state?.status==="buy"?"#16A36A":state?.status==="risk"?"#D94B59":"#D69B28";
  return {
    type:"bubble",size:"kilo",
    header:{type:"box",layout:"horizontal",contents:[
      {type:"text",text:symbol,weight:"bold",size:"xl",color:"#FFFFFF",flex:1},
      {type:"text",text:thai?"THAI STOCK":"US STOCK",size:"xs",color:"#A9B8CC",align:"end",gravity:"center"}
    ],backgroundColor:"#132238",paddingAll:"16px"},
    body:{type:"box",layout:"vertical",spacing:"md",contents:[
      {type:"text",text:priceText,size:"3xl",weight:"bold",color:"#FFFFFF"},
      {type:"box",layout:"baseline",spacing:"sm",contents:[
        {type:"text",text:"สถานะ",size:"sm",color:"#A9B8CC",flex:1},
        {type:"text",text:status,size:"sm",weight:"bold",color:tone,wrap:true,flex:4}
      ]},
      {type:"box",layout:"baseline",spacing:"sm",contents:[
        {type:"text",text:"คะแนน AI",size:"sm",color:"#A9B8CC",flex:1},
        {type:"text",text:score,size:"sm",weight:"bold",color:"#FFFFFF",flex:4}
      ]},
      {type:"text",text:"ข้อมูลสถานะล่าสุด · "+checked,size:"xs",color:"#8293A9",wrap:true}
    ],backgroundColor:"#0D1828",paddingAll:"16px"},
    footer:{type:"box",layout:"vertical",contents:[
      {type:"button",style:"primary",color:"#315FDB",action:{type:"uri",label:"เปิดกราฟและรายละเอียด",uri:dashboardUrl+"?symbol="+encodeURIComponent(symbol)+"&utm_source=line"}}
    ],backgroundColor:"#0D1828",paddingAll:"12px"}
  };
}
function stockFlexBubble(symbol,trade,state,dashboardUrl,bars=[],dailyBars=[]) {
  const thai=isThaiSymbol(symbol),currency=thai?"฿":"$";
  const price=Number(trade?.p);
  const priceText=Number.isFinite(price)?currency+price.toFixed(2):"ยังไม่มีราคาล่าสุด";
  const detail=analyzeStatus(dailyBars,price,thai?"Asia/Bangkok":"America/New_York");
  const dataUnavailable=thai&&(!trade||!Number.isFinite(price)||!dailyBars||dailyBars.length<20);
  const status=dataUnavailable?"รอข้อมูล":(state?.status_label||detail.label);
  const score=dataUnavailable?"—/5":(state&&state.score!==null&&state.score!==undefined?Number(state.score)+"/5":detail.score+"/5");
  const checked=state?.checked_at?new Date(state.checked_at).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"}):"คำนวณล่าสุด";
  const tone=!dataUnavailable&&(state?.status||detail.status)==="buy"?"#16A36A":!dataUnavailable&&(state?.status||detail.status)==="risk"?"#D94B59":"#D69B28";
  const chartUrl=stockChartImageUrl(bars);
  const plan=stockEntryPlan(dailyBars,thai?"Asia/Bangkok":"America/New_York");
  const money=n=>currency+Number(n).toFixed(2);
  const contents=[];
  if(chartUrl)contents.push({type:"image",url:chartUrl,size:"full",aspectRatio:"20:7",aspectMode:"fit"});
  contents.push(
    {type:"text",text:priceText,size:"3xl",weight:"bold",color:"#FFFFFF"},
    {type:"box",layout:"baseline",spacing:"sm",contents:[
      {type:"text",text:"สถานะ",size:"sm",color:"#A9B8CC",flex:1},
      {type:"text",text:status,size:"sm",weight:"bold",color:tone,wrap:true,flex:4}
    ]},
    {type:"box",layout:"baseline",spacing:"sm",contents:[
      {type:"text",text:"คะแนน AI",size:"sm",color:"#A9B8CC",flex:1},
      {type:"text",text:score,size:"sm",weight:"bold",color:"#FFFFFF",flex:4}
    ]},
    {type:"text",text:dataUnavailable?"EMA20/50 — / — · RSI14 — · MACD — · ADX14 —":"EMA20/50 "+(Number.isFinite(detail.ema20)?detail.ema20.toFixed(2):"—")+" / "+(Number.isFinite(detail.ema50)?detail.ema50.toFixed(2):"—")+" · RSI14 "+(Number.isFinite(detail.rsi)?detail.rsi.toFixed(1):"—")+" · MACD "+(Number.isFinite(detail.macd)?detail.macd.toFixed(3):"—")+" · ADX14 "+(Number.isFinite(detail.adx)?detail.adx.toFixed(1):"—"),size:"xs",color:"#A9B8CC",wrap:true},
    {type:"text",text:(thai?"ราคาอ้างอิง DataCedar · ราคาปิดรายวัน":"กราฟราคาและข้อมูลรายวัน · Alpaca IEX")+" · อัปเดตสัญญาณ: "+checked,size:"xs",color:"#8293A9",wrap:true}
  );
  if(plan)contents.push(
    {type:"separator",margin:"md",color:"#314158"},
    {type:"text",text:"โซนราคาเฝ้ารอเข้าซื้อ (กรอบรายวัน)",size:"sm",weight:"bold",color:"#FFFFFF"},
    {type:"text",text:money(plan.low)+" – "+money(plan.high),size:"xl",weight:"bold",color:"#69C79A"},
    {type:"box",layout:"horizontal",spacing:"md",contents:[
      {type:"box",layout:"vertical",flex:1,contents:[
        {type:"text",text:"เป้าหมาย 2R",size:"xs",color:"#A9B8CC"},
        {type:"text",text:money(plan.target),size:"sm",weight:"bold",color:"#69C79A"}
      ]},
      {type:"box",layout:"vertical",flex:1,contents:[
        {type:"text",text:"จุดตัดขาดทุน",size:"xs",color:"#A9B8CC"},
        {type:"text",text:money(plan.stop),size:"sm",weight:"bold",color:"#F08080"}
      ]}
    ]},
    {type:"text",text:"ราคาอ้างอิงจากแท่งรายวันที่ปิดแล้ว · เป็นโซนประมาณการ ไม่ใช่คำสั่งซื้อ",size:"xs",color:"#8293A9",wrap:true}
  );
  else contents.push({type:"text",text:dataUnavailable?"แหล่งข้อมูลราคาหุ้นไทยขัดข้องหรือข้อมูลย้อนหลังไม่ครบ จึงยังไม่ประเมินแนวโน้มและโซนเข้าซื้อ":"ข้อมูลรายวันยังไม่พอคำนวณโซนเข้าซื้อ",size:"xs",color:"#D69B28",wrap:true});
  return {
    type:"bubble",size:"kilo",
    header:{type:"box",layout:"horizontal",contents:[
      {type:"text",text:symbol,weight:"bold",size:"xl",color:"#FFFFFF",flex:1},
      {type:"text",text:thai?"THAI STOCK":"US STOCK",size:"xs",color:"#A9B8CC",align:"end",gravity:"center"}
    ],backgroundColor:"#132238",paddingAll:"16px"},
    body:{type:"box",layout:"vertical",spacing:"md",contents,backgroundColor:"#0D1828",paddingAll:"16px"},
    footer:{type:"box",layout:"vertical",contents:[
      {type:"button",style:"primary",color:"#315FDB",action:{type:"uri",label:"เปิดกราฟเต็มบนเว็บ",uri:dashboardUrl+"?symbol="+encodeURIComponent(symbol)+"&utm_source=line"}}
    ],backgroundColor:"#0D1828",paddingAll:"12px"}
  };
}
async function linePush(env,userId,text) {
  const r=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({to:userId,messages:[{type:"text",text:String(text).slice(0,4900)}]})});
  if(!r.ok)throw new Error("LINE push failed "+r.status+" "+(await r.text()).slice(0,200));
}
async function linePushMessages(env,userId,messages) {
  const r=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({to:userId,messages}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error("LINE push failed "+r.status+" "+(await r.text()).slice(0,250));
}
function parseSymbols(value) {
  const raw=String(value||"").trim().split(/[\s,，;；]+/).filter(Boolean).map(cleanSymbol);
  if(!raw.length||raw.some(x=>!validSymbol(x)))return null;
  return [...new Set(raw)];
}
function parseLineCommand(text) {
  const t=String(text||"").trim();
  if(/^(?:ยืนยัน|confirm)$/i.test(t))return {action:"confirm_stock_action"};
  if(/^(?:ยกเลิก|cancel)$/i.test(t))return {action:"cancel_stock_action"};
  let m=t.match(/^(?:เพิ่ม|add|\/add)\s+(.+)$/i);
  if(m){const symbols=parseSymbols(m[1]);return symbols?{action:"add",symbols}:{action:"invalid_symbols"};}
  m=t.match(/^(?:ลบ|remove|\/remove)\s+(.+)$/i);
  if(m){const symbols=parseSymbols(m[1]);return symbols?{action:"remove",symbols}:{action:"invalid_symbols"};}
  m=t.match(/^(?:รายการหุ้น|รายชื่อหุ้น|ดูรายการหุ้น|ดูหุ้น|list|\/list)(?:\s+(\d+))?$/i); if(m)return {action:"list",page:Math.max(1,Number(m[1]||1))};
  m=t.match(/^(?:เชื่อม|link)\s+([A-Z2-9]{8,12})$/i); if(m)return {action:"link",code:m[1].toUpperCase()};
  if(/^(?:ทดสอบแจ้งเตือน|ทดสอบการแจ้งเตือน|test alert|\/test-alert)$/i.test(t))return {action:"test"};
  if(/^(?:หุ้นแนะนำ|แนะนำหุ้น|หุ้นที่น่าสนใจ|หุ้นน่าสนใจ|ideas|\/ideas)$/i.test(t))return {action:"ideas"};
  if(/^(?:ราคาเข้าซื้อ|buy zones|โซนเฝ้าระวังหุ้น|โซนเข้าซื้อ)$/i.test(t))return {action:"buy_zones",page:1};
  if(/^(?:ดูหุ้นของฉัน|ดูหุ้น|menu|เมนู)$/i.test(t))return {action:"list",page:1};
  if(/^(?:เพิ่มหุ้น|add stock)$/i.test(t))return {action:"add_prompt"};
  if(/^(?:ลบหุ้น|remove stock)$/i.test(t))return {action:"remove_menu"};
  if(/^(?:ตั้งค่าแจ้งเตือน|settings)$/i.test(t))return {action:"settings"};
  if(/^(?:เปิดแจ้งเตือน|แจ้งเตือนเปิด)$/i.test(t))return {action:"alert_on"};
  if(/^(?:ปิดแจ้งเตือน|แจ้งเตือนปิด)$/i.test(t))return {action:"alert_off"};
  return {action:"help"};
}
async function handleLineWebhook(raw,signature,env) {
  if(!env.LINE_CHANNEL_SECRET||!env.LINE_CHANNEL_ACCESS_TOKEN)return json({error:"LINE secrets are missing"},503);
  if(!dbReady(env))return json({error:"D1 binding DB is missing"},503);
  if(!await verifyLineSignature(raw,signature||"",env.LINE_CHANNEL_SECRET))return json({error:"Invalid LINE signature"},401);
  let payload; try{payload=JSON.parse(new TextDecoder().decode(raw));}catch{return json({error:"Invalid JSON"},400);}
  await ensurePendingStockActionTable(env);
  const nowForCleanup=Math.floor(Date.now()/1000);
  await env.DB.prepare("DELETE FROM line_pending_stock_actions WHERE expires_at<=?").bind(nowForCleanup).run();
  for(const event of payload.events||[]) {
    const lineUserId=event.source?.userId;
    if(!lineUserId)continue;
    if(event.type==="unfollow")continue;
    if(event.type==="follow") {
      try {
        const activeRichMenuId=await ensureRichMenu(env);
        const mr=await fetch("https://api.line.me/v2/bot/user/"+lineUserId+"/richmenu/"+activeRichMenuId,{method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN}});
        if(!mr.ok)console.error("LINE_USER_RICH_MENU_LINK_FAILED",mr.status,(await mr.text()).slice(0,200));
      } catch(e) { console.error("LINE_RICH_MENU_SETUP_FAILED",String(e)); }
    }
    const isTextMessage=event.type==="message"&&event.message?.type==="text";
    const cmd=isTextMessage?parseLineCommand(event.message.text):null;
    const user=await createOrUpdateUser(env,lineUserId,{});
    if(event.type==="follow") {
      await lineReply(env,event.replyToken,"ยินดีต้อนรับสู่ AI Stock Watcher!\nเริ่มต้นติดตาม: ASTS, RKLB, IONQ, OKLO\nสูงสุด 50 หุ้นต่อคน\n\nเชื่อมเว็บ: เปิดเว็บไซต์ AI Stock Watcher แล้วพิมพ์ “เชื่อม รหัส” ในแชตนี้");
      continue;
    }
    if(!isTextMessage)continue;
    const now=Math.floor(Date.now()/1000);
    await env.DB.prepare("DELETE FROM user_input_modes WHERE user_id=? AND expires_at<=?").bind(user.id,now).run();
    const inputMode=await env.DB.prepare("SELECT mode FROM user_input_modes WHERE user_id=? AND expires_at>?").bind(user.id,now).first();
    if(inputMode && !["link","add_prompt","remove_menu","settings","alert_on","alert_off","list","ideas","test"].includes(cmd.action)) {
      const symbols=parseSymbols(event.message.text);
      if(symbols)cmd.action=inputMode.mode==="add"?"add":"remove",cmd.symbols=symbols;
    }
    if(cmd.action==="confirm_stock_action"||cmd.action==="cancel_stock_action") {
      const pending=await env.DB.prepare("SELECT action,symbols_json,expires_at FROM line_pending_stock_actions WHERE user_id=? AND expires_at>?").bind(user.id,now).first();
      if(cmd.action==="cancel_stock_action") {
        await env.DB.prepare("DELETE FROM line_pending_stock_actions WHERE user_id=?").bind(user.id).run();
        await lineReply(env,event.replyToken,pending?"ยกเลิกคำสั่งแล้ว ไม่มีการเปลี่ยนแปลง Watchlist":"ไม่มีคำสั่งค้างให้ยกเลิก");
      } else if(!pending) {
        await lineReply(env,event.replyToken,"ไม่มีคำสั่งที่รอยืนยันแล้ว หรือคำสั่งหมดเวลา 3 นาที กรุณาเลือกใหม่อีกครั้ง");
      } else {
        let symbols=[];
        try { symbols=JSON.parse(pending.symbols_json); } catch {}
        if(!Array.isArray(symbols)||!symbols.length) {
          await env.DB.prepare("DELETE FROM line_pending_stock_actions WHERE user_id=?").bind(user.id).run();
          await lineReply(env,event.replyToken,"คำสั่งไม่สมบูรณ์ ถูกล้างแล้ว กรุณาเริ่มใหม่");
        } else {
          const results=[];
          for(const symbol of symbols) {
            if(pending.action==="add") {
              const result=await addWatch(env,user.id,symbol);
              results.push(result.ok?(result.already?"มี "+symbol+" อยู่แล้ว":"เพิ่ม "+symbol+" สำเร็จ"):"เพิ่ม "+symbol+" ไม่สำเร็จ: "+result.error);
            } else if(pending.action==="remove") {
              const before=await getWatchlist(env,user.id);
              if(!before.includes(symbol))results.push("ไม่พบ "+symbol+" ใน Watchlist");
              else {const result=await removeWatch(env,user.id,symbol);results.push("ลบ "+symbol+" สำเร็จ · เหลือ "+result.symbols.length+" หุ้น");}
            }
          }
          await env.DB.prepare("DELETE FROM line_pending_stock_actions WHERE user_id=?").bind(user.id).run();
          await env.DB.prepare("DELETE FROM user_input_modes WHERE user_id=?").bind(user.id).run();
          const current=await getWatchlist(env,user.id);
          await lineReply(env,event.replyToken,results.join("\\n")+"\\n\\nWatchlist ปัจจุบัน "+current.length+"/50 หุ้น");
        }
      }
    } else if(cmd.action==="link") {
      const codeHash=await sha256Hex(cmd.code),now=Math.floor(Date.now()/1000);
      const pending=await env.DB.prepare("SELECT code_hash FROM web_link_sessions WHERE code_hash=? AND user_id IS NULL AND code_expires_at>?").bind(codeHash,now).first();
      if(!pending) {
        await lineReply(env,event.replyToken,"รหัสเชื่อมเว็บไม่ถูกต้องหรือหมดอายุ กลับไปที่เว็บไซต์เพื่อสร้างรหัสใหม่ แล้วพิมพ์ “เชื่อม รหัส” ในแชตนี้");
      } else {
        const linked=await env.DB.prepare("UPDATE web_link_sessions SET user_id=? WHERE code_hash=? AND user_id IS NULL AND code_expires_at>?").bind(user.id,codeHash,now).run();
        if((linked.meta?.changes||0)>0)await lineReply(env,event.replyToken,"เชื่อมบัญชีสำเร็จแล้ว! เว็บนี้ใช้ Watchlist เดียวกับ LINE ของคุณได้แล้ว");
        else await lineReply(env,event.replyToken,"รหัสนี้ถูกใช้ไปแล้ว กรุณาสร้างรหัสใหม่จากเว็บไซต์");
      }
    } else if(cmd.action==="add_prompt") {
      await env.DB.prepare("INSERT INTO user_input_modes(user_id,mode,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,expires_at=excluded.expires_at").bind(user.id,"add",now+180).run();
      await lineReply(env,event.replyToken,"พิมพ์ตัวย่อหุ้นที่ต้องการเพิ่มได้เลย เช่น\\nAMZN หรือ AMZN NVDA\\nหมดเวลารับรายการใน 3 นาที");
    } else if(cmd.action==="remove_menu") {
      const symbols=await getWatchlist(env,user.id);
      if(!symbols.length)await lineReply(env,event.replyToken,"Watchlist ยังว่าง ไม่มีหุ้นให้ลบ");
      else {
        await env.DB.prepare("INSERT INTO user_input_modes(user_id,mode,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,expires_at=excluded.expires_at").bind(user.id,"remove",now+180).run();
        const more=symbols.length>13?"\\n(ปุ่มเลือกแสดงได้ 13 หุ้นแรก หากต้องการลบตัวอื่น พิมพ์ ลบ ตามด้วยตัวย่อหุ้น)":"";
        await lineReply(env,event.replyToken,"เลือกหุ้นที่ต้องการลบจากปุ่มด้านล่างได้เลย ("+symbols.length+" หุ้นในรายการ)"+more,watchlistQuickReply(symbols));
      }
    } else if(cmd.action==="settings") {
      await lineReply(env,event.replyToken,"ตั้งค่าแจ้งเตือนสถานะหุ้น\nพิมพ์ “เปิดแจ้งเตือน” หรือ “ปิดแจ้งเตือน” เพื่อเปลี่ยนการตั้งค่า");
    } else if(cmd.action==="alert_on"||cmd.action==="alert_off") {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences (user_id INTEGER PRIMARY KEY, alerts_enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)").run();
      const enabled=cmd.action==="alert_on"?1:0;
      await env.DB.prepare("INSERT INTO user_preferences(user_id,alerts_enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET alerts_enabled=excluded.alerts_enabled,updated_at=CURRENT_TIMESTAMP").bind(user.id,enabled).run();
      await lineReply(env,event.replyToken,enabled?"เปิดแจ้งเตือนการเปลี่ยนสถานะแล้ว":"ปิดแจ้งเตือนการเปลี่ยนสถานะแล้ว");
    } else if(cmd.action==="invalid_symbols") {
      await lineReply(env,event.replyToken,"รูปแบบตัวย่อไม่ถูกต้อง กรุณาส่งเช่น AMZN หรือ AMZN NVDA หรือ AMZN,NVDA");
    } else if(cmd.action==="add"||cmd.action==="remove") {
      const symbols=[...new Set((cmd.symbols||[]).map(cleanSymbol))];
      if(!symbols.length) {
        await lineReply(env,event.replyToken,"ไม่พบตัวย่อหุ้น กรุณาส่งคำสั่งใหม่");
      } else {
        await env.DB.prepare("INSERT INTO line_pending_stock_actions(user_id,action,symbols_json,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET action=excluded.action,symbols_json=excluded.symbols_json,expires_at=excluded.expires_at,created_at=CURRENT_TIMESTAMP")
          .bind(user.id,cmd.action,JSON.stringify(symbols),now+180).run();
        await env.DB.prepare("DELETE FROM user_input_modes WHERE user_id=?").bind(user.id).run();
        const verb=cmd.action==="add"?"เพิ่ม":"ลบ";
        await lineReply(env,event.replyToken,"โปรดยืนยันคำสั่ง"+verb+"หุ้นนี้:\\n"+symbols.join(", ")+"\\n\\nกด “ยืนยัน” เพื่อดำเนินการ หรือ “ยกเลิก” เพื่อไม่เปลี่ยนแปลงรายการ\\n\\nคำสั่งนี้จะถูกล้างอัตโนมัติใน 3 นาที",stockActionConfirmQuickReply());
      }
    } else if(cmd.action==="list") {
      const symbols=await getWatchlist(env,user.id);
      if(!symbols.length) {
        await lineReply(env,event.replyToken,"Watchlist ของคุณยังไม่มีหุ้น\\nพิมพ์ “เพิ่ม NVDA” เพื่อเริ่มติดตาม");
      } else {
        const perPage=10,pageCount=Math.max(1,Math.ceil(symbols.length/perPage));
        const page=Math.min(cmd.page||1,pageCount),pageSymbols=symbols.slice((page-1)*perPage,page*perPage);
        try {
          const [market,states]=await Promise.all([
            fetchMarket(env,pageSymbols,"1Day"),
            env.DB.prepare("SELECT symbol,status,status_label,score,last_price,checked_at FROM user_stock_state WHERE user_id=? AND symbol IN ("+pageSymbols.map(()=>"?").join(",")+")").bind(user.id,...pageSymbols).all()
          ]);
          const bySymbol=new Map((states.results||[]).map(x=>[x.symbol,x]));
          const dashboard="https://bombbomb725-debug.github.io/Ai-stock-watcher/";
          const bubbles=pageSymbols.map(symbol=>{
            const item=market.stocks?.[symbol]||{};
            return stockFlexBubble(symbol,item.trade,bySymbol.get(symbol),dashboard,item.bars||[],item.bars||[]);
          });
          await lineReplyFlex(env,event.replyToken,{type:"carousel",contents:bubbles},"Watchlist "+symbols.length+"/50 · หน้า "+page+"/"+pageCount);
          if(pageCount>1)await linePush(env,lineUserId,"ดูหน้าถัดไปพิมพ์ “รายการหุ้น "+Math.min(page+1,pageCount)+"” · รีเฟรชพิมพ์ “รายการหุ้น "+page+"”");
        } catch(e) {
          console.error("LINE_WATCHLIST_FLEX_ERROR",String(e));
          await lineReply(env,event.replyToken,"โหลดการ์ดหุ้นไม่สำเร็จ: "+String(e).slice(0,180)+"\\nกรุณาลองใหม่อีกครั้ง");
        }
      }
    } else if(cmd.action==="buy_zones") {
      const symbols=await getWatchlist(env,user.id);
      if(!symbols.length) {
        await lineReply(env,event.replyToken,"Watchlist ของคุณยังไม่มีหุ้น\\nพิมพ์ “เพิ่ม NVDA” เพื่อเริ่มติดตาม");
      } else {
        const pageSymbols=symbols.slice(0,10);
        try {
          const [market,states]=await Promise.all([
            fetchMarket(env,pageSymbols,"1Day"),
            env.DB.prepare("SELECT symbol,status,status_label,score,last_price,checked_at FROM user_stock_state WHERE user_id=? AND symbol IN ("+pageSymbols.map(()=>"?").join(",")+")").bind(user.id,...pageSymbols).all()
          ]);
          const bySymbol=new Map((states.results||[]).map(x=>[x.symbol,x]));
          const dashboard="https://bombbomb725-debug.github.io/Ai-stock-watcher/";
          const bubbles=pageSymbols.map(symbol=>{
            const item=market.stocks?.[symbol]||{};
            return stockFlexBubble(symbol,item.trade,bySymbol.get(symbol),dashboard,item.bars||[],item.bars||[]);
          });
          await lineReplyFlex(env,event.replyToken,{type:"carousel",contents:bubbles},"โซนราคาเฝ้ารอเข้าซื้อ · "+symbols.length+" หุ้น");
          if(symbols.length>10)console.log("LINE_BUY_ZONES_MORE_THAN_TEN",user.id,symbols.length);
        } catch(e) {
          console.error("LINE_BUY_ZONES_ERROR",String(e));
          await lineReply(env,event.replyToken,"โหลดโซนราคาเฝ้ารอเข้าซื้อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        }
      }
    } else if(cmd.action==="test") {
      try {
        await linePush(env,lineUserId,"ทดสอบการแจ้งเตือน AI Stock Watcher สำเร็จ ✓\\nLINE Push ทำงานได้แล้ว\\nข้อความนี้เป็นการทดสอบ ไม่ใช่สัญญาณซื้อขาย");
        await lineReply(env,event.replyToken,"ส่งข้อความทดสอบไปยัง LINE ของคุณแล้ว กรุณาตรวจดูข้อความจาก AI Stock Watcher");
      } catch(e) {
        console.error("LINE_TEST_PUSH_ERROR",String(e));
        await lineReply(env,event.replyToken,"ส่งข้อความทดสอบไม่สำเร็จ กรุณาตรวจสอบ LINE Push: "+String(e).slice(0,180));
      }
    } else if(cmd.action==="ideas") {
      const rows=await env.DB.prepare("SELECT symbol,score,status,rationale FROM stock_ideas ORDER BY score DESC, symbol LIMIT 15").all();
      const lines=(rows.results||[]).map((x,i)=>(i+1)+". "+x.symbol+" · "+x.score+"/5 · "+x.status+" — "+(x.rationale||"คะแนนทางเทคนิค")).join("\n");
      await lineReply(env,event.replyToken,"หุ้นที่ Screener จัดอันดับ (ไม่ใช่คำแนะนำการลงทุน)\n"+(lines||"ยังไม่มีผลคัดกรอง รอรอบสแกน"));
    } else {
      await lineReply(env,event.replyToken,"ไม่พบคำสั่งนี้ กรุณาตรวจสอบคำสั่งแล้วลองอีกครั้ง");
    }
  }
  return json({ok:true});
}
async function fetchLatestTrades(env,symbols) {
  if(!env.ALPACA_KEY||!env.ALPACA_SECRET)throw new Error("Worker secrets ALPACA_KEY / ALPACA_SECRET missing");
  const u=new URL("https://data.alpaca.markets/v2/stocks/trades/latest");
  u.searchParams.set("symbols",symbols.join(","));
  u.searchParams.set("feed","iex");
  const r=await fetch(u,{headers:{"APCA-API-KEY-ID":env.ALPACA_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET}});
  if(!r.ok)throw new Error("Alpaca latest trades "+r.status+": "+(await r.text()).slice(0,250));
  const data=await r.json();
  return data.trades||{};
}
// D1-backed FIFO rate limiter: reserve a future slot instead of dropping requests.
// This keeps Thai symbols from being silently skipped when several are refreshed together.
async function reserveDataCedarSlot(env) {
  if(!env.DB) throw new Error("D1 binding is required for DataCedar rate limiting");
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS datacedar_rate_limit (id INTEGER PRIMARY KEY CHECK(id=1), next_at INTEGER NOT NULL DEFAULT 0)").run();
  await env.DB.prepare("INSERT OR IGNORE INTO datacedar_rate_limit(id,next_at) VALUES(1,0)").run();
  const now=Date.now();
  const row=await env.DB.prepare("UPDATE datacedar_rate_limit SET next_at=MAX(next_at,?)+1250 WHERE id=1 RETURNING next_at-1250 AS slot_at").bind(now).first();
  if(!row||!Number.isFinite(Number(row.slot_at))) throw new Error("Unable to reserve DataCedar request slot");
  return Number(row.slot_at);
}
async function dataCedarFetch(env,url,options={}) {
  for(let attempt=0;attempt<2;attempt++) {
    const slotAt=await reserveDataCedarSlot(env),waitMs=Math.max(0,slotAt-Date.now());
    if(waitMs) await new Promise(resolve=>setTimeout(resolve,waitMs));
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(2800)});
    if(response.status!==429||attempt===1)return response;
    let retrySeconds=1;
    try { const body=await response.clone().json(); retrySeconds=Math.max(1,Number(body?.error?.details?.retry_after)||1); } catch(e) {}
    await new Promise(resolve=>setTimeout(resolve,retrySeconds*1000+250));
  }
  throw new Error("DataCedar rate limit retry exhausted");
}
async function fetchDataCedarThai(env,symbol,timeframe="1Day") {
  if(!env.DATACEDAR_API_KEY)throw new Error("DATACEDAR_API_KEY is not configured");
  const tf=timeframe==="5Min"?"5Min":timeframe==="4Hour"?"1Hour":"1Day",ttl=timeframe==="5Min"?60:timeframe==="4Hour"?300:900;
  const cache=caches.default,cacheId="https://ai-stock-watcher-cache.invalid/datacedar/"+encodeURIComponent(symbol)+"/"+timeframe;
  const freshKey=new Request(cacheId+"/fresh"),staleKey=new Request(cacheId+"/stale"),fresh=await cache.match(freshKey);
  if(fresh)return await fresh.json();
  const sid="set:"+symbol.replace(/\.BK$/i,"").toUpperCase();
  const url="https://api.datacedar.com/v3/stocks/"+encodeURIComponent(sid)+"/bars?timeframe="+tf+"&adjustment=raw&order=asc&limit=500";
  let r;try{r=await dataCedarFetch(env,url,{headers:{"Accept":"application/json","X-API-Key":env.DATACEDAR_API_KEY},signal:AbortSignal.timeout(2800)});if(!r){const stale=await cache.match(staleKey);if(stale){const saved=await stale.json();return {...saved,trade:null,stale:true,error:"DataCedar request queued by global rate limit; showing cached data and suppressing buy signal"};}throw new Error("DataCedar rate limit queue busy; retry later");}}catch(e){const stale=await cache.match(staleKey);if(stale){const saved=await stale.json();return {...saved,trade:null,stale:true,error:"DataCedar timeout/network: "+String(e)+"; แสดงข้อมูลเก่าจากแคชและงดสัญญาณซื้อ"};}throw e;}
  if(!r.ok){const detail=(await r.text()).slice(0,240),stale=await cache.match(staleKey);if(stale){const saved=await stale.json();return {...saved,trade:null,stale:true,error:"DataCedar API "+r.status+": "+detail+"; แสดงข้อมูลเก่าจากแคชและงดสัญญาณซื้อ"};}throw new Error("DataCedar API "+r.status+": "+detail);}
  const payload=await r.json();if(payload?.error)throw new Error(payload.error.message||"DataCedar API error");
  if(!Array.isArray(payload?.data))throw new Error("DataCedar response format invalid");
  const bars=payload.data.map(row=>{const ms=Number(row.ts_ms),date=Number.isFinite(ms)?new Date(ms):new Date(row.ts_ms),o=Number(row.open),h=Number(row.high),l=Number(row.low),c=Number(row.close),v=Number(row.volume||0);if(!Number.isFinite(date.getTime())||![o,h,l,c].every(Number.isFinite))return null;return {t:date.toISOString(),o,h,l,c,v:Number.isFinite(v)?v:0};}).filter(Boolean);
  if(!bars.length)throw new Error("DataCedar has no "+tf+" bars for "+sid);
  const last=bars[bars.length-1],data={bars,trade:{p:last.c,t:last.t,s:"DATACEDAR_EOD"},currency:"THB",exchange:"SET",source:"DataCedar",delayed:true},body=JSON.stringify(data);
  await cache.put(freshKey,new Response(body,{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age="+ttl}}));
  await cache.put(staleKey,new Response(body,{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=604800"}}));
  return data;
}
function thaiMarketStatus(now=new Date()) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(now);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const date=p.year+"-"+p.month+"-"+p.day,minute=Number(p.hour)*60+Number(p.minute),weekday=p.weekday;
  const weekend=weekday==="Sat"||weekday==="Sun";
  const holidays2026=new Set(["2026-01-01","2026-01-02","2026-03-03","2026-04-06","2026-04-13","2026-04-14","2026-04-15","2026-05-01","2026-05-04","2026-06-01","2026-06-03","2026-07-28","2026-07-29","2026-08-12","2026-10-13","2026-10-16","2026-10-23","2026-12-07","2026-12-10","2026-12-31"]);
  const holiday=date.startsWith("2026-")&&holidays2026.has(date);
  const open=!weekend&&!holiday&&((minute>=600&&minute<750)||(minute>=840&&minute<990));
  let reason="market_closed";
  if(weekend)reason="weekend";else if(holiday)reason="set_holiday";else if(minute>=750&&minute<840)reason="lunch_break";else if(!open)reason="outside_trading_hours";
  return {open,reason,date,time:p.hour+":"+p.minute,timezone:"Asia/Bangkok"};
}
async function latestThaiCachedMarket(symbol,timeframe) {
  const cache=caches.default,items=[];
  for(const provider of ["datacedar","yahoo"]) {
    const base="https://ai-stock-watcher-cache.invalid/"+provider+"/"+encodeURIComponent(symbol)+"/"+timeframe;
    for(const suffix of ["/fresh","/stale"]) {
      const response=await cache.match(new Request(base+suffix));
      if(!response)continue;
      try { const data=await response.json(); if(data?.bars?.length||data?.trade?.p)items.push(data); } catch(e) {}
    }
  }
  items.sort((a,b)=>new Date(b.trade?.t||b.bars?.at(-1)?.t||0).getTime()-new Date(a.trade?.t||a.bars?.at(-1)?.t||0).getTime());
  return items[0]||null;
}
async function fetchYahooThai(env,symbol,timeframe="1Day") {
  const market=thaiMarketStatus();
  if(!market.open) {
    const cached=await latestThaiCachedMarket(symbol,timeframe);
    if(cached)return {...cached,stale:false,marketClosed:true,marketStatus:market.reason,marketCheckedAt:market.date+"T"+market.time+":00+07:00",marketNote:"ตลาดหุ้นไทยปิดทำการ/อยู่นอกเวลาซื้อขาย ใช้ข้อมูลล่าสุดจากรอบตลาดก่อนหน้า"};
    return {bars:[],trade:null,currency:"THB",exchange:"SET",marketClosed:true,marketStatus:market.reason,error:"ตลาดหุ้นไทยปิดทำการ/อยู่นอกเวลาซื้อขาย และยังไม่มีข้อมูลแคชล่าสุด"};
  }
  // Race both providers only while the SET is actively trading.
  let dataCedarStale=null,dataCedarError=null,yahooError=null;
  const primary=fetchDataCedarThai(env,symbol,timeframe).then(data=>{
    if(data?.stale){dataCedarStale=data;throw new Error(data.error||"DataCedar returned stale cache");}
    return data;
  }).catch(error=>{dataCedarError=error;throw error;});
  const fallback=fetchYahooThaiLegacy(symbol,timeframe).catch(error=>{yahooError=error;throw error;});
  try {
    return await Promise.any([primary,fallback]);
  } catch(e) {
    console.warn("THAI_MARKET_BOTH_SOURCES_FAILED",symbol,String(dataCedarError||e),String(yahooError||""));
    if(dataCedarStale)return dataCedarStale;
    throw new Error("DataCedar: "+String(dataCedarError||"unavailable")+"; Yahoo fallback: "+String(yahooError||"unavailable"));
  }
}
async function fetchYahooThaiLegacy(symbol,timeframe="1Day") {
  const interval=timeframe==="5Min"?"5m":timeframe==="4Hour"?"60m":"1d",range=timeframe==="5Min"?"5d":timeframe==="4Hour"?"3mo":"1y",ttl=timeframe==="5Min"?60:timeframe==="4Hour"?300:900;
  const cache=caches.default,cacheId="https://ai-stock-watcher-cache.invalid/yahoo/"+encodeURIComponent(symbol)+"/"+timeframe;
  const freshKey=new Request(cacheId+"/fresh"),staleKey=new Request(cacheId+"/stale"),fresh=await cache.match(freshKey);
  if(fresh)return await fresh.json();
  let payload=null,lastError=null;
  // Query both Yahoo edge hosts concurrently; use the first valid response instead of waiting sequentially.
  try {
    payload=await Promise.any(["query1.finance.yahoo.com","query2.finance.yahoo.com"].map(async host=>{
      const url="https://"+host+"/v8/finance/chart/"+encodeURIComponent(symbol)+"?range="+range+"&interval="+interval+"&events=div%2Csplits";
      const r=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"Mozilla/5.0 (compatible; AIStockWatcher/1.0)"},cf:{cacheTtl:ttl,cacheEverything:true},signal:AbortSignal.timeout(2200)});
      if(!r.ok)throw new Error("Yahoo HTTP "+r.status);
      const p=await r.json();if(p?.chart?.error)throw new Error(p.chart.error.description||"Yahoo chart error");
      if(!p?.chart?.result?.[0])throw new Error("Yahoo returned no price history for "+symbol);
      return p;
    }));
  } catch(e) { lastError=e; }
  if(!payload){const stale=await cache.match(staleKey);if(stale){const saved=await stale.json();return {...saved,trade:null,stale:true,error:"Yahoo Finance จำกัดการเรียกข้อมูล ("+String(lastError||"unavailable")+"); แสดงเฉพาะแท่งย้อนหลังจากแคช จึงงดสัญญาณซื้อ"};}throw new Error("DataCedar และ Yahoo ใช้งานไม่ได้สำหรับ "+symbol+": "+String(lastError||"no response"));}
  const result=payload.chart?.result?.[0];if(!result)throw new Error("Yahoo returned no price history for "+symbol);
  const q=result.indicators?.quote?.[0]||{},ts=result.timestamp||[],bars=[];
  for(let i=0;i<ts.length;i++){const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i],v=q.volume?.[i];if([o,h,l,c].every(x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))))bars.push({t:new Date(ts[i]*1000).toISOString(),o:Number(o),h:Number(h),l:Number(l),c:Number(c),v:Number(v||0)});}
  const meta=result.meta||{},last=bars[bars.length-1],mp=meta.regularMarketPrice===null||meta.regularMarketPrice===undefined?NaN:Number(meta.regularMarketPrice),price=Number.isFinite(mp)&&mp>0?mp:Number(last?.c),mt=meta.regularMarketTime===null||meta.regularMarketTime===undefined?NaN:Number(meta.regularMarketTime);
  const data={bars,trade:Number.isFinite(price)&&price>0?{p:price,t:Number.isFinite(mt)&&mt>0?new Date(mt*1000).toISOString():last?.t||new Date().toISOString(),s:"YAHOO"}:null,currency:meta.currency||"THB",exchange:meta.fullExchangeName||meta.exchangeName||"SET"};
  const body=JSON.stringify(data);await cache.put(freshKey,new Response(body,{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age="+ttl}}));await cache.put(staleKey,new Response(body,{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=604800"}}));return data;
}
async function fetchMarket(env,symbols,timeframe="1Day") {
  const thai=symbols.filter(isThaiSymbol),us=symbols.filter(x=>!isThaiSymbol(x)),stocks={};
  if(us.length){
    if(!env.ALPACA_KEY||!env.ALPACA_SECRET)throw new Error("Worker secrets ALPACA_KEY / ALPACA_SECRET missing");
    const auth={"APCA-API-KEY-ID":env.ALPACA_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET},base="https://data.alpaca.markets/v2",end=new Date(),days=timeframe==="4Hour"?45:timeframe==="5Min"?3:140,start=new Date(end.getTime()-days*86400000);
    const u=new URL(base+"/stocks/bars");u.searchParams.set("symbols",us.join(","));u.searchParams.set("timeframe",timeframe);u.searchParams.set("start",start.toISOString());u.searchParams.set("end",end.toISOString());u.searchParams.set("limit","10000");u.searchParams.set("feed","iex");u.searchParams.set("sort","asc");u.searchParams.set("adjustment","raw");
    const tu=new URL(base+"/stocks/trades/latest");tu.searchParams.set("symbols",us.join(","));tu.searchParams.set("feed","iex");
    const timeout=AbortSignal.timeout(12000);
    const [barResult,tradeResult]=await Promise.allSettled([fetch(u,{headers:auth,signal:timeout}),fetch(tu,{headers:auth,signal:timeout})]);
    if(barResult.status!=="fulfilled")throw new Error("Alpaca bars request failed: "+String(barResult.reason||"network error"));
    const br=barResult.value;
    if(!br.ok)throw new Error("Alpaca bars "+br.status+": "+(await br.text()).slice(0,250));
    const bd=await br.json();
    let td={trades:{}};
    if(tradeResult.status==="fulfilled"&&tradeResult.value.ok){
      try{td=await tradeResult.value.json();}catch(e){console.warn("ALPACA_LATEST_TRADES_JSON_ERROR",String(e));}
    }else{
      console.warn("ALPACA_LATEST_TRADES_UNAVAILABLE",tradeResult.status==="rejected"?String(tradeResult.reason):"HTTP "+tradeResult.value.status);
    }
    for(const symbol of us)stocks[symbol]={bars:bd.bars?.[symbol]||[],trade:td.trades?.[symbol]||null,currency:"USD",exchange:"US"};
  }
  for(let i=0;i<thai.length;i+=5) {
    const batch=await Promise.allSettled(thai.slice(i,i+5).map(async symbol=>[symbol,await fetchYahooThai(env,symbol,timeframe)]));
    for(let j=0;j<batch.length;j++) {
      const symbol=thai[i+j],result=batch[j];
      if(result.status==="fulfilled")stocks[result.value[0]]=result.value[1];
      else stocks[symbol]={bars:[],trade:null,error:String(result.reason||"Yahoo Finance unavailable"),currency:"THB",exchange:"SET"};
    }
  }
  return {feed:us.length&&thai.length?"Alpaca IEX + DataCedar (Yahoo fallback)":thai.length?"DataCedar (Yahoo fallback)":"Alpaca IEX",timeframe,fetchedAt:new Date().toISOString(),stocks};
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
function adxValue(bars,period=14) {
  if(!Array.isArray(bars)||bars.length<period*2+1)return null;
  const tr=[],plusDM=[],minusDM=[];
  for(let i=1;i<bars.length;i++){
    const h=Number(bars[i].h),l=Number(bars[i].l),pc=Number(bars[i-1].c);
    const ph=Number(bars[i-1].h),pl=Number(bars[i-1].l);
    if(![h,l,pc,ph,pl].every(Number.isFinite))continue;
    const up=h-ph,down=pl-l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
  }
  if(tr.length<period*2)return null;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let smP=plusDM.slice(0,period).reduce((a,b)=>a+b,0);
  let smM=minusDM.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=period-1;i<tr.length;i++){
    if(i>=period){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+plusDM[i];smM=smM-smM/period+minusDM[i];}
    const pdi=smTR?100*smP/smTR:0,mdi=smTR?100*smM/smTR:0;
    dx.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  }
  if(dx.length<period)return null;
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++)value=(value*(period-1)+dx[i])/period;
  return value;
}
function analyzeStatus(bars,price,timezone="America/New_York") {
  const last=bars[bars.length-1];
  const localDate=d=>new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  const done=last?.t&&localDate(new Date(last.t))===localDate(new Date())?bars.slice(0,-1):bars;
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<55)return {status:"wait",label:"ข้อมูลย้อนหลังไม่พอ",score:0};
  const short=ema(closes,20),long=ema(closes,50),momentum=rsi(closes),e20s=emaSeries(closes,20),e50s=emaSeries(closes,50);
  const e12=emaSeries(closes,12),e26=emaSeries(closes,26);
  const macdLine=closes.map((_,i)=>e12[i]!==null&&e26[i]!==null?e12[i]-e26[i]:null);
  const validMacd=macdLine.filter(Number.isFinite),signalSeries=emaSeries(validMacd,9);
  const macd=macdLine.at(-1),macdSignal=signalSeries.at(-1),hist=macd-macdSignal;
  const adx=adxValue(done),rising20=e20s.at(-1)>e20s.at(-6),rising50=e50s.at(-1)>e50s.at(-6);
  const lastClose=closes.at(-1),trend=short>long&&rising20&&rising50&&lastClose>short;
  const rsiOK=momentum>=50&&momentum<70,macdOK=macd>macdSignal&&hist>0,trendStrengthOK=Number.isFinite(adx)&&adx>=18;
  const confirmed=Boolean(trend&&rsiOK&&macdOK&&trendStrengthOK);
  const prior=done.slice(-21,-1),priorHigh=prior.length?Math.max(...prior.map(b=>Number(b.h)).filter(Number.isFinite)):null;
  const lastVolume=Number(done.at(-1)?.v),avgVolumeRows=prior.map(b=>Number(b.v)).filter(Number.isFinite);
  const volumeAvg=avgVolumeRows.length?avgVolumeRows.reduce((x,y)=>x+y,0)/avgVolumeRows.length:0;
  const breakout=Number.isFinite(lastClose)&&Number.isFinite(priorHigh)&&lastClose>priorHigh;
  const volumeOK=volumeAvg>0&&lastVolume>=volumeAvg*1.3;
  const strong=confirmed&&breakout&&volumeOK;
  const score=[trend,rsiOK,macdOK,breakout,volumeOK].filter(Boolean).length;
  let status="wait",label="รอการยืนยันแนวโน้ม";
  if(strong){status="buy";label="ขาขึ้นแข็งแรง + เบรกเอาต์และวอลุ่มยืนยัน";}
  else if(confirmed){status="buy";label="BUY SIGNAL · แนวโน้มและ ADX ยืนยัน";}
  else if(momentum<45||(!trend&&lastClose<short&&short<long)){status="risk";label="แนวโน้มยังอ่อน";}
  else if(lastClose>short&&!trend){status="wait";label="เริ่มฟื้นตัว · รอยืนยัน";}
  return {status,label,score,ema20:short,ema50:long,rsi:momentum,macd,adx};
}
async function scanAlerts(env) {
  if(!dbReady(env)||!env.LINE_CHANNEL_ACCESS_TOKEN)return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences (user_id INTEGER PRIMARY KEY, alerts_enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)").run();
  const rows=await env.DB.prepare("SELECT u.id AS user_id,u.line_user_id,w.symbol,COALESCE(p.alerts_enabled,1) AS alerts_enabled FROM watchlist w JOIN users u ON u.id=w.user_id LEFT JOIN user_preferences p ON p.user_id=u.id ORDER BY u.id,w.symbol").all();
  const watch=rows.results||[];
  const resolvedWatch=await Promise.all(watch.map(async x=>({...x,symbol:await normalizeSymbol(env,x.symbol)})));
  const symbols=[...new Set(resolvedWatch.map(x=>x.symbol))];
  const market={};
  // Separate provider groups so a Thai-data outage never stops US stock scans.
  const groups=[symbols.filter(s=>!isThaiSymbol(s)),symbols.filter(isThaiSymbol)].filter(group=>group.length);
  for(const group of groups)for(let i=0;i<group.length;i+=50) {
    try {
      const batch=await fetchMarket(env,group.slice(i,i+50));
      Object.assign(market,batch.stocks);
    } catch(e) {
      console.error(isThaiSymbol(group[0])?"ALERT_SCAN_THAI_ERROR":"ALERT_SCAN_US_ERROR",String(e));
    }
  }
  const checked=new Date().toISOString();
  if(!watch.length)return;
  // Read all saved states once instead of issuing one SELECT for every user/ticker pair.
  const stateRows=await env.DB.prepare("SELECT user_id,symbol,status FROM user_stock_state").all();
  const stateByKey=new Map((stateRows.results||[]).map(x=>[x.user_id+"|"+x.symbol,x.status]));
  for(const item of resolvedWatch) {
    const data=market[item.symbol];
    if(!data||data.error||(data.bars||[]).length<55)continue;
    const signal=analyzeStatus(data.bars||[],Number(data.trade?.p),isThaiSymbol(item.symbol)?"Asia/Bangkok":"America/New_York");
    const price=Number(data.trade?.p);
    const key=item.user_id+"|"+item.symbol;
    const oldStatus=stateByKey.get(key);
    if(oldStatus===undefined) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_stock_state(user_id,symbol,status,status_label,score,last_price,checked_at) VALUES(?,?,?,?,?,?,?)")
        .bind(item.user_id,item.symbol,signal.status,signal.label,signal.score,Number.isFinite(price)?price:null,checked).run();
      stateByKey.set(key,signal.status);
      continue;
    }
    if(oldStatus===signal.status) {
      // Keep the scan heartbeat fresh even when the signal has not changed.
      await env.DB.prepare("UPDATE user_stock_state SET status_label=?,score=?,last_price=?,checked_at=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND symbol=? AND status=?")
        .bind(signal.label,signal.score,Number.isFinite(price)?price:null,checked,item.user_id,item.symbol,oldStatus).run();
      continue;
    }
    const upd=await env.DB.prepare("UPDATE user_stock_state SET status=?,last_status=?,status_label=?,score=?,last_price=?,checked_at=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND symbol=? AND status=?")
      .bind(signal.status,signal.status,signal.label,signal.score,Number.isFinite(price)?price:null,checked,item.user_id,item.symbol,oldStatus).run();
    if((upd.meta?.changes||0)!==1)continue;
    stateByKey.set(key,signal.status);
    if(Number(item.alerts_enabled)===0)continue;
    const currency=isThaiSymbol(item.symbol)?"฿":"$";
    const message="AI Stock Watcher · สถานะหุ้นเปลี่ยน\n"+item.symbol+" : "+oldStatus.toUpperCase()+" → "+signal.status.toUpperCase()+"\n"+signal.label+" · คะแนน "+signal.score+"/5\nราคา "+(Number.isFinite(price)?currency+price.toFixed(2):"ไม่พบราคา")+"\nข้อมูล "+(isThaiSymbol(item.symbol)?"DataCedar (ราคาปิดรายวัน · อาจล่าช้า)":"Alpaca IEX")+" · สแกน "+checked;
    try {
      await linePush(env,item.line_user_id,message);
      await env.DB.prepare("INSERT INTO alert_events(user_id,symbol,status,old_status,new_status,message) VALUES(?,?,?,?,?,?)")
        .bind(item.user_id,item.symbol,signal.status,oldStatus,signal.status,message).run();
      stateByKey.set(key,signal.status);
    } catch(e) {
      console.error("LINE_PUSH_ERROR",item.symbol,String(e));
      await env.DB.prepare("UPDATE user_stock_state SET status=? WHERE user_id=? AND symbol=? AND status=?")
        .bind(oldStatus,item.user_id,item.symbol,signal.status).run();
    }
  }
}
async function apiHandler(request,env,url,headers) {
  if(url.pathname==="/api/link/start"&&request.method==="POST") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    await ensureLinkTable(env);
    const token=randomToken(32),code=randomPairCode(),now=Math.floor(Date.now()/1000),expiresAt=now+600,sessionExpiresAt=now+86400*30;
    await env.DB.prepare("DELETE FROM web_link_sessions WHERE expires_at<=? OR (user_id IS NULL AND code_expires_at<=?)").bind(now,now).run();
    await env.DB.prepare("INSERT INTO web_link_sessions(token_hash,code_hash,expires_at,code_expires_at) VALUES(?,?,?,?)").bind(await sha256Hex(token),await sha256Hex(code),sessionExpiresAt,expiresAt).run();
    return json({token,code,expiresAt},200,headers);
  }
  if(url.pathname==="/api/link/status"&&request.method==="GET") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const auth=request.headers.get("Authorization")||"",token=auth.startsWith("Bearer ")?auth.slice(7):"";
    if(!token)return json({error:"Missing link token"},401,headers);
    const row=await env.DB.prepare("SELECT s.user_id,u.display_name FROM web_link_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND ((s.user_id IS NULL AND s.code_expires_at>?) OR (s.user_id IS NOT NULL AND s.expires_at>?))").bind(await sha256Hex(token),Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).first();
    if(!row)return json({error:"รหัสเชื่อมเว็บหมดอายุ กรุณาสร้างรหัสใหม่"},401,headers);
    if(!row.user_id)return json({linked:false},200,headers);
    return json({linked:true,user:{displayName:row.display_name},symbols:await getWatchlist(env,row.user_id)},200,headers);
  }
  if(url.pathname==="/api/auth/line"&&request.method==="POST") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    if(!env.APP_SESSION_SECRET)return json({error:"APP_SESSION_SECRET missing"},503,headers);
    const body=await request.json().catch(()=>({}));if(!body.idToken)return json({error:"idToken is required"},400,headers);
    try {
      const profile=await lineIdTokenProfile(body.idToken,env),user=await createOrUpdateUser(env,profile.sub,{name:profile.name,picture:profile.picture});
      const token=await signSession({sub:user.id,exp:Math.floor(Date.now()/1000)+86400*14},env.APP_SESSION_SECRET);
      return json({token,user:{displayName:user.display_name,pictureUrl:null},symbols:await getWatchlist(env,user.id)},200,headers);
    } catch(e){return json({error:e.message||"LINE login failed"},401,headers);}
  }
  if(url.pathname==="/api/screener"&&request.method==="GET") {
    if(!env.ALPACA_KEY||!env.ALPACA_SECRET)return json({error:"Worker secrets ALPACA_KEY / ALPACA_SECRET missing"},503,headers);
    const candidates=SHAY_STOCK_UNIVERSE;
    const market={};
    const batches=await Promise.allSettled(Array.from({length:Math.ceil(candidates.length/50)},(_,i)=>fetchMarket(env,candidates.slice(i*50,(i+1)*50),"1Day")));
    for(let i=0;i<batches.length;i++) {
      const result=batches[i];
      if(result.status==="fulfilled")Object.assign(market,result.value.stocks||{});
      else console.error("SHAY_SCREENER_MARKET_BATCH_ERROR",i,String(result.reason));
    }
    const ranked=[];
    for(const symbol of candidates) {
      const item=market[symbol],bars=item?.bars||[];
      if(bars.length<55)continue;
      const signal=analyzeStatus(bars,Number(item.trade?.p),"America/New_York");
      const price=Number(item.trade?.p)>0?Number(item.trade.p):Number(bars[bars.length-1]?.c);
      ranked.push({symbol,score:signal.score,status:signal.status,label:signal.label,price:Number.isFinite(price)?price:null,ema20:signal.ema20,ema50:signal.ema50,rsi:signal.rsi,macd:signal.macd,adx:signal.adx,source:"@StockSavvyShay · X"});
    }
    ranked.sort((a,b)=>b.score-a.score||(a.status==="buy"?-1:0)-(b.status==="buy"?-1:0)||a.symbol.localeCompare(b.symbol));
    return json({
      ideas:ranked.slice(0,50),
      candidateCount:candidates.length,
      scannedCount:ranked.length,
      qualifiedCount:ranked.filter(x=>x.score>=4).length,
      minScore:0,
      fetchedAt:new Date().toISOString(),
      source:{label:"หุ้นที่พบในโพสต์สาธารณะของ @StockSavvyShay (คัดกรองจากรายการติดตาม 90 วัน)",accountUrl:"https://x.com/StockSavvyShay",trackerUrl:"https://www.six7alpha.com/invest-like/stock-savvy-shay",sourceUpdatedAt:SHAY_SOURCE_UPDATED_AT,reviewedAt:SHAY_LAST_REVIEWED_AT,disclaimer:"รายการติดตามนี้ AI สกัดจากโพสต์สาธารณะ อาจมีหุ้นที่ถูกกล่าวถึงในเชิงวิเคราะห์หรือยกตัวอย่าง ไม่ได้หมายความว่า Shay แนะนำซื้อทุกตัว"},
      universe:"Shay Boloor / StockSavvyShay public X-post tracking"
    },200,headers);
  }
  if(url.pathname==="/api/ideas"&&request.method==="GET") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const rows=await env.DB.prepare("SELECT symbol,score,status,rationale FROM stock_ideas ORDER BY score DESC,symbol LIMIT 50").all();
    return json({ideas:rows.results||[]},200,headers);
  }
  if(url.pathname.startsWith("/api/")&&!["/api/market","/api/assets","/api/signals","/api/quotes"].includes(url.pathname)) {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const user=await authenticate(request,env);if(!user)return json({error:"กรุณาเข้าสู่ระบบด้วย LINE ใหม่"},401,headers);
    if(url.pathname==="/api/me"&&request.method==="GET")return json({user:{displayName:user.display_name,pictureUrl:null},symbols:await getWatchlist(env,user.id)},200,headers);
    if(url.pathname==="/api/watchlist"&&request.method==="GET")return json({symbols:await getWatchlist(env,user.id),max:MAX_WATCHLIST},200,headers);
    if(url.pathname==="/api/watchlist/add"&&request.method==="POST") {
      const body=await request.json().catch(()=>({})),symbol=cleanSymbol(body.symbol),market=String(body.market||"AUTO").toUpperCase();
      if(!validSymbol(symbol)||!["AUTO","US","THAI"].includes(market))return json({error:"Ticker หรือตลาดไม่ถูกต้อง"},400,headers);
      let result;
      try { result=await addWatch(env,user.id,symbol,market); }
      catch(e) { return json({error:e.message||"เพิ่มหุ้นไม่สำเร็จ"},400,headers); }let lineNotified=false;if(result.ok&&!result.already&&user.line_user_id){try{await linePush(env,user.line_user_id,"AI Stock Watcher · เพิ่มหุ้นจากเว็บไซต์สำเร็จ ✓\\n"+symbol+" ถูกบันทึกใน Watchlist บัญชี LINE และเว็บเดียวกันแล้ว\\nรายการปัจจุบัน "+result.symbols.length+"/50");lineNotified=true;}catch(e){console.error("WEB_ADD_LINE_CONFIRMATION_FAILED",String(e));}}return json({...result,lineSynced:result.ok,lineNotified},result.ok?200:409,headers);
    }
    if(url.pathname==="/api/watchlist/remove"&&request.method==="POST") {
      const body=await request.json().catch(()=>({})),symbol=cleanSymbol(body.symbol);
      if(!validSymbol(symbol))return json({error:"Ticker ไม่ถูกต้อง"},400,headers);
      return json(await removeWatch(env,user.id,symbol),200,headers);
    }
  }
  if(url.pathname==="/api/assets"&&request.method==="GET") {
    const q=(url.searchParams.get("q")||"").trim().toUpperCase();if(!q||q.length>30)return json({assets:[]},200,headers);
    const [us,thai]=await Promise.allSettled([
      (async()=>{const auth={"APCA-API-KEY-ID":env.ALPACA_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET};const r=await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",{headers:auth});if(!r.ok)throw new Error("Alpaca HTTP "+r.status);const all=await r.json();return all.filter(a=>a.tradable&&a.exchange&&((a.symbol||"").toUpperCase().includes(q)||(a.name||"").toUpperCase().includes(q))).slice(0,12).map(a=>({symbol:a.symbol,name:a.name,exchange:a.exchange,market:"US"}));})(),
      (async()=>{const all=await getThaiSecurities();return all.filter(x=>String(x.symbol||"").toUpperCase().includes(q)||String(x.name||"").toUpperCase().includes(q)).slice(0,12).map(x=>({symbol:String(x.symbol).toUpperCase()+".BK",name:x.name,exchange:x.market||"SET",market:"THAI"}));})()
    ]);
    const assets=[...(us.status==="fulfilled"?us.value:[]),...(thai.status==="fulfilled"?thai.value:[])].slice(0,20);
    if(!assets.length&&us.status==="rejected"&&thai.status==="rejected")return json({error:"ค้นหาหุ้นไม่สำเร็จจากทั้งสองแหล่ง"},502,headers);
    return json({assets,thaiDirectory:thai.status==="fulfilled"},200,headers);
  }
  if(url.pathname==="/api/signals"&&request.method==="GET") {
    if(!dbReady(env))return json({error:"D1 binding DB is missing"},503,headers);
    const symbols=[...new Set((url.searchParams.get("symbols")||"").split(",").map(cleanSymbol).filter(validSymbol))];
    if(!symbols.length)return json({signals:{}},200,headers);
    if(symbols.length>50)return json({error:"Maximum 50 symbols per request",max:50},400,headers);
    const rows=await env.DB.prepare("SELECT s.symbol,s.status,s.status_label,s.score,s.last_price,s.checked_at FROM user_stock_state s WHERE s.symbol IN ("+symbols.map(()=>"?").join(",")+") AND s.checked_at=(SELECT MAX(s2.checked_at) FROM user_stock_state s2 WHERE s2.symbol=s.symbol)").bind(...symbols).all();
    const signals={};
    for(const row of rows.results||[])signals[row.symbol]=row;
    return json({signals},200,headers);
  }
  if(url.pathname==="/api/quotes"&&request.method==="GET") {
    const requested=(url.searchParams.get("symbols")||"").split(",").map(cleanSymbol).filter(validSymbol);
    const symbols=[...new Set(requested)];
    if(!symbols.length)return json({error:"No supported symbols requested"},400,headers);
    if(symbols.length>50)return json({error:"Maximum 50 symbols per request",max:50},400,headers);
    try{return json({feed:"Alpaca IEX",fetchedAt:new Date().toISOString(),trades:await fetchLatestTrades(env,symbols)},200,headers);}
    catch(e){return json({error:"Latest quote request failed",detail:String(e).slice(0,300)},502,headers);}
  }
  if(url.pathname==="/api/market"&&request.method==="GET") {
    const requested=(url.searchParams.get("symbols")||DEFAULT_SYMBOLS.join(",")).split(",").map(cleanSymbol).filter(validSymbol);
    const symbols=[...new Set(await normalizeSymbols(env,requested))],rawTf=(url.searchParams.get("timeframe")||"1Day").toLowerCase(),tf=rawTf==="4hour"?"4Hour":rawTf==="5min"?"5Min":"1Day";
    if(!symbols.length)return json({error:"No supported symbols requested"},400,headers);
    if(symbols.length>50)return json({error:"Maximum 50 symbols per request",max:50},400,headers);
    try{return json(await fetchMarket(env,symbols,tf),200,headers);}
    catch(e){return json({error:"Market data request failed",detail:String(e).slice(0,300)},502,headers);}
  }
  return json({error:"Not found"},404,headers);
}
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),origin=request.headers.get("Origin")||"",headers=corsHeaders(origin);
    if(url.pathname==="/line/webhook") {
      if(request.method!=="POST")return json({error:"Method not allowed"},405);
      // Buffer the tiny LINE payload before responding; never read the Request stream in waitUntil.
      const raw=await request.arrayBuffer();
      const signature=request.headers.get("x-line-signature")||"";
      ctx.waitUntil(handleLineWebhook(raw,signature,env).then(result=>{
        if(result.status>=400)console.error("LINE_WEBHOOK_BACKGROUND_FAILED",result.status);
      }).catch(error=>console.error("LINE_WEBHOOK_BACKGROUND_ERROR",String(error))));
      return json({ok:true});
    }
    if(request.method==="OPTIONS")return origin&&!ALLOWED_ORIGINS.has(origin)?json({error:"Origin not allowed"},403,headers):new Response(null,{status:204,headers});
    if(origin&&!ALLOWED_ORIGINS.has(origin))return json({error:"Origin not allowed",origin},403,headers);
    if(url.pathname==="/"&&request.method==="GET")return json({service:"AI Stock Watcher API",status:"ready",multiUser:true,d1:dbReady(env),maxWatchlist:MAX_WATCHLIST,feed:"Alpaca IEX + DataCedar (Yahoo fallback)",scheduledScan:"* * * * *"},200,headers);
    if(request.method!=="GET"&&request.method!=="POST")return json({error:"Method not allowed"},405,headers);
    try{return await apiHandler(request,env,url,headers);}catch(e){console.error("API_ERROR",String(e));return json({error:"Internal API error",detail:String(e).slice(0,250)},500,headers);}
  },
  async scheduled(event,env,ctx) {
    ctx.waitUntil(Promise.all([
      scanAlerts(env),
      (async()=>{
        if(!env.DB)return;
        const now=Math.floor(Date.now()/1000);
        await env.DB.prepare("DELETE FROM line_pending_stock_actions WHERE expires_at<=?").bind(now).run();
        await env.DB.prepare("DELETE FROM user_input_modes WHERE expires_at<=?").bind(now).run();
      })()
    ]));
  }
};
