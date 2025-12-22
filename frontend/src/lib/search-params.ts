import { parseAsInteger, parseAsString } from "nuqs/server";

export const searchParamsCache = {
  filter: parseAsString,
  year_tick_year: parseAsInteger,
  country_tick_country: parseAsString,
  tick_filter: parseAsString,
};
