export const MAX_PUBLISH_PREVIEW_ITEMS = 500;

export function publishPreviewLimitMessage(itemCount: number): string | null {
  return itemCount > MAX_PUBLISH_PREVIEW_ITEMS
    ? `This room has ${itemCount} publishable recordings; a destination preview supports at most ${MAX_PUBLISH_PREVIEW_ITEMS}. Hold or skip recordings, then try again.`
    : null;
}
