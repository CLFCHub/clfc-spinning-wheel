# CLFC Spinning Wheel

Production Cloudflare Worker & Frontend for CLFC Spinning Wheel raffle system tied to Cloudflare D1.

## Features

- **Direct D1 Integration**: Reads strictly from the `roster_players` table. If empty, correctly displays **"No team named this week."**
- **Admin Mock-Up Trigger**: Allows you to instantly populate any grade's wheel with 22 random members from your D1 `members` table.
- **Self-Wheel Prevention**: Verifies the spinner's PIN against D1 and blocks them from spinning if their UID is currently on that grade's wheel.
- **PayID Payment Flow**: Directs payments to `payment.payidme@gmail.com` with name referencing before unlocking the spin.
- **Atomic Concurrency & History**: Logs all spin histories and removes winning players from the roster instantly.

## Deployment

1. Clone or connect repository in Cloudflare Workers & Pages.
2. Ensure your D1 database (`199c7c5a-b202-4439-9401-4c2f27e33ea5`) is bound to the Worker as `DB`.
3. Deploy!
