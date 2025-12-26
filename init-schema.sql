-- journey-matcher schema initialization
-- Extracted from migrations for direct execution

-- Journeys table
CREATE TABLE IF NOT EXISTS journey_matcher.journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  origin_crs CHAR(3) NOT NULL,
  destination_crs CHAR(3) NOT NULL,
  departure_date DATE NOT NULL,
  departure_time_min TIME,
  departure_time_max TIME,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journeys_user_id ON journey_matcher.journeys(user_id);
CREATE INDEX IF NOT EXISTS idx_journeys_origin_dest ON journey_matcher.journeys(origin_crs, destination_crs);

-- Journey segments table
CREATE TABLE IF NOT EXISTS journey_matcher.journey_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
  segment_order INTEGER NOT NULL,
  origin_crs CHAR(3) NOT NULL,
  destination_crs CHAR(3) NOT NULL,
  departure_time TIMESTAMP NOT NULL,
  arrival_time TIMESTAMP NOT NULL,
  train_uid VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journey_segments_journey_id ON journey_matcher.journey_segments(journey_id);

-- Outbox table
CREATE TABLE IF NOT EXISTS journey_matcher.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbox_processed ON journey_matcher.outbox(processed_at) WHERE processed_at IS NULL;
