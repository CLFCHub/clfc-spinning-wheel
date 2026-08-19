-- Read-only checks for D1 structure
PRAGMA table_info(members);
PRAGMA table_info(roster_players);

-- Test PIN string handling (should retain leading zeroes)
SELECT name, playhq_uid FROM members WHERE CAST(pin AS TEXT) = '0227' LIMIT 1;
