"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  apiFetch,
  buildApiUrl,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { ClientOnly } from "@/components/client-only";
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
import { formatCountry } from "@/lib/countries";
import {
  FIELDS_ROUTE,
  FIELD_VALUES_ROUTE,
} from "@/lib/generated/api_constants";
import {
  FieldMetadataList,
  FieldValues as FieldValuesDecoder,
} from "@/lib/proto/redgrouse_api";
import { formatDisplayDate } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

function toComboboxOptions(
  values: string[],
  fieldName?: string,
): ComboboxOption[] {
  return values.map((v) => ({
    value: v,
    label: fieldName === "country_code" ? formatCountry(v) : v,
  }));
}

interface QueryBuilderProps {
  uploadId: string;
  onFilterChange: (filter: FilterGroup | null) => void;
  onClose?: () => void;
  isPanel?: boolean;
}

export function QueryBuilder({
  uploadId,
  onFilterChange,
  onClose,
  isPanel,
}: QueryBuilderProps) {
  const { showToast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [fields, setFields] = useState<FieldMetadata[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(createGroup());
  const [fieldValues, setFieldValues] = useState<Record<string, string[]>>({});

  useEffect(() => {
    apiFetch(FIELDS_ROUTE)
      .then(async (res) => {
        await checkApiResponse(res, "Failed to load field metadata");
        const data = await parseProtoResponse(res, FieldMetadataList);
        return data.fields.map((field) => ({
          name: field.name,
          label: field.label,
          field_type: field.fieldType as FieldMetadata["field_type"],
        }));
      })
      .then(setFields)
      .catch((err) => {
        console.error("Failed to fetch field metadata:", err);
        showToast(getErrorMessage(err, "Failed to load field metadata"), "error");
      });
  }, [showToast]);

  const fetchFieldValues = useCallback(
    async (field: string) => {
      if (fieldValues[field]) return;
      try {
        const url = buildApiUrl(FIELD_VALUES_ROUTE, {
          upload_id: uploadId,
          field,
        });
        const res = await apiFetch(url);
        if (!res.ok) {
          const readableName = field.split("_").join(" ");
          showToast(`Failed to load values for ${readableName}`, "error");
          return;
        }
        const data = await parseProtoResponse(res, FieldValuesDecoder);
        setFieldValues((prev) => ({ ...prev, [field]: data.values }));
      } catch (e) {
        console.error("Failed to fetch field values:", e);
        showToast(getErrorMessage(e, "Failed to load field values"), "error");
      }
    },
    [uploadId, fieldValues, showToast],
  );

  const updateRule = useCallback(
    (path: number[], updater: (rule: Rule) => Rule) => {
      setFilter((prev) => {
        const update = (group: FilterGroup, pathIndex: number): FilterGroup => {
          if (pathIndex === path.length - 1) {
            return {
              ...group,
              rules: group.rules.map((r, i) =>
                i === path[pathIndex] ? updater(r) : r,
              ),
            };
          }
          return {
            ...group,
            rules: group.rules.map((r, i) =>
              i === path[pathIndex] && isGroup(r)
                ? update(r, pathIndex + 1)
                : r,
            ),
          };
        };
        return update(prev, 0);
      });
    },
    [],
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
            i === path[pathIndex] && isGroup(r) ? add(r, pathIndex + 1) : r,
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
            i === path[pathIndex] && isGroup(r) ? remove(r, pathIndex + 1) : r,
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
                : r,
            ),
          };
        };
        return update(prev, 0);
      });
    },
    [],
  );

  const applyFilter = useCallback(() => {
    const hasValidRules = filter.rules.some((r) =>
      isGroup(r) ? r.rules.length > 0 : r.field !== "",
    );
    onFilterChange(hasValidRules ? filter : null);
    if (isPanel && onClose) {
      onClose();
    } else {
      setIsOpen(false);
    }
  }, [filter, onFilterChange, isPanel, onClose]);

  const clearFilter = useCallback(() => {
    setFilter(createGroup());
    onFilterChange(null);
  }, [onFilterChange]);

  const activeCount = filter.rules.filter((r) =>
    isGroup(r) ? r.rules.length > 0 : r.field !== "",
  ).length;

  if (isPanel) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-lg font-semibold text-stone-900">Filters</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-stone-100 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
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
        </div>

        <div className="flex gap-2 border-t p-4">
          <Button className="flex-1" onClick={applyFilter}>
            Apply filters
          </Button>
          <Button variant="outline" onClick={clearFilter}>
            Clear
          </Button>
        </div>
      </div>
    );
  }

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
        <ClientOnly>
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
        </ClientOnly>
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
  const isMultiValue =
    condition.operator === "in" || condition.operator === "not_in";

  const skipOperator = fieldType === "boolean";

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <ClientOnly>
        <Select
          value={condition.field}
          onValueChange={(v) => {
            fetchFieldValues(v);
            const newField = fields.find((f) => f.name === v);
            const newFieldType = newField?.field_type || "string";
            let defaultOp: Operator = "eq";
            let defaultValue: string | string[] | number = "";

            if (newFieldType === "date") {
              defaultOp = "gte";
            } else if (newFieldType === "boolean") {
              defaultOp = "eq";
              defaultValue = 1;
            }

            updateRule(path, () => ({
              ...condition,
              field: v,
              operator: defaultOp,
              value: defaultValue,
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
      </ClientOnly>

      {condition.field && !skipOperator && (
        <ClientOnly>
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
            <SelectTrigger className="w-32 h-8">
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
        </ClientOnly>
      )}

      {condition.field && isMultiValue ? (
        <MultiCombobox
          options={toComboboxOptions(values, condition.field)}
          values={Array.isArray(condition.value) ? condition.value : []}
          onChange={(v) => updateRule(path, () => ({ ...condition, value: v }))}
          placeholder="Select..."
          searchPlaceholder="Search..."
          className="min-w-32 flex-1"
        />
      ) : condition.field && fieldType === "boolean" ? null : condition.field &&
        fieldType === "date" ? (
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
          className="h-8 w-24"
        />
      ) : condition.field && isFreeform ? (
        <Input
          type="text"
          value={String(condition.value)}
          onChange={(e) =>
            updateRule(path, () => ({ ...condition, value: e.target.value }))
          }
          placeholder="Type to search..."
          className="h-8 min-w-32 flex-1"
        />
      ) : condition.field ? (
        <Combobox
          options={toComboboxOptions(values, condition.field)}
          value={String(condition.value)}
          onChange={(v) => updateRule(path, () => ({ ...condition, value: v }))}
          placeholder="Select..."
          searchPlaceholder="Search..."
          className="min-w-32 flex-1"
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-8 w-36 justify-start text-left font-normal"
        >
          {date ? formatDisplayDate(date) : "Select date..."}
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
