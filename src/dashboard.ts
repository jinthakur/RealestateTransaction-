// The dashboard page (served at "/" by src/portal.ts). Live from XRPL EVM Testnet.
import { headerHtml } from "./feed.js";

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RealestateTransaction - Dashboard</title>
<link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/shared.css">
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
h2{margin:0 0 12px;font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.flow{display:grid;grid-template-columns:1fr auto 1.2fr auto 1fr;gap:10px;align-items:center}
.node{border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center;background:#141b2b}
.node b{display:block;font-size:13px;color:var(--mute);font-weight:600}.node .v{font-size:20px;font-weight:700;margin-top:2px}
.node small{color:var(--mute);word-break:break-all;font-size:11px}.escrow{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
.arrow{color:var(--acc);font-size:12px;text-align:center;min-width:110px}.arrow i{display:block;font-style:normal;font-size:26px;animation:pulse 1.6s infinite}
@keyframes pulse{50%{transform:translateX(5px);opacity:.5}}
.checks{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:12px}
.chip{border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center;background:#141b2b}
.chip.on{border-color:var(--ok);color:var(--ok)}.chip.fail{border-color:var(--bad);color:var(--bad)}.chip span{display:block;font-size:12px;color:var(--mute)}
.badge{padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700}
.Deposited{background:#3a2f12;color:var(--warn)}.Closed{background:#12372a;color:var(--ok)}.Cancelled{background:#3a1d1d;color:var(--bad)}
ol.steps{margin:0;padding-left:20px}ol.steps li{margin:6px 0}ol.steps em{color:var(--acc);font-style:normal}
.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:13px}
.row:first-child{border-top:0}a{color:var(--acc)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mute)}
.who{font-weight:700}.Buyer{color:#7fb0ff}.Seller{color:#6fe0a8}.Attorney{color:#ffcf70}.Inspector{color:#d9a6ff}.Agent{color:#ff9fb6}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;margin:3px 6px 3px 0}
button.g{background:#2a8a62}button.r{background:#a94545}button.x{background:#3a4560}button:disabled{opacity:.5;cursor:wait}
pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
@media(max-width:760px){.flow{grid-template-columns:1fr}.arrow i{transform:rotate(90deg)}.checks{grid-template-columns:1fr 1fr}}
</style></head><body>
${headerHtml()}
<script src="/shared.js"></script>
<main>
<section class="card"><h2>Run the demo from here <span class="mono" id="at" style="float:right"></span></h2>
<div>
 <button data-c="services-start">1. Start check services</button>
 <button data-c="agent-start" class="g">2. Start deal agent</button>
 <button data-c="agent-stop" class="x">Stop agent</button>
 <button data-c="new-deal" class="r">New deal (deploy + 10% deposit)</button>
 <button data-c="reset" class="x">Reset portal data</button>
</div>
<div class="mono" id="ctl-msg" style="margin-top:8px">Mode: <span id="ctl-mode">...</span></div>
<ol class="steps" style="margin-top:12px">
<li><em>Inspector</em> &mdash; open <a href="/inspector">the inspector page</a>, upload a document, write a message, submit the report. The agent reads it.</li>
<li><em>Wait for &ldquo;inspection passed&rdquo;</em> below (the agent confirms the deposit, pays for checks, records the result).</li>
<li><em>Buyer</em> &mdash; <a href="/buyer">buyer page</a>: &ldquo;Final walkthrough: I am satisfied&rdquo;.</li>
<li><em>Seller</em> &mdash; <a href="/seller">seller page</a>: &ldquo;Approve closing&rdquo;.</li>
<li><em>Buyer</em> &mdash; &ldquo;Approve closing&rdquo;. The deal closes and the deposit goes to the seller.</li>
<li><em>Failure path</em> &mdash; submit a report with a failed item; then use <a href="/attorney">the attorney page</a> to cancel and return the deposit.</li>
</ol></section>

<section class="card"><h2>1. How the money flows</h2>
<div class="flow">
 <div class="node"><b>BUYER</b><div class="v" id="b-buyer">-</div><small id="a-buyer"></small></div>
 <div class="arrow"><i>&rarr;</i>10% deposit<br>on signing</div>
 <div class="node escrow"><b>SELLER&rsquo;S ATTORNEY ESCROW</b><div class="v" id="b-escrow">-</div><small id="a-escrow"></small></div>
 <div class="arrow"><i>&rarr;</i>released only when inspection +<br>walkthrough passed and<br>buyer + seller approve</div>
 <div class="node"><b>SELLER</b><div class="v" id="b-seller">-</div><small id="a-seller"></small></div>
</div>
<div class="flow" style="margin-top:14px;grid-template-columns:1fr auto 1fr">
 <div class="node"><b>AI DEAL AGENT (Amazon Bedrock)</b><div class="v" id="b-inspector">-</div><small>verifies the deposit, reads the report, pays for checks, records pass/fail</small></div>
 <div class="arrow"><i>&rarr;</i>pays per check<br>(AP4M RLUSD or XRP)</div>
 <div class="node"><b>PAID INSPECTION SERVICE</b><div class="v" id="b-checkService">-</div><small>structure &middot; roof &middot; systems &middot; pests</small></div>
</div></section>

<section class="card"><h2>2. How the deal works</h2>
<ol class="steps">
<li><em>Sign &amp; deposit</em> &mdash; the buyer signs and 10% of the price goes into the seller&rsquo;s attorney escrow. The seller cannot touch it yet.</li>
<li><em>Inspect</em> &mdash; a human inspector writes the report and uploads documents. The AI agent confirms the deposit, reads the report and every message, buys 4 cross-checks, and records PASSED or FAILED.</li>
<li><em>Final walkthrough</em> &mdash; the buyer walks through the home one last time and records the result.</li>
<li><em>Both say OK</em> &mdash; the buyer and the seller each approve.</li>
<li><em>Closed</em> &mdash; the moment both have approved, the deposit is paid to the seller.</li>
<li><em>Inspection or walkthrough failed?</em> &mdash; the attorney cancels and the buyer gets the full deposit back.</li>
</ol></section>

<section class="card"><h2>3. Live deal</h2><div id="deals">loading&hellip;</div></section>
<section class="card"><h2>4. Deal agent activity</h2><div id="agent">The deal agent has not started. Press &ldquo;Start deal agent&rdquo; above.</div></section>
<section class="card"><h2>5. Messages <button id="replay" style="float:right">Replay balloons</button></h2><div id="events">loading&hellip;</div></section>
</main>
<script>
const $=id=>document.getElementById(id), short=a=>a.slice(0,8)+'…'+a.slice(-6), n=x=>(+x).toFixed(3)+' XRP';
function chip(label,on,fail,sub){return '<div class="chip '+(fail?'fail':on?'on':'')+'">'+(fail?'&#10007; ':on?'&#10003; ':'&#9675; ')+label+'<span>'+sub+'</span></div>';}
document.querySelectorAll('button[data-c]').forEach(b=>b.onclick=async()=>{
 if(b.dataset.c==='new-deal'&&!confirm('Deploy a fresh escrow and deposit 10% (0.5 XRP of testnet XRP) from the buyer wallet?')) return;
 b.disabled=true; $('ctl-msg').textContent='Working...';
 try{ const r=await fetch('/api/control/'+b.dataset.c,{method:'POST'}); const j=await r.json(); const pre=document.createElement('pre'); pre.textContent=j.message; $('ctl-msg').textContent=''; $('ctl-msg').appendChild(pre); }
 catch(e){ $('ctl-msg').textContent='Failed: '+e.message; } b.disabled=false; });
$('replay').onclick=()=>SE.replay();
SE.onState((s,err)=>{
 if(!s){ $('at').textContent='· '+err; return; }
 $('at').textContent='· updated '+new Date(s.at).toLocaleTimeString();
 $('ctl-mode').textContent='agent='+s.control.agentMode+' | payments='+s.control.payments;
 for(const r of ['buyer','inspector','checkService','seller']){ $('b-'+r).textContent=n(s.balances[r]); if($('a-'+r)) $('a-'+r).innerHTML='<a href="'+s.explorer+'/address/'+s.addrs[r]+'" target="_blank">'+short(s.addrs[r])+'</a>'; }
 $('b-escrow').textContent=n(s.escrowBalance);
 $('a-escrow').innerHTML='<a href="'+s.explorer+'/address/'+s.escrow+'" target="_blank">'+short(s.escrow)+'</a>';
 $('deals').innerHTML=s.deals.map(d=>'<div style="margin-bottom:16px"><div class="row" style="border:0"><b>Deal '+d.id+': '+d.property+'</b><span><span class="badge '+d.status+'">'+d.status+'</span></span></div>'
  +'<div class="mono" style="margin-bottom:8px">price '+n(d.price)+' &middot; 10% deposit in attorney escrow '+n(d.deposit)+'</div>'
  +'<div class="checks">'+chip('Deposit in escrow',true,false,n(d.deposit))
  +chip('Home inspection',d.inspectionDone&&d.inspectionPassed,d.inspectionDone&&!d.inspectionPassed,d.inspectionDone?(d.inspectionPassed?'passed':'FAILED'):'pending')
  +chip('Final walkthrough',d.walkthroughDone&&d.walkthroughPassed,d.walkthroughDone&&!d.walkthroughPassed,d.walkthroughDone?(d.walkthroughPassed?'passed':'problem'):'pending')
  +chip('Buyer OK',d.buyerOk,false,d.buyerOk?'approved':'waiting')
  +chip('Seller OK',d.sellerOk,false,d.sellerOk?'approved':'waiting')+'</div>'
  +(d.status==='Closed'?'<p class="Seller who">Deal closed: the deposit was paid to the seller.</p>':d.status==='Cancelled'?'<p class="Attorney who">Deal cancelled: the deposit was returned to the buyer.</p>':'')+'</div>').join('')||'No deal yet.';
 $('events').innerHTML=s.events.slice().reverse().map(e=>'<div style="margin-bottom:12px"><div class="row" style="border:0"><b>Deal '+e.dealId+' &middot; '+e.name+'</b><a href="'+e.tx+'" target="_blank">tx &#8599;</a></div>'
  +e.messages.map(m=>'<div class="row"><span><span class="who '+m.from+'">'+m.from+' → '+m.to+'</span> &mdash; <b>'+m.headline+'</b><br><span style="color:var(--mute)">'+m.text+'</span></span></div>').join('')+'</div>').join('')||'No messages yet.';
 const a=$('agent'); a.textContent='';
 if(s.agentLog.length){
  s.agentLog.slice().reverse().forEach(l=>{ const r=document.createElement('div'); r.className='row';
   const w=document.createElement('span'); const k=document.createElement('b'); k.textContent=(l.kind==='tool'?'ACTION ':l.kind==='result'?'RESULT ':l.kind==='done'?'DONE ':l.kind==='message'?'MESSAGE ':'THINKING ');
   k.style.color=l.kind==='done'?'var(--ok)':l.kind==='tool'?'var(--acc)':'var(--mute)'; w.append(k,document.createTextNode(l.kind==='message'&&l.message?l.message.from+' → '+l.message.to+': '+l.message.headline+' — '+l.message.text:l.text));
   const t=document.createElement('span'); t.className='mono'; t.textContent=new Date(l.at).toLocaleTimeString(); r.append(w,t); a.appendChild(r); });
 } else { a.textContent=s.control.agentRunning?'The agent is starting...':'The deal agent has not started. Press "Start deal agent" above.'; }
 if(!s.control.agentRunning&&s.control.agentTail){ const p=document.createElement('pre'); p.className='mono'; p.textContent='Last agent output:\\n'+s.control.agentTail; a.appendChild(p); }
});
</script></body></html>`;
