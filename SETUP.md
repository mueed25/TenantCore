# TenantCore — Setup Guide

## Step 1: Create project on your machine

```bash
mkdir tenantcore
cd tenantcore
git init
```

## Step 2: Copy these files into your project

Create this folder structure:
```
tenantcore/
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── prisma/
│   └── schema.prisma
└── src/
    ├── main.ts
    ├── app.module.ts
    ├── health/
    │   └── health.module.ts
    ├── tenants/
    │   └── tenants.module.ts
    └── middleware/
        └── tenant.middleware.ts
```

## Step 3: Install dependencies

```bash
npm install
```

## Step 4: Copy .env.example to .env

```bash
cp .env.example .env
```

Edit .env — the DATABASE_URL is already filled for local dev. Leave AWS empty for now.

## Step 5: Start the database

```bash
docker compose up -d postgres redis
```

Wait 10 seconds for postgres to be ready.

## Step 6: Generate Prisma client and push schema

```bash
npx prisma generate
npx prisma db push
```

## Step 7: Start the server

```bash
npm run start:dev
```

## Step 8: Test it works

Open browser or use curl:
```bash
curl http://localhost:3000/health
# Should return: {"status":"ok","timestamp":"..."}
```

Create a tenant:
```bash
curl -X POST http://localhost:3000/api/v1/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Company", "slug": "test-company"}'
```

Get the tenant:
```bash
curl http://localhost:3000/api/v1/tenants/test-company
```

Test tenant middleware:
```bash
curl http://localhost:3000/api/v1/tenants/test-company/users \
  -H "X-Tenant-Slug: test-company"
```

## ✅ Week 1 Done When:
- [ ] Docker running (postgres + redis)
- [ ] NestJS server starts without errors
- [ ] Health check returns OK
- [ ] Can create a tenant
- [ ] Can fetch a tenant by slug
- [ ] Tenant middleware resolves from X-Tenant-Slug header

## Next Week: Add Supabase auth + guards
