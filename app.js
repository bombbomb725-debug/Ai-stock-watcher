const DEFAULT_SYMBOLS = ["ASTS", "RKLB", "IONQ", "OKLO"];
const SCREENER_SYMBOLS = ["NVDA","AMD","TSLA","PLTR","SOFI","AVGO","HOOD","SMR","JOBY","ACHR","RKLB","ASTS","IONQ","OKLO","MSFT","AMZN","META","ARM","COIN","LUNR","RDDT","MSTR","TEM","RGTI","QBTS","QUBT","HIMS","CRSP","RXRX","SPCE","APP","ORCL","CRM","NOW","PANW","CRWD","NET","SNOW","MU","TSM","ANET","GEV","CEG","VST","CCJ","LEU","UUUU","QS","ENVX","BBAI"];
const NAMES = {
  ASTS:"AST SpaceMobile",RKLB:"Rocket Lab",IONQ:"IonQ",OKLO:"Oklo",
  NVDA:"NVIDIA",AMD:"Advanced Micro Devices",TSLA:"Tesla",PLTR:"Palantir",
  SOFI:"SoFi Technologies",AVGO:"Broadcom",HOOD:"Robinhood",SMR:"NuScale Power",
  JOBY:"Joby Aviation",ACHR:"Archer Aviation",MSFT:"Microsoft",AMZN:"Amazon",
  META:"Meta Platforms",ARM:"Arm Holdings",COIN:"Coinbase",LUNR:"Intuitive Machines"
};
const $ = s => document.querySelector(s);
const fmt = n => Number.isFinite(n) ? n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}) : "—";
const state = {
  busy:false,
  intradayBusy:false,
  symbols:loadSavedSymbols(),
  assets:[],
  market:{},
  timeframe:"1Day",
  apiUrl:localStorage.getItem("stockWatcherApiUrl") || "https://ai-stock-watcher-api.bombbomb725.workers.dev",
  sessionToken:sessionStorage.getItem("stockWatcherSessionToken")||"",
  user:null,
  shared:false,
  focusSymbol:(new URLSearchParams(location.search).get("symbol")||"").trim().toUpperCase()
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
function completedBars(bars,timeframe="1Day"){
  if(!bars.length)return [];
  if(timeframe==="4Hour"){
    const last=bars[bars.length-1],start=last.t?new Date(last.t).getTime():NaN;
    return Number.isFinite(start)&&start+4*60*60*1000>Date.now()?bars.slice(0,-1):bars;
  }
  const last=bars[bars.length-1];
  const date=last.t?new Date(last.t):null;
  if(!date)return bars;
  const fmtDate=d=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  return fmtDate(date)===fmtDate(new Date())?bars.slice(0,-1):bars;
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
function analyze(bars,price,timeframe=state.timeframe){
  const done=completedBars(bars,timeframe);
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<55)return {signal:"ข้อมูลย้อนหลังไม่พอ",kind:"wait",score:0,short:null,long:null,rsi:null,macd:null,confirmed:false,strong:false};
  const short=ema(closes,20),long=ema(closes,50),momentum=rsi(closes),m=macdData(closes),adx=adxValue(done);
  const e20s=emaSeries(closes,20),e50s=emaSeries(closes,50);
  const rising20=e20s.at(-1)>e20s.at(-6),rising50=e50s.at(-1)>e50s.at(-6),lastClose=closes.at(-1);
  const trend=short>long&&rising20&&rising50&&lastClose>short;
  const rsiOK=momentum>=50&&momentum<70,macdOK=Boolean(m&&m.line>m.signal&&m.hist>0),trendStrengthOK=Number.isFinite(adx)&&adx>=18;
  const confirmed=Boolean(trend&&rsiOK&&macdOK&&trendStrengthOK);
  const prior=done.slice(-21,-1),priorHigh=prior.length?Math.max(...prior.map(b=>Number(b.h)).filter(Number.isFinite)):null;
  const lastVolume=Number(done.at(-1)?.v),avgVolume=prior.map(b=>Number(b.v)).filter(Number.isFinite);
  const volumeAvg=avgVolume.length?avgVolume.reduce((x,y)=>x+y,0)/avgVolume.length:0;
  const breakout=Number.isFinite(lastClose)&&Number.isFinite(priorHigh)&&lastClose>priorHigh;
  const volumeOK=volumeAvg>0&&lastVolume>=volumeAvg*1.3;
  const strong=confirmed&&breakout&&volumeOK;
  const score=[trend,rsiOK,macdOK,breakout,volumeOK].filter(Boolean).length;
  let signal="รอการยืนยันแนวโน้ม",kind="wait";
  if(strong){signal="ขาขึ้นแข็งแรง + เบรกเอาต์และวอลุ่มยืนยัน";kind="buy";}
  else if(confirmed){signal="BUY SIGNAL · แนวโน้มและ ADX ยืนยัน";kind="buy";}
  else if(momentum<45||(!trend&&lastClose<short&&short<long)){signal="แนวโน้มยังอ่อน";kind="risk";}
  else if(lastClose>short&&!trend){signal="เริ่มฟื้นตัว · รอยืนยัน";kind="wait";}
  return {short,long,rsi:momentum,macd:m?.line??null,macdSignal:m?.signal??null,adx,score,signal,kind,confirmed,strong,lastClose,priorHigh,breakout,volumeOK};
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
function chartSvg(bars,livePrice,caption="กราฟย้อนหลัง · รายวัน"){
  const rows=bars.slice(-60),history=rows.map(b=>Number(b.c)).filter(Number.isFinite),hasLive=Number.isFinite(livePrice);
  const cl=hasLive?[...history,livePrice]:history,e20=emaSeries(history,20),e50=emaSeries(history,50);
  if(hasLive){e20.push(e20.at(-1)??null);e50.push(e50.at(-1)??null);}
  const vals=[...cl,...e20.filter(Number.isFinite),...e50.filter(Number.isFinite)];
  if(vals.length<2)return '<div class="chart-empty">ข้อมูลกราฟยังไม่เพียงพอ · มี '+history.length+' แท่ง</div>';
  let lo=Math.min(...vals),hi=Math.max(...vals),pad=(hi-lo)*.12||1;lo-=pad;hi+=pad;
  const X=i=>30+i*(560/Math.max(1,cl.length-1)),Y=v=>12+(hi-v)/(hi-lo)*156;
  const path=a=>a.map((v,i)=>Number.isFinite(v)?(i&&Number.isFinite(a[i-1])?"L":"M")+X(i).toFixed(1)+","+Y(v).toFixed(1):"").join(" ");
  const last=cl.length-1;
  return '<div class="chart-wrap"><div class="chart-caption">'+caption+' · EMA20 / EMA50</div><svg class="price-chart" viewBox="0 0 610 190" role="img" aria-label="กราฟราคา EMA20 EMA50"><line x1="30" y1="45" x2="590" y2="45" class="chart-grid"/><line x1="30" y1="95" x2="590" y2="95" class="chart-grid"/><line x1="30" y1="145" x2="590" y2="145" class="chart-grid"/><path d="'+path(cl)+'" class="line-price"/><path d="'+path(e20)+'" class="line-ema20"/><path d="'+path(e50)+'" class="line-ema50"/><circle cx="'+X(last)+'" cy="'+Y(cl[last])+'" r="3.5" class="chart-last"/></svg><div class="chart-legend"><span>ราคา</span><span>EMA20</span><span>EMA50</span></div></div>';
}
function entryPlan(bars,a){
  const done=completedBars(bars,state.timeframe),atr=atrValue(done),e20=a.short;
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
  const bars=item.bars||[],price=Number(item.trade?.p),a=analyze(bars,price);
  if(item.signal){
    a.kind=item.signal.status||a.kind;
    a.signal=item.signal.status_label||a.signal;
    a.score=Number.isFinite(Number(item.signal.score))?Number(item.signal.score):a.score;
    a.confirmed=a.kind==="buy";
    a.strong=String(a.signal).includes("เบรกเอาต์");
  }
  const plan=entryPlan(bars,a);
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
  return '<article class="stock-card"><div class="stock-head"><div><div class="symbol">'+symbol+'</div><div class="company">'+(NAMES[symbol]||"หุ้นสหรัฐฯ")+'</div></div><div class="card-actions"><span class="signal '+a.kind+'">'+a.signal+'</span>'+(state.symbols.includes(symbol)?'<button class="remove-stock" data-remove="'+symbol+'" aria-label="ลบ '+symbol+'">×</button>':'')+'</div></div><div class="price">'+(Number.isFinite(price)?"$"+fmt(price):"ไม่มีราคาล่าสุด")+'</div><div class="change '+cls+'">'+(change===null?"เทียบราคาปิดไม่ได้":(change>=0?"+":"")+change.toFixed(2)+"% จากแท่งก่อนหน้า")+'</div>'+decisionHtml+chartSvg(item.intradayBars?.length?item.intradayBars:bars,price,item.intradayBars?.length?"กราฟระหว่างวัน · แท่ง 5 นาที":"กราฟย้อนหลัง · รายวัน")+'<div class="metrics"><div class="metric"><span>EMA20 / EMA50</span><b>'+fmt(a.short)+' / '+fmt(a.long)+'</b></div><div class="metric"><span>RSI14</span><b>'+fmt(a.rsi)+'</b></div><div class="metric"><span>MACD</span><b>'+fmt(a.macd)+'</b></div><div class="metric"><span>ADX14</span><b>'+fmt(a.adx)+'</b></div></div>'+planHtml+'<div class="card-foot">ซื้อขายล่าสุด: '+time+' · คะแนน '+a.score+'/5 · สถานะ/คะแนนอิงผลสแกน 1D '+(item.signal?.checked_at?new Date(item.signal.checked_at).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"}):"รอผลสแกน")+' · IEX</div></article>';
}
function setStatus(msg,ok=false){
  $("#connection").textContent=msg;
  const dot=document.querySelector(".live-dot");
  if(dot)dot.style.background=ok?"#3bd69b":"#f5c96a";
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function renderWatchlist(){ $("#watchlist").textContent="กำลังติดตาม "+state.symbols.length+"/50 หุ้น"+(state.shared?" · ซิงก์กับ LINE แล้ว":" · ยังไม่ซิงก์"); }
async function apiRequest(path,options={}) {
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(state.sessionToken)headers.Authorization="Bearer "+state.sessionToken;
  const response=await fetch(state.apiUrl.replace(/\/$/,"")+path,{...options,headers,cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data;
}
function showPairingCode(code) {
  $("#accountStatus").innerHTML='ยังไม่เชื่อม LINE · เปิดแชตบอต AI Stock Watcher แล้วพิมพ์ <b>เชื่อม '+escapeHtml(code)+'</b> · รหัสหมดอายุใน 10 นาที';
}
async function activateSharedAccount(data) {
  const localSymbols=[...state.symbols];
  state.user=data.user||null;
  state.shared=true;
  state.symbols=data.symbols||[];
  let mergeLimitReached=false;
  for(const symbol of localSymbols) {
    if(state.symbols.includes(symbol))continue;
    if(state.symbols.length>=50){mergeLimitReached=true;break;}
    try {
      const added=await apiRequest("/api/watchlist/add",{method:"POST",body:JSON.stringify({symbol})});
      if(added.ok)state.symbols=added.symbols;
    } catch(e) {
      if(e.message.includes("50")){mergeLimitReached=true;break;}
      throw e;
    }
  }
  const current=await apiRequest("/api/me");
  state.symbols=current.symbols||state.symbols;
  state.user=current.user||state.user;
  saveSymbols();
  sessionStorage.removeItem("stockWatcherLinkCode");
  sessionStorage.removeItem("stockWatcherLinkExpiry");
  renderWatchlist();
  $("#accountStatus").textContent="เชื่อม LINE แล้ว"+(state.user?.displayName?" · "+state.user.displayName:"")+" · ใช้ Watchlist ร่วมกัน"+(mergeLimitReached?" · รายการเต็ม 50 หุ้น จึงยังรวมบางตัวจากเว็บไม่ได้":"");
  setStatus("บัญชี LINE เชื่อมแล้ว",true);
  loadMarket();
}
async function pollLineLink() {
  if(!state.sessionToken)return;
  try {
    const data=await apiRequest("/api/link/status");
    if(data.linked){await activateSharedAccount(data);return;}
    const code=sessionStorage.getItem("stockWatcherLinkCode");
    if(code)showPairingCode(code);
  } catch(e) {
    sessionStorage.removeItem("stockWatcherSessionToken");
    sessionStorage.removeItem("stockWatcherLinkCode");
    sessionStorage.removeItem("stockWatcherLinkExpiry");
    state.sessionToken="";
    $("#accountStatus").textContent="การเชื่อมต่อหมดอายุ กำลังสร้างรหัสใหม่…";
    await startLinePairing();
    return;
  }
  setTimeout(pollLineLink,3000);
}
async function startLinePairing() {
  let code=sessionStorage.getItem("stockWatcherLinkCode");
  let expiry=Number(sessionStorage.getItem("stockWatcherLinkExpiry")||0);
  if(!state.sessionToken||!code||expiry<=Date.now()) {
    const data=await apiRequest("/api/link/start",{method:"POST",body:"{}"});
    state.sessionToken=data.token;
    sessionStorage.setItem("stockWatcherSessionToken",data.token);
    sessionStorage.setItem("stockWatcherLinkCode",data.code);
    sessionStorage.setItem("stockWatcherLinkExpiry",String(data.expiresAt*1000));
    code=data.code;
  }
  showPairingCode(code);
  setTimeout(pollLineLink,1200);
}
async function syncSharedWatchlist() {
  if(!state.shared||state.busy)return;
  try {
    const data=await apiRequest("/api/me");
    const next=data.symbols||[];
    if(JSON.stringify(next)!==JSON.stringify(state.symbols)) {
      state.symbols=next;
      saveSymbols();
      renderWatchlist();
      loadMarket();
    }
  } catch(e) {
    if(e.message.includes("เข้าสู่ระบบ")) {
      state.shared=false;
      state.user=null;
      renderWatchlist();
      $("#accountStatus").textContent="เซสชันหมดอายุ กรุณาเชื่อม LINE ใหม่";
    }
  }
}
async function initializeAccount() {
  state.user=null;
  renderWatchlist();
  try {
    if(state.sessionToken) {
      const data=await apiRequest("/api/link/status");
      if(data.linked){await activateSharedAccount(data);return;}
    }
    await startLinePairing();
    setStatus("รอเชื่อมบัญชี LINE");
    loadMarket();
  } catch(e) {
    state.sessionToken="";
    sessionStorage.removeItem("stockWatcherSessionToken");
    sessionStorage.removeItem("stockWatcherLinkCode");
    sessionStorage.removeItem("stockWatcherLinkExpiry");
    try {
      await startLinePairing();
      setStatus("รอเชื่อมบัญชี LINE");
    } catch(err) {
      $("#accountStatus").textContent="เชื่อมต่อระบบจับคู่ LINE ไม่สำเร็จ: "+err.message;
      setStatus("เชื่อมต่อบัญชีไม่สำเร็จ");
    }
    loadMarket();
  }
}
async function removeSymbol(symbol) {
  try {
    if(state.shared) {
      const data=await apiRequest("/api/watchlist/remove",{method:"POST",body:JSON.stringify({symbol})});
      state.symbols=data.symbols||[];
    } else {
      state.symbols=state.symbols.filter(s=>s!==symbol);
    }
    saveSymbols();
    renderWatchlist();
    loadMarket();
  } catch(e) {setStatus("ลบหุ้นไม่สำเร็จ: "+e.message);}
}
function renderIdeas(){
  const root=$("#ideas");
  root.innerHTML=SCREENER_SYMBOLS.map(s=>'<button class="idea-chip" type="button" data-idea="'+s+'">'+s+' <small>เพิ่ม</small></button>').join("");
}
async function fetchMarket(symbols,timeframe=state.timeframe){
  const result={};
  for(let i=0;i<symbols.length;i+=50){
    const batch=symbols.slice(i,i+50);
    const url=state.apiUrl.replace(/\/$/,"")+"/api/market?symbols="+encodeURIComponent(batch.join(","))+"&timeframe="+encodeURIComponent(timeframe);
    const response=await fetch(url,{cache:"no-store"});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
    Object.assign(result,data.stocks||{});
  }
  return result;
}
async function fetchSignals(symbols){
  const url=state.apiUrl.replace(/\/$/,"")+"/api/signals?symbols="+encodeURIComponent(symbols.join(","));
  const response=await fetch(url,{cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data.signals||{};
}
async function fetchLatestQuotes(symbols){
  const url=state.apiUrl.replace(/\/$/,"")+"/api/quotes?symbols="+encodeURIComponent(symbols.join(","));
  const response=await fetch(url,{cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data;
}
function isUsRegularSession(){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const minutes=Number(v.hour)*60+Number(v.minute);
  return v.weekday!=="Sat"&&v.weekday!=="Sun"&&minutes>=570&&minutes<960;
}
async function refreshIntradayBars(){
  if(!isUsRegularSession()||document.hidden||state.busy||state.intradayBusy||!Object.keys(state.market).length)return;
  const symbols=Object.keys(state.market);
  state.intradayBusy=true;
  try{
    const data=await fetchMarket(symbols,"5Min");
    for(const symbol of symbols){
      if(!state.market[symbol]||!data[symbol])continue;
      state.market[symbol].intradayBars=data[symbol].bars||state.market[symbol].intradayBars||[];
      if(data[symbol].trade)state.market[symbol].trade=data[symbol].trade;
    }
    $("#cards").innerHTML=symbols.map(s=>state.market[s]?renderCard(s,state.market[s]):"").join("");
    $("#updated").textContent="อัปเดตกราฟระหว่างวัน "+new Date().toLocaleTimeString("th-TH")+" · แท่ง 5 นาที";
  }catch(e){console.warn("INTRADAY_BAR_REFRESH_FAILED",e);}
  finally{state.intradayBusy=false;}
}
async function refreshLiveQuotes(){
  if(!isUsRegularSession()||document.hidden||state.busy||!Object.keys(state.market).length)return;
  const symbols=[...new Set([...state.symbols,...(state.focusSymbol?[state.focusSymbol]:[])])];
  if(!symbols.length)return;
  try{
    const [data,signals]=await Promise.all([fetchLatestQuotes(symbols),fetchSignals(symbols)]);
    for(const symbol of symbols){
      if(state.market[symbol]&&signals[symbol])state.market[symbol].signal=signals[symbol];
      const trade=data.trades?.[symbol];
      if(trade&&state.market[symbol])state.market[symbol].trade=trade;
    }
    $("#cards").innerHTML=symbols.map(s=>state.market[s]?renderCard(s,state.market[s]):'<article class="stock-card"><b>'+escapeHtml(s)+'</b><p>ไม่พบข้อมูลจาก IEX</p></article>').join("");
    $("#updated").textContent="อัปเดตราคาสด "+new Date().toLocaleTimeString("th-TH")+" · Alpaca IEX · รีเฟรชทุก 15 วินาทีขณะตลาดเปิด";
    setStatus("ตลาดสหรัฐฯ เปิด · อัปเดตราคาสดอัตโนมัติ",true);
  }catch(e){console.warn("LIVE_QUOTE_REFRESH_FAILED",e);}
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
    const displaySymbols=[...new Set([...state.symbols,...(state.focusSymbol?[state.focusSymbol]:[])])];
    const [dailyResult,intradayResult,signalResult]=await Promise.all([
      fetchMarket(displaySymbols,"1Day").then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason})),
      fetchMarket(displaySymbols,"5Min").then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason})),
      fetchSignals(displaySymbols).then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason}))
    ]);
    if(dailyResult.status!=="fulfilled")throw dailyResult.reason;
    const dailyMarket=dailyResult.value||{},intradayMarket=intradayResult.status==="fulfilled"?(intradayResult.value||{}):{},signals=signalResult.status==="fulfilled"?(signalResult.value||{}):{};
    state.market=dailyMarket;
    for(const symbol of displaySymbols){
      if(!state.market[symbol])continue;
      if(signals[symbol])state.market[symbol].signal=signals[symbol];
      state.market[symbol].intradayBars=intradayMarket[symbol]?.bars||[];
    }
    $("#cards").innerHTML=displaySymbols.map(s=>state.market[s]?renderCard(s,state.market[s]):'<article class="stock-card"><b>'+escapeHtml(s)+'</b><p>ไม่พบข้อมูลจาก IEX</p></article>').join("");
    state.symbols.forEach(s=>{if(state.market[s])maybeNotify(s,state.market[s]);});
    const count=Object.values(state.market).reduce((n,x)=>n+(x.bars||[]).length,0);
    const chartFallback=intradayResult.status!=="fulfilled";
    const signalFallback=signalResult.status!=="fulfilled";
    setStatus("เชื่อมต่อแล้ว · Alpaca IEX"+(chartFallback?" · ใช้กราฟรายวันสำรอง":"")+(signalFallback?" · คำนวณสถานะจากข้อมูลราคา":""),true);
    $("#updated").textContent="อัปเดต "+new Date().toLocaleString("th-TH")+" · ข้อมูลย้อนหลัง "+count+" แท่ง";
  }catch(e){setStatus("เชื่อมต่อไม่สำเร็จ");$("#cards").innerHTML='<article class="stock-card"><b>โหลดข้อมูลไม่สำเร็จ</b><p>'+escapeHtml(e.message)+'</p><small>ตรวจ Worker URL, CORS และ Secrets ใน Cloudflare</small></article>';}
  finally{state.busy=false;$("#refresh").disabled=false;$("#refresh").textContent="↻ อัปเดต";}
}
async function addSymbol(symbol){
  symbol=String(symbol||"").trim().toUpperCase();
  if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)){setStatus("Ticker ไม่ถูกต้อง");return;}
  if(state.symbols.includes(symbol)){setStatus(symbol+" อยู่ในรายการแล้ว",true);return;}
  if(state.symbols.length>=50){setStatus("ครบจำนวนสูงสุด 50 หุ้นแล้ว");return;}
  try {
    if(state.shared) {
      const data=await apiRequest("/api/watchlist/add",{method:"POST",body:JSON.stringify({symbol})});
      state.symbols=data.symbols||state.symbols;
    } else state.symbols.push(symbol);
    saveSymbols();
    renderWatchlist();
    $("#searchResults").innerHTML="";$("#stockSearch").value="";
    loadMarket();
  } catch(e) {setStatus("เพิ่มหุ้นไม่สำเร็จ: "+e.message);}
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
  btn.disabled=true;btn.textContent="กำลังคัดกรอง…";root.textContent="กำลังคัดกรองหุ้น "+SCREENER_SYMBOLS.length+" ตัว · กรอบเวลา "+(state.timeframe==="4Hour"?"4 ชั่วโมง":"รายวัน");
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
  finally{btn.disabled=false;btn.textContent="คัดกรองอีกครั้ง";}
}
$("#apiUrl").value=state.apiUrl;
$("#refresh").addEventListener("click",loadMarket);
$("#timeframe").value="1Day";
$("#timeframe").disabled=true;
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
  removeSymbol(b.dataset.remove);
});
$("#runScreener").addEventListener("click",runScreener);
$("#screenerResults").addEventListener("click",e=>{const b=e.target.closest("[data-screener-add]");if(b)addSymbol(b.dataset.screenerAdd);});
$("#enableAlerts").addEventListener("click",async()=>{
  if(!("Notification" in window)){setStatus("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");return;}
  const permission=await Notification.requestPermission();
  setStatus(permission==="granted"?"เปิดการแจ้งเตือนแล้ว":"ยังไม่ได้อนุญาตการแจ้งเตือน",permission==="granted");
});
renderIdeas();renderWatchlist();initializeAccount();


/* Live price polling: Alpaca IEX latest trades every 15 seconds during US regular hours. */
setInterval(refreshLiveQuotes,15000);
setInterval(refreshIntradayBars,60000);
setInterval(syncSharedWatchlist,10000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshLiveQuotes();});
