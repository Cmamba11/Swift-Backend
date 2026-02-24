import "dotenv/config";
import { randomBytes, scryptSync } from "crypto";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for seeding.");
}

const RESET = process.env.SEED_RESET === "1";
const SYNC_RUNTIME = process.env.SEED_RUNTIME !== "0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

const IDs = {
  adminRole: "c95d4b20-b01b-4e5f-bf8c-0e4fe0b50fc2",
  adminUser: "6e24338f-7d27-4cd6-96d6-b09a6381c9e2",
  salesRole: "5d85dd58-7f7a-4df0-aab7-d7e2a21fcb10",
  salesUser: "f6b7cc16-3a58-48c5-9f4a-95f8f8b0d201",
  agentHeadRole: "bdbf3bf2-5121-4f51-8b2a-78f1c4b7b101",
  agentHeadUser: "3ec34f28-cd52-4e6f-9f4d-34a4c7159b11",
  accountsRole: "4c376a49-420e-44a3-b950-3f9f6abf1201",
  accountsUser: "8f5f8b20-6437-4a61-b221-5f8da1bb2301",
  prodRole: "1ea32d8b-0e32-44a6-b0f4-8b975b2ac001",
  prodUser: "ee6f041a-9fcb-4e2a-8db8-0c1ba8f77101",
  agent: "40a8cdb5-dc83-43cc-a986-06c297e95ab8",
  agent2: "51b6ec82-5d64-4ae1-90f8-b2b8a90b3102",
  agent3: "f8d7d972-615d-410a-b0e0-8da94436f103",
  partner: "4a0c9734-ef9c-4509-a763-ba3d21b7a15f",
  partner2: "694c6d43-feb8-4c34-8b8c-cf99dc4fd202",
  partner3: "94d52b31-3545-4f40-8f17-f33719c6e303",
  order: "7783d2b2-7cde-476b-848f-734b86d7d37b",
  order2: "1c3265bc-4b76-4d12-9d88-9cb4b0f0d402",
  order3: "6f1c64ce-f1d6-41f8-b04a-70a15e520503",
  orderItem1: "w9siw",
  orderItem2: "m0udg",
  orderItem3: "aoj689",
  order2Item1: "o2itm1",
  order2Item2: "o2itm2",
  order3Item1: "o3itm1",
  workOrder: "2d7fa7f0-cbb4-4e61-88b2-a721f1f6aa27",
  workOrder2: "fc255fd4-74f2-4613-8a37-c18a8d3c0602",
  workOrder3: "ff855b0c-6f56-4fe8-a574-f9ae25bc0703",
  sale: "f0d9e8ef-f2f2-495f-a7de-95e4864ee001",
  sale2: "f0d9e8ef-f2f2-495f-a7de-95e4864ee011",
  sale3: "f0d9e8ef-f2f2-495f-a7de-95e4864ee021",
  call: "f0d9e8ef-f2f2-495f-a7de-95e4864ee002",
  call2: "f0d9e8ef-f2f2-495f-a7de-95e4864ee012",
  call3: "f0d9e8ef-f2f2-495f-a7de-95e4864ee022",
};

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  return { salt, passwordHash };
}

async function upsertAuthCredential(userId: string, username: string, password: string) {
  const { salt, passwordHash } = hashPassword(password);
  await pool.query(
    `
      INSERT INTO swift_auth_credentials (user_id, username, password_hash, salt, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, updated_at = NOW()
    `,
    [userId, username, passwordHash, salt],
  );
}

async function ensureBackendRuntimeTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS swift_auth_credentials (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS swift_auth_sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS swift_runtime_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function resetPrismaData() {
  await prisma.$transaction(async (tx) => {
    await tx.workOrder.deleteMany();
    await tx.orderItem.deleteMany();
    await tx.order.deleteMany();
    await tx.sale.deleteMany();
    await tx.callReport.deleteMany();
    await tx.user.deleteMany();
    await tx.partner.deleteMany();
    await tx.agent.deleteMany();
    await tx.role.deleteMany();
  });
}

async function resetBackendRuntimeData() {
  await pool.query(`DELETE FROM swift_auth_sessions`);
  await pool.query(`DELETE FROM swift_auth_credentials`);
  await pool.query(`DELETE FROM swift_runtime_state`);
}

async function seedRolesAndUsers() {
  const adminRole = await prisma.role.upsert({
    where: { id: IDs.adminRole },
    update: {
      name: "System Administrator",
      description: "Root access with full industrial control.",
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
      canViewInventory: true,
      canCreateInventory: true,
      canEditInventory: true,
      canDeleteInventory: true,
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
    create: {
      id: IDs.adminRole,
      name: "System Administrator",
      description: "Root access with full industrial control.",
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
      canViewInventory: true,
      canCreateInventory: true,
      canEditInventory: true,
      canDeleteInventory: true,
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

  const salesRole = await prisma.role.upsert({
    where: { id: IDs.salesRole },
    update: {
      name: "Sales Officer",
      description: "Handles partner onboarding and orders.",
      isSystemAdmin: false,
      canViewPartners: true,
      canCreatePartners: true,
      canEditPartners: true,
      canDeletePartners: false,
      canViewAgents: true,
      canCreateAgents: false,
      canEditAgents: false,
      canDeleteAgents: false,
      canViewOrders: true,
      canCreateOrders: true,
      canEditOrders: true,
      canDeleteOrders: false,
      canVerifyOrders: false,
      canApproveAsAgentHead: false,
      canApproveAsAccountOfficer: true,
      canViewInventory: false,
      canCreateInventory: false,
      canEditInventory: false,
      canDeleteInventory: false,
      canViewWorkOrders: true,
      canManageWorkOrders: false,
      canDeleteWorkOrders: false,
      canViewCalls: true,
      canCreateCalls: true,
      canEditCalls: true,
      canDeleteCalls: false,
      canViewLogistics: true,
      canManageLogistics: false,
      canViewSecurity: false,
      canManageUsers: false,
      canManageRoles: false,
      canAccessAIArchitect: false,
    },
    create: {
      id: IDs.salesRole,
      name: "Sales Officer",
      description: "Handles partner onboarding and orders.",
      isSystemAdmin: false,
      canViewPartners: true,
      canCreatePartners: true,
      canEditPartners: true,
      canDeletePartners: false,
      canViewAgents: true,
      canCreateAgents: false,
      canEditAgents: false,
      canDeleteAgents: false,
      canViewOrders: true,
      canCreateOrders: true,
      canEditOrders: true,
      canDeleteOrders: false,
      canVerifyOrders: false,
      canApproveAsAgentHead: false,
      canApproveAsAccountOfficer: true,
      canViewInventory: false,
      canCreateInventory: false,
      canEditInventory: false,
      canDeleteInventory: false,
      canViewWorkOrders: true,
      canManageWorkOrders: false,
      canDeleteWorkOrders: false,
      canViewCalls: true,
      canCreateCalls: true,
      canEditCalls: true,
      canDeleteCalls: false,
      canViewLogistics: true,
      canManageLogistics: false,
      canViewSecurity: false,
      canManageUsers: false,
      canManageRoles: false,
      canAccessAIArchitect: false,
    },
  });

  const agentHeadRole = await prisma.role.upsert({
    where: { id: IDs.agentHeadRole },
    update: {
      name: "Agent Head",
      description: "Approves field orders and supervises agents.",
      canViewPartners: true,
      canEditPartners: true,
      canViewAgents: true,
      canCreateAgents: true,
      canEditAgents: true,
      canViewOrders: true,
      canEditOrders: true,
      canVerifyOrders: true,
      canApproveAsAgentHead: true,
      canViewWorkOrders: true,
      canManageWorkOrders: true,
      canViewCalls: true,
      canEditCalls: true,
      canViewLogistics: true,
      canManageLogistics: true,
    },
    create: {
      id: IDs.agentHeadRole,
      name: "Agent Head",
      description: "Approves field orders and supervises agents.",
      canViewPartners: true,
      canEditPartners: true,
      canViewAgents: true,
      canCreateAgents: true,
      canEditAgents: true,
      canViewOrders: true,
      canEditOrders: true,
      canVerifyOrders: true,
      canApproveAsAgentHead: true,
      canViewWorkOrders: true,
      canManageWorkOrders: true,
      canViewCalls: true,
      canEditCalls: true,
      canViewLogistics: true,
      canManageLogistics: true,
    },
  });

  const accountsRole = await prisma.role.upsert({
    where: { id: IDs.accountsRole },
    update: {
      name: "Accounts Officer",
      description: "Validates payment and settlement approvals.",
      canViewPartners: true,
      canViewOrders: true,
      canEditOrders: true,
      canApproveAsAccountOfficer: true,
      canViewWorkOrders: true,
      canViewCalls: true,
      canViewLogistics: true,
      canViewSecurity: true,
    },
    create: {
      id: IDs.accountsRole,
      name: "Accounts Officer",
      description: "Validates payment and settlement approvals.",
      canViewPartners: true,
      canViewOrders: true,
      canEditOrders: true,
      canApproveAsAccountOfficer: true,
      canViewWorkOrders: true,
      canViewCalls: true,
      canViewLogistics: true,
      canViewSecurity: true,
    },
  });

  const prodRole = await prisma.role.upsert({
    where: { id: IDs.prodRole },
    update: {
      name: "Production Supervisor",
      description: "Manages work-order execution on the factory floor.",
      canViewOrders: true,
      canViewWorkOrders: true,
      canManageWorkOrders: true,
      canDeleteWorkOrders: false,
      canViewLogistics: true,
    },
    create: {
      id: IDs.prodRole,
      name: "Production Supervisor",
      description: "Manages work-order execution on the factory floor.",
      canViewOrders: true,
      canViewWorkOrders: true,
      canManageWorkOrders: true,
      canDeleteWorkOrders: false,
      canViewLogistics: true,
    },
  });

  await prisma.user.upsert({
    where: { username: "admin" },
    update: {
      id: IDs.adminUser,
      name: "Chief Administrator",
      roleId: adminRole.id,
      agentId: null,
      lastLogin: null,
    },
    create: {
      id: IDs.adminUser,
      username: "admin",
      name: "Chief Administrator",
      roleId: adminRole.id,
    },
  });

  await prisma.user.upsert({
    where: { username: "sales.demo" },
    update: {
      id: IDs.salesUser,
      name: "Sales Demo User",
      roleId: salesRole.id,
      agentId: null,
      lastLogin: null,
    },
    create: {
      id: IDs.salesUser,
      username: "sales.demo",
      name: "Sales Demo User",
      roleId: salesRole.id,
      agentId: null,
    },
  });

  await prisma.user.upsert({
    where: { username: "agent.head" },
    update: {
      id: IDs.agentHeadUser,
      name: "Regional Agent Head",
      roleId: agentHeadRole.id,
      agentId: null,
      lastLogin: null,
    },
    create: {
      id: IDs.agentHeadUser,
      username: "agent.head",
      name: "Regional Agent Head",
      roleId: agentHeadRole.id,
      agentId: null,
    },
  });

  await prisma.user.upsert({
    where: { username: "accounts.demo" },
    update: {
      id: IDs.accountsUser,
      name: "Accounts Officer Demo",
      roleId: accountsRole.id,
      agentId: null,
      lastLogin: null,
    },
    create: {
      id: IDs.accountsUser,
      username: "accounts.demo",
      name: "Accounts Officer Demo",
      roleId: accountsRole.id,
      agentId: null,
    },
  });

  await prisma.user.upsert({
    where: { username: "production.demo" },
    update: {
      id: IDs.prodUser,
      name: "Production Supervisor Demo",
      roleId: prodRole.id,
      agentId: null,
      lastLogin: null,
    },
    create: {
      id: IDs.prodUser,
      username: "production.demo",
      name: "Production Supervisor Demo",
      roleId: prodRole.id,
      agentId: null,
    },
  });
}

async function seedBusinessData() {
  await prisma.agent.upsert({
    where: { id: IDs.agent },
    update: {
      name: "Jonggdbf",
      email: "per@gmail.com",
      phone: "+233593024777",
      region: "FG",
      role: "GGG",
      performanceScore: 0,
      customersAcquired: 0,
      employeeId: "AGT-00",
      hireDate: new Date("2026-02-24T00:00:00.000Z"),
      emergencyContact: "",
      commissionRate: 2,
      dataAccuracyScore: 100,
      timelinessScore: 100,
    },
    create: {
      id: IDs.agent,
      name: "Jonggdbf",
      email: "per@gmail.com",
      phone: "+233593024777",
      region: "FG",
      role: "GGG",
      performanceScore: 0,
      customersAcquired: 0,
      employeeId: "AGT-00",
      hireDate: new Date("2026-02-24T00:00:00.000Z"),
      emergencyContact: "",
      commissionRate: 2,
      dataAccuracyScore: 100,
      timelinessScore: 100,
    },
  });

  await prisma.user.update({
    where: { id: IDs.salesUser },
    data: { agentId: IDs.agent },
  });

  await prisma.agent.upsert({
    where: { id: IDs.agent2 },
    update: {
      name: "Ama Boateng",
      email: "ama.boateng@example.com",
      phone: "+233200000002",
      region: "Greater Accra",
      role: "Senior Sales Rep",
      performanceScore: 86,
      customersAcquired: 14,
      employeeId: "AGT-02",
      hireDate: new Date("2025-10-10T00:00:00.000Z"),
      emergencyContact: "Kofi Boateng",
      commissionRate: 4.5,
      dataAccuracyScore: 97,
      timelinessScore: 95,
    },
    create: {
      id: IDs.agent2,
      name: "Ama Boateng",
      email: "ama.boateng@example.com",
      phone: "+233200000002",
      region: "Greater Accra",
      role: "Senior Sales Rep",
      performanceScore: 86,
      customersAcquired: 14,
      employeeId: "AGT-02",
      hireDate: new Date("2025-10-10T00:00:00.000Z"),
      emergencyContact: "Kofi Boateng",
      commissionRate: 4.5,
      dataAccuracyScore: 97,
      timelinessScore: 95,
    },
  });

  await prisma.agent.upsert({
    where: { id: IDs.agent3 },
    update: {
      name: "Kojo Mensah",
      email: "kojo.mensah@example.com",
      phone: "+233200000003",
      region: "Ashanti",
      role: "Territory Agent",
      performanceScore: 74,
      customersAcquired: 8,
      employeeId: "AGT-03",
      hireDate: new Date("2025-05-15T00:00:00.000Z"),
      emergencyContact: "Efua Mensah",
      commissionRate: 3.2,
      dataAccuracyScore: 93,
      timelinessScore: 89,
    },
    create: {
      id: IDs.agent3,
      name: "Kojo Mensah",
      email: "kojo.mensah@example.com",
      phone: "+233200000003",
      region: "Ashanti",
      role: "Territory Agent",
      performanceScore: 74,
      customersAcquired: 8,
      employeeId: "AGT-03",
      hireDate: new Date("2025-05-15T00:00:00.000Z"),
      emergencyContact: "Efua Mensah",
      commissionRate: 3.2,
      dataAccuracyScore: 93,
      timelinessScore: 89,
    },
  });

  await prisma.user.update({
    where: { id: IDs.agentHeadUser },
    data: { agentId: IDs.agent2 },
  });

  await prisma.partner.upsert({
    where: { id: IDs.partner },
    update: {
      customerId: "adsfg",
      name: "asdgfh",
      type: "NEW",
      email: "",
      phone: "",
      contactPerson: "",
      location: "ffgfg",
      address: "",
      assignedAgentId: IDs.agent,
      status: "Active Partner",
      businessCategory: "Major Industrialist",
      website: "",
      defaultRatePerKg: 15.5,
      micron: "30,32",
      colors: ["red"],
    },
    create: {
      id: IDs.partner,
      customerId: "adsfg",
      name: "asdgfh",
      type: "NEW",
      email: "",
      phone: "",
      contactPerson: "",
      location: "ffgfg",
      address: "",
      assignedAgentId: IDs.agent,
      status: "Active Partner",
      businessCategory: "Major Industrialist",
      website: "",
      defaultRatePerKg: 15.5,
      micron: "30,32",
      colors: ["red"],
    },
  });

  await prisma.partner.upsert({
    where: { id: IDs.partner2 },
    update: {
      customerId: "CUST-102",
      name: "Volta Packaging Ltd",
      type: "EXISTING",
      email: "procurement@voltapack.com",
      phone: "+233200100102",
      contactPerson: "Mary Tetteh",
      location: "Tema",
      address: "Industrial Area, Tema",
      assignedAgentId: IDs.agent2,
      status: "Priority Account",
      businessCategory: "Manufacturing",
      website: "https://voltapack.example",
      defaultRatePerKg: 18.25,
      micron: "25,30,35",
      colors: ["blue", "white"],
    },
    create: {
      id: IDs.partner2,
      customerId: "CUST-102",
      name: "Volta Packaging Ltd",
      type: "EXISTING",
      email: "procurement@voltapack.com",
      phone: "+233200100102",
      contactPerson: "Mary Tetteh",
      location: "Tema",
      address: "Industrial Area, Tema",
      assignedAgentId: IDs.agent2,
      status: "Priority Account",
      businessCategory: "Manufacturing",
      website: "https://voltapack.example",
      defaultRatePerKg: 18.25,
      micron: "25,30,35",
      colors: ["blue", "white"],
    },
  });

  await prisma.partner.upsert({
    where: { id: IDs.partner3 },
    update: {
      customerId: "CUST-103",
      name: "GreenMart Retail",
      type: "TARGETED",
      email: "supply@greenmart.example",
      phone: "+233200100103",
      contactPerson: "Daniel Owusu",
      location: "Kumasi",
      address: "Adum Commercial District",
      assignedAgentId: IDs.agent3,
      status: "Onboarding",
      businessCategory: "Retail Distribution",
      website: "https://greenmart.example",
      defaultRatePerKg: 14.75,
      micron: "20,22",
      colors: ["green", "black"],
    },
    create: {
      id: IDs.partner3,
      customerId: "CUST-103",
      name: "GreenMart Retail",
      type: "TARGETED",
      email: "supply@greenmart.example",
      phone: "+233200100103",
      contactPerson: "Daniel Owusu",
      location: "Kumasi",
      address: "Adum Commercial District",
      assignedAgentId: IDs.agent3,
      status: "Onboarding",
      businessCategory: "Retail Distribution",
      website: "https://greenmart.example",
      defaultRatePerKg: 14.75,
      micron: "20,22",
      colors: ["green", "black"],
    },
  });

  await prisma.order.upsert({
    where: { id: IDs.order },
    update: {
      partnerId: IDs.partner,
      guestCompanyName: "GGG",
      importerName: "Chief Administrator",
      orderDate: new Date("2026-02-24T07:16:50.301Z"),
      status: "PENDING",
      totalValue: 4650,
      internalId: "ORD-G9C81",
      adminApproved: true,
      agentHeadApproved: false,
      accountOfficerApproved: true,
      settlementAdminApproved: false,
      settlementAgentHeadApproved: false,
      settlementAccountOfficerApproved: false,
      proofOfPayment: null,
      finalWeight: null,
      finalUnits: null,
      settlementNotes: null,
    },
    create: {
      id: IDs.order,
      partnerId: IDs.partner,
      guestCompanyName: "GGG",
      importerName: "Chief Administrator",
      orderDate: new Date("2026-02-24T07:16:50.301Z"),
      status: "PENDING",
      totalValue: 4650,
      internalId: "ORD-G9C81",
      adminApproved: true,
      agentHeadApproved: false,
      accountOfficerApproved: true,
      settlementAdminApproved: false,
      settlementAgentHeadApproved: false,
      settlementAccountOfficerApproved: false,
    },
  });

  await prisma.orderItem.deleteMany({ where: { orderId: IDs.order } });
  await prisma.orderItem.createMany({
    data: [
      {
        id: IDs.orderItem1,
        orderId: IDs.order,
        productName: "Industrial Rollers",
        productType: "ROLLER" as any,
        quantity: 0,
        totalKg: 100,
        ratePerKg: 15.5,
        fulfilledQuantity: 0,
      },
      {
        id: IDs.orderItem2,
        orderId: IDs.order,
        productName: "Industrial Rollers",
        productType: "ROLLER" as any,
        quantity: 0,
        totalKg: 100,
        ratePerKg: 15.5,
        fulfilledQuantity: 0,
      },
      {
        id: IDs.orderItem3,
        orderId: IDs.order,
        productName: "Industrial Rollers",
        productType: "ROLLER" as any,
        quantity: 0,
        totalKg: 100,
        ratePerKg: 15.5,
        fulfilledQuantity: 0,
      },
    ],
  });

  await prisma.workOrder.upsert({
    where: { id: IDs.workOrder },
    update: {
      internalId: "WO-READY1",
      orderId: IDs.order,
      status: "PENDING",
      priority: "NORMAL",
      startDate: null,
      notes: "Production ticket for ORD-G9C81",
    },
    create: {
      id: IDs.workOrder,
      internalId: "WO-READY1",
      orderId: IDs.order,
      status: "PENDING",
      priority: "NORMAL",
      notes: "Production ticket for ORD-G9C81",
    },
  });

  await prisma.sale.upsert({
    where: { id: IDs.sale },
    update: {
      orderId: IDs.order,
      agentId: IDs.agent,
      partnerId: IDs.partner,
      inventoryItemId: "",
      productName: "Industrial Rollers",
      productType: "ROLLER",
      totalKg: 25,
      volume: 100,
      unitPrice: 15.5,
      date: new Date("2026-02-24T08:00:00.000Z"),
      notes: "Seeded sample sale",
    },
    create: {
      id: IDs.sale,
      orderId: IDs.order,
      agentId: IDs.agent,
      partnerId: IDs.partner,
      inventoryItemId: "",
      productName: "Industrial Rollers",
      productType: "ROLLER",
      totalKg: 25,
      volume: 100,
      unitPrice: 15.5,
      date: new Date("2026-02-24T08:00:00.000Z"),
      notes: "Seeded sample sale",
    },
  });

  await prisma.callReport.upsert({
    where: { id: IDs.call },
    update: {
      customerId: IDs.partner,
      agentId: IDs.agent,
      date: new Date("2026-02-24T06:30:00.000Z"),
      duration: 18,
      outcome: "FOLLOW_UP",
      summary: "Initial product discussion and pricing follow-up.",
      notes: "Seeded sample call report.",
      orderId: IDs.order,
    },
    create: {
      id: IDs.call,
      customerId: IDs.partner,
      agentId: IDs.agent,
      date: new Date("2026-02-24T06:30:00.000Z"),
      duration: 18,
      outcome: "FOLLOW_UP",
      summary: "Initial product discussion and pricing follow-up.",
      notes: "Seeded sample call report.",
      orderId: IDs.order,
    },
  });

  await prisma.order.upsert({
    where: { id: IDs.order2 },
    update: {
      partnerId: IDs.partner2,
      guestCompanyName: "Volta Packaging Ltd",
      importerName: "Sales Demo User",
      orderDate: new Date("2026-02-23T12:45:00.000Z"),
      status: "IN_PROD",
      totalValue: 9825,
      internalId: "ORD-VOLTA1",
      adminApproved: true,
      agentHeadApproved: true,
      accountOfficerApproved: true,
      settlementAdminApproved: false,
      settlementAgentHeadApproved: false,
      settlementAccountOfficerApproved: false,
      proofOfPayment: "seed://proof/ord-volta1",
      finalWeight: null,
      finalUnits: null,
      settlementNotes: null,
    },
    create: {
      id: IDs.order2,
      partnerId: IDs.partner2,
      guestCompanyName: "Volta Packaging Ltd",
      importerName: "Sales Demo User",
      orderDate: new Date("2026-02-23T12:45:00.000Z"),
      status: "IN_PROD",
      totalValue: 9825,
      internalId: "ORD-VOLTA1",
      adminApproved: true,
      agentHeadApproved: true,
      accountOfficerApproved: true,
      proofOfPayment: "seed://proof/ord-volta1",
    },
  });

  await prisma.order.upsert({
    where: { id: IDs.order3 },
    update: {
      partnerId: IDs.partner3,
      guestCompanyName: "GreenMart Retail",
      importerName: "Accounts Officer Demo",
      orderDate: new Date("2026-02-20T09:10:00.000Z"),
      status: "CLOSED",
      totalValue: 3120,
      internalId: "ORD-GREEN1",
      adminApproved: true,
      agentHeadApproved: true,
      accountOfficerApproved: true,
      settlementAdminApproved: true,
      settlementAgentHeadApproved: true,
      settlementAccountOfficerApproved: true,
      proofOfPayment: "seed://proof/ord-green1",
      finalWeight: 195.5,
      finalUnits: 520,
      settlementNotes: "Closed after final weighbridge confirmation.",
    },
    create: {
      id: IDs.order3,
      partnerId: IDs.partner3,
      guestCompanyName: "GreenMart Retail",
      importerName: "Accounts Officer Demo",
      orderDate: new Date("2026-02-20T09:10:00.000Z"),
      status: "CLOSED",
      totalValue: 3120,
      internalId: "ORD-GREEN1",
      adminApproved: true,
      agentHeadApproved: true,
      accountOfficerApproved: true,
      settlementAdminApproved: true,
      settlementAgentHeadApproved: true,
      settlementAccountOfficerApproved: true,
      proofOfPayment: "seed://proof/ord-green1",
      finalWeight: 195.5,
      finalUnits: 520,
      settlementNotes: "Closed after final weighbridge confirmation.",
    },
  });

  await prisma.orderItem.deleteMany({ where: { orderId: IDs.order2 } });
  await prisma.orderItem.createMany({
    data: [
      {
        id: IDs.order2Item1,
        orderId: IDs.order2,
        productName: "Premium Packing Bags",
        productType: "PACKING_BAG" as any,
        quantity: 3000,
        totalKg: 350,
        ratePerKg: 18.25,
        fulfilledQuantity: 1200,
      },
      {
        id: IDs.order2Item2,
        orderId: IDs.order2,
        productName: "Industrial Rollers",
        productType: "ROLLER" as any,
        quantity: 0,
        totalKg: 210,
        ratePerKg: 16.5,
        fulfilledQuantity: 90,
      },
    ],
  });

  await prisma.orderItem.deleteMany({ where: { orderId: IDs.order3 } });
  await prisma.orderItem.createMany({
    data: [
      {
        id: IDs.order3Item1,
        orderId: IDs.order3,
        productName: "Retail Carrier Bags",
        productType: "PACKING_BAG" as any,
        quantity: 520,
        totalKg: 195.5,
        ratePerKg: 14.75,
        fulfilledQuantity: 520,
      },
    ],
  });

  await prisma.workOrder.upsert({
    where: { id: IDs.workOrder2 },
    update: {
      internalId: "WO-VOLTA1",
      orderId: IDs.order2,
      status: "IN_PROD",
      priority: "HIGH",
      startDate: new Date("2026-02-23T14:30:00.000Z"),
      notes: "Extrusion line 2 in progress.",
    },
    create: {
      id: IDs.workOrder2,
      internalId: "WO-VOLTA1",
      orderId: IDs.order2,
      status: "IN_PROD",
      priority: "HIGH",
      startDate: new Date("2026-02-23T14:30:00.000Z"),
      notes: "Extrusion line 2 in progress.",
    },
  });

  await prisma.workOrder.upsert({
    where: { id: IDs.workOrder3 },
    update: {
      internalId: "WO-GREEN1",
      orderId: IDs.order3,
      status: "COMPLETED",
      priority: "NORMAL",
      startDate: new Date("2026-02-20T11:00:00.000Z"),
      notes: "Completed and handed to dispatch.",
    },
    create: {
      id: IDs.workOrder3,
      internalId: "WO-GREEN1",
      orderId: IDs.order3,
      status: "COMPLETED",
      priority: "NORMAL",
      startDate: new Date("2026-02-20T11:00:00.000Z"),
      notes: "Completed and handed to dispatch.",
    },
  });

  await prisma.sale.upsert({
    where: { id: IDs.sale2 },
    update: {
      orderId: IDs.order2,
      agentId: IDs.agent2,
      partnerId: IDs.partner2,
      inventoryItemId: "INV-ROLL-001",
      productName: "Industrial Rollers",
      productType: "ROLLER",
      totalKg: 60,
      volume: 240,
      unitPrice: 16.5,
      date: new Date("2026-02-23T18:15:00.000Z"),
      notes: "Partial production issue to fulfil order.",
    },
    create: {
      id: IDs.sale2,
      orderId: IDs.order2,
      agentId: IDs.agent2,
      partnerId: IDs.partner2,
      inventoryItemId: "INV-ROLL-001",
      productName: "Industrial Rollers",
      productType: "ROLLER",
      totalKg: 60,
      volume: 240,
      unitPrice: 16.5,
      date: new Date("2026-02-23T18:15:00.000Z"),
      notes: "Partial production issue to fulfil order.",
    },
  });

  await prisma.sale.upsert({
    where: { id: IDs.sale3 },
    update: {
      orderId: IDs.order3,
      agentId: IDs.agent3,
      partnerId: IDs.partner3,
      inventoryItemId: "INV-BAG-003",
      productName: "Retail Carrier Bags",
      productType: "PACKING_BAG",
      totalKg: 195.5,
      volume: 520,
      unitPrice: 14.75,
      date: new Date("2026-02-21T10:20:00.000Z"),
      notes: "Closed order fulfillment batch.",
    },
    create: {
      id: IDs.sale3,
      orderId: IDs.order3,
      agentId: IDs.agent3,
      partnerId: IDs.partner3,
      inventoryItemId: "INV-BAG-003",
      productName: "Retail Carrier Bags",
      productType: "PACKING_BAG",
      totalKg: 195.5,
      volume: 520,
      unitPrice: 14.75,
      date: new Date("2026-02-21T10:20:00.000Z"),
      notes: "Closed order fulfillment batch.",
    },
  });

  await prisma.callReport.upsert({
    where: { id: IDs.call2 },
    update: {
      customerId: IDs.partner2,
      agentId: IDs.agent2,
      date: new Date("2026-02-23T10:05:00.000Z"),
      duration: 26,
      outcome: "ORDER_PLACED",
      summary: "Confirmed production schedule and PO release.",
      notes: "Customer requested split delivery.",
      orderId: IDs.order2,
    },
    create: {
      id: IDs.call2,
      customerId: IDs.partner2,
      agentId: IDs.agent2,
      date: new Date("2026-02-23T10:05:00.000Z"),
      duration: 26,
      outcome: "ORDER_PLACED",
      summary: "Confirmed production schedule and PO release.",
      notes: "Customer requested split delivery.",
      orderId: IDs.order2,
    },
  });

  await prisma.callReport.upsert({
    where: { id: IDs.call3 },
    update: {
      customerId: IDs.partner3,
      agentId: IDs.agent3,
      date: new Date("2026-02-19T16:40:00.000Z"),
      duration: 12,
      outcome: "INTERESTED",
      summary: "Targeted partner interested in lower-micron samples.",
      notes: "Schedule site visit next week.",
      orderId: null,
    },
    create: {
      id: IDs.call3,
      customerId: IDs.partner3,
      agentId: IDs.agent3,
      date: new Date("2026-02-19T16:40:00.000Z"),
      duration: 12,
      outcome: "INTERESTED",
      summary: "Targeted partner interested in lower-micron samples.",
      notes: "Schedule site visit next week.",
      orderId: null,
    },
  });

  await prisma.systemConfig.upsert({
    where: { id: "default" },
    update: {
      recommendedCommissionRate: 10,
      targetEfficiencyMetric: "Lead Conversion",
      customerSegmentationAdvice: ["SMB", "Enterprise"],
      logisticsThreshold: 50,
      lastUpdated: new Date(),
      projectedImpact: "",
    },
    create: {
      id: "default",
      recommendedCommissionRate: 10,
      targetEfficiencyMetric: "Lead Conversion",
      customerSegmentationAdvice: ["SMB", "Enterprise"],
      logisticsThreshold: 50,
      lastUpdated: new Date(),
      projectedImpact: "",
    },
  });
}

async function seedAuthCredentials() {
  await upsertAuthCredential(IDs.adminUser, "admin", ADMIN_PASSWORD);
  await upsertAuthCredential(IDs.salesUser, "sales.demo", "demo123");
  await upsertAuthCredential(IDs.agentHeadUser, "agent.head", "demo123");
  await upsertAuthCredential(IDs.accountsUser, "accounts.demo", "demo123");
  await upsertAuthCredential(IDs.prodUser, "production.demo", "demo123");

  if (RESET) {
    await pool.query(`DELETE FROM swift_auth_sessions`);
  }
}

async function syncRuntimeStateFromPrisma() {
  if (!SYNC_RUNTIME) return;

  const [roles, users, partners, agents, orders, workOrders, sales, calls, config] = await Promise.all([
    prisma.role.findMany({ orderBy: { name: "asc" } }),
    prisma.user.findMany({ orderBy: { username: "asc" } }),
    prisma.partner.findMany({ orderBy: { name: "asc" } }),
    prisma.agent.findMany({ orderBy: { name: "asc" } }),
    prisma.order.findMany({ include: { items: true }, orderBy: { orderDate: "desc" } }),
    prisma.workOrder.findMany({ orderBy: { internalId: "asc" } }),
    prisma.sale.findMany({ orderBy: { date: "desc" } }),
    prisma.callReport.findMany({ orderBy: { date: "desc" } }),
    prisma.systemConfig.findUnique({ where: { id: "default" } }),
  ]);

  const runtimeState = {
    partners: partners.map((p: any) => ({
      id: p.id,
      customerId: p.customerId || "",
      name: p.name,
      type: p.type,
      email: p.email || "",
      phone: p.phone || "",
      contactPerson: p.contactPerson || "",
      location: p.location || "",
      address: p.address || "",
      assignedAgentId: p.assignedAgentId || "",
      status: p.status || "",
      businessCategory: p.businessCategory || "",
      website: p.website || "",
      defaultRatePerKg: p.defaultRatePerKg ?? null,
      micron: p.micron || "",
      colors: p.colors || [],
    })),
    agents: agents.map((a: any) => ({
      id: a.id,
      name: a.name,
      email: a.email || "",
      phone: a.phone || "",
      region: a.region || "",
      role: a.role || "",
      performanceScore: Number(a.performanceScore ?? 0),
      customersAcquired: Number(a.customersAcquired ?? 0),
      employeeId: a.employeeId || "",
      hireDate: a.hireDate ? a.hireDate.toISOString().slice(0, 10) : "",
      emergencyContact: a.emergencyContact || "",
      commissionRate: Number(a.commissionRate ?? 0),
      dataAccuracyScore: Number(a.dataAccuracyScore ?? 100),
      timelinessScore: Number(a.timelinessScore ?? 100),
    })),
    calls: calls.map((c: any) => ({
      id: c.id,
      customerId: c.customerId,
      agentId: c.agentId,
      date: c.date.toISOString(),
      duration: c.duration,
      outcome: c.outcome,
      summary: c.summary,
      notes: c.notes,
      orderId: c.orderId || undefined,
    })),
    orders: orders.map((o: any) => ({
      id: o.id,
      partnerId: o.partnerId || undefined,
      guestCompanyName: o.guestCompanyName || undefined,
      importerName: o.importerName || undefined,
      items: (o.items || []).map((i: any) => ({
        id: i.id,
        productName: i.productName,
        productType: i.productType,
        quantity: i.quantity,
        totalKg: i.totalKg ?? undefined,
        ratePerKg: i.ratePerKg ?? undefined,
        fulfilledQuantity: i.fulfilledQuantity ?? 0,
      })),
      orderDate: o.orderDate.toISOString(),
      status: o.status,
      totalValue: Number(o.totalValue ?? 0),
      internalId: o.internalId,
      adminApproved: !!o.adminApproved,
      agentHeadApproved: !!o.agentHeadApproved,
      accountOfficerApproved: !!o.accountOfficerApproved,
      proofOfPayment: o.proofOfPayment || undefined,
      settlementAdminApproved: !!o.settlementAdminApproved,
      settlementAgentHeadApproved: !!o.settlementAgentHeadApproved,
      settlementAccountOfficerApproved: !!o.settlementAccountOfficerApproved,
      finalWeight: o.finalWeight ?? undefined,
      finalUnits: o.finalUnits ?? undefined,
      settlementNotes: o.settlementNotes || undefined,
    })),
    sales: sales.map((s: any) => ({
      id: s.id,
      orderId: s.orderId,
      agentId: s.agentId,
      partnerId: s.partnerId,
      inventoryItemId: s.inventoryItemId || "",
      productName: s.productName,
      productType: s.productType,
      totalKg: Number(s.totalKg ?? 0),
      volume: Number(s.volume ?? 0),
      unitPrice: Number(s.unitPrice ?? 0),
      date: s.date.toISOString(),
      notes: s.notes || "",
    })),
    users: users.map((u: any) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      roleId: u.roleId,
      lastLogin: u.lastLogin ? u.lastLogin.toISOString() : undefined,
      agentId: u.agentId || undefined,
    })),
    roles: roles.map((r: any) => ({
      ...r,
      createdAt: r.createdAt?.toISOString?.() ?? undefined,
      updatedAt: r.updatedAt?.toISOString?.() ?? undefined,
    })),
    workOrders: workOrders.map((wo: any) => ({
      id: wo.id,
      internalId: wo.internalId,
      orderId: wo.orderId,
      status: wo.status,
      priority: wo.priority,
      startDate: wo.startDate ? wo.startDate.toISOString() : undefined,
      notes: wo.notes || undefined,
    })),
    config: config
      ? {
          recommendedCommissionRate: Number(config.recommendedCommissionRate ?? 10),
          targetEfficiencyMetric: config.targetEfficiencyMetric,
          customerSegmentationAdvice: config.customerSegmentationAdvice || ["SMB", "Enterprise"],
          logisticsThreshold: Number(config.logisticsThreshold ?? 50),
          lastUpdated: config.lastUpdated.toISOString(),
          projectedImpact: config.projectedImpact || "",
        }
      : {
          recommendedCommissionRate: 10,
          targetEfficiencyMetric: "Lead Conversion",
          customerSegmentationAdvice: ["SMB", "Enterprise"],
          logisticsThreshold: 50,
          lastUpdated: new Date().toISOString(),
          projectedImpact: "",
        },
  };

  await pool.query(
    `
      INSERT INTO swift_runtime_state (id, data, updated_at)
      VALUES ('main', $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [JSON.stringify(runtimeState)],
  );
}

async function main() {
  console.log(`🌱 Seeding database (reset=${RESET ? "yes" : "no"}, syncRuntime=${SYNC_RUNTIME ? "yes" : "no"})`);

  await ensureBackendRuntimeTables();

  if (RESET) {
    console.log("🧹 Resetting Prisma business tables + backend runtime/auth tables...");
    await resetBackendRuntimeData();
    await resetPrismaData();
  }

  await seedRolesAndUsers();
  await seedBusinessData();
  await seedAuthCredentials();
  await syncRuntimeStateFromPrisma();

  console.log(`✅ Seed complete`);
  console.log(`🔐 Admin login: admin / ${ADMIN_PASSWORD}`);
  console.log(`🔐 Sales login: sales.demo / demo123`);
  console.log(`🔐 Agent Head login: agent.head / demo123`);
  console.log(`🔐 Accounts login: accounts.demo / demo123`);
  console.log(`🔐 Production login: production.demo / demo123`);
}

main()
  .catch((err) => {
    console.error("❌ Prisma seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
