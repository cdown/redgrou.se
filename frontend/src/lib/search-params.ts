import {
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
} from "nuqs/server";

export const searchParamsCache = {
  filter: parseAsString,
  lifers_only: parseAsBoolean.withDefault(false),
  year_tick_year: parseAsInteger,
  country_tick_country: parseAsString,
};
