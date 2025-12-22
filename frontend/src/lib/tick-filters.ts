export interface TickFilterSelection {
  normal: boolean;
  lifer: boolean;
  year: boolean;
  country: boolean;
}

export type TickCategory = keyof TickFilterSelection;

export const DEFAULT_TICK_FILTER: TickFilterSelection = {
  normal: true,
  lifer: true,
  year: true,
  country: true,
};

export function parseTickFilterParam(value: string | null): TickFilterSelection {
  if (!value || value.trim() === "") {
    return { ...DEFAULT_TICK_FILTER };
  }

  const selection: TickFilterSelection = {
    normal: false,
    lifer: false,
    year: false,
    country: false,
  };

  for (const rawToken of value.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (!token) {
      continue;
    }
    switch (token) {
      case "normal":
      case "default":
        selection.normal = true;
        break;
      case "lifer":
      case "lifers":
        selection.lifer = true;
        break;
      case "year":
      case "year_tick":
      case "year_ticks":
        selection.year = true;
        break;
      case "country":
      case "country_tick":
      case "country_ticks":
        selection.country = true;
        break;
      default:
        // Ignore unknown tokens to remain forward compatible.
        break;
    }
  }

  return selection;
}

export function serializeTickFilterSelection(selection: TickFilterSelection): string | null {
  const tokens: string[] = [];
  if (selection.lifer) tokens.push("lifer");
  if (selection.year) tokens.push("year");
  if (selection.country) tokens.push("country");
  if (selection.normal) tokens.push("normal");

  if (tokens.length === 0) {
    return "";
  }

  if (tokens.length === 4) {
    return null;
  }

  return tokens.join(",");
}

export function isAllTickFiltersSelected(selection: TickFilterSelection): boolean {
  return selection.normal && selection.lifer && selection.year && selection.country;
}

export function isLiferOnlySelection(selection: TickFilterSelection): boolean {
  return selection.lifer && !selection.normal && !selection.year && !selection.country;
}

export function hasAnyTickSelection(selection: TickFilterSelection): boolean {
  return selection.normal || selection.lifer || selection.year || selection.country;
}

export function toggleTickFilter(
  selection: TickFilterSelection,
  category: TickCategory,
): TickFilterSelection {
  return setTickFilter(selection, category, !selection[category]);
}

export function setTickFilter(
  selection: TickFilterSelection,
  category: TickCategory,
  value: boolean,
): TickFilterSelection {
  if (selection[category] === value) {
    return selection;
  }

  return {
    ...selection,
    [category]: value,
  };
}

export function ensureTickLocks(
  selection: TickFilterSelection,
  locks: { year: boolean; country: boolean },
): TickFilterSelection {
  let next = selection;
  if (locks.year && !next.year) {
    next = { ...next, year: true };
  }
  if (locks.country && !next.country) {
    next = { ...next, country: true };
  }
  return next;
}

export function tickSelectionsEqual(
  a: TickFilterSelection,
  b: TickFilterSelection,
): boolean {
  return (
    a.normal === b.normal &&
    a.lifer === b.lifer &&
    a.year === b.year &&
    a.country === b.country
  );
}

