// Deal portal (separate from the dashboard). Local demo only: binds to 127.0.0.1.
//   /inspector  the human home inspector fills in the report and uploads the documents
//   /buyer      final walkthrough + approve closing
//   /seller     approve closing
//   /attorney   cancel and return the deposit (inspection or walkthrough failed)
// The deal agent reads GET /api/inspection/:deal to see whether the inspection is complete.
// Usage: npm run portal  -> http://localhost:3100
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, escrowContract, fmt, provider, txLink, txSigner } from "./config.js";
import { announce } from "./announce.js";
import { CHECK_TYPES } from "./mock-checks.js";
import { SHARED_CSS, SHARED_JS, feed, headerHtml } from "./feed.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { control } from "./control.js";

const PORT = Number(process.env.PORTAL_PORT ?? 3100);
const FILE = path.join(ROOT, "portal-data.json");
const UPLOADS = path.join(ROOT, "uploads");
const STATUS = ["None", "Deposited", "Closed", "Cancelled"];
const ALLOWED = new Set(["pdf", "png", "jpg", "jpeg", "txt", "md"]);
const MAX_BYTES = 8 * 1024 * 1024;

interface Item { ok: boolean; notes: string }
const ROLES = ["inspector", "buyer", "seller", "attorney"];
interface Note { by: string; text: string; at: string }
interface Doc { by: string; name: string; size: number; sha256: string; uploadedAt: string; file: string }
interface Inspection { complete: boolean; passed?: boolean; verification?: "yes" | "no"; inspector?: string; submittedAt?: string; items?: Record<string, Item>; documents: Doc[]; messages: Note[] }
type Store = Record<string, Inspection>;

const load = (): Store => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (s: Store) => fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
const record = (s: Store, deal: string): Inspection => (s[deal] ??= { complete: false, documents: [], messages: [] });
const dealId = (v: string) => (/^\d{1,6}$/.test(v) ? v : "");

const app = express();
app.use(express.json({ limit: "12mb" }));

app.get("/api/inspection/:deal", (req, res) => {
  const r = load()[dealId(req.params.deal)] ?? { complete: false, documents: [], messages: [] };
  // Text documents are included so the agent can read them; PDFs and images are listed with hashes only.
  const documents = r.documents.map((d) => {
    const ext = d.name.split(".").pop()?.toLowerCase();
    const excerpt = ext === "txt" || ext === "md" ? fs.readFileSync(path.join(UPLOADS, d.file), "utf8").slice(0, 6000) : undefined;
    return { ...d, url: `/files/${req.params.deal}/${encodeURIComponent(d.file.split(/[\\/]/).pop()!)}`, excerpt };
  });
  res.json({ ...r, documents });
});

app.post("/api/messages/:deal", (req, res) => {
  const id = dealId(req.params.deal);
  const by = String(req.body?.by ?? "");
  const text = String(req.body?.text ?? "").trim().slice(0, 1500);
  if (!id || !ROLES.includes(by) || !text) return res.status(400).json({ error: "need a role and a message" });
  const store = load();
  record(store, id).messages.push({ by, text, at: new Date().toISOString() });
  save(store);
  res.json({ ok: true });
});

app.post("/api/docs/:deal/upload", (req, res) => {
  const id = dealId(req.params.deal);
  const by = String(req.body?.by ?? "");
  const store = load();
  const r = record(store, id);
  if (!id || !ROLES.includes(by)) return res.status(400).json({ error: "unknown role" });
  if (by === "inspector" && r.complete) return res.status(409).json({ error: "report already submitted" });
  const name = String(req.body?.name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED.has(ext)) return res.status(400).json({ error: `file type .${ext} not allowed (pdf, png, jpg, txt, md)` });
  const data = Buffer.from(String(req.body?.dataBase64 ?? ""), "base64");
  if (!data.length || data.length > MAX_BYTES) return res.status(400).json({ error: "file empty or larger than 8 MB" });
  const dir = path.join(UPLOADS, id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}-${name}`;
  fs.writeFileSync(path.join(dir, stored), data);
  const doc: Doc = {
    by, name, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"),
    uploadedAt: new Date().toISOString(), file: path.join(id, stored),
  };
  r.documents.push(doc);
  save(store);
  res.json({ ok: true, sha256: doc.sha256 });
});

app.post("/api/inspection/:deal", (req, res) => {
  const id = dealId(req.params.deal);
  const store = load();
  const r = record(store, id);
  if (!id || r.complete) return res.status(409).json({ error: "report already submitted" });
  if (!r.documents.some((d) => d.by === "inspector")) return res.status(400).json({ error: "upload at least one inspection document (PDF, photos or notes) first" });
  const items: Record<string, Item> = {};
  for (const t of CHECK_TYPES) {
    const i = req.body?.items?.[t];
    if (!i || typeof i.ok !== "boolean") return res.status(400).json({ error: `missing result for ${t}` });
    items[t] = { ok: i.ok, notes: String(i.notes ?? "").slice(0, 500) };
  }
  const answer = String(req.body?.verification ?? "").trim().toLowerCase();
  const verification = answer === "yes" || answer === "y" ? "yes" : answer === "no" || answer === "n" ? "no" : null;
  if (!verification) return res.status(400).json({ error: 'type "yes" or "no" in the inspection verification box' });
  Object.assign(r, {
    complete: true,
    verification,
    passed: verification === "yes" && Object.values(items).every((i) => i.ok),
    inspector: String(req.body?.inspector ?? "").slice(0, 80) || "Licensed inspector",
    submittedAt: new Date().toISOString(),
    items,
  });
  save(store);
  res.json(r);
});

app.post("/api/inspection/:deal/reset", (req, res) => {
  const store = load();
  delete store[dealId(req.params.deal)];
  save(store);
  res.json({ ok: true });
});

app.get("/files/:deal/:file", (req, res) => {
  const rel = path.join(dealId(req.params.deal), path.basename(req.params.file));
  const doc = load()[dealId(req.params.deal)]?.documents.find((d) => path.normalize(d.file) === path.normalize(rel));
  if (!doc) return res.status(404).end();
  res.setHeader("Content-Disposition", `attachment; filename="${doc.name}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(UPLOADS, doc.file));
});

app.get("/api/deal/:deal", async (req, res) => {
  try {
    const d = await escrowContract(provider()).deals(dealId(req.params.deal) || "0");
    res.json({
      status: STATUS[Number(d.status)], property: d.property, price: fmt(d.price), deposit: fmt(d.deposit),
      inspectionDone: d.inspectionDone, inspectionPassed: d.inspectionPassed,
      walkthroughDone: d.walkthroughDone, walkthroughPassed: d.walkthroughPassed, buyerOk: d.buyerOk, sellerOk: d.sellerOk,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Each party acts with its own demo wallet. The contract enforces every rule on-chain.
const ACTIONS = {
  "walkthrough-ok": "buyer", "walkthrough-issue": "buyer", "buyer-ok": "buyer", "seller-ok": "seller", cancel: "attorney",
} as const;
app.post("/api/action/:deal/:action", async (req, res) => {
  const role = ACTIONS[req.params.action as keyof typeof ACTIONS];
  const id = dealId(req.params.deal);
  if (!role || !id) return res.status(404).json({ error: "unknown action" });
  try {
    const escrow = escrowContract(txSigner(role));
    const text = String(req.body?.text ?? "").slice(0, 200);
    const a = req.params.action;
    const tx = a === "walkthrough-ok" ? await escrow.recordWalkthrough(id, true, text || "satisfied with the home")
      : a === "walkthrough-issue" ? await escrow.recordWalkthrough(id, false, text || "problem found")
      : a === "buyer-ok" ? await escrow.buyerApprove(id)
      : a === "seller-ok" ? await escrow.sellerApprove(id)
      : await escrow.cancel(id, text || "cancelled by attorney");
    const receipt = await tx.wait();
    await announce(escrow, receipt);
    res.json({ ok: true, tx: txLink(tx.hash) });
  } catch (e) {
    txSigner(role).reset(); // a refused tx must not leave the local nonce ahead of the chain
    const err = e as { reason?: string; shortMessage?: string; revert?: { name?: string } };
    res.status(400).json({ error: err.revert?.name ?? err.reason ?? err.shortMessage ?? String(e) });
  }
});

// ---------------- pages ----------------

const STYLE = `<style>
:root{--bg:#0f1420;--card:#1a2133;--ink:#e8ecf5;--mute:#8f9ab3;--ok:#3ecf8e;--bad:#ef6a6a;--acc:#5b8cff;--line:#2a3550}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{padding:18px 24px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:19px}header p{margin:3px 0 0;color:var(--mute)}
main{max-width:760px;margin:0 auto;padding:20px;display:grid;gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
h2{margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
label{display:block;margin:10px 0 4px;color:var(--mute);font-size:13px}input[type=text],textarea{width:100%;background:#141b2b;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px}
.item{border-top:1px solid var(--line);padding:12px 0}.item:first-of-type{border-top:0}.item b{text-transform:capitalize}
.seg{display:inline-flex;gap:6px;margin-left:10px}.seg label{margin:0;padding:3px 12px;border:1px solid var(--line);border-radius:99px;cursor:pointer;color:var(--ink)}
.seg input{display:none}.seg input:checked+span{color:var(--ok);font-weight:700}.seg.f input:checked+span{color:var(--bad)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:14px;margin:4px 6px 4px 0}
button.g{background:#2a8a62}button.r{background:#a94545}button.x{background:#3a4560}button:disabled{opacity:.4;cursor:not-allowed}
.chip{display:inline-block;margin:4px 6px 4px 0;padding:6px 12px;border-radius:99px;border:1px solid var(--line)}.chip.on{border-color:var(--ok);color:var(--ok)}.chip.fail{border-color:var(--bad);color:var(--bad)}
#msg{margin-top:10px;font-size:13px;color:var(--mute);word-break:break-word}a{color:var(--acc)}nav a{margin-right:14px}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mute)}
</style>`;

const head = (title: string, sub: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/shared.css">${STYLE}</head><body>
${headerHtml()}<script src="/shared.js"></script>
<div class="se-sub"><b>${title}</b> &middot; Deal <span id="deal">1</span> &middot; ${sub}</div>`;

const comms = (role: string) => `<section class="card"><h2>Messages &amp; documents</h2>
<p style="color:var(--mute);margin-top:0">Write a message and/or upload documents (PDF, PNG/JPG, TXT/MD). The AI deal agent reads everything posted here before it moves the deal to the next stage.</p>
<textarea id="c-text" rows="3" placeholder="Write a message to the deal agent and the other parties"></textarea>
<button id="c-send">Send message</button> <input type="file" id="c-file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt,.md">
<div id="c-msg" class="mono"></div><div id="c-thread" style="margin-top:12px"></div></section>
<script>(function(){ const ROLE='${role}', dl=new URLSearchParams(location.search).get('deal')||'1', g=id=>document.getElementById(id);
 async function load(){ const r=await (await fetch('/api/inspection/'+dl)).json(); const t=g('c-thread'); t.textContent='';
  const items=[...(r.messages||[]).map(m=>({at:m.at,by:m.by,text:m.text})),...(r.documents||[]).map(d=>({at:d.uploadedAt,by:d.by,doc:d}))].sort((a,b)=>a.at<b.at?-1:1);
  if(!items.length){t.textContent='Nothing posted yet.';return;}
  items.forEach(i=>{ const p=document.createElement('p'); const b=document.createElement('b'); b.textContent=i.by+': '; p.appendChild(b);
   if(i.doc){ const a=document.createElement('a'); a.href=i.doc.url; a.textContent=i.doc.name; p.append('uploaded ',a,' (sha256 '+i.doc.sha256.slice(0,12)+'…)'); } else p.append(document.createTextNode(i.text));
   t.appendChild(p); }); }
 g('c-send').onclick=async()=>{ const x=g('c-text').value.trim(); if(!x) return; const r=await fetch('/api/messages/'+dl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:ROLE,text:x})});
  g('c-msg').textContent=r.ok?'Message sent.':'Failed: '+(await r.json()).error; if(r.ok) g('c-text').value=''; load(); };
 g('c-file').onchange=async()=>{ for(const f of g('c-file').files){ const b=await new Promise(r=>{const x=new FileReader(); x.onload=()=>r(x.result.split(',')[1]); x.readAsDataURL(f);});
  const r=await fetch('/api/docs/'+dl+'/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:ROLE,name:f.name,dataBase64:b})}); const j=await r.json();
  g('c-msg').textContent=r.ok?'Uploaded '+f.name:'Upload failed: '+j.error; } g('c-file').value=''; load(); };
 load(); setInterval(load,4000); })();</script>`;

const DOCS_JS = `
function docsInto(el,docs){ el.textContent=''; if(!docs.length){el.textContent='No documents yet.';return;}
 docs.forEach(d=>{const p=document.createElement('p'); const a=document.createElement('a'); a.href=d.url; a.textContent=d.name; p.append(a,document.createTextNode(' - '+Math.round(d.size/1024)+' KB - sha256 ')); const s=document.createElement('span'); s.className='mono'; s.textContent=d.sha256.slice(0,16)+'…'; p.appendChild(s); el.appendChild(p);}); }
`;

const INSPECTOR = `${head("Home Inspector Portal", "the AI deal agent reads this report and its documents automatically")}
<main>
${comms("inspector")}
<section class="card" id="form"><h2>Inspection report (needs at least one uploaded document)</h2>
<label>Inspector name / licence</label><input type="text" id="who" value="Pat Rivera, NYS Lic. 16000054321">
<div id="items"></div>
<label>Inspection verification: does this home pass inspection? Type yes or no</label><input type="text" id="verify" placeholder="yes or no" autocomplete="off">
<button class="g" id="submit">Mark inspection complete &amp; submit</button><button class="x" id="reset">Reset (demo)</button>
<div id="msg"></div></section>
<section class="card"><h2>Submitted report</h2><div id="done">Not submitted yet.</div></section>
</main>
<script>
const TYPES=${JSON.stringify(CHECK_TYPES)}, deal=new URLSearchParams(location.search).get('deal')||'1', $=id=>document.getElementById(id);
$('deal').textContent=deal; ${DOCS_JS}
$('items').innerHTML=TYPES.map(t=>'<div class="item"><b>'+t+'</b><span class="seg"><label><input type="radio" name="'+t+'" value="1" checked><span>Pass</span></label></span><span class="seg f"><label><input type="radio" name="'+t+'" value="0"><span>Fail</span></label></span><textarea id="n-'+t+'" rows="2" placeholder="Findings / notes"></textarea></div>').join('');
function show(r){ const d=$('done'); d.textContent=''; if(!r.complete){d.textContent='Not submitted yet.'; $('submit').disabled=false; return;}
 const h=document.createElement('p'); h.textContent=(r.passed?'PASSED':'FAILED')+' - '+r.inspector+' - '+new Date(r.submittedAt).toLocaleString(); d.appendChild(h);
 const vp=document.createElement('p'); vp.textContent='Inspector verification: '+(r.verification||'n/a'); d.appendChild(vp);
 for(const [k,v] of Object.entries(r.items)){const p=document.createElement('p'); p.textContent=(v.ok?'[pass] ':'[FAIL] ')+k+(v.notes?': '+v.notes:''); d.appendChild(p);} $('submit').disabled=true; }
async function refresh(){ show(await (await fetch('/api/inspection/'+deal)).json()); }
$('submit').onclick=async()=>{ const items={}; for(const t of TYPES) items[t]={ok:document.querySelector('input[name='+t+']:checked').value==='1',notes:$('n-'+t).value};
 const r=await fetch('/api/inspection/'+deal,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inspector:$('who').value,verification:$('verify').value,items})});
 $('msg').textContent=r.ok?'Submitted. The deal agent will pick this up.':(await r.json()).error; refresh(); };
$('reset').onclick=async()=>{ await fetch('/api/inspection/'+deal+'/reset',{method:'POST'}); $('msg').textContent='Reset.'; refresh(); };
refresh(); setInterval(refresh,4000);
</script></body></html>`;

interface RoleAction { action: string; label: string; cls: string; needsText?: string }
function rolePage(role: string, title: string, sub: string, actions: RoleAction[]) {
  return `${head(title, sub)}
<main>
<section class="card"><h2>Deal status</h2><div id="info">loading...</div><div id="chips"></div></section>
${comms(role)}
<section class="card"><h2>Your actions</h2>
<p style="color:var(--mute);margin-top:0">Each action is a transaction signed by this role&rsquo;s demo wallet. The contract refuses anything out of order.</p>
${actions.some((a) => a.needsText) ? `<label>${actions.find((a) => a.needsText)!.needsText}</label><input type="text" id="text">` : ""}
${actions.map((a) => `<button class="${a.cls}" data-a="${a.action}">${a.label}</button>`).join("")}
<div id="msg"></div></section>
</main>
<script>
const deal=new URLSearchParams(location.search).get('deal')||'1', $=id=>document.getElementById(id); $('deal').textContent=deal; ${DOCS_JS}
const chip=(l,on,f)=>'<span class="chip '+(f?'fail':on?'on':'')+'">'+(f?'✗ ':on?'✓ ':'○ ')+l+'</span>';
async function refresh(){ const d=await (await fetch('/api/deal/'+deal)).json(); if(d.error){$('info').textContent=d.error;return;}
 $('info').textContent=d.property+' | price '+d.price+' | 10% deposit in attorney escrow '+d.deposit+' | '+d.status;
 $('chips').innerHTML=chip('Deposit in escrow',true,false)+chip('Inspection '+(d.inspectionDone?(d.inspectionPassed?'passed':'FAILED'):'pending'),d.inspectionDone&&d.inspectionPassed,d.inspectionDone&&!d.inspectionPassed)
  +chip('Final walkthrough '+(d.walkthroughDone?(d.walkthroughPassed?'passed':'PROBLEM'):'pending'),d.walkthroughDone&&d.walkthroughPassed,d.walkthroughDone&&!d.walkthroughPassed)+chip('Buyer OK',d.buyerOk,false)+chip('Seller OK',d.sellerOk,false); }
document.querySelectorAll('button[data-a]').forEach(b=>b.onclick=async()=>{ b.disabled=true; $('msg').textContent='Sending transaction...';
 const r=await fetch('/api/action/'+deal+'/'+b.dataset.a,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:$('text')?$('text').value:''})}); const j=await r.json();
 $('msg').textContent=r.ok?'Done: '+j.tx:'Not allowed: '+j.error; b.disabled=false; refresh(); });
refresh(); setInterval(refresh,3000);
</script></body></html>`;
}

const PAGES: Record<string, string> = {
  inspector: INSPECTOR,
  buyer: rolePage("buyer", "Buyer Portal", "final walkthrough, then approve closing", [
    { action: "walkthrough-ok", label: "Final walkthrough: I am satisfied", cls: "g", needsText: "Walkthrough notes (optional)" },
    { action: "walkthrough-issue", label: "Final walkthrough: I found a problem", cls: "r" },
    { action: "buyer-ok", label: "Approve closing", cls: "g" },
  ]),
  seller: rolePage("seller", "Seller Portal", "approve closing so the deposit is released to you", [
    { action: "seller-ok", label: "Approve closing", cls: "g" },
  ]),
  attorney: rolePage("attorney", "Seller's Attorney Portal", "holds the escrow account", [
    { action: "cancel", label: "Cancel deal and return deposit to buyer", cls: "r", needsText: "Reason (shown to the parties)" },
  ]),
};
for (const [name, html] of Object.entries(PAGES)) app.get(`/${name}`, (_req, res) => res.type("html").send(html));
app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));
app.get("/__old_index", (_req, res) => res.type("html").send(`${head("SiteEscrow Portal", "pick your role")}<main><section class="card"><h2>Pages</h2>
<p><a href="/inspector">Home inspector</a> &mdash; write the report and upload documents</p><p><a href="/buyer">Buyer</a> &mdash; final walkthrough and approval</p>
<p><a href="/seller">Seller</a> &mdash; approval</p><p><a href="/attorney">Seller's attorney</a> &mdash; escrow holder</p></section></main></body></html>`));

app.get("/api/state", async (_req, res) => {
  try { res.json(await feed()); } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get("/shared.css", (_req, res) => res.type("css").send(SHARED_CSS));
app.get("/shared.js", (_req, res) => res.type("js").send(SHARED_JS));
app.get("/logo.svg", (_req, res) => res.sendFile(path.join(ROOT, "logo.svg")));
app.post("/api/control/:action", async (req, res) => {
  try { res.json(await control(req.params.action)); } catch (e) { res.status(500).json({ ok: false, message: String(e) }); }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`
RealestateTransaction demo is running. Open http://localhost:${PORT}
`);
  for (const [n, p] of [["Dashboard", ""], ["Inspector", "/inspector"], ["Buyer", "/buyer"], ["Seller", "/seller"], ["Attorney", "/attorney"]]) console.log(`  ${n.padEnd(10)} http://localhost:${PORT}${p}`);
});
