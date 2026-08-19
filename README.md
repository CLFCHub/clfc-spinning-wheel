# CLFC Spinning Wheel

Production-ready Cloudflare Worker + D1 spinning-wheel application for CLFC.

## Repository Structure

```text
CLFC-Spin-Wheel/
├── _worker.js                    ← Cloudflare Worker logic
├── index.html                  ← Frontend dashboard
├── wrangler.toml               ← Cloudflare configuration
├── package.json                ← Dependencies and scripts
├── README.md                   ← This file
└── sql/
    ├── verify.sql              ← Schema verification checks
    └── create-wheel-spins.sql  ← Database setup
```

## Setup & Deployment

1. **Database Initialization**: Run the following SQL in your Cloudflare D1 console to create the history table:
   ```bash
   npx wrangler d1 execute clfchub --remote --file=sql/create-wheel-spins.sql
   ```

2. **Schema Verification**: Run the verification script to ensure your `members` and `roster_players` tables are correct:
   ```bash
   npx wrangler d1 execute clfchub --remote --file=sql/verify.sql
   ```

3. **Deployment**:
   - Link this repository to your Cloudflare account.
   - Ensure the D1 database `199c7c5a-b202-4439-9401-4c2f27e33ea5` is bound as `DB`.
   - Deploy via Cloudflare Pages or `npm run deploy`.

## Features

- **D1 Relational Logic**: PIN lookup in `members`, wheel population from `roster_players`.
- **Atomic Concurrency**: One-spin-per-user and one-win-per-player enforced via D1 unique constraints.
- **4-Grade Dashboard**: Persistent history columns for League, Reserves, Colts, and Thirds.
- **PayID Ready**: Integrated instructions for payments to `payment.payidme@gmail.com`.
- **Non-Destructive**: Winners are filtered out of the wheel but remain in the roster table.
