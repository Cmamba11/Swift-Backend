/**
 * SWIFT PLASTICS - BACKEND ENGINE (Full Unified Version)
 * Includes: Auth, Partners, Roles, State Persistence, and Prisma Mirroring.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
// @ts-ignore
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. TYPES & STATE ---
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

// --- 2. DATABASE INIT ---
let prisma: PrismaClient | null = null;
let pgPool: Pool | null = null;

try {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    pgPool = new Pool({ connectionString });
    const adapter = new PrismaPg(pgPool);
    prisma = new PrismaClient({ adapter });
  }
} catch (err) { console.error("❌ Database Init Error", err); }

// --- 3. HELPER FUNCTIONS ---

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

function normalizeRole(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'Untitled Role',
    description: input.description ?? '',
    isSystemAdmin: Boolean(input.isSystemAdmin ?? false),
    canViewPartners: Boolean(input.canViewPartners ?? false),
    canEditPartners: Boolean(input.canEditPartners ?? false),
    canManageRoles: Boolean(input.canManageRoles ?? false),
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
  } catch (err: any) {
    console.error('❌ [STATE] Persistence failed:', err.message);
  }
}

// --- 4. API ROUTES ---
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());


// 👇 ADD THIS LINE HERE
app.get('/api/health', (req, res) => res.json({ status: 'ONLINE', timestamp: new Date().toISOString() }));

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  const user = state.users.find(u => u.username === username);
  if (user) res.json({ ok: true, user });
  else res.status(401).json({ ok: false, error: "Invalid credentials" });
});

app.get('/api/auth/me', (req, res) => res.json({ ok: true, status: "online" }));

// Partners
app.get('/api/partners', (req, res) => res.json(state.partners));
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

// Roles
app.get('/api/roles', (req, res) => res.json(state.roles));
app.patch('/api/roles/:id', async (req, res) => {
  const idx = state.roles.findIndex(r => r.id === req.params.id);
  if (idx !== -1) {
    state.roles[idx] = { ...state.roles[idx], ...req.body };
    await persistRuntimeChanges();
    res.json(state.roles[idx]);
  } else res.status(404).json({ error: "Role not found" });
});

// Other Data Routes
app.get('/api/agents', (req, res) => res.json(state.agents));
app.get('/api/calls', (req, res) => res.json(state.calls));
app.get('/api/orders', (req, res) => res.json(state.orders));
app.get('/api/sales', (req, res) => res.json(state.sales));
app.get('/api/users', (req, res) => res.json(state.users));
app.get('/api/work-orders', (req, res) => res.json(state.workOrders));
app.get('/api/config', (req, res) => res.json(state.config));

// --- 5. SEEDER & START ---
async function start() {
  if (pgPool) {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS swift_runtime_state (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`);
    const result = await pgPool.query(`SELECT data FROM swift_runtime_state WHERE id = $1`, [STATE_ROW_ID]);
    if (result.rows[0]) Object.assign(state, result.rows[0].data);
  }

  // Seed Admin if empty
  if (state.roles.length === 0) {
    const adminRole = normalizeRole({ name: 'System Administrator', isSystemAdmin: true, canEditPartners: true, canManageRoles: true });
    state.roles.push(adminRole);
    state.users.push({ id: randomUUID(), username: 'admin', name: 'Chief Administrator', roleId: adminRole.id });
    await persistRuntimeChanges();
  }

  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 [SWIFT ENGINE] Backend active on port ${PORT}`);
  });
}

start().catch(err => console.error("❌ Boot Error", err));