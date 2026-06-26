import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend
} from "recharts";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://fnqbnvijykoicfdkfzxi.supabase.co";
const SUPABASE_KEY = "sb_publishable_tmEqSe4uJMCU5XfvXIZPBQ_WvAINnUq";

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": options.prefer || "return=representation",
      ...(options.headers || {})
    }
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Supabase ${res.status}: ${err}`); }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function loadTransactions() {
  const rows = await sbFetch("transactions?select=*&order=date.desc", { prefer: "return=representation" });
  return rows.map(r => ({ ...r, date: r.date ? new Date(r.date) : null }));
}
async function loadImportedFiles() {
  const rows = await sbFetch("transactions?select=file_name&file_name=not.is.null", { prefer: "return=representation" });
  return [...new Set(rows.map(r => r.file_name).filter(Boolean))];
}
async function upsertTransactions(txns) {
  if (!txns.length) return;
  const rows = txns.map(t => ({
    id: t.id, date: t.date ? t.date.toISOString().split("T")[0] : null,
    description: t.description, amount: t.amount, currency: t.currency || "EUR",
    category: t.category, source: t.source, file_name: t.file_name || null
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await sbFetch("transactions", {
      method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify(rows.slice(i, i + 500))
    });
  }
}
async function updateCategoryInDB(id, category) {
  await sbFetch(`transactions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ category })
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const IT_MONTHS = { "gen":0,"feb":1,"mar":2,"apr":3,"mag":4,"giu":5,"lug":6,"ago":7,"set":8,"ott":9,"nov":10,"dic":11 };

const CATEGORIES = [
  "🍽️ Food & Dining","🛒 Groceries","🚗 Transport","🏠 Housing","💊 Health",
  "🎬 Entertainment","✈️ Travel","👗 Shopping","💼 Business","📱 Subscriptions",
  "💰 Savings / Transfer","🔧 Utilities","🎓 Education","🐾 Pets","❓ Other"
];
const CATEGORY_COLORS = {
  "🍽️ Food & Dining":"#f59e0b","🛒 Groceries":"#10b981","🚗 Transport":"#3b82f6",
  "🏠 Housing":"#8b5cf6","💊 Health":"#ef4444","🎬 Entertainment":"#ec4899",
  "✈️ Travel":"#06b6d4","👗 Shopping":"#f97316","💼 Business":"#6366f1",
  "📱 Subscriptions":"#84cc16","💰 Savings / Transfer":"#14b8a6","🔧 Utilities":"#a78bfa",
  "🎓 Education":"#fbbf24","🐾 Pets":"#fb7185","❓ Other":"#9ca3af"
};

const KEYWORD_MAP = [
  [["restaurant","cafe","coffee","pizza","burger","sushi","dining","mcdonald","kfc","starbucks","nandos","subway","bar","bistro","grill","bakery","kitchen","brunch","caribou","sangiovese","passion food","casinetto","grandiose","jo care","klassix"],"🍽️ Food & Dining"],
  [["carrefour","lulu","spinneys","waitrose","grocery","supermarket","hypermarket","baqala","organic","majid al futtaim","amazon grocery","bateel","gmg"],"🛒 Groceries"],
  [["uber","careem","taxi","metro","bus","petrol","fuel","adnoc","enoc","parking","toll","salik","transport","lyft","bolt"],"🚗 Transport"],
  [["rent","housing","apartment","maintenance","ejari","landlord","water leakage"],"🏠 Housing"],
  [["pharmacy","clinic","hospital","doctor","dentist","health","medical","aster","boots","nmc"],"💊 Health"],
  [["netflix","spotify","cinema","vox","reel","theatre","game","steam","playstation","apple music","entertainment","youtube","disney","hbo","execthread"],"🎬 Entertainment"],
  [["hotel","flight","airline","emirates","flydubai","airbnb","booking","airway","etihad","travel","holiday","resort","china eastern","air"],"✈️ Travel"],
  [["zara","h&m","adidas","nike","noon","fashion","mall","boutique","clothing","shoes","accessories","gmg consumer","digital dubai","area"],"👗 Shopping"],
  [["office","software","aws","google cloud","linkedin","zoom","microsoft","saas","notion","slack","innoventures"],"💼 Business"],
  [["netflix","spotify","apple","amazon prime","icloud","subscription","monthly","annual plan","adobe","canva","dropbox"],"📱 Subscriptions"],
  [["transfer","saving","investment","crypto","fixed saving","deposit","withdrawal","atm","prelievo","al conto di investimento","conversione"],"💰 Savings / Transfer"],
  [["dewa","sewa","addc","electricity","water","internet","du","etisalat","gas","utility","telecom","phone bill","dubai electricity"],"🔧 Utilities"],
  [["school","university","course","udemy","coursera","tuition","book","education","training","certification"],"🎓 Education"],
  [["pet","vet","dog","cat","animal"],"🐾 Pets"],
];

function autoCategory(description) {
  const d = (description || "").toLowerCase();
  for (const [keywords, cat] of KEYWORD_MAP) {
    if (keywords.some(k => d.includes(k))) return cat;
  }
  return "❓ Other";
}

// ─── FX ───────────────────────────────────────────────────────────────────────
const FX = { EUR:1, AED:0.257, USD:0.92, GBP:1.17, CHF:1.04, SGD:0.68, AUD:0.60 };
function toEUR(amount, currency) { return amount * (FX[currency] || 1); }

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function splitCSVLine(line) {
  const result = []; let cur = ""; let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { result.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

// Parse Italian date: "2 gen 2026" → Date
function parseItalianDate(raw) {
  if (!raw) return null;
  const clean = raw.replace(/^"|"$/g,"").trim();
  const m = clean.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (!m) return null;
  const month = IT_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(+m[3], month, +m[1]);
}

// Parse standard ISO / DD/MM/YYYY date
function parseStdDate(raw) {
  if (!raw) return null;
  const clean = raw.replace(/^"|"$/g,"").trim();
  // ISO: 2026-01-09
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return new Date(clean.slice(0,10));
  // DD/MM/YYYY
  const m = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  return null;
}

// Parse European-formatted number: "1.206,74€" or "-1.075,58 AED (-250,78€)" → number + currency
// We always prefer the EUR equivalent in parentheses when present
function parseEuropeanAmount(raw) {
  if (!raw) return { amount: null, currency: "EUR" };
  const clean = raw.replace(/^"|"$/g,"").trim();

  // Try to find EUR amount in parentheses: (-250,78€) or (585,44€)
  const eurInParen = clean.match(/\(([+-]?[\d.,]+)€\)/);
  if (eurInParen) {
    const num = parseFloat(eurInParen[1].replace(/\./g,"").replace(",","."));
    return { amount: isNaN(num) ? null : num, currency: "EUR" };
  }

  // Pure EUR amount: "1.206,74€" or "-844,30€"
  const eurDirect = clean.match(/^([+-]?[\d.,]+)€$/);
  if (eurDirect) {
    const num = parseFloat(eurDirect[1].replace(/\./g,"").replace(",","."));
    return { amount: isNaN(num) ? null : num, currency: "EUR" };
  }

  // AED amount without parens: "-1.743,00" with no currency marker — treat as native
  const plain = clean.match(/^([+-]?[\d.,]+)$/);
  if (plain) {
    const num = parseFloat(plain[1].replace(/\./g,"").replace(",","."));
    return { amount: isNaN(num) ? null : num, currency: null };
  }

  return { amount: null, currency: "EUR" };
}

// ─── REVOLUT PARSER (Italian consolidated statement) ─────────────────────────
// Structure: metadata header blocks, then "Estratti conto delle operazioni" section,
// then per-currency sub-sections each starting with "Conto personale (XYZ)" and
// a transaction table header: Data,Descrizione,Categoria,"Denaro in entrata/uscita",...
function parseRevolutIT(text) {
  const lines = text.split("\n");

  // Must contain the Italian transaction section marker
  if (!text.includes("Estratti conto delle operazioni") && !text.includes("Riepilogo delle transazioni")) return null;

  const rows = [];
  let currentCurrency = "EUR";
  let inTransactionTable = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cols = splitCSVLine(raw);
    const first = (cols[0] || "").replace(/^"|"$/g,"").trim();

    // Detect currency section: "Conto personale (EUR)" etc.
    const currMatch = first.match(/^Conto personale \(([A-Z]+)\)$/);
    if (currMatch) {
      currentCurrency = currMatch[1];
      inTransactionTable = false;
      continue;
    }

    // Detect transaction table header
    if (first === "Data" && cols[1] && cols[1].replace(/^"|"$/g,"").trim() === "Descrizione") {
      inTransactionTable = true;
      continue;
    }

    // End of transaction table
    if (first === "Totale" || first === "---------" || first === "") {
      if (first === "Totale" || first === "---------") inTransactionTable = false;
      continue;
    }

    if (!inTransactionTable) continue;

    // Transaction row: Date, Description, Category, Amount, Balance, ...
    const dateRaw = cols[0] || "";
    const description = (cols[1] || "").replace(/^"|"$/g,"").trim();
    const amountRaw = cols[3] || "";

    const date = parseItalianDate(dateRaw);
    if (!date) continue;
    if (!description) continue;

    const { amount, currency } = parseEuropeanAmount(amountRaw);
    if (amount === null) continue;

    // Skip credits (positive) and currency conversions and investment transfers
    const cat3 = (cols[2] || "").replace(/^"|"$/g,"").trim().toLowerCase();
    if (cat3 === "cambio valuta") continue; // skip FX conversions
    if (amount >= 0) continue; // skip credits

    const finalAmount = currency === "EUR" ? Math.abs(amount) : Math.abs(toEUR(amount, currentCurrency));

    rows.push({
      date,
      description,
      amount: +finalAmount.toFixed(2),
      currency: "EUR",
      source: "Revolut"
    });
  }

  return rows.length ? rows : null;
}

// ─── WIO PARSER ───────────────────────────────────────────────────────────────
// Columns: Account name, Account type, Account IBAN, Account number, Card number,
//          Account currency, Transaction type, Date, Ref. number, Description, Amount, Balance, ...
// Debits have negative Amount. Filter out: Interest credits, Cashback, Salary,
// Savings transfers in/out (Fixed Saving Space rows), Transfers in (positive)
function parseWio(text) {
  const lines = text.split("\n");
  const header = (lines[0] || "").toLowerCase();

  // Detect Wio by its column structure
  if (!header.includes("account name") && !header.includes("transaction type")) return null;

  // Find column indices from header
  const headerCols = splitCSVLine(lines[0]);
  const idx = {};
  headerCols.forEach((h, i) => {
    const k = h.replace(/^"|"$/g,"").trim().toLowerCase();
    idx[k] = i;
  });

  const dateIdx = idx["date"] ?? 7;
  const descIdx = idx["description"] ?? 9;
  const amtIdx  = idx["amount"] ?? 10;
  const typeIdx = idx["transaction type"] ?? 6;
  const currIdx = idx["account currency"] ?? 5;
  const acctTypeIdx = idx["account type"] ?? 1;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 5) continue;

    const acctType = (cols[acctTypeIdx] || "").replace(/^"|"$/g,"").trim().toLowerCase();
    // Skip Fixed Saving Space rows entirely — they are savings movements, not expenses
    if (acctType.includes("saving")) continue;

    const txType = (cols[typeIdx] || "").replace(/^"|"$/g,"").trim().toLowerCase();
    const description = (cols[descIdx] || "").replace(/^"|"$/g,"").trim();
    const amountRaw = (cols[amtIdx] || "").replace(/^"|"$/g,"").trim();
    const currency = (cols[currIdx] || "AED").replace(/^"|"$/g,"").trim();
    const dateRaw = (cols[dateIdx] || "").replace(/^"|"$/g,"").trim();

    const date = parseStdDate(dateRaw);
    if (!date) continue;

    const amount = parseFloat(amountRaw);
    if (isNaN(amount)) continue;

    // Skip income/credits: positive amounts that are interest, cashback, salary, savings returns
    if (amount > 0) continue;

    // Skip internal savings transfers (large round-number transfers to self)
    if (txType === "transfers") {
      const descL = description.toLowerCase();
      // Skip salary credits (already filtered by amount > 0, but belt-and-braces)
      if (descL.includes("salary") || descL.includes("etisalat grp")) continue;
      // Skip fixed saving space movements
      if (descL.includes("fixed saving") || descL.includes("saving space")) continue;
    }

    const finalAmount = +toEUR(Math.abs(amount), currency).toFixed(2);

    rows.push({
      date,
      description,
      amount: finalAmount,
      currency: "EUR",
      source: "Wio"
    });
  }

  return rows.length ? rows : null;
}

// ─── Main parse dispatcher ────────────────────────────────────────────────────
function parseCSV(text) {
  return parseRevolutIT(text) || parseWio(text);
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function ExpenseTracker() {
  const [transactions, setTransactions] = useState([]);
  const [importedFiles, setImportedFiles] = useState([]);
  const [dbStatus, setDbStatus] = useState("loading");
  const [dbError, setDbError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [view, setView] = useState("dashboard");
  const [editingTx, setEditingTx] = useState(null);
  const [filterMonth, setFilterMonth] = useState(null);
  const [filterCat, setFilterCat] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    (async () => {
      try {
        const [txns, files] = await Promise.all([loadTransactions(), loadImportedFiles()]);
        setTransactions(txns); setImportedFiles(files); setDbStatus("ok");
      } catch (e) { setDbStatus("error"); setDbError(e.message); }
    })();
  }, []);

  const ingestFile = useCallback(async (file) => {
    const fileName = file.name;
    if (importedFiles.includes(fileName)) {
      setImportMsg({ type:"warn", text:`"${fileName}" already imported — skipping to avoid duplicates.` });
      setTimeout(()=>setImportMsg(null), 4000); return;
    }
    setImporting(true);
    setImportMsg({ type:"info", text:`Parsing ${fileName}…` });
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const rows = parseCSV(text);
        if (!rows || rows.length === 0) {
          setImportMsg({ type:"error", text:"Could not parse file — check it's a Revolut or Wio CSV export." });
          setImporting(false); setTimeout(()=>setImportMsg(null), 6000); return;
        }
        const newTxns = rows.map((r, i) => ({
          id: `${fileName}-${i}-${r.date?.toISOString()}-${r.amount}-${r.description?.slice(0,10)}`,
          date: r.date, description: r.description, amount: r.amount,
          currency: "EUR", category: autoCategory(r.description),
          source: r.source, file_name: fileName
        }));
        setImportMsg({ type:"info", text:`Saving ${newTxns.length} transactions…` });
        await upsertTransactions(newTxns);
        const [txns, files] = await Promise.all([loadTransactions(), loadImportedFiles()]);
        setTransactions(txns); setImportedFiles(files);
        setImportMsg({ type:"ok", text:`✓ ${newTxns.length} transactions imported from "${fileName}"` });
        setTimeout(()=>setImportMsg(null), 5000);
      } catch (err) {
        setImportMsg({ type:"error", text:`Import failed: ${err.message}` });
        setTimeout(()=>setImportMsg(null), 7000);
      } finally { setImporting(false); }
    };
    reader.readAsText(file);
  }, [importedFiles]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) ingestFile(file);
  }, [ingestFile]);

  const updateCategory = async (id, cat) => {
    setTransactions(prev => prev.map(t => t.id===id ? {...t,category:cat} : t));
    setEditingTx(null);
    try { await updateCategoryInDB(id, cat); } catch(e) { console.error(e); }
  };

  const allMonths = useMemo(() => {
    const set = new Set(transactions.map(t => t.date ? `${t.date.getFullYear()}-${t.date.getMonth()}` : null).filter(Boolean));
    return [...set].sort();
  }, [transactions]);

  const monthlyByCategory = useMemo(() => {
    const map = {};
    for (const t of transactions) {
      if (!t.date) continue;
      const mk = `${t.date.getFullYear()}-${t.date.getMonth()}`;
      const cat = t.category || "❓ Other";
      if (!map[mk]) map[mk] = {};
      map[mk][cat] = (map[mk][cat] || 0) + t.amount;
    }
    return map;
  }, [transactions]);

  const trendData = useMemo(() => allMonths.map(mk => {
    const [y,m] = mk.split("-");
    const row = { month:`${MONTHS[+m]} ${y}` };
    for (const cat of CATEGORIES) row[cat] = +(monthlyByCategory[mk]?.[cat]||0).toFixed(2);
    return row;
  }), [allMonths, monthlyByCategory]);

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
  const summaryMonth = filterMonth || (allMonths.includes(currentMonthKey) ? currentMonthKey : allMonths[allMonths.length-1] || currentMonthKey);
  const monthTotals = monthlyByCategory[summaryMonth] || {};
  const totalSpend = Object.values(monthTotals).reduce((a,b)=>a+b,0);

  const visibleTransactions = useMemo(() => transactions.filter(t => {
    if (!t.date) return false;
    const mk = `${t.date.getFullYear()}-${t.date.getMonth()}`;
    if (filterMonth && mk !== filterMonth) return false;
    if (filterCat && t.category !== filterCat) return false;
    return true;
  }).sort((a,b)=>b.date-a.date), [transactions, filterMonth, filterCat]);

  const activeCategories = useMemo(() => CATEGORIES.filter(c => trendData.some(r=>r[c]>0)), [trendData]);
  const msgColors = { ok:"#10b981", error:"#ef4444", warn:"#f59e0b", info:"#3b82f6" };

  return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",fontFamily:"'DM Mono','Courier New',monospace",color:"#e2e8f0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#111}::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
        .nav-btn{background:none;border:none;cursor:pointer;padding:8px 18px;font-family:inherit;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;transition:all 0.2s}
        .nav-btn.active{color:#f59e0b;border-bottom:2px solid #f59e0b}
        .nav-btn:not(.active){color:#64748b}
        .nav-btn:hover:not(.active){color:#94a3b8}
        .card{background:#111827;border:1px solid #1f2937;border-radius:12px}
        .cat-chip{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;cursor:pointer;border:1px solid transparent;transition:all 0.15s}
        .cat-chip:hover{border-color:#374151}
        .drop-zone{border:2px dashed #374151;border-radius:12px;text-align:center;transition:all 0.2s;cursor:pointer}
        .drop-zone.over{border-color:#f59e0b;background:rgba(245,158,11,0.05)}
        .tx-row{border-bottom:1px solid #1f2937;padding:12px 0;display:flex;align-items:center;gap:12px;transition:background 0.1s}
        .tx-row:hover{background:#111827;border-radius:8px;padding-left:8px;padding-right:8px}
        .btn{padding:6px 14px;border-radius:6px;border:none;cursor:pointer;font-family:inherit;font-size:11px;letter-spacing:0.1em;text-transform:uppercase}
        .btn-gold{background:#f59e0b;color:#000;font-weight:500}
        .btn-ghost{background:#1f2937;color:#94a3b8}
        .btn-ghost:hover{background:#374151}
        .btn:disabled{opacity:0.5;cursor:not-allowed}
        select{background:#1f2937;border:1px solid #374151;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-family:inherit;font-size:12px;outline:none}
        .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;display:flex;align-items:center;justify-content:center}
        .modal{background:#111827;border:1px solid #374151;border-radius:16px;padding:28px;width:340px;max-height:80vh;overflow-y:auto}
        .source-badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:500}
        .src-revolut{background:#191970;color:#818cf8}
        .src-wio{background:#0d2b1f;color:#34d399}
        .progress-bar{height:4px;border-radius:2px;background:#1f2937;overflow:hidden;margin-top:6px}
        .progress-fill{height:100%;border-radius:2px;transition:width 0.6s ease}
        .number-big{font-family:'Syne',sans-serif;font-size:28px;font-weight:800}
        .pulse{animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        .db-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
      `}</style>

      {/* Header */}
      <div style={{borderBottom:"1px solid #1f2937",padding:"0 24px"}}>
        <div style={{maxWidth:1100,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",height:60}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18,color:"#f59e0b"}}>₠</span>
            <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:16}}>EXPENSE<span style={{color:"#f59e0b"}}>LENS</span></span>
            <span style={{display:"flex",alignItems:"center",fontSize:10,color:"#4b5563",marginLeft:8}}>
              <span className={`db-dot ${dbStatus==="loading"?"pulse":""}`}
                style={{background:dbStatus==="ok"?"#10b981":dbStatus==="error"?"#ef4444":"#f59e0b"}}/>
              {dbStatus==="loading"?"connecting…":dbStatus==="ok"?"supabase connected":"db error"}
            </span>
          </div>
          <nav style={{display:"flex",gap:4}}>
            {[["dashboard","Dashboard"],["trends","Trends"],["list","Transactions"]].map(([k,l])=>(
              <button key={k} className={`nav-btn ${view===k?"active":""}`} onClick={()=>setView(k)}>{l}</button>
            ))}
          </nav>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {importedFiles.length>0 && (
              <button className="btn btn-ghost" onClick={()=>setShowFiles(v=>!v)}>📂 {importedFiles.length}</button>
            )}
            <button className="btn btn-gold" disabled={importing} onClick={()=>fileRef.current.click()}>
              {importing?"Importing…":"+ Import CSV"}
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}}
            onChange={e=>{if(e.target.files[0])ingestFile(e.target.files[0]);e.target.value="";}}/>
        </div>
      </div>

      {importMsg && (
        <div style={{background:`${msgColors[importMsg.type]}18`,borderBottom:`1px solid ${msgColors[importMsg.type]}44`,
          padding:"10px 28px",fontSize:12,color:msgColors[importMsg.type],textAlign:"center"}}>
          {importMsg.text}
        </div>
      )}
      {dbStatus==="error" && (
        <div style={{background:"#ef444418",borderBottom:"1px solid #ef444444",padding:"10px 28px",fontSize:12,color:"#ef4444",textAlign:"center"}}>
          ⚠️ Database error: {dbError}
        </div>
      )}

      <div style={{maxWidth:1100,margin:"0 auto",padding:"28px 24px"}}>

        {showFiles && (
          <div className="card" style={{padding:"16px 20px",marginBottom:20}}>
            <div style={{fontSize:12,color:"#64748b",marginBottom:10,letterSpacing:"0.1em",textTransform:"uppercase"}}>Imported Files</div>
            {importedFiles.map(f=>(
              <div key={f} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"1px solid #1f2937",fontSize:12}}>
                <span style={{color:"#10b981"}}>✓</span>
                <span style={{flex:1}}>{f}</span>
                <span style={{fontSize:10,color:"#4b5563"}}>already in DB</span>
              </div>
            ))}
          </div>
        )}

        {/* Drop zone */}
        <div className={`drop-zone ${dragOver?"over":""}`}
          style={{marginBottom:28,display:"flex",alignItems:"center",justifyContent:"center",gap:16,padding:"20px 40px"}}
          onDragOver={e=>{e.preventDefault();setDragOver(true)}}
          onDragLeave={()=>setDragOver(false)} onDrop={onDrop} onClick={()=>fileRef.current.click()}>
          <span style={{fontSize:28}}>📂</span>
          <div>
            <div style={{fontSize:13,color:"#94a3b8"}}>Drop your <span style={{color:"#818cf8"}}>Revolut</span> or <span style={{color:"#34d399"}}>Wio</span> CSV export here</div>
            <div style={{fontSize:11,color:"#4b5563",marginTop:4}}>Revolut Italian consolidated · Wio monthly statement · Duplicates blocked</div>
          </div>
        </div>

        {dbStatus==="loading" && (
          <div style={{textAlign:"center",padding:"60px 0",color:"#4b5563",fontSize:13}}>
            <div className="pulse">Connecting to database…</div>
          </div>
        )}

        {dbStatus==="ok" && transactions.length===0 && (
          <div style={{textAlign:"center",padding:"60px 0",color:"#4b5563"}}>
            <div style={{fontSize:40,marginBottom:12}}>📊</div>
            <div style={{fontSize:14,marginBottom:6}}>No transactions yet</div>
            <div style={{fontSize:12}}>Import your Revolut or Wio CSV above</div>
          </div>
        )}

        {/* DASHBOARD */}
        {view==="dashboard" && dbStatus==="ok" && transactions.length>0 && (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
              <span style={{fontSize:11,color:"#64748b",letterSpacing:"0.1em",textTransform:"uppercase"}}>Month</span>
              <select value={summaryMonth} onChange={e=>setFilterMonth(e.target.value)}>
                {allMonths.map(mk=>{const[y,m]=mk.split("-");return<option key={mk} value={mk}>{MONTHS[+m]} {y}</option>;})}
              </select>
              <span style={{marginLeft:"auto",fontSize:12,color:"#64748b"}}>{transactions.length} transactions in database</span>
            </div>
            <div className="card" style={{padding:"20px 24px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:11,color:"#64748b",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>Total Spend</div>
                <div className="number-big">€{totalSpend.toLocaleString("en",{maximumFractionDigits:0})}</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <div className="source-badge src-revolut">Revolut</div>
                <div className="source-badge src-wio">Wio</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
              {CATEGORIES.filter(c=>monthTotals[c]>0).sort((a,b)=>monthTotals[b]-monthTotals[a]).map(cat=>{
                const amt=monthTotals[cat]||0;
                const pct=totalSpend>0?(amt/totalSpend*100):0;
                const col=CATEGORY_COLORS[cat];
                return(
                  <div key={cat} className="card" style={{padding:"16px 18px",cursor:"pointer"}}
                    onClick={()=>{setFilterCat(filterCat===cat?null:cat);setView("list");}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <span style={{fontSize:13}}>{cat}</span>
                      <span style={{fontSize:14,fontWeight:500,color:col}}>€{amt.toLocaleString("en",{maximumFractionDigits:0})}</span>
                    </div>
                    <div className="progress-bar"><div className="progress-fill" style={{width:`${pct}%`,background:col}}/></div>
                    <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>{pct.toFixed(1)}% of total</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TRENDS */}
        {view==="trends" && dbStatus==="ok" && transactions.length>0 && (
          <div>
            <div style={{marginBottom:24}}>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,marginBottom:4}}>Spending Trends</div>
              <div style={{fontSize:12,color:"#64748b"}}>Monthly evolution per category · EUR</div>
            </div>
            {activeCategories.map(cat=>(
              <div key={cat} className="card" style={{padding:"20px 24px",marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <span style={{fontSize:14}}>{cat}</span>
                  <span style={{fontSize:12,color:"#64748b"}}>avg €{(trendData.reduce((s,r)=>s+r[cat],0)/Math.max(trendData.length,1)).toFixed(0)}/mo</span>
                </div>
                <ResponsiveContainer width="100%" height={90}>
                  <LineChart data={trendData} margin={{top:0,right:0,left:0,bottom:0}}>
                    <XAxis dataKey="month" tick={{fontSize:10,fill:"#4b5563"}} axisLine={false} tickLine={false}/>
                    <YAxis hide/>
                    <Tooltip contentStyle={{background:"#1f2937",border:"1px solid #374151",borderRadius:8,fontSize:11}}
                      labelStyle={{color:"#94a3b8"}} formatter={v=>[`€${v}`,""]}/>
                    <Line type="monotone" dataKey={cat} stroke={CATEGORY_COLORS[cat]} strokeWidth={2}
                      dot={{r:3,fill:CATEGORY_COLORS[cat]}} activeDot={{r:5}}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ))}
            <div className="card" style={{padding:"20px 24px",marginTop:24}}>
              <div style={{fontSize:14,marginBottom:16}}>All Categories Overview</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={trendData} margin={{top:0,right:0,left:0,bottom:0}}>
                  <XAxis dataKey="month" tick={{fontSize:10,fill:"#4b5563"}} axisLine={false} tickLine={false}/>
                  <YAxis tick={{fontSize:10,fill:"#4b5563"}} axisLine={false} tickLine={false} tickFormatter={v=>`€${v}`}/>
                  <Tooltip contentStyle={{background:"#1f2937",border:"1px solid #374151",borderRadius:8,fontSize:11}} formatter={v=>[`€${v}`,""]}/>
                  <Legend wrapperStyle={{fontSize:11,paddingTop:12}}/>
                  {activeCategories.map(cat=>(
                    <Bar key={cat} dataKey={cat} stackId="a" fill={CATEGORY_COLORS[cat]}/>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* TRANSACTIONS */}
        {view==="list" && dbStatus==="ok" && transactions.length>0 && (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800}}>Transactions</div>
              <select value={filterMonth||""} onChange={e=>setFilterMonth(e.target.value||null)} style={{marginLeft:"auto"}}>
                <option value="">All months</option>
                {allMonths.map(mk=>{const[y,m]=mk.split("-");return<option key={mk} value={mk}>{MONTHS[+m]} {y}</option>;})}
              </select>
              <select value={filterCat||""} onChange={e=>setFilterCat(e.target.value||null)}>
                <option value="">All categories</option>
                {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              {(filterMonth||filterCat)&&<button className="btn btn-ghost" onClick={()=>{setFilterMonth(null);setFilterCat(null);}}>Clear</button>}
            </div>
            <div style={{fontSize:11,color:"#64748b",marginBottom:12}}>
              {visibleTransactions.length} transactions · €{visibleTransactions.reduce((s,t)=>s+t.amount,0).toLocaleString("en",{maximumFractionDigits:0})} total
            </div>
            {visibleTransactions.map(t=>(
              <div key={t.id} className="tx-row">
                <div style={{width:80,fontSize:11,color:"#4b5563",flexShrink:0}}>
                  {t.date?`${t.date.getDate()} ${MONTHS[t.date.getMonth()]}`:"—"}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.description}</div>
                  <div style={{marginTop:3,display:"flex",gap:6,alignItems:"center"}}>
                    <span className={`source-badge ${t.source==="Revolut"?"src-revolut":"src-wio"}`}>{t.source}</span>
                    <span className="cat-chip"
                      style={{background:`${CATEGORY_COLORS[t.category]}22`,color:CATEGORY_COLORS[t.category]}}
                      onClick={()=>setEditingTx(t)}>{t.category} ✎</span>
                  </div>
                </div>
                <div style={{fontSize:15,fontWeight:500,flexShrink:0}}>
                  €{t.amount.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editingTx && (
        <div className="modal-bg" onClick={()=>setEditingTx(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,marginBottom:4}}>{editingTx.description}</div>
            <div style={{fontSize:11,color:"#64748b",marginBottom:20}}>€{editingTx.amount} · Select category · saved to DB</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {CATEGORIES.map(cat=>(
                <button key={cat} onClick={()=>updateCategory(editingTx.id,cat)}
                  style={{
                    background:editingTx.category===cat?`${CATEGORY_COLORS[cat]}22`:"#1f2937",
                    border:editingTx.category===cat?`1px solid ${CATEGORY_COLORS[cat]}`:"1px solid #374151",
                    color:editingTx.category===cat?CATEGORY_COLORS[cat]:"#94a3b8",
                    borderRadius:8,padding:"10px 14px",cursor:"pointer",textAlign:"left",
                    fontFamily:"inherit",fontSize:13,transition:"all 0.15s"
                  }}>{cat}</button>
              ))}
            </div>
            <button className="btn btn-ghost" style={{marginTop:16,width:"100%"}} onClick={()=>setEditingTx(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
