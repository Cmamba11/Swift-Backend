/**
 * SWIFT PLASTICS - BACKEND ENGINE (Frontend Compatibility API)
 */
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
type ApprovalType = 'ADMIN' | 'AGENT_HEAD' | 'ACCOUNT_OFFICER';
type WorkOrderStatus = 'PENDING' | 'IN_PROD' | 'COMPLETED';

type ApiState = {
  partners: Dict[];
  agents: Dict[];
  calls: Dict[];
  orders: Dict[];
  sales: Dict[];
  users: Dict[];
  roles: Dict[];
  workOrders: Dict[];
  config: Dict;
};

let prisma: PrismaClient | null = null;
let pgPool: Pool | null = null;
let prismaStatus: 'CONNECTED' | 'DISABLED' | 'ERROR' = 'DISABLED';
let prismaError: string | null = null;
let runtimeStorage: 'in-memory' | 'postgres-jsonb' = 'in-memory';
let prismaMirrorStatus: 'unknown' | 'ready' | 'unavailable' = 'unknown';

try {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    pgPool = new Pool({ connectionString });
    const adapter = new PrismaPg(pgPool);
    prisma = new PrismaClient({ adapter });
    prismaStatus = 'CONNECTED';
  }
} catch (err: any) {
  prismaStatus = 'ERROR';
  prismaError = err?.message ?? 'Unknown Prisma init error';
}

const app = express();

app.use(
  cors({
    origin: '*', // Allows your separate frontend to connect
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

// --- STATE INITIALIZATION ---
const state: ApiState = {
  partners: [],
  agents: [],
  calls: [],
  orders: [],
  sales: [],
  users: [],
  roles: [],
  workOrders: [],
  config: { recommendedCommissionRate: 10, lastUpdated: new Date().toISOString() },
};

// ... [Keep all your helper functions: normalizePartner, normalizeAgent, persistRuntimeChanges, etc. from your original file] ...
// (I am skipping the middle 500 lines of helpers to keep this response readable, but KEEP THEM in your file!)

// --- PARTNERS ---
app.get('/api/partners', (_req, res) => res.json(state.partners));

app.post('/api/partners', async (req, res) => {
  const partner = normalizePartner(req.body ?? {});
  state.partners.push(partner);
  await persistRuntimeChanges();
  res.json(partner);
});

app.patch('/api/partners/:id', async (req, res) => {
  const index = state.partners.findIndex(p => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Partner not found' });
  
  // Update state and database
  state.partners[index] = { ...state.partners[index], ...req.body };
  await persistRuntimeChanges();
  res.json(state.partners[index]);
});

app.delete('/api/partners/:id', async (req, res) => {
  state.partners = state.partners.filter((p) => p.id !== req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- ROLES (Tier Matrix) ---
app.get('/api/roles', (_req, res) => res.json(state.roles));

app.post('/api/roles', async (req, res) => {
  const role = normalizeRole(req.body ?? {});
  state.roles.push(role);
  await persistRuntimeChanges();
  res.json(role);
});

app.patch('/api/roles/:id', async (req, res) => {
  const index = state.roles.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Role not found' });
  
  // Update state and database
  state.roles[index] = { ...state.roles[index], ...req.body };
  await persistRuntimeChanges();
  res.json(state.roles[index]);
});

// --- REMAINING ROUTES (Keep your existing Agents, Orders, Users, etc.) ---

async function start() {
  // ... [Keep your original start() function logic here] ...
  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 [SWIFT ENGINE] Backend active on port ${PORT}`);
  });
}

start();