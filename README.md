# TenantCore

A production-grade multi-tenant SaaS backend built with NestJS, Prisma, PostgreSQL, and Redis. TenantCore is the complete infrastructure layer that powers multi-organisation SaaS products — handling tenant isolation, role-based access control, Stripe billing with plan enforcement, webhook delivery, usage metering, audit logging, email flows, and per-tenant file storage from a single deployment.

---

## What It Solves

Most backend projects show CRUD. TenantCore shows what sits underneath real SaaS products — the infrastructure that determines whether a system can serve one client or ten thousand without data leaking between them, without billing getting out of sync, and without engineers manually managing per-customer state.

**The core problems TenantCore solves:**

- Every request must be scoped to the correct tenant before any business logic runs — get this wrong and Tenant A reads Tenant B's data
- Plans must be enforced at the API layer, not trusted from the client — a FREE tenant cannot call GROWTH endpoints regardless of what they send
- Usage must be metered in real time and checked on every request — not reconciled after the fact
- Webhooks must be delivered reliably with retries, failure tracking, and per-tenant endpoint management
- Every privileged action must be auditable — who did what, from where, when

---

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │              NestJS API Server            │
                        │                                          │
  Incoming Request ────▶│  TenantMiddleware                        │
                        │    └─ Resolves tenant from:              │
                        │         • X-Tenant-Slug header           │
                        │         • Subdomain                      │
                        │         • ?tenant= query param (dev)     │
                        │                                          │
                        │  JwtAuthGuard                            │
                        │    └─ Validates JWT                      │
                        │    └─ Attaches req.user                  │
                        │                                          │
                        │  RolesGuard                              │
                        │    └─ Checks TenantRole                  │
                        │                                          │
                        │  PlanGuard                               │
                        │    └─ Checks tenant plan vs endpoint     │
                        │                                          │
                        │  UsageMeterGuard                         │
                        │    └─ Checks quota remaining (Redis)     │
                        │    └─ Increments counter on pass         │
                        │                                          │
                        │  Controller → Service → Prisma           │
                        └──────────────┬───────────────────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────┐
         │                             │                          │
  ┌──────▼──────┐              ┌───────▼──────┐           ┌──────▼──────┐
  │  PostgreSQL  │              │    Redis      │           │  S3 Bucket  │
  │  (Supabase)  │              │  (Quota/Rate  │           │  (Per-tenant│
  │              │              │   Limiting/   │           │   isolation)│
  │              │              │   Sessions)   │           │             │
  └──────────────┘              └──────────────┘           └─────────────┘
         │
  ┌──────▼──────┐              ┌──────────────┐
  │   Stripe     │              │    SendGrid   │
  │  (Billing /  │              │   (Transact-  │
  │  Webhooks)   │              │    ional      │
  └──────────────┘              │    Email)     │
                                └──────────────┘
```

### Request Lifecycle

```
Request
  │
  ├─▶ TenantMiddleware     — Who is this request for?
  │       └─ 400 if no tenant identifier found
  │       └─ 404 if tenant does not exist
  │       └─ 400 if tenant is suspended
  │       └─ attaches req.tenant = { id, slug, plan }
  │
  ├─▶ JwtAuthGuard         — Are they authenticated?
  │       └─ 401 if no token or invalid token
  │       └─ attaches req.user = { userId, tenantId, role }
  │
  ├─▶ RolesGuard           — Are they authorised?
  │       └─ 403 if role insufficient for this route
  │
  ├─▶ PlanGuard            — Does their plan include this feature?
  │       └─ 403 if tenant plan does not cover this endpoint
  │
  ├─▶ UsageMeterGuard      — Have they hit their quota?
  │       └─ 429 if monthly API call limit exceeded
  │       └─ Increments Redis counter on pass
  │
  └─▶ Controller           — Business logic, fully scoped
          └─ req.tenant and req.user resolved and typed
          └─ AuditLog written for all privileged actions
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
| Caching / Rate Limiting | Redis | Real-time quota tracking and per-tenant rate limiting |
| Billing | Stripe | Subscription lifecycle, usage-based billing, webhook events |
| File Storage | AWS S3 | Per-tenant prefix isolation, pre-signed URL generation |
| Email | SendGrid | Transactional email — invites, password reset, billing alerts |
| Deployment | AWS EC2 + Docker | Containerised, reproducible deployments |
| CI/CD | GitHub Actions | Automated test and deploy pipeline |
| Process Manager | PM2 | Zero-downtime restarts on EC2 |

---

## Feature Set

### Multi-Tenancy & Isolation
- Shared database, shared schema with application-layer tenant isolation
- Every query is tenant-scoped before execution — no cross-tenant data leakage by design
- Tenant resolution from header, subdomain, or query param
- Tenant status management: ACTIVE, SUSPENDED, DELETED with appropriate HTTP responses

### Role-Based Access Control
- Five-tier role hierarchy: `SUPERADMIN → ADMIN → MANAGER → MEMBER → VIEWER`
- Declarative `@Roles()` decorator on any controller method
- Role is scoped per tenant — the same user can be ADMIN at Acme and MEMBER at Globex

### Plan-Based Feature Gating
- Four plans: `FREE | STARTER | GROWTH | ENTERPRISE`
- `@RequiresPlan()` decorator gates entire endpoints by plan tier
- Plan is resolved from `req.tenant` — no client input trusted
- Upgrading a plan in the database immediately unlocks gated features on the next request

### Usage Metering & Quota Enforcement
- Per-tenant monthly API call counters stored in Redis
- `UsageMeterGuard` checks quota before every metered endpoint and increments on pass
- Quota limits defined per plan — FREE gets 1,000 calls/month, ENTERPRISE gets unlimited
- Quota reset job runs on the first of each month via scheduled task
- Usage data exposed via admin endpoint for billing dashboards

### Stripe Billing Integration
- Tenant signup creates a Stripe customer automatically
- Subscription create, update, and cancel flows managed via NestJS services
- Stripe webhook endpoint processes `customer.subscription.updated`, `invoice.payment_failed`, and `invoice.payment_succeeded` events
- Failed payment suspends tenant after configurable grace period
- Plan changes in Stripe automatically sync to tenant record via webhook

### Webhook Delivery System
- Tenants register up to N webhook endpoints (plan-limited)
- Events are queued and delivered with exponential backoff retry (3 attempts)
- Each delivery attempt is logged: status code, response time, success/failure
- Dead-letter tracking for permanently failed deliveries
- Webhook secret per endpoint — HMAC-SHA256 signature on every payload

### Audit Logging
- Every privileged action (login, role change, user invite, plan change, webhook config) writes an `AuditLog` row
- Stores: tenantId, userId, action, resource, IP address, metadata
- Filterable audit log API endpoint for ADMIN and SUPERADMIN roles
- Indexed on `(tenantId, createdAt)` for efficient range queries

### Email Flows
- User invite: sends invitation email with time-limited token
- Password reset: secure token issued and validated before password update
- Billing alerts: payment failure and upcoming renewal notifications via SendGrid
- All email templates scoped to tenant — can include tenant name and branding fields

### File Storage
- Per-tenant S3 prefix isolation: `uploads/{tenantId}/filename`
- Pre-signed URL generation for direct client-to-S3 uploads (files never hit the API server)
- File metadata stored in database: name, size, type, uploadedBy, tenantId
- File listing scoped to tenant, with access control via role check

---

## Data Model

```prisma
Tenant
  id              String        (uuid)
  name            String
  slug            String        @unique
  plan            TenantPlan    (FREE | STARTER | GROWTH | ENTERPRISE)
  status          TenantStatus  (ACTIVE | SUSPENDED | DELETED)
  stripeCustomerId String?      @unique
  stripeSubId     String?       @unique
  trialEndsAt     DateTime?

TenantUser
  id         String       (uuid)
  tenantId   String
  email      String
  password   String       ← bcrypt hashed, never returned in responses
  role       TenantRole   (SUPERADMIN | ADMIN | MANAGER | MEMBER | VIEWER)
  isActive   Boolean
  invitedBy  String?      ← userId of the inviter
  invitedAt  DateTime?
  lastLoginAt DateTime?

  @@unique([tenantId, email])   ← same email can exist across tenants
  @@index([tenantId])           ← all queries tenant-scoped first

AuditLog
  tenantId   String
  userId     String
  action     String        ← e.g. USER_INVITED, ROLE_CHANGED, PLAN_UPGRADED
  resource   String        ← e.g. users, tenants, webhooks
  resourceId String?
  ipAddress  String?
  userAgent  String?
  metadata   Json?

  @@index([tenantId])
  @@index([tenantId, createdAt])

WebhookEndpoint
  id         String       (uuid)
  tenantId   String
  url        String
  secret     String       ← HMAC signing key, never returned after creation
  isActive   Boolean
  events     String[]     ← subscribed event types

  @@index([tenantId])

WebhookDelivery
  id              String       (uuid)
  endpointId      String
  tenantId        String
  event           String
  payload         Json
  statusCode      Int?
  responseBody    String?
  attemptCount    Int
  deliveredAt     DateTime?
  nextRetryAt     DateTime?
  failed          Boolean

  @@index([tenantId])
  @@index([endpointId, createdAt])

UsageRecord
  id         String       (uuid)
  tenantId   String       @unique
  periodStart DateTime
  periodEnd   DateTime
  apiCalls    Int
  storageBytes BigInt

  @@index([tenantId])

TenantFile
  id         String       (uuid)
  tenantId   String
  key        String       ← S3 object key
  name       String
  mimeType   String
  sizeBytes  Int
  uploadedBy String

  @@index([tenantId])
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

Every `TenantUser`, `AuditLog`, `WebhookDelivery`, and `UsageRecord` row has `tenantId` indexed. A query across 1,000,000 rows becomes a query across that tenant's rows only — PostgreSQL jumps directly to the indexed partition. The middleware pays one database lookup per request to resolve the tenant; everything after that is scoped.

---

## API Reference

### Health

```
GET /api/v1/health
→ 200 { status: "ok", uptime: 3600, version: "1.0.0" }
```

No auth required. Used by load balancers and uptime monitors.

### Tenants

```
POST /api/v1/tenants
Body: { name, slug, plan? }
→ 201 Tenant object (also creates Stripe customer)

GET /api/v1/tenants/:slug
Header: X-Tenant-Slug: <slug>
→ 200 Tenant object

PATCH /api/v1/tenants/:slug
Header: X-Tenant-Slug: <slug>
@Roles(SUPERADMIN)
Body: { name?, status? }
→ 200 Updated tenant

GET /api/v1/tenants/:slug/users
Header: X-Tenant-Slug: <slug>
@Roles(ADMIN, SUPERADMIN)
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

POST /api/v1/auth/invite
Header: X-Tenant-Slug: <slug>
@Roles(ADMIN, SUPERADMIN)
Body: { email, role }
→ 201 { invited: true } — sends invitation email via SendGrid

POST /api/v1/auth/accept-invite
Body: { token, password }
→ 200 { access_token }

POST /api/v1/auth/forgot-password
Header: X-Tenant-Slug: <slug>
Body: { email }
→ 200 { sent: true }

POST /api/v1/auth/reset-password
Body: { token, newPassword }
→ 200 { reset: true }
```

### Users

```
GET /api/v1/users/me
Authorization: Bearer <token>
→ 200 Current user profile

GET /api/v1/users
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 All users in the resolved tenant

PATCH /api/v1/users/:userId/role
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
Body: { role }
→ 200 Updated user (writes AuditLog)

DELETE /api/v1/users/:userId
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 204 No content (writes AuditLog)
```

### Billing

```
GET /api/v1/billing/subscription
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 Current Stripe subscription details

POST /api/v1/billing/upgrade
Authorization: Bearer <token>
@Roles(SUPERADMIN)
Body: { plan }
→ 200 { upgraded: true } — updates Stripe subscription and tenant plan

GET /api/v1/billing/invoices
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 Array of past Stripe invoices

POST /api/v1/billing/portal
Authorization: Bearer <token>
@Roles(SUPERADMIN)
→ 200 { url } — Stripe customer portal session URL

POST /api/v1/billing/webhook
(Stripe calls this — no auth, HMAC verified)
→ 200 { received: true }
```

### Usage

```
GET /api/v1/usage
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 {
     apiCalls: 4821,
     apiCallsLimit: 10000,
     storageBytes: 2048000,
     storageBytesLimit: 10737418240,
     periodStart: "2024-11-01",
     periodEnd: "2024-11-30"
   }
```

### Webhooks

```
GET /api/v1/webhooks
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 Array of WebhookEndpoint (secret redacted)

POST /api/v1/webhooks
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
@RequiresPlan(STARTER, GROWTH, ENTERPRISE)
Body: { url, events[] }
→ 201 WebhookEndpoint with secret (shown once only)

DELETE /api/v1/webhooks/:id
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 204 No content

GET /api/v1/webhooks/:id/deliveries
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 Array of WebhookDelivery (last 100)

POST /api/v1/webhooks/:id/deliveries/:deliveryId/retry
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 200 { queued: true }
```

### Audit Log

```
GET /api/v1/audit
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
Query: ?action=USER_INVITED&userId=xxx&from=2024-11-01&to=2024-11-30&limit=50&offset=0
→ 200 { logs: AuditLog[], total: 142 }
```

### Files

```
POST /api/v1/files/upload-url
Authorization: Bearer <token>
Body: { filename, mimeType, sizeBytes }
→ 200 { uploadUrl, fileId } — pre-signed S3 URL, client uploads directly

GET /api/v1/files
Authorization: Bearer <token>
→ 200 Array of TenantFile for the resolved tenant

DELETE /api/v1/files/:fileId
Authorization: Bearer <token>
@Roles(ADMIN, SUPERADMIN)
→ 204 No content
```

---

## Plan Limits

| Feature | FREE | STARTER | GROWTH | ENTERPRISE |
|---|---|---|---|---|
| API calls / month | 1,000 | 10,000 | 100,000 | Unlimited |
| Storage | 100 MB | 1 GB | 10 GB | Custom |
| Users | 5 | 25 | 100 | Unlimited |
| Webhook endpoints | — | 3 | 10 | Unlimited |
| Audit log retention | 7 days | 30 days | 1 year | Unlimited |
| Support | Community | Email | Priority | Dedicated |

---

## Project Structure

```
tenantcore/
├── prisma/
│   └── schema.prisma                   ← all models and relationships
├── src/
│   ├── middleware/
│   │   └── tenant.middleware.ts         ← tenant resolution on every request
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   ├── roles.guard.ts               ← @Roles() decorator enforcement
│   │   ├── plan.guard.ts                ← @RequiresPlan() decorator enforcement
│   │   └── usage-meter.guard.ts         ← quota check + Redis increment
│   ├── decorators/
│   │   ├── roles.decorator.ts
│   │   ├── require-plan.decorator.ts
│   │   └── current-tenant.decorator.ts
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts              ← login, signup, invite, password reset
│   │   ├── auth.controller.ts
│   │   ├── jwt.strategy.ts
│   │   └── jwt-auth.guard.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.service.ts             ← CRUD scoped to tenant
│   │   └── users.controller.ts
│   ├── tenants/
│   │   ├── tenants.module.ts
│   │   ├── tenants.service.ts
│   │   └── tenants.controller.ts
│   ├── billing/
│   │   ├── billing.module.ts
│   │   ├── billing.service.ts           ← Stripe subscription management
│   │   ├── billing.controller.ts
│   │   └── stripe-webhook.controller.ts ← handles Stripe webhook events
│   ├── webhooks/
│   │   ├── webhooks.module.ts
│   │   ├── webhooks.service.ts          ← endpoint CRUD, delivery dispatch
│   │   ├── webhooks.controller.ts
│   │   └── webhook-delivery.worker.ts   ← retry logic, exponential backoff
│   ├── usage/
│   │   ├── usage.module.ts
│   │   └── usage.service.ts             ← Redis counters, quota enforcement
│   ├── audit/
│   │   ├── audit.module.ts
│   │   ├── audit.service.ts             ← AuditLog writes and queries
│   │   └── audit.controller.ts
│   ├── files/
│   │   ├── files.module.ts
│   │   ├── files.service.ts             ← S3 pre-signed URLs, metadata
│   │   └── files.controller.ts
│   ├── email/
│   │   ├── email.module.ts
│   │   └── email.service.ts             ← SendGrid transactional email
│   ├── health/
│   │   └── health.module.ts
│   ├── app.module.ts                    ← root module, middleware wiring
│   └── main.ts                          ← bootstrap, global prefix, validation pipe
├── docker-compose.yml                   ← local PostgreSQL and Redis
├── .env.example
└── README.md
```

---

## Local Development

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL database (Supabase free tier works)
- Redis (Docker or Upstash free tier)
- Stripe account (test mode keys)
- SendGrid account (free tier)
- AWS S3 bucket (or use localstack)

### Setup

```bash
git clone https://github.com/mueed25/tenantcore.git
cd tenantcore
pnpm install
cp .env.example .env
```

Fill in `.env`:

```env
# Database
DATABASE_URL="postgresql://postgres.yourref:[PASSWORD]@aws-region.pooler.supabase.com:5432/postgres"

# Auth
JWT_SECRET="your-minimum-32-character-secret-string"

# App
NODE_ENV="development"
PORT=3000

# Redis
REDIS_URL="redis://localhost:6379"

# Stripe
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# SendGrid
SENDGRID_API_KEY="SG...."
SENDGRID_FROM_EMAIL="no-reply@yourdomain.com"

# AWS S3
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_REGION="us-east-1"
S3_BUCKET_NAME="tenantcore-uploads"
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
# Health check
curl http://localhost:3000/api/v1/health

# Create a tenant (also creates Stripe customer)
curl -X POST http://localhost:3000/api/v1/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp", "slug": "acme", "plan": "STARTER"}'

# Sign up a user
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Slug: acme" \
  -d '{"email": "admin@acme.com", "password": "SecurePass123!"}'

# Log in and get token
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Slug: acme" \
  -d '{"email": "admin@acme.com", "password": "SecurePass123!"}'

# Check usage
curl http://localhost:3000/api/v1/usage \
  -H "X-Tenant-Slug: acme" \
  -H "Authorization: Bearer <token>"
```

---

## Design Decisions

**Why not Supabase Auth directly?**
Supabase's client SDK would have the frontend talk directly to Supabase for authentication, bypassing NestJS entirely. This breaks the gatekeeper pattern — the entire security model depends on every request passing through tenant resolution and plan/usage guards before touching business logic. NestJS-issued JWTs keep the full request lifecycle server-controlled.

**Why shared schema instead of database-per-tenant?**
Database-per-tenant gives perfect isolation but makes cross-tenant analytics impossible, explodes infrastructure costs at scale, and complicates migrations. Shared schema with application-layer isolation delivers the isolation that matters at a fraction of the operational cost — the right tradeoff for most SaaS products at early to mid scale.

**Why Prisma over TypeORM?**
TypeORM requires verbose repository injection and entity classes. Prisma queries are plain function calls with full TypeScript inference — `prisma.tenant.findUnique()` autocompletes all fields and relationships at the call site. Schema changes flow through one `.prisma` file and one migration command.

**Why Redis for usage metering instead of database counters?**
A database increment on every API call would add a write to every request at the database layer — contention, latency, and IOPS cost. Redis `INCR` is atomic, sub-millisecond, and doesn't touch PostgreSQL. The usage counter is periodically flushed to the database for billing and reporting; the hot path stays in Redis.

**Why per-tenant webhook secrets?**
A shared signing secret would mean that if one tenant's secret leaked, all tenants' webhooks would be compromised. Per-endpoint HMAC secrets scope the blast radius to a single integration and allow rotation without affecting other tenants.

**Why pre-signed S3 URLs instead of proxying uploads?**
Routing file uploads through the API server wastes bandwidth, memory, and compute on data transfer the server doesn't need to see. Pre-signed URLs let clients upload directly to S3 at full speed; the API only handles metadata before and after, keeping latency and infrastructure cost low.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret — minimum 32 characters |
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | No | Server port, defaults to 3000 |
| `REDIS_URL` | Yes | Redis connection string |
| `STRIPE_SECRET_KEY` | Yes | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `SENDGRID_API_KEY` | Yes | SendGrid API key for transactional email |
| `SENDGRID_FROM_EMAIL` | Yes | Verified sender address |
| `AWS_ACCESS_KEY_ID` | Yes | AWS credentials for S3 access |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS credentials for S3 access |
| `AWS_REGION` | Yes | AWS region for S3 bucket |
| `S3_BUCKET_NAME` | Yes | S3 bucket name for tenant file storage |

---

## License

MIT
