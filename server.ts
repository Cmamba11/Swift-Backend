import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
// @ts-ignore
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

type Dict = Record<string, any>;
type ApiState = {
  partners: Dict[]; agents: Dict[]; calls: Dict[]; orders: Dict[];
  sales: Dict[]; users: Dict[]; roles: Dict[]; workOrders: Dict[];
  config: Dict;
};

const STATE_ROW_ID = 'main';
// Initialize with empty arrays to prevent .map() crashes
const state: ApiState = {
  partners: [], agents: [], calls: [], orders: [],
  sales: [], users: [], roles: [], workOrders: [],
  config: { 
    recommendedCommissionRate: 10, 
    targetEfficiencyMetric: 'Lead Conversion',
    customerSegmentationAdvice: ['SMB', 'Enterprise'],
    logisticsThreshold: 50,
    lastUpdated: new Date().toISOString() 
  },
};

let prisma: PrismaClient | null = null;
let pgPool: Pool | null = null;

try {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    pgPool = new Pool({ connectionString });
    const adapter = new PrismaPg(pgPool);
    prisma = new PrismaClient({ adapter });
    console.log("✅ Prisma Client Initialized");
  }
} catch (err) { console.error("❌ Database Init Error", err); }

// --- HELPERS ---
const nowIso = () => new Date().toISOString();

function normalizePartner(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    customerId: input.customerId ?? `CUS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    name: input.name ?? 'Unnamed Partner',
    type: input.type ?? 'NEW',
    email: input.email ?? '',
    phone: input.phone ?? '',
    location: input.location ?? '',
    status: input.status ?? 'ACTIVE',
    defaultRatePerKg: Number(input.defaultRatePerKg ?? 0),
    ...input
  };
}

// Ensures every order has an items array so the frontend doesn't crash
function normalizeOrder(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    items: Array.isArray(input.items) ? input.items : [],
    status: input.status ?? 'PENDING',
    orderDate: input.orderDate ?? nowIso(),
    totalValue: Number(input.totalValue ?? 0),
    ...input
  };
}

async function persistRuntimeChanges() {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO swift_runtime_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [STATE_ROW_ID, JSON.stringify(state)]
    );
    console.log("💾 [STATE] Changes persisted");
  } catch (err: any) { console.error('❌ [STATE] Persistence failed:', err.message); }
}

// --- API ROUTES ---
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ONLINE', timestamp: nowIso() }));

// Config
app.get('/api/config', (req, res) => res.json(state.config || {}));
app.patch('/api/config', async (req, res) => {
  state.config = { ...state.config, ...req.body, lastUpdated: nowIso() };
  await persistRuntimeChanges();
  res.json(state.config);
});

// Partners
app.get('/api/partners', (req, res) => res.json(state.partners || []));
app.post('/api/partners', async (req, res) => {
  const partner = normalizePartner(req.body);
  state.partners.push(partner);
  await persistRuntimeChanges();
  res.json(partner);
});

// Data Routes (Safety: Always return an array)
app.get('/api/agents', (req, res) => res.json(state.agents || []));
app.get('/api/orders', (req, res) => res.json(state.orders || []));
app.get('/api/calls', (req, res) => res.json(state.calls || []));
app.get('/api/sales', (req, res) => res.json(state.sales || []));
app.get('/api/users', (req, res) => res.json(state.users || []));
app.get('/api/roles', (req, res) => res.json(state.roles || []));
app.get('/api/work-orders', (req, res) => res.json(state.workOrders || []));

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  const user = state.users.find(u => u.username === username);
  if (user) res.json({ ok: true, user });
  else res.status(401).json({ ok: false, error: "Invalid credentials" });
});

app.get('/api/auth/me', (req, res) => res.json({ ok: true, status: "online" }));

// --- HYDRATION ---
async function hydrateFromPrisma() {
  if (!prisma) return;
  console.log("🌱 [HYDRATE] Pulling data from Neon...");
  try {
    const [p, a, o, r, u, c, wo, s] = await Promise.all([
      (prisma as any).partner.findMany(),
      (prisma as any).agent.findMany(),
      (prisma as any).order.findMany({ include: { items: true } }), // CRITICAL: Include items
      (prisma as any).role.findMany(),
      (prisma as any).user.findMany(),
      (prisma as any).callReport.findMany(),
      (prisma as any).workOrder.findMany(),
      (prisma as any).sale.findMany()
    ]);
    
    state.partners = (p || []).map((item: any) => normalizePartner(item));
    state.agents = a || [];
    state.orders = (o || []).map((item: any) => normalizeOrder(item));
    state.roles = r || [];
    state.users = u || [];
    state.calls = c || [];
    state.workOrders = wo || [];
    state.sales = s || [];
    
    await persistRuntimeChanges();
    console.log(`✅ Hydration Complete: ${state.orders.length} orders loaded with items.`);
  } catch (err: any) { console.error("❌ Hydration Error:", err.message); }
}

// --- STARTUP ---
async function start() {
  if (pgPool) {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS swift_runtime_state (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`);
    const result = await pgPool.query(`SELECT data FROM swift_runtime_state WHERE id = $1`, [STATE_ROW_ID]);
    
    if (result.rows[0]?.data) {
      console.log("📦 [STATE] Loading existing state from swift_runtime_state");
      const savedData = result.rows[0].data;
      // Merge saved data with defaults to ensure no missing keys
      state.partners = savedData.partners || [];
      state.agents = savedData.agents || [];
      state.orders = (savedData.orders || []).map((o: any) => normalizeOrder(o));
      state.sales = savedData.sales || [];
      state.users = savedData.users || [];
      state.roles = savedData.roles || [];
      state.workOrders = savedData.workOrders || [];
      state.calls = savedData.calls || [];
      if (savedData.config) state.config = savedData.config;
    } else {
      await hydrateFromPrisma();
    }
  }

  if (state.roles.length === 0) {
    const adminRole = { id: randomUUID(), name: 'System Administrator', isSystemAdmin: true };
    state.roles.push(adminRole);
    state.users.push({ id: randomUUID(), username: 'admin', name: 'Admin', roleId: adminRole.id });
    await persistRuntimeChanges();
  }

  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 [SWIFT ENGINE] Backend active on port ${PORT}`);
  });
}

start().catch(err => console.error("❌ Boot Error", err));