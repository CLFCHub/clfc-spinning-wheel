const GRADES = ["league", "reserves", "colts", "thirds"];
const SPIN_DURATION_MS = 3200;

const cors = env => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
});

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

function grade(v) {
  v = String(v || "").toLowerCase().trim();
  return GRADES.includes(v) ? v : null;
}

function pin(v) {
  v = String(v || "").trim();
  return /^\d{4}$/.test(v) ? v : null;
}

async function ensureTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS wheel_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grade TEXT NOT NULL,
      spinner_uid TEXT NOT NULL,
      spinner_name TEXT NOT NULL,
      winner_uid TEXT NOT NULL,
      winner_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(grade, spinner_uid),
      UNIQUE(grade, winner_uid)
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wheel_spins_grade ON wheel_spins(grade)`).run();
}

async function getFullRoster(db, g) {
  const { results } = await db.prepare(
    "SELECT playhq_uid, name FROM roster_players WHERE LOWER(TRIM(grade)) = ? AND playhq_uid IS NOT NULL AND name IS NOT NULL"
  ).bind(g).all();
  return results || [];
}

async function getSpunUIDs(db, g) {
  const { results } = await db.prepare(
    "SELECT winner_uid FROM wheel_spins WHERE LOWER(grade) = ?"
  ).bind(g).all();
  return new Set((results || []).map(r => r.winner_uid));
}

async function getAllHistory(db) {
  const { results } = await db.prepare(
    "SELECT * FROM wheel_spins ORDER BY created_at ASC"
  ).all();
  return results || [];
}

async function handleState(request, env) {
  const g = grade(new URL(request.url).searchParams.get("grade"));
  if (!g) return json({ error: "Invalid grade." }, 400, cors(env));

  await ensureTable(env.DB);
  const fullRoster = await getFullRoster(env.DB, g);
  const spunUIDs = await getSpunUIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p => !spunUIDs.has(p.playhq_uid));
  const history = await getAllHistory(env.DB);

  return json({
    grade: g,
    wheel: activeWheel,
    history,
    spin_duration_ms: SPIN_DURATION_MS,
    roster_empty: fullRoster.length === 0
  }, 200, cors(env));
}

async function handleVerify(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade), p = pin(b.pin);
  if (!g || !p) return json({ allowed: false, message: "Enter a valid grade and 4-digit PIN." }, 400, cors(env));

  await ensureTable(env.DB);
  
  // PIN lookup in members table
  const spinner = await env.DB.prepare(
    "SELECT playhq_uid, name FROM members WHERE CAST(pin AS TEXT) = ?"
  ).bind(p).first();

  if (!spinner) return json({ allowed: false, message: "PIN not found in members list." }, 401, cors(env));

  const fullRoster = await getFullRoster(env.DB, g);
  if (!fullRoster.length) return json({ allowed: false, reason: "empty", message: "No teams named yet." }, 200, cors(env));

  const spunUIDs = await getSpunUIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p => !spunUIDs.has(p.playhq_uid));

  if (fullRoster.some(x => x.playhq_uid === spinner.playhq_uid)) {
    return json({ allowed: false, reason: "self_on_wheel", message: "You can't spin this wheel because your name is on it." }, 200, cors(env));
  }

  const alreadySpun = await env.DB.prepare(
    "SELECT 1 FROM wheel_spins WHERE LOWER(grade) = ? AND spinner_uid = ?"
  ).bind(g, spinner.playhq_uid).first();

  if (alreadySpun) {
    return json({ allowed: false, reason: "already_spun", message: "You have already used your spin for this grade." }, 200, cors(env));
  }

  if (!activeWheel.length) {
    return json({ allowed: false, reason: "all_spun", message: "All players have already been spun for this grade." }, 200, cors(env));
  }

  return json({ allowed: true, spinner, grade: g }, 200, cors(env));
}

async function handleSpin(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade), p = pin(b.pin);
  if (!g || !p) return json({ error: "Invalid grade or PIN." }, 400, cors(env));

  await ensureTable(env.DB);

  const spinner = await env.DB.prepare(
    "SELECT playhq_uid, name FROM members WHERE CAST(pin AS TEXT) = ?"
  ).bind(p).first();

  if (!spinner) return json({ error: "PIN not found." }, 401, cors(env));

  const alreadySpun = await env.DB.prepare(
    "SELECT 1 FROM wheel_spins WHERE LOWER(grade) = ? AND spinner_uid = ?"
  ).bind(g, spinner.playhq_uid).first();
  if (alreadySpun) return json({ error: "You have already used your spin for this grade." }, 409, cors(env));

  const fullRoster = await getFullRoster(env.DB, g);
  const spunUIDs = await getSpunUIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p => !spunUIDs.has(p.playhq_uid));

  if (!activeWheel.length) return json({ error: "No players remaining on the wheel." }, 409, cors(env));
  if (fullRoster.some(x => x.playhq_uid === spinner.playhq_uid)) {
    return json({ error: "You are on the team sheet and cannot spin." }, 403, cors(env));
  }

  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const i = Math.floor((a[0] / 4294967296) * activeWheel.length);
  const winner = activeWheel[i];

  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO wheel_spins (grade, spinner_uid, spinner_name, winner_uid, winner_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(g, spinner.playhq_uid, spinner.name, winner.playhq_uid, winner.name, createdAt).run();

  return json({
    success: true,
    result: {
      spinner_uid: spinner.playhq_uid,
      spinner_name: spinner.name,
      winner_uid: winner.playhq_uid,
      winner_name: winner.name,
      winner_index: i,
      wheel_size: activeWheel.length
    },
    spin_duration_ms: SPIN_DURATION_MS
  }, 200, cors(env));
}

async function route(request, env) {
  const u = new URL(request.url);
  const path = u.pathname.replace(/\/$/, "");

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
  if (request.method === "GET" && path === "/api/state") return handleState(request, env);
  if (request.method === "GET" && path === "/api/history") {
    await ensureTable(env.DB);
    return json({ history: await getAllHistory(env.DB) }, 200, cors(env));
  }
  if (request.method === "POST" && path === "/api/verify") return handleVerify(request, env);
  if (request.method === "POST" && path === "/api/spin") return handleSpin(request, env);
  
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  
  return json({ error: "Not found." }, 404, cors(env));
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error("Database binding 'DB' is missing.");
      return await route(request, env);
    } catch (e) {
      return json({ error: "Server error.", message: e.message, stack: e.stack }, 500, cors(env));
    }
  }
};
