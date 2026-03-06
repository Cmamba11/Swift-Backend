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
  config: { recommendedCommissionRate: 10, lastUpdated: new Date().toISOString() },
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
    console.log("💾 [STATE] Changes persisted to swift_runtime_state");
  } catch (err: any) { console.error('❌ [STATE] Persistence failed:', err.message); }
}

// --- API ROUTES ---
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ONLINE', timestamp: nowIso(), dataCounts: {
  partners: state.partners.length,
  orders: state.orders.length,
  agents: state.agents.length
}}));

// --- DATA ROUTES (Partners, Agents, etc.) ---
app.get('/api/partners', (req, res) => res.json(state.partners));
app.get('/api/agents', (req, res) => res.json(state.agents));
app.get('/api/orders', (req, res) => res.json(state.orders));
app.get('/api/calls', (req, res) => res.json(state.calls));
app.get('/api/sales', (req, res) => res.json(state.sales));
app.get('/api/users', (req, res) => res.json(state.users));
app.get('/api/roles', (req, res) => res.json(state.roles));

// --- AUTH ---
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  const user = state.users.find(u => u.username === username);
  if (user) res.json({ ok: true, user });
  else res.status(401).json({ ok: false, error: "Invalid credentials" });
});

// --- HYDRATION LOGIC ---
async function hydrateFromPrisma() {
  if (!prisma) {
    console.error("❌ Cannot hydrate: Prisma not connected");
    return;
  }
  
  console.log("🌱 [HYDRATE] Pulling all data from Neon/Prisma tables...");
  
  try {
    // Partners
    const p = await (prisma as any).partner.findMany();
    state.partners = p.map((item: any) => normalizePartner(item));
    console.log(`✅ Loaded ${state.partners.length} partners`);

    // Agents
    state.agents = await (prisma as any).agent.findMany();
    console.log(`✅ Loaded ${state.agents.length} agents`);

    // Orders
    state.orders = await (prisma as any).order.findMany();
    console.log(`✅ Loaded ${state.orders.length} orders`);

    // Roles
    state.roles = await (prisma as any).role.findMany();
    console.log(`✅ Loaded ${state.roles.length} roles`);

    // Users
    state.users = await (prisma as any).user.findMany();
    console.log(`✅ Loaded ${state.users.length} users`);

    // Calls
    state.calls = await (prisma as any).callReport.findMany();
    console.log(`✅ Loaded ${state.calls.length} calls`);

    await persistRuntimeChanges();
  } catch (err: any) {
    console.error("❌ [HYDRATE] Error during data pull:", err.message);
  }
}

// --- STARTUP ---
async function start() {
  if (pgPool) {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS swift_runtime_state (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`);
    const result = await pgPool.query(`SELECT data FROM swift_runtime_state WHERE id = $1`, [STATE_ROW_ID]);
    
    // If the state table is empty OR has no partners, try to hydrate from Prisma
    const hasData = result.rows[0]?.data?.partners?.length > 0;
    
    if (hasData) {
      console.log("📦 [STATE] Loading existing state from swift_runtime_state");
      Object.assign(state, result.rows[0].data);
    } else {
      await hydrateFromPrisma();
    }
  }

  // Final check for Admin
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