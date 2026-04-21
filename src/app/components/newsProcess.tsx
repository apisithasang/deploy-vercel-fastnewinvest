import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';

// ============================================================================
//  SYSTEM CONFIGURATION
// ============================================================================
export const revalidate = 600; // Cache หน้าเว็บฝั่ง Server 10 นาที (ประหยัดโควต้า API)

// ============================================================================
//  LOCAL CACHE MEMORY (ป้องกัน API Rate Limit ตอน Develop)
// ============================================================================
const globalForCache = global as unknown as { 
  marketCache: { data: any; lastFetch: number; } | undefined 
};

if (!globalForCache.marketCache) {
  globalForCache.marketCache = { data: null, lastFetch: 0 };
}

// ข้อมูลสำรอง (Fallback) ในกรณีที่ API มีปัญหา
const FALLBACK_DATA = {
    btc: { score: 5, reason: "ระบบ AI ขัดข้อง กำลังพยายามเชื่อมต่อใหม่...", impact: "LOW", keywords: ["#Offline"] },
    gold: { score: 5, reason: "ระบบ AI ขัดข้อง กำลังพยายามเชื่อมต่อใหม่...", impact: "LOW", keywords: ["#Offline"] },
    summary: "ไม่สามารถเชื่อมต่อกับดึงข้อมูลจาก AI ได้ในขณะนี้ โปรดตรวจสอบการเชื่อมต่อ"
};

// ============================================================================
// 1. ฟังก์ชันดึงราคาล่าสุด (Live Prices) - ใช้ Yahoo Finance ทั้งคู่
// ============================================================================
async function getLivePrices() {
    let btcPrice = "N/A";
    let goldPrice = "N/A";

    // 1.1 ดึงราคา BTC จาก Yahoo Finance (BTC-USD)
    try {
        const btcRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD', {
            next: { revalidate: 60 }
        });
        const btcData = await btcRes.json();
        
        const rawBtcPrice = btcData?.chart?.result?.[0]?.meta?.regularMarketPrice;
        
        if (rawBtcPrice) {
            btcPrice = parseFloat(rawBtcPrice).toLocaleString('en-US', { 
                style: 'currency', 
                currency: 'USD',
                maximumFractionDigits: 0 
            });
        }
    } catch (error) {
        console.error("Yahoo BTC Fetch Error:", error);
    }

    // 1.2 ดึงราคา Gold จาก Yahoo Finance (GC=F)
    try {
        const goldRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', {
            next: { revalidate: 60 }
        });
        const goldData = await goldRes.json();
        
        const rawGoldPrice = goldData?.chart?.result?.[0]?.meta?.regularMarketPrice;
        
        if (rawGoldPrice) {
            goldPrice = parseFloat(rawGoldPrice).toLocaleString('en-US', { 
                style: 'currency', 
                currency: 'USD' 
            });
        }
    } catch (error) {
        console.error("Yahoo Gold Fetch Error:", error);
    }

    return { btc: btcPrice, gold: goldPrice };
}

// ============================================================================
// 2. ฟังก์ชันวิเคราะห์ข่าว (AI Sentiment)
// ============================================================================
async function getMarketAnalysis() {
  const CACHE_DURATION = 10 * 60 * 1000;
  const now = Date.now();
  const lastFetch = globalForCache.marketCache?.lastFetch || 0;

  // 1. ตรวจสอบ Cache
  if (globalForCache.marketCache?.data && (now - lastFetch < CACHE_DURATION)) {
    return { ...globalForCache.marketCache.data, isCached: true };
  }

  // 2. ดึงข่าวจาก CNBC
  let newsData = "";
  try {
    const response = await fetch('https://www.cnbc.com/world/?region=world', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error("CNBC Network Error");
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const headlines: string[] = [];
    
    $('.Card-title, .RiverHeadline-title, .LatestNews-headline').each((i, el) => {
      if (headlines.length < 20) { 
        const title = $(el).text().trim();
        if (title) headlines.push(title);
      }
    });
    newsData = headlines.map((t, i) => `${i+1}. ${t}`).join('\n');
  } catch (error) {
    if (globalForCache.marketCache?.data) return { ...globalForCache.marketCache.data, isCached: true };
  }

  if (!newsData) return FALLBACK_DATA;

  // 3. เรียกใช้ Gemini AI
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const ai = new GoogleGenAI({ apiKey: apiKey });

    const assetSchema = {
      type: Type.OBJECT,
      properties: {
        score: { type: Type.INTEGER, description: "1-10" },
        reason: { type: Type.STRING, description: "Short reason in Thai" },
        impact: { type: Type.STRING, description: "Volatility impact: HIGH, MEDIUM, or LOW" },
        keywords: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING }, 
            description: "2-3 short tags related to the news" 
        }
      },
      required: ["score", "reason", "impact", "keywords"]
    };

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        btc: assetSchema,
        gold: assetSchema,
        summary: { type: Type.STRING, description: "1 sentence overall summary" }
      },
      required: ["btc", "gold", "summary"]
    };

    const prompt = `
      Analyze these headlines for market sentiment (Bitcoin & Gold).
      Score 1-10 (1=Bearish, 5=Neutral, 10=Bullish). 
      Assess the impact level (HIGH, MEDIUM, LOW) and extract 2-3 key hashtags.
      Translate reasons and summary to Thai.
      Headlines: \n${newsData}
    `;

    const result = await ai.models.generateContent({
        model: "gemini-2.5-flash", 
        contents: prompt,
        config: {
            temperature: 0.7,
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    });

    const aiData = JSON.parse(result.text || "{}");
    globalForCache.marketCache = { data: aiData, lastFetch: Date.now() };
    return { ...aiData, isCached: false };

  } catch (error) {
    if (globalForCache.marketCache?.data) return { ...globalForCache.marketCache.data, isCached: true };
    return FALLBACK_DATA;
  }
}

// ============================================================================
//  3. HELPER FUNCTIONS FOR UI
// ============================================================================
const getTheme = (score: number) => {
  if (score <= 3) return { color: 'text-red-500', bar: 'bg-red-500', bgGlow: 'hover:shadow-red-900/30', text: 'BEARISH ขาลง' };
  if (score >= 7) return { color: 'text-green-400', bar: 'bg-green-500', bgGlow: 'hover:shadow-green-900/30', text: 'BULLISH ขาขึ้น' };
  return { color: 'text-yellow-400', bar: 'bg-yellow-400', bgGlow: 'hover:shadow-yellow-900/30', text: 'NEUTRAL ทรงตัว' };
};

const getImpactBadge = (impact: string) => {
    const impactUpper = impact?.toUpperCase();
    if (impactUpper === 'HIGH') return <span className="text-sm font-bold bg-red-500/20 text-red-400 border border-red-500/50 px-3 py-1.5 rounded-lg animate-pulse">⚡ HIGH IMPACT</span>;
    if (impactUpper === 'MEDIUM') return <span className="text-sm font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/50 px-3 py-1.5 rounded-lg">⚠️ MED IMPACT</span>;
    return <span className="text-sm font-bold bg-gray-500/20 text-gray-400 border border-gray-500/50 px-3 py-1.5 rounded-lg">📉 LOW IMPACT</span>;
};


// ============================================================================
// 4. MAIN PAGE COMPONENT (UI)
// ============================================================================
export default async function Page() {
  let aiData;
  let isCached = false;
  let prices = { btc: "N/A", gold: "N/A" };
  
  try {
    const [resAnalysis, resPrices] = await Promise.all([
        getMarketAnalysis(),
        getLivePrices()
    ]);
    aiData = resAnalysis || FALLBACK_DATA;
    isCached = aiData?.isCached || false;
    prices = resPrices;
  } catch (e) { 
    aiData = FALLBACK_DATA; 
  }

  // 🔴 เช็คว่าปัจจุบันเป็นข้อมูล Fallback (Error) หรือไม่
  const isError = aiData.summary === FALLBACK_DATA.summary;
  
  // ⏱️ ถ้า Error ให้รีเฟรชทุกๆ 15 วินาที, ถ้าปกติรีเฟรชทุกๆ 10 นาที (600 วิ)
  const refreshInterval = isError ? "15" : "600"; 

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans flex flex-col items-center py-12 selection:bg-indigo-500/30">
      
      {/* 🔄 Dynamic Refresh */}
      <meta httpEquiv="refresh" content={refreshInterval} />
      
      <div className="max-w-6xl w-full px-4 space-y-10">
    
        {/* ================= 1. HEADER TITLE ================= */}
        <div className="flex flex-col items-center text-center space-y-4 mb-2">
            <h1 className="text-5xl md:text-6xl font-black bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent drop-shadow-sm tracking-tight">
                AI MARKET TERMINAL
            </h1>
            
            <div className="flex items-center gap-3 bg-gray-900/60 px-5 py-2 rounded-full border border-gray-800/80 backdrop-blur-md">
                {isError ? (
                    <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
                ) : (
                    <span className={`w-3 h-3 rounded-full ${isCached ? 'bg-gray-600' : 'bg-green-500 animate-ping'}`}></span>
                )}
                
                <p className="text-sm text-gray-400 font-mono tracking-widest uppercase">
                    {isError ? 'SYS: AI OFFLINE' : (isCached ? 'SYS: CACHED DATA' : 'SYS: LIVE SYNC')}
                </p>
            </div>

            {/* 🆕 ปุ่มกด Reload แบบ Manual (จะโชว์เฉพาะตอน AI พัง) */}
            {isError && (
                <a href="/" className="mt-4 inline-flex items-center gap-2 bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20 hover:text-red-300 px-5 py-2 rounded-full transition-all text-sm font-bold tracking-wider">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    RECONNECT AI
                </a>
            )}
        </div>

        {/* ================= 2. SUMMARY BOX ================= */}
        <div className={`p-6 md:p-8 rounded-[2rem] border backdrop-blur-md text-center max-w-6xl mx-auto shadow-2xl transition-colors ${isError ? 'bg-red-950/20 border-red-900/50' : 'bg-gray-900/40 border-gray-800/60'}`}>
            <p className={`text-sm font-bold tracking-[0.2em] mb-4 uppercase ${isError ? 'text-red-400/80' : 'text-indigo-400/80'}`}>Market Overview</p>
            <p className="text-xl md:text-2xl text-gray-200 leading-relaxed font-medium">
                "{aiData.summary}"
            </p>
            {isError && <p className="text-sm text-red-500 mt-4 font-mono animate-pulse">Auto-retrying in 15 seconds...</p>}
        </div>

        {/* ================= 3. ASSET CARDS SECTION ================= */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            
            {[
                { key: 'btc', label: 'Bitcoin', icon: '₿', symbol: 'BTC / USD', price: prices.btc },
                { key: 'gold', label: 'Gold', icon: '🧈', symbol: 'XAU / USD', price: prices.gold }
            ].map((asset) => {
                const assetData = aiData[asset.key as keyof typeof aiData];
                const theme = getTheme(assetData.score);
                
                return (
                    <div key={asset.key} className={`bg-gray-900/60 rounded-[2.5rem] p-10 border border-gray-800 ${theme.bgGlow} hover:border-gray-600 transition-all duration-500 group relative overflow-hidden shadow-2xl backdrop-blur-sm`}>
                        
                        <div className="absolute -top-12 -right-12 text-[15rem] opacity-5 group-hover:opacity-10 transition-opacity duration-700 pointer-events-none">
                            {asset.icon}
                        </div>

                        <div className="flex justify-between items-start mb-8 relative z-10">
                            <div>
                                <h2 className="text-5xl font-black tracking-tight mb-3">{asset.label}</h2>
                                <span className="text-lg text-gray-400 font-mono bg-gray-950 px-4 py-1.5 rounded-xl border border-gray-800">
                                    {asset.symbol}
                                </span>
                            </div>
                            {getImpactBadge(assetData.impact)}
                        </div>

                        <div className="mb-10 bg-black/50 p-6 rounded-[1.5rem] border border-gray-800/80 relative z-10">
                            <p className="text-gray-500 text-xs md:text-sm font-bold tracking-widest mb-2">CURRENT PRICE</p>
                            <p className="text-4xl md:text-[3.5rem] font-mono font-black text-gray-100 tracking-tight leading-none">
                                {asset.price}
                            </p>
                        </div>

                        <div className="flex justify-between items-end mb-6 relative z-10">
                             <div className="flex items-baseline gap-2">
                                <span className={`text-[8rem] md:text-[11rem] font-black ${theme.color} leading-[0.75] tracking-tighter drop-shadow-lg`}>
                                    {assetData.score}
                                </span>
                                <span className="text-gray-600 text-3xl font-bold">/ 10</span>
                            </div>
                            
                            <span className={`text-lg md:text-xl font-bold ${theme.color} bg-gray-950 border-2 border-current px-5 py-2.5 rounded-xl mb-4 shadow-lg`}>
                                {theme.text}
                            </span>
                        </div>

                        <div className="w-full h-4 bg-gray-950 rounded-full mb-8 overflow-hidden border border-gray-800/80 relative z-10 shadow-inner">
                            <div className={`h-full ${theme.bar} transition-all duration-1000 ease-out`} style={{width: `${assetData.score * 10}%`}}></div>
                        </div>

                        <div className="bg-gray-950/60 rounded-2xl p-6 border border-gray-800/80 mb-6 relative z-10 shadow-md">
                            <p className="text-gray-200 text-lg md:text-xl leading-relaxed font-medium">
                                {assetData.reason}
                            </p>
                        </div>

                        <div className="flex flex-wrap gap-3 relative z-10">
                            {assetData.keywords?.map((kw: string, idx: number) => (
                                <span key={idx} className="text-sm font-mono text-gray-300 bg-gray-800/80 px-4 py-2 rounded-xl border border-gray-700 hover:bg-gray-700 hover:text-white transition cursor-default shadow-sm">
                                    {kw}
                                </span>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>

        {/* ================= 4. FOOTER ================= */}
        <div className="flex flex-col md:flex-row justify-between items-center text-xs md:text-sm text-gray-600 font-mono mt-12 border-t border-gray-800/50 pt-8 gap-4 md:gap-0">
            <p>DATA SOURCE: CNBC / YAHOO FINANCE</p>
            <p>INTELLIGENCE: GEMINI 2.5 FLASH</p>
        </div>

      </div>
    </div>
  );
}
