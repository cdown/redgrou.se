export function deriveTitleFromFilename(filename: string): string {
  if (filename.toLowerCase().endsWith(".csv") && filename.length > 4) {
    const trimmed = filename.slice(0, -4);
    return trimmed.length > 0 ? trimmed : filename;
  }
  return filename;
}

