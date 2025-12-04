import { z } from "zod";

export const SightingSchema = z.object({
  id: z.number().or(z.string().transform(Number)),
  common_name: z.string(),
  scientific_name: z.string().nullable(),
  count: z.number().or(z.string().transform(Number)).nullable(),
  latitude: z.number(),
  longitude: z.number(),
  country_code: z.string().nullable(),
  region_code: z.string().nullable(),
  observed_at: z.string(),
});

export const GroupedSightingSchema = z.object({
  common_name: z.string().nullable(),
  scientific_name: z.string().nullable(),
  country_code: z.string().nullable(),
  observed_at: z.string().nullable(),
  count: z.number().or(z.string().transform(Number)),
  species_count: z.number().or(z.string().transform(Number)),
});

export const SightingsResponseSchema = z.object({
  sightings: z.array(SightingSchema).nullable(),
  groups: z.array(GroupedSightingSchema).nullable(),
  total: z.number().or(z.string().transform(Number)),
  page: z.number(),
  page_size: z.number(),
  total_pages: z.number(),
});

export type Sighting = z.infer<typeof SightingSchema>;
export type GroupedSighting = z.infer<typeof GroupedSightingSchema>;
export type SightingsResponse = z.infer<typeof SightingsResponseSchema>;
