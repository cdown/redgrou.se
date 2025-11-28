"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Condition,
  FilterGroup,
  Rule,
  isGroup,
  createCondition,
  createGroup,
  FieldMetadata,
  getOperatorsForType,
  getOperatorLabel,
  isFreeformOperator,
  Operator,
} from "@/lib/filter-types";

interface QueryBuilderProps {
  uploadId: string;
  onFilterChange: (filter: FilterGroup | null) => void;
}

export function QueryBuilder({ uploadId, onFilterChange }: QueryBuilderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [fields, setFields] = useState<FieldMetadata[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(createGroup());
  const [fieldValues, setFieldValues] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetch("http://localhost:3001/api/fields")
      .then((res) => res.json())
      .then(setFields)
      .catch(console.error);
  }, []);

  const fetchFieldValues = useCallback(
    async (field: string) => {
      if (fieldValues[field]) return;
      try {
        const res = await fetch(
          `http://localhost:3001/api/fields/${uploadId}/${field}`
        );
        const data = await res.json();
        setFieldValues((prev) => ({ ...prev, [field]: data.values }));
      } catch (e) {
        console.error(e);
      }
    },
    [uploadId, fieldValues]
  );

  const updateRule = useCallback(
    (path: number[], updater: (rule: Rule) => Rule) => {
      setFilter((prev) => {
        const update = (group: FilterGroup, pathIndex: number): FilterGroup => {
          if (pathIndex === path.length - 1) {
            return {
              ...group,
              rules: group.rules.map((r, i) =>
                i === path[pathIndex] ? updater(r) : r
              ),
            };
          }
          return {
            ...group,
            rules: group.rules.map((r, i) =>
              i === path[pathIndex] && isGroup(r)
                ? update(r, pathIndex + 1)
                : r
            ),
          };
        };
        return update(prev, 0);
      });
    },
    []
  );

  const addRule = useCallback((path: number[], rule: Rule) => {
    setFilter((prev) => {
      const add = (group: FilterGroup, pathIndex: number): FilterGroup => {
        if (pathIndex === path.length) {
          return { ...group, rules: [...group.rules, rule] };
        }
        return {
          ...group,
          rules: group.rules.map((r, i) =>
            i === path[pathIndex] && isGroup(r) ? add(r, pathIndex + 1) : r
          ),
        };
      };
      return add(prev, 0);
    });
  }, []);

  const removeRule = useCallback((path: number[]) => {
    setFilter((prev) => {
      const remove = (group: FilterGroup, pathIndex: number): FilterGroup => {
        if (pathIndex === path.length - 1) {
          return {
            ...group,
            rules: group.rules.filter((_, i) => i !== path[pathIndex]),
          };
        }
        return {
          ...group,
          rules: group.rules.map((r, i) =>
            i === path[pathIndex] && isGroup(r) ? remove(r, pathIndex + 1) : r
          ),
        };
      };
      return remove(prev, 0);
    });
  }, []);

  const setCombinator = useCallback(
    (path: number[], combinator: "and" | "or") => {
      setFilter((prev) => {
        const update = (group: FilterGroup, pathIndex: number): FilterGroup => {
          if (pathIndex === path.length) {
            return { ...group, combinator };
          }
          return {
            ...group,
            rules: group.rules.map((r, i) =>
              i === path[pathIndex] && isGroup(r)
                ? update(r, pathIndex + 1)
                : r
            ),
          };
        };
        return update(prev, 0);
      });
    },
    []
  );

  const applyFilter = useCallback(() => {
    const hasValidRules = filter.rules.some((r) =>
      isGroup(r) ? r.rules.length > 0 : r.field !== ""
    );
    onFilterChange(hasValidRules ? filter : null);
  }, [filter, onFilterChange]);

  const clearFilter = useCallback(() => {
    setFilter(createGroup());
    onFilterChange(null);
  }, [onFilterChange]);

  const activeCount = filter.rules.filter((r) =>
    isGroup(r) ? r.rules.length > 0 : r.field !== ""
  ).length;

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="gap-2"
      >
        Filters
        {activeCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5">
            {activeCount}
          </Badge>
        )}
      </Button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[600px] rounded-lg border bg-card p-4 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium">Filter sightings</span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>

          <GroupBuilder
            group={filter}
            path={[]}
            fields={fields}
            fieldValues={fieldValues}
            fetchFieldValues={fetchFieldValues}
            updateRule={updateRule}
            addRule={addRule}
            removeRule={removeRule}
            setCombinator={setCombinator}
            isRoot
            depth={0}
          />

          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={applyFilter}>
              Apply
            </Button>
            <Button size="sm" variant="outline" onClick={clearFilter}>
              Clear
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const GROUP_COLOURS = [
  "bg-transparent",
  "bg-blue-500/5",
  "bg-amber-500/5",
  "bg-emerald-500/5",
  "bg-purple-500/5",
];

interface GroupBuilderProps {
  group: FilterGroup;
  path: number[];
  fields: FieldMetadata[];
  fieldValues: Record<string, string[]>;
  fetchFieldValues: (field: string) => void;
  updateRule: (path: number[], updater: (rule: Rule) => Rule) => void;
  addRule: (path: number[], rule: Rule) => void;
  removeRule: (path: number[]) => void;
  setCombinator: (path: number[], combinator: "and" | "or") => void;
  isRoot?: boolean;
  depth?: number;
}

function GroupBuilder({
  group,
  path,
  fields,
  fieldValues,
  fetchFieldValues,
  updateRule,
  addRule,
  removeRule,
  setCombinator,
  isRoot,
  depth = 0,
}: GroupBuilderProps) {
  const bgColour = GROUP_COLOURS[depth % GROUP_COLOURS.length];

  return (
    <div
      className={`space-y-2 rounded-md p-2 ${bgColour} ${!isRoot ? "ml-2 border-l-2 border-muted" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Select
          value={group.combinator}
          onValueChange={(v) => setCombinator(path, v as "and" | "or")}
        >
          <SelectTrigger className="w-24 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">All of</SelectItem>
            <SelectItem value="or">Any of</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {group.rules.map((rule, index) => (
        <div key={isGroup(rule) ? rule.id : rule.id} className="flex gap-2">
          {isGroup(rule) ? (
            <div className="flex-1">
              <GroupBuilder
                group={rule}
                path={[...path, index]}
                fields={fields}
                fieldValues={fieldValues}
                fetchFieldValues={fetchFieldValues}
                updateRule={updateRule}
                addRule={addRule}
                removeRule={removeRule}
                setCombinator={setCombinator}
                depth={depth + 1}
              />
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 text-xs text-muted-foreground"
                onClick={() => removeRule([...path, index])}
              >
                Remove group
              </Button>
            </div>
          ) : (
            <ConditionBuilder
              condition={rule}
              path={[...path, index]}
              fields={fields}
              fieldValues={fieldValues}
              fetchFieldValues={fetchFieldValues}
              updateRule={updateRule}
              removeRule={removeRule}
            />
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => addRule(path, createCondition())}
        >
          + Condition
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => addRule(path, createGroup())}
        >
          + Group
        </Button>
      </div>
    </div>
  );
}

interface ConditionBuilderProps {
  condition: Condition;
  path: number[];
  fields: FieldMetadata[];
  fieldValues: Record<string, string[]>;
  fetchFieldValues: (field: string) => void;
  updateRule: (path: number[], updater: (rule: Rule) => Rule) => void;
  removeRule: (path: number[]) => void;
}

function ConditionBuilder({
  condition,
  path,
  fields,
  fieldValues,
  fetchFieldValues,
  updateRule,
  removeRule,
}: ConditionBuilderProps) {
  const field = fields.find((f) => f.name === condition.field);
  const fieldType = field?.field_type || "string";
  const operators = field ? getOperatorsForType(fieldType) : [];
  const values = fieldValues[condition.field] || [];
  const isFreeform = isFreeformOperator(condition.operator);
  const isMultiValue = condition.operator === "in" || condition.operator === "not_in";

  return (
    <div className="flex flex-1 items-center gap-2">
      <Select
        value={condition.field}
        onValueChange={(v) => {
          fetchFieldValues(v);
          const newFieldType = fields.find((f) => f.name === v)?.field_type || "string";
          const defaultOp = newFieldType === "date" ? "gte" : "eq";
          updateRule(path, () => ({
            ...condition,
            field: v,
            operator: defaultOp,
            value: "",
          }));
        }}
      >
        <SelectTrigger className="w-36 h-8">
          <SelectValue placeholder="Field..." />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {condition.field && (
        <Select
          value={condition.operator}
          onValueChange={(v) =>
            updateRule(path, () => ({
              ...condition,
              operator: v as Operator,
              value: v === "in" || v === "not_in" ? [] : "",
            }))
          }
        >
          <SelectTrigger className="w-36 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operators.map((op) => (
              <SelectItem key={op} value={op}>
                {getOperatorLabel(op, fieldType)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {condition.field && isMultiValue ? (
        <MultiValueSelect
          values={Array.isArray(condition.value) ? condition.value : []}
          options={values}
          onChange={(v) => updateRule(path, () => ({ ...condition, value: v }))}
        />
      ) : condition.field && fieldType === "boolean" ? (
        <Select
          value={String(condition.value)}
          onValueChange={(v) =>
            updateRule(path, () => ({ ...condition, value: Number(v) }))
          }
        >
          <SelectTrigger className="w-24 h-8">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Yes</SelectItem>
            <SelectItem value="0">No</SelectItem>
          </SelectContent>
        </Select>
      ) : condition.field && fieldType === "date" ? (
        <DatePicker
          value={String(condition.value)}
          onChange={(v) => updateRule(path, () => ({ ...condition, value: v }))}
        />
      ) : condition.field && fieldType === "number" ? (
        <Input
          type="number"
          value={String(condition.value)}
          onChange={(e) =>
            updateRule(path, () => ({
              ...condition,
              value: e.target.value === "" ? "" : Number(e.target.value),
            }))
          }
          placeholder="Value..."
          className="h-8 flex-1"
        />
      ) : condition.field && isFreeform ? (
        <Input
          type="text"
          value={String(condition.value)}
          onChange={(e) =>
            updateRule(path, () => ({ ...condition, value: e.target.value }))
          }
          placeholder="Type to search..."
          className="h-8 flex-1"
        />
      ) : condition.field ? (
        <TypeaheadSelect
          value={String(condition.value)}
          options={values}
          onChange={(v) => updateRule(path, () => ({ ...condition, value: v }))}
          placeholder="Type to search..."
        />
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 text-muted-foreground"
        onClick={() => removeRule(path)}
      >
        ✕
      </Button>
    </div>
  );
}

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
}

function DatePicker({ value, onChange }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const date = value ? new Date(value) : undefined;

  const formatDate = (d: Date) => {
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-8 flex-1 justify-start text-left font-normal"
        >
          {date ? formatDate(date) : "Select date..."}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (d) {
              onChange(d.toISOString());
            }
            setOpen(false);
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

interface TypeaheadSelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}

function TypeaheadSelect({
  value,
  options,
  onChange,
  placeholder,
}: TypeaheadSelectProps) {
  const [search, setSearch] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setSearch(value);
  }, [value]);

  const filtered = useMemo(() => {
    if (!search) return options.slice(0, 50);
    const lower = search.toLowerCase();
    return options
      .filter((o) => o.toLowerCase().includes(lower))
      .slice(0, 50);
  }, [search, options]);

  return (
    <div className="relative flex-1">
      <Input
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          onChange(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        placeholder={placeholder}
        className="h-8"
      />
      {isOpen && filtered.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {filtered.map((opt) => (
            <button
              key={opt}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onMouseDown={() => {
                onChange(opt);
                setSearch(opt);
                setIsOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface MultiValueSelectProps {
  values: string[];
  options: string[];
  onChange: (values: string[]) => void;
}

function MultiValueSelect({
  values,
  options,
  onChange,
}: MultiValueSelectProps) {
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filtered = useMemo(() => {
    const available = options.filter((o) => !values.includes(o));
    if (!search) return available.slice(0, 50);
    const lower = search.toLowerCase();
    return available
      .filter((o) => o.toLowerCase().includes(lower))
      .slice(0, 50);
  }, [search, options, values]);

  return (
    <div className="relative flex-1">
      <div className="flex min-h-8 flex-wrap gap-1 rounded-md border bg-transparent p-1">
        {values.map((v) => (
          <Badge key={v} variant="secondary" className="gap-1 h-6">
            {v}
            <button
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="ml-1 hover:text-destructive"
            >
              ✕
            </button>
          </Badge>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 150)}
          placeholder={values.length === 0 ? "Type to search..." : ""}
          className="h-6 flex-1 min-w-20 bg-transparent text-sm outline-none"
        />
      </div>
      {isOpen && filtered.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {filtered.map((opt) => (
            <button
              key={opt}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onMouseDown={() => {
                onChange([...values, opt]);
                setSearch("");
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
