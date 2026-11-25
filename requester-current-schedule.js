// Add current-schedule details to shift-request rows using UserScheduleCurrent.
// This query wrapper changes only the dashboard request query.
const { Pool, Client } = require('pg');

function addRequesterCurrentSchedule(query) {
  const text = typeof query === 'string' ? query : query?.text;
  // Pool queries can pass through both Pool and Client wrappers; avoid adding the join twice.
  if (typeof text !== 'string' || !text.includes('FROM "ShiftSwapsOpen" r') || text.includes('requester_current')) return query;

  const normalized = text
    .replace(
      "NULL::text AS offering_name, 'Open' AS status",
      `NULL::text AS offering_name, 'Open' AS status,
             requester_current.position AS requester_position,
             ARRAY(SELECT day.day_of_week FROM "UserScheduleDays" day WHERE day.schedule_id = requester_current.schedule_id ORDER BY day.day_of_week)::integer[] AS requester_shift_days`,
    )
    .replace(
      "offering.first_name || ' ' || offering.last_name AS offering_name, h.status",
      `offering.first_name || ' ' || offering.last_name AS offering_name, h.status,
             requester_current.position AS requester_position,
             ARRAY(SELECT day.day_of_week FROM "UserScheduleDays" day WHERE day.schedule_id = requester_current.schedule_id ORDER BY day.day_of_week)::integer[] AS requester_shift_days`,
    )
    .replace(
      'FROM "ShiftSwapsOpen" r JOIN "User" requester ON requester.id = r.person_requesting',
      'FROM "ShiftSwapsOpen" r JOIN "User" requester ON requester.id = r.person_requesting\n      JOIN "UserScheduleCurrent" requester_current ON requester_current.user_id = requester.id',
    )
    .replace(
      'JOIN "User" requester ON requester.id = h.person_requesting\n      JOIN "User" offering ON offering.id = h.person_offering',
      'JOIN "User" requester ON requester.id = h.person_requesting\n      JOIN "UserScheduleCurrent" requester_current ON requester_current.user_id = requester.id\n      JOIN "User" offering ON offering.id = h.person_offering',
    );

  return typeof query === 'string' ? normalized : { ...query, text: normalized };
}

for (const DatabaseClient of [Pool, Client]) {
  const originalQuery = DatabaseClient.prototype.query;
  DatabaseClient.prototype.query = function queryWithRequesterCurrentSchedule(query, ...args) {
    return originalQuery.call(this, addRequesterCurrentSchedule(query), ...args);
  };
}
