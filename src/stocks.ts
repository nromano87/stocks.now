// The league's stock list: the 71 Coinbase tokenized stocks on Base that had
// supply (total_supply > 0) in the first week of November 2026, read from
// Coinbase's tokenized-stock API. Fixed before the first trade; changing it is a rule change.
// ticker = the underlying US listing. token = the symbol on Base.
// h24 = the token has a real trading pool on Base, so the stock trades 24/7 at
// the token's price there. The rest trade at the exchange price while the US
// market is open.

export interface Stock { ticker: string; token: string; name: string; contract: string; h24?: boolean; about?: string; logo?: boolean }

export const STOCKS: Stock[] = [
  { ticker: "AAOI", token: "AAOIc", name: "Applied Optoelectronics Inc", contract: "0xb200000000000000000000cf36D05963A3E2205c" },
  { ticker: "AAPL", token: "AAPLc", name: "Apple Inc.", contract: "0xb200000000000000000000C2e324d24d7eEcd1fb" },
  { ticker: "AMC", token: "AMCc", name: "AMC Entertainment Holdings, Inc.", contract: "0xB200000000000000000000CD7e6b8042cb7c2BB5" },
  { ticker: "AMD", token: "AMDc", name: "Advanced Micro Devices, Inc.", contract: "0xB2000000000000000000000d8Ce462E99ee7A47B" },
  { ticker: "AMZN", token: "AMZNc", name: "Amazon.com Inc.", contract: "0xb200000000000000000000d9192b6B456483C2E8" },
  { ticker: "APP", token: "APPc", name: "AppLovin Corporation", contract: "0xb20000000000000000000006f910a0e7BBD3c168" },
  { ticker: "ARM", token: "ARMc", name: "Arm Holdings plc", contract: "0xB20000000000000000000026215D755356E5043f" },
  { ticker: "ASTS", token: "ASTSc", name: "AST SpaceMobile, Inc.", contract: "0xB200000000000000000000B1a29cF17A1819288a" },
  { ticker: "AVGO", token: "AVGOc", name: "Broadcom Inc.", contract: "0xB200000000000000000000Fc737aeA6196aB5a4c" },
  { ticker: "BE", token: "BEc", name: "Bloom Energy Corporation", contract: "0xb20000000000000000000016f9dfe862feBA122b" },
  { ticker: "BIDU", token: "BIDUc", name: "Baidu, Inc.", contract: "0xb200000000000000000000d2b7D9aeE52F6C6BEf" },
  { ticker: "BILI", token: "BILIc", name: "Bilibili Inc.", contract: "0xb200000000000000000000ca7C6D1438e7245eb6" },
  { ticker: "BIRD", token: "BIRDc", name: "Smartbird, Inc.", contract: "0xB200000000000000000000535fE96f18204BFD96" },
  { ticker: "BMNR", token: "BMNRc", name: "BitMine Immersion Technologies, Inc.", contract: "0xB200000000000000000000eA2df44A307CaB279C" },
  { ticker: "BUD", token: "BUDc", name: "Anheuser-Busch InBev SA/NV", contract: "0xB200000000000000000000c36ce081Dd09e86cA2" },
  { ticker: "CAKE", token: "CAKEc", name: "Cheesecake Factory Inc", contract: "0xb200000000000000000000f215E4C890CFb7176B" },
  { ticker: "CBRS", token: "CBRSc", name: "Cerebras Systems Inc.", contract: "0xb200000000000000000000720133EeDF525f93E2" },
  { ticker: "CRCL", token: "CRCLc", name: "Circle Internet Group Inc.", contract: "0xB20000000000000000000019f6E7C675b73C2e4D" },
  { ticker: "CRWV", token: "CRWVc", name: "CoreWeave, Inc.", contract: "0xB200000000000000000000F111184A74720787E6" },
  { ticker: "DJT", token: "DJTc", name: "Trump Media & Technology Group Corp.", contract: "0xb200000000000000000000428E3a3eebBb20692B" },
  { ticker: "DUOL", token: "DUOLc", name: "Duolingo, Inc.", contract: "0xb200000000000000000000A613D12dEAfBBb1Db7" },
  { ticker: "GME", token: "GMEc", name: "GameStop Corp.", contract: "0xb2000000000000000000007790ed6E48e06eD935" },
  { ticker: "GOOGL", token: "GOOGLc", name: "Alphabet Inc.", contract: "0xb2000000000000000000002D0BA3164cc74f58B7" },
  { ticker: "HIMS", token: "HIMSc", name: "Hims & Hers Health, Inc.", contract: "0xB20000000000000000000043a599976181Bcf336" },
  { ticker: "HSAI", token: "HSAIc", name: "Hesai Group", contract: "0xb200000000000000000000f3049F4aa834b23b64" },
  { ticker: "HTZ", token: "HTZc", name: "Hertz Global Holdings, Inc.", contract: "0xb2000000000000000000002601C5C94F435da168" },
  { ticker: "INFY", token: "INFYc", name: "Infosys Limited", contract: "0xb200000000000000000000F6b0417af5F52341FC" },
  { ticker: "INTC", token: "INTCc", name: "Intel Corporation", contract: "0xB2000000000000000000004AFF16039bA04bdFBc" },
  { ticker: "LITE", token: "LITEc", name: "Lumentum Holdings Inc", contract: "0xB200000000000000000000eDA6C2c6F11E0F838f" },
  { ticker: "LI", token: "LIc", name: "Li Auto Inc.", contract: "0xb200000000000000000000D61eFD9F54A23ef9eB" },
  { ticker: "LLY", token: "LLYc", name: "Eli Lilly & Co", contract: "0xB200000000000000000000f1a0F91e34892E4718" },
  { ticker: "META", token: "METAc", name: "Meta Platforms Inc.", contract: "0xb2000000000000000000008bC8786B856E61707C" },
  { ticker: "MRNA", token: "MRNAc", name: "Moderna, Inc.", contract: "0xB200000000000000000000e215e9B76ecBA02468" },
  { ticker: "MRVL", token: "MRVLc", name: "Marvell Technology, Inc.", contract: "0xB200000000000000000000eC3c4c7395Cc609813" },
  { ticker: "MSFT", token: "MSFTc", name: "Microsoft Corporation", contract: "0xB200000000000000000000Ab99cFa739E253872B" },
  { ticker: "MSTR", token: "MSTRc", name: "Strategy Inc.", contract: "0xb2000000000000000000004884b426556b92883d" },
  { ticker: "MU", token: "MUc", name: "Micron Technology Inc.", contract: "0xb200000000000000000000Fd2f87532B90095211" },
  { ticker: "NFLX", token: "NFLXc", name: "Netflix Inc", contract: "0xb20000000000000000000058B8c947e44011dFE6" },
  { ticker: "NIO", token: "NIOc", name: "NIO Inc.", contract: "0xb2000000000000000000002D2B5dc53c61f1bA06" },
  { ticker: "NOK", token: "NOKc", name: "Nokia Corporation", contract: "0xB2000000000000000000005ac674f707E357409c" },
  { ticker: "NVAX", token: "NVAXc", name: "Novavax Inc", contract: "0xB200000000000000000000C597c476FCf9Aed3a8" },
  { ticker: "NVDA", token: "NVDAc", name: "NVIDIA Corporation", contract: "0xb20000000000000000000078ee7ce2fE4908108C" },
  { ticker: "NVO", token: "NVOc", name: "Novo Nordisk A/S", contract: "0xb2000000000000000000008D5328e9208773dC58" },
  { ticker: "ORCL", token: "ORCLc", name: "Oracle Corporation", contract: "0xb200000000000000000000347AFbA223D7B6b63C" },
  { ticker: "PDD", token: "PDDc", name: "PDD Holdings Inc.", contract: "0xB200000000000000000000c8A7223510467D8563" },
  { ticker: "PFE", token: "PFEc", name: "Pfizer Inc", contract: "0xB20000000000000000000018FE7eC7d6DfeeB528" },
  { ticker: "PLTR", token: "PLTRc", name: "Palantir Technologies Inc.", contract: "0xb2000000000000000000007d16372840dF4dAbbe" },
  { ticker: "PM", token: "PMc", name: "Philip Morris International Inc.", contract: "0xB2000000000000000000008FC2A8C23cf5937b66" },
  { ticker: "PTON", token: "PTONc", name: "Peloton Interactive, Inc.", contract: "0xB2000000000000000000009272A491812842Aa84" },
  { ticker: "PYPL", token: "PYPLc", name: "PayPal Holdings, Inc.", contract: "0xb200000000000000000000450ad3abE5d4846c6E" },
  { ticker: "QUBT", token: "QUBTc", name: "Quantum Computing Inc.", contract: "0xb200000000000000000000CA425ab42e07C35bC3" },
  { ticker: "RBLX", token: "RBLXc", name: "Roblox Corporation", contract: "0xB2000000000000000000005bd7AE89b9E6189Bb5" },
  { ticker: "RDDT", token: "RDDTc", name: "Reddit, Inc.", contract: "0xb20000000000000000000066242d4067724cB7A1" },
  { ticker: "RIVN", token: "RIVNc", name: "Rivian Automotive, Inc.", contract: "0xB2000000000000000000003e4249C65bd6c037d9" },
  { ticker: "RKLB", token: "RKLBc", name: "Rocket Lab Corporation", contract: "0xb200000000000000000000e8E50CBbb9a3861a3C" },
  { ticker: "SAN", token: "SANc", name: "Banco Santander, S.A.", contract: "0xB20000000000000000000017BB66E9301E913A99" },
  { ticker: "SAP", token: "SAPc", name: "SAP SE", contract: "0xb200000000000000000000da6F64c306234127E0" },
  { ticker: "SE", token: "SEc", name: "Sea Limited", contract: "0xB2000000000000000000003088798F6d0722AaAC" },
  { ticker: "SKHY", token: "SKHYc", name: "SK hynix Inc.", contract: "0xb200000000000000000000187f7071D6E321a7d2" },
  { ticker: "SNDK", token: "SNDKc", name: "Sandisk Corporation", contract: "0xb200000000000000000000397293Cb8cda9a10c5" },
  { ticker: "SONY", token: "SONYc", name: "Sony Group Corporation", contract: "0xb200000000000000000000a26326a922FFA87f6C" },
  { ticker: "SOUN", token: "SOUNc", name: "SoundHound AI, Inc.", contract: "0xB2000000000000000000002137743D4a01Fe4e88" },
  { ticker: "SPCX", token: "SPCXc", name: "Space Exploration Technologies Corp.", contract: "0xb2000000000000000000007b9fcbd005511aCBd5" },
  { ticker: "TSLA", token: "TSLAc", name: "Tesla Inc.", contract: "0xb2000000000000000000001e800a7f5189430cD0" },
  { ticker: "TTWO", token: "TTWOc", name: "Take-Two Interactive Software, Inc.", contract: "0xB200000000000000000000f720C26062Bc3067Da" },
  { ticker: "UL", token: "ULc", name: "Unilever Plc", contract: "0xB200000000000000000000349ef3Aa93a0897476" },
  { ticker: "UNH", token: "UNHc", name: "UnitedHealth Group Incorporated", contract: "0xb200000000000000000000c367d37d07150182A2" },
  { ticker: "VALE", token: "VALEc", name: "Vale S.A.", contract: "0xB20000000000000000000063376b142C0764B489" },
  { ticker: "WDC", token: "WDCc", name: "Western Digital Corporation", contract: "0xb2000000000000000000008fde21a1F5c69FeC0b" },
  { ticker: "WEN", token: "WENc", name: "Wendy's Co", contract: "0xB20000000000000000000044E3CD7a0E1028E57a" },
  { ticker: "WRD", token: "WRDc", name: "WeRide Inc.", contract: "0xb200000000000000000000e88EFe88D8aDE3f0dA" },
];

// The tokens with a real USDC pool on Base: on 8 November 2026 each pool held at
// least $25,000 (read on chain) and priced the token within 10% of the stock's
// Friday close. 28 at launch; 18 more added that evening, before any citizen had
// entered. The other 25 have no pool, a pool of a few hundred dollars, or one that
// prices them as much as 4 times off. Changing this list is a rule change: a
// stock's kind of price never switches on its own.
export const H24 = [
  "AAOI", "AAPL", "AMD", "AMZN", "AVGO", "BE", "CRCL", "CRWV", "GOOGL", "HIMS", "INTC", "LITE", "LLY", "META",
  "MRNA", "MRVL", "MSFT", "MSTR", "MU", "NFLX", "NVDA", "ORCL", "PLTR", "SKHY", "SNDK", "SPCX", "TSLA", "TTWO",
  "ARM", "BIDU", "BILI", "BUD", "HSAI", "INFY", "LI", "NIO", "NOK", "NVO", "PDD", "SAN", "SAP", "SE", "SONY", "UL", "VALE", "WRD",
];
for (const s of STOCKS) if (H24.includes(s.ticker)) s.h24 = true;

/**
 * The 18 24/7 stocks added on 8 November, priced from the second Slipstream factory's
 * pools. Initially held about $45K-$65K each; many have since drained below the $25K
 * liquidity threshold and now fall back to exchange pricing (live during US hours,
 * last close otherwise). Real-token payouts value them at a 30-minute average rather
 * than the price of one moment, so a push on one pool can't win a payout.
 */
export const THIN_POOLS: readonly string[] = [
  "ARM", "BIDU", "BILI", "BUD", "HSAI", "INFY", "LI", "NIO", "NOK", "NVO", "PDD", "SAN", "SAP", "SE", "SONY", "UL", "VALE", "WRD",
];

// What each company does, in a few words, for people who don't know the ticker.
export const ABOUT: Record<string, string> = {
  AAOI: "Fiber-optic parts for data centers", AAPL: "iPhone, Mac and services", AMC: "Movie theaters",
  AMD: "Chips for PCs, servers and AI", AMZN: "Online shopping and AWS cloud", APP: "Ads for mobile apps",
  ARM: "The chip designs inside most phones", ASTS: "Satellites that talk to ordinary phones", AVGO: "Chips and networking for AI data centers",
  BE: "Fuel cells that power data centers", BIDU: "China's search engine and AI", BILI: "Chinese video platform",
  BMNR: "Holds ether as its treasury", BUD: "Budweiser's brewer", CAKE: "Restaurant chain",
  CBRS: "Wafer-sized AI chips", CRCL: "Issues the USDC stablecoin", CRWV: "Cloud computing for AI",
  DJT: "Owns Truth Social", DUOL: "Language-learning app", GME: "Video game stores",
  GOOGL: "Google search, YouTube and cloud", HIMS: "Online health care", HSAI: "Lidar sensors for cars and robots",
  HTZ: "Car rental", INFY: "IT services from India", INTC: "PC and server chips, and chip factories",
  LITE: "Lasers and optics for networks", LI: "Chinese electric cars", LLY: "Drugmaker behind Mounjaro and Zepbound",
  META: "Facebook, Instagram and WhatsApp", MRNA: "mRNA vaccines and medicines", MRVL: "Chips for data centers and networks",
  MSFT: "Windows, Office and Azure cloud", MSTR: "Holds bitcoin as its treasury", MU: "Memory chips",
  NFLX: "Streaming", NIO: "Chinese electric cars", NOK: "Network equipment",
  NVAX: "Vaccines", NVDA: "The GPUs that train AI", NVO: "Drugmaker behind Ozempic and Wegovy",
  ORCL: "Databases and cloud", PDD: "Temu and Pinduoduo", PFE: "Drugmaker",
  PLTR: "Data and AI software", PM: "Cigarettes and smoke-free nicotine", PTON: "Connected exercise bikes",
  PYPL: "PayPal and Venmo payments", QUBT: "Quantum computing", RBLX: "Online game platform",
  RDDT: "Online communities", RIVN: "Electric trucks and SUVs", RKLB: "Rockets and spacecraft",
  SAN: "Spanish bank", SAP: "Business software", SE: "Shopping, games and payments in Southeast Asia",
  SKHY: "Memory chips for AI", SNDK: "Flash storage", SONY: "PlayStation, music, film and camera sensors",
  SOUN: "Voice AI", SPCX: "SpaceX: rockets and Starlink", TSLA: "Electric cars, batteries and robots",
  TTWO: "Video games, including GTA", UL: "Household brands like Dove", UNH: "Health insurance",
  VALE: "Iron ore mining", WDC: "Hard drives", WEN: "Burger chain", WRD: "Self-driving robotaxis",
};
// Logos: Coinbase's icons for its tokenized stocks, saved in public/logos. BIRD and CBRS have none.
const NO_LOGO = ["BIRD", "CBRS"];
for (const s of STOCKS) { s.about = ABOUT[s.ticker]; s.logo = !NO_LOGO.includes(s.ticker); }

export const BY_TICKER: Record<string, Stock> = Object.fromEntries(STOCKS.map((s) => [s.ticker, s]));
