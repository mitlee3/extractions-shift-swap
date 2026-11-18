// Keep legacy server queries compatible with the current schedule columns and request-card data.
const { Pool, Client } = require('pg');

// Rewrite known SQL shapes to read/write current schedule details from the schema's authoritative tables.
function normalizeScheduleQuery(query) {
  const text = typeof query === 'string' ? query : query?.text;
  if (typeof text !== 'string') return query;

  let normalized = text.replace(/h\.position,\s*h\.shift_number,\s*c\.schedule_id/g, 'c.position, c.shift_number, c.schedule_id');

  // On profile creation, copy position and shift from the newly inserted history row into the current row.
  normalized = normalized.replace(
    /INSERT INTO "UserScheduleCurrent" \(user_id, schedule_id\) VALUES \(\$1, \$2\) ON CONFLICT \(user_id\) DO UPDATE SET schedule_id = EXCLUDED\.schedule_id, created_at = CURRENT_TIMESTAMP/i,
    'INSERT INTO "UserScheduleCurrent" (user_id, position, shift_number, schedule_id) SELECT $1, h.position, h.shift_number, $2 FROM "UserScheduleHistory" h WHERE h.schedule_id = $2 AND h.user_id = $1 ON CONFLICT (user_id) DO UPDATE SET position = EXCLUDED.position, shift_number = EXCLUDED.shift_number, schedule_id = EXCLUDED.schedule_id, created_at = CURRENT_TIMESTAMP',
  );

  // When profile settings create a new history row, update the active current row from that exact history version.
  normalized = normalized.replace(
    /UPDATE "UserScheduleCurrent" SET schedule_id = \$2, created_at = CURRENT_TIMESTAMP WHERE user_id = \$1/i,
    'UPDATE "UserScheduleCurrent" c SET schedule_id = $2, position = h.position, shift_number = h.shift_number, created_at = CURRENT_TIMESTAMP FROM "UserScheduleHistory" h WHERE c.user_id = $1 AND h.user_id = c.user_id AND h.schedule_id = $2',
  );

  // Add schedule position and recurring weekdays to open-request records for compatibility cards.
  normalized = normalized.replace(
    "NULL::text AS offering_name, 'Open' AS status\n      FROM \"ShiftSwapsOpen\" r JOIN \"User\" requester ON requester.id = r.person_requesting",
    "NULL::text AS offering_name, 'Open' AS status, requester_schedule.position AS requester_position, ARRAY(SELECT day.day_of_week FROM \"UserScheduleDays\" day WHERE day.schedule_id = r.requester_schedule_id ORDER BY day.day_of_week)::integer[] AS requester_shift_days\n      FROM \"ShiftSwapsOpen\" r JOIN \"User\" requester ON requester.id = r.person_requesting JOIN \"UserScheduleHistory\" requester_schedule ON requester_schedule.schedule_id = r.requester_schedule_id AND requester_schedule.user_id = r.person_requesting",
  );

  // Preserve UNION column alignment by attaching the historical requester schedule to completed swaps too.
  normalized = normalized.replace(
    "offering.first_name || ' ' || offering.last_name AS offering_name, h.status\n      FROM \"ShiftSwapsHistory\" h",
    "offering.first_name || ' ' || offering.last_name AS offering_name, h.status, requester_schedule.position AS requester_position, ARRAY(SELECT day.day_of_week FROM \"UserScheduleDays\" day WHERE day.schedule_id = h.requester_schedule_id ORDER BY day.day_of_week)::integer[] AS requester_shift_days\n      FROM \"ShiftSwapsHistory\" h",
  );
  normalized = normalized.replace(
    'JOIN "User" requester ON requester.id = h.person_requesting\n      JOIN "User" offering ON offering.id = h.person_offering',
    'JOIN "User" requester ON requester.id = h.person_requesting\n      JOIN "UserScheduleHistory" requester_schedule ON requester_schedule.schedule_id = h.requester_schedule_id AND requester_schedule.user_id = h.person_requesting\n      JOIN "User" offering ON offering.id = h.person_offering',
  );

  if (typeof query === 'string') return normalized;
  return { ...query, text: normalized };
}

// Apply the SQL compatibility layer to both pooled queries and checked-out transaction clients.
for (const DatabaseClient of [Pool, Client]) {
  const originalQuery = DatabaseClient.prototype.query;
  DatabaseClient.prototype.query = function queryWithCurrentSchedule(query, ...args) {
    return originalQuery.call(this, normalizeScheduleQuery(query), ...args);
  };
}
