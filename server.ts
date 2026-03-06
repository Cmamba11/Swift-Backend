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

// Health Check
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
app.patch('/api/partners/:id', async (req, res) => {
  const idx = state.partners.findIndex(p => p.id === req.params.id);
  if (idx !== -1) {
    state.partners[idx] = { ...state.partners[idx], ...req.body };
    await persistRuntimeChanges();
    res.json(state.partners[idx]);
  } else res.status(404).json({ error: "Partner not found" });
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

// Fix: Added missing /auth/me route
app.get('/api/auth/me', (req, res) => {
  // In this simple setup, we return a generic success if the API is reachable
  // The frontend uses this to check if the session is still valid
  res.json({ ok: true, status: "online" });
});

// --- HYDRATION ---
async function hydrateFromPrisma() {
  if (!prisma) return;
  console.log("🌱 [HYDRATE] Pulling data from Neon...");
  try {
    const [p, a, o, r, u, c, wo, s] = await Promise.all([
      (prisma as any).partner.findMany(),
      (prisma as any).agent.findMany(),
      (prisma as any).order.findMany(),
      (prisma as any).role.findMany(),
      (prisma as any).user.findMany(),
      (prisma as any).callReport.findMany(),
      (prisma as any).workOrder.findMany(),
      (prisma as any).sale.findMany()
    ]);
    
    state.partners = p.map((item: any) => normalizePartner(item));
    state.agents = a || [];
    state.orders = o || [];
    state.roles = r || [];
    state.users = u || [];
    state.calls = c || [];
    state.workOrders = wo || [];
    state.sales = s || [];
    
    await persistRuntimeChanges();
    console.log(`✅ Hydration Complete: ${state.partners.length} partners, ${state.sales.length} sales, ${state.workOrders.length} work orders loaded.`);
  } catch (err: any) { console.error("❌ Hydration Error:", err.message); }
}

// --- STARTUP ---
async function start() {
  if (pgPool) {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS swift_runtime_state (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`);
    const result = await pgPool.query(`SELECT data FROM swift_runtime_state WHERE id = $1`, [STATE_ROW_ID]);
    
    if (result.rows[0]?.data?.partners?.length > 0) {
      console.log("📦 [STATE] Loading existing state from swift_runtime_state");
      Object.assign(state, result.rows[0].data);
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