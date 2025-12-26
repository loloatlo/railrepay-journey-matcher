/**
 * TypeScript types for journey-matcher service
 * Based on RFC-001: journey-matcher Schema Design
 */

export interface Journey {
  id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  departure_datetime: Date;
  arrival_datetime: Date;
  journey_type: 'single' | 'return';
  status: 'draft' | 'confirmed' | 'cancelled';
  created_at: Date;
  updated_at: Date;
}

export interface JourneySegment {
  id: string;
  journey_id: string;
  segment_order: number;
  rid: string;
  toc_code: string;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: Date;
  scheduled_arrival: Date;
  created_at: Date;
}

export interface CreateJourneyRequest {
  user_id: string;
  origin_station: string;
  destination_station: string;
  departure_date: string; // ISO date string (YYYY-MM-DD)
  departure_time: string; // HH:mm format
  journey_type: 'single' | 'return';
}

export interface JourneyWithSegments extends Journey {
  segments: JourneySegment[];
}

export interface OutboxEvent {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  created_at: Date;
  published_at: Date | null;
  published: boolean;
}
