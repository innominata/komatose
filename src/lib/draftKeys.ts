/** Per-account local draft keys. Old `scan.drafts.${episodeId}` keys are left unread. */
export function chapterDraftKey(userId: string, episodeId: string): string {
  return `scan.drafts.${userId}.${episodeId}`;
}

export function maskDraftKey(userId: string, episodeId: string, imageId: string): string {
  return `scan.mask.${userId}.${episodeId}.${imageId}`;
}
