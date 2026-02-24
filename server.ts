/**
 * SWIFT PLASTICS - BACKEND ENGINE (Frontend Compatibility API)
 * Provides a backend contract that matches the frontend `services/api.ts`.
 * Prisma is used opportunistically for health/bootstrapping when available,
 * while the runtime API uses a normalized in-memory store to handle the
 * frontend's richer data model than the current Prisma schema supports.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
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

type SessionRecord = {
  sid: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
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
    origin: ['https://swiftplasticsinc.com', 'https://www.swiftplasticsinc.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

const nowIso = () => new Date().toISOString();
const generateInternalId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const defaultRolePermissions = {
  isSystemAdmin: false,
  canViewPartners: false,
  canCreatePartners: false,
  canEditPartners: false,
  canDeletePartners: false,
  canViewAgents: false,
  canCreateAgents: false,
  canEditAgents: false,
  canDeleteAgents: false,
  canViewOrders: false,
  canCreateOrders: false,
  canEditOrders: false,
  canDeleteOrders: false,
  canVerifyOrders: false,
  canApproveAsAgentHead: false,
  canApproveAsAccountOfficer: false,
  canViewInventory: false,
  canCreateInventory: false,
  canEditInventory: false,
  canDeleteInventory: false,
  canViewWorkOrders: false,
  canManageWorkOrders: false,
  canDeleteWorkOrders: false,
  canViewCalls: false,
  canCreateCalls: false,
  canEditCalls: false,
  canDeleteCalls: false,
  canViewLogistics: false,
  canManageLogistics: false,
  canViewSecurity: false,
  canManageUsers: false,
  canManageRoles: false,
  canAccessAIArchitect: false,
};

function makeAdminRole(): Dict {
  return {
    id: randomUUID(),
    name: 'System Administrator',
    description: 'Root access with full industrial control.',
    ...Object.fromEntries(Object.keys(defaultRolePermissions).map((k) => [k, true])),
  };
}

function makeDefaultConfig(): Dict {
  return {
    recommendedCommissionRate: 10,
    targetEfficiencyMetric: 'Lead Conversion',
    customerSegmentationAdvice: ['SMB', 'Enterprise'],
    logisticsThreshold: 50,
    lastUpdated: nowIso(),
    projectedImpact: '',
  };
}

const state: ApiState = {
  partners: [],
  agents: [],
  calls: [],
  orders: [],
  sales: [],
  users: [],
  roles: [],
  workOrders: [],
  config: makeDefaultConfig(),
};

type CredentialRecord = {
  userId: string;
  username: string;
  passwordHash: string;
  salt: string;
  updatedAt: string;
};

const credentialsByUserId = new Map<string, CredentialRecord>();
const sessionsById = new Map<string, SessionRecord>();
const STATE_ROW_ID = 'main';
const SESSION_COOKIE_NAME = 'swift_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function sanitizeUser(user: Dict): Dict {
  const { password, ...safeUser } = user;
  return safeUser;
}

function clientUsers() {
  return state.users.map(sanitizeUser);
}

function snapshotStateForDb(): ApiState {
  return {
    ...state,
    users: clientUsers(),
    config: { ...state.config },
  };
}

function applyStateSnapshot(snapshot: Partial<ApiState>) {
  if (Array.isArray(snapshot.partners)) state.partners = snapshot.partners.map((p) => normalizePartner(p));
  if (Array.isArray(snapshot.agents)) state.agents = snapshot.agents.map((a) => normalizeAgent(a));
  if (Array.isArray(snapshot.calls)) state.calls = snapshot.calls.map((c) => normalizeCall(c));
  if (Array.isArray(snapshot.sales)) state.sales = snapshot.sales.map((s) => normalizeSale(s));
  if (Array.isArray(snapshot.roles)) state.roles = snapshot.roles.map((r) => normalizeRole(r));
  if (Array.isArray(snapshot.users)) state.users = snapshot.users.map((u) => normalizeUser(u));
  if (Array.isArray(snapshot.orders)) state.orders = snapshot.orders.map((o) => normalizeOrder(o));
  if (Array.isArray(snapshot.workOrders)) state.workOrders = snapshot.workOrders.map((wo) => normalizeWorkOrder(wo));
  if (snapshot.config && typeof snapshot.config === 'object') {
    state.config = { ...makeDefaultConfig(), ...snapshot.config };
  }
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 64);
  return { salt, passwordHash: derived.toString('hex') };
}

function verifyPassword(password: string, record: CredentialRecord) {
  const derived = scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.passwordHash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

async function ensureRuntimeTables() {
  if (!pgPool) return false;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS swift_runtime_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS swift_auth_credentials (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS swift_auth_sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  runtimeStorage = 'postgres-jsonb';
  return true;
}

async function loadRuntimeStateFromDb() {
  if (!pgPool) return false;
  const result = await pgPool.query('SELECT data FROM swift_runtime_state WHERE id = $1', [STATE_ROW_ID]);
  if (!result.rows[0]?.data) return false;
  applyStateSnapshot(result.rows[0].data as Partial<ApiState>);
  return true;
}

async function persistRuntimeStateToDb() {
  if (!pgPool || runtimeStorage !== 'postgres-jsonb') return;
  await pgPool.query(
    `
      INSERT INTO swift_runtime_state (id, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [STATE_ROW_ID, JSON.stringify(snapshotStateForDb())],
  );
}

async function loadCredentialsFromDb() {
  if (!pgPool || runtimeStorage !== 'postgres-jsonb') return;
  const result = await pgPool.query(
    'SELECT user_id, username, password_hash, salt, updated_at FROM swift_auth_credentials',
  );
  credentialsByUserId.clear();
  for (const row of result.rows) {
    credentialsByUserId.set(row.user_id, {
      userId: row.user_id,
      username: row.username,
      passwordHash: row.password_hash,
      salt: row.salt,
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
}

async function loadSessionsFromDb() {
  if (!pgPool || runtimeStorage !== 'postgres-jsonb') return;
  const result = await pgPool.query(
    `
      SELECT sid, user_id, created_at, last_seen_at, expires_at
      FROM swift_auth_sessions
      WHERE expires_at > NOW()
    `,
  );
  sessionsById.clear();
  for (const row of result.rows) {
    sessionsById.set(row.sid, {
      sid: row.sid,
      userId: row.user_id,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }
  if (pgPool) {
    await pgPool.query('DELETE FROM swift_auth_sessions WHERE expires_at <= NOW()');
  }
}

async function upsertCredential(userId: string, username: string, password: string) {
  const { salt, passwordHash } = hashPassword(password);
  const record: CredentialRecord = {
    userId,
    username,
    passwordHash,
    salt,
    updatedAt: nowIso(),
  };
  credentialsByUserId.set(userId, record);

  if (pgPool && runtimeStorage === 'postgres-jsonb') {
    await pgPool.query(
      `
        INSERT INTO swift_auth_credentials (user_id, username, password_hash, salt, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, updated_at = NOW()
      `,
      [userId, username, passwordHash, salt],
    );
  }
}

async function deleteCredential(userId: string) {
  credentialsByUserId.delete(userId);
  if (pgPool && runtimeStorage === 'postgres-jsonb') {
    await pgPool.query('DELETE FROM swift_auth_credentials WHERE user_id = $1', [userId]);
  }
}

async function syncCredentialUsername(userId: string, username: string) {
  const existing = credentialsByUserId.get(userId);
  if (!existing) return;
  existing.username = username;
  existing.updatedAt = nowIso();
  if (pgPool && runtimeStorage === 'postgres-jsonb') {
    await pgPool.query(
      'UPDATE swift_auth_credentials SET username = $2, updated_at = NOW() WHERE user_id = $1',
      [userId, username],
    );
  }
}

async function ensureAdminCredentials() {
  const adminUser = state.users.find((u) => u.username === 'admin');
  if (!adminUser) return;
  if (credentialsByUserId.has(adminUser.id)) return;
  await upsertCredential(adminUser.id, adminUser.username, process.env.ADMIN_PASSWORD || 'admin');
}

function findUserByUsername(username: string) {
  return state.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

function parseCookies(cookieHeader?: string) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeSessionCookie(sid: string, expiresAt: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

function clearSessionCookieValue() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

async function persistSession(record: SessionRecord) {
  sessionsById.set(record.sid, record);
  if (pgPool && runtimeStorage === 'postgres-jsonb') {
    await pgPool.query(
      `
        INSERT INTO swift_auth_sessions (sid, user_id, created_at, last_seen_at, expires_at)
        VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz)
        ON CONFLICT (sid)
        DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at
      `,
      [record.sid, record.userId, record.createdAt, record.lastSeenAt, record.expiresAt],
    );
  }
}

async function deleteSession(sid: string) {
  sessionsById.delete(sid);
  if (pgPool && runtimeStorage === 'postgres-jsonb') {
    await pgPool.query('DELETE FROM swift_auth_sessions WHERE sid = $1', [sid]);
  }
}

async function createSession(userId: string) {
  const createdAt = nowIso();
  const record: SessionRecord = {
    sid: randomBytes(24).toString('hex'),
    userId,
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  await persistSession(record);
  return record;
}

async function touchSession(record: SessionRecord) {
  record.lastSeenAt = nowIso();
  record.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await persistSession(record);
}

async function getAuthenticatedUser(req: express.Request) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE_NAME];
  if (!sid) return null;
  const session = sessionsById.get(sid);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await deleteSession(sid);
    return null;
  }
  const user = state.users.find((u) => u.id === session.userId);
  if (!user) {
    await deleteSession(sid);
    return null;
  }
  return { sid, session, user };
}

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateOrNow(value: any): Date {
  return toDateOrNull(value) ?? new Date();
}

function asPartnerType(value: any) {
  return value === 'EXISTING' || value === 'TARGETED' ? value : 'NEW';
}

function asVisitOutcome(value: any) {
  return value === 'INTERESTED' || value === 'NOT_INTERESTED' || value === 'ORDER_PLACED' ? value : 'FOLLOW_UP';
}

function asProductType(value: any) {
  return value === 'PACKING_BAG' ? 'PACKING_BAG' : 'ROLLER';
}

function asOrderStatus(value: any) {
  const valid = new Set([
    'PENDING',
    'AWAITING_PROD',
    'IN_PROD',
    'READY_FOR_DISPATCH',
    'CLOSED',
    'CANCELLED',
    'PARTIALLY_SETTLED',
  ]);
  return valid.has(value) ? value : 'PENDING';
}

function asWorkOrderStatus(value: any) {
  return value === 'IN_PROD' || value === 'COMPLETED' ? value : 'PENDING';
}

function asWorkOrderPriority(value: any) {
  return value === 'CRITICAL' || value === 'HIGH' ? value : 'NORMAL';
}

async function mirrorStateToPrisma() {
  if (!prisma) return;
  if (prismaMirrorStatus === 'unavailable') return;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.workOrder.deleteMany();
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.sale.deleteMany();
      await tx.callReport.deleteMany();
      await tx.user.deleteMany();
      await tx.role.deleteMany();
      await tx.partner.deleteMany();
      await tx.agent.deleteMany();

      if (state.roles.length) {
        await tx.role.createMany({
          data: state.roles.map((r) => ({
            id: r.id,
            name: String(r.name ?? ''),
            description: String(r.description ?? ''),
            isSystemAdmin: Boolean(r.isSystemAdmin),
            canViewPartners: Boolean(r.canViewPartners),
            canCreatePartners: Boolean(r.canCreatePartners),
            canEditPartners: Boolean(r.canEditPartners),
            canDeletePartners: Boolean(r.canDeletePartners),
            canViewAgents: Boolean(r.canViewAgents),
            canCreateAgents: Boolean(r.canCreateAgents),
            canEditAgents: Boolean(r.canEditAgents),
            canDeleteAgents: Boolean(r.canDeleteAgents),
            canViewOrders: Boolean(r.canViewOrders),
            canCreateOrders: Boolean(r.canCreateOrders),
            canEditOrders: Boolean(r.canEditOrders),
            canDeleteOrders: Boolean(r.canDeleteOrders),
            canVerifyOrders: Boolean(r.canVerifyOrders),
            canApproveAsAgentHead: Boolean(r.canApproveAsAgentHead),
            canApproveAsAccountOfficer: Boolean(r.canApproveAsAccountOfficer),
            canViewInventory: Boolean(r.canViewInventory),
            canCreateInventory: Boolean(r.canCreateInventory),
            canEditInventory: Boolean(r.canEditInventory),
            canDeleteInventory: Boolean(r.canDeleteInventory),
            canViewWorkOrders: Boolean(r.canViewWorkOrders),
            canManageWorkOrders: Boolean(r.canManageWorkOrders),
            canDeleteWorkOrders: Boolean(r.canDeleteWorkOrders),
            canViewCalls: Boolean(r.canViewCalls),
            canCreateCalls: Boolean(r.canCreateCalls),
            canEditCalls: Boolean(r.canEditCalls),
            canDeleteCalls: Boolean(r.canDeleteCalls),
            canViewLogistics: Boolean(r.canViewLogistics),
            canManageLogistics: Boolean(r.canManageLogistics),
            canViewSecurity: Boolean(r.canViewSecurity),
            canManageUsers: Boolean(r.canManageUsers),
            canManageRoles: Boolean(r.canManageRoles),
            canAccessAIArchitect: Boolean(r.canAccessAIArchitect),
          })),
        });
      }

      if (state.agents.length) {
        await tx.agent.createMany({
          data: state.agents.map((a) => ({
            id: a.id,
            name: String(a.name ?? ''),
            email: String(a.email ?? ''),
            phone: String(a.phone ?? ''),
            region: String(a.region ?? ''),
            role: String(a.role ?? ''),
            performanceScore: Number(a.performanceScore ?? 0),
            customersAcquired: Number(a.customersAcquired ?? 0),
            employeeId: String(a.employeeId ?? ''),
            hireDate: toDateOrNull(a.hireDate),
            emergencyContact: String(a.emergencyContact ?? ''),
            commissionRate: Number(a.commissionRate ?? 0),
            dataAccuracyScore: Number(a.dataAccuracyScore ?? 100),
            timelinessScore: Number(a.timelinessScore ?? 100),
          })),
        });
      }

      if (state.partners.length) {
        await tx.partner.createMany({
          data: state.partners.map((p) => ({
            id: p.id,
            customerId: p.customerId || null,
            name: String(p.name ?? ''),
            type: asPartnerType(p.type),
            email: String(p.email ?? ''),
            phone: String(p.phone ?? ''),
            contactPerson: String(p.contactPerson ?? ''),
            location: String(p.location ?? ''),
            address: String(p.address ?? ''),
            assignedAgentId: String(p.assignedAgentId ?? ''),
            status: String(p.status ?? 'ACTIVE'),
            businessCategory: String(p.businessCategory ?? ''),
            website: p.website ? String(p.website) : null,
            defaultRatePerKg:
              p.defaultRatePerKg == null || Number.isNaN(Number(p.defaultRatePerKg))
                ? null
                : Number(p.defaultRatePerKg),
            micron: String(p.micron ?? ''),
            colors: Array.isArray(p.colors) ? p.colors.map((c: any) => String(c)) : [],
          })),
        });
      }

      if (state.users.length) {
        await tx.user.createMany({
          data: state.users.map((u) => ({
            id: u.id,
            username: String(u.username ?? ''),
            name: String(u.name ?? ''),
            roleId: String(u.roleId ?? ''),
            agentId: u.agentId ? String(u.agentId) : null,
            lastLogin: toDateOrNull(u.lastLogin),
          })),
        });
      }

      if (state.orders.length) {
        await tx.order.createMany({
          data: state.orders.map((o) => ({
            id: o.id,
            partnerId: o.partnerId ? String(o.partnerId) : null,
            guestCompanyName: o.guestCompanyName ? String(o.guestCompanyName) : null,
            importerName: o.importerName ? String(o.importerName) : null,
            orderDate: toDateOrNow(o.orderDate),
            status: asOrderStatus(o.status),
            totalValue: Number(o.totalValue ?? 0),
            internalId: String(o.internalId ?? generateInternalId('ORD')),
            adminApproved: Boolean(o.adminApproved),
            agentHeadApproved: Boolean(o.agentHeadApproved),
            accountOfficerApproved: Boolean(o.accountOfficerApproved),
            proofOfPayment: o.proofOfPayment ? String(o.proofOfPayment) : null,
            settlementAdminApproved: Boolean(o.settlementAdminApproved),
            settlementAgentHeadApproved: Boolean(o.settlementAgentHeadApproved),
            settlementAccountOfficerApproved: Boolean(o.settlementAccountOfficerApproved),
            finalWeight:
              o.finalWeight == null || Number.isNaN(Number(o.finalWeight)) ? null : Number(o.finalWeight),
            finalUnits: o.finalUnits == null || Number.isNaN(Number(o.finalUnits)) ? null : Number(o.finalUnits),
            settlementNotes: o.settlementNotes ? String(o.settlementNotes) : null,
          })),
        });
      }

      const allOrderItems = state.orders.flatMap((o) =>
        (Array.isArray(o.items) ? o.items : []).map((i: any) => ({
          id: String(i.id ?? randomUUID()),
          orderId: String(o.id),
          productName: String(i.productName ?? i.product ?? 'Unknown Product'),
          productType: asProductType(i.productType),
          quantity: Number(i.quantity ?? 0),
          totalKg: i.totalKg == null || Number.isNaN(Number(i.totalKg)) ? null : Number(i.totalKg),
          ratePerKg: i.ratePerKg == null || Number.isNaN(Number(i.ratePerKg)) ? null : Number(i.ratePerKg),
          fulfilledQuantity: Number(i.fulfilledQuantity ?? 0),
        })),
      );
      if (allOrderItems.length) {
        await tx.orderItem.createMany({ data: allOrderItems as any });
      }

      if (state.workOrders.length) {
        await tx.workOrder.createMany({
          data: state.workOrders.map((wo) => ({
            id: wo.id,
            internalId: String(wo.internalId ?? generateInternalId('WO')),
            orderId: String(wo.orderId),
            status: asWorkOrderStatus(wo.status),
            priority: asWorkOrderPriority(wo.priority),
            startDate: toDateOrNull(wo.startDate),
            notes: wo.notes ? String(wo.notes) : null,
          })),
        });
      }

      if (state.sales.length) {
        await tx.sale.createMany({
          data: state.sales.map((s) => ({
            id: s.id,
            orderId: String(s.orderId ?? ''),
            agentId: String(s.agentId ?? ''),
            partnerId: String(s.partnerId ?? ''),
            inventoryItemId: String(s.inventoryItemId ?? ''),
            productName: String(s.productName ?? ''),
            productType: asProductType(s.productType),
            totalKg: Number(s.totalKg ?? 0),
            volume: Number(s.volume ?? 0),
            unitPrice: Number(s.unitPrice ?? 0),
            date: toDateOrNow(s.date),
            notes: String(s.notes ?? ''),
          })),
        });
      }

      if (state.calls.length) {
        await tx.callReport.createMany({
          data: state.calls.map((c) => ({
            id: c.id,
            customerId: String(c.customerId ?? ''),
            agentId: String(c.agentId ?? ''),
            date: toDateOrNow(c.date),
            duration: Number(c.duration ?? 0),
            outcome: asVisitOutcome(c.outcome),
            summary: String(c.summary ?? ''),
            notes: String(c.notes ?? ''),
            orderId: c.orderId ? String(c.orderId) : null,
          })),
        });
      }

      await tx.systemConfig.upsert({
        where: { id: 'default' },
        update: {
          recommendedCommissionRate: Number(state.config.recommendedCommissionRate ?? 10),
          targetEfficiencyMetric: String(state.config.targetEfficiencyMetric ?? 'Lead Conversion'),
          customerSegmentationAdvice: Array.isArray(state.config.customerSegmentationAdvice)
            ? state.config.customerSegmentationAdvice.map((v: any) => String(v))
            : ['SMB', 'Enterprise'],
          logisticsThreshold: Number(state.config.logisticsThreshold ?? 50),
          lastUpdated: toDateOrNow(state.config.lastUpdated),
          projectedImpact: state.config.projectedImpact ? String(state.config.projectedImpact) : null,
        },
        create: {
          id: 'default',
          recommendedCommissionRate: Number(state.config.recommendedCommissionRate ?? 10),
          targetEfficiencyMetric: String(state.config.targetEfficiencyMetric ?? 'Lead Conversion'),
          customerSegmentationAdvice: Array.isArray(state.config.customerSegmentationAdvice)
            ? state.config.customerSegmentationAdvice.map((v: any) => String(v))
            : ['SMB', 'Enterprise'],
          logisticsThreshold: Number(state.config.logisticsThreshold ?? 50),
          lastUpdated: toDateOrNow(state.config.lastUpdated),
          projectedImpact: state.config.projectedImpact ? String(state.config.projectedImpact) : null,
        },
      });
    });

    prismaMirrorStatus = 'ready';
  } catch (err: any) {
    console.warn('⚠️ [PRISMA MIRROR] Disabled:', err?.message ?? err);
    prismaMirrorStatus = 'unavailable';
  }
}

async function persistRuntimeChanges() {
  try {
    await persistRuntimeStateToDb();
    await mirrorStateToPrisma();
  } catch (err: any) {
    console.error('❌ [STATE] Failed to persist runtime state:', err?.message ?? err);
  }
}

function ensureSeedState() {
  if (state.roles.length === 0) {
    const adminRole = makeAdminRole();
    state.roles.push(adminRole);
    state.users.push({
      id: randomUUID(),
      username: 'admin',
      name: 'Chief Administrator',
      roleId: adminRole.id,
      lastLogin: undefined,
      agentId: undefined,
    });
  }
}

function normalizePartner(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    customerId: input.customerId ?? `CUS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    name: input.name ?? 'Unnamed Partner',
    type: input.type ?? 'NEW',
    email: input.email ?? '',
    phone: input.phone ?? '',
    contactPerson: input.contactPerson ?? '',
    location: input.location ?? '',
    address: input.address ?? '',
    assignedAgentId: input.assignedAgentId ?? '',
    status: input.status ?? 'ACTIVE',
    businessCategory: input.businessCategory ?? '',
    website: input.website ?? '',
    defaultRatePerKg:
      typeof input.defaultRatePerKg === 'number' ? input.defaultRatePerKg : Number(input.defaultRatePerKg ?? 0),
    micron: input.micron ?? '',
    colors: Array.isArray(input.colors) ? input.colors : [],
  };
}

function normalizeAgent(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'Unnamed Agent',
    email: input.email ?? '',
    phone: input.phone ?? '',
    region: input.region ?? '',
    role: input.role ?? '',
    performanceScore: Number(input.performanceScore ?? 0),
    customersAcquired: Number(input.customersAcquired ?? 0),
    employeeId: input.employeeId ?? '',
    hireDate: input.hireDate ?? nowIso(),
    emergencyContact: input.emergencyContact ?? '',
    commissionRate: Number(input.commissionRate ?? 0),
    dataAccuracyScore: Number(input.dataAccuracyScore ?? 100),
    timelinessScore: Number(input.timelinessScore ?? 100),
  };
}

function normalizeOrderItems(items: any[]): Dict[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item?.id ?? randomUUID(),
    productName: item?.productName ?? item?.product ?? 'Unknown Product',
    productType: item?.productType ?? 'ROLLER',
    quantity: Number(item?.quantity ?? 0),
    totalKg: item?.totalKg != null ? Number(item.totalKg) : undefined,
    ratePerKg:
      item?.ratePerKg != null ? Number(item.ratePerKg) : item?.price != null ? Number(item.price) : undefined,
    fulfilledQuantity: Number(item?.fulfilledQuantity ?? 0),
  }));
}

function computeTotalValue(items: Dict[]): number {
  return items.reduce((sum, item) => {
    const qty = Number(item.quantity ?? 0);
    const rate = Number(item.ratePerKg ?? 0);
    return sum + qty * rate;
  }, 0);
}

function normalizeOrder(input: Dict): Dict {
  const items = normalizeOrderItems(input.items ?? []);
  const totalValue = input.totalValue != null ? Number(input.totalValue) : computeTotalValue(items);
  return {
    id: input.id ?? randomUUID(),
    partnerId: input.partnerId ?? undefined,
    guestCompanyName: input.guestCompanyName ?? undefined,
    importerName: input.importerName ?? undefined,
    items,
    orderDate: input.orderDate ?? nowIso(),
    status: input.status ?? 'PENDING',
    totalValue,
    internalId: input.internalId ?? generateInternalId('ORD'),
    adminApproved: Boolean(input.adminApproved ?? false),
    agentHeadApproved: Boolean(input.agentHeadApproved ?? false),
    accountOfficerApproved: Boolean(input.accountOfficerApproved ?? false),
    proofOfPayment: input.proofOfPayment ?? undefined,
    settlementAdminApproved: Boolean(input.settlementAdminApproved ?? false),
    settlementAgentHeadApproved: Boolean(input.settlementAgentHeadApproved ?? false),
    settlementAccountOfficerApproved: Boolean(input.settlementAccountOfficerApproved ?? false),
    finalWeight: input.finalWeight != null ? Number(input.finalWeight) : undefined,
    finalUnits: input.finalUnits != null ? Number(input.finalUnits) : undefined,
    settlementNotes: input.settlementNotes ?? undefined,
  };
}

function normalizeRole(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'Untitled Role',
    description: input.description ?? '',
    ...defaultRolePermissions,
    ...input,
  };
}

function normalizeUser(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    username: input.username ?? `user_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name ?? 'Unnamed User',
    roleId: input.roleId ?? state.roles[0]?.id,
    lastLogin: input.lastLogin,
    agentId: input.agentId,
  };
}

function normalizeWorkOrder(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    internalId: input.internalId ?? generateInternalId('WO'),
    orderId: input.orderId,
    status: input.status ?? 'PENDING',
    priority: input.priority ?? 'NORMAL',
    startDate: input.startDate ? new Date(input.startDate).toISOString() : undefined,
    notes: input.notes ?? undefined,
  };
}

function normalizeSale(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    orderId: input.orderId ?? '',
    agentId: input.agentId ?? '',
    partnerId: input.partnerId ?? '',
    inventoryItemId: input.inventoryItemId ?? '',
    productName: input.productName ?? 'Unknown Product',
    productType: input.productType ?? 'ROLLER',
    totalKg: Number(input.totalKg ?? 0),
    volume: Number(input.volume ?? 0),
    unitPrice: Number(input.unitPrice ?? 0),
    date: input.date ?? nowIso(),
    notes: input.notes ?? '',
  };
}

function normalizeCall(input: Dict): Dict {
  return {
    id: input.id ?? randomUUID(),
    customerId: input.customerId ?? '',
    agentId: input.agentId ?? '',
    date: input.date ?? nowIso(),
    duration: Number(input.duration ?? 0),
    outcome: input.outcome ?? 'FOLLOW_UP',
    summary: input.summary ?? '',
    notes: input.notes ?? '',
    orderId: input.orderId ?? undefined,
  };
}

function jsonError(res: express.Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

function findOrder(orderId: string) {
  return state.orders.find((o) => o.id === orderId);
}

function setApprovalFlag(order: Dict, type: ApprovalType, settlement = false) {
  if (type === 'ADMIN') order[settlement ? 'settlementAdminApproved' : 'adminApproved'] = true;
  if (type === 'AGENT_HEAD') order[settlement ? 'settlementAgentHeadApproved' : 'agentHeadApproved'] = true;
  if (type === 'ACCOUNT_OFFICER') {
    order[settlement ? 'settlementAccountOfficerApproved' : 'accountOfficerApproved'] = true;
  }
}

async function seedPrismaIfPossible() {
  if (!prisma) return;
  try {
    const roleCount = await prisma.role.count();
    if (roleCount > 0) return;

    console.log('🌱 [SEED] Database empty. Planting System Administrator role...');
    const adminRole = await prisma.role.create({
      data: {
        name: 'System Administrator',
        description: 'Root access with full industrial control.',
        isSystemAdmin: true,
        canViewPartners: true,
        canCreatePartners: true,
        canEditPartners: true,
        canDeletePartners: true,
        canViewAgents: true,
        canCreateAgents: true,
        canEditAgents: true,
        canDeleteAgents: true,
        canViewOrders: true,
        canCreateOrders: true,
        canEditOrders: true,
        canDeleteOrders: true,
        canVerifyOrders: true,
        canApproveAsAgentHead: true,
        canApproveAsAccountOfficer: true,
        canViewWorkOrders: true,
        canManageWorkOrders: true,
        canDeleteWorkOrders: true,
        canViewCalls: true,
        canCreateCalls: true,
        canEditCalls: true,
        canDeleteCalls: true,
        canViewLogistics: true,
        canManageLogistics: true,
        canViewSecurity: true,
        canManageUsers: true,
        canManageRoles: true,
        canAccessAIArchitect: true,
      },
    });

    await prisma.user.create({
      data: {
        username: 'admin',
        name: 'Chief Administrator',
        roleId: adminRole.id,
      },
    });
    console.log("✅ [SEED] System initialized. Login with 'admin'.");
  } catch (err: any) {
    console.error('❌ [SEED] Failed to seed Prisma:', err?.message ?? err);
  }
}

async function hydrateFromPrisma() {
  if (!prisma) return;

  try {
    const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
    if (roles.length) {
      state.roles = roles.map((r) =>
        normalizeRole({
          ...r,
          description: r.description ?? '',
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] roles unavailable:', err?.message ?? err);
  }

  try {
    const users = await prisma.user.findMany({ orderBy: { username: 'asc' } });
    if (users.length) {
      state.users = users.map((u: any) =>
        normalizeUser({
          id: u.id,
          username: u.username,
          name: u.name,
          roleId: u.roleId,
          agentId: u.agentId ?? undefined,
          lastLogin: u.lastLogin?.toISOString?.(),
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] users unavailable:', err?.message ?? err);
  }

  try {
    const partners = await prisma.partner.findMany({ orderBy: { name: 'asc' } });
    if (partners.length) {
      state.partners = partners.map((p: any) => normalizePartner({ ...p }));
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] partners unavailable:', err?.message ?? err);
  }

  try {
    const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } });
    if (agents.length) {
      state.agents = agents.map((a: any) =>
        normalizeAgent({
          ...a,
          hireDate: a.hireDate?.toISOString?.(),
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] agents unavailable:', err?.message ?? err);
  }

  try {
    const orders = await prisma.order.findMany({
      include: { items: true },
      orderBy: { orderDate: 'desc' },
    });
    if (orders.length) {
      state.orders = orders.map((o: any) =>
        normalizeOrder({
          id: o.id,
          partnerId: o.partnerId ?? undefined,
          guestCompanyName: o.guestCompanyName ?? undefined,
          importerName: o.importerName ?? undefined,
          internalId: o.internalId,
          status: o.status,
          totalValue: o.totalValue,
          adminApproved: o.adminApproved,
          agentHeadApproved: o.agentHeadApproved,
          accountOfficerApproved: o.accountOfficerApproved,
          proofOfPayment: o.proofOfPayment ?? undefined,
          settlementAdminApproved: o.settlementAdminApproved ?? false,
          settlementAgentHeadApproved: o.settlementAgentHeadApproved ?? false,
          settlementAccountOfficerApproved: o.settlementAccountOfficerApproved ?? false,
          finalWeight: o.finalWeight ?? undefined,
          finalUnits: o.finalUnits ?? undefined,
          settlementNotes: o.settlementNotes ?? undefined,
          orderDate: o.orderDate?.toISOString?.() ?? o.createdAt?.toISOString?.() ?? nowIso(),
          items: (o.items ?? []).map((i: any) => ({
            id: i.id,
            productName: i.productName ?? i.product,
            productType: i.productType ?? 'ROLLER',
            quantity: i.quantity,
            totalKg: i.totalKg ?? undefined,
            ratePerKg: i.ratePerKg ?? i.price ?? undefined,
            fulfilledQuantity: i.fulfilledQuantity ?? 0,
          })),
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] orders unavailable:', err?.message ?? err);
  }

  try {
    const workOrders = await prisma.workOrder.findMany({ orderBy: { internalId: 'asc' } });
    if (workOrders.length) {
      state.workOrders = workOrders.map((wo: any) =>
        normalizeWorkOrder({
          id: wo.id,
          internalId: wo.internalId,
          orderId: wo.orderId,
          status: wo.status,
          priority: wo.priority,
          startDate: wo.startDate?.toISOString(),
          notes: wo.notes ?? undefined,
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] workOrders unavailable:', err?.message ?? err);
  }

  try {
    const sales = await prisma.sale.findMany({ orderBy: { date: 'desc' } });
    if (sales.length) {
      state.sales = sales.map((s: any) =>
        normalizeSale({
          ...s,
          date: s.date?.toISOString?.() ?? nowIso(),
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] sales unavailable:', err?.message ?? err);
  }

  try {
    const calls = await prisma.callReport.findMany({ orderBy: { date: 'desc' } });
    if (calls.length) {
      state.calls = calls.map((c: any) =>
        normalizeCall({
          ...c,
          date: c.date?.toISOString?.() ?? nowIso(),
        }),
      );
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] calls unavailable:', err?.message ?? err);
  }

  try {
    const cfg = await prisma.systemConfig.findFirst();
    if (cfg) {
      state.config = {
        recommendedCommissionRate: Number(cfg.recommendedCommissionRate ?? 10),
        targetEfficiencyMetric: cfg.targetEfficiencyMetric ?? 'Lead Conversion',
        customerSegmentationAdvice: cfg.customerSegmentationAdvice ?? ['SMB', 'Enterprise'],
        logisticsThreshold: Number(cfg.logisticsThreshold ?? 50),
        lastUpdated: cfg.lastUpdated?.toISOString?.() ?? nowIso(),
        projectedImpact: (cfg as any).projectedImpact ?? '',
      };
    }
  } catch (err: any) {
    console.warn('⚠️ [HYDRATE] config unavailable:', err?.message ?? err);
  }
}

// --- SYSTEM HEALTH ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ONLINE',
    timestamp: nowIso(),
    engine: 'Frontend Compatibility API',
    storage: runtimeStorage,
    auth: 'password',
    prismaStatus,
    prismaMirrorStatus,
    ...(prismaError ? { prismaError } : {}),
  });
});

// --- AUTH ---
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) {
    return res.json({ ok: false, error: 'Username and password are required' });
  }

  const user = findUserByUsername(username);
  if (!user) return res.json({ ok: false, error: 'Invalid credentials' });

  const credential = credentialsByUserId.get(user.id);
  if (!credential || !verifyPassword(password, credential)) {
    return res.json({ ok: false, error: 'Invalid credentials' });
  }

  const newSession = await createSession(user.id);
  user.lastLogin = nowIso();
  await persistRuntimeChanges();
  res.setHeader('Set-Cookie', serializeSessionCookie(newSession.sid, newSession.expiresAt));
  return res.json({ ok: true, user: sanitizeUser(user) });
});

app.get('/api/auth/me', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth) {
    return res.json({ ok: false, user: null });
  }
  await touchSession(auth.session);
  res.setHeader('Set-Cookie', serializeSessionCookie(auth.session.sid, auth.session.expiresAt));
  return res.json({ ok: true, user: sanitizeUser(auth.user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE_NAME];
  if (sid) await deleteSession(sid);
  res.setHeader('Set-Cookie', clearSessionCookieValue());
  return res.json({ ok: true });
});

// --- PARTNERS ---
app.get('/api/partners', (_req, res) => res.json(state.partners));
app.post('/api/partners', async (req, res) => {
  const partner = normalizePartner(req.body ?? {});
  state.partners.push(partner);
  await persistRuntimeChanges();
  res.json(partner);
});
app.delete('/api/partners/:id', async (req, res) => {
  state.partners = state.partners.filter((p) => p.id !== req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- AGENTS ---
app.get('/api/agents', (_req, res) => res.json(state.agents));
app.post('/api/agents', async (req, res) => {
  const agent = normalizeAgent(req.body ?? {});
  state.agents.push(agent);
  await persistRuntimeChanges();
  res.json(agent);
});
app.delete('/api/agents/:id', async (req, res) => {
  state.agents = state.agents.filter((a) => a.id !== req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- CALL REPORTS ---
app.get('/api/calls', (_req, res) => res.json(state.calls));
app.post('/api/calls', async (req, res) => {
  const call = normalizeCall(req.body ?? {});
  state.calls.push(call);
  await persistRuntimeChanges();
  res.json(call);
});

// --- SALES ---
app.get('/api/sales', (_req, res) => res.json(state.sales));
app.post('/api/sales', async (req, res) => {
  const sale = normalizeSale(req.body ?? {});
  state.sales.push(sale);
  await persistRuntimeChanges();
  res.json(sale);
});

// --- USERS ---
app.get('/api/users', (_req, res) => res.json(clientUsers()));
app.post('/api/users', async (req, res) => {
  const body = req.body ?? {};
  const requestedUsername = String(body.username ?? '').trim();
  if (!requestedUsername) return jsonError(res, 400, 'username is required');
  if (findUserByUsername(requestedUsername)) return jsonError(res, 409, 'username already exists');

  const user = normalizeUser({ ...body, username: requestedUsername });
  state.users.push(user);
  await upsertCredential(user.id, user.username, String(body.password ?? 'changeme'));
  await persistRuntimeChanges();
  res.json(sanitizeUser(user));
});
app.patch('/api/users/:id', async (req, res) => {
  const user = state.users.find((u) => u.id === req.params.id);
  if (!user) return jsonError(res, 404, 'User not found');
  const body = { ...(req.body ?? {}) };
  const nextUsername =
    typeof body.username === 'string' && body.username.trim() ? body.username.trim() : undefined;
  if (nextUsername && nextUsername.toLowerCase() !== user.username.toLowerCase()) {
    const conflict = findUserByUsername(nextUsername);
    if (conflict && conflict.id !== user.id) return jsonError(res, 409, 'username already exists');
  }
  const newPassword = typeof body.password === 'string' ? body.password : undefined;
  delete body.password;
  Object.assign(user, body);
  if (nextUsername) {
    user.username = nextUsername;
    await syncCredentialUsername(user.id, user.username);
  }
  if (newPassword && newPassword.length > 0) {
    await upsertCredential(user.id, user.username, newPassword);
  }
  await persistRuntimeChanges();
  res.json(sanitizeUser(user));
});
app.delete('/api/users/:id', async (req, res) => {
  state.users = state.users.filter((u) => u.id !== req.params.id);
  await deleteCredential(req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- ROLES ---
app.get('/api/roles', (_req, res) => res.json(state.roles));
app.post('/api/roles', async (req, res) => {
  const role = normalizeRole(req.body ?? {});
  state.roles.push(role);
  await persistRuntimeChanges();
  res.json(role);
});
app.delete('/api/roles/:id', async (req, res) => {
  state.roles = state.roles.filter((r) => r.id !== req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- CONFIG ---
app.get('/api/config', (_req, res) => res.json(state.config));
app.patch('/api/config', async (req, res) => {
  state.config = {
    ...state.config,
    ...(req.body ?? {}),
    lastUpdated: nowIso(),
  };
  await persistRuntimeChanges();
  res.json(state.config);
});

// --- ORDERS ---
app.get('/api/orders', (_req, res) => res.json(state.orders));
app.post('/api/orders', async (req, res) => {
  const order = normalizeOrder(req.body ?? {});
  state.orders.push(order);
  await persistRuntimeChanges();
  res.json(order);
});
app.post('/api/orders/:id/approve', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return jsonError(res, 404, 'Order not found');
  const type = req.body?.type as ApprovalType;
  if (!type) return jsonError(res, 400, 'Approval type is required');
  setApprovalFlag(order, type, false);
  await persistRuntimeChanges();
  res.json(order);
});
app.post('/api/orders/:id/settlement-approve', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return jsonError(res, 404, 'Order not found');
  const type = req.body?.type as ApprovalType;
  if (!type) return jsonError(res, 400, 'Approval type is required');
  setApprovalFlag(order, type, true);
  await persistRuntimeChanges();
  res.json(order);
});
app.patch('/api/orders/:id/settlement-data', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return jsonError(res, 404, 'Order not found');
  const body = req.body ?? {};
  if (body.totalKg != null) order.finalWeight = Number(body.totalKg);
  if (body.volume != null) order.finalUnits = Number(body.volume);
  if (body.notes != null) order.settlementNotes = String(body.notes);
  await persistRuntimeChanges();
  res.json(order);
});
app.post('/api/orders/:id/close', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return jsonError(res, 404, 'Order not found');
  order.status = 'CLOSED';
  await persistRuntimeChanges();
  res.json(order);
});
app.delete('/api/orders/:id', async (req, res) => {
  const id = req.params.id;
  state.orders = state.orders.filter((o) => o.id !== id);
  state.workOrders = state.workOrders.filter((wo) => wo.orderId !== id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

// --- WORK ORDERS ---
app.get('/api/work-orders', (_req, res) => res.json(state.workOrders));
app.post('/api/work-orders/issue', async (req, res) => {
  const orderId = req.body?.orderId as string | undefined;
  if (!orderId) return jsonError(res, 400, 'orderId is required');

  const order = findOrder(orderId);
  if (!order) return jsonError(res, 404, 'Reference order missing.');

  const workOrder = normalizeWorkOrder({
    orderId,
    priority: req.body?.priority ?? 'NORMAL',
    notes: req.body?.notes ?? `Production ticket for ${order.internalId}`,
  });

  order.status = 'AWAITING_PROD';
  state.workOrders.push(workOrder);
  await persistRuntimeChanges();
  res.json(workOrder);
});
app.patch('/api/work-orders/:id/status', async (req, res) => {
  const status = req.body?.status as WorkOrderStatus | undefined;
  if (!status) return jsonError(res, 400, 'status is required');

  const wo = state.workOrders.find((w) => w.id === req.params.id);
  if (!wo) return jsonError(res, 404, 'Work order not found');

  wo.status = status;
  const order = findOrder(wo.orderId);

  if (status === 'IN_PROD') {
    wo.startDate = nowIso();
    if (order) order.status = 'IN_PROD';
  }
  if (status === 'COMPLETED') {
    if (order) order.status = 'READY_FOR_DISPATCH';
  }

  await persistRuntimeChanges();
  res.json(wo);
});
app.delete('/api/work-orders/:id', async (req, res) => {
  state.workOrders = state.workOrders.filter((wo) => wo.id !== req.params.id);
  await persistRuntimeChanges();
  res.json({ ok: true });
});

app.use('/api', (_req, res) => jsonError(res, 404, 'Endpoint not found'));

async function start() {
  let loadedRuntimeState = false;
  ensureSeedState();
  try {
    const stateStoreReady = await ensureRuntimeTables();
    if (stateStoreReady) {
      loadedRuntimeState = await loadRuntimeStateFromDb();
      await loadCredentialsFromDb();
      await loadSessionsFromDb();
    }
  } catch (err: any) {
    runtimeStorage = 'in-memory';
    console.warn('⚠️ [STATE] Runtime DB store unavailable:', err?.message ?? err);
  }

  await seedPrismaIfPossible();
  if (!loadedRuntimeState) {
    await hydrateFromPrisma();
  }
  ensureSeedState();
  await ensureAdminCredentials();
  await persistRuntimeChanges();

  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, () => {
    console.log(`📡 [SWIFT ENGINE] Backend active on port ${PORT}`);
    console.log(`🔗 [MODE] Frontend compatibility API`);
    console.log(`🗄️  [PRISMA] ${prismaStatus}${prismaError ? ` (${prismaError})` : ''}`);
    console.log(`💾 [STATE] ${runtimeStorage}`);
    console.log(`🪞 [PRISMA MIRROR] ${prismaMirrorStatus}`);
    console.log(`🔐 [AUTH] Password login enabled (default admin password: ${process.env.ADMIN_PASSWORD ? '[env]' : 'admin'})`);
  });
}

start().catch((err) => {
  console.error('❌ [BOOT] Failed to start backend:', err);
  process.exit(1);
});
