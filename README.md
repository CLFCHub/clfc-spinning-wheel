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
   - Link this repository to your Cloudflare account via Cloudflare Pages.
   - In your Cloudflare dashboard, go to **Settings > Functions > D1 Database Bindings** and bind your D1 database using the variable name **`DB`**.
   - Deploy via Cloudflare Pages.

## Features

- **D1 Relational Logic**: PIN lookup in `members`, wheel population from `roster_players`.
- **Atomic Concurrency**: One-spin-per-user and one-win-per-player enforced via D1 unique constraints.
- **4-Grade Dashboard**: Persistent history columns for League, Reserves, Colts, and Thirds.
- **Acknowledgement Check**: Integrated acknowledgement for the $5 spin fee.
- **Non-Destructive**: Winners are filtered out of the wheel but remain in the roster table.
