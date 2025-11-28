export type Combinator = "and" | "or";

export type Operator =
  | "eq"
  | "neq"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gte"
  | "lte"
  | "in"
  | "not_in";

export interface Condition {
  id: string;
  field: string;
  operator: Operator;
  value: string | number | string[];
}

export interface FilterGroup {
  id: string;
  combinator: Combinator;
  rules: Rule[];
}

export type Rule = Condition | FilterGroup;

export function isGroup(rule: Rule): rule is FilterGroup {
  return "combinator" in rule;
}

export interface FieldMetadata {
  name: string;
  label: string;
  field_type: "string" | "number" | "date" | "boolean";
}

export const OPERATORS: Record<
  string,
  { label: string; types: string[]; freeform?: boolean }
> = {
  eq: { label: "is", types: ["string", "boolean"] },
  neq: { label: "is not", types: ["string", "boolean"] },
  contains: { label: "contains", types: ["string"] },
  starts_with: { label: "starts with", types: ["string"], freeform: true },
  ends_with: { label: "ends with", types: ["string"], freeform: true },
  gte: { label: "is on or after", types: ["date"] },
  lte: { label: "is on or before", types: ["date"] },
  in: { label: "is one of", types: ["string"] },
  not_in: { label: "is not one of", types: ["string"] },
};

export const NUMBER_OPERATORS: Record<string, { label: string }> = {
  eq: { label: "equals" },
  neq: { label: "does not equal" },
  gte: { label: "is at least" },
  lte: { label: "is at most" },
};

export function getOperatorsForType(fieldType: string): Operator[] {
  if (fieldType === "number") {
    return ["eq", "neq", "gte", "lte"];
  }
  if (fieldType === "date") {
    return ["gte", "lte"];
  }
  return Object.entries(OPERATORS)
    .filter(([, meta]) => meta.types.includes(fieldType))
    .map(([op]) => op as Operator);
}

export function getOperatorLabel(operator: Operator, fieldType: string): string {
  if (fieldType === "number" && NUMBER_OPERATORS[operator]) {
    return NUMBER_OPERATORS[operator].label;
  }
  return OPERATORS[operator]?.label || operator;
}

export function isFreeformOperator(operator: Operator): boolean {
  return OPERATORS[operator]?.freeform === true;
}

export function createCondition(): Condition {
  return {
    id: crypto.randomUUID(),
    field: "",
    operator: "eq",
    value: "",
  };
}

export function createGroup(): FilterGroup {
  return {
    id: crypto.randomUUID(),
    combinator: "and",
    rules: [createCondition()],
  };
}

export function filterToJson(filter: FilterGroup): string {
  const clean = (group: FilterGroup): object => ({
    combinator: group.combinator,
    rules: group.rules.map((rule) => {
      if (isGroup(rule)) {
        return clean(rule);
      }
      return {
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
      };
    }),
  });

  return JSON.stringify(clean(filter));
}
