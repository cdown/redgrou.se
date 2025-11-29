const STORAGE_KEY = "redgrouse";
const CURRENT_VERSION = 1;

interface StorageData {
  version: number;
  editTokens: Record<string, string>;
}

function getDefaultData(): StorageData {
  return {
    version: CURRENT_VERSION,
    editTokens: {},
  };
}

function migrate(data: unknown): StorageData {
  // v0 (legacy): raw editTokens object without version envelope
  if (data && typeof data === "object" && !("version" in data)) {
    return {
      version: CURRENT_VERSION,
      editTokens: data as Record<string, string>,
    };
  }

  // Future migrations would go here:
  // if (data.version === 1) { /* migrate to v2 */ }

  return data as StorageData;
}

function loadStorage(): StorageData {
  if (typeof window === "undefined") {
    return getDefaultData();
  }

  try {
    // Try new format first
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return migrate(parsed);
    }

    // Migrate from legacy format (editTokens stored directly)
    const legacyRaw = localStorage.getItem("editTokens");
    if (legacyRaw) {
      const legacyData = JSON.parse(legacyRaw);
      const migrated = migrate(legacyData);
      // Save in new format and remove legacy key
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem("editTokens");
      return migrated;
    }

    return getDefaultData();
  } catch {
    return getDefaultData();
  }
}

function saveStorage(data: StorageData): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getEditToken(uploadId: string): string | null {
  const data = loadStorage();
  return data.editTokens[uploadId] || null;
}

export function setEditToken(uploadId: string, token: string): void {
  const data = loadStorage();
  data.editTokens[uploadId] = token;
  saveStorage(data);
}

export function removeEditToken(uploadId: string): void {
  const data = loadStorage();
  delete data.editTokens[uploadId];
  saveStorage(data);
}
