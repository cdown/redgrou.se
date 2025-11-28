const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

export function getCountryName(code: string): string {
  try {
    return displayNames.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

export function getCountryFlag(code: string): string {
  const upperCode = code.toUpperCase();
  const codePoints = [...upperCode].map(
    (char) => 0x1f1e6 + char.charCodeAt(0) - 65
  );
  return String.fromCodePoint(...codePoints);
}

export function formatCountry(code: string): string {
  if (!code) return "—";
  return `${getCountryFlag(code)} ${getCountryName(code)}`;
}

export function formatCountryShort(code: string): string {
  if (!code) return "—";
  return `${getCountryFlag(code)} ${code}`;
}
