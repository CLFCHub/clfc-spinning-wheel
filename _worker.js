const GRADES = ["league", "reserves", "colts", "thirds"];
const SPIN_DURATION_MS = 3200;

const cors = (env, request) => {
  const origin = request ? request.headers.get("Origin") : null;
  return {
    "access-control-allow-origin": origin || env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "86400"
  };
};

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

function checkPasscode(env, passcode) {
  const expected = env.ADMIN_PASSCODE || "";
  return !!expected && String(passcode || "") === expected;
}

async function ensureTable(db) {
  // Table should already exist from migration, but we keep this for safety
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS wheel_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grade TEXT NOT NULL,
      spinner_id INTEGER NOT NULL,
      spinner_name TEXT NOT NULL,
      winner_id INTEGER NOT NULL,
      winner_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      spinner_uid TEXT,
      winner_uid TEXT,
      FOREIGN KEY (spinner_id) REFERENCES members(id),
      FOREIGN KEY (winner_id) REFERENCES members(id)
    )
  `).run();
}

async function ensureDeclarationsTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS grade_declarations (grade TEXT PRIMARY KEY, scorer_name TEXT, spinner_name TEXT, declared_at TEXT)"
  ).run();
}

async function getDeclaration(db, g) {
  await ensureDeclarationsTable(db);
  return await db.prepare("SELECT * FROM grade_declarations WHERE grade = ?").bind(g).first();
}

/**
 * Get all active players on roster.
 * Uses COALESCE to ensure we have an ID even for unlinked mock players.
 */
async function getFullRoster(db, g) {
  const { results } = await db.prepare(
    "SELECT COALESCE(id, playhq_uid) as id, name FROM roster_players WHERE LOWER(TRIM(grade)) = ?"
  ).bind(g).all();
  return results || [];
}

/**
 * Get set of member IDs/UIDs who have already won
 */
async function getSpunIDs(db, g) {
  const { results } = await db.prepare(
    "SELECT DISTINCT winner_id, winner_uid FROM wheel_spins WHERE LOWER(grade) = ?"
  ).bind(g).all();
  const spun = new Set();
  (results || []).forEach(r => {
    if (r.winner_id) spun.add(String(r.winner_id));
    if (r.winner_uid) spun.add(String(r.winner_uid));
  });
  return spun;
}

async function getAllHistory(db) {
  const { results } = await db.prepare(
    "SELECT id, grade, spinner_id, spinner_name, winner_id, winner_name, created_at FROM wheel_spins ORDER BY created_at ASC"
  ).all();
  return results || [];
}

async function handleState(request, env) {
  const g = grade(new URL(request.url).searchParams.get("grade"));
  if (!g) return json({ error: "Invalid grade." }, 400, cors(env, request));
  
  await ensureTable(env.DB);
  const fullRoster = await getFullRoster(env.DB, g);
  const spunIDs = await getSpunIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p => !spunIDs.has(String(p.id)));
  const history = await getAllHistory(env.DB);
  const declarationRow = await getDeclaration(env.DB, g);

  return json({
    grade: g,
    wheel: activeWheel,
    history,
    spin_duration_ms: SPIN_DURATION_MS,
    roster_empty: fullRoster.length === 0,
    active_count: activeWheel.length,
    spun_count: fullRoster.length - activeWheel.length,
    declaration: declarationRow ? {
      scorer_name: declarationRow.scorer_name,
      spinner_name: declarationRow.spinner_name,
      declared_at: declarationRow.declared_at
    } : null
  }, 200, cors(env, request));
}

async function handleVerify(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade);
  const p = pin(b.pin);

  if (!g || !p) {
    return json({ allowed: false, message: "Enter a valid grade and 4-digit PIN." }, 400, cors(env, request));
  }

  await ensureTable(env.DB);

  const spinner = await env.DB.prepare(
    "SELECT id, name, playhq_uid FROM members WHERE CAST(pin AS TEXT) = ?"
  ).bind(p).first();

  if (!spinner) {
    return json({ allowed: false, message: "PIN not found in members list." }, 401, cors(env, request));
  }

  const spinnerId = spinner.id !== undefined ? spinner.id : spinner.ID;
  const spinnerName = spinner.name !== undefined ? spinner.name : spinner.NAME;

  const declarationRow = await getDeclaration(env.DB, g);
  if (declarationRow) {
    return json({ allowed: false, reason: "declared", message: "The first goal scorer has already been declared for this grade." }, 200, cors(env, request));
  }

  const fullRoster = await getFullRoster(env.DB, g);
  if (!fullRoster.length) {
    return json({ allowed: false, reason: "empty", message: "No teams named yet." }, 200, cors(env, request));
  }

  // Self-exclusion check: Check both ID and Name to be robust
  const onRoster = fullRoster.some(x => 
    String(x.id) === String(spinnerId) || 
    String(x.name).toLowerCase().trim() === String(spinnerName).toLowerCase().trim()
  );

  if (onRoster) {
    return json({ allowed: false, reason: "self_on_wheel", message: "You can't spin your own team." }, 200, cors(env, request));
  }

  const alreadySpun = await env.DB.prepare(
    "SELECT 1 FROM wheel_spins WHERE LOWER(grade) = ? AND spinner_id = ?"
  ).bind(g, spinnerId).first();

  if (alreadySpun) {
    return json({ allowed: false, reason: "already_spun", message: "You have already used your spin for this grade." }, 200, cors(env, request));
  }

  const spunIDs = await getSpunIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p2 => !spunIDs.has(String(p2.id)));

  if (!activeWheel.length) {
    return json({ allowed: false, reason: "all_spun", message: "All players have already been spun for this grade." }, 200, cors(env, request));
  }

  return json({ allowed: true, spinner: { id: spinnerId, name: spinnerName }, grade: g }, 200, cors(env, request));
}

async function handleSpin(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade);
  const p = pin(b.pin);

  if (!g || !p) {
    return json({ error: "Invalid grade or PIN." }, 400, cors(env, request));
  }

  await ensureTable(env.DB);

  const spinner = await env.DB.prepare(
    "SELECT id, name, playhq_uid FROM members WHERE CAST(pin AS TEXT) = ?"
  ).bind(p).first();

  if (!spinner) {
    return json({ error: "PIN not found." }, 401, cors(env, request));
  }

  // Handle potential case-sensitivity issues with D1 returning uppercase ID
  const spinnerId = spinner.id !== undefined ? spinner.id : spinner.ID;
  const spinnerName = spinner.name !== undefined ? spinner.name : spinner.NAME;
  const spinnerUid = spinner.playhq_uid !== undefined ? spinner.playhq_uid : spinner.PLAYHQ_UID;

  if (!spinnerId) {
    return json({ error: "Member record is missing a canonical ID. Contact admin." }, 500, cors(env, request));
  }

  const alreadySpun = await env.DB.prepare(
    "SELECT 1 FROM wheel_spins WHERE LOWER(grade) = ? AND spinner_id = ?"
  ).bind(g, spinnerId).first();

  if (alreadySpun) {
    return json({ error: "You have already used your spin for this grade." }, 409, cors(env, request));
  }

  const fullRoster = await getFullRoster(env.DB, g);
  
  // Self-exclusion check
  const onRoster = fullRoster.some(x => 
    String(x.id) === String(spinnerId) || 
    String(x.name).toLowerCase().trim() === String(spinnerName).toLowerCase().trim()
  );

  if (onRoster) {
    return json({ error: "You can't spin your own team." }, 403, cors(env, request));
  }

  const spunIDs = await getSpunIDs(env.DB, g);
  const activeWheel = fullRoster.filter(p2 => !spunIDs.has(String(p2.id)));

  if (!activeWheel.length) {
    return json({ error: "No players remaining on the wheel." }, 409, cors(env, request));
  }

  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const i = Math.floor((a[0] / 4294967296) * activeWheel.length);
  const winner = activeWheel[i];
  const createdAt = new Date().toISOString();

  // If winner.id is not a number (e.g. mock UID), we store 0 in winner_id 
  // and the string in winner_uid. The trigger or manual insert will handle it.
  const wId = winner.id !== undefined ? winner.id : winner.ID;
  const wName = winner.name !== undefined ? winner.name : winner.NAME;

  const winnerId = isNaN(parseInt(wId)) ? 0 : parseInt(wId);
  const winnerUid = isNaN(parseInt(wId)) ? String(wId) : null;

  try {
    await env.DB.prepare(
      "INSERT INTO wheel_spins (grade, spinner_id, spinner_name, winner_id, winner_name, created_at, spinner_uid, winner_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      g, 
      spinnerId, 
      spinnerName, 
      winnerId, 
      wName, 
      createdAt, 
      spinnerUid || null, 
      winnerUid
    ).run();
  } catch (e) {
    console.error("Insert failed:", e);
    return json({ 
      error: "Database error during spin.", 
      message: e.message,
      debug: { spinnerId, winnerId, winnerName: winner.name }
    }, 500, cors(env, request));
  }

  return json({
    success: true,
    result: {
      spinner_id: spinnerId,
      spinner_name: spinnerName,
      winner_id: winnerId,
      winner_name: winner.name,
      winner_index: i,
      wheel_size: activeWheel.length
    },
    spin_duration_ms: SPIN_DURATION_MS
  }, 200, cors(env, request));
}

async function handleAdminClearSpins(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade);
  if (!g) return json({ error: "Invalid grade." }, 400, cors(env, request));
  if (!checkPasscode(env, b.passcode)) return json({ error: "Invalid passcode." }, 401, cors(env, request));
  
  await ensureTable(env.DB);
  await ensureDeclarationsTable(env.DB);
  await env.DB.prepare("DELETE FROM wheel_spins WHERE LOWER(grade) = ?").bind(g).run();
  await env.DB.prepare("DELETE FROM grade_declarations WHERE grade = ?").bind(g).run();
  return json({ success: true, grade: g }, 200, cors(env, request));
}

async function handleAdminDeclareWinner(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade);
  const scorer = String(b.scorer_name || "").trim();
  if (!g) return json({ error: "Invalid grade." }, 400, cors(env, request));
  if (!scorer) return json({ error: "Enter the first goal scorer's name." }, 400, cors(env, request));
  if (!checkPasscode(env, b.passcode)) return json({ error: "Invalid passcode." }, 401, cors(env, request));

  await ensureTable(env.DB);
  const spinRow = await env.DB.prepare(
    "SELECT spinner_name, winner_name FROM wheel_spins WHERE LOWER(grade) = ? AND LOWER(winner_name) = LOWER(?)"
  ).bind(g, scorer).first();

  if (!spinRow) {
    return json({ error: "No one has spun and picked that player for this grade yet." }, 404, cors(env, request));
  }

  await ensureDeclarationsTable(env.DB);
  const declaredAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO grade_declarations (grade, scorer_name, spinner_name, declared_at) VALUES (?, ?, ?, ?) ON CONFLICT(grade) DO UPDATE SET scorer_name = excluded.scorer_name, spinner_name = excluded.spinner_name, declared_at = excluded.declared_at"
  ).bind(g, spinRow.winner_name, spinRow.spinner_name, declaredAt).run();

  return json({
    success: true,
    grade: g,
    scorer_name: spinRow.winner_name,
    spinner_name: spinRow.spinner_name
  }, 200, cors(env, request));
}

async function route(request, env) {
  const u = new URL(request.url);
  const path = u.pathname.replace(/\/$/, "");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(env, request) });
  }

  if (request.method === "GET" && path === "/api/state") return handleState(request, env);
  if (request.method === "GET" && path === "/api/history") {
    await ensureTable(env.DB);
    return json({ history: await getAllHistory(env.DB) }, 200, cors(env, request));
  }
  if (request.method === "POST" && path === "/api/verify") return handleVerify(request, env);
  if (request.method === "POST" && path === "/api/spin") return handleSpin(request, env);
  if (request.method === "POST" && path === "/api/admin/clear-spins") return handleAdminClearSpins(request, env);
  if (request.method === "POST" && path === "/api/admin/declare-winner") return handleAdminDeclareWinner(request, env);

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  return json({ error: "Not found." }, 404, cors(env, request));
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error("Database binding 'DB' is missing.");
      return await route(request, env);
    } catch (e) {
      console.error(e);
      return json({
        error: "Server error.",
        message: e.message,
        cause: e.cause ? e.cause.message : void 0
      }, 500, cors(env, request));
    }
  }
};
