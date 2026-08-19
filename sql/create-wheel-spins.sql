-- Create the history table as per spec
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
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_wheel_spins_grade ON wheel_spins(grade);
CREATE INDEX IF NOT EXISTS idx_wheel_spins_spinner ON wheel_spins(spinner_uid);
CREATE INDEX IF NOT EXISTS idx_wheel_spins_winner ON wheel_spins(winner_uid);
