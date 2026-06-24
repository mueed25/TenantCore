# TenantCore

A production-grade multi-tenant backend built with NestJS, Prisma, PostgreSQL, and Redis. Designed for SaaS products that need to serve multiple organisations from a single deployment — with strict data isolation, role-based access control, and zero cross-tenant data leakage.

---

## What It Solves

Most backend tutorials show CRUD apps. TenantCore demonstrates the infrastructure layer underneath real SaaS products — the part that determines whether a system can serve one client or ten thousand without data leaking between them.

**The core problem:** when multiple organisations share one deployment, every request must be scoped to the correct tenant before any business logic runs. Get this wrong and Tenant A reads Tenant B's data. TenantCore solves this at the middleware layer, before a request reaches a controller.

---

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │           NestJS API Server          │
                        │                                      │
  Incoming Request ────▶│  TenantMiddleware                    │
                        │    └─ Resolves tenant from:          │
                        │         • X-Tenant-Slug header       │
                        │         • Subdomain                  │
                        │         • ?tenant= query param       │
                        │                                      │
                        │  JwtAuthGuard                        │
                        │    └─ Validates JWT                  │
                        │    └─ Attaches req.user              │
                        │                                      │
                        │  RolesGuard                          │
                        │    └─ Checks TenantRole              │
                        │                                      │
                        │  Controller → Service → Prisma       │
                        └──────────────┬──────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                   │
             ┌──────▼──────┐   ┌───────▼──────┐   ┌──────▼──────┐
             │  PostgreSQL  │   │    Redis      │   │  S3 Bucket  │
             │  (Supabase)  │   │  (Cache/Rate  │   │  (Per-tenant│
             │              │   │   Limiting)   │   │   Files)    │
             └─────────────┘   └──────────────┘   └─────────────┘
```

### Request Lifecycle

```
Request
  │
  ├─▶ TenantMiddleware    — Who is making this request?
  │       └─ 400 if no tenant identifier found
  │       └─ 404 if tenant does not exist
  │       └─ 400 if tenant is suspended
  │       └─ attaches req.tenant = { id, slug, plan }
  │
  ├─▶ JwtAuthGuard        — Are they authenticated?
  │       └─ 401 if no token or invalid token
  │       └─ attaches req.user = { userId, tenantId, role }
  │
  ├─▶ RolesGuard          — Are they authorised?
  │       └─ 403 if role insufficient
  │
  └─▶ Controller          — Business logic, fully scoped
          └─ req.tenant and req.user resolved and typed
```

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Framework | NestJS | Modular, decorator-driven, built for large-scale APIs |
| ORM | Prisma | Type-safe queries, clean schema, straightforward migrations |
| Database | PostgreSQL (Supabase) | Battle-tested relational DB with row-level security support |
| Auth | JWT + Passport | Full control over token contents and lifecycle |
| Password Hashing | bcrypt | Industry standard, configurable salt rounds |
| Caching / Rate Limiting | Redis | Session storage and per-tenant rate limiting |
| File Storage | AWS S3 | Per-tenant bucket isolation |
| Deployment | AWS EC2 + Docker | Containerised, reproducible deployments |
| CI/CD | GitHub Actions | Automated test and deploy pipeline |
| Process Manager | PM2 | Zero-downtime restarts on EC2 |

---

## Data Model

```prisma
Tenant
  id         String       (uuid)
  name       String
  slug       String       @unique
  plan       TenantPlan   (FREE | STARTER | GROWTH | ENTERPRISE)
  status     TenantStatus (ACTIVE | SUSPENDED | DELETED)

TenantUser
  id         String       (uuid)
  tenantId   String
  email      String
  password   String       ← bcrypt hashed, never returned in responses
  role       TenantRole   (SUPERADMIN | ADMIN | MANAGER | MEMBER | VIEWER)
  isActive   Boolean

  @@unique([tenantId, email])   ← same email can exist across tenants
  @@index([tenantId])           ← all queries tenant-scoped first

AuditLog
  tenantId   String
  userId     String
  action     String
  resource   String
  ipAddress  String?
  metadata   Json?

  @@index([tenantId])
  @@index([tenantId, createdAt])
```

**Why `@@unique([tenantId, email])` and not `@unique` on email alone?**

`john@example.com` at `acme.com` and `john@example.com` at `globex.com` are different people in different organisations. A global unique constraint on email would bleed organisational identity across tenant boundaries. The compound constraint enforces uniqueness only within each tenant's scope.

---

## Multi-Tenancy Strategy

TenantCore uses a **shared database, shared schema** model with tenant isolation enforced at the application layer.

Each tenant is identified by a `slug`. Every request resolves the tenant in this order:

1. `X-Tenant-Slug` request header (API clients, mobile apps)
2. Subdomain — `acme.yourapp.com` resolves to slug `acme`
3. `?tenant=acme` query parameter (development only, disabled in production)

Once resolved, `req.tenant` is available to every downstream guard and controller without an additional database call.

### Query Performance

Every `TenantUser` and `AuditLog` row has `tenantId` indexed. A query across 1,000,000 rows becomes a query across that tenant's rows only — PostgreSQL jumps directly to the indexed partition. The middleware pays one database lookup per request to resolve the tenant; everything after is scoped.

---

## API Endpoints

### Health

```
GET /api/v1/health
→ 200 { status: "ok" }
```

No auth required. Used by load balancers and uptime monitors.

### Tenants

```
POST /api/v1/tenants
Body: { name, slug, plan? }
→ 201 Tenant object

GET /api/v1/tenants/:slug
Header: X-Tenant-Slug: <slug>
→ 200 Tenant object

GET /api/v1/tenants/:slug/users
Header: X-Tenant-Slug: <slug>
→ 200 Array of TenantUser (passwords excluded)
```

### Auth

```
POST /api/v1/auth/signup
Header: X-Tenant-Slug: <slug>
Body: { email, password }
→ 201 { user }

POST /api/v1/auth/login
Header: X-Tenant-Slug: <slug>
Body: { email, password }
→ 200 { access_token }
```

### Protected Routes

All routes below require `Authorization: Bearer <token>`.

```
GET /api/v1/users/me
→ 200 Current user profile

GET /api/v1/users
@Roles(ADMIN, SUPERADMIN)
→ 200 All users in the resolved tenant
```

---

## Project Structure

```
tenantcore/
├── prisma/
│   └── schema.prisma              ← data models and relationships
├── src/
│   ├── middleware/
│   │   └── tenant.middleware.ts   ← tenant resolution, runs on every request
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts        ← login, signup, token issuance
│   │   ├── auth.controller.ts
│   │   ├── jwt.strategy.ts        ← Passport JWT strategy
│   │   └── jwt-auth.guard.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   └── users.service.ts       ← user lookup scoped to tenant
│   ├── tenants/
│   │   └── tenants.module.ts
│   ├── health/
│   │   └── health.module.ts
│   ├── app.module.ts              ← root module, middleware wiring
│   └── main.ts                    ← bootstrap, global prefix, validation pipe
├── docker-compose.yml             ← local PostgreSQL and Redis
├── .env.example
└── README.md
```

---

## Local Development

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL database (Supabase free tier works)

### Setup

```bash
git clone https://github.com/mueed25/tenantcore.git
cd tenantcore
pnpm install
cp .env.example .env
```

Fill in `.env`:

```env
DATABASE_URL="postgresql://postgres.yourref:[PASSWORD]@aws-region.pooler.supabase.com:5432/postgres"
JWT_SECRET="your-minimum-32-character-secret-string"
NODE_ENV="development"
PORT=3000
```

```bash
npx prisma generate
npx prisma db push
npm run start:dev
```

### With Docker

```bash
docker compose up -d postgres redis
# Use local DATABASE_URL:
# postgresql://tenantcore:tenantcore_dev@localhost:5432/tenantcore
```

### Verify

```bash
curl http://localhost:3000/api/v1/health

curl -X POST http://localhost:3000/api/v1/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp", "slug": "acme"}'

curl http://localhost:3000/api/v1/tenants/acme \
  -H "X-Tenant-Slug: acme"
```

---

## Design Decisions

**Why not Supabase Auth directly?**
Using Supabase's client SDK for auth would have the frontend talk directly to Supabase, bypassing NestJS entirely for authentication. This breaks the gatekeeper pattern — the entire security model depends on every request passing through tenant resolution before anything else. NestJS-issued JWTs keep the full request lifecycle server-controlled.

**Why shared schema instead of database-per-tenant?**
Database-per-tenant gives perfect isolation but makes cross-tenant analytics impossible, explodes infrastructure costs at scale, and complicates migrations. Shared schema with application-layer isolation gives 95% of the isolation benefit at a fraction of the operational cost — the right tradeoff for most SaaS products at early to mid scale.

**Why Prisma over TypeORM?**
TypeORM requires verbose repository injection and entity classes. Prisma queries are plain function calls with full TypeScript inference — `prisma.tenant.findUnique()` autocompletes all fields and relationships at the call site. Schema changes flow through one `.prisma` file and one migration command.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret — minimum 32 characters |
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | No | Server port, defaults to 3000 |

---

## License

MIT
