CREATE TABLE IF NOT EXISTS funnel_leads (
  lead_uuid TEXT PRIMARY KEY,
  first_event_id TEXT NOT NULL,
  first_url TEXT NOT NULL,
  original_query_string TEXT NOT NULL,
  fbc TEXT,
  fbp TEXT,
  ip_address TEXT,
  user_agent TEXT,
  email_hash TEXT,
  phone_hash TEXT,
  first_name_hash TEXT,
  last_name_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS downstream_conversions (
  external_id TEXT PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  lead_uuid TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS sheet_delivery_counters (
  sheet_id TEXT PRIMARY KEY,
  next_row INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sheet_delivery_rows (
  delivery_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  sheet_row INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  UNIQUE(sheet_id, sheet_row)
);
