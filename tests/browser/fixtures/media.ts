export const missingCover = {
  status: "missing",
  revision: null,
  url: null,
  retry_after_ms: null,
};
export function mediaRecord(item: {
  id: string;
  title: string;
  [key: string]: unknown;
}) {
  return {
    original_title: item.title,
    shared_title: null,
    shared_title_revision: "0",
    personal_title: null,
    personal_title_revision: "0",
    cover: { ...missingCover },
    duration_ms: null,
    kind: "local",
    ...item,
  };
}
