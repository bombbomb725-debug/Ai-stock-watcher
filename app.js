const DEFAULT_SYMBOLS = ["ASTS", "RKLB", "IONQ", "OKLO"];
const SCREENER_SYMBOLS = ["NVDA","AMD","TSLA","PLTR","SOFI","AVGO","HOOD","SMR","JOBY","ACHR","RKLB","ASTS","IONQ","OKLO"];
const NAMES = {
  ASTS:"AST SpaceMobile",RKLB:"Rocket Lab",IONQ:"IonQ",OKLO:"Oklo",
  NVDA:"NVIDIA",AMD:"Advanced Micro Devices",TSLA:"Tesla",PLTR:"Palantir",
  SOFI:"SoFi Technologies",AVGO:"Broadcom",HOOD:"Robinhood",SMR:"NuScale Power",
  JOBY:"Joby Aviation",ACHR:"Archer Aviation"
};
const $ = s => document.querySelector(s);
const fmt = n => Number.isFinite(n) ? n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}) : "—";
const state = {
  busy:false,
  symbols:loadSavedSymbols(),
  assets:[],
  market:{},
  apiUrl:localStorage.getItem("stockWatcherApiUrl") || "https://ai-stock-watcher-api.bombbomb725.workers.dev"
};
function loadSavedSymbols(){
  try {
    const saved = JSON.parse(localStorage.getItem("stockWatcherSymbols") || "null");
    return Array.isArray(saved) ? [...new Set(saved.filter(s=>typeof s==="string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(s))) ] : [...DEFAULT_SYMBOLS];
  } catch { return [...DEFAULT_SYMBOLS]; }
}
function saveSymbols(){ localStorage.setItem("stockWatcherSymbols",JSON.stringify(state.symbols)); }
function ema(values,period){
  if(values.length<period)return null;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function emaSeries(values,period){
  const out=Array(values.length).fill(null);
  if(values.length<period)return out;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1]=v;
  for(let i=period;i<values.length;i++){v=values[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function rsi(values,period=14){
  if(values.length<=period)return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  let avgGain=gain/period,avgLoss=loss/period;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(d,0))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;
  }
  if(avgLoss===0)return 100;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
}
function macdData(values){
  if(values.length<35)return null;
  const e12=emaSeries(values,12),e26=emaSeries(values,26);
  const line=values.map((_,i)=>e12[i]!==null&&e26[i]!==null?e12[i]-e26[i]:null);
  const valid=line.filter(Number.isFinite);
  if(valid.length<9)return null;
  const signalValid=emaSeries(valid,9);
  const signal=signalValid[signalValid.length-1];
  const macd=line[line.length-1];
  return {line:macd,signal,hist:macd-signal};
}
function completedBars(bars){
  if(!bars.length)return [];
  const last=bars[bars.length-1];
  const date=last.t?new Date(last.t):null;
  if(!date)return bars;
  const fmtDate=d=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  return fmtDate(date)===fmtDate(new Date())?bars.slice(0,-1):bars;
}
function analyze(bars,price){
  const done=completedBars(bars);
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<55)return {signal:"ข้อมูลย้อนหลังไม่พอ",kind:"wait",score:0,short:null,long:null,rsi:null,macd:null,confirmed:false,strong:false};
  const short=ema(closes,20),long=ema(closes,50),momentum=rsi(closes),m=macdData(closes);
  const e20s=emaSeries(closes,20),e50s=emaSeries(closes,50);
  const rising20=e20s.at(-1)>e20s.at(-6),rising50=e50s.at(-1)>e50s.at(-6);
  const lastClose=closes.at(-1);
  const trend=short>long&&rising20&&rising50&&lastClose>short;
  const momentumOK=momentum>=50&&momentum<70&&m&&m.line>m.signal&&m.hist>0;
  const confirmed=Boolean(trend&&momentumOK);
  const prior=done.slice(-21,-1);
  const priorHigh=prior.length?Math.max(...prior.map(b=>Number(b.h)).filter(Number.isFinite)):null;
  const lastVolume=Number(done.at(-1)?.v);
  const avgVolume=done.slice(-21,-1).map(b=>Number(b.v)).filter(Number.isFinite);
  const volumeAvg=avgVolume.length?avgVolume.reduce((x,y)=>x+y,0)/avgVolume.length:0;
  const breakout=Number.isFinite(price)&&Number.isFinite(priorHigh)&&price>priorHigh;
  const volumeOK=volumeAvg>0&&lastVolume>=volumeAvg*1.3;
  const strong=confirmed&&breakout&&volumeOK;
  const score=[trend,momentumOK,breakout,volumeOK,Boolean(m&&m.hist>0)].filter(Boolean).length;
  let signal="รอการยืนยันแนวโน้ม",kind="wait";
  if(strong){signal="ขาขึ้นยืนยัน + เบรกเอาต์";kind="buy";}
  else if(confirmed){signal="BUY SIGNAL · แนวโน้มขาขึ้น";kind="buy";}
  else if(momentum<45||(!trend&&Number.isFinite(price)&&price<short&&short<long)){signal="แนวโน้มยังอ่อน";kind="risk";}
  else if(Number.isFinite(price)&&price>short&&!trend){signal="เริ่มฟื้นตัว · รอยืนยัน";kind="wait";}
  return {short,long,rsi:momentum,macd:m?.line??null,macdSignal:m?.signal??null,score,signal,kind,confirmed,strong,lastClose,priorHigh,breakout,volumeOK};
}
function atrValue(bars,period=14){
  if(bars.length<period+1)return null;
  const tr=[];
  for(let i=1;i<bars.length;i++){
    const h=Number(bars[i].h),l=Number(bars[i].l),pc=Number(bars[i-1].c);
    if([h,l,pc].every(Number.isFinite))tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return tr.length>=period?tr.slice(-period).reduce((a,b)=>a+b,0)/period:null;
}
function chartSvg(bars){
  const rows=bars.slice(-60),cl=rows.map(b=>Number(b.c)),e20=emaSeries(cl,20),e50=emaSeries(cl,50);
  const vals=[...cl,...e20.filter(Number.isFinite),...e50.filter(Number.isFinite)];
  if(vals.length<2)return '<div class="chart-empty">ข้อมูลกราฟยังไม่เพียงพอ</div>';
  let lo=Math.min(...vals),hi=Math.max(...vals),pad=(hi-lo)*.12||1;lo-=pad;hi+=pad;
  const X=i=>30+i*(560/Math.max(1,rows.length-1)),Y=v=>12+(hi-v)/(hi-lo)*156;
  const path=a=>a.map((v,i)=>Number.isFinite(v)?(i&&Number.isFinite(a[i-1])?"L":"M")+X(i).toFixed(1)+","+Y(v).toFixed(1):"").join(" ");
  const last=cl.length-1;
  return '<div class="chart-wrap"><svg class="price-chart" viewBox="0 0 610 190" role="img" aria-label="กราฟราคา EMA20 EMA50"><line x1="30" y1="45" x2="590" y2="45" class="chart-grid"/><line x1="30" y1="95" x2="590" y2="95" class="chart-grid"/><line x1="30" y1="145" x2="590" y2="145" class="chart-grid"/><path d="'+path(cl)+'" class="line-price"/><path d="'+path(e20)+'" class="line-ema20"/><path d="'+path(e50)+'" class="line-ema50"/><circle cx="'+X(last)+'" cy="'+Y(cl[last])+'" r="3.5" class="chart-last"/></svg><div class="chart-legend"><span>ราคาปิด</span><span>EMA20</span><span>EMA50</span></div></div>';
}
function entryPlan(bars,a){
  const done=completedBars(bars),atr=atrValue(done),e20=a.short;
  if(!Number.isFinite(atr)||!Number.isFinite(e20))return null;
  const lows=done.slice(-20).map(b=>Number(b.l)).filter(Number.isFinite);
  const support=lows.length?Math.min(...lows):e20-atr;
  const low=Math.max(e20-.35*atr,e20*.985);
  const high=e20+.15*atr;
  const stop=Math.min(support,e20-1.2*atr);
  const risk=Math.max(high-stop,atr*.5);
  return {low,high,stop,target:high+2*risk};
}
function renderCard(symbol,item){
  const bars=item.bars||[],price=Number(item.trade?.p),a=analyze(bars,price),plan=entryPlan(bars,a);
  const prev=bars.length>1?Number(bars[bars.length-2].c):NaN;
  const change=Number.isFinite(price)&&Number.isFinite(prev)&&prev!==0?(price-prev)/prev*100:null;
  const cls=change===null?"neutral":change>=0?"positive":"negative";
  const decision=a.kind==="buy"
    ? {label:"ซื้อได้",tone:"green",detail:a.strong?"แนวโน้มขาขึ้นยืนยันแล้ว และราคาทะลุจุดสูงเดิมพร้อมวอลุ่ม":"แนวโน้มขาขึ้นผ่านเงื่อนไขหลักแล้ว แต่ควรรอเข้าตามโซน ไม่ไล่ราคา"}
    : a.kind==="risk"
    ? {label:"อย่าเพิ่งซื้อ",tone:"red",detail:"แนวโน้มยังอ่อนหรือโมเมนตัมไม่สนับสนุน รอให้สัญญาณกลับตัวก่อน"}
    : {label:"เตรียมซื้อ",tone:"yellow",detail:"เริ่มมีสัญญาณฟื้นตัวหรือยังยืนยันไม่ครบ รอดูแท่งวันถัดไปและเงื่อนไขให้ครบก่อน"};
  const decisionHtml='<section class="decision '+decision.tone+'"><div class="decision-heading"><span>สรุปง่ายๆ</span><b>'+decision.label+'</b></div><p>'+decision.detail+'</p></section>';
  const planHtml=plan?`<section class="entry-plan"><div class="entry-title">โซนราคาเฝ้ารอเข้าซื้อเมื่อกลับตัวเป็นขาขึ้น</div><div class="entry-range">$${fmt(plan.low)} – $${fmt(plan.high)}</div><div class="entry-levels"><span>เป้าหมาย 2R <b>$${fmt(plan.target)}</b></span><span>จุดตัดขาดทุน <b>$${fmt(plan.stop)}</b></span></div><small>${a.confirmed?'แนวโน้มผ่านเงื่อนไขแล้ว รอราคาเข้ามาในโซนนี้ ไม่ไล่ซื้อ':'ระดับประมาณการล่วงหน้า ยังไม่ใช่สัญญาณซื้อ รอให้สถานะเป็นสีเขียวก่อน'}</small></section>`:"";
  const time=item.trade?.t?new Date(item.trade.t).toLocaleString("th-TH"):"ไม่พบรายการซื้อขายล่าสุด";
  return '<article class="stock-card"><div class="stock-head"><div><div class="symbol">'+symbol+'</div><div class="company">'+(NAMES[symbol]||"หุ้นสหรัฐฯ")+'</div></div><div class="card-actions"><span class="signal '+a.kind+'">'+a.signal+'</span><button class="remove-stock" data-remove="'+symbol+'" aria-label="ลบ '+symbol+'">×</button></div></div><div class="price">'+(Number.isFinite(price)?"$"+fmt(price):"ไม่มีราคาล่าสุด")+'</div><div class="change '+cls+'">'+(change===null?"เทียบราคาปิดไม่ได้":(change>=0?"+":"")+change.toFixed(2)+"% จากแท่งก่อนหน้า")+'</div>'+decisionHtml+chartSvg(bars)+'<div class="metrics"><div class="metric"><span>EMA20 / EMA50</span><b>'+fmt(a.short)+' / '+fmt(a.long)+'</b></div><div class="metric"><span>RSI14</span><b>'+fmt(a.rsi)+'</b></div><div class="metric"><span>MACD</span><b>'+fmt(a.macd)+'</b></div></div>'+planHtml+'<div class="card-foot">ซื้อขายล่าสุด: '+time+' · คะแนน '+a.score+'/5 · ใช้แท่งรายวันที่ปิดแล้ว · IEX</div></article>';
}
function setStatus(msg,ok=false){
  $("#connection").textContent=msg;
  const dot=document.querySelector(".live-dot");
  if(dot)dot.style.background=ok?"#3bd69b":"#f5c96a";
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function renderWatchlist(){ $("#watchlist").textContent="กำลังติดตาม "+state.symbols.length+" หุ้น"; }
function renderIdeas(){
  const root=$("#ideas");
  root.innerHTML=SCREENER_SYMBOLS.map(s=>'<button class="idea-chip" type="button" data-idea="'+s+'">'+s+' <small>เพิ่ม</small></button>').join("");
}
async function fetchMarket(symbols){
  const result={};
  for(let i=0;i<symbols.length;i+=20){
    const batch=symbols.slice(i,i+20);
    const url=state.apiUrl.replace(/\/$/,"")+"/api/market?symbols="+encodeURIComponent(batch.join(","));
    const response=await fetch(url,{cache:"no-store"});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
    Object.assign(result,data.stocks||{});
  }
  return result;
}
function maybeNotify(symbol,item){
  if(!("Notification" in window)||Notification.permission!=="granted")return;
  const price=Number(item.trade?.p),a=analyze(item.bars||[],price);
  if(!a.confirmed)return;
  const day=new Date().toISOString().slice(0,10),key="stockWatcherAlert_"+symbol;
  if(localStorage.getItem(key)===day)return;
  new Notification("AI Stock Watcher: "+symbol,{body:"ยืนยันแนวโน้มขาขึ้น · คะแนน "+a.score+"/5 · ราคา "+(Number.isFinite(price)?"$"+fmt(price):"ไม่ทราบ")});
  localStorage.setItem(key,day);
}
async function loadMarket(){
  if(state.busy)return;
  state.busy=true;$("#refresh").disabled=true;$("#refresh").textContent="กำลังโหลด…";
  setStatus("กำลังดึงข้อมูลตลาด");
  try{
    if(!state.symbols.length){$("#cards").innerHTML='<article class="stock-card">ยังไม่มีหุ้นใน Watchlist ค้นหาและเพิ่มหุ้นได้ด้านบน</article>';return;}
    state.market=await fetchMarket(state.symbols);
    $("#cards").innerHTML=state.symbols.map(s=>state.market[s]?renderCard(s,state.market[s]):'<article class="stock-card"><b>'+s+'</b><p>ไม่พบข้อมูลจาก IEX</p></article>').join("");
    state.symbols.forEach(s=>{if(state.market[s])maybeNotify(s,state.market[s]);});
    const count=Object.values(state.market).reduce((n,x)=>n+(x.bars||[]).length,0);
    setStatus("เชื่อมต่อแล้ว · Alpaca IEX",true);
    $("#updated").textContent="อัปเดต "+new Date().toLocaleString("th-TH")+" · ข้อมูลย้อนหลัง "+count+" แท่ง";
  }catch(e){setStatus("เชื่อมต่อไม่สำเร็จ");$("#cards").innerHTML='<article class="stock-card"><b>โหลดข้อมูลไม่สำเร็จ</b><p>'+escapeHtml(e.message)+'</p><small>ตรวจ Worker URL, CORS และ Secrets ใน Cloudflare</small></article>';}
  finally{state.busy=false;$("#refresh").disabled=false;$("#refresh").textContent="↻ อัปเดต";}
}
function addSymbol(symbol){
  symbol=String(symbol||"").trim().toUpperCase();
  if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)){setStatus("Ticker ไม่ถูกต้อง");return;}
  if(state.symbols.includes(symbol)){setStatus(symbol+" อยู่ในรายการแล้ว",true);return;}
  state.symbols.push(symbol);saveSymbols();renderWatchlist();
  $("#searchResults").innerHTML="";$("#stockSearch").value="";
  loadMarket();
}
async function searchAssets(){
  const q=$("#stockSearch").value.trim();if(!q)return;
  const root=$("#searchResults");root.textContent="กำลังค้นหา…";
  try{
    const response=await fetch(state.apiUrl.replace(/\/$/,"")+"/api/assets?q="+encodeURIComponent(q),{cache:"no-store"});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"ค้นหาไม่สำเร็จ");
    state.assets=data.assets||[];
    root.innerHTML=state.assets.length?state.assets.map(a=>'<button class="search-result" type="button" data-symbol="'+escapeHtml(a.symbol)+'"><b>'+escapeHtml(a.symbol)+'</b><span>'+escapeHtml(a.name)+'</span><small>เพิ่ม +</small></button>').join(""):"ไม่พบหุ้นที่ตรงกัน";
  }catch(e){root.textContent="ค้นหาไม่สำเร็จ: "+e.message;}
}
async function runScreener(){
  const btn=$("#runScreener"),root=$("#screenerResults");
  btn.disabled=true;btn.textContent="กำลังคัดกรอง…";root.textContent="กำลังดึงข้อมูลหุ้นตัวอย่างและคำนวณตัวชี้วัด";
  try{
    const symbols=[...new Set(SCREENER_SYMBOLS)];
    const data=await fetchMarket(symbols);
    const ranked=symbols.map(symbol=>{
      const item=data[symbol];if(!item)return null;
      const a=analyze(item.bars||[],Number(item.trade?.p));
      return {symbol,item,a};
    }).filter(Boolean).sort((x,y)=>y.a.score-x.a.score);
    root.innerHTML=ranked.map((x,i)=>'<div class="rank-row"><b>#'+(i+1)+' '+x.symbol+'</b><span class="signal '+x.a.kind+'">'+x.a.signal+'</span><span>'+x.a.score+'/5</span><button type="button" data-screener-add="'+x.symbol+'">เพิ่มในรายการ</button></div>').join("")||"ไม่มีข้อมูลสำหรับคัดกรอง";
  }catch(e){root.textContent="คัดกรองไม่สำเร็จ: "+e.message;}
  finally{btn.disabled=false;btn.textContent="เริ่มคัดกรองหุ้น";}
}
$("#apiUrl").value=state.apiUrl;
$("#refresh").addEventListener("click",loadMarket);
$("#saveUrl").addEventListener("click",()=>{
  const value=$("#apiUrl").value.trim().replace(/\/$/,"");
  try{new URL(value);state.apiUrl=value;localStorage.setItem("stockWatcherApiUrl",value);setStatus("บันทึก Worker URL แล้ว",true);loadMarket();}
  catch{setStatus("Worker URL ไม่ถูกต้อง");}
});
$("#addStock").addEventListener("click",searchAssets);
$("#stockSearch").addEventListener("keydown",e=>{if(e.key==="Enter")searchAssets();});
$("#searchResults").addEventListener("click",e=>{const b=e.target.closest("[data-symbol]");if(b)addSymbol(b.dataset.symbol);});
$("#ideas").addEventListener("click",e=>{const b=e.target.closest("[data-idea]");if(b)addSymbol(b.dataset.idea);});
$("#cards").addEventListener("click",e=>{
  const b=e.target.closest("[data-remove]");if(!b)return;
  state.symbols=state.symbols.filter(s=>s!==b.dataset.remove);saveSymbols();renderWatchlist();loadMarket();
});
$("#runScreener").addEventListener("click",runScreener);
$("#screenerResults").addEventListener("click",e=>{const b=e.target.closest("[data-screener-add]");if(b)addSymbol(b.dataset.screenerAdd);});
$("#enableAlerts").addEventListener("click",async()=>{
  if(!("Notification" in window)){setStatus("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");return;}
  const permission=await Notification.requestPermission();
  setStatus(permission==="granted"?"เปิดการแจ้งเตือนแล้ว":"ยังไม่ได้อนุญาตการแจ้งเตือน",permission==="granted");
});
renderIdeas();renderWatchlist();loadMarket();
