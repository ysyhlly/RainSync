/** Source-owner declaration only: no URLs, roots or decoder/filter options. */
export interface HttpAssetAssociation {
  schema_version: 1;
  subtitles: Array<"ass" | "ssa" | "pgs">;
  fonts: string[];
}
export function parseHttpAssetAssociation(
  text: string,
): HttpAssetAssociation | undefined {
  if (!text.trim()) return undefined;
  if (text.length > 32_768) throw Error("字幕/字体关联声明过大");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error("字幕/字体关联须为有效 JSON 对象");
  }
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw Error("字幕/字体关联须为 JSON 对象");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    row.schema_version !== 1 ||
    !Array.isArray(row.subtitles) ||
    !Array.isArray(row.fonts) ||
    row.subtitles.length > 3 ||
    row.fonts.length > 64 ||
    row.subtitles.some((kind) => !["ass", "ssa", "pgs"].includes(kind)) ||
    new Set(row.subtitles).size !== row.subtitles.length
  )
    throw Error("关联版本须为 1，字幕仅允许 ass、ssa、pgs，字体最多 64 个");
  if (
    row.fonts.some(
      (font) =>
        typeof font !== "string" ||
        font.length > 256 ||
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(ttf|otf|ttc)$/i.test(font),
    ) ||
    new Set(row.fonts).size !== row.fonts.length
  )
    throw Error("字体须为同名 .fonts 目录内的直接 ttf、otf 或 ttc 文件名");
  return {
    schema_version: 1,
    subtitles: row.subtitles as HttpAssetAssociation["subtitles"],
    fonts: row.fonts as string[],
  };
}
