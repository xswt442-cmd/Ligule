export interface TranscriptPages<T> {
  /** Pages in fetch order: newest first, older pages after it. */
  readonly pages: (readonly T[])[];
  /** Whether the collected pages reach back past the previous sequence. */
  readonly complete: boolean;
}

/**
 * Reads transcript pages backwards until they cover records newer than `prior`.
 *
 * A gap can span several pages, so a single newest page is not enough: advancing the cursor past a
 * truncated read would hide the older unseen records for good. Pages stay newest-first so callers can
 * reverse them once and keep chronological order.
 */
export async function collectTranscriptPages<T extends { readonly seq: number }>(
  fetchPage: (before: number | undefined) => Promise<readonly T[]>,
  prior: number,
  pageLimit: number,
  shouldStop?: () => boolean,
): Promise<TranscriptPages<T>> {
  const pages: (readonly T[])[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < pageLimit; page += 1) {
    if (shouldStop?.() === true) return { pages, complete: false };
    const events = await fetchPage(cursor);
    pages.push(events);
    const oldest = events[0]?.seq;
    // An empty page or one that already reaches `prior` means the unseen tail is complete.
    if (oldest === undefined || oldest <= prior + 1 || oldest <= 1) return { pages, complete: true };
    cursor = oldest;
  }
  return { pages, complete: false };
}
