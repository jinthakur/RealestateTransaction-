// Shared by every screen: live chain feed, top menu (logo + role pages) and message balloons.
import fs from "node:fs";
import { ethers } from "ethers";
import { AGENT_LOG, EXPLORER, PORTAL_URL, ROLE_INDEX, Role, escrowContract, loadDeployment, provider, wallet } from "./config.js";
import { type DealEvent, messagesFor } from "./messages.js";
import { controlStatus } from "./control.js";

const STATUS = ["None", "Deposited", "Closed", "Cancelled"];
const xrp = (wei: bigint) => `${ethers.formatEther(wei)} XRP`;
const NAMES = ["DealOpened", "InspectionRecorded", "WalkthroughRecorded", "BuyerApproved", "SellerApproved", "DealClosed", "DealCancelled"];

export async function feed() {
  const p = provider();
  const dep = loadDeployment();
  const escrow = escrowContract(p);
  const addrs = Object.fromEntries((Object.keys(ROLE_INDEX) as Role[]).map((r) => [r, wallet(r).address]));
  const balances: Record<string, string> = {};
  for (const [r, a] of Object.entries(addrs)) balances[r] = ethers.formatEther(await p.getBalance(a));
  const escrowBalance = ethers.formatEther(await p.getBalance(dep.escrow));

  const deals = [];
  for (let id = 1; id <= 10; id++) {
    const d = await escrow.deals(id);
    if (Number(d.status) === 0) break;
    deals.push({
      id, property: d.property, price: ethers.formatEther(d.price), deposit: ethers.formatEther(d.deposit),
      status: STATUS[Number(d.status)], inspectionDone: d.inspectionDone, inspectionPassed: d.inspectionPassed,
      walkthroughDone: d.walkthroughDone, walkthroughPassed: d.walkthroughPassed, buyerOk: d.buyerOk, sellerOk: d.sellerOk,
    });
  }

  // Replay the chain events in order so each message knows what had already happened.
  const latest = await p.getBlockNumber();
  const from = Math.max(0, latest - Number(process.env.LOG_LOOKBACK ?? 2_000));
  const logs: { name: string; args: any; tx: string; block: number; index: number }[] = [];
  for (const name of NAMES) {
    try {
      for (const log of await escrow.queryFilter(escrow.filters[name](), from, latest)) {
        logs.push({ name, args: (log as unknown as { args: any }).args, tx: log.transactionHash, block: log.blockNumber, index: log.index });
      }
    } catch { /* RPC log-range limits: show what we can */ }
  }
  logs.sort((a, b) => a.block - b.block || a.index - b.index);

  const flags = new Map<string, { buyerOk: boolean; sellerOk: boolean; property: string; deposit: string }>();
  const events = logs.map((l) => {
    const id = l.args[0].toString();
    const f = flags.get(id) ?? { buyerOk: false, sellerOk: false, property: "", deposit: "" };
    const e: DealEvent = { name: l.name as DealEvent["name"], dealId: id, property: f.property, deposit: f.deposit };
    if (l.name === "DealOpened") { f.property = l.args.property; e.property = f.property; f.deposit = xrp(l.args.deposit); e.price = xrp(l.args.price); e.deposit = xrp(l.args.deposit); }
    if (l.name === "InspectionRecorded") { e.passed = l.args.passed; e.evidence = l.args.evidence; }
    if (l.name === "WalkthroughRecorded") { e.passed = l.args.passed; e.evidence = l.args.notes; }
    if (l.name === "BuyerApproved") { f.buyerOk = true; e.otherOk = f.sellerOk; }
    if (l.name === "SellerApproved") { f.sellerOk = true; e.otherOk = f.buyerOk; }
    if (l.name === "DealClosed" || l.name === "DealCancelled") { e.amount = xrp(l.args.amount); if (l.name === "DealCancelled") e.reason = l.args.reason; }
    flags.set(id, f);
    return { key: `${dep.escrow}:${l.tx}:${l.index}`, name: l.name, dealId: id, tx: `${EXPLORER}/tx/${l.tx}`, block: l.block, messages: messagesFor(e) };
  });

  let agentLog: unknown[] = [];
  try {
    agentLog = fs.readFileSync(AGENT_LOG, "utf8").trim().split("\n").slice(-40).map((l) => JSON.parse(l));
  } catch { /* the deal agent has not run yet */ }

  return { escrow: dep.escrow, escrowBalance, addrs, balances, deals, events, agentLog, control: controlStatus(), portal: PORTAL_URL, explorer: EXPLORER, at: new Date().toISOString() };
}

const PAGES = [
  { id: "dashboard", label: "Dashboard", path: "/" },
  { id: "inspector", label: "Inspector", path: "/inspector" },
  { id: "buyer", label: "Buyer", path: "/buyer" },
  { id: "seller", label: "Seller", path: "/seller" },
  { id: "attorney", label: "Attorney", path: "/attorney" },
];

/** Top bar: logo, role pages with their URLs, live agent status. */
export const headerHtml = () => `<div class="se-head"><a class="se-brand" href="/"><img src="/logo.svg" alt="logo"><span>RealestateTransaction<small>AI-run home purchase escrow</small></span></a>
<nav class="se-nav">${PAGES.map((p) => `<a href="${p.path}"><b>${p.label}</b><small>${p.path}</small></a>`).join("")}</nav>
<div class="se-pill" id="se-pill">agent: ...</div></div>`;

export const SHARED_CSS = `
:root{--bg:#0f1420;--card:#1a2133;--ink:#e8ecf5;--mute:#8f9ab3;--ok:#3ecf8e;--warn:#f5b84b;--bad:#ef6a6a;--acc:#5b8cff;--line:#2a3550}
body{overflow-x:hidden}
.se-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 16px;background:#0b101b;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:40}
.se-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:700}
.se-brand img{width:38px;height:38px;border-radius:9px}.se-brand span{display:flex;flex-direction:column;line-height:1.15;font-size:15px}
.se-brand small{font-weight:400;color:var(--mute);font-size:11px}
.se-nav{display:flex;flex-wrap:wrap;gap:6px;flex:1}
.se-nav a{display:flex;flex-direction:column;padding:4px 9px;border:1px solid var(--line);border-radius:9px;text-decoration:none;color:var(--ink);background:#141b2b}
.se-nav a b{font-size:13px}.se-nav a small{font-size:10px;color:var(--mute);font-family:ui-monospace,Consolas,monospace}
.se-nav a:hover{border-color:var(--acc)}.se-nav a.on{border-color:var(--acc);background:#1c2a4d}
.se-pill{font:12px ui-monospace,Consolas,monospace;color:var(--mute);border:1px solid var(--line);border-radius:99px;padding:5px 12px}.se-pill.on{color:var(--ok);border-color:var(--ok)}
.se-sub{padding:12px 24px 0;color:var(--mute);max-width:1100px;margin:0 auto}.se-sub b{color:var(--ink)}
#sky{position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden}
.balloon{position:absolute;bottom:-340px;width:290px;max-width:84vw;padding:14px 16px 16px;border-radius:14px;color:#10151f;box-shadow:0 10px 28px #000a;pointer-events:auto;cursor:pointer;
 animation:float var(--dur,16s) ease-in forwards;font-family:system-ui,Segoe UI,sans-serif}
.balloon::after{content:"";position:absolute;left:50%;bottom:-24px;width:2px;height:26px;background:#ffffff88}
.balloon::before{content:"";position:absolute;left:calc(50% - 7px);bottom:-8px;width:14px;height:14px;background:inherit;transform:rotate(45deg);border-radius:2px}
.balloon h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.8}
.balloon b{display:block;font-size:15px;line-height:1.25;margin-bottom:6px}.balloon p{margin:0;font-size:13px;line-height:1.4}
.balloon.Buyer{background:#a9c8ff}.balloon.Seller{background:#8ff0bf}.balloon.Attorney{background:#ffdc8f}.balloon.Inspector{background:#e0b8ff}.balloon.Agent{background:#ffb8c8}
.balloon.bad{outline:3px solid var(--bad)}.balloon.good{outline:3px solid #fff}
@keyframes float{0%{transform:translateY(0) rotate(-2deg);opacity:0}8%{opacity:1}50%{transform:translateY(-52vh) translateX(18px) rotate(2deg);opacity:1}88%{opacity:1}
 100%{transform:translateY(-118vh) translateX(-14px) rotate(-2deg);opacity:0}}
`;

/** Loaded on every screen: polls the feed, pops message balloons, fills the menu and agent pill. */
export const SHARED_JS = `(function(){
 const SE=window.SE={cbs:[],last:null,onState(cb){this.cbs.push(cb); if(this.last) cb(this.last);}};
 const here=location.pathname.replace(/\\/$/,'')||'/';
 document.querySelectorAll('.se-nav a').forEach(a=>{ const p=a.getAttribute('href'); const s=a.querySelector('small'); if(s) s.textContent=location.host+p; if(p===here) a.classList.add('on'); });
 const sky=document.createElement('div'); sky.id='sky'; document.body.appendChild(sky);
 const seen=new Set(); let first=true;
 function balloon(m,delay){ setTimeout(()=>{
  const b=document.createElement('div'); b.className='balloon '+m.from+' '+m.tone;
  b.style.left=(8+Math.random()*Math.max(10,innerWidth-330))+'px'; b.style.setProperty('--dur',(15+Math.random()*4)+'s');
  const h=document.createElement('h4'); h.textContent='From '+m.from+' → To '+m.to;
  const t=document.createElement('b'); t.textContent=m.headline;
  const p=document.createElement('p'); p.textContent=m.text;
  b.append(h,t,p); b.onclick=()=>b.remove(); b.addEventListener('animationend',()=>b.remove()); sky.appendChild(b); },delay); }
 SE.balloon=balloon; SE.pop=ev=>ev.messages.forEach((m,i)=>balloon(m,i*700));
 SE.replay=()=>{ if(SE.last) SE.last.events.slice(-3).forEach((e,i)=>setTimeout(()=>SE.pop(e),i*2500)); };
 function pill(c){ const el=document.getElementById('se-pill'); if(!el||!c) return; el.textContent='agent: '+(c.agentRunning?'running':'stopped')+'  |  checks: '+(c.servicesRunning?'running':'stopped'); el.className='se-pill'+(c.agentRunning?' on':''); }
 async function tick(){ try{
   const s=await (await fetch('/api/state')).json(); if(s.error) throw new Error(s.error);
   SE.last=s; pill(s.control);
   s.agentLog.filter(l=>l.kind==='message'&&l.message).forEach(l=>{ const k='agent:'+l.at+l.text; if(seen.has(k)) return; seen.add(k); if(!first) balloon(Object.assign({subject:l.text},l.message),0); });
   const fresh=s.events.filter(e=>!seen.has(e.key)); fresh.forEach(e=>seen.add(e.key)); if(!first) fresh.forEach(SE.pop);
   first=false; SE.cbs.forEach(cb=>cb(s));
  }catch(e){ SE.cbs.forEach(cb=>cb(null,e.message)); } }
 tick(); setInterval(tick,3000);
})();`;
