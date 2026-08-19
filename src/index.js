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
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }
  });

function grade(v) {
  v = String(v || "").toLowerCase().trim();
  return GRADES.includes(v) ? v : null;
}

function pin(v) {
  v = String(v || "").trim();
  return /^\d{4}$/.test(v) ? v : null;
}

export class WheelState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return json({ error: "Durable Object active" });
  }
}

async function getRoster(db, g) {
  const { results } = await db.prepare(
    "SELECT playerhq_uid, name FROM roster_players WHERE LOWER(grade) = ?"
  ).bind(g).all();
  return results || [];
}

async function getHistory(db, g) {
  const { results } = await db.prepare(
    "SELECT * FROM spin_history WHERE LOWER(grade) = ? ORDER BY created_at ASC"
  ).bind(g).all();
  return results || [];
}

async function handleState(request, env) {
  const g = grade(new URL(request.url).searchParams.get("grade"));
  if (!g) return json({ error: "Invalid grade." }, 400);

  const wheel = await getRoster(env.DB, g);
  const history = await getHistory(env.DB, g);

  return json({
    grade: g,
    wheel: wheel.map(p => ({ playerhq_uid: p.playerhq_uid, name: p.name })),
    history,
    spin_duration_ms: SPIN_DURATION_MS
  });
}

async function handleVerify(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade), p = pin(b.pin);
  if (!g || !p) return json({ allowed: false, message: "Enter a valid grade and 4-digit PIN." }, 400);

  // Find spinner in members
  const memberRes = await env.DB.prepare(
    "SELECT playerhq_uid, name FROM members WHERE pin = ?"
  ).bind(p).first();

  if (!memberRes) return json({ allowed: false, message: "That PIN could not be verified." }, 401);
  const spinner = memberRes;

  const wheel = await getRoster(env.DB, g);
  if (!wheel.length) return json({ allowed: false, reason: "empty", message: "No team named this week." });

  if (wheel.some(x => x.playerhq_uid === spinner.playerhq_uid)) {
    return json({ allowed: false, reason: "self_on_wheel", message: "You are on the team sheet for this grade and cannot spin this wheel." });
  }

  // Check history
  const historyRes = await env.DB.prepare(
    "SELECT 1 FROM spin_history WHERE LOWER(grade) = ? AND spinner_uid = ?"
  ).bind(g, spinner.playerhq_uid).first();

  if (historyRes) {
    return json({ allowed: false, reason: "already_spun", message: "You have already used your spin for this grade." });
  }

  return json({ allowed: true, spinner: { playerhq_uid: spinner.playerhq_uid, name: spinner.name }, grade: g });
}

async function handleSpin(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade), p = pin(b.pin);
  if (!g || !p) return json({ error: "Invalid grade or PIN." }, 400);

  const memberRes = await env.DB.prepare(
    "SELECT playerhq_uid, name FROM members WHERE pin = ?"
  ).bind(p).first();

  if (!memberRes) return json({ error: "That PIN could not be verified." }, 401);
  const spinner = memberRes;

  const historyRes = await env.DB.prepare(
    "SELECT 1 FROM spin_history WHERE LOWER(grade) = ? AND spinner_uid = ?"
  ).bind(g, spinner.playerhq_uid).first();

  if (historyRes) return json({ error: "You have already used your spin for this grade." }, 409);

  const wheel = await getRoster(env.DB, g);
  if (!wheel.length) return json({ error: "No team named this week." }, 409);

  if (wheel.some(x => x.playerhq_uid === spinner.playerhq_uid)) {
    return json({ error: "You can't spin this wheel because your name is on it.", message: "You are on the team sheet for this grade and cannot spin this wheel." }, 403);
  }

  // Pick winner using crypto.getRandomValues
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const i = Math.floor((a[0] / 4294967296) * wheel.length);
  const winner = wheel[i];

  const recordId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const paymentRef = `${spinner.name} (PayID)`;

  // Insert history and remove winner from roster_players
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO spin_history (id, grade, spinner_uid, spinner_name, winner_uid, winner_name, payment_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(recordId, g, spinner.playerhq_uid, spinner.name, winner.playerhq_uid, winner.name, paymentRef, createdAt),
    env.DB.prepare(
      "DELETE FROM roster_players WHERE LOWER(grade) = ? AND playerhq_uid = ?"
    ).bind(g, winner.playerhq_uid)
  ]);

  return json({
    success: true,
    result: {
      spinner_uid: spinner.playerhq_uid,
      spinner_name: spinner.name,
      winner_uid: winner.playerhq_uid,
      winner_name: winner.name,
      winner_index: i,
      wheel_size: wheel.length
    },
    spin_duration_ms: SPIN_DURATION_MS
  });
}

async function handleMockup(request, env) {
  const b = await request.json().catch(() => ({}));
  const g = grade(b.grade);
  if (!g) return json({ error: "Invalid grade." }, 400);

  // Get random 22 members
  const { results: members } = await env.DB.prepare(
    "SELECT playerhq_uid, name FROM members ORDER BY RANDOM() LIMIT 22"
  ).all();

  if (!members || !members.length) return json({ error: "No members found in D1 to mock up." }, 400);

  // Clear existing roster for grade and insert mock
  const statements = [
    env.DB.prepare("DELETE FROM roster_players WHERE LOWER(grade) = ?").bind(g)
  ];

  for (const m of members) {
    statements.push(
      env.DB.prepare("INSERT INTO roster_players (grade, playerhq_uid, name) VALUES (?, ?, ?)").bind(g, m.playerhq_uid, m.name)
    );
  }

  await env.DB.batch(statements);

  return json({ success: true, message: `Successfully mocked up ${members.length} players for ${g.toUpperCase()}.` });
}

async function route(request, env) {
  const u = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
  if (request.method === "GET" && u.pathname === "/api/state") return handleState(request, env);
  if (request.method === "GET" && u.pathname === "/api/history") return handleState(request, env);
  if (request.method === "POST" && u.pathname === "/api/verify") return handleVerify(request, env);
  if (request.method === "POST" && u.pathname === "/api/spin") return handleSpin(request, env);
  if (request.method === "POST" && u.pathname === "/api/admin/mockup") return handleMockup(request, env);
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const r = await route(request, env);
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(cors(env))) h.set(k, v);
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      console.error(e);
      return json({ error: "Server error.", detail: env.DEBUG === "true" ? e.message : undefined }, 500, cors(env));
    }
  }
};
